// Serves the built arcade (dist/) to other devices on your network, with the CORS
// header that lets another arcade's launcher read its game list.
// Usage: npm run serve                     builds, then serves on port 8080
//        node scripts/serve.mjs --port 9000 --host 127.0.0.1 --dir dist
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(option('port', process.env.PORT || 8080));
const host = option('host', '0.0.0.0');
const dir = path.resolve(root, option('dir', 'dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  // Older Chrome versions send a private-network preflight before reaching a LAN address.
  'Access-Control-Allow-Private-Network': 'true',
};

if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`Nothing to serve in ${dir}. Run npm run build first.`);
  process.exit(1);
}

function send(res, status, headers = {}, body = '') {
  res.writeHead(status, { ...CORS, ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, { 'Access-Control-Max-Age': '600' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);

  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400);
  }
  if (pathname.includes('\0')) return send(res, 400);
  let file = path.join(dir, pathname);
  if (file !== dir && !file.startsWith(dir + path.sep)) return send(res, 403);

  fs.stat(file, (err, stat) => {
    if (!err && stat.isDirectory()) {
      // Like GitHub Pages: add the trailing slash so the game's relative URLs resolve.
      if (!url.pathname.endsWith('/')) return send(res, 301, { Location: `${url.pathname}/${url.search}` });
      file = path.join(file, 'index.html');
    }
    fs.stat(file, (err2, stat2) => {
      if (err2 || !stat2.isFile()) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      res.writeHead(200, {
        ...CORS,
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat2.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: npm run serve -- --port ${port + 1}`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`\nServing ${path.relative(root, dir) || dir}/ at http://localhost:${port}/`);
  if (host === '0.0.0.0') {
    const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
      (list ?? []).filter((i) => (i.family === 'IPv4' || i.family === 4) && !i.internal).map((i) => ({ name, ip: i.address })),
    );
    if (addresses.length) {
      console.log('\nFrom another device, enter one of these under "Other arcades":');
      for (const { name, ip } of addresses) console.log(`  ${ip}:${port}   (${name})`);
    }
    console.log('\nIf other devices can\'t connect, allow Node.js through your firewall.');
  }
  console.log('Press Ctrl+C to stop.\n');
});
