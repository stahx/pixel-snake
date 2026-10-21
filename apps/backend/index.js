import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import 'dotenv/config';
import { pool } from './db/pool.js';
import { attachLab } from './lab/agents.js';
import { labRouter } from './lab/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

import GameServer from './class/GameServer.js';

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';

const app = express();

app.use(cors());
app.use('/lab', express.static(join(__dirname, '../frontend/dist/lab')));
app.use(express.static('../frontend/src'));
app.use(express.static('../frontend/public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const gameConfig = {
  MAP_WIDTH: 4000,
  MAP_HEIGHT: 4000,
  POINTS_AMOUNT: 400,
  NORMAL_SPEED: 1.3,
  BOOST_SPEED: 2.8,
  TICK_RATE: 60,
  TIMESCALE: Number(process.env.TIMESCALE) || 1,
  // Vision radius scales with snake size (see Player.js spawn size / calculatePlayerNewSize
  // growth cap): small at spawn, growing toward FOG_RADIUS_MAX as the snake grows.
  FOG_RADIUS_MIN: 300,
  FOG_RADIUS_MAX: 2500,
  BOTS: Number(process.env.BOTS) || 10,
};

const game = new GameServer(io, gameConfig);
game.start();

const flushMinutes = Number(process.env.LAB_FLUSH_MINUTES) || 5;
const lab = attachLab({ io, game, pool, flushMinutes, room: port });
app.use('/api/lab', labRouter({ pool, lab, password: process.env.LAB_ADMIN_PASSWORD, flushMinutes }));

app.get('/version', (req, res) => {
  return res.json({ version: rootPkg.version });
});

app.get('/health', (req, res) => {
  return res.status(200).send('OK');
});

app.get('/state', (req, res) => {
  if (game.running) return res.status(200).send(true);
  return res.status(400).send(false);
});

app.get('/game-data', (req, res) => {
  if (game.running) {
    return res.json({
      entities: game.entities,
      width: game.config.MAP_WIDTH,
      height: game.config.MAP_HEIGHT,
    });
  }
  return res.status(400).send(false);
});

server.listen(port, host, (err) => {
  if (err) return console.log(err);
  console.log(`server listening at http://${host}:${port}`);
});
