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
Build the frontend once before starting (the RL lab panel uses Vite):
```
pnpm build
```

Development rebuilds both the game CSS and the Vue lab panel:
```
pnpm dev
```

App should be running at http://localhost:3030 by default.

The port and host are configurable via `apps/backend/.env` (see
`apps/backend/.env.example`) — copy it to `.env` and adjust `PORT`/`HOST`
if you need a different port.

## Project structure
- `apps/backend` — game server (Express, Socket.IO, game loop)
- `apps/frontend` — canvas-based client (plain JS, Tailwind for UI chrome)
- `apps/shared` — shared code between the two
- `apps/lab` — Python SDK for writing RL trainers against the live game

See [CHANGELOG.md](./CHANGELOG.md) for recent changes.

## RL lab

Trainers written in Python play the live game through the `/lab` Socket.IO
namespace. Each connection needs a lab key and becomes a normal snake that
joins immediately, sees only its fog-of-war view and acts through the same
events as the browser. Nothing is stored per step: the server records
progress windows (episode count, average/best score, survival, causes of
death) and the averaged metrics the trainer sends with `game.log(...)`.
See [apps/lab/README.md](./apps/lab/README.md) for writing a trainer.

The panel at `/lab/` (admin login) manages keys and shows learning curves
and the agents playing right now.

With Docker running:

```
pnpm db:up
```

In `apps/backend/.env` (keep your existing PORT/HOST):

```
DATABASE_URL=postgres://pixel_snake:pixel_snake_local@127.0.0.1:5432/pixel_snake
LAB_ADMIN_PASSWORD=<a long random password>
LAB_FLUSH_MINUTES=5
```

Then run `pnpm db:migrate`, restart the backend, log in at `/lab/` and
create a key for each machine you train from. The game runs without these
variables; the lab namespace and panel stay disabled until both
`DATABASE_URL` and `LAB_ADMIN_PASSWORD` are set.

On a public deployment serve the game over HTTPS/WSS: the lab key travels
in the Socket.IO handshake and the panel session in a cookie. Keys are
stored as SHA-256 hashes and can be revoked from the panel, which also
disconnects trainers using them.

`pnpm test` runs the backend specs; `cd apps/lab && pytest` runs the SDK spec.
