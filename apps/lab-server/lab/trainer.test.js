import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createTrainer } from './trainer.js';

const labDir = mkdtempSync(join(tmpdir(), 'lab-trainer-'));
mkdirSync(join(labDir, 'py'));
writeFileSync(join(labDir, 'py/ppo_agent.py'), 'echo "started $* for $PIXEL_SNAKE_LAB_URL"\ntrap \'echo stopped; exit 0\' INT\nwhile :; do sleep 0.05; done\n');
const trainer = createTrainer({ labUrl: 'http://127.0.0.1:3101', labDir, python: '/bin/sh' });

describe('lab/trainer', () => {
  test('start, running, stop', async () => {
    const pid = await trainer.start({ name: 'v 6', groups: ['quiet', 'crowded'] });
    await sleep(200);
    assert.equal(await trainer.running(pid, 'v 6'), true);
    assert.equal(await trainer.running(pid, 'v'), false);

    trainer.stop(pid);
    await sleep(300);
    assert.equal(await trainer.running(pid, 'v 6'), false);
    assert.equal(readFileSync(join(labDir, 'py/checkpoints/v 6/trainer.log'), 'utf8'),
      'started --groups quiet,crowded --run v 6 for http://127.0.0.1:3101\nstopped\n');

    const seeded = await trainer.start({ name: 'v8', groups: ['quiet'], model: { run: 'v7', file: 'update-200.pt' } });
    await sleep(200);
    assert.equal(await trainer.running(seeded, 'v8'), true);
    assert.equal(await trainer.running(seeded, 'v'), false);
    trainer.stop(seeded);
    await sleep(300);
    assert.equal(readFileSync(join(labDir, 'py/checkpoints/v8/trainer.log'), 'utf8'),
      'started --groups quiet --run v8 --model py/checkpoints/v7/update-200.pt for http://127.0.0.1:3101\nstopped\n');
  });

  test('models', () => {
    mkdirSync(join(labDir, 'py/checkpoints/v7'), { recursive: true });
    for (const file of ['update-200.pt', 'latest.pt', 'update-1000.pt', 'config.json']) writeFileSync(join(labDir, 'py/checkpoints/v7', file), '');

    assert.deepEqual(trainer.models(), [{ run: 'v7', files: ['latest.pt', 'update-1000.pt', 'update-200.pt'] }]);
  });
});
