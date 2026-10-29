// Main-thread side of the analysis: downmix, decimate, and hand off to a worker.

export function analyzeBuffer(audioBuffer, onProgress) {
  const { samples, sampleRate } = prepareSamples(audioBuffer);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.p);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(unpack(msg.result, audioBuffer.duration));
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker failed'));
    };
    worker.postMessage({ samples, sampleRate }, [samples.buffer]);
  });
}

// Mono mix at roughly 22 kHz is plenty for onset and loudness analysis.
function prepareSamples(buffer) {
  const factor = Math.max(1, Math.round(buffer.sampleRate / 22050));
  const len = Math.floor(buffer.length / factor);
  const out = new Float32Array(len);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const scale = 1 / (channels.length * factor);
  for (let i = 0; i < len; i++) {
    const base = i * factor;
    let s = 0;
    for (const ch of channels) for (let j = 0; j < factor; j++) s += ch[base + j];
    out[i] = s * scale;
  }
  return { samples: out, sampleRate: buffer.sampleRate / factor };
}

function unpack(r, duration) {
  const onsets = [];
  for (let i = 0; i < r.onsets.length; i += 3) {
    onsets.push({ t: r.onsets[i], s: r.onsets[i + 1], b: r.onsets[i + 2] });
  }
  return { ...r, onsets, duration };
}
