// Starter game: steer the light into the orbs. Replace all of this with your game.
import './style.css';

// The launcher's build adds this meta tag, so the link only appears there.
const hubUrl = document.querySelector('meta[name="hub-url"]')?.content;
if (hubUrl) {
  const link = document.getElementById('hub-link');
  link.href = hubUrl;
  link.hidden = false;
}

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const keys = new Set();
const player = { x: innerWidth / 2, y: innerHeight / 2, r: 14, speed: 420 };
let pointer = null;
let orb = null;
let score = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnOrb() {
  orb = { x: 40 + Math.random() * (innerWidth - 80), y: 60 + Math.random() * (innerHeight - 100), r: 9 };
}

function glow(x, y, r, color) {
  ctx.shadowBlur = 24;
  ctx.shadowColor = color;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

addEventListener('resize', resize);
addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY }));
addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  pointer = null;
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  let dx = (keys.has('arrowright') || keys.has('d')) - (keys.has('arrowleft') || keys.has('a'));
  let dy = (keys.has('arrowdown') || keys.has('s')) - (keys.has('arrowup') || keys.has('w'));
  if (pointer) {
    dx = pointer.x - player.x;
    dy = pointer.y - player.y;
  }
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    const step = Math.min(len, player.speed * dt);
    player.x += (dx / len) * step;
    player.y += (dy / len) * step;
  }

  if (Math.hypot(orb.x - player.x, orb.y - player.y) < player.r + orb.r) {
    score++;
    scoreEl.textContent = score;
    spawnOrb();
  }

  ctx.fillStyle = 'rgba(7, 6, 15, 0.3)';
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  glow(orb.x, orb.y, orb.r, '#ff3fa4');
  glow(player.x, player.y, player.r, '#46d9ff');
  requestAnimationFrame(frame);
}

resize();
spawnOrb();
requestAnimationFrame(frame);
