// A ping: rays traced once when it is emitted; the wave then reveals each hit point
// as it expands past it.
export const PING_SPEED = 430;
export const PING_RANGE = 480;
export const PING_FADE = 2.8;
export const RAYS = 640;

export const COS = new Float32Array(RAYS);
export const SIN = new Float32Array(RAYS);
for (let i = 0; i < RAYS; i++) {
  COS[i] = Math.cos((i / RAYS) * Math.PI * 2);
  SIN[i] = Math.sin((i / RAYS) * Math.PI * 2);
}

export class Ping {
  constructor(cave, x, y, time) {
    this.x = x;
    this.y = y;
    this.start = time;
    this.hit = new Float32Array(RAYS);
    for (let i = 0; i < RAYS; i++) this.hit[i] = cave.trace(x, y, COS[i], SIN[i], PING_RANGE);
    this.remembered = new Uint8Array(RAYS);
    this.reached = new Set(); // creatures, spores and the gate the wave has already passed
  }

  radius(time) {
    return (time - this.start) * PING_SPEED;
  }

  expired(time) {
    return time - this.start > PING_RANGE / PING_SPEED + PING_FADE;
  }
}
