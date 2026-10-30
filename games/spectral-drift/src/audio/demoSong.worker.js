// Renders the demo track (demoSong.synth.js) off the main thread, so the menu stays
// responsive while it composes (~1 s).
import { SR, compose } from './demoSong.synth.js';

self.onmessage = () => {
  const { left, right } = compose();
  self.postMessage({ left, right, sampleRate: SR }, [left.buffer, right.buffer]);
};
