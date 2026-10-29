export const DEMO_TITLE = 'First Light (built-in demo)';

let cached = null;

// Renders the procedural demo song in a worker and wraps it in an AudioBuffer.
export function generateDemoSong() {
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./demoSong.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      worker.terminate();
      const { left, right, sampleRate } = e.data;
      const buffer = new AudioBuffer({ length: left.length, numberOfChannels: 2, sampleRate });
      buffer.copyToChannel(left, 0);
      buffer.copyToChannel(right, 1);
      resolve(buffer);
    };
    worker.onerror = (e) => {
      worker.terminate();
      cached = null;
      reject(new Error(e.message || 'Demo synthesis failed'));
    };
    worker.postMessage({});
  });
  return cached;
}
