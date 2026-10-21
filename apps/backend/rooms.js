import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const count = Number(process.argv[2]) || 4;
const timescale = process.argv[3];
const firstPort = Number(process.env.LAB_FIRST_ROOM_PORT) || 3031;
const server = fileURLToPath(new URL('index.js', import.meta.url));

for (let room = 0; room < count; room++) {
  fork(server, { env: { ...process.env, PORT: firstPort + room, ...(timescale && { TIMESCALE: timescale }) } });
}
