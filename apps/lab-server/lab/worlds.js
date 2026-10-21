import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { numbersError } from './agents.js';
import { worldToken } from './keys.js';

const WORLD = fileURLToPath(new URL('./world.js', import.meta.url));
const RESTART_MS = 1000;

const finite = (...values) => values.every(Number.isFinite);
const MESSAGES = {
  listening: ({ port }) => Number.isInteger(port),
  state: ({ tps, stepMs, agents }) => finite(tps, stepMs) && Array.isArray(agents)
    && agents.every((agent) => typeof agent?.id === 'string' && typeof agent.runId === 'string' && finite(agent.score, agent.ticks)),
  episode: ({ runId, episode }) => typeof runId === 'string' && typeof episode?.cause === 'string'
    && finite(episode.maxScore, episode.ticks, episode.eaten, episode.boostSpent),
  log: ({ runId, values }) => typeof runId === 'string' && !numbersError(values),
};

export function createWorlds({ file = WORLD, restartMs = RESTART_MS } = {}) {
  const groups = new Map();
  const worlds = new EventEmitter();
  const label = (world) => `${world.group.name} #${world.index + 1}`;

  function spawn(group, index) {
    const world = { group, index, secret: randomBytes(32).toString('base64url'), port: null, state: null };
    world.child = fork(file);
    group.worlds[index] = world;
    world.child.send({ type: 'start', config: group.config, secret: world.secret });
    world.child.on('error', (error) => console.error(`Lab: world ${label(world)}:`, error.message));
    world.child.on('message', (message) => {
      if (!MESSAGES[message?.type]?.(message)) return console.error(`Lab: world ${label(world)} sent an invalid message`);
      if (message.type === 'listening') world.port = message.port;
      if (message.type === 'state') world.state = message;
      worlds.emit('message', world, message);
    });
    world.child.on('exit', (code, signal) => {
      world.port = null;
      world.state = null;
      worlds.emit('exit', world);
      if (groups.get(group.id) !== group) return;
      console.error(`Lab: world ${label(world)} exited with ${signal ?? `code ${code}`}, restarting`);
      setTimeout(() => groups.get(group.id) === group && spawn(group, index), restartMs);
    });
  }

  const sendTo = (list, message) => list.forEach((world) => world.child.connected && world.child.send(message));
  const byName = (name) => [...groups.values()].find((running) => running.name === name);
  const stop = (id) => {
    groups.get(id)?.worlds.forEach((world) => world.child.kill());
    groups.delete(id);
  };

  return Object.assign(worlds, {
    start({ id, name, config, sessions }) {
      if (groups.has(id)) return;
      const started = { id, name, config: { ...config }, sessions, worlds: [] };
      groups.set(id, started);
      sessions.forEach((_, index) => spawn(started, index));
    },
    stop,
    close: () => [...groups.keys()].forEach(stop),
    running: (id) => groups.has(id),
    group: byName,
    setConfig(id, values) {
      const running = groups.get(id);
      Object.assign(running.config, values);
      sendTo(running.worlds, { type: 'config', values });
    },
    send: (message) => sendTo(worlds.all(), message),
    all: () => [...groups.values()].flatMap((running) => running.worlds),
    resolve: (name, runId) => byName(name)?.worlds.map((world, index) => ({
      url: world.port && `http://127.0.0.1:${world.port}`,
      token: world.port && worldToken(world.secret, runId),
      sessions: world.group.sessions[index],
    })),
    state: (id) => (groups.get(id)?.worlds ?? []).map((world) => ({
      pid: world.child.pid,
      port: world.port,
      tps: world.state?.tps ?? null,
      stepMs: world.state?.stepMs ?? null,
      agents: world.state?.agents.length ?? 0,
    })),
  });
}
