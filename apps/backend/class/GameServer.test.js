import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import GameServer from './GameServer.js';
import Tail from './Tail.js';

const CONFIG = {
  MAP_WIDTH: 4000,
  MAP_HEIGHT: 4000,
  POINTS_AMOUNT: 50,
  NORMAL_SPEED: 1.3,
  BOOST_SPEED: 2.3,
  TICK_RATE: 60,
};
const AGENT = { runId: 'run-1', keyId: 'key-1', name: 'ppo-run-1' };

let game;
let sent;
let episodes;

const fakeSocket = (id) => {
  const handlers = {};
  return {
    id,
    handlers,
    on: (event, handler) => { handlers[event] = handler; },
    emit: (event, data) => sent.push({ to: id, event, data }),
  };
};

describe('class/GameServer', () => {
  beforeEach(() => {
    sent = [];
    episodes = [];
    game = new GameServer({ on() {} }, CONFIG);
    game.on('episode-end', (episode) => episodes.push(episode));
  });

  test('connect (agent)', () => {
    game.connect(fakeSocket('agent-1'), AGENT);

    const player = game.players.get('agent-1');
    assert.equal(player.name, 'ppo-run-1');
    assert.equal(player.agent, AGENT);
    assert.equal(game.spectators.has('agent-1'), false);
    const info = sent.find((m) => m.event === 'env-info').data;
    assert.deepEqual(info.map, { width: 4000, height: 4000, wraps: true });
    assert.deepEqual(info.players, { total: 11, bots: 10, clients: 1 });
    assert.deepEqual(info.actions.map((a) => a.event), ['player-join', 'change-dir', 'player-speed']);
    const updates = sent.filter((m) => m.event === 'update');
    assert.equal(updates.length, 1);
    assert.ok(updates[0].data.a.some((e) => e.t === 2 && e.p === 'agent-1'));
  });

  test('connect (browser)', () => {
    game.connect(fakeSocket('browser-1'));

    assert.equal(game.players.has('browser-1'), false);
    assert.equal(game.spectators.has('browser-1'), true);
    assert.deepEqual(sent.map((m) => m.event), ['update', 'env-info']);
  });

  test('step', () => {
    const socket = fakeSocket('agent-1');
    game.connect(socket, AGENT);
    game.step();

    const agent = game.players.get('agent-1');
    agent.points = 7;
    agent.maxPoints = 9;
    const botId = [...game.botManager.bots][0];
    const tail = new Tail(agent.x + 2, agent.y + 2, { playerId: botId, color: '#fff' });
    game.tails.get(botId).push(tail);
    game.allEntities.set(tail.id, tail);
    game.step();

    assert.equal(game.players.has('agent-1'), false);
    assert.ok(sent.some((m) => m.to === 'agent-1' && m.event === 'ded'));
    assert.deepEqual(episodes, [{ agent: AGENT, score: 7, maxScore: 9, ticks: 2, eaten: 0, boostSpent: 0, cause: 'bot' }]);

    socket.handlers['player-join']({ name: 'renamed' });
    assert.equal(game.players.get('agent-1').name, 'ppo-run-1');
    assert.equal(game.players.get('agent-1').agent, AGENT);
  });

  test('disconnect', () => {
    const socket = fakeSocket('agent-1');
    game.connect(socket, AGENT);
    game.step();
    game.step();
    socket.handlers.disconnect();

    assert.equal(game.players.size, 0);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].cause, 'disconnect');
    assert.equal(episodes[0].ticks, 2);
  });
});
