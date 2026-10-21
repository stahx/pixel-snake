import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as tf from '@tensorflow/tfjs';

import { Game, parsePorts } from './pixel-snake-lab.js';

const TURNS = [-0.32, -0.16, -0.05, 0, 0.05, 0.16, 0.32];
const LEGACY_TURNS = [-0.5, 0, 0.5];
const TICKS_PER_ACTION = 4;
const DEATH_PENALTY = -50;
const KILL_REWARD = 30;
const KILL_SHARE = 0.5;
// Returns in the hundreds would make the value loss drown the policy gradient in the shared body.
const REWARD_SCALE = 0.01;

export const FOOD_SLOTS = 3;
export const DANGER_SECTORS = 8;
export const VIEW_DISTANCE = 500;
const FEATURE_COUNT = FOOD_SLOTS * 3 + DANGER_SECTORS + 2;
const HIDDEN_SIZE = 64;

const SEGMENT_STEPS = 128;
const BATCH_STEPS = 4096;
const EPOCHS = 4;
const MINIBATCH_SIZE = 512;
const GAMMA = 0.99;
const GAE_LAMBDA = 0.95;
const CLIP_RANGE = 0.2;
const VALUE_COEF = 0.5;
const ENTROPY_COEF = 0.01;
const LEARNING_RATE = 3e-4;
const MAX_GRAD_NORM = 0.5;
const CHECKPOINT_EVERY = 10;

const CHECKPOINTS = new URL('checkpoints/', import.meta.url);

const dense = (inputs, outputs, name) => ({
  weights: tf.variable(tf.randomNormal([inputs, outputs], 0, Math.sqrt(1 / inputs)), true, `${name}/weights`),
  bias: tf.variable(tf.zeros([outputs]), true, `${name}/bias`),
});

export function createActorCritic(turns = TURNS) {
  const actions = turns.flatMap((turn) => [[turn, false], [turn, true]]);
  return {
    turns,
    actions,
    layers: {
      hidden1: dense(FEATURE_COUNT, HIDDEN_SIZE, 'hidden1'),
      hidden2: dense(HIDDEN_SIZE, HIDDEN_SIZE, 'hidden2'),
      policy: dense(HIDDEN_SIZE, actions.length, 'policy'),
      value: dense(HIDDEN_SIZE, 1, 'value'),
    },
  };
}

const layer = (input, { weights, bias }) => input.matMul(weights).add(bias);
const variablesOf = (net) => Object.values(net.layers).flatMap(({ weights, bias }) => [weights, bias]);

function forward({ layers }, states) {
  const hidden = layer(layer(states, layers.hidden1).tanh(), layers.hidden2).tanh();
  return { logits: layer(hidden, layers.policy), values: layer(hidden, layers.value).squeeze([1]) };
}

const wrapped = (delta, size) => ((delta + size / 2) % size + size) % size - size / 2;

export function features(observation, info) {
  const { me } = observation;
  const { width, height } = info.map;
  const headX = me.x + me.size / 2;
  const headY = me.y + me.size / 2;
  const cos = Math.cos(me.angle);
  const sin = Math.sin(me.angle);

  const relative = (entity) => {
    const dx = wrapped(entity.x - headX, width);
    const dy = wrapped(entity.y - headY, height);
    const forwardDistance = dx * cos + dy * sin;
    const side = -dx * sin + dy * cos;
    return { forward: forwardDistance, side, distance: Math.hypot(forwardDistance, side) };
  };

  const entities = [...observation.entities.values()];
  const food = entities.filter((entity) => entity.type === 'point').map(relative).sort((a, b) => a.distance - b.distance);
  const foodFeatures = Array.from({ length: FOOD_SLOTS }, (_, slot) => (food[slot]
    ? [food[slot].forward / VIEW_DISTANCE, food[slot].side / VIEW_DISTANCE, 1]
    : [0, 0, 0])).flat();

  const danger = new Array(DANGER_SECTORS).fill(0);
  for (const entity of entities) {
    if (entity.type === 'point' || entity.player === me.player) continue;
    const { forward: forwardDistance, side, distance } = relative(entity);
    const sector = Math.floor((Math.atan2(side, forwardDistance) + Math.PI) / (2 * Math.PI) * DANGER_SECTORS) % DANGER_SECTORS;
    danger[sector] = Math.max(danger[sector], 1 - distance / VIEW_DISTANCE);
  }

  const own = [Math.log1p(me.points) / 5, me.boosting ? 1 : 0];
  return [...foodFeatures, ...danger, ...own].map((value) => Math.min(5, Math.max(-5, value)));
}

export const rewardFor = (observation, nextObservation) => KILL_REWARD * (nextObservation.kills - observation.kills)
  + KILL_SHARE * (nextObservation.killPoints - observation.killPoints)
  + (nextObservation.alive ? nextObservation.me.points - observation.me.points : DEATH_PENALTY - observation.me.points);

export function advantages(rewards, values, dones, lastValue) {
  const advantage = new Array(rewards.length);
  let running = 0;
  for (let step = rewards.length - 1; step >= 0; step--) {
    const nextValue = step === rewards.length - 1 ? lastValue : values[step + 1];
    const alive = 1 - dones[step];
    const delta = rewards[step] + GAMMA * nextValue * alive - values[step];
    running = delta + GAMMA * GAE_LAMBDA * alive * running;
    advantage[step] = running;
  }
  return { advantage, returns: advantage.map((value, step) => value + values[step]) };
}

function act(net, state) {
  return tf.tidy(() => {
    const { logits, values } = forward(net, tf.tensor2d([state]));
    const action = tf.multinomial(logits, 1).dataSync()[0];
    const logProb = tf.logSoftmax(logits).dataSync()[action];
    return { action, logProb, value: values.dataSync()[0] };
  });
}

function shuffled(count) {
  const indices = Array.from({ length: count }, (_, index) => index);
  for (let index = count - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [indices[index], indices[other]] = [indices[other], indices[index]];
  }
  return indices;
}

function ppoLoss(net, batch) {
  const { logits, values } = forward(net, batch.states);
  const logProbsAll = tf.logSoftmax(logits);
  const logProbs = logProbsAll.mul(tf.oneHot(batch.actions, net.actions.length)).sum(1);
  const ratio = logProbs.sub(batch.logProbs).exp();
  const policyLoss = tf.minimum(
    ratio.mul(batch.advantages),
    ratio.clipByValue(1 - CLIP_RANGE, 1 + CLIP_RANGE).mul(batch.advantages),
  ).mean().neg();
  const valueLoss = batch.returns.sub(values).square().mean();
  const entropy = logProbsAll.exp().mul(logProbsAll).sum(1).mean().neg();
  const loss = policyLoss.add(valueLoss.mul(VALUE_COEF)).sub(entropy.mul(ENTROPY_COEF));
  return { loss, policyLoss, valueLoss, entropy };
}

function trainStep(net, optimizer, batch) {
  return tf.tidy(() => {
    let parts;
    const { grads } = tf.variableGrads(() => {
      parts = ppoLoss(net, batch);
      [parts.policyLoss, parts.valueLoss, parts.entropy].forEach((tensor) => tf.keep(tensor));
      return parts.loss;
    }, variablesOf(net));
    const norm = Math.sqrt(Object.values(grads).reduce((sum, grad) => sum + grad.square().sum().dataSync()[0], 0));
    const scale = Math.min(1, MAX_GRAD_NORM / (norm + 1e-6));
    optimizer.applyGradients(Object.fromEntries(Object.entries(grads).map(([name, grad]) => [name, grad.mul(scale)])));
    const stats = {
      'loss/policy': parts.policyLoss.dataSync()[0],
      'loss/value': parts.valueLoss.dataSync()[0],
      entropy: parts.entropy.dataSync()[0],
    };
    tf.dispose([parts.policyLoss, parts.valueLoss, parts.entropy]);
    return stats;
  });
}

function learn(net, optimizer, segments) {
  const all = {
    states: segments.flatMap((segment) => segment.states),
    actions: segments.flatMap((segment) => segment.actions),
    logProbs: segments.flatMap((segment) => segment.logProbs),
    advantages: segments.flatMap((segment) => segment.advantages),
    returns: segments.flatMap((segment) => segment.returns),
  };
  const mean = all.advantages.reduce((sum, value) => sum + value, 0) / all.advantages.length;
  const std = Math.sqrt(all.advantages.reduce((sum, value) => sum + (value - mean) ** 2, 0) / all.advantages.length);
  all.advantages = all.advantages.map((value) => (value - mean) / (std + 1e-8));

  let stats;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const order = shuffled(all.actions.length);
    for (let start = 0; start < order.length; start += MINIBATCH_SIZE) {
      const indices = order.slice(start, start + MINIBATCH_SIZE);
      const pick = (values) => indices.map((index) => values[index]);
      const batch = {
        states: tf.tensor2d(pick(all.states)),
        actions: tf.tensor1d(pick(all.actions), 'int32'),
        logProbs: tf.tensor1d(pick(all.logProbs)),
        advantages: tf.tensor1d(pick(all.advantages)),
        returns: tf.tensor1d(pick(all.returns)),
      };
      stats = trainStep(net, optimizer, batch);
      tf.dispose(Object.values(batch));
    }
  }
  return { ...stats, steps: all.actions.length };
}

async function save(net, optimizer, update, folder) {
  mkdirSync(folder, { recursive: true });
  const tensorsToJson = async (named) => Object.fromEntries(await Promise.all(
    named.map(async ({ name, tensor }) => [name, { shape: tensor.shape, data: Array.from(await tensor.data()) }]),
  ));
  const checkpoint = JSON.stringify({
    update,
    turns: net.turns,
    model: await tensorsToJson(variablesOf(net).map((variable) => ({ name: variable.name, tensor: variable }))),
    optimizer: await tensorsToJson(await optimizer.getWeights()),
  });
  writeFileSync(new URL(`update-${update}.json`, folder), checkpoint);
  writeFileSync(new URL('latest.json', folder), checkpoint);
}

async function load(net, optimizer, checkpoint) {
  for (const variable of variablesOf(net)) {
    const { shape, data } = checkpoint.model[variable.name];
    variable.assign(tf.tensor(data, shape));
  }
  await optimizer.setWeights(Object.entries(checkpoint.optimizer).map(([name, { shape, data }]) => ({
    name, tensor: tf.tensor(data, shape),
  })));
  return checkpoint.update;
}

async function playSession({ url, run, net, trainer, label }) {
  const game = await Game.connect({ url, run });
  let observation = await game.observe();
  let segment = { states: [], actions: [], logProbs: [], values: [], rewards: [], dones: [] };
  let episodeReturn = 0;
  let episodeKills = 0;
  let steps = 0;

  const send = (lastValue) => {
    const { advantage, returns } = advantages(segment.rewards, segment.values, segment.dones, lastValue);
    trainer.add({ states: segment.states, actions: segment.actions, logProbs: segment.logProbs, advantages: advantage, returns });
    segment = { states: [], actions: [], logProbs: [], values: [], rewards: [], dones: [] };
  };

  while (true) {
    if (!observation.alive) {
      await game.respawn();
      observation = await game.observe();
      continue;
    }
    const state = features(observation, game.info);
    const { action, logProb, value } = act(net, state);
    const [turn, boost] = net.actions[action];
    game.steer(observation.me.angle + turn);
    game.boost(boost && observation.me.points > 0);
    let nextObservation;
    for (let tick = 0; tick < TICKS_PER_ACTION; tick++) {
      nextObservation = await game.observe();
      if (!nextObservation.alive) break;
    }
    const reward = rewardFor(observation, nextObservation);
    const done = !nextObservation.alive;
    segment.states.push(state);
    segment.actions.push(action);
    segment.logProbs.push(logProb);
    segment.values.push(value);
    segment.rewards.push(reward * REWARD_SCALE);
    segment.dones.push(done ? 1 : 0);
    episodeReturn += reward;
    steps++;

    if (done) {
      send(0);
      game.log({ reward: episodeReturn, steps, kills: nextObservation.kills - episodeKills, ...trainer.takeStats() });
      console.log(`${label}: return ${episodeReturn.toFixed(1)}, steps ${steps}`);
      episodeReturn = 0;
      episodeKills = nextObservation.kills;
      steps = 0;
    } else if (segment.actions.length >= SEGMENT_STEPS) {
      send(act(net, features(nextObservation, game.info)).value);
    }
    observation = nextObservation;
  }
}

function createTrainer({ net, optimizer, update, folder, lastUpdate, onFinish }) {
  let segments = [];
  let collected = 0;
  let pendingStats = {};
  return {
    get update() { return update; },
    add(segment) {
      segments.push(segment);
      collected += segment.actions.length;
      if (collected < BATCH_STEPS) return;
      const stats = learn(net, optimizer, segments);
      segments = [];
      collected = 0;
      update++;
      pendingStats = { 'loss/policy': stats['loss/policy'], 'loss/value': stats['loss/value'], entropy: stats.entropy, update };
      console.log(`update ${update}: ${stats.steps} steps, policy loss ${stats['loss/policy'].toFixed(3)}, `
        + `value loss ${stats['loss/value'].toFixed(3)}, entropy ${stats.entropy.toFixed(3)}`);
      if (update === lastUpdate) onFinish();
      else if (update % CHECKPOINT_EVERY === 0) save(net, optimizer, update, folder);
    },
    takeStats() {
      const stats = pendingStats;
      pendingStats = {};
      return stats;
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: args } = parseArgs({
    options: {
      host: { type: 'string', default: 'http://127.0.0.1' },
      ports: { type: 'string', default: '3030' },
      sessions: { type: 'string', default: '1' },
      run: { type: 'string', default: 'ppo-js-1' },
      updates: { type: 'string' },
      model: { type: 'string' },
    },
  });

  const folder = new URL(`${encodeURIComponent(args.run)}/`, CHECKPOINTS);
  const model = args.model ?? new URL('latest.json', folder);
  const checkpoint = args.model || existsSync(model) ? JSON.parse(readFileSync(model, 'utf8')) : null;
  const net = createActorCritic(checkpoint ? checkpoint.turns ?? LEGACY_TURNS : TURNS);
  const optimizer = tf.train.adam(LEARNING_RATE);
  const update = checkpoint ? await load(net, optimizer, checkpoint) : 0;
  console.log(update ? `continuing ${model} from update ${update}` : `new model for run ${args.run}`);
  const finish = async () => {
    await save(net, optimizer, trainer.update, folder);
    console.log(`saved ${new URL('latest.json', folder).pathname} at update ${trainer.update}`);
    process.exit(0);
  };
  const lastUpdate = args.updates ? update + Number(args.updates) : null;
  const trainer = createTrainer({ net, optimizer, update, folder, lastUpdate, onFinish: finish });

  process.once('SIGINT', finish);

  for (const port of parsePorts(args.ports)) {
    for (let number = 0; number < Number(args.sessions); number++) {
      playSession({ url: `${args.host}:${port}`, run: args.run, net, trainer, label: `${args.host}:${port} session ${number}` })
        .catch((error) => console.error(`${port} session ${number}: ${error.message}`));
    }
  }
}
