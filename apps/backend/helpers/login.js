import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const digest = (value) => createHash('sha256').update(value).digest();

export function passwordLogin(router, { password, cookie }) {
  const sessions = new Map();
  const failures = new Map();
  const sessionToken = (req) => req.headers.cookie?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === cookie)?.[1];

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
    res.setHeader('Set-Cookie', `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=${req.baseUrl}; Max-Age=${SESSION_MS / 1000}${secure}`);
    res.status(204).end();
  });

  router.post('/logout', (req, res) => {
    sessions.delete(sessionToken(req));
    res.setHeader('Set-Cookie', `${cookie}=; HttpOnly; SameSite=Strict; Path=${req.baseUrl}; Max-Age=0`);
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
}
