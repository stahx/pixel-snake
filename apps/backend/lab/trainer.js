import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const LAB_DIR = fileURLToPath(new URL('../../lab', import.meta.url));
const run = promisify(execFile);

const MODEL = /^(latest|update-(\d+))\.pt$/;
const updateOf = (file) => Number(file.match(MODEL)[2] ?? Infinity);

export const PORTS = /^\d{2,5}(-\d{2,5})?(,\d{2,5}(-\d{2,5})?)*$/;

export function createTrainer({ labDir = LAB_DIR, python = process.env.LAB_PYTHON || join(labDir, '.venv/bin/python') } = {}) {
  return {
    available: existsSync(python),

    // The shell backgrounds the trainer and exits, so the trainer is reparented away from this server:
    // nodemon kills the whole process tree on restart, and training must outlive it. Without job control (set -m)
    // a background job starts with SIGINT ignored and could not be stopped like Ctrl+C; with it, the job leads its own group.
    models() {
      const folder = join(labDir, 'py/checkpoints');
      if (!existsSync(folder)) return [];
      return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .map(({ name }) => ({ run: name, files: readdirSync(join(folder, name)).filter((file) => MODEL.test(file))
          .sort((a, b) => updateOf(b) - updateOf(a)) }))
        .filter((run) => run.files.length);
    },

    async start({ name, rooms, model }) {
      const folder = join(labDir, 'py/checkpoints', name);
      mkdirSync(folder, { recursive: true });
      // One count for every group keeps the plain form that trainers copied into older runs understand.
      const sizes = new Set(rooms.map((room) => room.sessions));
      const ports = sizes.size === 1
        ? ['--ports', rooms.map((room) => room.ports).join(','), '--sessions', String(rooms[0].sessions)]
        : ['--ports', rooms.map((room) => `${room.ports}:${room.sessions}`).join(',')];
      const shell = spawn(
        '/bin/sh',
        ['-c', 'set -m; "$@" >"$0" 2>&1 </dev/null & echo $!', join(folder, 'trainer.log'),
          python, 'py/ppo_agent.py', ...ports, '--run', name,
          ...(model ? ['--model', join('py/checkpoints', model.run, model.file)] : [])],
        { cwd: labDir, detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let output = '';
      shell.stdout.on('data', (chunk) => { output += chunk; });
      await new Promise((resolve, reject) => shell.on('error', reject).on('close', resolve));
      return Number(output);
    },

    async running(pid, name) {
      try {
        const command = (await run('ps', ['-o', 'command=', '-p', String(pid)])).stdout.trimEnd();
        return command.endsWith(` --run ${name}`) || command.includes(` --run ${name} --model `);
      } catch {
        return false;
      }
    },

    stop: (pid) => process.kill(-pid, 'SIGINT'),
  };
}
