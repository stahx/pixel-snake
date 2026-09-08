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

// Size grows in fixed steps of the snake's points, capped at a max size --
// not a continuous curve, and not a value that freezes forever once reached
// (previously `player.size < 100 ? ... : player.size` locked size in place
// permanently the first time it crossed 100, no matter how many more points
// came in afterwards). GameClient.js#getVisionRadius mirrors this size range
// (BASE_SIZE/MAX_SIZE) to size the camera zoom -- keep both in sync.
const BASE_SIZE = 10;
const MAX_SIZE = 100;
const POINTS_PER_SIZE_STEP = 10;

export const calculatePlayerNewSize = (player) => {
  return Math.min(
    MAX_SIZE,
    BASE_SIZE + Math.floor(player.points / POINTS_PER_SIZE_STEP),
  );
};
