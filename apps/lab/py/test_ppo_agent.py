import math
import queue

import numpy as np
import pytest
import torch

from model import ACTIONS, RADAR_FEATURES, ActorCritic
from ppo_agent import DEVICE, PARAMETERS, advantages, learn, parameters, reward_for, save


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
