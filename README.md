<p align="center">
  <img src="apps/frontend/public/icon-512.png" alt="Pixel Snake icon" width="120" />
</p>

<h1 align="center">Pixel Snake</h1>

## Project info
This project was made during free time in school, just for fun. </br>
Do with it whatever you want.

A pixel-art take on slither.io: steer a growing snake around a wrap-around
map, eat food to grow, boost at the cost of points, and avoid other
snakes' tails. Built as a small monorepo — an Express + Socket.IO backend
driving the game simulation, and a plain-JS canvas frontend.

### Prerequisites
- Node.js
- pnpm

## Setup
```
pnpm install
```

## Run
Build once before starting (the game CSS and the RL lab panel):
```
pnpm build
```

Development rebuilds both the game CSS and the Vue lab panel and runs the game
under nodemon:
```
pnpm dev
```

App should be running at http://localhost:3030 by default.

The port and host are configurable via `apps/backend/.env` (see
`apps/backend/.env.example`) — copy it to `.env` and adjust `PORT`/`HOST`
if you need a different port.

## Admin panel

Set `ADMIN_PASSWORD` in `apps/backend/.env`, restart the backend, open the game
with `#admin` at the end of the URL (http://localhost:3030/#admin) and log in.
The panel in the top-right corner changes world settings live (game speed,
bots, food, vision radius, speeds), spawns snakes and sets the points of,
teleports or kills any player. Without `ADMIN_PASSWORD` the admin API answers
503 and the panel stays hidden; once logged in, it shows without `#admin` until
the session ends (12 hours or a backend restart).

## Project structure
- `apps/backend` — game server (Express, Socket.IO, game loop)
- `apps/frontend` — canvas-based client (plain JS, Tailwind for UI chrome)
- `apps/shared` — shared code between the two
- `apps/lab-server` — RL lab: panel, API, Postgres, and the training worlds it runs
- `apps/lab` — Python (`py/`) and JavaScript (`js/`) SDKs and PPO trainers

See [CHANGELOG.md](./CHANGELOG.md) for recent changes.

## RL lab

The lab is its own app (`apps/lab-server`), separate from the public game. It
runs training worlds: Node child processes, each one a GameServer from the game
package with its own map and bots, listening on 127.0.0.1 on a port the OS
picks. Worlds take only trainer agents holding a token from the lab, serve no
game client and never touch the database; they report episodes, trainer
metrics and live state to the lab over IPC. The lab aggregates progress
windows (episode count, average/best score, survival, causes of death, the
metrics trainers send with `game.log(...)`) and writes them to Postgres.
Nothing is stored per step. See [apps/lab/README.md](./apps/lab/README.md) for
writing a trainer.

With Docker running:

```
pnpm db:up
cp apps/lab-server/.env.example apps/lab-server/.env   # set LAB_ADMIN_PASSWORD
pnpm db:migrate
pnpm build
pnpm lab
```

The panel is at http://127.0.0.1:3100 (`LAB_PORT`; the lab listens on
127.0.0.1 only). Log in with `LAB_ADMIN_PASSWORD`, create a key for each
machine you train from, then a group under Grupy. `LAB_FLUSH_MINUTES` sets the
progress window, `LAB_PYTHON` the Python that starts trainers from the panel
(default `apps/lab/.venv/bin/python`).

`pnpm dev` rebuilds the panel but does not run the lab, since a restart on every
edit would restart its worlds: run `pnpm lab` in its own terminal and restart it
after server changes.

### Groups

A group is a set of worlds with the same settings (game speed, bots, food,
vision radius, speeds) and a list of processes, each with the number of trainer
sessions it takes. Saved settings reach a running group's worlds at once;
processes change while the group is stopped. A trainer started with
`--groups quiet,crowded` asks the lab for every world of those groups, opens
the sessions each world asks for, and asks again on every reconnect, because a
world that dies is restarted by the lab on a new port with a new token. Groups
that were running start again when the lab starts. Stopping a group needs its
trainers stopped first.

The game and its bots count time in ticks, so a higher game speed is the same
game played faster: agents collect experience sooner and play the same at
normal speed. It helps while the machine has CPU to spare; past that, worlds
and trainer sessions fall behind.

Keys are stored as SHA-256 hashes and can be revoked from the panel, which
disconnects the trainers using them from every world.

`pnpm test` runs the game and lab-server specs; `cd apps/lab/py && pytest` and
`pnpm --filter @pixel-snake/lab-js test` run the trainer specs.
