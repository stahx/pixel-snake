import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';

import { pool } from './db/pool.js';
import { attachLab } from './lab/agents.js';
import { labRouter } from './lab/router.js';
import { createTrainer } from './lab/trainer.js';
import { createWorlds } from './lab/worlds.js';

const port = Number(process.env.LAB_PORT) || 3100;
const flushMinutes = Number(process.env.LAB_FLUSH_MINUTES) || 5;
const labUrl = `http://127.0.0.1:${port}`;

const worlds = createWorlds();
const lab = attachLab({ worlds, pool, flushMinutes });
const trainer = createTrainer({ labUrl });

const app = express();
app.use(express.static(fileURLToPath(new URL('dist', import.meta.url))));
app.use('/api/lab', labRouter({ pool, lab, worlds, password: process.env.LAB_ADMIN_PASSWORD, flushMinutes, trainer }));
app.listen(port, '127.0.0.1', () => console.log(`lab listening at ${labUrl}`));

if (pool) {
  const running = await pool.query('SELECT id, name, config, sessions FROM lab_groups WHERE running ORDER BY created_at');
  running.rows.forEach((group) => worlds.start(group));
}

async function shutdown() {
  worlds.close();
  await lab.flushAll();
  process.exit();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
