import express from 'express';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { createKey, hashKey } from './keys.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const COOKIE = 'lab_session';

const digest = (value) => createHash('sha256').update(value).digest();
const fail = (status, message) => Object.assign(new Error(message), { status });
const route = (handler) => (req, res, next) => handler(req, res).catch(next);
const sessionToken = (req) => req.headers.cookie?.split(';')
  .map((part) => part.trim().split('='))
  .find(([name]) => name === COOKIE)?.[1];

export function labRouter({ pool, lab, password }) {
  const router = express.Router();
  const sessions = new Map();
  const failures = new Map();

  router.use(express.json({ limit: '10kb' }));
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
      `SELECT r.id, r.name, k.name AS key_name, r.created_at, r.last_seen_at,
        COALESCE(sum(p.episodes), 0)::int AS episodes, max(p.score_max) AS best_score
       FROM lab_runs r
       JOIN lab_keys k ON k.id = r.key_id
       LEFT JOIN lab_progress p ON p.run_id = r.id
       GROUP BY r.id, k.name
       ORDER BY r.last_seen_at DESC`,
    );
    res.json(result.rows);
  }));

  router.get('/runs/:id/progress', route(async (req, res) => {
    const result = await pool.query(
      `SELECT recorded_at, episodes, score_avg, score_max, ticks_avg, eaten_avg, boost_avg, deaths, metrics
       FROM lab_progress WHERE run_id = $1 ORDER BY recorded_at`,
      [req.params.id],
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
