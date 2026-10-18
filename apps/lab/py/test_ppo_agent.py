import math

import numpy as np
import pytest

from ppo_agent import DANGER_SECTORS, FOOD_SLOTS, VIEW_DISTANCE, advantages, features

INFO = {'map': {'width': 4000, 'height': 4000}}


def test_features():
    me = {'type': 'player', 'player': 'me', 'x': 3990, 'y': 1995, 'size': 10, 'angle': 0.0, 'points': 0, 'boosting': 0}
    observation = {'me': me, 'entities': {
        1: me,
        2: {'type': 'point', 'x': 100, 'y': 2000, 'size': 16},
        3: {'type': 'tail', 'player': 'me', 'x': 3900, 'y': 2000},
        4: {'type': 'tail', 'player': 'other', 'x': 3995, 'y': 2250},
    }}

    state = features(observation, INFO)
    food = state[:3]
    danger = state[FOOD_SLOTS * 3:FOOD_SLOTS * 3 + DANGER_SECTORS]

    assert food.tolist() == pytest.approx([105 / VIEW_DISTANCE, 0.0, 1.0])
    assert state[3:FOOD_SLOTS * 3].tolist() == [0.0] * 6
    right_side = int((math.pi / 2 + math.pi) / (2 * math.pi) * DANGER_SECTORS)
    assert danger[right_side] == pytest.approx(1 - 250 / VIEW_DISTANCE)
    assert np.count_nonzero(danger) == 1


def test_advantages():
    advantage, returns = advantages([1.0, 1.0], [0.5, 0.5], [0.0, 1.0], last_value=9.0)

    last = 1.0 - 0.5
    first = 1.0 + 0.99 * 0.5 - 0.5 + 0.99 * 0.95 * last
    assert advantage.tolist() == pytest.approx([first, last])
    assert returns.tolist() == pytest.approx([first + 0.5, last + 0.5])
