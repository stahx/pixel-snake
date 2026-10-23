import math
import queue

import numpy as np
import pytest
import torch

import ppo_agent
from controller import Step
from model import ACTIONS, RADAR_FEATURES, ActorCritic
from ppo_agent import DEVICE, PARAMETERS, advantages, learn, parameters, reward_for, save, train_session


def test_advantages():
    advantage, returns = advantages([1.0, 1.0], [0.5, 0.5], [0.0, 1.0], 9.0, PARAMETERS)

    last = 1.0 - 0.5
    first = 1.0 + 0.99 * 0.5 - 0.5 + 0.99 * 0.95 * last
    assert advantage.tolist() == pytest.approx([first, last])
    assert returns.tolist() == pytest.approx([first + 0.5, last + 0.5])


def test_reward_for():
    earlier = {'points': 40, 'distance': 400.0, 'size': 20}
    alive = {'alive': True, 'me': {'points': 120}, 'seen_kills': [earlier]}
    far = {'points': 60, 'distance': 400.0, 'size': 20}
    cut = {'points': 0, 'distance': 50.0, 'size': 20}
    big_cut = {'points': 0, 'distance': 250.0, 'size': 100}
    dead = {'alive': False, 'me': None, 'seen_kills': [earlier]}

    assert reward_for(alive, {'alive': True, 'me': {'points': 123}, 'seen_kills': [earlier]}, PARAMETERS) == 3
    assert reward_for(alive, {'alive': True, 'me': {'points': 123}, 'seen_kills': [earlier, far]}, PARAMETERS) == 63
    assert reward_for(alive, {'alive': True, 'me': {'points': 120}, 'seen_kills': [earlier, far, cut, big_cut]},
                      PARAMETERS | {'cutoff_reward': 500.0}) == 60 + 530 + 530
    assert reward_for(alive, dead, PARAMETERS) == -170
    assert reward_for(alive, dead, PARAMETERS | {'death_penalty': -10.0}) == -130
    assert reward_for(alive, dead, PARAMETERS | {'death_points_share': 0.3}) == pytest.approx(-86)


def test_parameters():
    assert parameters({'epochs': 8.0, 'gamma': 1}, 'config.json') == {'epochs': 8, 'gamma': 1.0}
    assert type(parameters({'epochs': 8.0}, 'config.json')['epochs']) is int
    with pytest.raises(ValueError, match='unknown parameters in config.json: lr'):
        parameters({'lr': 1}, 'config.json')
    with pytest.raises(ValueError, match='epochs must be a whole number'):
        parameters({'epochs': 4.5}, 'the lab panel')


def test_save(tmp_path):
    net = ActorCritic()
    save(net, torch.optim.Adam(net.parameters()), 7, tmp_path)

    checkpoint = torch.load(tmp_path / 'latest.pt', weights_only=True)
    loaded = ActorCritic()
    loaded.load_state_dict(checkpoint['model'])
    logits, value = loaded(torch.zeros(RADAR_FEATURES))
    assert checkpoint['update'] == 7
    assert logits.shape == (len(ACTIONS),) and value.shape == ()


def test_learn(tmp_path):
    shared = ActorCritic()
    net = ActorCritic().to(DEVICE)
    net.load_state_dict(shared.state_dict())
    before = next(shared.parameters()).clone()
    rollouts = queue.Queue()
    for _ in range(2):
        rollouts.put({'states': np.random.rand(128, RADAR_FEATURES).astype(np.float32),
                      'actions': np.random.randint(len(ACTIONS), size=128),
                      'log_probs': np.full(128, -math.log(len(ACTIONS)), dtype=np.float32),
                      'advantages': np.random.randn(128).astype(np.float32),
                      'returns': np.random.randn(128).astype(np.float32)})
    config = PARAMETERS | {'batch_steps': 256, 'minibatch_size': 128}
    stats = queue.Queue()
    learn(net, shared, torch.optim.Adam(net.parameters()), 0, rollouts, stats, tmp_path, config, last_update=1)

    after = next(shared.parameters())
    assert not torch.equal(after, before)
    assert torch.equal(after, next(net.parameters()).cpu())
    assert torch.load(tmp_path / 'latest.pt', weights_only=True, map_location='cpu')['update'] == 1
    logged = stats.get_nowait()
    assert logged['update'] == 1 and logged['approx_kl'] >= 0
    assert 0 <= logged['clip_frac'] <= 1 and 0 < logged['learner_busy_pct'] <= 100


def test_train_session(monkeypatch):
    logged = []

    class FakeGame:
        info = {'growth': {'maxSize': 100}, 'tickRate': 60}

        def __init__(self, *args, **kwargs):
            pass

        def log(self, **metrics):
            logged.append(metrics)

    cut = {'points': 0, 'distance': 30.0, 'size': 60}

    def step(boost, size, alive=True, seen=(), seen_next=()):
        action = ACTIONS.index((0.0, boost))
        observation = {'alive': True, 'me': {'size': size, 'points': 50}, 'kills': 0, 'seen_kills': list(seen)}
        next_observation = {'alive': alive, 'me': {'size': size, 'points': 50} if alive else None, 'kills': 0,
                            'seen_kills': list(seen_next)}
        return Step(np.zeros(RADAR_FEATURES, dtype=np.float32), action, -1.0, 0.0, observation, next_observation, 4)

    steps = [step(True, 10), step(False, 10), step(True, 60, seen_next=[cut]), step(True, 60, alive=False, seen=[cut], seen_next=[cut])]
    monkeypatch.setattr(ppo_agent, 'Game', FakeGame)
    monkeypatch.setattr(ppo_agent, 'play', lambda game, net: iter(steps))
    rollouts = queue.Queue()
    train_session('quiet', 0, 'run', None, rollouts, queue.Queue(), 'quiet #1 session 0', PARAMETERS)

    assert logged == [{'reward': pytest.approx(-70.0), 'steps': 4, 'kills': 0, 'dropped_steps': 0,
                       'boost_small_pct': 50.0, 'boost_big_pct': 100.0,
                       'kills_seen': 1, 'cutoffs': 1, 'kills_per_min': pytest.approx(225.0)}]
    assert rollouts.get_nowait()['actions'].tolist() == [step.action for step in steps]
