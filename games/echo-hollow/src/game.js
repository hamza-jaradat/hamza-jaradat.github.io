// Rules and simulation: the cave, the wisp, pings, spores, the gate and the listeners.
import { Cave, NEIGHBORS } from './cave.js';
import { PING_RANGE, Ping } from './sonar.js';
import { clamp, damp, dist, mulberry32, shuffle } from './util.js';

export const PLAYER_R = 9;
export const LISTENER_R = 13;
export const PING_COOLDOWN = 1.1;
export const MAX_LIVES = 3;
const PLAYER_SPEED = 175;
const HEAR_AROUND_CORNERS = 170; // listeners this close hear a ping even without line of sight
const SENSE_RANGE = 62; // listeners this close notice the wisp without any ping
const BEST_KEY = 'echo-hollow:best';

export class Game {
  constructor({ sound, onState, onLevel }) {
    this.sound = sound;
    this.onState = onState;
    this.onLevel = onLevel;
    this.best = readBest();
    this.time = 0;
    this.toTitle();
  }

  // --- Flow -------------------------------------------------------------------
  toTitle() {
    this.demo = true;
    this.level = 2;
    this.load(2, randomSeed());
    this.setState('title');
  }

  newRun() {
    this.demo = false;
    this.score = 0;
    this.lives = MAX_LIVES;
    this.level = 0;
    this.nextLevel();
  }

  nextLevel() {
    this.level++;
    this.load(this.level, randomSeed());
    this.setState('playing');
  }

  togglePause() {
    if (this.state === 'playing') this.setState('paused');
    else if (this.state === 'paused') this.setState('playing');
  }

  setState(state, info) {
    this.state = state;
    this.onState?.(state, info, this);
  }

  load(level, seed) {
    const lv = createLevel(level, seed);
    Object.assign(this, lv);
    this.seed = seed;
    this.player = { x: lv.start.x, y: lv.start.y, vx: 0, vy: 0, invuln: 0 };
    this.pings = [];
    this.particles = [];
    this.cooldown = 0;
    this.collected = 0;
    this.stats = { pings: 0, time: 0, hits: 0 };
    this.heartbeat = 0;
    this.hurtFlash = 0;
    this.bot = { goal: null, flow: null, retarget: 0, lastPing: -10 };
    this.onLevel?.(this);
  }

  // --- Simulation ------------------------------------------------------------------
  update(dt, input, playerOnScreen) {
    if (this.state === 'paused') return;
    this.time += dt;
    if (this.state === 'playing' || this.state === 'title') {
      const control = this.demo ? this.autopilot(dt) : input.move(playerOnScreen());
      const ping = this.demo ? control.ping : input.takePing();
      this.step(dt, control, ping);
    } else {
      this.step(dt, { x: 0, y: 0 }, false); // the cave stays alive behind the cards
    }
  }

  step(dt, move, wantsPing) {
    const p = this.player;
    const live = this.state === 'playing';
    if (live) this.stats.time += dt;

    p.vx += (move.x * PLAYER_SPEED - p.vx) * damp(9, dt);
    p.vy += (move.y * PLAYER_SPEED - p.vy) * damp(9, dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    this.cave.pushOut(p, PLAYER_R);
    p.invuln = Math.max(0, p.invuln - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);

    this.cooldown = Math.max(0, this.cooldown - dt);
    if (wantsPing && this.cooldown === 0) this.emitPing();

    this.updatePings();
    for (const l of this.listeners) this.updateListener(l, dt);
    this.updateSpores(dt);
    this.updateGate(dt);
    this.updateParticles(dt);
    if (live) {
      this.checkContacts();
      this.updateHeartbeat(dt);
    }
  }

  emitPing() {
    const p = this.player;
    this.pings.push(new Ping(this.cave, p.x, p.y, this.time));
    this.cooldown = PING_COOLDOWN;
    if (!this.demo) this.stats.pings++;
    this.sfx('ping');
  }

  // Sound effects, kept quiet while the title-screen demo plays itself.
  sfx(name, ...args) {
    if (!this.demo) this.sound[name](...args);
  }

  // The wave reaches creatures, spores and the gate in turn; walls block it beyond close range.
  updatePings() {
    const now = this.time;
    this.pings = this.pings.filter((ping) => !ping.expired(now));
    for (const ping of this.pings) {
      const r = ping.radius(now);
      if (r > PING_RANGE + 40) continue;
      const reaches = (thing) => {
        if (ping.reached.has(thing)) return false;
        const d = dist(ping.x, ping.y, thing.x, thing.y);
        if (d > PING_RANGE) ping.reached.add(thing);
        if (d > PING_RANGE || r < d) return false;
        ping.reached.add(thing);
        return d < HEAR_AROUND_CORNERS || this.cave.los(ping.x, ping.y, thing.x, thing.y) ? 'heard' : 'blocked';
      };
      for (const l of this.listeners) if (reaches(l) === 'heard') this.alert(l, ping.x, ping.y, true);
      for (const s of this.spores) if (!s.collected && reaches(s) === 'heard') s.reveal = 5;
      if (reaches(this.exit) === 'heard') this.exit.reveal = 5;
    }
  }

  alert(l, x, y, byPing) {
    const fresh = l.state !== 'hunt';
    l.state = 'hunt';
    l.tx = x;
    l.ty = y;
    l.flow = this.cave.bfs(this.cave.cellAt(x, y), LISTENER_R + 2);
    l.replan = 0.35;
    if (byPing) l.reveal = 1.8;
    if (fresh) this.sfx('growl', this.pan(l.x), this.near(l.x, l.y));
  }

  updateListener(l, dt) {
    const p = this.player;
    l.reveal = Math.max(0, l.reveal - dt);
    l.replan -= dt;
    l.timer -= dt;
    if (this.state === 'playing' && l.replan <= 0 && dist(l.x, l.y, p.x, p.y) < SENSE_RANGE) this.alert(l, p.x, p.y, false);

    let speed = 40;
    if (l.state === 'hunt') {
      speed = Math.min(150, 108 + 5 * this.level);
      if (dist(l.x, l.y, l.tx, l.ty) < 18) {
        l.state = 'search';
        l.timer = 2.2;
      }
    } else if (l.state === 'search') {
      speed = 30;
      if (l.timer <= 0) {
        l.state = 'wander';
        l.flow = null;
      }
    } else if (!l.flow || l.timer <= 0 || dist(l.x, l.y, l.tx, l.ty) < 16) {
      this.wanderTarget(l);
    }

    let dir;
    if (l.state === 'search') {
      dir = { x: Math.cos(this.time * 1.7 + l.phase), y: Math.sin(this.time * 1.3 + l.phase) };
    } else {
      dir = follow(this.cave, l, l.flow, l.tx, l.ty);
    }
    l.vx += (dir.x * speed - l.vx) * damp(3.5, dt);
    l.vy += (dir.y * speed - l.vy) * damp(3.5, dt);
    l.x += l.vx * dt;
    l.y += l.vy * dt;
    this.cave.pushOut(l, LISTENER_R);
  }

  wanderTarget(l) {
    const { cave } = this;
    const walk = cave.walkable(LISTENER_R + 2);
    const here = cave.cellAt(l.x, l.y);
    const hx = here % cave.cols;
    const hy = Math.floor(here / cave.cols);
    for (let tries = 0; tries < 24; tries++) {
      const x = hx + Math.round((Math.random() * 2 - 1) * 7);
      const y = hy + Math.round((Math.random() * 2 - 1) * 7);
      if (x < 0 || y < 0 || x >= cave.cols || y >= cave.rows) continue;
      const i = y * cave.cols + x;
      if (!walk[i] || Math.max(Math.abs(x - hx), Math.abs(y - hy)) < 3) continue;
      const c = cave.center(i);
      l.tx = c.x;
      l.ty = c.y;
      l.flow = cave.bfs(i, LISTENER_R + 2);
      break;
    }
    l.timer = 7;
  }

  updateSpores(dt) {
    const p = this.player;
    for (const s of this.spores) {
      if (s.collected) continue;
      s.reveal = Math.max(0, s.reveal - dt);
      s.chime -= dt;
      if (s.chime <= 0) {
        s.chime = 3.2 + Math.random() * 1.6;
        s.ring = this.time;
        const d = dist(s.x, s.y, p.x, p.y);
        if (d < 360) this.sfx('tinkle', this.pan(s.x), 1 - d / 360);
      }
      const canCollect = this.state === 'playing' || this.demo;
      if (canCollect && dist(s.x, s.y, p.x, p.y) < PLAYER_R + 11) this.collect(s);
    }
  }

  collect(s) {
    s.collected = true;
    this.collected++;
    if (!this.demo) this.score += 100;
    this.sfx('chime', this.collected);
    this.burst(s.x, s.y, '#c6ff6e', 22, 90);
    if (this.collected === this.spores.length) {
      this.exit.open = true;
      this.exit.openedAt = this.time;
      this.sfx('gateOpen');
    }
  }

  updateGate(dt) {
    const p = this.player;
    this.exit.reveal = Math.max(0, this.exit.reveal - dt);
    if (!this.exit.open || dist(p.x, p.y, this.exit.x, this.exit.y) > 24) return;
    if (this.demo) {
      this.load(2, randomSeed());
    } else if (this.state === 'playing') {
      this.completeLevel();
    }
  }

  completeLevel() {
    const s = this.stats;
    const bonus = {
      silence: Math.max(0, 800 - 40 * s.pings),
      speed: Math.max(0, 600 - Math.round(6 * s.time)),
      unharmed: s.hits === 0 ? 300 : 0,
    };
    const total = bonus.silence + bonus.speed + bonus.unharmed;
    this.score += total;
    const healed = this.lives < MAX_LIVES;
    if (healed) this.lives++;
    this.saveBest();
    this.sound.cleared();
    this.burst(this.exit.x, this.exit.y, '#ffd36b', 40, 140);
    this.setState('levelDone', {
      level: this.level,
      spores: this.spores.length,
      pings: s.pings,
      time: s.time,
      hits: s.hits,
      bonus,
      score: this.score,
      healed,
    });
  }

  checkContacts() {
    const p = this.player;
    if (p.invuln > 0) return;
    for (const l of this.listeners) {
      const d = dist(l.x, l.y, p.x, p.y);
      if (d > PLAYER_R + LISTENER_R - 3) continue;
      this.lives--;
      this.stats.hits++;
      p.invuln = 1.6;
      this.hurtFlash = 1;
      const nx = d > 0.01 ? (p.x - l.x) / d : 1;
      const ny = d > 0.01 ? (p.y - l.y) / d : 0;
      p.vx = nx * 320;
      p.vy = ny * 320;
      l.state = 'search';
      l.timer = 1.8;
      l.reveal = 1.5;
      this.burst(p.x, p.y, '#ff3b5c', 30, 160);
      this.sound.hurt();
      if (this.lives <= 0) this.gameOver();
      return;
    }
  }

  gameOver() {
    const newBest = this.saveBest();
    this.sound.lost();
    this.setState('gameOver', { score: this.score, best: this.best, newBest, level: this.level });
  }

  // Heartbeat speeds up as a hunting listener closes in.
  updateHeartbeat(dt) {
    let near = Infinity;
    for (const l of this.listeners) {
      if (l.state === 'hunt') near = Math.min(near, dist(l.x, l.y, this.player.x, this.player.y));
    }
    if (near > 300) {
      this.heartbeat = 0;
      return;
    }
    const k = 1 - near / 300;
    this.heartbeat -= dt;
    if (this.heartbeat <= 0) {
      this.sound.heartbeat(k);
      this.heartbeat = 0.95 - 0.5 * k;
    }
  }

  burst(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life: 0.5 + Math.random() * 0.5,
        max: 1,
        color,
        size: 6 + Math.random() * 10,
      });
    }
  }

  updateParticles(dt) {
    const drag = Math.exp(-dt * 3);
    for (const q of this.particles) {
      q.life -= dt;
      q.vx *= drag;
      q.vy *= drag;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
    this.particles = this.particles.filter((q) => q.life > 0);
  }

  pan(x) {
    return clamp((x - this.player.x) / 320, -1, 1);
  }

  near(x, y) {
    return clamp(1 - dist(x, y, this.player.x, this.player.y) / 600, 0.15, 1);
  }

  // Heads for the nearest spore (then the gate), pinging every couple of seconds.
  // Drives the title-screen demo, and is handy for testing.
  autopilot(dt) {
    const b = this.bot;
    const p = this.player;
    b.retarget -= dt;
    if (!b.goal || b.goal.collected || b.retarget <= 0) {
      const left = this.spores.filter((s) => !s.collected);
      b.goal = left.length
        ? left.reduce((a, s) => (dist(s.x, s.y, p.x, p.y) < dist(a.x, a.y, p.x, p.y) ? s : a))
        : this.exit;
      b.flow = this.cave.bfs(this.cave.cellAt(b.goal.x, b.goal.y), PLAYER_R + 1);
      b.retarget = 2;
    }
    const dir = follow(this.cave, p, b.flow, b.goal.x, b.goal.y);
    const ping = this.time - b.lastPing > 2.4;
    if (ping) b.lastPing = this.time;
    return { x: dir.x * 0.8, y: dir.y * 0.8, ping };
  }

  saveBest() {
    if (this.score <= this.best) return false;
    this.best = this.score;
    try {
      localStorage.setItem(BEST_KEY, String(this.best));
    } catch {
      // storage unavailable
    }
    return true;
  }
}

// Direction toward (tx, ty) following a BFS flow field built from the target's cell.
function follow(cave, e, flow, tx, ty) {
  let gx = tx;
  let gy = ty;
  if (flow) {
    const c = cave.cellAt(e.x, e.y);
    const here = flow[c];
    if (here !== 0 && here !== 1) {
      let best = here < 0 ? Infinity : here;
      let pick = -1;
      const x = c % cave.cols;
      const y = Math.floor(c / cave.cols);
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cave.cols || ny >= cave.rows) continue;
        const n = ny * cave.cols + nx;
        if (flow[n] >= 0 && flow[n] < best) {
          best = flow[n];
          pick = n;
        }
      }
      if (pick >= 0) ({ x: gx, y: gy } = cave.center(pick));
    }
  }
  const dx = gx - e.x;
  const dy = gy - e.y;
  const len = Math.hypot(dx, dy);
  return len > 0.001 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 };
}

export function createLevel(level, seed) {
  const rng = mulberry32(seed);
  const cave = new Cave(level, rng);
  const n = cave.cols * cave.rows;
  const clear = new Float32Array(n);
  for (let i = 0; i < n; i++) clear[i] = cave.clearance(i);

  // Start somewhere roomy; the gate goes as far away as the wisp can travel.
  const roomy = [];
  let widest = 0;
  for (let i = 0; i < n; i++) {
    if (clear[i] >= 30) roomy.push(i);
    if (clear[i] > clear[widest]) widest = i;
  }
  const startCell = roomy.length ? roomy[Math.floor(rng() * roomy.length)] : widest;
  const walk = cave.bfs(startCell, PLAYER_R + 1);
  let exitCell = startCell;
  for (let i = 0; i < n; i++) if (walk[i] > walk[exitCell] && clear[i] >= 22) exitCell = i;

  const sporeCells = spread(cave, rng, (i) => walk[i] >= 5 && i !== exitCell && clear[i] >= 14, Math.min(17, 5 + 2 * level), 5);

  // Listeners start well away from the wisp, in space they can move through.
  const lwalk = cave.bfs(startCell, LISTENER_R + 2);
  let far = 0;
  for (let i = 0; i < n; i++) far = Math.max(far, lwalk[i]);
  const listenerCells = spread(cave, rng, (i) => lwalk[i] >= Math.max(10, far * 0.45) && clear[i] >= 18, Math.min(7, 1 + level), 6);

  const jitter = (i, room) => {
    const c = cave.center(i);
    const r = clamp((clear[i] - room) / 1.5, 0, 8);
    return { x: c.x + (rng() * 2 - 1) * r, y: c.y + (rng() * 2 - 1) * r };
  };

  return {
    cave,
    start: cave.center(startCell),
    exit: { ...cave.center(exitCell), open: false, reveal: 0, openedAt: 0 },
    spores: sporeCells.map((i) => ({
      ...jitter(i, 12),
      collected: false,
      reveal: 0,
      chime: rng() * 3,
      ring: -10,
      phase: rng() * Math.PI * 2,
    })),
    listeners: listenerCells.map((i) => ({
      ...cave.center(i),
      vx: 0,
      vy: 0,
      state: 'wander',
      tx: 0,
      ty: 0,
      flow: null,
      timer: 0,
      replan: 0,
      reveal: 0,
      phase: rng() * Math.PI * 2,
    })),
  };
}

// Picks up to `count` cells that pass `ok`, at least `spacing` cells apart (relaxing if needed).
function spread(cave, rng, ok, count, spacing) {
  const candidates = [];
  for (let i = 0; i < cave.cols * cave.rows; i++) if (ok(i)) candidates.push(i);
  shuffle(candidates, rng);
  let picked = [];
  for (let s = spacing; s >= 1; s--) {
    picked = [];
    for (const c of candidates) {
      if (picked.length >= count) break;
      const cx = c % cave.cols;
      const cy = Math.floor(c / cave.cols);
      const apart = picked.every((q) => Math.max(Math.abs((q % cave.cols) - cx), Math.abs(Math.floor(q / cave.cols) - cy)) >= s);
      if (apart) picked.push(c);
    }
    if (picked.length >= count) break;
  }
  return picked;
}

function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function readBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}
