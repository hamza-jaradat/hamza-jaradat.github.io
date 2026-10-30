// Dev-server routes behind the label page (bench/label.html): list the songs folder,
// serve its audio, and read and write each song's labels. Only active under `vite` (dev),
// never in the built game.
import { createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AUDIO, listSongs, readLabels, songsDir, writeLabels } from './songs.js';

const MAX_BODY = 5 * 1024 * 1024;

export function benchSongs() {
  return {
    name: 'bench-songs',
    apply: 'serve',
    configureServer(server) {
      const dir = songsDir();
      server.middlewares.use('/__bench', (req, res) => {
        handle(dir, req, res).catch((err) => send(res, 500, { error: err.message }));
      });
    },
  };
}

async function handle(dir, req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/songs' && req.method === 'GET') return send(res, 200, { dir, songs: listSongs(dir) });

  // Every other route names one song file in the folder, and nothing outside it.
  const file = url.searchParams.get('file') ?? '';
  if (file !== basename(file) || !AUDIO.test(file) || !existsSync(join(dir, file))) return send(res, 404, { error: 'No such song' });

  if (url.pathname === '/audio' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(join(dir, file)).pipe(res);
    return;
  }
  if (url.pathname === '/labels' && req.method === 'GET') return send(res, 200, { labels: readLabels(dir, file) });
  if (url.pathname === '/labels' && req.method === 'PUT') {
    const body = await readBody(req);
    return send(res, 200, { labels: writeLabels(dir, file, JSON.parse(body)) });
  }
  send(res, 404, { error: 'Not found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Labels too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
