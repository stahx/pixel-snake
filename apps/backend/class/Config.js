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
