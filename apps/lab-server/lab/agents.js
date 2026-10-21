import { GAME_CONFIG } from '@pixel-snake/backend/Config';

import { addEpisode, addMetrics, createProgress, summarize } from './progress.js';

export const RUN_NAME = /^\w[\w .:-]{0,39}$/;
const METRIC_NAME = /^[\w./-]{1,40}$/;
const MAX_METRICS = 32;

export const numbersError = (values, what = 'log') => {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return `${what} expects an object of numbers`;
  const entries = Object.entries(values);
  if (!entries.length || entries.length > MAX_METRICS) return `${what} expects 1-${MAX_METRICS} numbers`;
  const bad = entries.find(([name, value]) => !METRIC_NAME.test(name) || !Number.isFinite(value));
  return bad ? `Invalid ${what} entry ${JSON.stringify(bad[0])}: names match ${METRIC_NAME}, values are finite numbers` : null;
};

export function attachLab({ worlds, pool, flushMinutes }) {
  const runs = new Map();
  const runOf = (runId) => {
    if (!runs.has(runId)) runs.set(runId, { id: runId, progress: createProgress() });
    return runs.get(runId);
  };

  async function flush(run) {
    const summary = summarize(run.progress);
    run.progress = createProgress();
    if (!summary) return;
    try {
      await pool.query(
        `INSERT INTO lab_progress(run_id, episodes, score_avg, score_max, ticks_avg, eaten_avg, boost_avg, deaths, metrics)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [run.id, summary.episodes, summary.scoreAvg, summary.scoreMax, summary.ticksAvg, summary.eatenAvg,
          summary.boostAvg, JSON.stringify(summary.deaths), JSON.stringify(summary.metrics)],
      );
      await pool.query('UPDATE lab_runs SET last_seen_at = now() WHERE id = $1', [run.id]);
    } catch (error) {
      console.error(`Lab: lost progress of run ${run.id}:`, error.message);
    }
  }

  const agents = () => worlds.all().flatMap((world) => (world.state?.agents ?? [])
    .map((agent) => ({ ...agent, world: `${world.group.name} #${world.index + 1}` })));

  // A world reports its agents on every connect and disconnect, before any episode of a new agent,
  // so a run missing from every report has left the lab.
  function settle() {
    const live = new Set(agents().map((agent) => agent.runId));
    for (const run of runs.values()) {
      if (live.has(run.id)) continue;
      runs.delete(run.id);
      flush(run);
    }
  }

  worlds.on('message', (world, message) => {
    if (message.type === 'episode') addEpisode(runOf(message.runId).progress, message.episode);
    else if (message.type === 'log') addMetrics(runOf(message.runId).progress, message.values);
    else if (message.type === 'state') settle();
  });
  worlds.on('exit', settle);

  setInterval(() => runs.forEach(flush), flushMinutes * 60_000).unref();

  return {
    live: () => ({
      tickRate: GAME_CONFIG.TICK_RATE,
      flushMinutes,
      runs: [...Map.groupBy(agents(), (agent) => agent.runId)].map(([runId, list]) => ({
        runId,
        agents: list.map(({ runId: _, ...agent }) => agent),
        pending: runs.has(runId) ? summarize(runs.get(runId).progress) : null,
      })),
    }),
    async disconnectKey(keyId) {
      const result = await pool.query('SELECT id FROM lab_runs WHERE key_id = $1', [keyId]);
      worlds.send({ type: 'revoke', runIds: result.rows.map((row) => row.id) });
    },
    flushAll: () => Promise.all([...runs.values()].map(flush)),
  };
}
