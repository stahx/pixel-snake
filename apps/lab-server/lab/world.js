import express from 'express';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { serveClient } from '@pixel-snake/backend/client';
import GameServer from '@pixel-snake/backend/GameServer';
import { GAME_CONFIG, configError } from '@pixel-snake/backend/Config';

import { RUN_NAME, numbersError } from './agents.js';
import { HUMAN, verifyToken } from './keys.js';

const STATE_MS = 1000;

export function admitHumans(io, secret) {
  io.use((socket, next) => {
    if (verifyToken(secret, socket.handshake.auth.token) !== HUMAN) return next(new Error('Open this world from the lab panel'));
    socket.data.follow = socket.handshake.auth.follow;
    next();
  });
}

export function attachAgents({ io, game, secret, send }) {
  const namespace = io.of('/lab');
  const revoked = new Set();
  const sendState = () => send({
    type: 'state',
    ...game.stats,
    agents: [...game.agents].map(([id, { runId }]) => {
      const player = game.players.get(id);
      return player
        ? { id, runId, alive: true, score: player.points, ticks: game.tick - player.bornTick }
        : { id, runId, alive: false, score: 0, ticks: 0 };
    }),
  });

  namespace.use((socket, next) => {
    const { token, run } = socket.handshake.auth;
    const runId = verifyToken(secret, token);
    if (!runId || runId === HUMAN) return next(new Error('Invalid world token: ask the lab for a new one'));
    if (revoked.has(runId)) return next(new Error('Invalid or revoked lab key'));
    if (typeof run !== 'string' || !RUN_NAME.test(run)) return next(new Error(`Run name must match ${RUN_NAME}`));
    socket.data.agent = { runId, name: run };
    next();
  });

  namespace.on('connection', (socket) => {
    const { agent } = socket.data;
    game.connect(socket, agent);
    sendState();
    socket.on('log', (values) => {
      const error = numbersError(values);
      if (error) return socket.emit('lab-error', error);
      send({ type: 'log', runId: agent.runId, values });
    });
    socket.on('disconnect', sendState);
  });

  game.on('episode-end', ({ agent, ...episode }) => agent && send({ type: 'episode', runId: agent.runId, episode }));
  setInterval(sendState, STATE_MS).unref();

  return {
    revoke(runIds) {
      runIds.forEach((runId) => revoked.add(runId));
      for (const socket of namespace.sockets.values()) {
        if (revoked.has(socket.data.agent.runId)) socket.disconnect(true);
      }
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('disconnect', () => process.exit());
  process.once('message', ({ type, config, secret }) => {
    const invalid = type === 'start' && typeof secret === 'string' && secret ? configError(config, GAME_CONFIG) : 'Expected a start message';
    if (invalid) {
      console.error(`World: ${invalid}`);
      process.exit(1);
    }
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { serveClient: false });
    admitHumans(io, secret);
    const game = new GameServer(io, { ...GAME_CONFIG, ...config });
    serveClient(app, game);
    const agents = attachAgents({ io, game, secret, send: (message) => process.send(message) });

    process.on('message', (message) => {
      if (message.type === 'config') {
        const error = configError(message.values, game.config);
        if (error) return console.error(`World: ${error}`);
        game.setConfig(message.values);
      } else if (message.type === 'revoke' && Array.isArray(message.runIds)) {
        agents.revoke(message.runIds.filter((runId) => typeof runId === 'string'));
      }
    });
    game.start();
    server.listen(0, '127.0.0.1', () => process.send({ type: 'listening', port: server.address().port }));
  });
}
