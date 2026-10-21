import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createRooms } from './rooms.js';

const backendDir = mkdtempSync(join(tmpdir(), 'lab-rooms-'));
writeFileSync(join(backendDir, 'rooms.js'), `console.log('started', process.argv.slice(2).join(' '), process.env.LAB_FIRST_ROOM_PORT);
process.on('SIGINT', () => { console.log('stopped'); process.exit(0); });
setInterval(() => {}, 1000);
`);

describe('lab/rooms', () => {
  test('start, list, stop', async () => {
    const rooms = createRooms({ backendDir, firstPort: 4031 });
    const pid = await rooms.start({ count: 3, timescale: 1.5 });
    await sleep(300);
    const started = (await rooms.list()).find((r) => r.pid === pid);
    assert.deepEqual(started, { pid, group: pid, count: 3, timescale: 1.5 });

    rooms.stop(started.group);
    await sleep(300);
    assert.equal((await rooms.list()).some((r) => r.pid === pid), false);
    assert.equal(readFileSync(join(backendDir, 'rooms.log'), 'utf8'), 'started 3 1.5 4031\nstopped\n');
  });

  test('taken', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    const rooms = createRooms({ backendDir, firstPort: port });
    assert.equal(await rooms.taken(1), port);

    server.close();
    await once(server, 'close');
    assert.equal(await rooms.taken(1), null);
  });
});
