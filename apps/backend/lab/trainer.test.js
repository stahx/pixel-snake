import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createTrainer } from './trainer.js';

const labDir = mkdtempSync(join(tmpdir(), 'lab-trainer-'));
mkdirSync(join(labDir, 'py'));
writeFileSync(join(labDir, 'py/ppo_agent.py'), 'echo "started $*"\ntrap \'echo stopped; exit 0\' INT\nwhile :; do sleep 0.05; done\n');
const trainer = createTrainer({ labDir, python: '/bin/sh' });

describe('lab/trainer', () => {
  test('start, running, stop', async () => {
    const pid = await trainer.start({ name: 'v 6', rooms: [{ ports: '3031-3032', sessions: 2 }, { ports: '3035', sessions: 2 }] });
    await sleep(200);
    assert.equal(await trainer.running(pid, 'v 6'), true);
    assert.equal(await trainer.running(pid, 'v'), false);

    trainer.stop(pid);
    await sleep(300);
    assert.equal(await trainer.running(pid, 'v 6'), false);
    assert.equal(readFileSync(join(labDir, 'py/checkpoints/v 6/trainer.log'), 'utf8'),
      'started --ports 3031-3032,3035 --sessions 2 --run v 6\nstopped\n');

    const mixed = await trainer.start({ name: 'v7', rooms: [{ ports: '3031-3040', sessions: 1 }, { ports: '3041-3050', sessions: 10 }] });
    await sleep(200);
    trainer.stop(mixed);
    await sleep(300);
    assert.equal(readFileSync(join(labDir, 'py/checkpoints/v7/trainer.log'), 'utf8'),
      'started --ports 3031-3040:1,3041-3050:10 --run v7\nstopped\n');

    const seeded = await trainer.start({ name: 'v8', rooms: [{ ports: '3031', sessions: 1 }], model: { run: 'v7', file: 'update-200.pt' } });
    await sleep(200);
    assert.equal(await trainer.running(seeded, 'v8'), true);
    assert.equal(await trainer.running(seeded, 'v'), false);
    trainer.stop(seeded);
    await sleep(300);
    assert.equal(readFileSync(join(labDir, 'py/checkpoints/v8/trainer.log'), 'utf8'),
      'started --ports 3031 --sessions 1 --run v8 --model py/checkpoints/v7/update-200.pt\nstopped\n');
  });

  test('models', () => {
    mkdirSync(join(labDir, 'py/checkpoints/v7'), { recursive: true });
    for (const file of ['update-200.pt', 'latest.pt', 'update-1000.pt', 'config.json']) writeFileSync(join(labDir, 'py/checkpoints/v7', file), '');

    assert.deepEqual(trainer.models(), [{ run: 'v7', files: ['latest.pt', 'update-1000.pt', 'update-200.pt'] }]);
  });
});
