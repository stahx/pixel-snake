import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { attachLab } from './agents.js';
import { hashKey } from './keys.js';

const KEY = 'psl_test-key';
const KEY_ID = 'key-1';
const RUN_ID = 'run-1';
const EPISODE = { score: 5, maxScore: 8, ticks: 300, eaten: 9, boostSpent: 1, cause: 'bot' };

let middleware;
let onConnection;
let queries;
let game;
let lab;

const pool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('UPDATE lab_keys')) return params[0] === hashKey(KEY) ? { rows: [{ id: KEY_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO lab_runs')) return { rows: [{ id: RUN_ID }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
};

const fakeSocket = (id, auth) => {
  const handlers = {};
  return {
    id,
    data: {},
    handshake: { auth },
    handlers,
    emitted: [],
    on(event, handler) { handlers[event] = handler; },
    emit(event, data) { this.emitted.push({ event, data }); },
    disconnect() { handlers.disconnect(); },
  };
};
const authorize = (socket) => new Promise((resolve) => middleware(socket, resolve));
const connectAgent = async (id) => {
  const socket = fakeSocket(id, { key: KEY, run: 'ppo-run-1' });
  assert.equal(await authorize(socket), undefined);
  onConnection(socket);
  return socket;
};

describe('lab/agents', () => {
  beforeEach(() => {
    queries = [];
    const io = { of: () => ({ use: (fn) => { middleware = fn; }, on: (event, fn) => { onConnection = fn; } }) };
    game = Object.assign(new EventEmitter(), {
      tick: 100,
      config: { TICK_RATE: 60 },
      players: new Map(),
      connect(socket, agent) { this.players.set(socket.id, { points: 3, bornTick: 40, agent }); },
    });
    lab = attachLab({ io, game, pool, flushMinutes: 5 });
  });

  test('attachLab', async () => {
    const missing = await authorize(fakeSocket('a', {}));
    assert.equal(missing.message, 'Missing lab key');
    const wrong = await authorize(fakeSocket('a', { key: 'psl_wrong' }));
    assert.equal(wrong.message, 'Invalid or revoked lab key');
    const badRun = await authorize(fakeSocket('a', { key: KEY, run: 'x'.repeat(41) }));
    assert.match(badRun.message, /^Run name must match/);

    const socket = await connectAgent('agent-1');
    assert.deepEqual(socket.data.agent, { runId: RUN_ID, keyId: KEY_ID, name: 'ppo-run-1' });
    assert.equal(game.players.get('agent-1').agent, socket.data.agent);
  });

  test('live', async () => {
    const socket = await connectAgent('agent-1');
    game.emit('episode-end', { ...EPISODE, agent: socket.data.agent });

    const { tickRate, flushMinutes, runs: [run] } = lab.live();
    assert.equal(tickRate, 60);
    assert.equal(flushMinutes, 5);
    assert.equal(run.name, 'ppo-run-1');
    assert.deepEqual(run.agents, [{ alive: true, score: 3, ticks: 60 }]);
    assert.equal(run.pending.episodes, 1);
  });

  test('log', async () => {
    const socket = await connectAgent('agent-1');
    socket.handlers.log({ loss: 0.4, 'policy/entropy': 1.2 });
    socket.handlers.log({ loss: Infinity });
    socket.handlers.log('loss');

    assert.deepEqual(lab.live().runs[0].pending.metrics, { loss: 0.4, 'policy/entropy': 1.2 });
    assert.equal(socket.emitted.filter((m) => m.event === 'lab-error').length, 2);
  });

  test('disconnect', async () => {
    const first = await connectAgent('agent-1');
    const second = await connectAgent('agent-2');
    game.emit('episode-end', { ...EPISODE, agent: first.data.agent });
    game.emit('episode-end', { ...EPISODE, maxScore: 20, cause: 'human', agent: second.data.agent });

    first.handlers.disconnect();
    assert.equal(queries.some((q) => q.sql.includes('INSERT INTO lab_progress')), false);

    second.handlers.disconnect();
    await new Promise(setImmediate);
    const insert = queries.find((q) => q.sql.includes('INSERT INTO lab_progress'));
    assert.deepEqual(insert.params, [RUN_ID, 2, 14, 20, 300, 9, 1, '{"bot":1,"human":1}', '{}']);
    assert.deepEqual(lab.live().runs, []);
  });

  test('disconnectKey', async () => {
    const socket = await connectAgent('agent-1');
    let closed = false;
    socket.disconnect = () => { closed = true; };

    lab.disconnectKey('other-key');
    assert.equal(closed, false);
    lab.disconnectKey(KEY_ID);
    assert.equal(closed, true);
  });
});
