# Pixel Snake RL lab

Write a training algorithm in Python (`py/`) or JavaScript (`js/`) that plays
the live game on the running server. Both folders hold the same SDK and the
same PPO trainer, so one can be read against the other. The agent joins as a normal snake, sees only what a player sees (fog of
war), and acts through the same events as the browser client. Learning happens
online inside your trainer; the server only keeps progress for the lab panel.

## Setup

Lab setup on the server is in the root README. Create a key in the panel
(`/lab/` → Klucze), then:

```sh
cd apps/lab
cp .env.example .env              # paste the key after PIXEL_SNAKE_LAB_KEY=

# Python
python3 -m venv .venv && source .venv/bin/activate
pip install -r py/requirements.txt
python py/example_agent.py

# JavaScript (from the repo root: pnpm install)
node js/ppo-agent.js
```

`apps/lab/.env` is read by both SDKs; a variable already set in the shell wins.

| Python (`py/`) | JavaScript (`js/`) |
| --- | --- |
| `pixel_snake_lab.py`: `Game(url, run, key)` | `pixel-snake-lab.js`: `await Game.connect({ url, run, key })` |
| `game.observe()` blocks | `await game.observe()` |
| `game.log(loss=0.1)` | `game.log({ loss: 0.1 })` |
| `example_agent.py`: random baseline | — |
| `ppo_agent.py`: PPO in PyTorch | `ppo-agent.js`: PPO in TensorFlow.js |

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
| `maxTurnPerTick` | Max heading change per tick for a small snake, radians |
| `growth` | Growth factor `min(1, points / capPoints)` drives size (from `spawnSize` up to `maxSize`), tail length (up to `maxTailSegments`), speed (down to `1 - slowdown`) and turning radius (`turnRadiusPerSize` × size) |
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
  'kills': 3,                # snakes that died on your tail since connecting
  'kill_points': 250,        # their points summed
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
python py/example_agent.py                                  # 1 session on :3030
python py/example_agent.py --sessions 5                     # 5 sessions on :3030
python py/example_agent.py --ports 3031-3050 --sessions 5   # 5 sessions on each of 20 rooms
python py/example_agent.py --ports 3030,3035-3036           # a list of servers
```

Start the rooms first (`pnpm lab:rooms 20`, root README). Other flags:
`--episodes` (per session, default 3), `--run`, `--host`. Ctrl+C stops every
room. All sessions with one key and run name form one run; put the room in
the name (`--run ppo-1:r3`) to compare rooms. Threads share one CPU core per
process because of the GIL, so keep sessions per server in the tens.

## PPO trainer

`py/ppo_agent.py` and `js/ppo-agent.js` train one actor-critic network
shared by every session:

```sh
python py/ppo_agent.py --ports 3031-3050 --sessions 5 --run ppo-1
python py/ppo_agent.py --ports 3031-3040:1,3041-3050:10 --run ppo-1   # quiet and crowded rooms
python py/ppo_agent.py --ports 3031-3050 --sessions 5 --run ppo-2 --model py/checkpoints/ppo-1/update-800.pt
python py/ppo_agent.py --ports 3030 --sessions 3 --run ppo-1 --play
node js/ppo-agent.js --ports 3031-3050 --sessions 5 --run ppo-js-1
```

A run name owns its model: starting a run whose `checkpoints/<run>/latest.*`
exists continues that model. `--model` starts from a specific checkpoint
instead (an older update, or another run's model); a new run name starts a
new model. The lab panel only holds statistics, never weights.

The learner trains on the GPU when PyTorch finds one (`mps` on Apple silicon,
CUDA), otherwise on the CPU; the log's `learning on …` line says which.

### Parameters

Rewards and PPO settings (`kill_reward`, `death_penalty`, `gamma`,
`learning_rate`, `entropy_coef`, `batch_steps`, …; `--help` lists them with
their defaults) live in `checkpoints/<run>/config.json`. On every start the
trainer takes the file, applies the edits waiting in the lab panel (run →
Parametry), then the command-line flags, writes the result back to the file and
reports it to the panel:

```sh
python py/ppo_agent.py --ports 3031-3046 --sessions 5 --run slither-v6 --death-penalty -80 --gamma 0.995
```

Edits in the panel or the file apply on the trainer's next start (Ctrl+C and
start it again); a running trainer keeps its parameters. The network layout
(radar, actions, layers) is not a parameter: change it in a new run.

### Logs

Everything the trainer prints (the learner, every session, tracebacks) goes to
the terminal as before and to the run's log in the panel (run → Logi trenera),
which keeps the last 2000 lines per run. `--play` logs to `<run>-play`. Other
trainers can do the same with `stream_output(url, run)` from the SDK.

A new Python run copies the trainer into its folder as
`checkpoints/<run>/trainer.py` (with `pixel_snake_lab.py`). Starting
`py/ppo_agent.py --run <run>` later hands over to that copy, so every run keeps
training and playing with the algorithm it started with, whatever
`ppo_agent.py` has become since. `--play` runs the model without training and
logs it to the panel as `<run>-play`.

- Observation (Python): a 24×24 grid of 50 px cells around the head, rotated so
  the heading points up, with layers for food (count, up to 5), enemy tails,
  enemy heads, where each enemy head is going (cos and sin of its heading
  relative to yours), whether it boosts and its size (log of its size over
  yours), your own tail, and which cells are inside your fog radius (so unseen
  is not mistaken for empty), plus log of points, boost flag, size and how many
  ticks the last decision lasted. The fog radius grows from `fogRadius.min` at
  `growth.spawnSize` to `fogRadius.max` at `growth.maxSize`.
- Network (Python): two convolutions over the 9 layers (16 and 32 filters, stride 2) → 128 →
  128 (tanh), a policy head with 10 action scores (5 turns from -0.32 to
  0.32 rad × boost) and a value head. 0.32 rad is the most the server turns
  in 4 ticks; big snakes turn less (turn radius).
- The JavaScript trainer still uses the earlier 19-number observation (3
  nearest points, danger in 8 sectors, log of points, boost flag) and a
  19 → 64 → 64 network, with its parameters fixed in the code and no logs in
  the panel.
- Reward: change in points per decision; a kill (another snake hit your
  tail) pays 30 plus half the victim's points; dying costs 50 plus every point
  the snake had, so death stays the worst outcome and gets worse as the snake
  grows. The learner sees rewards × 0.01; the panel's `reward` is unscaled. One
  decision every 3-6 ticks, drawn for each life, so the model learns to cope
  with lag. Each episode logs `kills` and `dropped_steps` to the panel.
- Every 4096 steps the learner runs PPO (4 epochs, minibatches of 512, clip
  0.2, GAE λ 0.95; defaults, see Parameters) and sends `loss/policy`,
  `loss/value`, `entropy`, `entropy_pct` (percent of the most an action count
  allows, comparable across runs), `approx_kl` (how far the update moved the
  policy from the one that played the batch), `clip_frac` (share of steps the
  clip cut off), `learner_busy_pct` (time spent training rather than waiting
  for steps: low means room for more epochs) and `update` to the panel with the next episode's
  `reward` and `steps`.
- Checkpoints (weights + optimizer state) go to `<py|js>/checkpoints/<run>/`
  every 10 updates and on Ctrl+C.

Python runs a process for every five sessions of a server, since threads in one
process take turns on its GIL; sessions play with weights in shared memory
(`torch.multiprocessing`), which the learner refreshes after every update. A
session whose server goes away (a room restarting) reconnects every 5 seconds
and plays on, so the trainer outlives a restart of the rooms.
The learner holds at most two batches of unread steps: when it falls behind,
sessions drop new segments (`dropped_steps`) instead of queueing them, so it
never trains on stale play. Many dropped steps mean too many sessions for this
machine.
JavaScript runs every session in one Node process and the learner blocks the
event loop for the update; it stays simple but slows down past a few dozen
sessions. Install `@tensorflow/tfjs-node` for native speed.

## What the lab records

The server tracks every episode of every lab agent (peak score, survival,
points eaten, points spent on boost, cause: `bot`, `human`, `agent` or
`disconnect`) and writes one averaged row per run every `LAB_FLUSH_MINUTES`,
plus one when the run's last agent disconnects. Your algorithm adds its own
numbers with `game.log(**metrics)`: up to 32 finite numbers per call, names
matching `[A-Za-z0-9_./-]{1,40}`, averaged over the same window and drawn as
separate charts in the panel. Invalid calls come back as a warning.

## Tests

```sh
cd py && pytest -p no:cacheprovider
pnpm --filter @pixel-snake/lab-js test
```
