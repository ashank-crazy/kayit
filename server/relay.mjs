/**
 * A small NIP-01 relay so Kayit runs fully offline on a laptop or a community box.
 * Verifies signatures, stores events in memory with an append-only file, handles replaceable (NIP-16/33)
 * events, and enforces size and rate limits. Not meant for the open internet at scale.
 */
import { WebSocketServer } from 'ws';
import { verifyEvent } from 'nostr-tools/pure';
import fs from 'node:fs';
import path from 'node:path';

const MAX_EVENT_BYTES = 128 * 1024;
const MAX_SUBS = 20;
const MAX_EVENTS_PER_MIN = 120;

function matches(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since && ev.created_at < f.since) return false;
  if (f.until && ev.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (k[0] !== '#' || k.length !== 2) continue;
    const vals = f[k];
    if (!Array.isArray(vals)) return false;
    if (!ev.tags.some((t) => t[0] === k[1] && vals.includes(t[1]))) return false;
  }
  return true;
}

function replaceKey(ev) {
  const k = ev.kind;
  if (k === 0 || k === 3 || (k >= 10000 && k < 20000)) return `${k}:${ev.pubkey}`;
  if (k >= 30000 && k < 40000) return `${k}:${ev.pubkey}:${ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`;
  return null;
}

export function createRelay({ server, port, path: wsPath = '/', dataFile } = {}) {
  const events = new Map(); // id -> event
  const replaceable = new Map(); // key -> id

  function store(ev) {
    if (events.has(ev.id)) return false;
    if (ev.kind >= 20000 && ev.kind < 30000) return true; // ephemeral: broadcast only
    const rk = replaceKey(ev);
    if (rk) {
      const prevId = replaceable.get(rk);
      const prev = prevId && events.get(prevId);
      if (prev && prev.created_at >= ev.created_at) return false;
      if (prevId) events.delete(prevId);
      replaceable.set(rk, ev.id);
    }
    events.set(ev.id, ev);
    return true;
  }

  if (dataFile) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    if (fs.existsSync(dataFile)) {
      for (const line of fs.readFileSync(dataFile, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          store(JSON.parse(line));
        } catch {
          /* skip corrupt line */
        }
      }
    }
  }
  const log = dataFile ? fs.createWriteStream(dataFile, { flags: 'a' }) : null;

  const wss = server ? new WebSocketServer({ server, path: wsPath }) : new WebSocketServer({ port });
  const clients = new Set();

  wss.on('connection', (ws) => {
    const subs = new Map();
    const client = { ws, subs, window: Date.now(), count: 0 };
    clients.add(client);
    const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

    ws.on('message', (raw) => {
      if (raw.length > MAX_EVENT_BYTES) return send(['NOTICE', 'message too large']);
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(['NOTICE', 'invalid json']);
      }
      if (!Array.isArray(msg)) return;
      const [type] = msg;
      if (type === 'EVENT') {
        const ev = msg[1];
        if (Date.now() - client.window > 60_000) {
          client.window = Date.now();
          client.count = 0;
        }
        if (++client.count > MAX_EVENTS_PER_MIN) return send(['OK', ev?.id ?? '', false, 'rate-limited: slow down']);
        if (!ev || typeof ev !== 'object' || !verifyEvent(ev)) return send(['OK', ev?.id ?? '', false, 'invalid: bad signature']);
        const fresh = store(ev);
        send(['OK', ev.id, true, fresh ? '' : 'duplicate:']);
        if (!fresh) return;
        if (log && !(ev.kind >= 20000 && ev.kind < 30000)) log.write(JSON.stringify(ev) + '\n');
        for (const c of clients) {
          for (const [sid, filters] of c.subs) {
            if (filters.some((f) => matches(ev, f))) c.ws.readyState === 1 && c.ws.send(JSON.stringify(['EVENT', sid, ev]));
          }
        }
      } else if (type === 'REQ') {
        const [, sid, ...filters] = msg;
        if (typeof sid !== 'string' || sid.length > 64) return;
        if (!subs.has(sid) && subs.size >= MAX_SUBS) return send(['CLOSED', sid, 'error: too many subscriptions']);
        subs.set(sid, filters);
        for (const f of filters) {
          const limit = Math.min(Number(f.limit) || 500, 500);
          const found = [...events.values()].filter((ev) => matches(ev, f)).sort((a, b) => b.created_at - a.created_at).slice(0, limit);
          for (const ev of found) send(['EVENT', sid, ev]);
        }
        send(['EOSE', sid]);
      } else if (type === 'CLOSE') {
        subs.delete(msg[1]);
      }
    });
    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  return {
    wss,
    size: () => events.size,
    close: () =>
      new Promise((resolve) => {
        for (const c of clients) c.ws.terminate();
        log?.end();
        wss.close(() => resolve());
      }),
  };
}

// `node server/relay.mjs` runs it standalone on ws://127.0.0.1:7777
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 7777);
  createRelay({ port, dataFile: process.env.RELAY_DATA || 'data/relay.jsonl' });
  console.log(`kayit relay listening on ws://127.0.0.1:${port}`);
}
