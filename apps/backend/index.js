import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import 'dotenv/config';
import { adminRouter } from './admin/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

import GameServer from './class/GameServer.js';
import { GAME_CONFIG } from './class/Config.js';

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';

const app = express();

app.use(cors());
app.use(express.static('../frontend/src'));
app.use(express.static('../frontend/public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const gameConfig = {
  ...GAME_CONFIG,
  BOTS: Number(process.env.BOTS) || GAME_CONFIG.BOTS,
};

const game = new GameServer(io, gameConfig);
game.start();

app.use('/api/admin', adminRouter({ game, password: process.env.ADMIN_PASSWORD }));

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
