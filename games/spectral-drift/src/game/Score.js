import { KIND, OVERDRIVE_DURATION } from '../config.js';

export const MAX_MULTIPLIER = 8;
const COMBO_PER_STEP = 10;
const HOLD_RATE = 30; // points per second held, before the multiplier

export class Score {
  constructor(chart) {
    this.chart = chart;
    this.reset();
  }

  reset() {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.multiplier = 1;
    this.collected = 0;
    this.missed = 0;
    this.hits = 0;
    this.smashed = 0;
    this.charge = 0;
    this.overdrive = 0; // seconds remaining
    this.holdsDone = 0;
    this.holdCarry = 0; // fractional hold points not yet added to the score
  }

  get overdriveActive() {
    return this.overdrive > 0;
  }

  collect(obj) {
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.multiplier = Math.min(MAX_MULTIPLIER, 1 + Math.floor(this.combo / COMBO_PER_STEP));
    const points = obj.value * this.multiplier * (this.overdriveActive ? 2 : 1);
    this.score += points;
    this.collected++;
    if (!this.overdriveActive) this.charge = Math.min(1, this.charge + (obj.kind === KIND.POWER ? 0.15 : 0.025));
    return points;
  }

  // Points for every moment a hold is kept; letting go early costs nothing but those points.
  hold(seconds) {
    this.holdCarry += HOLD_RATE * seconds * this.multiplier * (this.overdriveActive ? 2 : 1);
    const whole = Math.floor(this.holdCarry);
    this.score += whole;
    this.holdCarry -= whole;
  }

  holdComplete(obj) {
    this.holdsDone++;
    const points = Math.round(obj.hold * HOLD_RATE) * this.multiplier * (this.overdriveActive ? 2 : 1);
    this.score += points;
    if (!this.overdriveActive) this.charge = Math.min(1, this.charge + 0.02);
    return points;
  }

  miss() {
    this.missed++;
    this.combo = 0;
    this.multiplier = 1;
  }

  hit() {
    this.hits++;
    this.combo = 0;
    this.multiplier = 1;
    this.charge = Math.max(0, this.charge - 0.25);
  }

  smash() {
    this.smashed++;
    const points = 30 * this.multiplier;
    this.score += points;
    return points;
  }

  activateOverdrive() {
    if (this.charge < 1 || this.overdriveActive) return false;
    this.overdrive = OVERDRIVE_DURATION;
    this.charge = 0;
    return true;
  }

  update(dt) {
    if (this.overdrive > 0) this.overdrive = Math.max(0, this.overdrive - dt);
  }

  get accuracy() {
    const total = this.chart.notesTotal;
    return total ? this.collected / total : 1;
  }

  grade() {
    const a = this.accuracy - this.hits * 0.01;
    if (a >= 0.95) return 'S';
    if (a >= 0.88) return 'A';
    if (a >= 0.75) return 'B';
    if (a >= 0.6) return 'C';
    return 'D';
  }
}
