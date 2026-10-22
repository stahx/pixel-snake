import random
import time
from typing import NamedTuple

import numpy as np

from model import ACTIONS, act, radar

TICKS_PER_ACTION = (3, 6)
RECONNECT_SECONDS = 5


class Step(NamedTuple):
    state: np.ndarray
    action: int
    log_prob: float
    value: float
    observation: dict
    next_observation: dict
    elapsed: int


def play(game, net):
    observation = game.observe()
    ticks = elapsed = random.randint(*TICKS_PER_ACTION)
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
        yield Step(state, action, log_prob, value, observation, next_observation, elapsed)
        observation = next_observation


def keep_playing(session, label):
    while True:
        started = time.monotonic()
        try:
            session()
        except ConnectionError as error:
            if time.monotonic() - started > RECONNECT_SECONDS:
                print(f'{label}: {error}, reconnecting', flush=True)
            time.sleep(RECONNECT_SECONDS)
