import './style.css';
import { Sound } from './audio.js';
import { Game } from './game.js';
import { Input } from './input.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';

const canvas = document.getElementById('view');
const pingButton = document.getElementById('ping-btn');
const sound = new Sound();
const renderer = new Renderer(canvas);
const input = new Input(canvas, pingButton);
let game = null;

const ui = new UI({
  start: () => {
    sound.ensure();
    game.newRun();
  },
  next: () => game.nextLevel(),
  title: () => game.toTitle(),
  resume: () => game.togglePause(),
});

game = new Game({
  sound,
  onLevel: (g) => renderer.reset(g),
  onState: (state, info, g) => {
    ui.show(state, info, g);
    input.takePing(); // drop a ping left over from the key that changed screens
    sound.suspend(state === 'paused');
    document.body.classList.toggle('playing', state === 'playing');
  },
});

if (matchMedia('(pointer: coarse)').matches) pingButton.hidden = false;

const pauseIfPlaying = () => {
  if (game.state === 'playing') game.togglePause();
};
document.addEventListener('visibilitychange', () => document.hidden && pauseIfPlaying());
addEventListener('blur', pauseIfPlaying);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  input.poll();
  if (input.take('pause') && (game.state === 'playing' || game.state === 'paused')) game.togglePause();
  if (input.take('mute')) sound.toggleMute();
  game.update(dt, input, () => renderer.toScreen(game.player.x, game.player.y));
  renderer.draw(game, dt);
  ui.hud(game);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.echo = { game, renderer, input, sound }; // handy in the console
