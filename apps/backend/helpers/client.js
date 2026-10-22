import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const frontend = (folder) => fileURLToPath(new URL(`../../frontend/${folder}`, import.meta.url));

export function serveClient(app, game) {
  app.use(express.static(frontend('src')));
  app.use(express.static(frontend('public')));

  app.get('/version', (req, res) => res.json({ version }));

  app.get('/state', (req, res) => res.status(game.running ? 200 : 400).send(game.running));

  app.get('/game-data', (req, res) => {
    if (!game.running) return res.status(400).send(false);
    res.json({ entities: game.entities, width: game.config.MAP_WIDTH, height: game.config.MAP_HEIGHT });
  });
}
