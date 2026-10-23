import math

import numpy as np
import pytest
import torch

from model import (ACTIONS, ENEMY_BOOST, ENEMY_FORWARD, ENEMY_HEAD, ENEMY_RIGHT, ENEMY_SIZE, ENEMY_TAIL, FOOD,
                   GRID_CHANNELS, GRID_SIZE, OWN_TAIL, RADAR_FEATURES, SELF_FEATURES, VISIBLE, ActorCritic, act, load,
                   radar)

INFO = {'map': {'width': 4000, 'height': 4000}, 'growth': {'spawnSize': 10, 'maxSize': 100},
        'fogRadius': {'min': 300, 'max': 2500}}


def test_load(tmp_path):
    net = ActorCritic()
    torch.save({'model': net.state_dict(), 'update': 7}, tmp_path / 'latest.pt')
    state = torch.rand(RADAR_FEATURES)

    logits, value = load(tmp_path / 'latest.pt')(state)
    expected_logits, expected_value = net(state)
    assert torch.equal(logits, expected_logits) and torch.equal(value, expected_value)


def test_act():
    action, log_prob, value = act(ActorCritic(), np.zeros(RADAR_FEATURES, dtype=np.float32))

    assert action in range(len(ACTIONS))
    assert log_prob <= 0 and isinstance(value, float)


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
