import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { applyUpdate, loadEnv, parsePorts } from './pixel-snake-lab.js';

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

  test('parsePorts', () => {
    assert.deepEqual(parsePorts('3030'), [3030]);
    assert.deepEqual(parsePorts('3031-3034'), [3031, 3032, 3033, 3034]);
    assert.deepEqual(parsePorts('3030,3035-3036'), [3030, 3035, 3036]);
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
