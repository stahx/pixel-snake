import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

import { hashKey } from './keys.js';
import { labRouter } from './router.js';

const PASSWORD = 'correct horse';
const KEY_ID = '7f8e1d2c-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
const GROUP_ID = '5b0c9a1e-6d7f-4a8b-9c0d-1e2f3a4b5c6d';
const DEFAULTS = { TIMESCALE: 1, BOTS: 10, POINTS_AMOUNT: 400, FOG_RADIUS_MIN: 300, FOG_RADIUS_MAX: 2500, NORMAL_SPEED: 1.3, BOOST_SPEED: 2.8 };

let server;
let base;
let queries;
let results;
let disconnected;
let trainerCalls;
let runningPid;
let liveRuns;
let worldCalls;
let runningGroups;
let worldStates;
let opponentCalls;

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
const worlds = {
  running: (id) => runningGroups.has(id),
  group: (name) => [...runningGroups.values()].find((group) => group.name === name),
  resolve: (name, runId) => worlds.group(name) && [{ url: 'http://127.0.0.1:51000', token: `${runId}.signed`, sessions: 2 }],
  state: (id) => worldStates[id] ?? [],
  start: (group) => worldCalls.push(['start', group]),
  stop: (id) => worldCalls.push(['stop', id]),
  setConfig: (id, values) => worldCalls.push(['setConfig', id, values]),
};
const opponents = {
  start: (group) => opponentCalls.push(['start', group.id]),
  stop: (id) => opponentCalls.push(['stop', id]),
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
    app.use('/api/lab', labRouter({ pool, lab, worlds, password: PASSWORD, flushMinutes: 5, trainer, opponents }));
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
    worldCalls = [];
    runningGroups = new Map();
    worldStates = {};
    opponentCalls = [];
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
    const groups = ['quiet', 'crowded'];
    assert.equal((await start({ groups: ['quiet; rm -rf /'] })).status, 400);
    assert.equal((await start({ groups: [] })).status, 400);
    assert.equal((await start({ groups })).status, 409);

    runningGroups.set('g-1', { name: 'quiet' }).set('g-2', { name: 'crowded' });
    assert.equal((await start({ groups, model: { run: '../..', file: 'latest.pt' } })).status, 400);
    assert.equal((await start({ groups, model: { run: 'slither-v7', file: 'update-1.pt' } })).status, 400);

    runningPid = 7;
    results.push({ rows: [{ name: 'v6', trainer: { pid: 7 } }], rowCount: 1 });
    assert.equal((await start({ groups })).status, 409);

    runningPid = null;
    liveRuns = [{ runId: KEY_ID }];
    results.push({ rows: [{ name: 'v6', trainer: null }], rowCount: 1 });
    assert.equal((await start({ groups })).status, 409);

    liveRuns = [];
    results.push({ rows: [{ name: 'v6', trainer: { pid: 7, groups: ['quiet'] } }], rowCount: 1 });
    const started = await start({ groups: [...groups, 'quiet'] });
    assert.deepEqual(await started.json(), { trainer: { pid: 4242, groups, running: true } });
    assert.deepEqual(trainerCalls, [['start', { name: 'v6', groups }]]);
    assert.deepEqual(queries.at(-1).params, [KEY_ID, JSON.stringify({ pid: 4242, groups })]);

    results.push({ rows: [{ name: 'new-v1', trainer: null }], rowCount: 1 });
    await start({ groups, model: { run: 'slither-v7', file: 'update-7300.pt', extra: 1 } });
    assert.deepEqual(trainerCalls.at(-1), ['start', { name: 'new-v1', groups, model: { run: 'slither-v7', file: 'update-7300.pt' } }]);
  });

  test('POST /agent/worlds', async () => {
    const post = (body, key = 'psl_x') => request('/agent/worlds', { method: 'POST', body, key });
    assert.equal((await post({ run: 'ppo-1', groups: [] })).status, 400);
    assert.equal((await post({ run: 'ppo-1', groups: ['quiet,crowded'] })).status, 400);
    assert.equal((await post({ run: 'ppo-1', groups: ['quiet'] }, null)).status, 401);

    results.push({ rows: [{ id: KEY_ID }], rowCount: 1 }, { rows: [{ id: 'run-1' }], rowCount: 1 });
    assert.equal((await post({ run: 'ppo-1', groups: ['quiet'] })).status, 409);

    runningGroups.set(GROUP_ID, { name: 'quiet' });
    queries = [];
    results.push({ rows: [{ id: KEY_ID }], rowCount: 1 }, { rows: [{ id: 'run-1' }], rowCount: 1 });
    const response = await post({ run: 'ppo-1', groups: ['quiet'] });
    assert.deepEqual(await response.json(), { quiet: [{ url: 'http://127.0.0.1:51000', token: 'run-1.signed', sessions: 2 }] });
    assert.equal(queries[0].params[0], hashKey('psl_x'));
    assert.deepEqual(queries[1].params.slice(1), [KEY_ID, 'ppo-1']);
  });

  test('GET /groups', async () => {
    runningGroups.set(GROUP_ID, { name: 'quiet' });
    worldStates[GROUP_ID] = [{ pid: 9, port: 51000, tps: 60, stepMs: 1.2, agents: 2 }];
    results.push({ rows: [
      { id: GROUP_ID, name: 'quiet', config: DEFAULTS, sessions: [2] },
      { id: 'g-2', name: 'crowded', config: DEFAULTS, sessions: [10, 10] },
    ] });
    const body = await (await request('/groups', { cookie: await login() })).json();

    assert.deepEqual(body.defaults, DEFAULTS);
    assert.deepEqual(body.limits.BOTS, [0, 100, true]);
    assert.deepEqual(body.groups.map((group) => [group.name, group.running, group.worlds]), [
      ['quiet', true, worldStates[GROUP_ID]],
      ['crowded', false, []],
    ]);
  });

  test('POST /groups', async () => {
    const cookie = await login();
    const post = (body) => request('/groups', { method: 'POST', body, cookie });
    assert.equal((await post({ name: 'a,b', sessions: [1] })).status, 400);
    assert.equal((await post({ name: 'quiet', sessions: [] })).status, 400);
    assert.equal((await post({ name: 'quiet', sessions: [33] })).status, 400);
    assert.equal((await post({ name: 'quiet', sessions: [1], config: { MAP_WIDTH: 100 } })).status, 400);
    assert.equal((await post({ name: 'quiet', sessions: [1], config: { FOG_RADIUS_MIN: 3000 } })).status, 400);

    results.push({ rows: [], rowCount: 0 });
    assert.equal((await post({ name: 'quiet', sessions: [1] })).status, 409);

    results.push({ rows: [{ id: GROUP_ID }], rowCount: 1 });
    const created = await post({ name: 'quiet', sessions: [2, 2], config: { TIMESCALE: 1.5 } });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: GROUP_ID });
    assert.deepEqual(queries.at(-1).params.slice(1), ['quiet', JSON.stringify({ ...DEFAULTS, TIMESCALE: 1.5 }), [2, 2], '[]']);

    const bots = (count) => ({ model: null, count });
    const model = (count, file = 'latest.pt') => ({ model: `slither-v7/${file}`, count });
    for (const opponents of [
      [[bots(3)]],
      [[bots(3)], [model(2, 'update-1.pt')]],
      [[bots(3)], [model(33)]],
      [[bots(0)], []],
      [[bots(60), bots(41)], []],
      [[bots(1), bots(1), bots(1), bots(1), bots(1)], []],
      [[{ count: 2 }], []],
    ]) {
      assert.equal((await post({ name: 'mixed', sessions: [5, 5], opponents })).status, 400, JSON.stringify(opponents));
    }
    results.push({ rows: [{ id: GROUP_ID }], rowCount: 1 });
    const lineup = [[bots(3), model(5)], []];
    assert.equal((await post({ name: 'mixed', sessions: [5, 5], opponents: lineup })).status, 201);
    assert.equal(queries.at(-1).params[4], JSON.stringify(lineup));
  });

  test('PATCH /groups/:id', async () => {
    const cookie = await login();
    const patch = (body) => request(`/groups/${GROUP_ID}`, { method: 'PATCH', body, cookie });
    const found = () => results.push({ rows: [{ id: GROUP_ID, name: 'quiet', config: DEFAULTS, sessions: [2], opponents: [] }], rowCount: 1 });
    assert.equal((await patch({ config: { BOTS: 1 } })).status, 404);
    found();
    assert.equal((await patch({})).status, 400);
    found();
    assert.equal((await patch({ config: { BOTS: 2.5 } })).status, 400);
    found();
    assert.equal((await patch({ config: { FOG_RADIUS_MAX: 200 } })).status, 400);
    found();
    assert.equal((await patch({ sessions: [0] })).status, 400);

    runningGroups.set(GROUP_ID, { name: 'quiet' });
    found();
    assert.equal((await patch({ sessions: [3] })).status, 409);

    found();
    results.push({ rows: [{ id: GROUP_ID, name: 'quiet', config: { ...DEFAULTS, BOTS: 4 }, sessions: [2] }], rowCount: 1 });
    const response = await patch({ config: { BOTS: 4 } });
    assert.equal((await response.json()).config.BOTS, 4);
    assert.deepEqual(queries.at(-1).params, [GROUP_ID, '{"BOTS":4}', null, null]);
    assert.deepEqual(worldCalls, [['setConfig', GROUP_ID, { BOTS: 4 }]]);

    found();
    assert.equal((await patch({ opponents: [[{ model: null, count: 3 }]] })).status, 409);

    runningGroups.clear();
    found();
    results.push({ rows: [{ id: GROUP_ID, name: 'quiet', config: DEFAULTS, sessions: [3, 1], opponents: [] }], rowCount: 1 });
    await patch({ sessions: [3, 1] });
    assert.deepEqual(queries.at(-1).params, [GROUP_ID, '{}', [3, 1], null]);
    assert.equal(worldCalls.length, 1);

    found();
    assert.equal((await patch({ sessions: [3, 1], opponents: [[{ model: null, count: 3 }]] })).status, 400);
    found();
    results.push({ rows: [{ id: GROUP_ID }], rowCount: 1 });
    const lineup = [[{ model: 'slither-v7/latest.pt', count: 4 }]];
    await patch({ opponents: lineup });
    assert.deepEqual(queries.at(-1).params, [GROUP_ID, '{}', null, JSON.stringify(lineup)]);
  });

  test('POST /groups/:id/start', async () => {
    const cookie = await login();
    const start = () => request(`/groups/${GROUP_ID}/start`, { method: 'POST', cookie });
    const group = { id: GROUP_ID, name: 'quiet', config: DEFAULTS, sessions: [2] };
    assert.equal((await start()).status, 404);

    runningGroups.set(GROUP_ID, group);
    results.push({ rows: [group], rowCount: 1 });
    assert.equal((await start()).status, 409);

    runningGroups.clear();
    results.push({ rows: [group], rowCount: 1 });
    assert.equal((await start()).status, 204);
    assert.equal(queries.at(-1).sql, 'UPDATE lab_groups SET running = true WHERE id = $1');
    assert.deepEqual(worldCalls, [['start', group]]);
    assert.deepEqual(opponentCalls, [['start', GROUP_ID]]);
  });

  test('POST /groups/:id/stop', async () => {
    const cookie = await login();
    const stop = () => request(`/groups/${GROUP_ID}/stop`, { method: 'POST', cookie });
    const group = { id: GROUP_ID, name: 'quiet', config: DEFAULTS, sessions: [2, 2], opponents: [[], [{ model: 'slither-v7/latest.pt', count: 2 }]] };
    results.push({ rows: [group], rowCount: 1 });
    assert.equal((await stop()).status, 409);

    runningGroups.set(GROUP_ID, group);
    worldStates[GROUP_ID] = [{ agents: 0, runs: [] }, { agents: 3, runs: ['run-play', 'run-play', 'run-trainer'] }];
    results.push({ rows: [group], rowCount: 1 }, { rows: [{ id: 'run-play' }] });
    assert.equal((await stop()).status, 409);
    assert.deepEqual(queries.at(-1).params, [['slither-v7-play']]);

    worldStates[GROUP_ID] = [{ agents: 0, runs: [] }, { agents: 2, runs: ['run-play', 'run-play'] }];
    results.push({ rows: [group], rowCount: 1 }, { rows: [{ id: 'run-play' }] });
    assert.equal((await stop()).status, 204);
    assert.equal(queries.at(-1).sql, 'UPDATE lab_groups SET running = false WHERE id = $1');
    assert.deepEqual(opponentCalls, [['stop', GROUP_ID]]);
    assert.deepEqual(worldCalls, [['stop', GROUP_ID]]);
  });

  test('DELETE /groups/:id', async () => {
    const cookie = await login();
    const remove = () => request(`/groups/${GROUP_ID}`, { method: 'DELETE', cookie });
    runningGroups.set(GROUP_ID, { name: 'quiet' });
    assert.equal((await remove()).status, 409);

    runningGroups.clear();
    assert.equal((await remove()).status, 404);
    results.push({ rowCount: 1 });
    assert.equal((await remove()).status, 204);
    assert.deepEqual(queries.at(-1).params, [GROUP_ID]);
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
