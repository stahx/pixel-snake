import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { botsOf, createOpponents, opponentRun } from './opponents.js';

const GROUP = {
  id: 'group-1',
  name: 'mixed',
  opponents: [
    [{ model: null, count: 3 }, { model: 'slither-v7/latest.pt', count: 5 }],
    [{ model: null, count: 10 }],
    [{ model: 'slither-v7/update-100.pt', count: 2 }, { model: 'slither-v8/latest.pt', count: 1 }],
  ],
};

let played;
let opponents;

const trainer = {
  play: (options) => {
    const child = Object.assign(new EventEmitter(), { options, killed: false });
    child.kill = () => {
      child.killed = true;
      child.emit('exit', null, 'SIGTERM');
    };
    played.push(child);
    return child;
  },
};

describe('lab/opponents', () => {
  beforeEach(() => {
    played = [];
    opponents = createOpponents({ trainer, restartMs: 20 });
  });

  test('botsOf', () => {
    assert.equal(botsOf(GROUP.opponents[0]), 3);
    assert.equal(botsOf(GROUP.opponents[2]), 0);
    assert.equal(botsOf([{ model: null, count: 2 }, { model: null, count: 4 }]), 6);
  });

  test('opponentRun', () => {
    assert.equal(opponentRun('slither-v7/update-100.pt'), 'slither-v7-play');
  });

  test('createOpponents', async () => {
    opponents.start(GROUP);
    opponents.start(GROUP);

    assert.deepEqual(played.map((child) => child.options), [
      { model: { run: 'slither-v7', file: 'latest.pt' }, run: 'slither-v7-play', group: 'mixed', world: 0, sessions: 5 },
      { model: { run: 'slither-v7', file: 'update-100.pt' }, run: 'slither-v7-play', group: 'mixed', world: 2, sessions: 2 },
      { model: { run: 'slither-v8', file: 'latest.pt' }, run: 'slither-v8-play', group: 'mixed', world: 2, sessions: 1 },
    ]);

    played[1].emit('exit', 1, null);
    await sleep(50);
    assert.equal(played.length, 4);
    assert.deepEqual(played[3].options, played[1].options);

    opponents.stop('group-1');
    await sleep(50);
    assert.deepEqual(played.map((child) => child.killed), [true, false, true, true]);
    assert.equal(played.length, 4);
  });
});
