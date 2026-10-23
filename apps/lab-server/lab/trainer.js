import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const LAB_DIR = fileURLToPath(new URL('../../lab', import.meta.url));
const run = promisify(execFile);

const MODEL = /^(latest|update-(\d+))\.pt$/;
const updateOf = (file) => Number(file.match(MODEL)[2] ?? Infinity);

export function createTrainer({ labUrl, labDir = LAB_DIR, python = process.env.LAB_PYTHON || join(labDir, '.venv/bin/python') }) {
  return {
    available: existsSync(python),

    models() {
      const folder = join(labDir, 'py/checkpoints');
      if (!existsSync(folder)) return [];
      return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .map(({ name }) => ({ run: name, files: readdirSync(join(folder, name)).filter((file) => MODEL.test(file))
          .sort((a, b) => updateOf(b) - updateOf(a)) }))
        .filter((run) => run.files.length);
    },

    // The shell backgrounds the trainer and exits, so the trainer is reparented away from this server:
    // Ctrl+C on the lab signals its whole process group, and training must outlive a lab restart. Without job control (set -m)
    // a background job starts with SIGINT ignored and could not be stopped like Ctrl+C; with it, the job leads its own group.
    async start({ name, groups, model }) {
      const folder = join(labDir, 'py/checkpoints', name);
      mkdirSync(folder, { recursive: true });
      const shell = spawn(
        '/bin/sh',
        ['-c', 'set -m; "$@" >"$0" 2>&1 </dev/null & echo $!', join(folder, 'trainer.log'),
          python, 'py/ppo_agent.py', '--groups', groups.join(','), '--run', name,
          ...(model ? ['--model', join('py/checkpoints', model.run, model.file)] : [])],
        { cwd: labDir, detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PIXEL_SNAKE_LAB_URL: labUrl } },
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

    // Unlike trainers, opponents are the lab's own children: they stop with it, and running groups start them again.
    play({ model, run: name, group, world, sessions }) {
      const log = openSync(join(labDir, 'py/checkpoints', model.run, 'play.log'), 'a');
      const child = spawn(
        python,
        ['py/play.py', '--model', join('py/checkpoints', model.run, model.file), '--groups', group,
          '--world', String(world + 1), '--sessions', String(sessions), '--run', name],
        { cwd: labDir, stdio: ['ignore', log, log], env: { ...process.env, PIXEL_SNAKE_LAB_URL: labUrl } },
      );
      closeSync(log);
      return child;
    },
  };
}
