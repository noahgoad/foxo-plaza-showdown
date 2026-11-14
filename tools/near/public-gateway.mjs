import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../dist', import.meta.url));
const port = Number(process.env.FOX_PUBLIC_PORT || 8826);
const relayPort = Number(process.env.NEAR_RELAY_PORT || 8824);
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

function proxyRelay(req, res, url) {
  const path = url.pathname.slice('/relay'.length);
  if (!/^\/(health|capacity|create|join|leave|ready|settings|start|sync|near-auth\/[a-z-]+|near\/[a-z0-9/._-]+)$/.test(path)) {
    res.writeHead(404).end();
    return;
  }
  const headers = Object.fromEntries(['content-type', 'content-length', 'authorization', 'origin']
    .filter(name => req.headers[name] !== undefined).map(name => [name, req.headers[name]]));
  const upstream = request({ hostname: '127.0.0.1', port: relayPort,
    method: req.method, path: path + url.search, headers, timeout: 90_000 }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'The game relay is temporarily unavailable.' }));
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/relay/')) return proxyRelay(req, res, url);
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end();
    const path = decodeURIComponent(url.pathname);
    const relative = path === '/' || path === '/dist/' ? 'index.html' : path.replace(/^\/(?:dist\/)?/, '');
    if (relative !== 'index.html' && relative !== 'assets/near-fox/social-popup.html' &&
      (!/^(assets|songs|src|styles|vendor)\//.test(relative) || extname(relative) === '.html')) {
      return res.writeHead(404).end();
    }
    const file = resolve(root, relative);
    const type = mime[extname(file)];
    if (!type || !file.startsWith(root + sep) || relative.split(/[\\/]/).some(part => part.startsWith('.'))) {
      return res.writeHead(404).end();
    }
    const info = await stat(file);
    if (!info.isFile()) return res.writeHead(404).end();
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ETag: etag,
      'Cache-Control': /\.(glb|png|webp|jpg|ogg|mp3|ttf|woff2)$/.test(relative) ? 'public, max-age=3600' : 'no-cache' };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    res.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400).end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Fox public gateway listening on ${port}`));
