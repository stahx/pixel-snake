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

const pool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return results.shift() || { rows: [], rowCount: 0 };
  },
};
const lab = { live: () => ({ tickRate: 60, runs: [] }), disconnectKey: (id) => disconnected.push(id) };

const request = (path, { method = 'GET', body, cookie } = {}) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
  body: body && JSON.stringify(body),
});
const login = async () => {
  const response = await request('/login', { method: 'POST', body: { password: PASSWORD } });
  return response.headers.get('set-cookie').split(';')[0];
};

describe('lab/router', () => {
  before(async () => {
    const app = express();
    app.use('/api/lab', labRouter({ pool, lab, password: PASSWORD }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api/lab`;
  });
  after(() => server.close());
  beforeEach(() => {
    queries = [];
    results = [];
    disconnected = [];
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

  test('lockout', async () => {
    for (let i = 0; i < 5; i++) {
      await request('/login', { method: 'POST', body: { password: 'nope' } });
    }
    const locked = await request('/login', { method: 'POST', body: { password: PASSWORD } });
    assert.equal(locked.status, 429);
  });
});
