/**
 * One process for a laptop, a community box or a container: serves the built app, runs a Nostr relay
 * at /relay, and tells the app which mint and relays to use via /kayit-config.json.
 *
 *   PORT          default 8080
 *   KAYIT_MINT    default https://testnut.cashu.space (test mint: fake sats)
 *   KAYIT_RELAYS  extra relays, comma separated (the built-in /relay is always first)
 *   RELAY_DATA    default data/relay.jsonl
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createRelay } from './relay.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT || 8080);
const MINT = process.env.KAYIT_MINT || 'https://testnut.cashu.space';
const EXTRA = (process.env.KAYIT_RELAYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TEST_MINT = process.env.KAYIT_TEST_MINT ? process.env.KAYIT_TEST_MINT === '1' : /testnut|localhost|127\.0\.0\.1|mint:/.test(MINT);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // the camera is only for scanning envelopes at a ceremony, and only for this page
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first (or `npm start`, which builds).');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/kayit-config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY });
    return res.end(JSON.stringify({ mint: MINT, relays: ['/relay', ...EXTRA], testMint: TEST_MINT }));
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok events=${relay.size()}`);
  }
  let file;
  try {
    file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  } catch {
    res.writeHead(400);
    return res.end(); // malformed %-encoding
  }
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  const asset = load(file);
  const gzip = asset.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gzip ? asset.gz : asset.raw;
  res.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': body.length,
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    ...SECURITY,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

/** dist/ is small and immutable while the server runs: keep each file (and its gzip) in memory. */
const cache = new Map();
function load(file) {
  let a = cache.get(file);
  if (!a) {
    const raw = fs.readFileSync(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const gz = /text|json|svg|manifest/.test(type) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null;
    a = { raw, gz, type };
    cache.set(file, a);
  }
  return a;
}

const relay = createRelay({ server, path: '/relay', dataFile: process.env.RELAY_DATA || 'data/relay.jsonl' });

server.listen(PORT, () => {
  console.log(`Kayit on http://localhost:${PORT}`);
  console.log(`  relay   ws://localhost:${PORT}/relay`);
  console.log(`  mint    ${MINT}${TEST_MINT ? ' (test mint: no real sats)' : ''}`);
});
