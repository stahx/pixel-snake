import math
import queue
import time

import numpy as np
import pytest
import torch

import ppo_agent
from ppo_agent import (ACTIONS, DEVICE, ENEMY_BOOST, ENEMY_FORWARD, ENEMY_HEAD, ENEMY_RIGHT, ENEMY_SIZE, ENEMY_TAIL, FOOD,
                       GRID_CHANNELS, GRID_SIZE, OWN_TAIL, PARAMETERS, RADAR_FEATURES, SELF_FEATURES, VISIBLE, ActorCritic,
                       advantages, keep_playing, learn, parameters, radar, reward_for, save)

INFO = {'map': {'width': 4000, 'height': 4000}, 'growth': {'spawnSize': 10, 'maxSize': 100},
        'fogRadius': {'min': 300, 'max': 2500}}


def test_radar():
    me = {'type': 'player', 'player': 'me', 'x': 3990, 'y': 1995, 'size': 10, 'angle': 0.0, 'points': 0, 'boosting': 0}
    observation = {'me': me, 'entities': {
        1: me,
        2: {'type': 'point', 'x': 100, 'y': 2000, 'size': 16},
        3: {'type': 'tail', 'player': 'me', 'x': 3900, 'y': 2000},
        4: {'type': 'tail', 'player': 'other', 'x': 3995, 'y': 2250},
        5: {'type': 'player', 'player': 'other', 'x': 3970, 'y': 2380, 'size': 50, 'angle': math.pi,
            'boosting': 1},
    }}

    state = radar(observation, INFO, 4)
    grid = state[:-SELF_FEATURES].reshape(GRID_CHANNELS, GRID_SIZE, GRID_SIZE)

    assert len(state) == RADAR_FEATURES
    assert {tuple(cell) for cell in np.argwhere(grid[:VISIBLE].round(6))} == {
        (FOOD, 9, 12), (OWN_TAIL, 13, 12), (ENEMY_TAIL, 11, 17),
        (ENEMY_HEAD, 12, 20), (ENEMY_FORWARD, 12, 20), (ENEMY_BOOST, 12, 20), (ENEMY_SIZE, 12, 20)}
    assert grid[[ENEMY_FORWARD, ENEMY_RIGHT], 12, 20] == pytest.approx([-1, 0], abs=1e-6)
    assert grid[ENEMY_SIZE, 12, 20] == pytest.approx(math.log(5))
    assert grid[VISIBLE, 12, 18] == 1
    assert grid[VISIBLE, 12, 19] == 0
    assert radar({**observation, 'me': {**me, 'size': 100}}, INFO, 4)[:-SELF_FEATURES].reshape(
        GRID_CHANNELS, GRID_SIZE, GRID_SIZE)[VISIBLE].all()
    assert state[-SELF_FEATURES:].tolist() == pytest.approx([0.0, 0.0, 0.1, 4 / 6])
    assert radar(observation, INFO, 90)[-1] == 4


def test_advantages():
    advantage, returns = advantages([1.0, 1.0], [0.5, 0.5], [0.0, 1.0], 9.0, PARAMETERS)

    last = 1.0 - 0.5
    first = 1.0 + 0.99 * 0.5 - 0.5 + 0.99 * 0.95 * last
    assert advantage.tolist() == pytest.approx([first, last])
    assert returns.tolist() == pytest.approx([first + 0.5, last + 0.5])


def test_reward_for():
    alive = {'alive': True, 'me': {'points': 120}, 'kills': 2, 'kill_points': 40}

    assert reward_for(alive, {'alive': True, 'me': {'points': 123}, 'kills': 2, 'kill_points': 40}, PARAMETERS) == 3
    assert reward_for(alive, {'alive': True, 'me': {'points': 123}, 'kills': 3, 'kill_points': 100}, PARAMETERS) == 63
    assert reward_for(alive, {'alive': False, 'me': None, 'kills': 2, 'kill_points': 40}, PARAMETERS) == -170
    assert reward_for(alive, {'alive': False, 'me': None, 'kills': 2, 'kill_points': 40},
                      PARAMETERS | {'death_penalty': -10.0}) == -130


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


def test_keep_playing(monkeypatch):
    calls = []

    def play_session(*args):
        calls.append(args)
        if len(calls) < 3:
            raise ConnectionError('Disconnected from the world')
        raise KeyboardInterrupt

    monkeypatch.setattr(ppo_agent, 'play_session', play_session)
    monkeypatch.setattr(time, 'sleep', lambda seconds: None)
    with pytest.raises(KeyboardInterrupt):
        keep_playing('quiet', 1, 'run', None, None, None, 'quiet #2 session 0', PARAMETERS)

    assert len(calls) == 3
    assert calls[0][:3] == ('quiet', 1, 'run')
