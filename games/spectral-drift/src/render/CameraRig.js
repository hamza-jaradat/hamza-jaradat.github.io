// Chase camera that rides the road's frame, rolls with banking, widens its
// field of view with speed and shakes on impacts.
import * as THREE from 'three';
import { damp } from '../util.js';

const BACK = 6.2;
const AHEAD = 24;
const HEIGHT = 2.35;

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.up = new THREE.Vector3(0, 1, 0);
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };
    this.lateral = 0;
    this.shake = 0;
    this.fov = camera.fov;
    this.fovKick = 0;
    this.snap = true;
  }

  reset() {
    this.snap = true;
    this.shake = 0;
    this.fovKick = 0;
  }

  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount);
  }

  // A sudden widening of the view that springs back (drops).
  punch(amount = 1) {
    this.fovKick = Math.max(this.fovKick, amount);
  }

  update(track, t, shipX, dt, { speedNorm = 0, overdrive = 0, kick = 0, tension = 0 } = {}) {
    const v = Math.max(1, track.speedAt(t));
    const tc = t - BACK / v;
    const ta = t + AHEAD / v;
    if (this.snap) {
      this.lateral = shipX * 0.55;
      track.frameAt(tc, this.frame);
      this.up.copy(this.frame.U);
      this.snap = false;
    }
    this.lateral += (shipX * 0.55 - this.lateral) * damp(8, dt);
    track.pointAt(tc, this.lateral, HEIGHT, this.pos);
    track.pointAt(ta, this.lateral * 0.4, 0.1, this.look);
    track.frameAt(tc, this.frame);
    this.up.lerp(this.frame.U, damp(5, dt)).normalize();

    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 0.45 + kick * 0.035 + tension * tension * 0.03;
    if (s > 0.0005) {
      this.pos.x += (Math.random() - 0.5) * s;
      this.pos.y += (Math.random() - 0.5) * s;
      this.pos.z += (Math.random() - 0.5) * s;
    }

    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.up.copy(this.up);
    cam.lookAt(this.look);

    // Speed widens the view; a build-up narrows it; a drop punches it wide for a moment.
    const targetFov = 64 + speedNorm * 14 + overdrive * 6 - tension * 7;
    this.fov += (targetFov - this.fov) * damp(3, dt);
    this.fovKick = Math.max(0, this.fovKick - dt * 1.2);
    const fov = this.fov + this.fovKick * this.fovKick * 16;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
