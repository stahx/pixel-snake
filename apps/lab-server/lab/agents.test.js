import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { attachLab } from './agents.js';

const KEY_ID = 'key-1';
const RUN_ID = 'run-1';
const EPISODE = { score: 5, maxScore: 8, ticks: 300, eaten: 9, boostSpent: 1, cause: 'bot' };

let queries;
let sent;
let worlds;
let lab;

const pool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT id FROM lab_runs')) return { rows: params[0] === KEY_ID ? [{ id: RUN_ID }, { id: 'run-3' }] : [] };
    return { rows: [], rowCount: 1 };
  },
};

const world = (name, index, agents) => ({ group: { name }, index, state: { type: 'state', tps: 60, stepMs: 1, agents } });
const agent = (id, runId = RUN_ID) => ({ id, runId, alive: true, score: 3, ticks: 60 });
const report = (from, message) => worlds.emit('message', from, message);
const inserts = () => queries.filter((q) => q.sql.includes('INSERT INTO lab_progress'));

describe('lab/agents', () => {
  beforeEach(() => {
    queries = [];
    sent = [];
    worlds = Object.assign(new EventEmitter(), {
      list: [],
      all() { return this.list; },
      send: (message) => sent.push(message),
    });
    lab = attachLab({ worlds, pool, flushMinutes: 5 });
  });

  test('live', () => {
    const quiet = world('quiet', 0, [agent('a-1')]);
    worlds.list = [quiet, world('crowded', 1, [agent('a-2'), agent('b-1', 'run-2')])];
    report(quiet, { type: 'episode', runId: RUN_ID, episode: EPISODE });

    const { tickRate, flushMinutes, runs } = lab.live();
    assert.equal(tickRate, 60);
    assert.equal(flushMinutes, 5);
    assert.deepEqual(runs, [
      {
        runId: RUN_ID,
        agents: [
          { id: 'a-1', alive: true, score: 3, ticks: 60, world: 'quiet #1' },
          { id: 'a-2', alive: true, score: 3, ticks: 60, world: 'crowded #2' },
        ],
        pending: { episodes: 1, scoreAvg: 8, scoreMax: 8, ticksAvg: 300, eatenAvg: 9, boostAvg: 1, deaths: { bot: 1 }, metrics: {} },
      },
      { runId: 'run-2', agents: [{ id: 'b-1', alive: true, score: 3, ticks: 60, world: 'crowded #2' }], pending: null },
    ]);
  });

  test('attachLab (log)', async () => {
    const quiet = world('quiet', 0, [agent('a-1')]);
    worlds.list = [quiet];
    report(quiet, { type: 'log', runId: RUN_ID, values: { loss: 0.4, 'policy/entropy': 1.2 } });
    quiet.state.agents = [];
    report(quiet, quiet.state);
    await new Promise(setImmediate);

    assert.equal(inserts()[0].params[8], '{"loss":0.4,"policy/entropy":1.2}');
  });

  test('attachLab (state)', async () => {
    const quiet = world('quiet', 0, [agent('a-1')]);
    const crowded = world('crowded', 0, [agent('a-2')]);
    worlds.list = [quiet, crowded];
    report(quiet, { type: 'episode', runId: RUN_ID, episode: EPISODE });
    report(crowded, { type: 'episode', runId: RUN_ID, episode: { ...EPISODE, maxScore: 20, cause: 'human' } });

    quiet.state.agents = [];
    report(quiet, quiet.state);
    assert.equal(inserts().length, 0);

    crowded.state.agents = [];
    report(crowded, crowded.state);
    await new Promise(setImmediate);
    assert.deepEqual(inserts()[0].params, [RUN_ID, 2, 14, 20, 300, 9, 1, '{"bot":1,"human":1}', '{}']);
    assert.deepEqual(lab.live().runs, []);
  });

  test('attachLab (exit)', async () => {
    const quiet = world('quiet', 0, [agent('a-1')]);
    worlds.list = [quiet];
    report(quiet, { type: 'episode', runId: RUN_ID, episode: EPISODE });
    quiet.state = null;
    worlds.emit('exit', quiet);
    await new Promise(setImmediate);

    assert.equal(inserts()[0].params[1], 1);
  });

  test('disconnectKey', async () => {
    await lab.disconnectKey('other-key');
    await lab.disconnectKey(KEY_ID);

    assert.deepEqual(sent, [{ type: 'revoke', runIds: [] }, { type: 'revoke', runIds: [RUN_ID, 'run-3'] }]);
  });

  test('flushAll', async () => {
    const quiet = world('quiet', 0, [agent('a-1')]);
    worlds.list = [quiet];
    report(quiet, { type: 'episode', runId: RUN_ID, episode: EPISODE });
    await lab.flushAll();

    assert.equal(inserts().length, 1);
    assert.equal(lab.live().runs[0].pending, null);
  });
});
