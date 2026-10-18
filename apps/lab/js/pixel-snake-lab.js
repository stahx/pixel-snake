import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { io } from 'socket.io-client';

const NAMESPACE = '/lab';
const ENTITY_TYPES = ['point', 'tail', 'player'];
const FIELD_NAMES = {
  i: 'id', t: 'type', x: 'x', y: 'y', c: 'color', s: 'size',
  p: 'player', n: 'name', pt: 'points', a: 'angle', b: 'boosting',
};
const AIM_DISTANCE = 200;
const ENV_FILE = new URL('../.env', import.meta.url);

export function loadEnv(file = ENV_FILE) {
  if (!existsSync(file)) return;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    process.env[name] ??= value;
  }
}

export function parsePorts(ports) {
  return ports.split(',').flatMap((part) => {
    const [first, last = first] = part.split('-').map(Number);
    return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
  });
}

const renameFields = (wireEntity) => Object.fromEntries(
  Object.entries(wireEntity).map(([shortName, value]) => [FIELD_NAMES[shortName], value]),
);

export function applyUpdate(entities, update) {
  for (const wireEntity of update.a ?? []) {
    const entity = renameFields(wireEntity);
    entity.type = ENTITY_TYPES[entity.type];
    entities.set(entity.id, entity);
  }
  for (const wireChange of update.u ?? []) {
    const change = renameFields(wireChange);
    if (entities.has(change.id)) entities.set(change.id, { ...entities.get(change.id), ...change });
  }
  for (const removedId of update.r ?? []) entities.delete(removedId);
}

export class Game {
  static async connect({ url = 'http://127.0.0.1:3030', run = 'TRAINING', key } = {}) {
    loadEnv();
    const game = new Game(io(`${url}${NAMESPACE}`, {
      auth: { key: key ?? process.env.PIXEL_SNAKE_LAB_KEY, run },
      transports: ['websocket'],
      reconnection: false,
    }));
    await new Promise((resolve, reject) => {
      game.socket.once('connect', resolve);
      game.socket.once('connect_error', (error) => reject(new Error(error.message)));
    });
    await game.#waitFor(() => game.info && game.alive, 5000);
    return game;
  }

  info = null;
  entities = new Map();
  leaderboard = [];
  alive = false;
  tick = 0;
  #disconnected = false;
  #waiters = new Set();

  constructor(socket) {
    this.socket = socket;
    socket.on('env-info', (info) => {
      this.info = info;
      this.#changed();
    });
    socket.on('update', (update) => {
      applyUpdate(this.entities, update);
      if (update.l) this.leaderboard = update.l;
      this.alive = this.me !== null;
      this.tick++;
      this.#changed();
    });
    socket.on('ded', () => {
      this.alive = false;
      this.entities.clear();
      this.#changed();
    });
    socket.on('lab-error', (message) => console.warn(`lab: ${message}`));
    socket.on('disconnect', () => {
      this.#disconnected = true;
      this.alive = false;
      this.#changed();
    });
  }

  get me() {
    for (const entity of this.entities.values()) {
      if (entity.type === 'player' && entity.player === this.socket.id) return entity;
    }
    return null;
  }

  async observe(timeout = 1000) {
    const tick = this.tick;
    await this.#waitFor(() => this.tick !== tick || !this.alive, timeout);
    if (this.#disconnected) throw new Error('Disconnected from the lab server');
    return { tick: this.tick, alive: this.alive, me: this.me, entities: new Map(this.entities), leaderboard: this.leaderboard };
  }

  aim(x, y) {
    this.socket.emit('change-dir', { mouseX: x, mouseY: y });
  }

  steer(angle) {
    const me = this.me;
    if (!me) return;
    const headX = me.x + me.size / 2;
    const headY = me.y + me.size / 2;
    this.aim(headX + Math.cos(angle) * AIM_DISTANCE, headY + Math.sin(angle) * AIM_DISTANCE);
  }

  boost(on) {
    this.socket.emit('player-speed', on);
  }

  async respawn() {
    this.socket.emit('player-join', {});
    await this.#waitFor(() => this.alive, 5000);
  }

  log(metrics) {
    this.socket.emit('log', metrics);
  }

  close() {
    this.socket.disconnect();
  }

  #changed() {
    for (const waiter of this.#waiters) waiter();
  }

  #waitFor(condition, timeout) {
    if (condition() || this.#disconnected) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (!condition() && !this.#disconnected) return;
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(done);
        resolve();
      }, timeout);
      this.#waiters.add(done);
    });
  }
}
