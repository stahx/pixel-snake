import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { addEpisode, addMetrics, createProgress, mergeWindows, summarize } from './progress.js';

const EPISODE = { maxScore: 10, ticks: 600, eaten: 12, boostSpent: 2, cause: 'bot' };
const ROW = { score_avg: 10, score_max: 20, ticks_avg: 600, eaten_avg: 5, boost_avg: 1, deaths: { bot: 1 }, metrics: { loss: 1 } };

let progress;

describe('lab/progress', () => {
  beforeEach(() => {
    progress = createProgress();
  });

  test('addEpisode', () => {
    addEpisode(progress, EPISODE);
    addEpisode(progress, { ...EPISODE, maxScore: 30, ticks: 1200, cause: 'disconnect' });

    assert.equal(progress.episodes, 1);
    assert.equal(progress.scoreMax, 10);
    assert.equal(progress.ticksSum, 600);
    assert.deepEqual(progress.deaths, { bot: 1, disconnect: 1 });
  });

  test('addMetrics', () => {
    addMetrics(progress, { loss: 1, entropy: 2 });
    addMetrics(progress, { loss: 3 });
    addMetrics(progress, JSON.parse('{"__proto__": 5, "constructor": 6}'));

    assert.deepEqual(progress.metrics, new Map([
      ['loss', { sum: 4, count: 2 }],
      ['entropy', { sum: 2, count: 1 }],
      ['__proto__', { sum: 5, count: 1 }],
      ['constructor', { sum: 6, count: 1 }],
    ]));
    assert.equal({}.sum, undefined);
  });

  test('summarize', () => {
    assert.equal(summarize(progress), null);

    addEpisode(progress, { ...EPISODE, cause: 'disconnect' });
    assert.deepEqual(summarize(progress), {
      episodes: 0, scoreAvg: null, scoreMax: null, ticksAvg: null, eatenAvg: null, boostAvg: null,
      deaths: { disconnect: 1 }, metrics: {},
    });
    progress = createProgress();

    addMetrics(progress, { loss: 0.5 });
    assert.deepEqual(summarize(progress), {
      episodes: 0, scoreAvg: null, scoreMax: null, ticksAvg: null, eatenAvg: null, boostAvg: null,
      deaths: {}, metrics: { loss: 0.5 },
    });

    addEpisode(progress, EPISODE);
    addEpisode(progress, { ...EPISODE, maxScore: 30, ticks: 1200, eaten: 20, boostSpent: 4, cause: 'human' });
    assert.deepEqual(summarize(progress), {
      episodes: 2, scoreAvg: 20, scoreMax: 30, ticksAvg: 900, eatenAvg: 16, boostAvg: 3,
      deaths: { bot: 1, human: 1 }, metrics: { loss: 0.5 },
    });
  });

  test('mergeWindows', () => {
    const rows = [
      { ...ROW, recorded_at: '2026-10-18T15:28:14.100Z', episodes: 1 },
      { ...ROW, recorded_at: '2026-10-18T15:28:14.900Z', episodes: 3, score_avg: 30, score_max: 90, deaths: { bot: 2, agent: 1 }, metrics: { loss: 3, entropy: 1 } },
      { ...ROW, recorded_at: '2026-10-18T15:33:14.200Z', episodes: 0, score_avg: null, score_max: null, deaths: {}, metrics: { loss: 2 } },
    ];

    assert.deepEqual(mergeWindows(rows, 5 * 60_000), [
      {
        recorded_at: '2026-10-18T15:28:14.900Z', episodes: 4, score_max: 90, deaths: { bot: 3, agent: 1 },
        score_avg: 25, ticks_avg: 600, eaten_avg: 5, boost_avg: 1, metrics: { loss: 2, entropy: 1 },
      },
      {
        recorded_at: '2026-10-18T15:33:14.200Z', episodes: 0, score_max: null, deaths: {},
        score_avg: null, ticks_avg: null, eaten_avg: null, boost_avg: null, metrics: { loss: 2 },
      },
    ]);
  });
});
