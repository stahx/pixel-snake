export const calculatePlayerSize = (player) => {
  return player.points * 10;
};

export const calculatePlayerSpeed = (player) => {
  return player.speed ? 2.3 : 1.3;
};

export const calculatePlayerDirection = (player) => {
  return player.direction;
};

export const calculatePlayerPosition = (player) => {
  return player.position;
};

export const GROWTH_CAP_POINTS = 333;
export const SPAWN_SIZE = 10;
export const MAX_SIZE = 100;
export const MAX_TAIL_SEGMENTS = 400;
export const BIG_SLOWDOWN = 0.3;
export const TURN_RADIUS_PER_SIZE = 1.2;

export const growth = (points) => Math.min(1, Math.max(0, points) / GROWTH_CAP_POINTS);

export const calculatePlayerNewSize = (player) => SPAWN_SIZE + (MAX_SIZE - SPAWN_SIZE) * growth(player.points);

export const maxTailSegments = (points) => Math.round(MAX_TAIL_SEGMENTS * growth(points));

export const speedFactor = (points) => 1 - BIG_SLOWDOWN * growth(points);

export const maxTurn = (speed, size, cap) => Math.min(cap, speed / (TURN_RADIUS_PER_SIZE * size));
