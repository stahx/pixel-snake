import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';

import { serveClient } from './client.js';

const game = { running: true, entities: [], config: { MAP_WIDTH: 4000, MAP_HEIGHT: 3000 } };

let server;
let base;

describe('helpers/client', () => {
  before(async () => {
    const app = express();
    serveClient(app, game);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('serveClient', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /class\/GameClient\.js/);
    assert.equal((await fetch(`${base}/icon.svg`)).status, 200);
    assert.match((await (await fetch(`${base}/version`)).json()).version, /^\d+\.\d+/);
    assert.equal((await fetch(`${base}/state`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/game-data`)).json(), { entities: [], width: 4000, height: 3000 });

    game.running = false;
    assert.equal((await fetch(`${base}/state`)).status, 400);
    assert.equal((await fetch(`${base}/game-data`)).status, 400);
  });
});
