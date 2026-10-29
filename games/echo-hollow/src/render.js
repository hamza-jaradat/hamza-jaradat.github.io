// Draws the cave as light in darkness: walls exist on screen only where a ping or the
// wisp's own glow has touched them, plus a faint memory of everything revealed so far.
import { LISTENER_R, PING_COOLDOWN } from './game.js';
import { COS, PING_FADE, PING_RANGE, PING_SPEED, RAYS, SIN } from './sonar.js';
import { clamp, damp, dist, smoothstep } from './util.js';

const WALL = '#5fe1ff';
const FRESH = '#eafcff';
const MEMORY = '#163a52';
const SPORE = '#c6ff6e';
const GATE = '#ffd36b';
const LISTENER = '#ff3b5c';
const WISP = '#9ff0ff';
const LIGHT_RANGE = 140;
const LIGHT_RAYS = 220;
const BUCKETS = 8;
const GAP = 18; // hit points further apart than this belong to different walls

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0 };
    this.zoom = 1;
    this.dpr = 1;
    this.sprites = new Map();
    this.buckets = Array.from({ length: BUCKETS }, () => []);
    this.fresh = [];
    this.recall = [];
    this.light = new Float32Array(LIGHT_RAYS);
    this.memory = document.createElement('canvas');
    this.memCtx = this.memory.getContext('2d');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    // Show roughly 620 px of cave vertically, but never less than 520 px across.
    this.zoom = clamp(Math.min(this.h / 620, this.w / 520), 0.5, 2.4);
    this.vignette = makeVignette(this.w, this.h);
  }

  // New level: a fresh (half-resolution) memory of the walls, camera on the wisp.
  reset(game) {
    const { cave, player } = game;
    this.memory.width = Math.ceil(cave.width / 2);
    this.memory.height = Math.ceil(cave.height / 2);
    this.memCtx.setTransform(0.5, 0, 0, 0.5, 0, 0);
    this.memCtx.lineCap = 'round';
    this.cam.x = player.x;
    this.cam.y = player.y;
  }

  toScreen(x, y) {
    return { x: (x - this.cam.x) * this.zoom + this.w / 2, y: (y - this.cam.y) * this.zoom + this.h / 2 };
  }

  sprite(color) {
    let s = this.sprites.get(color);
    if (!s) {
      s = document.createElement('canvas');
      s.width = s.height = 64;
      const g = s.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, color);
      grad.addColorStop(0.18, `${color}cc`);
      grad.addColorStop(0.45, `${color}40`);
      grad.addColorStop(1, `${color}00`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this.sprites.set(color, s);
    }
    return s;
  }

  glow(color, x, y, size, alpha) {
    if (alpha <= 0.003) return;
    this.ctx.globalAlpha = Math.min(1, alpha);
    this.ctx.drawImage(this.sprite(color), x - size / 2, y - size / 2, size, size);
  }

  draw(game, dt) {
    const { ctx, dpr } = this;
    const p = game.player;
    const lead = 0.25;
    this.cam.x += (p.x + p.vx * lead - this.cam.x) * damp(5, dt);
    this.cam.y += (p.y + p.vy * lead - this.cam.y) * damp(5, dt);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#020207';
    ctx.fillRect(0, 0, this.w, this.h);

    const z = this.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, dpr * (this.w / 2 - this.cam.x * this.zoom), dpr * (this.h / 2 - this.cam.y * this.zoom));
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    ctx.globalAlpha = 1;
    ctx.drawImage(this.memory, 0, 0, game.cave.width, game.cave.height);

    const light = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, LIGHT_RANGE + 20);
    light.addColorStop(0, 'rgba(95, 225, 255, 0.16)');
    light.addColorStop(1, 'rgba(95, 225, 255, 0)');
    ctx.fillStyle = light;
    ctx.fillRect(p.x - LIGHT_RANGE - 20, p.y - LIGHT_RANGE - 20, (LIGHT_RANGE + 20) * 2, (LIGHT_RANGE + 20) * 2);

    this.collectLight(game);
    for (const ping of game.pings) this.collectPing(ping, game.time);
    this.flushMemory();
    this.strokeWalls();
    for (const ping of game.pings) this.drawWave(ping, game.time);

    this.drawSpores(game);
    this.drawGate(game);
    this.drawListeners(game);
    for (const q of game.particles) this.glow(q.color, q.x, q.y, q.size, (q.life / q.max) * 0.9);
    this.drawWisp(game);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.vignette, 0, 0, this.w, this.h);
    this.drawGateArrow(game);
    if (game.hurtFlash > 0) {
      ctx.globalAlpha = game.hurtFlash * 0.32;
      ctx.fillStyle = LISTENER;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
    }
  }

  // The wisp's own glow lights the walls right around it.
  collectLight(game) {
    const { cave, player: p } = game;
    const step = RAYS / LIGHT_RAYS;
    for (let i = 0; i < LIGHT_RAYS; i++) {
      const k = Math.round(i * step) % RAYS;
      this.light[i] = cave.trace(p.x, p.y, COS[k], SIN[k], LIGHT_RANGE);
    }
    for (let i = 0; i < LIGHT_RAYS; i++) {
      const j = (i + 1) % LIGHT_RAYS;
      const a = this.light[i];
      const b = this.light[j];
      if (a === Infinity || b === Infinity) continue;
      const ki = Math.round(i * step) % RAYS;
      const kj = Math.round(j * step) % RAYS;
      const ax = p.x + COS[ki] * a;
      const ay = p.y + SIN[ki] * a;
      const bx = p.x + COS[kj] * b;
      const by = p.y + SIN[kj] * b;
      if (dist(ax, ay, bx, by) > GAP) continue;
      const alpha = 0.85 * Math.pow(1 - Math.max(a, b) / LIGHT_RANGE, 1.4);
      this.push(alpha, ax, ay, bx, by);
      if (Math.max(a, b) < LIGHT_RANGE * 0.8) this.recall.push(ax, ay, bx, by);
    }
  }

  collectPing(ping, now) {
    const r = ping.radius(now);
    const age0 = now - ping.start;
    for (let i = 0; i < RAYS; i++) {
      const j = i + 1 === RAYS ? 0 : i + 1;
      const a = ping.hit[i];
      const b = ping.hit[j];
      if (a > r || b > r) continue; // also skips Infinity: no wall in range
      const ax = ping.x + COS[i] * a;
      const ay = ping.y + SIN[i] * a;
      const bx = ping.x + COS[j] * b;
      const by = ping.y + SIN[j] * b;
      if (dist(ax, ay, bx, by) > GAP) continue;
      const age = age0 - Math.max(a, b) / PING_SPEED;
      const alpha = 1 - age / PING_FADE;
      if (alpha <= 0) continue;
      this.push(alpha * alpha, ax, ay, bx, by);
      if (age < 0.12) this.fresh.push(ax, ay, bx, by);
      if (!ping.remembered[i]) {
        ping.remembered[i] = 1;
        this.recall.push(ax, ay, bx, by);
      }
    }
  }

  push(alpha, ax, ay, bx, by) {
    this.buckets[Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS))].push(ax, ay, bx, by);
  }

  strokeWalls() {
    const { ctx } = this;
    ctx.strokeStyle = WALL;
    for (let b = 0; b < BUCKETS; b++) {
      const segs = this.buckets[b];
      if (!segs.length) continue;
      const a = (b + 0.5) / BUCKETS;
      tracePath(ctx, segs);
      ctx.globalAlpha = a * 0.22;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      segs.length = 0;
    }
    if (this.fresh.length) {
      tracePath(ctx, this.fresh);
      ctx.strokeStyle = FRESH;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2.4;
      ctx.stroke();
      this.fresh.length = 0;
    }
  }

  flushMemory() {
    if (!this.recall.length) return;
    const m = this.memCtx;
    tracePath(m, this.recall);
    m.strokeStyle = MEMORY;
    m.lineWidth = 3;
    m.stroke();
    this.recall.length = 0;
  }

  // The wavefront travels through open space and stops where it meets rock.
  drawWave(ping, now) {
    const r = ping.radius(now);
    if (r >= PING_RANGE) return;
    const { ctx } = this;
    ctx.beginPath();
    let open = false;
    for (let i = 0; i <= RAYS; i++) {
      const k = i % RAYS;
      if (ping.hit[k] > r) {
        const x = ping.x + COS[k] * r;
        const y = ping.y + SIN[k] * r;
        if (open) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        open = true;
      } else {
        open = false;
      }
    }
    ctx.strokeStyle = WALL;
    ctx.globalAlpha = 0.5 * (1 - r / PING_RANGE);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  drawSpores(game) {
    const { ctx } = this;
    const p = game.player;
    for (const s of game.spores) {
      if (s.collected) continue;
      const d = dist(s.x, s.y, p.x, p.y);
      // A soft chime ring every few seconds, faintly visible through rock as a hint.
      const ringAge = game.time - s.ring;
      if (ringAge < 1.4) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 8 + ringAge * 55, 0, Math.PI * 2);
        ctx.strokeStyle = SPORE;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.32 * (1 - ringAge / 1.4) * (1 - smoothstep(380, 560, d));
        ctx.stroke();
      }
      const seen = Math.max(clamp(s.reveal / 2, 0, 1), smoothstep(170, 70, d));
      if (seen <= 0.01) continue;
      const pulse = 1 + 0.18 * Math.sin(game.time * 3 + s.phase);
      this.glow(SPORE, s.x, s.y, 34 * pulse, 0.85 * seen);
      this.glow('#ffffff', s.x, s.y, 9, seen);
    }
  }

  drawGate(game) {
    const { ctx } = this;
    const g = game.exit;
    const d = dist(g.x, g.y, game.player.x, game.player.y);
    if (g.open) {
      const t = game.time - g.openedAt;
      for (let k = 0; k < 3; k++) {
        const phase = (t * 0.9 + k / 3) % 1;
        ctx.beginPath();
        ctx.arc(g.x, g.y, 14 + phase * 70, 0, Math.PI * 2);
        ctx.strokeStyle = GATE;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.55 * (1 - phase);
        ctx.stroke();
      }
      this.glow(GATE, g.x, g.y, 90 + 10 * Math.sin(t * 4), 0.9);
      this.glow('#ffffff', g.x, g.y, 18, 1);
      return;
    }
    const seen = Math.max(clamp(g.reveal / 2, 0, 1), smoothstep(170, 70, d));
    if (seen <= 0.01) return;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 16, 0, Math.PI * 2);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = GATE;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.45 * seen;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawListeners(game) {
    const { ctx } = this;
    const p = game.player;
    for (const l of game.listeners) {
      const d = dist(l.x, l.y, p.x, p.y);
      const seen = Math.max(clamp(l.reveal / 1.2, 0, 1), smoothstep(160, 60, d));
      if (seen <= 0.01) continue;
      const hunting = l.state === 'hunt';
      const t = game.time;
      ctx.beginPath();
      for (let k = 0; k <= 18; k++) {
        const a = (k / 18) * Math.PI * 2;
        const rr = LISTENER_R * (1 + 0.16 * Math.sin(a * 3 + t * (hunting ? 6 : 2.4) + l.phase));
        const x = l.x + Math.cos(a) * rr;
        const y = l.y + Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#12010a';
      ctx.globalAlpha = 0.85 * seen;
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = LISTENER;
      ctx.lineWidth = 2;
      ctx.globalAlpha = (hunting ? 0.95 : 0.55) * seen;
      ctx.stroke();
      const beat = hunting ? 0.6 + 0.4 * Math.sin(t * 10) : 0.4;
      this.glow(LISTENER, l.x, l.y, 46, 0.5 * seen * beat);
      // Two "ears" that tilt toward whatever they last heard.
      const facing = Math.atan2(l.ty - l.y, l.tx - l.x);
      for (const side of [-0.55, 0.55]) {
        const a = facing + side;
        this.glow(LISTENER, l.x + Math.cos(a) * 9, l.y + Math.sin(a) * 9, 9, seen * (hunting ? 1 : 0.5));
      }
    }
  }

  drawWisp(game) {
    const { ctx } = this;
    const p = game.player;
    const blink = p.invuln > 0 && Math.floor(game.time * 14) % 2 === 0;
    if (blink) return;
    this.glow(WISP, p.x, p.y, 70, 0.75);
    this.glow('#ffffff', p.x, p.y, 16, 1);
    // The ring around the wisp fills up as the next ping recharges.
    const ready = 1 - game.cooldown / PING_COOLDOWN;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 15, -Math.PI / 2, -Math.PI / 2 + ready * Math.PI * 2);
    ctx.strokeStyle = WISP;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = ready >= 1 ? 0.22 + 0.12 * Math.sin(game.time * 4) : 0.5;
    ctx.stroke();
  }

  // Points toward the open gate when it is off screen.
  drawGateArrow(game) {
    const g = game.exit;
    if (!g.open || game.state !== 'playing') return;
    const s = this.toScreen(g.x, g.y);
    const m = 42;
    if (s.x > m && s.y > m && s.x < this.w - m && s.y < this.h - m) return;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const dx = s.x - cx;
    const dy = s.y - cy;
    const k = Math.min((this.w / 2 - m) / Math.abs(dx || 1e-6), (this.h / 2 - m) / Math.abs(dy || 1e-6));
    const { ctx } = this;
    ctx.save();
    ctx.translate(cx + dx * k, cy + dy * k);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -9);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fillStyle = GATE;
    ctx.shadowColor = GATE;
    ctx.shadowBlur = 14;
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(game.time * 5);
    ctx.fill();
    ctx.restore();
  }
}

function tracePath(ctx, segs) {
  ctx.beginPath();
  for (let k = 0; k < segs.length; k += 4) {
    ctx.moveTo(segs[k], segs[k + 1]);
    ctx.lineTo(segs[k + 2], segs[k + 3]);
  }
}

function makeVignette(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const g = c.getContext('2d');
  const r = Math.hypot(w, h) / 2;
  const grad = g.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.78)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  return c;
}
