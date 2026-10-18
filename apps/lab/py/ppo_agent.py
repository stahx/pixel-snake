import argparse
import math
import queue
import signal
import threading
from pathlib import Path

import numpy as np
import torch
import torch.multiprocessing as mp
from torch import nn
from torch.distributions import Categorical

from pixel_snake_lab import Game, parse_ports

TURNS = (-0.5, 0.0, 0.5)
ACTIONS = [(turn, boost) for turn in TURNS for boost in (False, True)]
TICKS_PER_ACTION = 4
DEATH_PENALTY = -10.0

FOOD_SLOTS = 3
DANGER_SECTORS = 8
VIEW_DISTANCE = 500.0
FEATURE_COUNT = FOOD_SLOTS * 3 + DANGER_SECTORS + 2
HIDDEN_SIZE = 64

SEGMENT_STEPS = 128
BATCH_STEPS = 4096
EPOCHS = 4
MINIBATCH_SIZE = 512
GAMMA = 0.99
GAE_LAMBDA = 0.95
CLIP_RANGE = 0.2
VALUE_COEF = 0.5
ENTROPY_COEF = 0.01
LEARNING_RATE = 3e-4
MAX_GRAD_NORM = 0.5
CHECKPOINT_EVERY = 10

CHECKPOINTS = Path(__file__).parent / 'checkpoints'


class ActorCritic(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(FEATURE_COUNT, HIDDEN_SIZE), nn.Tanh(),
            nn.Linear(HIDDEN_SIZE, HIDDEN_SIZE), nn.Tanh(),
        )
        self.policy = nn.Linear(HIDDEN_SIZE, len(ACTIONS))
        self.value = nn.Linear(HIDDEN_SIZE, 1)

    def forward(self, state):
        hidden = self.body(state)
        return self.policy(hidden), self.value(hidden).squeeze(-1)


def wrapped(delta, size):
    return (delta + size / 2) % size - size / 2


def features(observation, info):
    me = observation['me']
    width, height = info['map']['width'], info['map']['height']
    head_x = me['x'] + me['size'] / 2
    head_y = me['y'] + me['size'] / 2
    cos, sin = math.cos(me['angle']), math.sin(me['angle'])

    def relative(entity):
        dx = wrapped(entity['x'] - head_x, width)
        dy = wrapped(entity['y'] - head_y, height)
        forward = dx * cos + dy * sin
        side = -dx * sin + dy * cos
        return forward, side, math.hypot(forward, side)

    food = sorted((relative(entity) for entity in observation['entities'].values() if entity['type'] == 'point'),
                  key=lambda position: position[2])
    food_features = []
    for slot in range(FOOD_SLOTS):
        if slot < len(food):
            forward, side, _ = food[slot]
            food_features += [forward / VIEW_DISTANCE, side / VIEW_DISTANCE, 1.0]
        else:
            food_features += [0.0, 0.0, 0.0]

    danger = [0.0] * DANGER_SECTORS
    for entity in observation['entities'].values():
        if entity['type'] == 'point' or entity['player'] == me['player']:
            continue
        forward, side, distance = relative(entity)
        sector = int((math.atan2(side, forward) + math.pi) / (2 * math.pi) * DANGER_SECTORS) % DANGER_SECTORS
        danger[sector] = max(danger[sector], 1 - distance / VIEW_DISTANCE)

    own = [math.log1p(me['points']) / 5, float(bool(me.get('boosting')))]
    return np.clip(np.array(food_features + danger + own, dtype=np.float32), -5, 5)


def reward_for(observation, next_observation):
    if not next_observation['alive']:
        return DEATH_PENALTY
    return next_observation['me']['points'] - observation['me']['points']


def advantages(rewards, values, dones, last_value):
    result = np.zeros(len(rewards), dtype=np.float32)
    running = 0.0
    for step in reversed(range(len(rewards))):
        next_value = last_value if step == len(rewards) - 1 else values[step + 1]
        alive = 1.0 - dones[step]
        delta = rewards[step] + GAMMA * next_value * alive - values[step]
        running = delta + GAMMA * GAE_LAMBDA * alive * running
        result[step] = running
    return result, result + np.asarray(values, dtype=np.float32)


def act(net, state):
    with torch.no_grad():
        logits, value = net(torch.as_tensor(state))
    distribution = Categorical(logits=logits)
    action = distribution.sample()
    return action.item(), distribution.log_prob(action).item(), value.item()


def play_session(url, run, net, rollouts, learner_stats, label):
    game = Game(url=url, run=run)
    observation = game.observe()
    segment = {'states': [], 'actions': [], 'log_probs': [], 'values': [], 'rewards': [], 'dones': []}
    episode_return = 0.0
    steps = 0

    def send(last_value):
        advantage, returns = advantages(segment['rewards'], segment['values'], segment['dones'], last_value)
        rollouts.put({'states': np.stack(segment['states']), 'actions': np.array(segment['actions']),
                      'log_probs': np.array(segment['log_probs'], dtype=np.float32),
                      'advantages': advantage, 'returns': returns})
        for values in segment.values():
            values.clear()

    while True:
        if not observation['alive']:
            game.respawn()
            observation = game.observe()
            continue
        state = features(observation, game.info)
        action, log_prob, value = act(net, state)
        turn, boost = ACTIONS[action]
        me = observation['me']
        game.steer(me['angle'] + turn)
        game.boost(boost and me['points'] > 0)
        for _ in range(TICKS_PER_ACTION):
            next_observation = game.observe()
            if not next_observation['alive']:
                break
        reward = reward_for(observation, next_observation)
        done = not next_observation['alive']
        for name, item in (('states', state), ('actions', action), ('log_probs', log_prob),
                           ('values', value), ('rewards', reward), ('dones', float(done))):
            segment[name].append(item)
        episode_return += reward
        steps += 1

        if done:
            send(0.0)
            metrics = {'reward': episode_return, 'steps': steps}
            try:
                metrics.update(learner_stats.get_nowait())
            except queue.Empty:
                pass
            game.log(**metrics)
            print(f'{label}: return {episode_return:.1f}, steps {steps}', flush=True)
            episode_return, steps = 0.0, 0
        elif len(segment['actions']) >= SEGMENT_STEPS:
            send(act(net, features(next_observation, game.info))[2])
        observation = next_observation


def play_server(url, run, sessions, net, rollouts, learner_stats):
    torch.set_num_threads(1)
    threads = [threading.Thread(target=play_session, args=(url, run, net, rollouts, learner_stats, f'{url} session {number}'),
                                daemon=True)
               for number in range(sessions)]
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


def learn(net, optimizer, update, rollouts, learner_stats, folder, last_update=None):
    try:
        while last_update is None or update < last_update:
            segments, collected = [], 0
            while collected < BATCH_STEPS:
                segments.append(rollouts.get())
                collected += len(segments[-1]['actions'])
            batch = {name: torch.as_tensor(np.concatenate([segment[name] for segment in segments])) for name in segments[0]}
            batch['advantages'] = (batch['advantages'] - batch['advantages'].mean()) / (batch['advantages'].std() + 1e-8)

            for _ in range(EPOCHS):
                for indices in torch.randperm(collected).split(MINIBATCH_SIZE):
                    logits, values = net(batch['states'][indices])
                    distribution = Categorical(logits=logits)
                    ratio = torch.exp(distribution.log_prob(batch['actions'][indices]) - batch['log_probs'][indices])
                    advantage = batch['advantages'][indices]
                    policy_loss = -torch.min(ratio * advantage,
                                             ratio.clamp(1 - CLIP_RANGE, 1 + CLIP_RANGE) * advantage).mean()
                    value_loss = (batch['returns'][indices] - values).pow(2).mean()
                    entropy = distribution.entropy().mean()
                    loss = policy_loss + VALUE_COEF * value_loss - ENTROPY_COEF * entropy
                    optimizer.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(net.parameters(), MAX_GRAD_NORM)
                    optimizer.step()

            update += 1
            learner_stats.put({'loss/policy': policy_loss.item(), 'loss/value': value_loss.item(),
                               'entropy': entropy.item(), 'update': update})
            print(f'update {update}: {collected} steps, policy loss {policy_loss.item():.3f}, '
                  f'value loss {value_loss.item():.3f}, entropy {entropy.item():.3f}', flush=True)
            if update % CHECKPOINT_EVERY == 0:
                save(net, optimizer, update, folder)
    except KeyboardInterrupt:
        pass
    save(net, optimizer, update, folder)
    print(f'saved {folder / "latest.pt"} at update {update}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='http://127.0.0.1')
    parser.add_argument('--ports', type=parse_ports, default='3030', help='servers: 3030, 3031-3050 or 3031,3035')
    parser.add_argument('--sessions', type=int, default=1, help='training sessions per server')
    parser.add_argument('--run', default='ppo-1')
    parser.add_argument('--updates', type=int, help='stop after this many model updates in this run (default: until Ctrl+C)')
    parser.add_argument('--resume', type=Path, help='checkpoint to continue from, e.g. checkpoints/ppo-1/latest.pt')
    args = parser.parse_args()

    net = ActorCritic()
    optimizer = torch.optim.Adam(net.parameters(), lr=LEARNING_RATE)
    update = 0
    if args.resume:
        checkpoint = torch.load(args.resume, weights_only=True)
        net.load_state_dict(checkpoint['model'])
        optimizer.load_state_dict(checkpoint['optimizer'])
        update = checkpoint['update']
    net.share_memory()

    rollouts = mp.Queue()
    learner_stats = mp.Queue()
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    for port in args.ports:
        mp.Process(target=play_server, args=(f'{args.host}:{port}', args.run, args.sessions, net, rollouts, learner_stats),
                   daemon=True).start()
    learn(net, optimizer, update, rollouts, learner_stats, CHECKPOINTS / args.run,
          update + args.updates if args.updates else None)
