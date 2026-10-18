import Entity from './Entity.js';

class Point extends Entity {
  constructor(x, y, options = {}) {
    super(x, y, options);
    this.size = options.size || 10;
    this.color = options.color || '#ffffff';
    this.respawns = options.respawns ?? true;
  }
}

export default Point;
