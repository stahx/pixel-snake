const RESTART_MS = 5000;

export const botsOf = (rows) => rows.filter((row) => !row.model).reduce((sum, row) => sum + row.count, 0);
export const opponentRun = (model) => `${model.split('/')[0]}-play`;

export function createOpponents({ trainer, restartMs = RESTART_MS }) {
  const groups = new Map();
  const label = (group, entry) => `opponent ${entry.model} in ${group.name} #${entry.world + 1}`;

  function launch(group, entry) {
    const [run, file] = entry.model.split('/');
    entry.child = trainer.play({ model: { run, file }, run: opponentRun(entry.model), group: group.name, world: entry.world, sessions: entry.count });
    entry.child.on('error', (error) => console.error(`Lab: ${label(group, entry)}:`, error.message));
    entry.child.on('exit', (code, signal) => {
      if (groups.get(group.id) !== group) return;
      console.error(`Lab: ${label(group, entry)} exited with ${signal ?? `code ${code}`}, restarting`);
      setTimeout(() => groups.get(group.id) === group && launch(group, entry), restartMs);
    });
  }

  const stop = (id) => {
    const group = groups.get(id);
    groups.delete(id);
    group?.entries.forEach((entry) => entry.child.kill());
  };

  return {
    start({ id, name, opponents }) {
      if (groups.has(id)) return;
      const entries = opponents.flatMap((rows, world) => rows.filter((row) => row.model).map((row) => ({ ...row, world })));
      const group = { id, name, entries };
      groups.set(id, group);
      entries.forEach((entry) => launch(group, entry));
    },
    stop,
    close: () => [...groups.keys()].forEach(stop),
  };
}
