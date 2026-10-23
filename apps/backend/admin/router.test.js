import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

import { adminRouter } from './router.js';

const PASSWORD = 'correct horse';
const STATE = { tps: 59.8, stepMs: 1.2, food: 400, tails: 12, players: [{ id: 'bot:1', name: 'Snek', type: 'bot', points: 3, size: 11 }] };

let server;
let base;
let calls;

const game = {
  config: { MAP_WIDTH: 4000, MAP_HEIGHT: 3000, FOG_RADIUS_MIN: 300, FOG_RADIUS_MAX: 2500, BOTS: 10 },
  players: new Map([['bot:1', {}]]),
  adminState: () => STATE,
  setConfig: (values) => calls.push(['setConfig', values]),
  spawnSnake: (points, near) => {
    calls.push(['spawnSnake', points, near]);
    return { playerId: 'bot:2' };
  },
  setPoints: (id, points) => calls.push(['setPoints', id, points]),
  teleport: (id, x, y) => calls.push(['teleport', id, x, y]),
  kill: (id) => calls.push(['kill', id]),
};

const request = (path, { method = 'GET', body, cookie } = {}) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
  body: body && JSON.stringify(body),
});
const login = async () => {
  const response = await request('/login', { method: 'POST', body: { password: PASSWORD } });
  return response.headers.get('set-cookie').split(';')[0];
};

describe('admin/router', () => {
  before(async () => {
    const app = express();
    app.use('/api/admin', adminRouter({ game, password: PASSWORD }));
    app.use('/api/disabled', adminRouter({ game }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/admin`;
  });
  after(() => server.close());
  beforeEach(() => {
    calls = [];
  });

  test('POST /login', async () => {
    assert.equal((await request('/login', { method: 'POST', body: { password: 'nope' } })).status, 401);

    const ok = await request('/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(ok.status, 204);
    assert.match(ok.headers.get('set-cookie'), /^admin_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/api\/admin;/);
  });

  test('GET /session', async () => {
    assert.equal((await request('/session')).status, 401);
    assert.equal((await request('/session', { cookie: 'admin_session=forged' })).status, 401);
    assert.equal((await request('/session', { cookie: await login() })).status, 204);
    assert.equal((await fetch(base.replace('/api/admin', '/api/disabled/session'))).status, 503);
  });

  test('POST /logout', async () => {
    const cookie = await login();
    await request('/logout', { method: 'POST', cookie });
    assert.equal((await request('/session', { cookie })).status, 401);
  });

  test('GET /state', async () => {
    assert.equal((await request('/state')).status, 401);

    const response = await request('/state', { cookie: await login() });
    assert.deepEqual(await response.json(), STATE);
  });

  test('PATCH /config', async () => {
    const cookie = await login();
    const patch = (body) => request('/config', { method: 'PATCH', body, cookie });
    assert.equal((await patch({})).status, 400);
    assert.equal((await patch({ MAP_WIDTH: 100 })).status, 400);
    assert.equal((await patch({ constructor: 1 })).status, 400);
    assert.equal((await patch({ TIMESCALE: 5 })).status, 400);
    assert.equal((await patch({ TIMESCALE: '2' })).status, 400);
    assert.equal((await patch({ BOTS: 2.5 })).status, 400);
    assert.equal((await patch({ FOG_RADIUS_MIN: 3000 })).status, 400);
    assert.equal((await patch({ FOG_RADIUS_MAX: 200 })).status, 400);
    assert.deepEqual(calls, []);

    const response = await patch({ TIMESCALE: 0.25, BOTS: 0, FOG_RADIUS_MIN: 3000, FOG_RADIUS_MAX: 3500 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), game.config);
    assert.deepEqual(calls, [['setConfig', { TIMESCALE: 0.25, BOTS: 0, FOG_RADIUS_MIN: 3000, FOG_RADIUS_MAX: 3500 }]]);
  });

  test('POST /spawn', async () => {
    const cookie = await login();
    const spawn = (body) => request('/spawn', { method: 'POST', body, cookie });
    assert.equal((await spawn({ points: -1 })).status, 400);
    assert.equal((await spawn({ points: 5001 })).status, 400);
    assert.equal((await spawn({ points: 100, near: 'ghost' })).status, 404);

    const random = await spawn({ points: 100 });
    assert.equal(random.status, 201);
    assert.deepEqual(await random.json(), { id: 'bot:2' });
    await spawn({ points: 0, near: 'bot:1' });
    assert.deepEqual(calls, [['spawnSnake', 100, undefined], ['spawnSnake', 0, 'bot:1']]);
  });

  test('PUT /players/:id/points', async () => {
    const cookie = await login();
    const put = (id, body) => request(`/players/${encodeURIComponent(id)}/points`, { method: 'PUT', body, cookie });
    assert.equal((await put('ghost', { points: 10 })).status, 404);
    assert.equal((await put('bot:1', { points: 1.5 })).status, 400);

    assert.equal((await put('bot:1', { points: 250 })).status, 204);
    assert.deepEqual(calls, [['setPoints', 'bot:1', 250]]);
  });

  test('POST /players/:id/teleport', async () => {
    const cookie = await login();
    const teleport = (body) => request('/players/bot%3A1/teleport', { method: 'POST', body, cookie });
    assert.equal((await teleport({ x: 4001, y: 10 })).status, 400);
    assert.equal((await teleport({ x: 10, y: 3001 })).status, 400);
    assert.equal((await teleport({ x: 10 })).status, 400);

    assert.equal((await teleport({ x: 3999.5, y: 0 })).status, 204);
    assert.deepEqual(calls, [['teleport', 'bot:1', 3999.5, 0]]);
  });

  test('POST /players/:id/kill', async () => {
    const cookie = await login();
    assert.equal((await request('/players/ghost/kill', { method: 'POST', cookie })).status, 404);

    assert.equal((await request('/players/bot%3A1/kill', { method: 'POST', cookie })).status, 204);
    assert.deepEqual(calls, [['kill', 'bot:1']]);
  });
});
