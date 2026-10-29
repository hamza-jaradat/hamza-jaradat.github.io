// Owns the renderer, scene and every visual system; driven once per frame by
// either the gameplay session or the menu's attract mode.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TRACK_HALF_WIDTH } from '../config.js';
import { damp } from '../util.js';
import { CameraRig } from './CameraRig.js';
import { NotesView } from './NotesView.js';
import { Bursts, Streaks } from './Particles.js';
import { PostFX } from './PostFX.js';
import { Ship } from './Ship.js';
import { Sky } from './Sky.js';
import { TrackView } from './TrackView.js';

export class World {
  constructor(canvas) {
    this.highQuality = true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0042);
    this.camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.1, 4000);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0x8fb8ff, 0x501050, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 6, 3);
    this.scene.add(key);

    this.spectrum = new Uint8Array(32);
    this.spectrumTex = new THREE.DataTexture(this.spectrum, 32, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.spectrumTex.minFilter = THREE.LinearFilter;
    this.spectrumTex.magFilter = THREE.LinearFilter;
    this.spectrumTex.needsUpdate = true;

    this.uniforms = {
      uTime: { value: 0 },
      uClock: { value: 0 },
      uBeat: { value: 0 },
      uOverdrive: { value: 0 },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.0042 },
      uSpectrum: { value: this.spectrumTex },
      uShipU: { value: 0.5 },
      uPixelRatio: { value: this.pixelRatio },
      uPointScale: { value: 400 },
    };

    this.sky = new Sky(this.uniforms);
    this.ship = new Ship();
    this.notes = new NotesView(this.uniforms);
    this.bursts = new Bursts(this.uniforms);
    this.streaks = new Streaks();
    this.scene.add(this.sky.group, this.ship.group, this.ship.trails, this.notes.group, this.bursts.points, this.streaks.lines);

    this.rig = new CameraRig(this.camera);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera);

    this.track = null;
    this.chart = null;
    this.trackView = null;
    this.clock = 0;
    this.overdrive = 0;
    this.skySnap = true;
    this.origin = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(high) {
    this.highQuality = high;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, high ? 2 : 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.uniforms.uPixelRatio.value = this.pixelRatio;
    this.postfx.setQuality(high);
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx.setSize(w, h, this.pixelRatio);
  }

  setTrack(track, features, chart, seed = 1) {
    if (this.trackView) {
      this.scene.remove(this.trackView.group);
      this.trackView.dispose();
    }
    this.track = track;
    this.chart = chart;
    this.trackView = new TrackView(track, features, this.uniforms, seed);
    this.scene.add(this.trackView.group);
    this.resetDynamics();
  }

  resetDynamics() {
    this.notes.reset();
    this.bursts.clear();
    this.streaks.reset();
    this.ship.reset();
    this.rig.reset();
    this.skySnap = true;
    this.overdrive = 0;
  }

  // Particle burst at lateral position x on the road at time t.
  burst(t, x, rgb, count, spread = 7, size = 0.35) {
    const track = this.track;
    track.pointAt(t, x, 0.62, this.tmp);
    track.frameAt(t, this.frame);
    this.bursts.emit(this.tmp, this.frame.T, track.speedAt(t), rgb, count, spread, size);
  }

  update(s, dt) {
    const U = this.uniforms;
    const track = this.track;
    this.clock += dt;
    this.overdrive += (s.overdrive - this.overdrive) * damp(4, dt);
    const od = this.overdrive;
    U.uClock.value = this.clock;
    U.uTime.value = s.t;
    U.uBeat.value = s.beat;
    U.uOverdrive.value = od;
    U.uShipU.value = (s.shipX + TRACK_HALF_WIDTH) / (2 * TRACK_HALF_WIDTH);
    if (s.spectrum) {
      this.spectrum.set(s.spectrum);
      this.spectrumTex.needsUpdate = true;
    }

    const horizon = this.sky.setPalette(s.intensity, od);
    U.uFogColor.value.copy(horizon).multiplyScalar(0.55);
    this.scene.fog.color.copy(U.uFogColor.value);

    this.ship.update(track, s.t, s.shipX, s.shipVX, dt, { beat: s.beat, overdrive: od, invuln: s.invuln, time: this.clock });
    this.origin.copy(this.ship.group.position);
    this.ship.updateTrails(track, this.origin, od);
    this.trackView.update(s.t, dt);
    this.notes.update(track, this.chart, s.t, this.origin, s.shipX, s.magnet, s.beat);
    this.bursts.update(dt, this.origin);
    this.streaks.update(track, s.t, this.origin, s.intensity, od);

    const v = track.speedAt(s.t);
    const speedNorm = Math.min(1, Math.max(0, (v - track.speedMin) / (track.speedMax - track.speedMin)));
    this.rig.update(track, s.t, s.shipX, dt, { speedNorm, overdrive: od, kick: s.kick });
    U.uPointScale.value = (window.innerHeight * this.pixelRatio) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));

    track.frameAt(s.t, this.frame);
    if (this.skySnap) {
      this.sky.snapHeading(this.frame.T);
      this.skySnap = false;
    }
    this.sky.update(this.camera, this.frame.T, dt);
    this.postfx.update(dt, { beat: s.beat, overdrive: od, intensity: s.intensity });
  }

  render(dt) {
    this.postfx.render(dt);
  }
}
