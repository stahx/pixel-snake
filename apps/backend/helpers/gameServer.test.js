import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { calculatePlayerNewSize, growth, maxTailSegments, maxTurn, speedFactor } from './gameServer.js';

describe('helpers/gameServer', () => {
  test('growth', () => {
    assert.equal(growth(0), 0);
    assert.equal(growth(-5), 0);
    assert.ok(Math.abs(growth(166.5) - 0.5) < 1e-9);
    assert.equal(growth(5000), 1);
  });

  test('calculatePlayerNewSize', () => {
    assert.equal(calculatePlayerNewSize({ points: 0 }), 10);
    assert.equal(calculatePlayerNewSize({ points: 333 }), 100);
    assert.equal(calculatePlayerNewSize({ points: 9574 }), 100);
  });

  test('maxTailSegments', () => {
    assert.equal(maxTailSegments(0), 0);
    assert.equal(maxTailSegments(333), 400);
    assert.equal(maxTailSegments(9574), 400);
  });

  test('speedFactor', () => {
    assert.equal(speedFactor(0), 1);
    assert.ok(Math.abs(speedFactor(333) - 0.7) < 1e-9);
  });

  test('maxTurn', () => {
    assert.equal(maxTurn(1.3, 10, 0.08), 0.08);
    assert.ok(Math.abs(maxTurn(0.91, 100, 0.08) - 0.91 / 120) < 1e-9);
  });
});
