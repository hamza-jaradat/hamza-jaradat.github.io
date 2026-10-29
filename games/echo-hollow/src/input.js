// Keyboard, mouse or touch (hold to drift toward the pointer), and gamepad.
export class Input {
  constructor(canvas, pingButton) {
    this.keys = new Set();
    this.pointer = null;
    this.pointerId = null;
    this.ping = false;
    this.pause = false;
    this.mute = false;
    this.pad = { x: 0, y: 0, a: false, start: false };

    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (!e.repeat) {
        if (e.code === 'Space' || e.code === 'KeyE') this.ping = true;
        if (e.code === 'Escape' || e.code === 'KeyP') this.pause = true;
        if (e.code === 'KeyM') this.mute = true;
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button === 2) {
        this.ping = true;
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.pointerId = e.pointerId;
      this.pointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') pingButton.hidden = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.pointerId) this.pointer = { x: e.clientX, y: e.clientY };
    });
    const release = (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointer = null;
      this.pointerId = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    pingButton.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.ping = true;
    });
  }

  // Desired movement, length at most 1. `from` is the wisp's position on screen.
  move(from) {
    const k = this.keys;
    let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let y = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    if (this.pointer) {
      const dx = this.pointer.x - from.x;
      const dy = this.pointer.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len > 12) {
        const s = Math.min(1, len / 90);
        x = (dx / len) * s;
        y = (dy / len) * s;
      }
    }
    if (Math.hypot(this.pad.x, this.pad.y) > 0.2) {
      x = this.pad.x;
      y = this.pad.y;
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  poll() {
    if (!navigator.getGamepads) return;
    for (const pad of navigator.getGamepads()) {
      if (!pad) continue;
      this.pad.x = Math.abs(pad.axes[0] ?? 0) > 0.15 ? pad.axes[0] : 0;
      this.pad.y = Math.abs(pad.axes[1] ?? 0) > 0.15 ? pad.axes[1] : 0;
      const a = !!pad.buttons[0]?.pressed;
      const start = !!pad.buttons[9]?.pressed;
      if (a && !this.pad.a) this.ping = true;
      if (start && !this.pad.start) this.pause = true;
      this.pad.a = a;
      this.pad.start = start;
      break;
    }
  }

  take(flag) {
    const value = this[flag];
    this[flag] = false;
    return value;
  }

  takePing() {
    return this.take('ping');
  }
}
