/**
 * Nostr transport. Gifts and receipts travel in NIP-59 gift wraps (kind 1059): the relay sees a random
 * one-time key writing to the recipient, nothing else. Each message is wrapped twice, once for the other
 * person and once for myself, so a restore on a new phone finds both sides of every line.
 * The full notebook is also backed up as one NIP-44 encrypted, replaceable event (NIP-78, kind 30078).
 */
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import * as nip44 from 'nostr-tools/nip44';
import { KIND_ENVELOPE, KIND_BACKUP, KIND_INVITE, BACKUP_D, parseEnvelope, type EnvelopePayload, now, bytesToB64Url, b64UrlToBytes } from './protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deflate, inflate } from './zip';

export interface Inbound {
  wrapId: string;
  senderPk: string;
  payload: EnvelopePayload;
  at: number;
}

let pool: SimplePool | null = null;
export function getPool(): SimplePool {
  if (!pool) pool = new SimplePool({ enablePing: true, enableReconnect: true });
  return pool;
}

/**
 * Resolves as soon as ONE relay accepts (slow or dead relays must not block a guest at a ceremony);
 * the other relays keep receiving it in the background.
 */
async function publishAll(relays: string[], ev: NostrEvent): Promise<number> {
  const pubs = getPool().publish(relays, ev, { maxWait: 6000 });
  try {
    await Promise.any(pubs);
  } catch {
    throw new Error('no relay accepted the message');
  }
  return pubs.length;
}

/** Send a payload to `recipientPk` and a copy to myself. Returns the number of relays that took it. */
export async function sendEnvelope(sk: Uint8Array, myPk: string, recipientPk: string, payload: EnvelopePayload, relays: string[]): Promise<number> {
  const rumor = { kind: KIND_ENVELOPE, content: JSON.stringify(payload), tags: [['p', recipientPk]], created_at: now() };
  const toThem = wrapEvent(rumor, sk, recipientPk);
  if (recipientPk !== myPk) {
    // my own copy, for restore on a new phone; never blocks the send
    publishAll(relays, wrapEvent(rumor, sk, myPk)).catch(() => 0);
  }
  return publishAll(relays, toThem);
}

export function openWrap(wrap: NostrEvent, sk: Uint8Array): Inbound | null {
  try {
    const rumor = unwrapEvent(wrap, sk);
    if (rumor.kind !== KIND_ENVELOPE) return null;
    const payload = parseEnvelope(rumor.content);
    if (!payload) return null;
    return { wrapId: wrap.id, senderPk: rumor.pubkey, payload, at: rumor.created_at };
  } catch {
    return null;
  }
}

/** Live inbox. NIP-59 back-dates wraps by up to 2 days, so `since` is widened accordingly. */
export function subscribeInbox(
  sk: Uint8Array,
  pk: string,
  relays: string[],
  sinceSec: number | undefined,
  onMessage: (m: Inbound) => void,
  onReady?: () => void,
): () => void {
  const seen = new Set<string>();
  const filter: { kinds: number[]; '#p': string[]; since?: number } = { kinds: [1059], '#p': [pk] };
  if (sinceSec) filter.since = sinceSec - 3 * 24 * 3600;
  const sub = getPool().subscribe(relays, filter, {
    onevent(ev) {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      const m = openWrap(ev, sk);
      if (m) onMessage(m);
    },
    oneose() {
      onReady?.();
    },
  });
  return () => sub.close();
}

/* -------------------------------------------------------------- encrypted backup */

/*
 * The backup is the whole notebook, so it grows with every gift (~2 KB per signed line) while NIP-44 caps
 * one message at 64 KB. v2 compresses it and splits it into numbered parts plus a manifest, all
 * NIP-44 encrypted to myself. v1 (one event) is still read for older backups.
 *
 * Parts live in two slots, a and b. A new backup is written into the slot the current manifest does not
 * use, and the manifest is switched last, so a save cut off half-way (tab closed, network gone) never
 * damages the backup that is already there.
 */
const BACKUP_V2 = 'kayit:backup:v2';
const BACKUP_PART_CHARS = 30_000; // keeps each encrypted event under common 64 KB relay limits
const BACKUP_MAX_PARTS = 24;

export async function packBackup(state: unknown): Promise<{ id: string; parts: string[] }> {
  const packed = bytesToB64Url(await deflate(new TextEncoder().encode(JSON.stringify(state))));
  const parts: string[] = [];
  for (let i = 0; i < packed.length; i += BACKUP_PART_CHARS) parts.push(packed.slice(i, i + BACKUP_PART_CHARS));
  if (parts.length > BACKUP_MAX_PARTS) throw new Error('backup too large');
  return { id: bytesToHex(sha256(new TextEncoder().encode(packed))).slice(0, 16), parts };
}

export async function unpackBackup<T>(id: string, parts: string[]): Promise<T> {
  const packed = parts.join('');
  if (bytesToHex(sha256(new TextEncoder().encode(packed))).slice(0, 16) !== id) throw new Error('backup parts do not match');
  return JSON.parse(new TextDecoder().decode(await inflate(b64UrlToBytes(packed)))) as T;
}

type Slot = 'a' | 'b';
const partTag = (slot: Slot, i: number) => `${BACKUP_V2}:${slot}:${i}`;
interface Manifest {
  id: string;
  n: number;
  slot: Slot;
}

function readManifest(ev: NostrEvent | undefined, key: Uint8Array): Manifest | null {
  if (!ev) return null;
  try {
    const m = JSON.parse(nip44.decrypt(ev.content, key)) as Manifest;
    return typeof m.id === 'string' && Number.isInteger(m.n) && m.n > 0 && m.n <= BACKUP_MAX_PARTS && (m.slot === 'a' || m.slot === 'b') ? m : null;
  } catch {
    return null;
  }
}

function newest(events: NostrEvent[]): Map<string, NostrEvent> {
  const latest = new Map<string, NostrEvent>();
  for (const ev of events) {
    const d = ev.tags.find((t) => t[0] === 'd')?.[1];
    if (d && (!latest.has(d) || latest.get(d)!.created_at < ev.created_at)) latest.set(d, ev);
  }
  return latest;
}

export async function publishBackup(sk: Uint8Array, pk: string, relays: string[], state: unknown): Promise<number> {
  const key = nip44.getConversationKey(sk, pk);
  const { id, parts } = await packBackup(state);
  // write into the slot the live manifest does not point to
  const live = await getPool()
    .querySync(relays, { kinds: [KIND_BACKUP], authors: [pk], '#d': [BACKUP_V2] }, { maxWait: 3000 })
    .then((evs) => readManifest(newest(evs).get(BACKUP_V2), key))
    .catch(() => null);
  const slot: Slot = live?.slot === 'a' ? 'b' : 'a';
  const at = now();
  const part = (i: number) =>
    finalizeEvent({ kind: KIND_BACKUP, created_at: at, tags: [['d', partTag(slot, i)]], content: nip44.encrypt(JSON.stringify({ id, i, p: parts[i] }), key) }, sk);
  for (let i = 0; i < parts.length; i++) await publishAll(relays, part(i));
  // the manifest goes last, so a reader never sees a manifest whose parts are missing
  const manifest = finalizeEvent({ kind: KIND_BACKUP, created_at: at, tags: [['d', BACKUP_V2]], content: nip44.encrypt(JSON.stringify({ id, n: parts.length, slot } satisfies Manifest), key) }, sk);
  return publishAll(relays, manifest);
}

export async function fetchBackup<T>(sk: Uint8Array, pk: string, relays: string[]): Promise<{ state: T; at: number } | null> {
  const ds = [BACKUP_D, BACKUP_V2];
  for (const slot of ['a', 'b'] as const) for (let i = 0; i < BACKUP_MAX_PARTS; i++) ds.push(partTag(slot, i));
  const events = await getPool().querySync(relays, { kinds: [KIND_BACKUP], authors: [pk], '#d': ds }, { maxWait: 6000 });
  const latest = newest(events);
  const key = nip44.getConversationKey(sk, pk);
  const manifest = latest.get(BACKUP_V2);
  const m = readManifest(manifest, key);
  if (manifest && m) {
    try {
      const parts: string[] = [];
      for (let i = 0; i < m.n; i++) {
        const ev = latest.get(partTag(m.slot, i));
        const p = ev ? (JSON.parse(nip44.decrypt(ev.content, key)) as { id: string; i: number; p: string }) : null;
        if (!p || p.id !== m.id || p.i !== i) throw new Error('missing part');
        parts.push(p.p);
      }
      return { state: await unpackBackup<T>(m.id, parts), at: manifest.created_at };
    } catch {
      /* parts lost by every relay: fall back to v1 if there is one */
    }
  }
  const v1 = latest.get(BACKUP_D);
  if (!v1) return null;
  return { state: JSON.parse(nip44.decrypt(v1.content, key)) as T, at: v1.created_at };
}

/** Everything ever wrapped to me, for a full rebuild after restore. */
export async function fetchInbox(sk: Uint8Array, pk: string, relays: string[]): Promise<Inbound[]> {
  const wraps = await getPool().querySync(relays, { kinds: [1059], '#p': [pk] }, { maxWait: 6000 });
  return wraps.map((w) => openWrap(w, sk)).filter((m): m is Inbound => !!m);
}

/* -------------------------------------------------------------- compact invitations */

export function publishInvite(relays: string[], carrier: NostrEvent): Promise<number> {
  return publishAll(relays, carrier);
}

export function fetchInviteCarriers(relays: string[], carrierPk: string): Promise<NostrEvent[]> {
  return getPool().querySync(relays, { kinds: [KIND_INVITE], authors: [carrierPk], limit: 10 }, { maxWait: 6000 });
}

export function closePool(relays: string[]): void {
  pool?.close(relays);
}
