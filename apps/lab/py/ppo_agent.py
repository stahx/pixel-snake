import argparse
import json
import math
import os
import queue
import random
import shutil
import signal
import sys
import threading
import time
from pathlib import Path

import numpy as np
import torch
import torch.multiprocessing as mp
from torch import nn
from torch.distributions import Categorical

from pixel_snake_lab import Game, parse_ports, stream_output, sync_config

TURNS = (-0.32, -0.16, 0.0, 0.16, 0.32)
ACTIONS = [(turn, boost) for turn in TURNS for boost in (False, True)]
TICKS_PER_ACTION = (3, 6)
PROCESS_SESSIONS = 5
RECONNECT_SECONDS = 5

GRID_SIZE = 24
GRID_CELL = 50.0
FOOD, ENEMY_TAIL, ENEMY_HEAD, ENEMY_FORWARD, ENEMY_RIGHT, ENEMY_BOOST, ENEMY_SIZE, OWN_TAIL, VISIBLE = range(9)
GRID_CHANNELS = 9
SELF_FEATURES = 4
RADAR_FEATURES = GRID_CHANNELS * GRID_SIZE * GRID_SIZE + SELF_FEATURES
HIDDEN_SIZE = 128
DEVICE = torch.accelerator.current_accelerator() or torch.device('cpu')

PARAMETERS = {
    'kill_reward': 30.0,
    'kill_share': 0.5,
    'death_penalty': -50.0,
    # Returns in the hundreds would make the value loss drown the policy gradient in the shared body.
    'reward_scale': 0.01,
    'gamma': 0.99,
    'gae_lambda': 0.95,
    'clip_range': 0.2,
    'value_coef': 0.5,
    'entropy_coef': 0.01,
    'learning_rate': 3e-4,
    'max_grad_norm': 0.5,
    'segment_steps': 128,
    'batch_steps': 4096,
    'epochs': 4,
    'minibatch_size': 512,
    'checkpoint_every': 10,
}

HERE = Path(__file__).resolve().parent
CHECKPOINTS = HERE.parent if HERE.parent.name == 'checkpoints' else HERE / 'checkpoints'


class ActorCritic(nn.Module):
    def __init__(self):
        super().__init__()
        self.vision = nn.Sequential(
            nn.Unflatten(-1, (GRID_CHANNELS, GRID_SIZE, GRID_SIZE)),
            nn.Conv2d(GRID_CHANNELS, 16, 3, stride=2, padding=1), nn.ReLU(),
            nn.Conv2d(16, 32, 3, stride=2, padding=1), nn.ReLU(),
            nn.Flatten(start_dim=-3),
        )
        self.body = nn.Sequential(
            nn.Linear(32 * (GRID_SIZE // 4) ** 2 + SELF_FEATURES, HIDDEN_SIZE), nn.Tanh(),
            nn.Linear(HIDDEN_SIZE, HIDDEN_SIZE), nn.Tanh(),
        )
        self.policy = nn.Linear(HIDDEN_SIZE, len(ACTIONS))
        self.value = nn.Linear(HIDDEN_SIZE, 1)

    def forward(self, state):
        grid, own = state[..., :-SELF_FEATURES], state[..., -SELF_FEATURES:]
        hidden = self.body(torch.cat([self.vision(grid), own], dim=-1))
        return self.policy(hidden), self.value(hidden).squeeze(-1)


def wrapped(delta, size):
    return (delta + size / 2) % size - size / 2


CELL_GAPS = np.abs(np.arange(GRID_SIZE) - GRID_SIZE / 2 + 0.5) * GRID_CELL - GRID_CELL / 2
CELL_NEAREST = np.hypot(*np.meshgrid(CELL_GAPS, CELL_GAPS, indexing='ij'))


def fog_radius(me, info):
    fog, growth = info['fogRadius'], info['growth']
    progress = min(1.0, max(0.0, (me['size'] - growth['spawnSize']) / (growth['maxSize'] - growth['spawnSize'])))
    return fog['min'] + (fog['max'] - fog['min']) * progress


def radar(observation, info, elapsed):
    me = observation['me']
    width, height = info['map']['width'], info['map']['height']
    head_x = me['x'] + me['size'] / 2
    head_y = me['y'] + me['size'] / 2
    cos, sin = math.cos(me['angle']), math.sin(me['angle'])
    entities = observation['entities'].values()
    sizes = {entity['player']: entity['size'] for entity in entities if entity['type'] == 'player'}

    grid = np.zeros((GRID_CHANNELS, GRID_SIZE, GRID_SIZE), dtype=np.float32)
    for entity in entities:
        if entity is me:
            continue
        half = entity.get('size', sizes.get(entity.get('player'), 0)) / 2
        dx = wrapped(entity['x'] + half - head_x, width)
        dy = wrapped(entity['y'] + half - head_y, height)
        row = math.floor(-(dx * cos + dy * sin) / GRID_CELL) + GRID_SIZE // 2
        column = math.floor((-dx * sin + dy * cos) / GRID_CELL) + GRID_SIZE // 2
        if not (0 <= row < GRID_SIZE and 0 <= column < GRID_SIZE):
            continue
        if entity['type'] == 'point':
            grid[FOOD, row, column] += 1
        elif entity['type'] == 'player':
            heading = entity['angle'] - me['angle']
            grid[ENEMY_HEAD, row, column] = 1
            grid[ENEMY_FORWARD, row, column] = math.cos(heading)
            grid[ENEMY_RIGHT, row, column] = math.sin(heading)
            grid[ENEMY_BOOST, row, column] = float(bool(entity.get('boosting')))
            grid[ENEMY_SIZE, row, column] = math.log(entity['size'] / me['size'])
        else:
            grid[OWN_TAIL if entity['player'] == me['player'] else ENEMY_TAIL, row, column] = 1

    grid[FOOD] = np.minimum(grid[FOOD], 5)
    # The server measures fog between top-left corners, so anything up to half a cell past the radius can still show.
    grid[VISIBLE] = CELL_NEAREST <= fog_radius(me, info) + GRID_CELL / 2
    own = [math.log1p(me['points']) / 5, float(bool(me.get('boosting'))), me['size'] / info['growth']['maxSize'],
           min(elapsed, 24) / 6]
    return np.concatenate([grid.ravel(), own]).astype(np.float32)


def parameters(values, source):
    unknown = sorted(values.keys() - PARAMETERS.keys())
    if unknown:
        raise ValueError(f'unknown parameters in {source}: {", ".join(unknown)}')
    for name, value in values.items():
        if isinstance(PARAMETERS[name], int) and not float(value).is_integer():
            raise ValueError(f'{name} must be a whole number, got {value} in {source}')
    return {name: type(default)(values[name]) for name, default in PARAMETERS.items() if name in values}


def reward_for(observation, next_observation, config):
    kills = (config['kill_reward'] * (next_observation['kills'] - observation['kills'])
             + config['kill_share'] * (next_observation['kill_points'] - observation['kill_points']))
    if not next_observation['alive']:
        return kills + config['death_penalty'] - observation['me']['points']
    return kills + next_observation['me']['points'] - observation['me']['points']


def advantages(rewards, values, dones, last_value, config):
    gamma, gae_lambda = config['gamma'], config['gae_lambda']
    result = np.zeros(len(rewards), dtype=np.float32)
    running = 0.0
    for step in reversed(range(len(rewards))):
        next_value = last_value if step == len(rewards) - 1 else values[step + 1]
        alive = 1.0 - dones[step]
        delta = rewards[step] + gamma * next_value * alive - values[step]
        running = delta + gamma * gae_lambda * alive * running
        result[step] = running
    return result, result + np.asarray(values, dtype=np.float32)


def parse_rooms(spec, sessions):
    rooms = {}
    for group in spec.split(','):
        ports, _, count = group.partition(':')
        rooms |= dict.fromkeys(parse_ports(ports), int(count or sessions))
    return rooms


def act(net, state):
    with torch.no_grad():
        logits, value = net(torch.as_tensor(state))
    distribution = Categorical(logits=logits)
    action = distribution.sample()
    return action.item(), distribution.log_prob(action).item(), value.item()


def play_session(url, run, net, rollouts, learner_stats, label, config):
    game = Game(url=url, run=run)
    observation = game.observe()
    segment = {'states': [], 'actions': [], 'log_probs': [], 'values': [], 'rewards': [], 'dones': []}
    episode_return = 0.0
    episode_kills = 0
    steps = 0
    dropped = 0
    ticks = elapsed = random.randint(*TICKS_PER_ACTION)

    def send(last_value):
        nonlocal dropped
        advantage, returns = advantages(segment['rewards'], segment['values'], segment['dones'], last_value, config)
        try:
            rollouts.put_nowait({'states': np.stack(segment['states']), 'actions': np.array(segment['actions']),
                                 'log_probs': np.array(segment['log_probs'], dtype=np.float32),
                                 'advantages': advantage, 'returns': returns})
        except queue.Full:
            dropped += len(segment['actions'])
        for values in segment.values():
            values.clear()

    while True:
        if not observation['alive']:
            game.respawn()
            observation = game.observe()
            ticks = elapsed = random.randint(*TICKS_PER_ACTION)
            continue
        state = radar(observation, game.info, elapsed)
        action, log_prob, value = act(net, state)
        turn, boost = ACTIONS[action]
        me = observation['me']
        game.steer(me['angle'] + turn)
        game.boost(boost and me['points'] > 0)
        while True:
            next_observation = game.observe()
            if not next_observation['alive'] or next_observation['tick'] - observation['tick'] >= ticks:
                break
        elapsed = next_observation['tick'] - observation['tick']
        reward = reward_for(observation, next_observation, config)
        done = not next_observation['alive']
        for name, item in (('states', state), ('actions', action), ('log_probs', log_prob),
                           ('values', value), ('rewards', reward * config['reward_scale']), ('dones', float(done))):
            segment[name].append(item)
        episode_return += reward
        steps += 1

        if done:
            send(0.0)
            metrics = {'reward': episode_return, 'steps': steps, 'kills': next_observation['kills'] - episode_kills,
                       'dropped_steps': dropped}
            try:
                metrics.update(learner_stats.get_nowait())
            except queue.Empty:
                pass
            game.log(**metrics)
            print(f'{label}: return {episode_return:.1f}, steps {steps}', flush=True)
            episode_return, steps, dropped = 0.0, 0, 0
            episode_kills = next_observation['kills']
        elif len(segment['actions']) >= config['segment_steps']:
            send(act(net, radar(next_observation, game.info, elapsed))[2])
        observation = next_observation


def keep_playing(url, run, net, rollouts, learner_stats, label, config):
    while True:
        started = time.monotonic()
        try:
            play_session(url, run, net, rollouts, learner_stats, label, config)
        except ConnectionError as error:
            if time.monotonic() - started > RECONNECT_SECONDS:
                print(f'{label}: {error}, reconnecting', flush=True)
            time.sleep(RECONNECT_SECONDS)


def play_server(url, run, numbers, net, rollouts, learner_stats, config):
    torch.set_num_threads(1)
    rollouts.cancel_join_thread()
    threads = [threading.Thread(target=keep_playing, daemon=True,
                                args=(url, run, net, rollouts, learner_stats, f'{url} session {number}', config))
               for number in numbers]
    for thread in threads:
        thread.start()
    try:
        for thread in threads:
            thread.join()
    except KeyboardInterrupt:
        pass


def save(net, optimizer, update, folder):
    folder.mkdir(parents=True, exist_ok=True)
    checkpoint = {'model': net.state_dict(), 'optimizer': optimizer.state_dict(), 'update': update}
    torch.save(checkpoint, folder / f'update-{update}.pt')
    torch.save(checkpoint, folder / 'latest.pt')


def learn(net, shared, optimizer, update, rollouts, learner_stats, folder, config, last_update=None):
    cycle = time.monotonic()
    try:
        while last_update is None or update < last_update:
            segments, collected = [], 0
            while collected < config['batch_steps']:
                segments.append(rollouts.get())
                collected += len(segments[-1]['actions'])
            training = time.monotonic()
            batch = {name: torch.as_tensor(np.concatenate([segment[name] for segment in segments])).to(DEVICE)
                     for name in segments[0]}
            batch['advantages'] = (batch['advantages'] - batch['advantages'].mean()) / (batch['advantages'].std() + 1e-8)

            clipped = []
            for _ in range(config['epochs']):
                for indices in torch.randperm(collected, device=DEVICE).split(config['minibatch_size']):
                    logits, values = net(batch['states'][indices])
                    distribution = Categorical(logits=logits)
                    log_ratio = distribution.log_prob(batch['actions'][indices]) - batch['log_probs'][indices]
                    ratio = torch.exp(log_ratio)
                    clipped.append(((ratio - 1).abs() > config['clip_range']).float().mean())
                    advantage = batch['advantages'][indices]
                    policy_loss = -torch.min(ratio * advantage,
                                             ratio.clamp(1 - config['clip_range'], 1 + config['clip_range']) * advantage).mean()
                    value_loss = (batch['returns'][indices] - values).pow(2).mean()
                    entropy = distribution.entropy().mean()
                    loss = policy_loss + config['value_coef'] * value_loss - config['entropy_coef'] * entropy
                    optimizer.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(net.parameters(), config['max_grad_norm'])
                    optimizer.step()

            shared.load_state_dict(net.state_dict())
            update += 1
            approx_kl = ((ratio - 1) - log_ratio).mean().item()
            clip_frac = torch.stack(clipped).mean().item()
            now = time.monotonic()
            busy = 100 * (now - training) / (now - cycle)
            cycle = now
            learner_stats.put({'loss/policy': policy_loss.item(), 'loss/value': value_loss.item(),
                               'entropy': entropy.item(), 'entropy_pct': 100 * entropy.item() / math.log(len(ACTIONS)),
                               'approx_kl': approx_kl, 'clip_frac': clip_frac, 'learner_busy_pct': busy, 'update': update})
            print(f'update {update}: {collected} steps, policy loss {policy_loss.item():.3f}, '
                  f'value loss {value_loss.item():.3g}, entropy {entropy.item():.3f}, '
                  f'kl {approx_kl:.3g}, clipped {clip_frac:.0%}, busy {busy:.0f}%', flush=True)
            if update % config['checkpoint_every'] == 0:
                save(shared, optimizer, update, folder)
    except KeyboardInterrupt:
        pass
    save(shared, optimizer, update, folder)
    print(f'saved {folder / "latest.pt"} at update {update}')


class Discard:
    def put(self, item):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='http://127.0.0.1')
    parser.add_argument('--ports', default='3030',
                        help='servers: 3030, 3031-3050 or 3031,3035; 3031-3040:1,3041-3050:10 sets the sessions of each group')
    parser.add_argument('--sessions', type=int, default=1, help='training sessions per server without its own count')
    parser.add_argument('--run', default='ppo-1')
    parser.add_argument('--updates', type=int, help='stop after this many model updates in this run (default: until Ctrl+C)')
    parser.add_argument('--model', type=Path, help="checkpoint to start from (default: this run's latest.pt if it exists)")
    parser.add_argument('--play', action='store_true', help="play the model without training, logged as <run>-play")
    for name, default in PARAMETERS.items():
        parser.add_argument(f'--{name.replace("_", "-")}', dest=name, type=type(default), metavar=str(default),
                            help="overrides checkpoints/<run>/config.json and the lab panel")
    args = parser.parse_args()
    rooms = parse_rooms(args.ports, args.sessions)
    url = f'{args.host}:{next(iter(rooms))}'

    folder = CHECKPOINTS / args.run
    trainer = folder / 'trainer.py'
    if trainer.exists() and trainer.resolve() != Path(__file__).resolve():
        print(f'run {args.run} has its own trainer: {trainer}', flush=True)
        os.execv(sys.executable, [sys.executable, str(trainer), *sys.argv[1:]])
    stream_output(url, f'{args.run}-play' if args.play else args.run)

    config_file = folder / 'config.json'
    overrides = {name: getattr(args, name) for name in PARAMETERS if getattr(args, name) is not None}
    try:
        saved = PARAMETERS | parameters(json.loads(config_file.read_text()) if config_file.exists() else {}, config_file)
        config = (saved | overrides if args.play else
                  parameters(sync_config(url, args.run, saved, overrides), 'the lab panel'))
    except (ValueError, OSError) as error:
        sys.exit(f'{parser.prog}: error: {error}')
    if not args.play:
        folder.mkdir(parents=True, exist_ok=True)
        config_file.write_text(json.dumps(config, indent=2) + '\n')
        changed = {name: value for name, value in config.items() if value != saved[name]}
        print(f'parameters: {config_file}' + (f', changed: {changed}' if changed else ''), flush=True)

    update = 0
    model = args.model or folder / 'latest.pt'
    checkpoint = torch.load(model, weights_only=True, map_location='cpu') if args.model or model.exists() else None
    if args.play and not checkpoint:
        parser.error(f'no model at {model}')
    net = ActorCritic()
    learner = ActorCritic().to(DEVICE)
    optimizer = torch.optim.Adam(learner.parameters())
    if checkpoint:
        net.load_state_dict(checkpoint['model'])
        learner.load_state_dict(checkpoint['model'])
        optimizer.load_state_dict(checkpoint['optimizer'])
        update = checkpoint['update']
        print(f'continuing {model} from update {update}', flush=True)
    else:
        print(f'new model for run {args.run}', flush=True)
    for group in optimizer.param_groups:
        group['lr'] = config['learning_rate']
    if not trainer.exists() and not args.play:
        shutil.copy(__file__, trainer)
        shutil.copy(HERE / 'pixel_snake_lab.py', folder)

    if args.play:
        sessions = [threading.Thread(target=keep_playing, daemon=True,
                                     args=(f'{args.host}:{port}', f'{args.run}-play', net, Discard(), queue.Queue(),
                                           f'{args.host}:{port} session {number}', config))
                    for port, count in rooms.items() for number in range(count)]
        for session in sessions:
            session.start()
        try:
            for session in sessions:
                session.join()
        except KeyboardInterrupt:
            pass
        sys.exit()

    net.share_memory()
    # Sessions drop segments the learner has no room for, so it always trains on what the current policy just played.
    rollouts = mp.Queue(2 * config['batch_steps'] // config['segment_steps'])
    learner_stats = mp.Queue()
    # Nobody drains the pipes after Ctrl+C, so joining the feeder threads at exit would hang.
    learner_stats.cancel_join_thread()
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    for port, count in rooms.items():
        for first in range(0, count, PROCESS_SESSIONS):
            numbers = range(first, min(first + PROCESS_SESSIONS, count))
            mp.Process(target=play_server, args=(f'{args.host}:{port}', args.run, numbers, net, rollouts, learner_stats, config),
                       daemon=True).start()
    print(f'learning on {DEVICE}', flush=True)
    learn(learner, net, optimizer, update, rollouts, learner_stats, folder, config,
          update + args.updates if args.updates else None)
