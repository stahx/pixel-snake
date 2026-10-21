import express from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { RUN_NAME, numbersError } from './agents.js';
import { createKey, findKey, hashKey } from './keys.js';
import { mergeWindows } from './progress.js';
import { createRooms } from './rooms.js';
import { PORTS, createTrainer } from './trainer.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const COOKIE = 'lab_session';
const LOG_LINES = 2000;
const LOG_BATCH = 1000;
const LOG_LINE_LENGTH = 1000;

const digest = (value) => createHash('sha256').update(value).digest();
const fail = (status, message) => Object.assign(new Error(message), { status });
const parametersError = (values) => (values && typeof values === 'object' && !Array.isArray(values) && !Object.keys(values).length
  ? null
  : numbersError(values, 'Parameters'));
const route = (handler) => (req, res, next) => handler(req, res).catch(next);
const sessionToken = (req) => req.headers.cookie?.split(';')
  .map((part) => part.trim().split('='))
  .find(([name]) => name === COOKIE)?.[1];

export function labRouter({ pool, lab, password, flushMinutes, trainer = createTrainer(), roomServers = createRooms() }) {
  const router = express.Router();
  const sessions = new Map();
  const failures = new Map();

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

  router.use((req, res, next) => {
    if (!password) return res.status(503).json({ error: 'Lab panel is disabled: set LAB_ADMIN_PASSWORD' });
    if (!pool) return res.status(503).json({ error: 'Lab panel is disabled: set DATABASE_URL and run pnpm db:migrate' });
    next();
  });

  router.post('/login', (req, res) => {
    const now = Date.now();
    const record = failures.get(req.ip);
    if (record?.until > now) return res.status(429).json({ error: 'Too many failed attempts, try again later' });
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!timingSafeEqual(digest(given), digest(password))) {
      const count = (record?.until ? 0 : record?.count || 0) + 1;
      failures.set(req.ip, count >= MAX_FAILURES ? { count, until: now + LOCKOUT_MS } : { count });
      return res.status(401).json({ error: 'Wrong password' });
    }
    failures.delete(req.ip);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + SESSION_MS);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/lab; Max-Age=${SESSION_MS / 1000}${secure}`);
    res.status(204).end();
  });

  router.post('/logout', (req, res) => {
    sessions.delete(sessionToken(req));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/lab; Max-Age=0`);
    res.status(204).end();
  });

  router.use((req, res, next) => {
    const token = sessionToken(req);
    if (!(sessions.get(token) > Date.now())) {
      sessions.delete(token);
      return res.status(401).json({ error: 'Log in first' });
    }
    next();
  });

  router.get('/session', (req, res) => res.status(204).end());

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
    lab.disconnectKey(req.params.id);
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
    const { rooms, model } = req.body ?? {};
    if (!Array.isArray(rooms) || !rooms.length || rooms.length > 20) throw fail(400, 'Rooms must be a list of 1-20 port groups');
    for (const { ports, sessions } of rooms) {
      if (typeof ports !== 'string' || !PORTS.test(ports)) throw fail(400, 'Ports look like 3031-3046 or 3030,3035');
      if (!Number.isInteger(sessions) || sessions < 1 || sessions > 32) throw fail(400, 'Sessions must be a whole number 1-32');
    }
    if (model && !trainer.models().some((r) => r.run === model.run && r.files.includes(model.file))) {
      throw fail(400, 'Model must be a checkpoint listed by /models');
    }
    const { name, running } = await trainerRun(req.params.id);
    const training = (await lab.live()).runs.some((r) => r.runId === req.params.id);
    if (running || training) throw fail(409, 'This run is already training');
    const groups = rooms.map(({ ports, sessions }) => ({ ports, sessions }));
    const pid = await trainer.start({ name, rooms: groups, ...(model && { model: { run: model.run, file: model.file } }) });
    await pool.query('UPDATE lab_runs SET trainer = $2 WHERE id = $1', [req.params.id, JSON.stringify({ pid, rooms: groups })]);
    res.json({ trainer: { pid, rooms: groups, running: true } });
  }));

  router.get('/models', (req, res) => res.json(trainer.models()));

  router.get('/rooms', route(async (req, res) => {
    res.json({ firstPort: roomServers.firstPort, running: await roomServers.list() });
  }));

  router.post('/rooms/start', route(async (req, res) => {
    const { count, timescale } = req.body ?? {};
    if (!Number.isInteger(count) || count < 1 || count > 40) throw fail(400, 'Rooms must be a whole number 1-40');
    if (typeof timescale !== 'number' || !(timescale >= 0.25 && timescale <= 4)) throw fail(400, 'Timescale must be 0.25-4');
    if ((await roomServers.list()).length) throw fail(409, 'Training rooms are already running');
    const taken = await roomServers.taken(count);
    if (taken) throw fail(409, `Port ${taken} is already in use`);
    res.status(201).json({ pid: await roomServers.start({ count, timescale }), count, timescale });
  }));

  router.post('/rooms/stop', route(async (req, res) => {
    const running = await roomServers.list();
    if (!running.length) throw fail(409, 'No training rooms are running');
    if ((await lab.live()).runs.length) throw fail(409, 'Stop the trainers first: their sessions would lose the rooms');
    for (const { group } of running) roomServers.stop(group);
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

  router.get('/live', route(async (req, res) => res.json(await lab.live())));

  router.use((error, req, res, next) => {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '22P02') return res.status(400).json({ error: 'Invalid ID' });
    console.error('Lab API:', error.message);
    res.status(503).json({ error: 'Lab database unavailable' });
  });

  return router;
}
