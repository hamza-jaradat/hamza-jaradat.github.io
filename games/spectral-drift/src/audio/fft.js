// Iterative radix-2 FFT that returns magnitudes of a real input frame.
export class FFT {
  constructor(size) {
    const levels = Math.log2(size);
    if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      let x = i;
      for (let j = 0; j < levels; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r;
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  magnitudes(input, out) {
    const n = this.size;
    const { re, im, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      re[rev[i]] = input[i];
      im[i] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = start, k = 0; j < start + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
    const half = n >> 1;
    for (let i = 0; i < half; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
}
