// DOM overlays (title, cleared, game over, pause) and the HUD.
import { MAX_LIVES } from './game.js';

const SCREEN_FOR_STATE = { title: 'title', levelDone: 'level', gameOver: 'over', paused: 'pause' };

export class UI {
  constructor(actions) {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.screens = { title: $('screen-title'), level: $('screen-level'), over: $('screen-over'), pause: $('screen-pause') };
    this.hudEl = $('hud');
    this.last = {};

    const bind = (id, action) =>
      $(id).addEventListener('click', (e) => {
        e.currentTarget.blur();
        action();
      });
    bind('btn-start', actions.start);
    bind('btn-next', actions.next);
    bind('btn-retry', actions.start);
    bind('btn-title', actions.title);
    bind('btn-resume', actions.resume);
    bind('btn-quit', actions.title);

    // Enter or Space presses the main button of whichever card is showing.
    addEventListener('keydown', (e) => {
      if ((e.code !== 'Enter' && e.code !== 'Space') || e.repeat) return;
      const open = Object.values(this.screens).find((s) => !s.hidden);
      if (!open) return;
      e.preventDefault();
      open.querySelector('.btn.primary')?.click();
    });

    // The arcade's build adds this meta tag; the link only shows when served from there.
    const hubUrl = document.querySelector('meta[name="hub-url"]')?.content;
    if (hubUrl) {
      $('hub-link').href = hubUrl;
      $('hub-link').hidden = false;
    }
  }

  show(state, info, game) {
    const name = SCREEN_FOR_STATE[state];
    for (const [key, el] of Object.entries(this.screens)) el.hidden = key !== name;
    this.hudEl.hidden = state === 'title';
    if (state === 'title') {
      this.$('title-best').textContent = game.best ? `Best score ${game.best.toLocaleString()}` : '';
    } else if (state === 'levelDone') {
      this.fillLevel(info);
    } else if (state === 'gameOver') {
      this.$('over-eyebrow').textContent = `Lost in cavern ${info.level}`;
      this.$('over-score').textContent = info.score.toLocaleString();
      this.$('over-best').textContent = info.newBest ? 'New best score' : `Best score ${info.best.toLocaleString()}`;
      this.$('over-best').classList.toggle('new', info.newBest);
    }
  }

  fillLevel(info) {
    this.$('level-eyebrow').textContent = `Cavern ${info.level}`;
    const time = `${Math.floor(info.time / 60)}:${String(Math.floor(info.time % 60)).padStart(2, '0')}`;
    const rows = [
      ['Spores', info.spores],
      ['Pings', info.pings],
      ['Time', time],
      ['Silence bonus', `+${info.bonus.silence}`],
      ['Speed bonus', `+${info.bonus.speed}`],
      ['Unharmed', info.bonus.unharmed ? `+${info.bonus.unharmed}` : '—'],
    ];
    const list = this.$('level-stats');
    list.replaceChildren(
      ...rows.map(([label, value]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        row.append(dt, dd);
        return row;
      }),
    );
    this.$('level-total').textContent = info.score.toLocaleString();
    this.$('level-healed').hidden = !info.healed;
  }

  hud(game) {
    if (game.state === 'title') return;
    const values = {
      level: `Cavern ${game.level}`,
      spores: `${game.collected} / ${game.spores.length}`,
      score: game.score.toLocaleString(),
      lives: game.lives,
    };
    const L = this.last;
    if (L.level !== values.level) this.$('hud-level').textContent = values.level;
    if (L.spores !== values.spores) this.$('hud-spores').textContent = values.spores;
    if (L.score !== values.score) this.$('hud-score').textContent = values.score;
    if (L.lives !== values.lives) {
      const lives = this.$('hud-lives');
      lives.replaceChildren(
        ...Array.from({ length: MAX_LIVES }, (_, i) => {
          const dot = document.createElement('i');
          dot.className = i < values.lives ? 'life on' : 'life';
          return dot;
        }),
      );
      lives.setAttribute('aria-label', `${values.lives} of ${MAX_LIVES} lights left`);
    }
    this.last = values;
  }
}
