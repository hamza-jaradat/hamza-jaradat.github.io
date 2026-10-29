# Arcade

A launcher for browser games, published as one GitHub Pages site. Every folder in
`games/` becomes a card on the launcher page and a playable page at `games/<folder>/`.

```
games/            one folder per game (each with a game.json)
hub/              the launcher page template, styles and filters
templates/starter starter game copied by `npm run new-game`
scripts/          build.mjs (builds everything) and new-game.mjs
site.json         launcher title and tagline
```

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs every game's dependencies in one go (npm workspaces) |
| `npm run dev -w games/<folder>` | Works on one game with hot reload |
| `npm run build` | Builds every game plus the launcher into `dist/` |
| `npm run preview` | Serves `dist/` at http://localhost:4173, the way GitHub Pages will |
| `npm run new-game -- "My Game"` | Creates `games/my-game/` from the starter template |

## Adding a game

**From the template:** `npm run new-game -- "My Game"` creates a small Vite game,
links it into the workspace, and it shows up on the launcher after the next build.

**Bring your own:** put any game in `games/<folder>/` and add a `game.json`.

- If the folder has a `package.json` with a `build` script, the build runs it and
  publishes its output folder (`dist/` unless `output` says otherwise).
- Otherwise the folder is published as-is, which suits plain HTML/JS games.
- The folder name becomes the URL, so use lowercase letters, numbers and dashes.
- Use relative asset paths so the game works under `games/<folder>/`. For Vite games,
  set `base: './'` in `vite.config.js` (the template already does).

### game.json

| Field | Purpose |
| --- | --- |
| `title` | Name on the card |
| `description` | One or two sentences |
| `tags` | List of words; used by the search and tag filters (shown from 4 games up) |
| `controls` | Shown on the featured card |
| `cover` | Image file in the game folder, 16:9 works best. Without one, the card gets a letter tile |
| `accent` | Hex color for the letter tile, like `"#46d9ff"` |
| `added` | `YYYY-MM-DD`; the newest game is featured at the top |
| `hidden` | `true` to publish a work in progress without listing it |
| `output` | Build output folder, if it isn't `dist` |

### "All games" link

The build adds `<meta name="hub-url" content="../../">` to every game's `index.html`.
A game can read it to show a link back to the launcher only when it's served from
here; Spectral Drift and the starter template already do.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
   - Name it `<username>.github.io` to put the launcher at `https://<username>.github.io/`.
   - Any other name, like `arcade`, puts it at `https://<username>.github.io/arcade/`.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.

After that, every push to `main` rebuilds all games and redeploys the site
(`.github/workflows/deploy.yml`). On a free GitHub plan the repository must be public.
