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
