export const GAME_CONFIG = {
  MAP_WIDTH: 4000,
  MAP_HEIGHT: 4000,
  POINTS_AMOUNT: 400,
  NORMAL_SPEED: 1.3,
  BOOST_SPEED: 2.8,
  TICK_RATE: 60,
  TIMESCALE: 1,
  // Vision radius scales with snake size (see Player.js spawn size / calculatePlayerNewSize
  // growth cap): small at spawn, growing toward FOG_RADIUS_MAX as the snake grows.
  FOG_RADIUS_MIN: 300,
  FOG_RADIUS_MAX: 2500,
  BOTS: 10,
};

export const LIMITS = {
  TIMESCALE: [0.25, 4],
  BOTS: [0, 100, true],
  POINTS_AMOUNT: [0, 5000, true],
  FOG_RADIUS_MIN: [100, 4000],
  FOG_RADIUS_MAX: [100, 4000],
  NORMAL_SPEED: [0.1, 10],
  BOOST_SPEED: [0.1, 10],
};

export const rangeError = (name, value, min, max, integer = false) => (
  typeof value === 'number' && value >= min && value <= max && (!integer || Number.isInteger(value))
    ? null
    : `${name} must be ${integer ? 'a whole number' : 'a number'} ${min}-${max}`
);

export function configError(values, current) {
  if (!values || typeof values !== 'object' || !Object.keys(values).length) return 'Nothing to change';
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(LIMITS, name)) return `Unknown parameter ${name}`;
    const error = rangeError(name, value, ...LIMITS[name]);
    if (error) return error;
  }
  const { FOG_RADIUS_MIN, FOG_RADIUS_MAX } = { ...current, ...values };
  return FOG_RADIUS_MIN > FOG_RADIUS_MAX ? 'FOG_RADIUS_MIN must not exceed FOG_RADIUS_MAX' : null;
}

export default class Config {
  constructor(config) {
    const {
      MAP_WIDTH,
      MAP_HEIGHT,
      POINTS_AMOUNT,
      NORMAL_SPEED,
      BOOST_SPEED,
      TICK_RATE,
      TIMESCALE = 1,
      FOG_RADIUS_MIN = 500,
      FOG_RADIUS_MAX = 2500,
      BOTS = 10,
    } = config;

    this.MAP_WIDTH = MAP_WIDTH;
    this.MAP_HEIGHT = MAP_HEIGHT;
    this.POINTS_AMOUNT = POINTS_AMOUNT;
    this.NORMAL_SPEED = NORMAL_SPEED;
    this.BOOST_SPEED = BOOST_SPEED;
    this.TICK_RATE = TICK_RATE;
    this.TIMESCALE = TIMESCALE;
    this.FOG_RADIUS_MIN = FOG_RADIUS_MIN;
    this.FOG_RADIUS_MAX = FOG_RADIUS_MAX;
    this.BOTS = BOTS;
  }
}
