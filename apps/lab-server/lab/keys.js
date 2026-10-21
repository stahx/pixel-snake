import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const createKey = () => `psl_${randomBytes(24).toString('base64url')}`;

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export const worldToken = (secret, runId) => `${runId}.${createHmac('sha256', secret).update(runId).digest('base64url')}`;

export function verifyToken(secret, token) {
  if (typeof token !== 'string') return null;
  const runId = token.split('.')[0];
  const given = Buffer.from(token);
  const expected = Buffer.from(worldToken(secret, runId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? runId : null;
}

export async function findKey(pool, key) {
  const found = await pool.query(
    'UPDATE lab_keys SET last_used_at = now() WHERE hash = $1 AND revoked_at IS NULL RETURNING id',
    [hashKey(key)],
  );
  return found.rows[0]?.id;
}
