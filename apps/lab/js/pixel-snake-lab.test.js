import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyUpdate, findWorlds, loadEnv } from './pixel-snake-lab.js';

describe('lab/pixel-snake-lab', () => {
  test('loadEnv', () => {
    delete process.env.PIXEL_SNAKE_LAB_KEY;
    process.env.PIXEL_SNAKE_LAB_URL = 'from-shell';
    const file = join(mkdtempSync(join(tmpdir(), 'lab-')), '.env');
    writeFileSync(file, '# comment\nPIXEL_SNAKE_LAB_KEY="psl_abc=="\nPIXEL_SNAKE_LAB_URL=from-file\n');

    loadEnv(file);
    loadEnv(join(tmpdir(), 'missing.env'));

    assert.equal(process.env.PIXEL_SNAKE_LAB_KEY, 'psl_abc==');
    assert.equal(process.env.PIXEL_SNAKE_LAB_URL, 'from-shell');
  });

  test('findWorlds', async () => {
    const worlds = { quiet: [{ url: 'http://127.0.0.1:51000', token: 'run-1.signed', sessions: 2 }] };
    const received = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push([req.url, req.headers.authorization, JSON.parse(body)]);
      const running = JSON.parse(body).groups[0] === 'quiet';
      res.writeHead(running ? 200 : 409, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(running ? worlds : { error: 'Group crowded is not running' }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    process.env.PIXEL_SNAKE_LAB_URL = `http://127.0.0.1:${server.address().port}`;

    assert.deepEqual(await findWorlds({ run: 'ppo-1', groups: ['quiet'], key: 'psl_x' }), worlds);
    assert.deepEqual(received, [['/api/lab/agent/worlds', 'Bearer psl_x', { run: 'ppo-1', groups: ['quiet'] }]]);
    await assert.rejects(findWorlds({ run: 'ppo-1', groups: ['crowded'], key: 'psl_x' }), /Group crowded is not running/);
    server.close();
  });

  test('applyUpdate', () => {
    const entities = new Map();
    applyUpdate(entities, { a: [
      { i: 1, t: 2, x: 10, y: 20, c: '#fff', s: 10, p: 'sid', n: 'TRAINING', pt: 0, a: 1.5 },
      { i: 2, t: 0, x: 50, y: 60, c: '#000', s: 16 },
      { i: 3, t: 1, x: 5, y: 5, c: '#f00', p: 'other' },
    ] });
    const beforeChange = new Map(entities);
    applyUpdate(entities, { u: [{ i: 1, x: 12, y: 21, pt: 2, a: 1.6, b: 1 }, { i: 99, x: 0, y: 0 }], r: [3] });

    assert.deepEqual(entities, new Map([
      [1, { id: 1, type: 'player', x: 12, y: 21, color: '#fff', size: 10, player: 'sid', name: 'TRAINING', points: 2, angle: 1.6, boosting: 1 }],
      [2, { id: 2, type: 'point', x: 50, y: 60, color: '#000', size: 16 }],
    ]));
    assert.equal(beforeChange.get(1).x, 10);
  });
});
