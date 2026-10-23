import itertools
import random
import time

import pytest

from controller import keep_playing, play
from model import ACTIONS, ActorCritic

INFO = {'map': {'width': 4000, 'height': 4000}, 'growth': {'spawnSize': 10, 'maxSize': 100},
        'fogRadius': {'min': 300, 'max': 2500}}


def alive(tick):
    me = {'type': 'player', 'player': 'me', 'x': 2000, 'y': 2000, 'size': 10, 'angle': 0.5, 'points': 0}
    return {'alive': True, 'tick': tick, 'me': me, 'entities': {1: me}}


class FakeGame:
    info = INFO

    def __init__(self, observations):
        self.observations = iter(observations)
        self.steered, self.boosted, self.respawns = [], [], 0

    def observe(self):
        return next(self.observations)

    def steer(self, angle):
        self.steered.append(angle)

    def boost(self, on):
        self.boosted.append(on)

    def respawn(self):
        self.respawns += 1


def test_play(monkeypatch):
    monkeypatch.setattr(random, 'randint', lambda low, high: 4)
    dead = {'alive': False, 'tick': 6, 'me': None, 'entities': {}}
    game = FakeGame([alive(0), alive(1), alive(4), dead, alive(10), alive(14)])

    steps = list(itertools.islice(play(game, ActorCritic()), 3))

    assert [step.elapsed for step in steps] == [4, 2, 4]
    assert [step.next_observation['alive'] for step in steps] == [True, False, True]
    assert game.respawns == 1
    assert all(step.action in range(len(ACTIONS)) for step in steps)
    assert game.steered == [pytest.approx(0.5 + ACTIONS[step.action][0]) for step in steps]
    assert game.boosted == [False, False, False]


def test_keep_playing(monkeypatch):
    calls = []

    def session():
        calls.append(len(calls))
        if len(calls) < 3:
            raise ConnectionError('Disconnected from the world')
        raise KeyboardInterrupt

    monkeypatch.setattr(time, 'sleep', lambda seconds: None)
    with pytest.raises(KeyboardInterrupt):
        keep_playing(session, 'quiet #2 session 0')

    assert calls == [0, 1, 2]
