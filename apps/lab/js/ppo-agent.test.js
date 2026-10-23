import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DANGER_SECTORS, FOOD_SLOTS, VIEW_DISTANCE, advantages, features, rewardFor } from './ppo-agent.js';

const INFO = { map: { width: 4000, height: 4000 } };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

describe('lab/ppo-agent', () => {
  test('features', () => {
    const me = { type: 'player', player: 'me', x: 3990, y: 1995, size: 10, angle: 0, points: 0, boosting: 0 };
    const observation = { me, entities: new Map([
      [1, me],
      [2, { type: 'point', x: 100, y: 2000, size: 16 }],
      [3, { type: 'tail', player: 'me', x: 3900, y: 2000 }],
      [4, { type: 'tail', player: 'other', x: 3995, y: 2250 }],
    ]) };

    const state = features(observation, INFO);
    const danger = state.slice(FOOD_SLOTS * 3, FOOD_SLOTS * 3 + DANGER_SECTORS);

    close(state[0], 105 / VIEW_DISTANCE);
    close(state[1], 0);
    close(state[2], 1);
    assert.ok(state.slice(3, FOOD_SLOTS * 3).every((value) => value === 0));
    const rightSide = Math.floor((Math.PI / 2 + Math.PI) / (2 * Math.PI) * DANGER_SECTORS);
    close(danger[rightSide], 1 - 250 / VIEW_DISTANCE);
    assert.equal(danger.filter(Boolean).length, 1);
  });

  test('advantages', () => {
    const { advantage, returns } = advantages([1, 1], [0.5, 0.5], [0, 1], 9);

    const last = 1 - 0.5;
    const first = 1 + 0.99 * 0.5 - 0.5 + 0.99 * 0.95 * last;
    close(advantage[0], first);
    close(advantage[1], last);
    close(returns[0], first + 0.5);
  });

  test('rewardFor', () => {
    const alive = { alive: true, me: { points: 120 }, kills: 2, killPoints: 40 };

    assert.equal(rewardFor(alive, { alive: true, me: { points: 123 }, kills: 2, killPoints: 40 }), 3);
    assert.equal(rewardFor(alive, { alive: true, me: { points: 123 }, kills: 3, killPoints: 100 }), 63);
    assert.equal(rewardFor(alive, { alive: false, me: null, kills: 2, killPoints: 40 }), -170);
  });
});
