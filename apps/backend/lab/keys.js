import { createHash, randomBytes } from 'node:crypto';

export const createKey = () => `psl_${randomBytes(24).toString('base64url')}`;

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export async function findKey(pool, key) {
  const found = await pool.query(
    'UPDATE lab_keys SET last_used_at = now() WHERE hash = $1 AND revoked_at IS NULL RETURNING id',
    [hashKey(key)],
  );
  return found.rows[0]?.id;
}
