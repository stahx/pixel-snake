import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { findKey } from './keys.js';
import { addEpisode, addMetrics, createProgress, summarize } from './progress.js';

export const RUN_NAME = /^\w[\w .:-]{0,39}$/;
const METRIC_NAME = /^[\w./-]{1,40}$/;
const MAX_METRICS = 32;
const SYNC_MS = 2000;

export const numbersError = (values, what = 'log') => {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return `${what} expects an object of numbers`;
  const entries = Object.entries(values);
  if (!entries.length || entries.length > MAX_METRICS) return `${what} expects 1-${MAX_METRICS} numbers`;
  const bad = entries.find(([name, value]) => !METRIC_NAME.test(name) || !Number.isFinite(value));
  return bad ? `Invalid ${what} entry ${JSON.stringify(bad[0])}: names match ${METRIC_NAME}, values are finite numbers` : null;
};

const mergeRuns = (instances) => {
  const merged = new Map();
  for (const run of instances.flat()) {
    const known = merged.get(run.runId) || { ...run, agents: [], pending: { episodes: 0, scoreMax: null } };
    known.agents.push(...run.agents);
    known.pending.episodes += run.pending?.episodes ?? 0;
    if (run.pending?.scoreMax != null) known.pending.scoreMax = Math.max(known.pending.scoreMax ?? 0, run.pending.scoreMax);
    merged.set(run.runId, known);
  }
  return [...merged.values()];
};

export function attachLab({ io, game, pool, flushMinutes, room }) {
  const namespace = io.of('/lab');
  const runs = new Map();
  const instance = `${hostname()}:${room}`;
  let published = false;

  namespace.use(async (socket, next) => {
    if (!pool) return next(new Error('Lab is disabled: DATABASE_URL is not set'));
    const { key, run = 'TRAINING' } = socket.handshake.auth;
    if (typeof key !== 'string') return next(new Error('Missing lab key'));
    if (typeof run !== 'string' || !RUN_NAME.test(run)) return next(new Error(`Run name must match ${RUN_NAME}`));
    try {
      const keyId = await findKey(pool, key);
      if (!keyId) return next(new Error('Invalid or revoked lab key'));
      const saved = await pool.query(
        `INSERT INTO lab_runs(id, key_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (key_id, name) DO UPDATE SET last_seen_at = now() RETURNING id`,
        [randomUUID(), keyId, run],
      );
      socket.data.agent = { runId: saved.rows[0].id, keyId, name: run };
      next();
    } catch (error) {
      console.error('Lab auth:', error.message);
      next(new Error('Lab database unavailable'));
    }
  });

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

  namespace.on('connection', (socket) => {
    const { agent } = socket.data;
    let run = runs.get(agent.runId);
    if (!run) {
      run = { id: agent.runId, name: agent.name, keyId: agent.keyId, sockets: new Set(), progress: createProgress() };
      runs.set(run.id, run);
    }
    run.sockets.add(socket);
    game.connect(socket, agent);

    socket.on('log', (values) => {
      const error = numbersError(values);
      if (error) return socket.emit('lab-error', error);
      addMetrics(run.progress, values);
    });
    socket.on('disconnect', () => {
      run.sockets.delete(socket);
      if (run.sockets.size) return;
      runs.delete(run.id);
      flush(run);
    });
  });

  game.on('episode-end', (episode) => {
    const run = runs.get(episode.agent.runId);
    if (run) addEpisode(run.progress, episode);
  });

  const localRuns = () => [...runs.values()].map((run) => ({
    runId: run.id,
    name: run.name,
    agents: [...run.sockets].map((socket) => {
      const player = game.players.get(socket.id);
      return player
        ? { id: socket.id, room, alive: true, score: player.points, ticks: game.tick - player.bornTick }
        : { id: socket.id, room, alive: false, score: 0, ticks: 0 };
    }),
    pending: summarize(run.progress),
  }));

  const disconnectKey = (keyId) => {
    for (const run of runs.values()) {
      if (run.keyId === keyId) run.sockets.forEach((socket) => socket.disconnect(true));
    }
  };

  async function sync() {
    try {
      if (!runs.size) {
        if (published) await pool.query('DELETE FROM lab_live WHERE instance = $1', [instance]);
        published = false;
        return;
      }
      await pool.query(
        `INSERT INTO lab_live(instance, runs) VALUES ($1, $2)
         ON CONFLICT (instance) DO UPDATE SET runs = $2, updated_at = now()`,
        [instance, JSON.stringify(localRuns())],
      );
      published = true;
      const keyIds = [...new Set([...runs.values()].map((run) => run.keyId))];
      const revoked = await pool.query('SELECT id FROM lab_keys WHERE revoked_at IS NOT NULL AND id = ANY($1)', [keyIds]);
      revoked.rows.forEach(({ id }) => disconnectKey(id));
    } catch (error) {
      console.error('Lab sync:', error.message);
    }
  }

  setInterval(() => runs.forEach(flush), flushMinutes * 60_000).unref();
  if (pool) setInterval(sync, SYNC_MS).unref();

  return {
    live: async () => {
      const others = await pool.query(
        `SELECT runs FROM lab_live WHERE instance <> $1 AND updated_at > now() - interval '10 seconds'`,
        [instance],
      );
      return {
        tickRate: game.config.TICK_RATE,
        flushMinutes,
        runs: mergeRuns([localRuns(), ...others.rows.map((row) => row.runs)]),
      };
    },
    sync,
    disconnectKey,
  };
}
