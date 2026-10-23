import argparse
import json
import math
import os
import queue
import shutil
import signal
import sys
import threading
import time
from functools import partial
from pathlib import Path

import numpy as np
import torch
import torch.multiprocessing as mp
from torch import nn
from torch.distributions import Categorical

from controller import keep_playing, play
from model import ACTIONS, ActorCritic, act, radar
from pixel_snake_lab import Game, find_worlds, stream_output, sync_config

PROCESS_SESSIONS = 5
DEVICE = torch.accelerator.current_accelerator() or torch.device('cpu')

PARAMETERS = {
    'kill_reward': 30.0,
    'kill_share': 0.5,
    'cutoff_reward': 0.0,
    'death_penalty': -50.0,
    'death_points_share': 1.0,
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
RUN_FILES = ('model.py', 'controller.py', 'pixel_snake_lab.py')
CUTOFF_DISTANCE = 150
CUTOFF_SIZES = 3


def parameters(values, source):
    unknown = sorted(values.keys() - PARAMETERS.keys())
    if unknown:
        raise ValueError(f'unknown parameters in {source}: {", ".join(unknown)}')
    for name, value in values.items():
        if isinstance(PARAMETERS[name], int) and not float(value).is_integer():
            raise ValueError(f'{name} must be a whole number, got {value} in {source}')
    return {name: type(default)(values[name]) for name, default in PARAMETERS.items() if name in values}


def cutoff(kill):
    return kill['distance'] <= max(CUTOFF_DISTANCE, CUTOFF_SIZES * kill['size'])


def reward_for(observation, next_observation, config):
    kills = sum(config['kill_reward'] + config['kill_share'] * kill['points'] + config['cutoff_reward'] * cutoff(kill)
                for kill in next_observation['seen_kills'][len(observation['seen_kills']):])
    if not next_observation['alive']:
        return kills + config['death_penalty'] - config['death_points_share'] * observation['me']['points']
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


def train_session(group, world, run, net, rollouts, learner_stats, label, config):
    game = Game(group, run=run, world=world)
    segment = {'states': [], 'actions': [], 'log_probs': [], 'values': [], 'rewards': [], 'dones': []}
    episode_return = 0.0
    episode_kills = 0
    episode_seen = 0
    steps = 0
    ticks = 0
    dropped = 0
    boosts = {'small': [0, 0], 'big': [0, 0]}

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

    for step in play(game, net):
        me = step.observation['me']
        counts = boosts['big' if me['size'] >= game.info['growth']['maxSize'] / 2 else 'small']
        counts[0] += 1
        counts[1] += ACTIONS[step.action][1] and me['points'] > 0
        reward = reward_for(step.observation, step.next_observation, config)
        done = not step.next_observation['alive']
        for name, item in (('states', step.state), ('actions', step.action), ('log_probs', step.log_prob),
                           ('values', step.value), ('rewards', reward * config['reward_scale']), ('dones', float(done))):
            segment[name].append(item)
        episode_return += reward
        steps += 1
        ticks += step.elapsed

        if done:
            send(0.0)
            metrics = {'reward': episode_return, 'steps': steps, 'kills': step.next_observation['kills'] - episode_kills,
                       'dropped_steps': dropped,
                       **{f'boost_{size}_pct': 100 * boosted / total for size, (total, boosted) in boosts.items() if total}}
            seen = step.next_observation['seen_kills'][episode_seen:]
            metrics.update({'kills_seen': len(seen), 'cutoffs': sum(map(cutoff, seen)),
                            'kills_per_min': len(seen) / (ticks / game.info['tickRate'] / 60)})
            try:
                metrics.update(learner_stats.get_nowait())
            except queue.Empty:
                pass
            game.log(**metrics)
            print(f'{label}: return {episode_return:.1f}, steps {steps}', flush=True)
            episode_return, steps, dropped, ticks = 0.0, 0, 0, 0
            boosts = {'small': [0, 0], 'big': [0, 0]}
            episode_kills = step.next_observation['kills']
            episode_seen = len(step.next_observation['seen_kills'])
        elif len(segment['actions']) >= config['segment_steps']:
            send(act(net, radar(step.next_observation, game.info, step.elapsed))[2])


def play_world(group, world, run, numbers, net, rollouts, learner_stats, config):
    torch.set_num_threads(1)
    rollouts.cancel_join_thread()
    threads = []
    for number in numbers:
        label = f'{group} #{world + 1} session {number}'
        session = partial(train_session, group, world, run, net, rollouts, learner_stats, label, config)
        threads.append(threading.Thread(target=keep_playing, args=(session, label), daemon=True))
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--groups', required=True,
                        help='lab groups to play in, e.g. quiet,crowded: every world gets the sessions its group sets')
    parser.add_argument('--run', default='ppo-1')
    parser.add_argument('--updates', type=int, help='stop after this many model updates in this run (default: until Ctrl+C)')
    parser.add_argument('--model', type=Path, help="checkpoint to start from (default: this run's latest.pt if it exists)")
    for name, default in PARAMETERS.items():
        parser.add_argument(f'--{name.replace("_", "-")}', dest=name, type=type(default), metavar=str(default),
                            help="overrides checkpoints/<run>/config.json and the lab panel")
    args = parser.parse_args()

    folder = CHECKPOINTS / args.run
    trainer = folder / 'trainer.py'
    if trainer.exists() and trainer.resolve() != Path(__file__).resolve():
        print(f'run {args.run} has its own trainer: {trainer}', flush=True)
        os.execv(sys.executable, [sys.executable, str(trainer), *sys.argv[1:]])
    stream_output(args.run)

    config_file = folder / 'config.json'
    overrides = {name: getattr(args, name) for name in PARAMETERS if getattr(args, name) is not None}
    try:
        saved = PARAMETERS | parameters(json.loads(config_file.read_text()) if config_file.exists() else {}, config_file)
        config = parameters(sync_config(args.run, saved, overrides), 'the lab panel')
        worlds = [(group, world, found['sessions']) for group, listed in find_worlds(args.run, args.groups.split(',')).items()
                  for world, found in enumerate(listed)]
    except (ValueError, OSError) as error:
        sys.exit(f'{parser.prog}: error: {error}')
    folder.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps(config, indent=2) + '\n')
    changed = {name: value for name, value in config.items() if value != saved[name]}
    print(f'parameters: {config_file}' + (f', changed: {changed}' if changed else ''), flush=True)

    update = 0
    model = args.model or folder / 'latest.pt'
    checkpoint = torch.load(model, weights_only=True, map_location='cpu') if args.model or model.exists() else None
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
    if not trainer.exists():
        shutil.copy(__file__, trainer)
        for name in RUN_FILES:
            shutil.copy(HERE / name, folder)

    net.share_memory()
    # Sessions drop segments the learner has no room for, so it always trains on what the current policy just played.
    rollouts = mp.Queue(2 * config['batch_steps'] // config['segment_steps'])
    learner_stats = mp.Queue()
    # Nobody drains the pipes after Ctrl+C, so joining the feeder threads at exit would hang.
    learner_stats.cancel_join_thread()
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    for group, world, count in worlds:
        for first in range(0, count, PROCESS_SESSIONS):
            numbers = range(first, min(first + PROCESS_SESSIONS, count))
            mp.Process(target=play_world, args=(group, world, args.run, numbers, net, rollouts, learner_stats, config),
                       daemon=True).start()
    print(f'learning on {DEVICE}', flush=True)
    learn(learner, net, optimizer, update, rollouts, learner_stats, folder, config,
          update + args.updates if args.updates else None)
