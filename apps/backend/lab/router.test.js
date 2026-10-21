import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

import { hashKey } from './keys.js';
import { labRouter } from './router.js';

const PASSWORD = 'correct horse';
const KEY_ID = '7f8e1d2c-3b4a-4c5d-8e9f-0a1b2c3d4e5f';

let server;
let base;
let queries;
let results;
let disconnected;
let trainerCalls;
let runningPid;
let liveRuns;
let roomsCalls;
let roomsRunning;
let takenPort;

const pool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return results.shift() || { rows: [], rowCount: 0 };
  },
};
const lab = { live: () => ({ tickRate: 60, runs: liveRuns }), disconnectKey: (id) => disconnected.push(id) };
const trainer = {
  available: true,
  start: async (options) => { trainerCalls.push(['start', options]); return 4242; },
  running: async (pid) => pid === runningPid,
  stop: (pid) => trainerCalls.push(['stop', pid]),
  models: () => [{ run: 'slither-v7', files: ['latest.pt', 'update-7300.pt'] }],
};
const roomServers = {
  firstPort: 3031,
  list: async () => roomsRunning,
  taken: async () => takenPort,
  start: async (options) => { roomsCalls.push(['start', options]); return 777; },
  stop: (group) => roomsCalls.push(['stop', group]),
};

const request = (path, { method = 'GET', body, cookie, key } = {}) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...(key && { Authorization: `Bearer ${key}` }) },
  body: body && JSON.stringify(body),
});
const login = async () => {
  const response = await request('/login', { method: 'POST', body: { password: PASSWORD } });
  return response.headers.get('set-cookie').split(';')[0];
};

describe('lab/router', () => {
  before(async () => {
    const app = express();
    app.use('/api/lab', labRouter({ pool, lab, password: PASSWORD, flushMinutes: 5, trainer, roomServers }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/lab`;
  });
  after(() => server.close());
  beforeEach(() => {
    queries = [];
    results = [];
    disconnected = [];
    trainerCalls = [];
    runningPid = null;
    liveRuns = [];
    roomsCalls = [];
    roomsRunning = [];
    takenPort = null;
  });

  test('POST /login', async () => {
    const wrong = await request('/login', { method: 'POST', body: { password: 'nope' } });
    assert.equal(wrong.status, 401);

    const ok = await request('/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(ok.status, 204);
    assert.match(ok.headers.get('set-cookie'), /^lab_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/api\/lab/);
  });

  test('GET /session', async () => {
    assert.equal((await request('/session')).status, 401);
    assert.equal((await request('/session', { cookie: 'lab_session=forged' })).status, 401);
    assert.equal((await request('/session', { cookie: await login() })).status, 204);
  });

  test('POST /logout', async () => {
    const cookie = await login();
    await request('/logout', { method: 'POST', cookie });
    assert.equal((await request('/session', { cookie })).status, 401);
  });

  test('POST /keys', async () => {
    const cookie = await login();
    assert.equal((await request('/keys', { method: 'POST', body: { name: ' ' }, cookie })).status, 400);

    results.push({ rows: [{ id: KEY_ID, name: 'macbook' }] });
    const response = await request('/keys', { method: 'POST', body: { name: ' macbook ' }, cookie });
    const created = await response.json();

    assert.equal(response.status, 201);
    assert.match(created.key, /^psl_[\w-]{32}$/);
    const [, name, hash] = queries[0].params;
    assert.equal(name, 'macbook');
    assert.equal(hash, hashKey(created.key));
  });

  test('DELETE /keys/:id', async () => {
    const cookie = await login();
    assert.equal((await request(`/keys/${KEY_ID}`, { method: 'DELETE', cookie })).status, 404);
    assert.deepEqual(disconnected, []);

    results.push({ rows: [], rowCount: 1 });
    assert.equal((await request(`/keys/${KEY_ID}`, { method: 'DELETE', cookie })).status, 204);
    assert.deepEqual(disconnected, [KEY_ID]);
  });

  test('GET /runs/:id/progress', async () => {
    const cookie = await login();
    const row = { score_avg: 10, score_max: 20, ticks_avg: 600, eaten_avg: 5, boost_avg: 1, deaths: { bot: 1 }, metrics: {} };
    results.push({ rows: [
      { ...row, recorded_at: '2026-10-18T15:28:14.100Z', episodes: 1 },
      { ...row, recorded_at: '2026-10-18T15:28:14.900Z', episodes: 1, score_avg: 30 },
    ] });
    const response = await request(`/runs/${KEY_ID}/progress`, { cookie });

    assert.equal(response.status, 200);
    const points = await response.json();
    assert.equal(points.length, 1);
    assert.equal(points[0].score_avg, 20);
    assert.deepEqual(queries.at(-1).params, [KEY_ID]);
  });

  test('POST /agent/config', async () => {
    const body = { run: 'ppo-1', config: { gamma: 0.99, epochs: 4 }, overrides: { epochs: 8 } };
    assert.equal((await request('/agent/config', { method: 'POST', body })).status, 401);
    assert.equal((await request('/agent/config', { method: 'POST', body: { ...body, config: { gamma: 'high' } }, key: 'psl_x' })).status, 400);
    assert.equal((await request('/agent/config', { method: 'POST', body: { ...body, overrides: { lr: 1 } }, key: 'psl_x' })).status, 400);

    queries = [];
    results.push({ rows: [{ id: KEY_ID }], rowCount: 1 }, { rows: [{ config: { gamma: 0.95, epochs: 8 } }] });
    const response = await request('/agent/config', { method: 'POST', body, key: 'psl_x' });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { config: { gamma: 0.95, epochs: 8 } });
    assert.equal(queries[0].params[0], hashKey('psl_x'));
    assert.deepEqual(queries[1].params.slice(1), [KEY_ID, 'ppo-1', '{"gamma":0.99,"epochs":4}', '{"epochs":8}']);
  });

  test('POST /agent/logs', async () => {
    const post = (body, key = 'psl_x') => request('/agent/logs', { method: 'POST', body, key });
    assert.equal((await post({ run: 'ppo-1', lines: [] })).status, 400);
    assert.equal((await post({ run: 'ppo-1', lines: ['x'.repeat(1001)] })).status, 400);
    assert.equal((await post({ run: 'ppo-1', lines: ['update 1'] }, null)).status, 401);

    queries = [];
    results.push({ rows: [{ id: KEY_ID }], rowCount: 1 }, { rows: [{ run_id: 'run-1' }, { run_id: 'run-1' }], rowCount: 2 });
    assert.equal((await post({ run: 'ppo-1', lines: ['update 1', 'update 2'] })).status, 204);
    assert.deepEqual(queries[1].params.slice(1), [KEY_ID, 'ppo-1', ['update 1', 'update 2']]);
    assert.deepEqual(queries[2].params, ['run-1', 2000]);
  });

  test('GET /runs/:id/logs', async () => {
    const cookie = await login();
    results.push({ rows: [{ id: '8', at: '2026-10-19T16:00:00.000Z', line: 'update 1' }] });
    const response = await request(`/runs/${KEY_ID}/logs?after=7`, { cookie });

    assert.deepEqual(await response.json(), [{ id: '8', at: '2026-10-19T16:00:00.000Z', line: 'update 1' }]);
    assert.deepEqual(queries.at(-1).params, [KEY_ID, '7', 2000]);

    await request(`/runs/${KEY_ID}/logs?after=1;drop`, { cookie });
    assert.deepEqual(queries.at(-1).params, [KEY_ID, null, 2000]);
  });

  test('PUT /runs/:id/config', async () => {
    const cookie = await login();
    const put = (values) => request(`/runs/${KEY_ID}/config`, { method: 'PUT', body: { values }, cookie });
    assert.equal((await put({ gamma: 'high' })).status, 400);

    results.push({ rows: [{ config: null, config_pending: null }], rowCount: 1 });
    assert.equal((await put({ gamma: 0.9 })).status, 409);

    results.push({ rows: [{ config: null, config_pending: { gamma: 0.99, epochs: 4 } }], rowCount: 1 });
    assert.deepEqual(await (await put({ gamma: 0.9 })).json(), { config_pending: { gamma: 0.9, epochs: 4 } });

    results.push({ rows: [{ config: { gamma: 0.99, epochs: 4 } }], rowCount: 1 });
    assert.equal((await put({ lr: 1 })).status, 400);

    results.push({ rows: [{ config: { gamma: 0.99, epochs: 4 } }], rowCount: 1 });
    const response = await put({ gamma: 0.95, epochs: 4 });
    assert.deepEqual(await response.json(), { config_pending: { gamma: 0.95 } });
    assert.deepEqual(queries.at(-1).params, [KEY_ID, '{"gamma":0.95}']);

    results.push({ rows: [{ config: { gamma: 0.99, epochs: 4 } }], rowCount: 1 });
    assert.deepEqual(await (await put({})).json(), { config_pending: null });
    assert.deepEqual(queries.at(-1).params, [KEY_ID, null]);
  });

  test('POST /runs', async () => {
    const cookie = await login();
    const post = (body) => request('/runs', { method: 'POST', body, cookie });
    assert.equal((await post({ name: 'bad/name', key_id: KEY_ID })).status, 400);
    assert.equal((await post({ name: 'v6', key_id: KEY_ID, values: { gamma: 'high' } })).status, 400);
    assert.equal((await post({ name: 'v6', key_id: KEY_ID })).status, 404);

    results.push({ rowCount: 1 }, { rows: [], rowCount: 0 });
    assert.equal((await post({ name: 'v6', key_id: KEY_ID })).status, 409);

    results.push({ rowCount: 1 }, { rows: [{ id: 'run-id' }], rowCount: 1 });
    const created = await post({ name: 'v6', key_id: KEY_ID, values: { gamma: 0.95 } });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: 'run-id' });
    assert.deepEqual(queries.at(-1).params.slice(1), [KEY_ID, 'v6', '{"gamma":0.95}']);
  });

  test('POST /runs/:id/start', async () => {
    const cookie = await login();
    const start = (body) => request(`/runs/${KEY_ID}/start`, { method: 'POST', body, cookie });
    const rooms = [{ ports: '3031-3040', sessions: 1 }, { ports: '3041-3050', sessions: 10 }];
    assert.equal((await start({ rooms: [{ ports: '3031; rm -rf /', sessions: 5 }] })).status, 400);
    assert.equal((await start({ rooms: [rooms[0], { ports: '3041-3050', sessions: 2.5 }] })).status, 400);
    assert.equal((await start({ rooms: [] })).status, 400);
    assert.equal((await start({ rooms, model: { run: '../..', file: 'latest.pt' } })).status, 400);
    assert.equal((await start({ rooms, model: { run: 'slither-v7', file: 'update-1.pt' } })).status, 400);

    runningPid = 7;
    results.push({ rows: [{ name: 'v6', trainer: { pid: 7 } }], rowCount: 1 });
    assert.equal((await start({ rooms })).status, 409);

    results.push({ rows: [{ name: 'v6', trainer: { pid: 7, ports: '3030', sessions: 1 } }], rowCount: 1 });
    runningPid = null;
    const started = await start({ rooms: [{ ...rooms[0], extra: 1 }, rooms[1]] });
    assert.deepEqual(await started.json(), { trainer: { pid: 4242, rooms, running: true } });
    assert.deepEqual(trainerCalls, [['start', { name: 'v6', rooms }]]);
    assert.deepEqual(queries.at(-1).params, [KEY_ID, JSON.stringify({ pid: 4242, rooms })]);

    results.push({ rows: [{ name: 'new-v1', trainer: null }], rowCount: 1 });
    await start({ rooms, model: { run: 'slither-v7', file: 'update-7300.pt', extra: 1 } });
    assert.deepEqual(trainerCalls.at(-1), ['start', { name: 'new-v1', rooms, model: { run: 'slither-v7', file: 'update-7300.pt' } }]);
  });

  test('GET /rooms', async () => {
    roomsRunning = [{ pid: 5, group: 4, count: 20, timescale: 1.5 }];
    const response = await request('/rooms', { cookie: await login() });
    assert.deepEqual(await response.json(), { firstPort: 3031, running: roomsRunning });
  });

  test('POST /rooms/start', async () => {
    const cookie = await login();
    const start = (body) => request('/rooms/start', { method: 'POST', body, cookie });
    assert.equal((await start({ count: 0, timescale: 1 })).status, 400);
    assert.equal((await start({ count: 20, timescale: 10 })).status, 400);
    assert.equal((await start({ count: 20, timescale: '2' })).status, 400);

    roomsRunning = [{ pid: 5, group: 4, count: 20, timescale: 1 }];
    assert.equal((await start({ count: 20, timescale: 1.5 })).status, 409);
    roomsRunning = [];
    takenPort = 3035;
    assert.equal((await start({ count: 20, timescale: 1.5 })).status, 409);
    takenPort = null;

    const started = await start({ count: 20, timescale: 1.5 });
    assert.equal(started.status, 201);
    assert.deepEqual(await started.json(), { pid: 777, count: 20, timescale: 1.5 });
    assert.deepEqual(roomsCalls, [['start', { count: 20, timescale: 1.5 }]]);
  });

  test('POST /rooms/stop', async () => {
    const cookie = await login();
    const stop = () => request('/rooms/stop', { method: 'POST', cookie });
    assert.equal((await stop()).status, 409);

    roomsRunning = [{ pid: 5, group: 4, count: 20, timescale: 1.5 }];
    liveRuns = [{ runId: 'run-1' }];
    assert.equal((await stop()).status, 409);
    liveRuns = [];
    assert.equal((await stop()).status, 204);
    assert.deepEqual(roomsCalls, [['stop', 4]]);
  });

  test('GET /models', async () => {
    const response = await request('/models', { cookie: await login() });
    assert.deepEqual(await response.json(), [{ run: 'slither-v7', files: ['latest.pt', 'update-7300.pt'] }]);
  });

  test('POST /runs/:id/stop', async () => {
    const cookie = await login();
    const stop = () => request(`/runs/${KEY_ID}/stop`, { method: 'POST', cookie });
    results.push({ rows: [{ name: 'v6', trainer: null }], rowCount: 1 });
    assert.equal((await stop()).status, 409);

    runningPid = 7;
    results.push({ rows: [{ name: 'v6', trainer: { pid: 7 } }], rowCount: 1 });
    assert.equal((await stop()).status, 204);
    assert.deepEqual(trainerCalls, [['stop', 7]]);
  });

  test('lockout', async () => {
    for (let i = 0; i < 5; i++) {
      await request('/login', { method: 'POST', body: { password: 'nope' } });
    }
    const locked = await request('/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(locked.status, 429);
  });
});
