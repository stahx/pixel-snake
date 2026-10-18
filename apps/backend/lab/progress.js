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
  progress.episodes++;
  progress.scoreSum += episode.maxScore;
  progress.scoreMax = Math.max(progress.scoreMax, episode.maxScore);
  progress.ticksSum += episode.ticks;
  progress.eatenSum += episode.eaten;
  progress.boostSum += episode.boostSpent;
  progress.deaths[episode.cause] = (progress.deaths[episode.cause] || 0) + 1;
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
  if (!episodes && !metrics.size) return null;
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
