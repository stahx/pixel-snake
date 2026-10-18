import { createHash, randomBytes } from 'node:crypto';

export const createKey = () => `psl_${randomBytes(24).toString('base64url')}`;

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');
