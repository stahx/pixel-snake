import math

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

from pixel_snake_lab import fog_radius

TURNS = (-0.32, -0.16, 0.0, 0.16, 0.32)
ACTIONS = [(turn, boost) for turn in TURNS for boost in (False, True)]

GRID_SIZE = 24
GRID_CELL = 50.0
FOOD, ENEMY_TAIL, ENEMY_HEAD, ENEMY_FORWARD, ENEMY_RIGHT, ENEMY_BOOST, ENEMY_SIZE, OWN_TAIL, VISIBLE = range(9)
GRID_CHANNELS = 9
SELF_FEATURES = 4
RADAR_FEATURES = GRID_CHANNELS * GRID_SIZE * GRID_SIZE + SELF_FEATURES
HIDDEN_SIZE = 128


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


def load(path):
    net = ActorCritic()
    net.load_state_dict(torch.load(path, weights_only=True, map_location='cpu')['model'])
    return net


def act(net, state):
    with torch.no_grad():
        logits, value = net(torch.as_tensor(state))
    distribution = Categorical(logits=logits)
    action = distribution.sample()
    return action.item(), distribution.log_prob(action).item(), value.item()


def wrapped(delta, size):
    return (delta + size / 2) % size - size / 2


CELL_GAPS = np.abs(np.arange(GRID_SIZE) - GRID_SIZE / 2 + 0.5) * GRID_CELL - GRID_CELL / 2
CELL_NEAREST = np.hypot(*np.meshgrid(CELL_GAPS, CELL_GAPS, indexing='ij'))


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
