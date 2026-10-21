#!/usr/bin/env node
// Development only: serves the web export of the app (npx expo export --platform web → dist/) over HTTPS and
// forwards /api/* to a running ETS backend, so the preview, the API and the session cookie share one origin — as the
// phone sees one server. Nothing here is used by the phone app or the production server (whose CORS stays closed).
//
//   TLS_CERT=cert.pem TLS_KEY=key.pem [ETS_API=http://127.0.0.1:3000] [PORT=8443] node scripts/web-preview.mjs
//   then open https://localhost:8443 and enter https://localhost:8443 as the server address.
// A self-signed certificate is enough (openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost …); the backend
// may run with COOKIE_SECURE=true: the browser then gets the same __Host- cookie as a phone.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const api = new URL(process.env.ETS_API || 'http://127.0.0.1:3000');
const port = +(process.env.PORT || 8443);
if (!process.env.TLS_CERT || !process.env.TLS_KEY) { console.error('Set TLS_CERT and TLS_KEY (PEM files).'); process.exit(1); }
if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('No dist/index.html: run `npx expo export --platform web` first.'); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.map': 'application/json' };

function proxy(req, res) {
  const up = http.request({ host: api.hostname, port: api.port || 80, method: req.method, path: req.url,
    headers: { ...req.headers, host: api.host, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'https' } }, r => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"bad_gateway"}'); });
  req.pipe(up);
}

function file(req, res) {
  const url = decodeURIComponent(new URL(req.url, 'https://x').pathname);
  let p = path.join(root, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');   // SPA routes
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}

https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) },
  (req, res) => (req.url.startsWith('/api/') ? proxy(req, res) : file(req, res)))
  .listen(port, '127.0.0.1', () => console.log(`Preview on https://localhost:${port} → API ${api.origin}`));
