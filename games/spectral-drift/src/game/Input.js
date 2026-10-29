// Mouse / touch (absolute position), keyboard (lane steps) and gamepad steering.
import { LANES, LANE_WIDTH, MAX_X, laneX } from '../config.js';
import { clamp } from '../util.js';

const MOUSE_SPAN = 0.7; // fraction of the screen width that covers every lane

export class Input {
  constructor() {
    this.enabled = false;
    this.mode = 'mouse';
    this.targetX = 0;
    this.lane = Math.floor(LANES / 2);
    this.shipX = 0;
    this.onOverdrive = null;
    this.onPause = null;
    this._pad = { a: false, start: false, left: false, right: false };

    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && e.buttons === 0) return;
      this.mode = e.pointerType === 'touch' ? 'touch' : 'mouse';
      this.targetX = this._mapX(e.clientX);
    });
    window.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.pointerType === 'touch') {
        this.mode = 'touch';
        this.targetX = this._mapX(e.clientX);
      } else if (e.button === 2) {
        this.onOverdrive?.();
      }
    });
    window.addEventListener('contextmenu', (e) => {
      if (this.enabled) e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      switch (e.code) {
        case 'ArrowLeft':
        case 'KeyA':
          this._step(-1);
          e.preventDefault();
          break;
        case 'ArrowRight':
        case 'KeyD':
          this._step(1);
          e.preventDefault();
          break;
        case 'Space':
        case 'ArrowUp':
        case 'KeyW':
          if (!e.repeat) this.onOverdrive?.();
          e.preventDefault();
          break;
      }
    });
  }

  reset() {
    this.targetX = 0;
    this.lane = Math.floor(LANES / 2);
    this.shipX = 0;
  }

  _mapX(clientX) {
    const n = ((clientX / window.innerWidth - 0.5) * 2) / MOUSE_SPAN;
    return clamp(n, -1, 1) * MAX_X;
  }

  _step(d) {
    if (this.mode !== 'keys') {
      this.lane = clamp(Math.round(this.shipX / LANE_WIDTH + (LANES - 1) / 2), 0, LANES - 1);
      this.mode = 'keys';
    }
    this.lane = clamp(this.lane + d, 0, LANES - 1);
    this.targetX = laneX(this.lane);
  }

  // Polls the first connected gamepad; call once per frame.
  update() {
    if (!navigator.getGamepads) return;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.3) this.mode = 'pad';
      if (this.mode === 'pad') {
        const mag = Math.max(0, (Math.abs(ax) - 0.15) / 0.85);
        this.targetX = Math.sign(ax) * Math.min(1, mag) * MAX_X;
      }
      const pressed = (i) => !!pad.buttons[i]?.pressed;
      const edge = (key, now) => {
        const fired = now && !this._pad[key];
        this._pad[key] = now;
        return fired;
      };
      if (this.enabled) {
        if (edge('a', pressed(0) || pressed(1))) this.onOverdrive?.();
        if (edge('left', pressed(14))) this._step(-1);
        if (edge('right', pressed(15))) this._step(1);
      }
      if (edge('start', pressed(9))) this.onPause?.();
      break;
    }
  }
}
