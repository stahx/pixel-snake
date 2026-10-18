# Pixel Snake RL lab

Write a training algorithm in Python that plays the live game on the running
server. The agent joins as a normal snake, sees only what a player sees (fog of
war), and acts through the same events as the browser client. Learning happens
online inside your trainer; the server only keeps progress for the lab panel.

## Setup

Lab setup on the server is in the root README. Create a key in the panel
(`/lab/` → Klucze), then:

```sh
cd apps/lab
pip install -r requirements.txt   # or: uv pip install -r requirements.txt
cp .env.example .env              # paste the key after PIXEL_SNAKE_LAB_KEY=
python example_agent.py
```

## How the agent connects

`Game(url='http://127.0.0.1:3030', run='TRAINING', key=None)` opens the `/lab`
Socket.IO namespace with `auth={'key': ..., 'run': ...}`. `key` defaults to
`PIXEL_SNAKE_LAB_KEY`, read from the environment or from `apps/lab/.env` (the
environment wins). A valid key puts the snake straight into the game, with
no start button and no nickname form; the nickname is the run name (shown cut
to 15 characters). Run names match `[A-Za-z0-9_ .:-]{1,40}`.

Connections with the same key and run name are one run in the panel, so
parallel agents of one experiment share a learning curve. A missing, wrong or
revoked key raises `ConnectionError` with the server's reason. Revoking the key
in the panel disconnects running agents, and the next `observe()` raises
`ConnectionError`; the SDK does not reconnect on its own.

## What the game gives you

`game.info` holds the base state, sent on connect (call `game.refresh_info()`
to fetch it again):

| Field | Meaning |
| --- | --- |
| `map.width`, `map.height`, `map.wraps` | World size; edges wrap around (torus) |
| `tickRate` | Server ticks per second (60) |
| `speed.normal`, `speed.boost` | Pixels moved per tick |
| `maxTurnPerTick` | Max heading change per tick, radians |
| `boostCost` | Boost costs `points` every `everyTicks` ticks |
| `fogRadius.min/max` | View radius, grows with snake size |
| `pointsOnMap`, `players.total/bots/clients` | Current population |
| `actions` | Every event the agent may send, with its payload |

`game.observe()` blocks until the next server tick and returns:

```python
{
  'tick': 1234,              # client-side counter of received updates
  'alive': True,
  'me': {...},               # your player entity, None when dead
  'entities': {id: {...}},   # everything inside your fog radius
  'leaderboard': [{'name': ..., 'points': ...}],
}
```

Entity fields: `id`, `type` (`point` | `tail` | `player`), `x`, `y`, `color`,
plus `size` (point, player), `player` (owner socket id for tail and player),
`name`, `points`, `angle`, `boosting` (player). Your own entities have
`player == game.sid`. Coordinates are world pixels with y pointing down;
`angle` is in radians in that space.

Feature extraction is up to your algorithm: the SDK hands over raw entities and
does not build an observation vector.

## The hands

| Call | Event sent | Effect |
| --- | --- | --- |
| `game.steer(angle)` | `change-dir` | Head toward an absolute heading (radians) |
| `game.aim(x, y)` | `change-dir` | Head toward a world point |
| `game.boost(True/False)` | `player-speed` | Boost on/off; the server turns it off at 0 points |
| `game.respawn()` | `player-join` | New snake after death |
| `game.close()` | disconnect | Leave the game |

Turning is rate-limited by `maxTurnPerTick`, so a new heading takes several
ticks to reach.

## Episode loop

An episode starts at spawn and ends when `observation['alive']` becomes
`False`, which is the server's `ded` event. Reward is defined by your algorithm. The example
uses the change in points per step and −100 on death. Call `game.respawn()` to
start the next episode.

```python
from pixel_snake_lab import Game

game = Game(run='ppo-run-1')
observation = game.observe()
while True:
    action = my_policy(features(observation, game.info))
    apply(action, game)               # steer / boost
    next_observation = game.observe()
    my_learner.record(observation, action, reward(observation, next_observation), not next_observation['alive'])
    observation = next_observation
    if not observation['alive']:
        stats = my_learner.update()
        game.log(loss=stats.loss, entropy=stats.entropy, reward=stats.episode_return)
        game.respawn()
        observation = game.observe()
```

The game runs in real time at 60 ticks/s, shared with any humans and bots on
the server. Several agents can train in parallel by opening several `Game`
connections.

## Many agents, many rooms

`example_agent.py` runs one Python process per server and one thread per
training session:

```sh
python example_agent.py                                  # 1 session on :3030
python example_agent.py --sessions 5                     # 5 sessions on :3030
python example_agent.py --ports 3031-3050 --sessions 5   # 5 sessions on each of 20 rooms
python example_agent.py --ports 3030,3035-3036           # a list of servers
```

Start the rooms first (`pnpm lab:rooms 20`, root README). Other flags:
`--episodes` (per session, default 3), `--run`, `--host`. Ctrl+C stops every
room. All sessions with one key and run name form one run; put the room in
the name (`--run ppo-1:r3`) to compare rooms. Threads share one CPU core per
process because of the GIL, so keep sessions per server in the tens.

## What the lab records

The server tracks every episode of every lab agent (peak score, survival,
points eaten, points spent on boost, cause: `bot`, `human`, `agent` or
`disconnect`) and writes one averaged row per run every `LAB_FLUSH_MINUTES`,
plus one when the run's last agent disconnects. Your algorithm adds its own
numbers with `game.log(**metrics)`: up to 32 finite numbers per call, names
matching `[A-Za-z0-9_./-]{1,40}`, averaged over the same window and drawn as
separate charts in the panel. Invalid calls come back as a Python warning.

## Tests

```sh
pytest -p no:cacheprovider
```
