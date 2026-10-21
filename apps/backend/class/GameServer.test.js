import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import GameServer from './GameServer.js';
import Point from './Point.js';
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

const clearPoints = () => {
  for (const id of game.points.keys()) game.allEntities.delete(id);
  game.points.clear();
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
    assert.deepEqual([info.growth.spawnSize, info.growth.maxSize], [10, 100]);
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

  test('start', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    game = new GameServer({ on() {} }, { ...CONFIG, TIMESCALE: 2 });
    game.start();
    for (let ms = 0; ms < 1000; ms++) t.mock.timers.tick(1);
    assert.equal(game.tick, 120);

    t.mock.timers.tick(60_000);
    assert.ok(game.tick - 120 <= 3);
  });

  test('step', () => {
    const socket = fakeSocket('agent-1');
    game.connect(socket, AGENT);
    clearPoints();
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

    const dropped = [...game.points.values()].filter((point) => !point.respawns);
    assert.equal(dropped.length, 5);
    assert.ok(dropped.every((point) => point.size === 8));

    socket.handlers['player-join']({ name: 'renamed' });
    assert.equal(game.players.get('agent-1').name, 'ppo-run-1');
    assert.equal(game.players.get('agent-1').agent, AGENT);
  });

  test('step (kill)', () => {
    game.connect(fakeSocket('agent-1'), AGENT);
    game.connect(fakeSocket('agent-2'), AGENT);
    clearPoints();
    game.step();

    const victim = game.players.get('agent-1');
    victim.points = 7;
    const tail = new Tail(victim.x + 2, victim.y + 2, { playerId: 'agent-2', color: '#fff' });
    game.tails.get('agent-2').push(tail);
    game.allEntities.set(tail.id, tail);
    game.step();

    assert.deepEqual(sent.filter((m) => m.event === 'kill'), [{ to: 'agent-2', event: 'kill', data: { points: 7 } }]);
    assert.equal(episodes[0].cause, 'agent');
  });

  test('step (tail out of sight of its head)', () => {
    game.connect(fakeSocket('agent-1'), AGENT);
    game.connect(fakeSocket('agent-2'), AGENT);
    clearPoints();
    game.step();
    const viewer = game.players.get('agent-1');
    const owner = game.players.get('agent-2');
    owner.x = viewer.x + 2000;
    owner.y = viewer.y;
    owner.points = 200;
    const tail = new Tail(viewer.x + 200, viewer.y, { playerId: 'agent-2', color: '#abc' });
    game.tails.get('agent-2').push(tail);
    game.allEntities.set(tail.id, tail);
    sent = [];
    game.step();

    const added = sent.filter((m) => m.to === 'agent-1' && m.event === 'update').flatMap((m) => m.data.a ?? []);
    assert.equal(added.some((e) => e.t === 2 && e.p === 'agent-2'), false);
    assert.equal(added.find((e) => e.i === tail.id).s, Math.round(owner.size));
  });

  test('step (eating)', () => {
    game.connect(fakeSocket('agent-1'), AGENT);
    clearPoints();
    game.step();
    const agent = game.players.get('agent-1');
    const placePoint = (respawns) => {
      const point = new Point(agent.x, agent.y, { size: 8, respawns });
      game.points.set(point.id, point);
      game.allEntities.set(point.id, point);
    };

    placePoint(false);
    const before = game.points.size;
    game.step();
    assert.equal(agent.points, 1);
    assert.equal(game.points.size, before - 1);

    placePoint(true);
    game.step();
    assert.equal(agent.points, 2);
    assert.equal(game.points.size, before);
  });

  test('step (boost)', () => {
    const socket = fakeSocket('agent-1');
    game.connect(socket, AGENT);
    clearPoints();
    const agent = game.players.get('agent-1');
    agent.points = 10;
    for (let tick = 0; tick < 30; tick++) game.step();
    socket.handlers['player-speed'](true);
    const dropsBefore = [...game.points.values()].filter((point) => !point.respawns).length;
    for (let tick = 0; tick < 15; tick++) game.step();
    const dropsAfterFirstCharge = [...game.points.values()].filter((point) => !point.respawns).length;
    for (let tick = 0; tick < 15; tick++) game.step();

    const drops = [...game.points.values()].filter((point) => !point.respawns);
    assert.equal(agent.points, 8);
    assert.equal(agent.boostSpent, 2);
    assert.equal(dropsAfterFirstCharge, dropsBefore);
    assert.equal(drops.length - dropsBefore, 1);
    assert.equal(drops.at(-1).size, 8);
  });

  test('step (growth)', () => {
    game.connect(fakeSocket('agent-1'), AGENT);
    clearPoints();
    const agent = game.players.get('agent-1');
    agent.points = 333;
    game.step();
    assert.equal(agent.size, 100);

    const { x, y, currentAngle } = agent;
    agent.mouseX = agent.x + agent.size / 2 - Math.cos(currentAngle) * 500;
    agent.mouseY = agent.y + agent.size / 2 - Math.sin(currentAngle) * 500;
    game.step();

    const speed = 1.3 * 0.7;
    assert.ok(Math.abs(Math.hypot(agent.x - x, agent.y - y) - speed) < 1e-6);
    assert.ok(Math.abs(Math.abs(agent.currentAngle - currentAngle) - speed / 120) < 1e-6);
  });

  test('step (tail cap)', () => {
    game.connect(fakeSocket('agent-1'), AGENT);
    const agent = game.players.get('agent-1');
    agent.points = 5000;
    for (let segment = 0; segment < 401; segment++) {
      const tail = new Tail(agent.x - 4000, agent.y - 4000, { playerId: 'agent-1', color: '#fff' });
      game.tails.get('agent-1').push(tail);
      game.allEntities.set(tail.id, tail);
    }
    game.step();

    assert.equal(game.tails.get('agent-1').length, 400);
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
