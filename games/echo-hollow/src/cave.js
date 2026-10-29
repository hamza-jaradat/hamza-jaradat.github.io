// Procedural caves: a cellular automaton on a coarse grid, smoothed into a fine
// signed distance field (pixels to the nearest rock, negative inside rock). That one
// field drives collision, sonar rays, line of sight and spawn placement.
import { clamp } from './util.js';

export const CELL = 32;
const FINE = 4;
const SUB = CELL / FINE;
export const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const ORTHOGONAL = NEIGHBORS.slice(0, 4);

export class Cave {
  constructor(level, rng) {
    this.cols = Math.min(72, 42 + 4 * (level - 1));
    this.rows = Math.min(50, 28 + 3 * (level - 1));
    this.width = this.cols * CELL;
    this.height = this.rows * CELL;
    let grid;
    for (let attempt = 0; attempt < 30; attempt++) {
      grid = automaton(this.cols, this.rows, rng);
      if (keepLargestRegion(grid, this.cols, this.rows) >= 0.36 * this.cols * this.rows) break;
    }
    this.grid = grid;
    this.walkCache = new Map();
    this.buildField();
  }

  buildField() {
    const { cols, rows, grid } = this;
    // A light blur rounds the blocky automaton without closing one-cell corridors.
    const soft = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const at = (dx, dy) => grid[clamp(y + dy, 0, rows - 1) * cols + clamp(x + dx, 0, cols - 1)];
        soft[y * cols + x] = (4 * at(0, 0) + at(1, 0) + at(-1, 0) + at(0, 1) + at(0, -1)) / 8;
      }
    }
    const fw = (this.fw = cols * SUB);
    const fh = (this.fh = rows * SUB);
    const rock = new Uint8Array(fw * fh);
    for (let fy = 0; fy < fh; fy++) {
      for (let fx = 0; fx < fw; fx++) {
        const cx = (fx + 0.5) / SUB - 0.5;
        const cy = (fy + 0.5) / SUB - 0.5;
        rock[fy * fw + fx] = bilinear(soft, cols, rows, cx, cy) >= 0.5 ? 1 : 0;
      }
    }
    const toRock = edt(rock, fw, fh, 1);
    const toOpen = edt(rock, fw, fh, 0);
    this.sdf = new Float32Array(fw * fh);
    for (let i = 0; i < fw * fh; i++) {
      this.sdf[i] = (rock[i] ? -(toOpen[i] - 0.5) : toRock[i] - 0.5) * FINE;
    }
  }

  // Signed distance to the nearest rock, in pixels (bilinear).
  sample(x, y) {
    const fx = x / FINE - 0.5;
    const fy = y / FINE - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= this.fw - 1 || iy >= this.fh - 1) return -FINE;
    const ax = fx - ix;
    const ay = fy - iy;
    const s = this.sdf;
    const i = iy * this.fw + ix;
    const top = s[i] + (s[i + 1] - s[i]) * ax;
    const bottom = s[i + this.fw] + (s[i + this.fw + 1] - s[i + this.fw]) * ax;
    return top + (bottom - top) * ay;
  }

  // Distance along (dx, dy) to the first rock, or Infinity within maxDist (sphere tracing).
  trace(x, y, dx, dy, maxDist) {
    let t = 0;
    while (t < maxDist) {
      const d = this.sample(x + dx * t, y + dy * t);
      if (d < 0.5) return t;
      t += d > 1 ? d : 1;
    }
    return Infinity;
  }

  los(ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1) return true;
    return this.trace(ax, ay, (bx - ax) / len, (by - ay) / len, len) === Infinity;
  }

  // Slide a circle out of the rock along the field's gradient, dropping velocity into the wall.
  pushOut(e, r) {
    for (let k = 0; k < 3; k++) {
      const d = this.sample(e.x, e.y);
      if (d >= r) return;
      let gx = this.sample(e.x + 1.5, e.y) - this.sample(e.x - 1.5, e.y);
      let gy = this.sample(e.x, e.y + 1.5) - this.sample(e.x, e.y - 1.5);
      const len = Math.hypot(gx, gy);
      if (len < 1e-6) return;
      gx /= len;
      gy /= len;
      e.x += gx * (r - d);
      e.y += gy * (r - d);
      const into = e.vx * gx + e.vy * gy;
      if (into < 0) {
        e.vx -= gx * into;
        e.vy -= gy * into;
      }
    }
  }

  cellAt(x, y) {
    const cx = clamp(Math.floor(x / CELL), 0, this.cols - 1);
    const cy = clamp(Math.floor(y / CELL), 0, this.rows - 1);
    return cy * this.cols + cx;
  }

  center(i) {
    return { x: ((i % this.cols) + 0.5) * CELL, y: (Math.floor(i / this.cols) + 0.5) * CELL };
  }

  clearance(i) {
    const c = this.center(i);
    return this.sample(c.x, c.y);
  }

  // Cells whose centres have at least `room` pixels of open space around them.
  walkable(room) {
    let w = this.walkCache.get(room);
    if (!w) {
      w = new Uint8Array(this.cols * this.rows);
      for (let i = 0; i < w.length; i++) w[i] = this.clearance(i) >= room ? 1 : 0;
      this.walkCache.set(room, w);
    }
    return w;
  }

  // Steps from `from` to every cell, through cells with `room` pixels of space (-1: unreachable).
  bfs(from, room) {
    const { cols, rows } = this;
    const walk = this.walkable(room);
    const steps = new Int16Array(cols * rows).fill(-1);
    const queue = new Int32Array(cols * rows);
    let head = 0;
    let tail = 0;
    steps[from] = 0;
    queue[tail++] = from;
    while (head < tail) {
      const c = queue[head++];
      const x = c % cols;
      const y = (c - x) / cols;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (steps[n] >= 0 || !walk[n]) continue;
        if (dx && dy && (!walk[y * cols + nx] || !walk[ny * cols + x])) continue;
        steps[n] = steps[c] + 1;
        queue[tail++] = n;
      }
    }
    return steps;
  }
}

function automaton(w, h, rng) {
  let g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
      g[y * w + x] = edge || rng() < 0.47 ? 1 : 0;
    }
  }
  for (let pass = 0; pass < 5; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          next[y * w + x] = 1;
          continue;
        }
        let rocks = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) rocks += g[(y + dy) * w + x + dx];
        next[y * w + x] = rocks >= 5 ? 1 : 0;
      }
    }
    g = next;
  }
  return g;
}

// Fills every open pocket except the biggest, so the whole cave is one connected space.
function keepLargestRegion(g, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let best = -1;
  let bestSize = 0;
  let id = 0;
  for (let i = 0; i < w * h; i++) {
    if (g[i] || label[i] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    label[i] = id;
    while (head < tail) {
      const c = queue[head++];
      const x = c % w;
      const y = (c - x) / w;
      for (const [dx, dy] of ORTHOGONAL) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!g[n] && label[n] < 0) {
          label[n] = id;
          queue[tail++] = n;
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = id;
    }
    id++;
  }
  for (let i = 0; i < w * h; i++) if (!g[i] && label[i] !== best) g[i] = 1;
  return bestSize;
}

function bilinear(v, w, h, x, y) {
  const x0 = clamp(Math.floor(x), 0, w - 1);
  const y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const ax = clamp(x - x0, 0, 1);
  const ay = clamp(y - y0, 0, 1);
  const top = v[y0 * w + x0] + (v[y0 * w + x1] - v[y0 * w + x0]) * ax;
  const bottom = v[y1 * w + x0] + (v[y1 * w + x1] - v[y1 * w + x0]) * ax;
  return top + (bottom - top) * ay;
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher): distance from every
// pixel to the nearest pixel whose mask value equals `target`.
function edt(mask, w, h, target) {
  const INF = 1e20;
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] === target ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
  }
  return grid;
}

function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
