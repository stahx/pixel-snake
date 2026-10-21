export const createProgress = () => ({
  episodes: 0,
  scoreSum: 0,
  scoreMax: 0,
  ticksSum: 0,
  eatenSum: 0,
  boostSum: 0,
  deaths: {},
  metrics: new Map(),
});

export function addEpisode(progress, episode) {
  progress.deaths[episode.cause] = (progress.deaths[episode.cause] || 0) + 1;
  // A trainer stopping ends every life at once, whatever it was worth; only the death chart counts those.
  if (episode.cause === 'disconnect') return;
  progress.episodes++;
  progress.scoreSum += episode.maxScore;
  progress.scoreMax = Math.max(progress.scoreMax, episode.maxScore);
  progress.ticksSum += episode.ticks;
  progress.eatenSum += episode.eaten;
  progress.boostSum += episode.boostSpent;
}

export function addMetrics(progress, values) {
  for (const [name, value] of Object.entries(values)) {
    const metric = progress.metrics.get(name) || { sum: 0, count: 0 };
    metric.sum += value;
    metric.count++;
    progress.metrics.set(name, metric);
  }
}

export function summarize(progress) {
  const { episodes, metrics } = progress;
  if (!episodes && !metrics.size && !Object.keys(progress.deaths).length) return null;
  const average = (sum) => (episodes ? sum / episodes : null);
  return {
    episodes,
    scoreAvg: average(progress.scoreSum),
    scoreMax: episodes ? progress.scoreMax : null,
    ticksAvg: average(progress.ticksSum),
    eatenAvg: average(progress.eatenSum),
    boostAvg: average(progress.boostSum),
    deaths: progress.deaths,
    metrics: Object.fromEntries([...metrics].map(([name, m]) => [name, m.sum / m.count])),
  };
}

const WEIGHTED = ['score_avg', 'ticks_avg', 'eaten_avg', 'boost_avg'];

export function mergeWindows(rows, windowMs) {
  const windows = new Map();
  for (const row of rows) {
    const start = Math.floor(new Date(row.recorded_at).getTime() / windowMs);
    const window = windows.get(start)
      ?? { recorded_at: row.recorded_at, episodes: 0, score_max: null, deaths: {}, sums: {}, metrics: new Map() };
    window.recorded_at = row.recorded_at;
    window.episodes += row.episodes;
    if (row.score_max != null) window.score_max = Math.max(window.score_max ?? 0, row.score_max);
    for (const field of WEIGHTED) {
      if (row[field] != null) window.sums[field] = (window.sums[field] ?? 0) + row[field] * row.episodes;
    }
    for (const [cause, count] of Object.entries(row.deaths)) window.deaths[cause] = (window.deaths[cause] ?? 0) + count;
    for (const [name, value] of Object.entries(row.metrics)) {
      const metric = window.metrics.get(name) || { sum: 0, count: 0 };
      metric.sum += value;
      metric.count++;
      window.metrics.set(name, metric);
    }
    windows.set(start, window);
  }
  return [...windows.values()].map(({ sums, metrics, ...window }) => ({
    ...window,
    ...Object.fromEntries(WEIGHTED.map((field) => [field, window.episodes ? sums[field] / window.episodes : null])),
    metrics: Object.fromEntries([...metrics].map(([name, metric]) => [name, metric.sum / metric.count])),
  }));
}
