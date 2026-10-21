import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import GameServer from './GameServer.js';

const CONFIG = {
  MAP_WIDTH: 4000,
  MAP_HEIGHT: 4000,
  POINTS_AMOUNT: 0,
  NORMAL_SPEED: 1.3,
  BOOST_SPEED: 2.3,
  TICK_RATE: 60,
  BOTS: 4,
};

let game;
let bots;

describe('class/BotManager', () => {
  beforeEach(() => {
    game = new GameServer({ on() {} }, CONFIG);
    bots = game.botManager;
  });

  test('reconcile', () => {
    const extra = bots.spawnExtra({ x: 1, y: 1 });
    game.humanSockets.add('human-1');
    bots.reconcile();
    assert.equal(bots.bots.size, 5);

    game.config.BOTS = 1;
    bots.reconcile();
    assert.equal(bots.bots.size, 2);
    assert.equal(bots.isBot(extra.playerId), true);

    game.humanSockets.clear();
    bots.reconcile();
    assert.deepEqual([...bots.bots], [extra.playerId]);
  });

  test('spawnExtra', () => {
    const extra = bots.spawnExtra({ x: 120, y: 340 });

    assert.deepEqual([extra.x, extra.y], [120, 340]);
    assert.equal(game.players.get(extra.playerId), extra);
    assert.deepEqual(game.tails.get(extra.playerId), []);
    assert.equal(bots.isBot(extra.playerId), true);
  });

  test('remove', () => {
    const extra = bots.spawnExtra({ x: 120, y: 340 });
    bots.remove(extra.playerId);

    assert.equal(game.players.has(extra.playerId), false);
    assert.equal(bots.isBot(extra.playerId), false);
    assert.equal(bots.extras.size, 0);
  });
});
