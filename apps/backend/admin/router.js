import express from 'express';

import { passwordLogin } from '../helpers/login.js';

const MAX_POINTS = 5000;
const LIMITS = {
  TIMESCALE: [0.25, 4],
  BOTS: [0, 100, true],
  POINTS_AMOUNT: [0, 5000, true],
  FOG_RADIUS_MIN: [100, 4000],
  FOG_RADIUS_MAX: [100, 4000],
  NORMAL_SPEED: [0.1, 10],
  BOOST_SPEED: [0.1, 10],
};

const fail = (status, message) => Object.assign(new Error(message), { status });
const checkRange = (name, value, min, max, integer = false) => {
  if (!(typeof value === 'number' && value >= min && value <= max && (!integer || Number.isInteger(value)))) {
    throw fail(400, `${name} must be ${integer ? 'a whole number' : 'a number'} ${min}-${max}`);
  }
};

export function adminRouter({ game, password }) {
  const router = express.Router();

  router.use(express.json({ limit: '10kb' }));

  router.use((req, res, next) => {
    if (!password) return res.status(503).json({ error: 'Admin panel is disabled: set ADMIN_PASSWORD' });
    next();
  });

  passwordLogin(router, { password, cookie: 'admin_session' });

  router.param('id', (req, res, next, id) => {
    if (!game.players.has(id)) throw fail(404, 'Player not found');
    next();
  });

  router.get('/state', (req, res) => res.json(game.adminState()));

  router.patch('/config', (req, res) => {
    const values = req.body;
    if (!Object.keys(values).length) throw fail(400, 'Nothing to change');
    for (const [name, value] of Object.entries(values)) {
      if (!Object.hasOwn(LIMITS, name)) throw fail(400, `Unknown parameter ${name}`);
      checkRange(name, value, ...LIMITS[name]);
    }
    const { FOG_RADIUS_MIN, FOG_RADIUS_MAX } = { ...game.config, ...values };
    if (FOG_RADIUS_MIN > FOG_RADIUS_MAX) throw fail(400, 'FOG_RADIUS_MIN must not exceed FOG_RADIUS_MAX');
    game.setConfig(values);
    res.json(game.config);
  });

  router.post('/spawn', (req, res) => {
    const { points, near } = req.body;
    checkRange('Points', points, 0, MAX_POINTS, true);
    if (near !== undefined && !game.players.has(near)) throw fail(404, 'Player not found');
    res.status(201).json({ id: game.spawnSnake(points, near).playerId });
  });

  router.put('/players/:id/points', (req, res) => {
    checkRange('Points', req.body.points, 0, MAX_POINTS, true);
    game.setPoints(req.params.id, req.body.points);
    res.status(204).end();
  });

  router.post('/players/:id/teleport', (req, res) => {
    const { x, y } = req.body;
    checkRange('x', x, 0, game.config.MAP_WIDTH);
    checkRange('y', y, 0, game.config.MAP_HEIGHT);
    game.teleport(req.params.id, x, y);
    res.status(204).end();
  });

  router.post('/players/:id/kill', (req, res) => {
    game.kill(req.params.id);
    res.status(204).end();
  });

  router.use((error, req, res, next) => {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  });

  return router;
}
