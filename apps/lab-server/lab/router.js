import express from 'express';
import { randomUUID } from 'node:crypto';
import { LIMITS, configError } from '@pixel-snake/backend/Config';
import { passwordLogin } from '@pixel-snake/backend/login';

import { RUN_NAME, numbersError } from './agents.js';
import { createKey, findKey, hashKey } from './keys.js';
import { mergeWindows } from './progress.js';
import { LAB_CONFIG } from './world.js';

const LOG_LINES = 2000;
const LOG_BATCH = 1000;
const LOG_LINE_LENGTH = 1000;
const GROUP_NAME = /^[\w.-]{1,40}$/;
const MAX_GROUPS = 20;
const MAX_PROCESSES = 40;
const MAX_SESSIONS = 32;
const DEFAULTS = Object.fromEntries(Object.keys(LIMITS).map((name) => [name, LAB_CONFIG[name]]));

const fail = (status, message) => Object.assign(new Error(message), { status });
const parametersError = (values) => (values && typeof values === 'object' && !Array.isArray(values) && !Object.keys(values).length
  ? null
  : numbersError(values, 'Parameters'));
const groupsError = (groups) => (Array.isArray(groups) && groups.length && groups.length <= MAX_GROUPS
  && groups.every((name) => typeof name === 'string' && GROUP_NAME.test(name))
  ? null
  : `Groups must be a list of 1-${MAX_GROUPS} group names`);
const sessionsError = (sessions) => (Array.isArray(sessions) && sessions.length && sessions.length <= MAX_PROCESSES
  && sessions.every((count) => Number.isInteger(count) && count >= 1 && count <= MAX_SESSIONS)
  ? null
  : `Sessions must list 1-${MAX_PROCESSES} processes of 1-${MAX_SESSIONS} sessions each`);
const route = (handler) => (req, res, next) => handler(req, res).catch(next);

export function labRouter({ pool, lab, worlds, password, flushMinutes, trainer }) {
  const router = express.Router();

  async function agentRun(req) {
    if (!pool) throw fail(503, 'Lab is disabled: DATABASE_URL is not set');
    const { run } = req.body ?? {};
    if (typeof run !== 'string' || !RUN_NAME.test(run)) throw fail(400, `Run name must match ${RUN_NAME}`);
    const key = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const keyId = key && await findKey(pool, key);
    if (!keyId) throw fail(401, 'Invalid or revoked lab key');
    return { run, keyId };
  }

  router.post('/agent/logs', express.json({ limit: '1mb' }), route(async (req, res) => {
    const { lines } = req.body ?? {};
    const valid = Array.isArray(lines) && lines.length && lines.length <= LOG_BATCH
      && lines.every((line) => typeof line === 'string' && line.length <= LOG_LINE_LENGTH);
    if (!valid) throw fail(400, `lines must be 1-${LOG_BATCH} strings of up to ${LOG_LINE_LENGTH} characters`);
    const { run, keyId } = await agentRun(req);
    const added = await pool.query(
      `WITH saved AS (
         INSERT INTO lab_runs(id, key_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (key_id, name) DO UPDATE SET last_seen_at = now() RETURNING id)
       INSERT INTO lab_logs(run_id, line)
       SELECT saved.id, l.line FROM saved, unnest($4::text[]) WITH ORDINALITY AS l(line, n) ORDER BY l.n
       RETURNING run_id`,
      [randomUUID(), keyId, run, lines],
    );
    await pool.query(
      `DELETE FROM lab_logs WHERE run_id = $1 AND id <= (
         SELECT id FROM lab_logs WHERE run_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
      [added.rows[0].run_id, LOG_LINES],
    );
    res.status(204).end();
  }));

  router.use(express.json({ limit: '10kb' }));

  // The run's saved parameters, then the panel's pending edits, then the trainer's command-line flags.
  router.post('/agent/config', route(async (req, res) => {
    const { config, overrides = {} } = req.body ?? {};
    const invalid = numbersError(config, 'config')
      || (Object.keys(overrides).length ? numbersError(overrides, 'overrides') : null)
      || (Object.keys(overrides).some((name) => !(name in config)) ? 'overrides must name parameters from config' : null);
    if (invalid) throw fail(400, invalid);
    const { run, keyId } = await agentRun(req);
    const result = await pool.query(
      `INSERT INTO lab_runs(id, key_id, name, config, starts) VALUES ($1, $2, $3, $4::jsonb || $5::jsonb, ARRAY[now()])
       ON CONFLICT (key_id, name) DO UPDATE
       SET config = EXCLUDED.config || COALESCE(lab_runs.config_pending, '{}') || $5::jsonb, config_pending = NULL, last_seen_at = now(),
         starts = lab_runs.starts || now()
       RETURNING config`,
      [randomUUID(), keyId, run, JSON.stringify(config), JSON.stringify(overrides)],
    );
    res.json({ config: result.rows[0].config });
  }));

  router.post('/agent/worlds', route(async (req, res) => {
    const invalid = groupsError(req.body?.groups);
    if (invalid) throw fail(400, invalid);
    const { run, keyId } = await agentRun(req);
    const saved = await pool.query(
      `INSERT INTO lab_runs(id, key_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (key_id, name) DO UPDATE SET last_seen_at = now() RETURNING id`,
      [randomUUID(), keyId, run],
    );
    const found = {};
    for (const name of req.body.groups) {
      found[name] = worlds.resolve(name, saved.rows[0].id);
      if (!found[name]) throw fail(409, `Group ${name} is not running`);
    }
    res.json(found);
  }));

  router.use((req, res, next) => {
    if (!password) return res.status(503).json({ error: 'Lab panel is disabled: set LAB_ADMIN_PASSWORD' });
    if (!pool) return res.status(503).json({ error: 'Lab panel is disabled: set DATABASE_URL and run pnpm db:migrate' });
    next();
  });

  passwordLogin(router, { password, cookie: 'lab_session' });

  router.get('/keys', route(async (req, res) => {
    const result = await pool.query(
      'SELECT id, name, created_at, last_used_at, revoked_at FROM lab_keys ORDER BY created_at DESC',
    );
    res.json(result.rows);
  }));

  router.post('/keys', route(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 40) throw fail(400, 'Key name must have 1-40 characters');
    const key = createKey();
    const result = await pool.query(
      'INSERT INTO lab_keys(id, name, hash) VALUES ($1, $2, $3) RETURNING id, name, created_at',
      [randomUUID(), name, hashKey(key)],
    );
    res.status(201).json({ ...result.rows[0], key });
  }));

  router.delete('/keys/:id', route(async (req, res) => {
    const result = await pool.query(
      'UPDATE lab_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [req.params.id],
    );
    if (!result.rowCount) throw fail(404, 'Key not found or already revoked');
    await lab.disconnectKey(req.params.id);
    res.status(204).end();
  }));

  router.get('/runs', route(async (req, res) => {
    const result = await pool.query(
      `SELECT r.id, r.name, r.key_id, k.name AS key_name, r.created_at, r.last_seen_at, r.config, r.config_pending, r.trainer, r.starts,
        COALESCE(sum(p.episodes), 0)::int AS episodes, max(p.score_max) AS best_score
       FROM lab_runs r
       JOIN lab_keys k ON k.id = r.key_id
       LEFT JOIN lab_progress p ON p.run_id = r.id
       GROUP BY r.id, k.name
       ORDER BY r.last_seen_at DESC`,
    );
    await Promise.all(result.rows.filter((r) => r.trainer?.pid).map(async (r) => {
      r.trainer.running = await trainer.running(r.trainer.pid, r.name);
    }));
    res.json(result.rows);
  }));

  async function trainerRun(id) {
    const found = await pool.query('SELECT name, trainer FROM lab_runs WHERE id = $1', [id]);
    if (!found.rowCount) throw fail(404, 'Run not found');
    const { name, trainer: started } = found.rows[0];
    return { name, started, running: !!started?.pid && await trainer.running(started.pid, name) };
  }

  router.post('/runs/:id/start', route(async (req, res) => {
    if (!trainer.available) throw fail(503, 'Starting from the panel needs the trainer\'s Python in apps/lab/.venv or LAB_PYTHON');
    const { groups, model } = req.body ?? {};
    const invalid = groupsError(groups);
    if (invalid) throw fail(400, invalid);
    const stopped = groups.find((name) => !worlds.group(name));
    if (stopped) throw fail(409, `Group ${stopped} is not running`);
    if (model && !trainer.models().some((r) => r.run === model.run && r.files.includes(model.file))) {
      throw fail(400, 'Model must be a checkpoint listed by /models');
    }
    const { name, running } = await trainerRun(req.params.id);
    const training = lab.live().runs.some((r) => r.runId === req.params.id);
    if (running || training) throw fail(409, 'This run is already training');
    const names = [...new Set(groups)];
    const pid = await trainer.start({ name, groups: names, ...(model && { model: { run: model.run, file: model.file } }) });
    await pool.query('UPDATE lab_runs SET trainer = $2 WHERE id = $1', [req.params.id, JSON.stringify({ pid, groups: names })]);
    res.json({ trainer: { pid, groups: names, running: true } });
  }));

  router.get('/models', (req, res) => res.json(trainer.models()));

  async function findGroup(id) {
    const found = await pool.query('SELECT id, name, config, sessions FROM lab_groups WHERE id = $1', [id]);
    if (!found.rowCount) throw fail(404, 'Group not found');
    return found.rows[0];
  }

  router.get('/groups', route(async (req, res) => {
    const result = await pool.query('SELECT id, name, config, sessions, created_at FROM lab_groups ORDER BY created_at');
    res.json({
      limits: LIMITS,
      defaults: DEFAULTS,
      groups: result.rows.map((group) => ({ ...group, running: worlds.running(group.id), worlds: worlds.state(group.id) })),
    });
  }));

  router.post('/groups', route(async (req, res) => {
    const { name, config, sessions } = req.body ?? {};
    if (typeof name !== 'string' || !GROUP_NAME.test(name)) throw fail(400, `Group name must match ${GROUP_NAME}`);
    const values = { ...DEFAULTS, ...config };
    const invalid = configError(values, {}) || sessionsError(sessions);
    if (invalid) throw fail(400, invalid);
    const created = await pool.query(
      'INSERT INTO lab_groups(id, name, config, sessions) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING RETURNING id',
      [randomUUID(), name, JSON.stringify(values), sessions],
    );
    if (!created.rowCount) throw fail(409, 'A group with that name already exists');
    res.status(201).json({ id: created.rows[0].id });
  }));

  // Parameters reach running worlds at once; processes only change while the group is stopped,
  // because trainers read the group's layout when they start.
  router.patch('/groups/:id', route(async (req, res) => {
    const { config, sessions } = req.body ?? {};
    const group = await findGroup(req.params.id);
    const invalid = (config === undefined && sessions === undefined && 'Nothing to change')
      || (config !== undefined && configError(config, group.config))
      || (sessions !== undefined && sessionsError(sessions));
    if (invalid) throw fail(400, invalid);
    if (sessions !== undefined && worlds.running(group.id)) throw fail(409, 'Stop the group to change its processes');
    const result = await pool.query(
      `UPDATE lab_groups SET config = config || $2::jsonb, sessions = COALESCE($3::integer[], sessions) WHERE id = $1
       RETURNING id, name, config, sessions`,
      [group.id, JSON.stringify(config ?? {}), sessions ?? null],
    );
    if (config !== undefined && worlds.running(group.id)) worlds.setConfig(group.id, config);
    res.json(result.rows[0]);
  }));

  router.post('/groups/:id/start', route(async (req, res) => {
    const group = await findGroup(req.params.id);
    if (worlds.running(group.id)) throw fail(409, 'The group is already running');
    await pool.query('UPDATE lab_groups SET running = true WHERE id = $1', [group.id]);
    worlds.start(group);
    res.status(204).end();
  }));

  router.post('/groups/:id/stop', route(async (req, res) => {
    const group = await findGroup(req.params.id);
    if (!worlds.running(group.id)) throw fail(409, 'The group is not running');
    if (worlds.state(group.id).some((world) => world.agents)) throw fail(409, 'Stop the trainers first: their sessions would lose the worlds');
    await pool.query('UPDATE lab_groups SET running = false WHERE id = $1', [group.id]);
    worlds.stop(group.id);
    res.status(204).end();
  }));

  router.delete('/groups/:id', route(async (req, res) => {
    if (worlds.running(req.params.id)) throw fail(409, 'Stop the group first');
    const result = await pool.query('DELETE FROM lab_groups WHERE id = $1', [req.params.id]);
    if (!result.rowCount) throw fail(404, 'Group not found');
    res.status(204).end();
  }));

  router.post('/runs/:id/stop', route(async (req, res) => {
    const { started, running } = await trainerRun(req.params.id);
    if (!running) throw fail(409, 'No trainer started from the panel is running for this run');
    trainer.stop(started.pid);
    res.status(204).end();
  }));

  router.post('/runs', route(async (req, res) => {
    const { name, key_id: keyId, values = {} } = req.body ?? {};
    if (typeof name !== 'string' || !RUN_NAME.test(name)) throw fail(400, `Run name must match ${RUN_NAME}`);
    const invalid = parametersError(values);
    if (invalid) throw fail(400, invalid);
    const key = await pool.query('SELECT 1 FROM lab_keys WHERE id = $1 AND revoked_at IS NULL', [keyId]);
    if (!key.rowCount) throw fail(404, 'Key not found or revoked');
    const created = await pool.query(
      `INSERT INTO lab_runs(id, key_id, name, config_pending) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key_id, name) DO NOTHING RETURNING id`,
      [randomUUID(), keyId, name, Object.keys(values).length ? JSON.stringify(values) : null],
    );
    if (!created.rowCount) throw fail(409, 'This key already has a run with that name');
    res.status(201).json({ id: created.rows[0].id });
  }));

  router.get('/runs/:id/progress', route(async (req, res) => {
    const result = await pool.query(
      `SELECT recorded_at, episodes, score_avg, score_max, ticks_avg, eaten_avg, boost_avg, deaths, metrics
       FROM lab_progress WHERE run_id = $1 ORDER BY recorded_at`,
      [req.params.id],
    );
    res.json(mergeWindows(result.rows, flushMinutes * 60_000));
  }));

  router.put('/runs/:id/config', route(async (req, res) => {
    const values = req.body?.values;
    const invalid = parametersError(values);
    if (invalid) throw fail(400, invalid);
    const found = await pool.query('SELECT config, config_pending FROM lab_runs WHERE id = $1', [req.params.id]);
    if (!found.rowCount) throw fail(404, 'Run not found');
    const { config, config_pending: queued } = found.rows[0];
    const known = config ?? queued;
    if (!known) throw fail(409, 'This run has not reported its parameters yet');
    const unknown = Object.keys(values).find((name) => !(name in known));
    if (unknown) throw fail(400, `Unknown parameter ${unknown}`);
    const changed = config
      ? Object.entries(values).filter(([name, value]) => value !== config[name])
      : Object.entries({ ...queued, ...values });
    const pending = changed.length ? Object.fromEntries(changed) : null;
    await pool.query('UPDATE lab_runs SET config_pending = $2 WHERE id = $1', [req.params.id, pending && JSON.stringify(pending)]);
    res.json({ config_pending: pending });
  }));

  router.get('/runs/:id/logs', route(async (req, res) => {
    const after = /^\d+$/.test(req.query.after ?? '') ? req.query.after : null;
    const result = await pool.query(
      `SELECT id, at, line FROM (
         SELECT id, at, line FROM lab_logs WHERE run_id = $1 AND ($2::bigint IS NULL OR id > $2)
         ORDER BY id DESC LIMIT $3) latest
       ORDER BY id`,
      [req.params.id, after, LOG_LINES],
    );
    res.json(result.rows);
  }));

  router.get('/live', (req, res) => res.json(lab.live()));

  router.use((error, req, res, next) => {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '22P02') return res.status(400).json({ error: 'Invalid ID' });
    console.error('Lab API:', error.message);
    res.status(503).json({ error: 'Lab database unavailable' });
  });

  return router;
}
