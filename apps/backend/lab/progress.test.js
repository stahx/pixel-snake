import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { addEpisode, addMetrics, createProgress, summarize } from './progress.js';

const EPISODE = { maxScore: 10, ticks: 600, eaten: 12, boostSpent: 2, cause: 'bot' };

let progress;

describe('lab/progress', () => {
  beforeEach(() => {
    progress = createProgress();
  });

  test('addEpisode', () => {
    addEpisode(progress, EPISODE);
    addEpisode(progress, { ...EPISODE, maxScore: 30, ticks: 1200, cause: 'disconnect' });

    assert.equal(progress.episodes, 2);
    assert.equal(progress.scoreMax, 30);
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
});
