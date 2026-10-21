import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const BACKEND_DIR = fileURLToPath(new URL('..', import.meta.url));
const ROOMS = /^\s*(\d+)\s+(\d+)\s+\S*node rooms\.js (\d+)(?: (\S+))?$/;
const run = promisify(execFile);

const listening = (port) => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1')
    .on('connect', () => { socket.destroy(); resolve(true); })
    .on('error', () => resolve(false));
});

export function createRooms({ backendDir = BACKEND_DIR, firstPort = Number(process.env.LAB_FIRST_ROOM_PORT) || 3031 } = {}) {
  return {
    firstPort,

    async list() {
      const { stdout } = await run('ps', ['-axo', 'pid=,pgid=,command=']);
      return stdout.split('\n').map((line) => line.match(ROOMS)).filter(Boolean)
        .map(([, pid, group, count, timescale]) => ({
          pid: Number(pid), group: Number(group), count: Number(count), timescale: timescale ? Number(timescale) : null,
        }));
    },

    async taken(count) {
      for (let port = firstPort; port < firstPort + count; port++) {
        if (await listening(port)) return port;
      }
      return null;
    },

    // Detached like the trainer, so the rooms outlive a restart of this server.
    async start({ count, timescale }) {
      const shell = spawn(
        '/bin/sh',
        ['-c', 'set -m; "$@" >"$0" 2>&1 </dev/null & echo $!', join(backendDir, 'rooms.log'),
          process.execPath, 'rooms.js', String(count), String(timescale)],
        { cwd: backendDir, detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, LAB_FIRST_ROOM_PORT: String(firstPort) } },
      );
      let output = '';
      shell.stdout.on('data', (chunk) => { output += chunk; });
      await new Promise((resolve, reject) => shell.on('error', reject).on('close', resolve));
      return Number(output);
    },

    stop: (group) => process.kill(-group, 'SIGINT'),
  };
}
