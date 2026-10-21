import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { worldToken } from './keys.js';
import { attachAgents } from './world.js';

const SECRET = 'world-secret';
const RUN_ID = 'run-1';
const EPISODE = { score: 5, maxScore: 8, ticks: 300, eaten: 9, boostSpent: 1, cause: 'bot' };

let middleware;
let onConnection;
let sockets;
let sent;
let game;
let agents;

const fakeSocket = (id, auth) => {
  const handlers = {};
  return {
    id,
    data: {},
    handshake: { auth },
    emitted: [],
    disconnected: false,
    on(event, handler) { (handlers[event] ??= []).push(handler); },
    emit(event, data) { this.emitted.push({ event, data }); },
    fire(event, data) { handlers[event]?.forEach((handler) => handler(data)); },
    disconnect() { this.disconnected = true; },
  };
};
const authorize = (socket) => new Promise((resolve) => middleware(socket, resolve));
const connectAgent = async (id, runId = RUN_ID) => {
  const socket = fakeSocket(id, { token: worldToken(SECRET, runId), run: 'ppo-run-1' });
  assert.equal(await authorize(socket), undefined);
  sockets.set(id, socket);
  onConnection(socket);
  return socket;
};
const states = () => sent.filter((message) => message.type === 'state');

describe('lab/world', () => {
  beforeEach(() => {
    sent = [];
    sockets = new Map();
    const io = { of: () => ({ use: (fn) => { middleware = fn; }, on: (event, fn) => { onConnection = fn; }, sockets }) };
    game = Object.assign(new EventEmitter(), {
      tick: 100,
      stats: { tps: 60, stepMs: 1.5 },
      players: new Map(),
      agents: new Map(),
      connect(socket, agent) {
        this.agents.set(socket.id, agent);
        this.players.set(socket.id, { points: 3, bornTick: 40 });
        socket.on('disconnect', () => {
          this.agents.delete(socket.id);
          this.players.delete(socket.id);
        });
      },
    });
    agents = attachAgents({ io, game, secret: SECRET, send: (message) => sent.push(message) });
  });

  test('attachAgents', async () => {
    assert.match((await authorize(fakeSocket('a', {}))).message, /^Invalid world token/);
    const forged = await authorize(fakeSocket('a', { token: worldToken('other-secret', RUN_ID), run: 'ppo-run-1' }));
    assert.match(forged.message, /^Invalid world token/);
    const badRun = await authorize(fakeSocket('a', { token: worldToken(SECRET, RUN_ID), run: '..' }));
    assert.match(badRun.message, /^Run name must match/);

    const socket = await connectAgent('agent-1');
    assert.deepEqual(socket.data.agent, { runId: RUN_ID, name: 'ppo-run-1' });
    assert.equal(game.agents.get('agent-1'), socket.data.agent);
    assert.deepEqual(states().at(-1), {
      type: 'state', tps: 60, stepMs: 1.5, agents: [{ id: 'agent-1', runId: RUN_ID, alive: true, score: 3, ticks: 60 }],
    });

    socket.fire('disconnect');
    assert.deepEqual(states().at(-1).agents, []);
  });

  test('attachAgents (log)', async () => {
    const socket = await connectAgent('agent-1');
    socket.fire('log', { loss: 0.4, 'policy/entropy': 1.2 });
    socket.fire('log', { loss: Infinity });
    socket.fire('log', 'loss');

    assert.deepEqual(sent.filter((message) => message.type === 'log'), [
      { type: 'log', runId: RUN_ID, values: { loss: 0.4, 'policy/entropy': 1.2 } },
    ]);
    assert.equal(socket.emitted.filter((message) => message.event === 'lab-error').length, 2);
  });

  test('attachAgents (episode)', async () => {
    const socket = await connectAgent('agent-1');
    game.emit('episode-end', { ...EPISODE, agent: socket.data.agent });

    assert.deepEqual(sent.at(-1), { type: 'episode', runId: RUN_ID, episode: EPISODE });
  });

  test('revoke', async () => {
    const revokedSocket = await connectAgent('agent-1');
    const other = await connectAgent('agent-2', 'run-2');
    agents.revoke([RUN_ID]);

    assert.equal(revokedSocket.disconnected, true);
    assert.equal(other.disconnected, false);
    const again = await authorize(fakeSocket('agent-3', { token: worldToken(SECRET, RUN_ID), run: 'ppo-run-1' }));
    assert.equal(again.message, 'Invalid or revoked lab key');
  });
});
