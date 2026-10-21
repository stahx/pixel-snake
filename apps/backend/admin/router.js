import express from 'express';

import { configError, rangeError } from '../class/Config.js';
import { passwordLogin } from '../helpers/login.js';

const MAX_POINTS = 5000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const checkRange = (...range) => {
  const error = rangeError(...range);
  if (error) throw fail(400, error);
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
    const invalid = configError(values, game.config);
    if (invalid) throw fail(400, invalid);
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
