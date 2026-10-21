import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';

import { createWorlds } from './worlds.js';

const RUN_ID = 'run-1';
const CONFIG = { TIMESCALE: 1, BOTS: 2, POINTS_AMOUNT: 50, FOG_RADIUS_MIN: 300, FOG_RADIUS_MAX: 2500, NORMAL_SPEED: 1.3, BOOST_SPEED: 2.8 };
const GROUP = { id: 'group-1', name: 'quiet', config: CONFIG, sessions: [2, 3] };

let worlds;
let clients;

const message = (type, test = () => true) => new Promise((resolve) => {
  const listener = (world, received) => {
    if (received.type !== type || !test(received)) return;
    worlds.off('message', listener);
    resolve(world);
  };
  worlds.on('message', listener);
});
const listening = async (count) => {
  for (let started = 0; started < count; started++) await message('listening');
};
const connect = (url, auth) => {
  const client = io(url, { auth, transports: ['websocket'], reconnection: false });
  clients.push(client);
  return client;
};
const connected = (client) => new Promise((resolve, reject) => {
  client.once('connect', resolve).once('connect_error', reject);
});
const joinAgent = async (world) => {
  const agent = connect(`${world.url}/lab`, { token: world.token, run: 'ppo-run-1' });
  const [info] = await once(agent, 'env-info');
  return { agent, info };
};

describe('lab/worlds', { timeout: 20_000 }, () => {
  beforeEach(() => {
    worlds = createWorlds({ restartMs: 50 });
    clients = [];
  });
  afterEach(() => {
    clients.forEach((client) => client.close());
    worlds.close();
  });

  test('start', async () => {
    worlds.start(GROUP);
    await listening(2);
    const [first, second] = worlds.resolve('quiet', RUN_ID);
    assert.deepEqual([first.sessions, second.sessions], [2, 3]);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(first.url, second.url);

    const reported = message('state', (state) => state.agents.length === 1);
    const { info } = await joinAgent(first);
    assert.deepEqual(info.fogRadius, { min: 300, max: 2500 });
    assert.equal(info.players.bots, 2);
    await reported;
    assert.deepEqual(worlds.state('group-1').map((world) => world.agents).sort(), [0, 1]);

    await assert.rejects(connected(connect(`${second.url}/lab`, { token: first.token, run: 'ppo-run-1' })), /Invalid world token/);
    await assert.rejects(connected(connect(first.url, {})), /only takes lab agents/);
  });

  test('start (restart)', async () => {
    worlds.start(GROUP);
    await listening(2);
    const [dead] = worlds.all();
    const { token } = worlds.resolve('quiet', RUN_ID)[0];
    dead.child.kill('SIGKILL');
    await once(worlds, 'exit');
    assert.equal(worlds.resolve('quiet', RUN_ID)[0].url, null);

    await listening(1);
    const [restarted] = worlds.all();
    assert.notEqual(restarted.child.pid, dead.child.pid);
    const fresh = worlds.resolve('quiet', RUN_ID)[0];
    assert.notEqual(fresh.token, token);
    await joinAgent(fresh);
  });

  test('start (invalid message)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lab-world-')), 'world.js');
    writeFileSync(file, `process.send({ type: 'listening', port: 'x' });
process.send({ type: 'listening', port: 4321 });
process.on('disconnect', () => process.exit());
`);
    worlds = createWorlds({ file });
    const reported = [];
    worlds.on('message', (world, received) => reported.push(received));
    worlds.start({ ...GROUP, sessions: [1] });
    await message('listening');

    assert.deepEqual(reported, [{ type: 'listening', port: 4321 }]);
    assert.equal(worlds.all()[0].port, 4321);
  });

  test('setConfig', async () => {
    worlds.start(GROUP);
    await listening(2);
    const { agent } = await joinAgent(worlds.resolve('quiet', RUN_ID)[0]);
    worlds.setConfig('group-1', { FOG_RADIUS_MAX: 1200, BOTS: 3 });
    const [info] = await once(agent, 'env-info');

    assert.deepEqual(info.fogRadius, { min: 300, max: 1200 });
    assert.equal(info.players.bots, 3);
    assert.equal(worlds.group('quiet').config.FOG_RADIUS_MAX, 1200);
    assert.equal(GROUP.config.FOG_RADIUS_MAX, 2500);
  });

  test('send', async () => {
    worlds.start(GROUP);
    await listening(2);
    const { agent } = await joinAgent(worlds.resolve('quiet', RUN_ID)[0]);
    worlds.send({ type: 'revoke', runIds: [RUN_ID] });

    const [reason] = await once(agent, 'disconnect');
    assert.equal(reason, 'io server disconnect');
  });

  test('stop', async () => {
    worlds.start(GROUP);
    await listening(2);
    worlds.stop('group-1');
    await once(worlds, 'exit');
    await sleep(200);

    assert.equal(worlds.running('group-1'), false);
    assert.equal(worlds.resolve('quiet', RUN_ID), undefined);
    assert.deepEqual(worlds.all(), []);
  });
});
