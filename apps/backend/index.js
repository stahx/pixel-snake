import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import 'dotenv/config';
import { adminRouter } from './admin/router.js';
import { serveClient } from './helpers/client.js';

import GameServer from './class/GameServer.js';
import { GAME_CONFIG } from './class/Config.js';

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';

const app = express();

app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const gameConfig = {
  ...GAME_CONFIG,
  BOTS: Number(process.env.BOTS) || GAME_CONFIG.BOTS,
};

const game = new GameServer(io, gameConfig);
game.start();

serveClient(app, game);
app.use('/api/admin', adminRouter({ game, password: process.env.ADMIN_PASSWORD }));

app.get('/health', (req, res) => {
  return res.status(200).send('OK');
});

server.listen(port, host, (err) => {
  if (err) return console.log(err);
  console.log(`server listening at http://${host}:${port}`);
});
