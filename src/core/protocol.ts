/**
 * Kayit protocol: three signed Nostr events and one transport envelope.
 *
 *  - Ceremony   kind 31923 (NIP-52 time-based calendar event), signed by the host. Travels inside the
 *               invitation link fragment, so relays and web servers never see it.
 *  - Gift       kind 9330, signed by the GIVER: "I gave N francs to X at ceremony Y" (+ hash of the ecash token).
 *  - Receipt    kind 9331, signed by the HOST: "I received gift <id>" (status redeemed | received).
 *  - Envelope   kind 9332 rumor, carried in a NIP-59 gift wrap so relays see neither sender nor content.
 *
 * A notebook line is "co-signed" when the gift and its receipt are both present and valid. Neither side can
 * later inflate, deny or invent a line, and the whole notebook can be rebuilt from relays with the 12 words.
 */
import { finalizeEvent, getPublicKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const KIND_CEREMONY = 31923;
export const KIND_GIFT = 9330;
export const KIND_RECEIPT = 9331;
export const KIND_ENVELOPE = 9332;
export const KIND_BACKUP = 30078;
export const BACKUP_D = 'kayit:backup:v1';

export type CeremonyType = 'ngente' | 'mariage' | 'deuil' | 'autre';
export type GiftMethod = 'ecash' | 'cash';

export interface Ceremony {
  id: string;
  ref: string; // "31923:<hostPk>:<id>"
  hostPk: string;
  hostName: string;
  title: string;
  type: CeremonyType;
  start: number; // unix seconds
  lockPk: string;
  mint: string;
  relays: string[];
  capXof?: number;
  event: NostrEvent;
}

export interface Gift {
  id: string;
  giverPk: string;
  giverName: string;
  hostPk: string;
  ceremonyRef: string;
  xof: number;
  method: GiftMethod;
  sats?: number;
  tokenHash?: string;
  message: string;
  createdAt: number;
  event: NostrEvent;
}

export interface Receipt {
  id: string;
  giftId: string;
  hostPk: string;
  giverPk: string;
  xof: number;
  status: 'redeemed' | 'received';
  message: string;
  createdAt: number;
  event: NostrEvent;
}

export type EnvelopePayload =
  | { t: 'gift'; gift: NostrEvent; token?: string; ceremony?: NostrEvent }
  | { t: 'receipt'; receipt: NostrEvent; gift: NostrEvent; ceremony?: NostrEvent }
  | { t: 'reject'; giftId: string; reason: string; hostPk: string };

const MAX_TEXT = 280;
const MAX_XOF = 50_000_000;

/**
 * nostr-tools caches a "verified" flag on the event object, and object spread copies it. Verify a clean
 * copy so an edited event can never ride on an earlier successful check.
 */
export function strictVerify(ev: NostrEvent): boolean {
  if (!ev || typeof ev !== 'object') return false;
  const clean = {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  } as NostrEvent;
  if (!Array.isArray(clean.tags) || !clean.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  if (typeof clean.content !== 'string' || !Number.isSafeInteger(clean.created_at)) return false;
  try {
    return verifyEvent(clean);
  } catch {
    return false;
  }
}

function tag(ev: NostrEvent, name: string): string[] | undefined {
  return ev.tags.find((t) => t[0] === name);
}
function tagValue(ev: NostrEvent, name: string): string | undefined {
  return tag(ev, name)?.[1];
}
function tagValues(ev: NostrEvent, name: string): string[] {
  return ev.tags.filter((t) => t[0] === name).map((t) => t[1]);
}

export function cleanText(s: string, max = MAX_TEXT): string {
  // strip control characters; keep accents, Wolof letters and emoji
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function tokenHash(token: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}

export function randomId(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
}

function isHex(s: unknown, len: number): s is string {
  return typeof s === 'string' && s.length === len && /^[0-9a-f]+$/.test(s);
}

function isWsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'wss:' || u.protocol === 'ws:';
  } catch {
    return false;
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseAmount(v: string | undefined): number | null {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 && n <= MAX_XOF ? n : null;
}

/* ------------------------------------------------------------------ ceremony */

export function createCeremony(
  sk: Uint8Array,
  opts: { hostName: string; title: string; type: CeremonyType; start: number; lockPk: string; mint: string; relays: string[]; capXof?: number },
): Ceremony {
  const id = randomId();
  const tags: string[][] = [
    ['d', id],
    ['title', cleanText(opts.title, 80)],
    ['start', String(Math.floor(opts.start))],
    ['t', 'ndawtal'],
    ['ceremony', opts.type],
    ['name', cleanText(opts.hostName, 60)],
    ['lock', opts.lockPk],
    ['mint', opts.mint],
    ...opts.relays.slice(0, 4).map((r) => ['relay', r]),
  ];
  if (opts.capXof) tags.push(['cap', String(opts.capXof), 'XOF']);
  const event = finalizeEvent({ kind: KIND_CEREMONY, created_at: now(), tags, content: '' }, sk);
  const c = parseCeremony(event);
  if (!c) throw new Error('could not build ceremony');
  return c;
}

export function parseCeremony(event: NostrEvent): Ceremony | null {
  if (!event || event.kind !== KIND_CEREMONY || !strictVerify(event)) return null;
  const id = tagValue(event, 'd');
  const title = tagValue(event, 'title');
  const start = Number(tagValue(event, 'start'));
  const lockPk = tagValue(event, 'lock');
  const mint = tagValue(event, 'mint');
  const type = (tagValue(event, 'ceremony') ?? 'autre') as CeremonyType;
  if (!id || !/^[0-9a-f]{16}$/.test(id) || !title || !Number.isFinite(start)) return null;
  if (!isHex(lockPk, 66) || !(lockPk.startsWith('02') || lockPk.startsWith('03'))) return null;
  if (!mint || !isHttpUrl(mint)) return null;
  const relays = tagValues(event, 'relay').filter(isWsUrl);
  const cap = parseAmount(tagValue(event, 'cap') ?? undefined);
  return {
    id,
    ref: `${KIND_CEREMONY}:${event.pubkey}:${id}`,
    hostPk: event.pubkey,
    hostName: cleanText(tagValue(event, 'name') ?? '', 60) || 'Hôte',
    title: cleanText(title, 80),
    type: ['ngente', 'mariage', 'deuil', 'autre'].includes(type) ? type : 'autre',
    start,
    lockPk,
    mint,
    relays,
    capXof: cap ?? undefined,
    event,
  };
}

/* ------------------------------------------------------------------ invitation links */

function toB64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The ceremony rides in the URL fragment (#...), which browsers never send to the web server. */
export function invitationLink(baseUrl: string, c: Ceremony): string {
  const base = baseUrl.split('#')[0];
  return `${base}#/invite/${toB64Url(JSON.stringify(c.event))}`;
}

export function parseInvitation(payload: string): Ceremony | null {
  try {
    if (payload.length > 8000) return null;
    return parseCeremony(JSON.parse(fromB64Url(payload)) as NostrEvent);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ compact invitation */

/**
 * A short invitation that fits a small QR: `#/i/<code>`, where the code is 24 bytes in base64url:
 *   16-byte random seed  ||  first 8 bytes of the host's public key.
 * From the seed both sides derive a throwaway signing key and an encryption key. The host publishes the
 * signed ceremony, NIP-44 encrypted, as a carrier event (kind 9333) from the throwaway key. Relays see a
 * random key posting ciphertext. Anyone holding the link could post a second carrier, so the guest only
 * accepts a ceremony whose host key starts with the 8-byte prefix in the code (forging that takes ~2^64 work).
 */
export const KIND_INVITE = 9333;
const INVITE_SEED_BYTES = 16;
const INVITE_PREFIX_BYTES = 8;

export function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function derive(label: string, seed: Uint8Array): Uint8Array {
  const l = new TextEncoder().encode(label);
  const buf = new Uint8Array(l.length + seed.length);
  buf.set(l);
  buf.set(seed, l.length);
  return sha256(buf);
}

export interface InviteKeys {
  seed: Uint8Array;
  sk: Uint8Array;
  pk: string;
  key: Uint8Array;
}

export function inviteKeys(seed: Uint8Array): InviteKeys {
  if (seed.length !== INVITE_SEED_BYTES) throw new Error('bad invite seed');
  const sk = derive('kayit:invite:sk', seed);
  return { seed, sk, pk: getPublicKey(sk), key: derive('kayit:invite:key', seed) };
}

export function newInviteSeed(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(INVITE_SEED_BYTES));
}

export function inviteCode(seed: Uint8Array, hostPk: string): string {
  const code = new Uint8Array(INVITE_SEED_BYTES + INVITE_PREFIX_BYTES);
  code.set(seed);
  code.set(hexToBytes(hostPk).slice(0, INVITE_PREFIX_BYTES), INVITE_SEED_BYTES);
  return bytesToB64Url(code);
}

export function parseInviteCode(code: string): { seed: Uint8Array; hostPrefix: string } | null {
  try {
    const b = b64UrlToBytes(code);
    if (b.length !== INVITE_SEED_BYTES + INVITE_PREFIX_BYTES) return null;
    return { seed: b.slice(0, INVITE_SEED_BYTES), hostPrefix: bytesToHex(b.slice(INVITE_SEED_BYTES)) };
  } catch {
    return null;
  }
}

export function compactInvitationLink(baseUrl: string, code: string): string {
  return `${baseUrl.split('#')[0]}#/i/${code}`;
}

export function createInviteCarrier(c: Ceremony, seed: Uint8Array): NostrEvent {
  const k = inviteKeys(seed);
  return finalizeEvent({ kind: KIND_INVITE, created_at: now(), tags: [], content: nip44.encrypt(JSON.stringify(c.event), k.key) }, k.sk);
}

/** The newest carrier that decrypts to a valid ceremony from the host named in the code. */
export function openInviteCarriers(events: NostrEvent[], code: string): Ceremony | null {
  const parsed = parseInviteCode(code);
  if (!parsed) return null;
  const k = inviteKeys(parsed.seed);
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
  for (const ev of sorted) {
    if (ev.kind !== KIND_INVITE || ev.pubkey !== k.pk || ev.content.length > 16_000 || !strictVerify(ev)) continue;
    try {
      const c = parseCeremony(JSON.parse(nip44.decrypt(ev.content, k.key)) as NostrEvent);
      if (c && c.hostPk.startsWith(parsed.hostPrefix)) return c;
    } catch {
      /* not ours, or tampered: try the next one */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ gift */

export function createGift(
  sk: Uint8Array,
  opts: { ceremony: Ceremony; giverName: string; xof: number; method: GiftMethod; sats?: number; token?: string; message?: string },
): Gift {
  const tags: string[][] = [
    ['p', opts.ceremony.hostPk],
    ['a', opts.ceremony.ref],
    ['amount', String(opts.xof), 'XOF'],
    ['method', opts.method],
    ['name', cleanText(opts.giverName, 60)],
  ];
  if (opts.method === 'ecash') {
    if (!opts.token || !opts.sats) throw new Error('ecash gift needs token and sats');
    tags.push(['sats', String(opts.sats)], ['token', tokenHash(opts.token)]);
  }
  const event = finalizeEvent({ kind: KIND_GIFT, created_at: now(), tags, content: cleanText(opts.message ?? '') }, sk);
  const g = parseGift(event);
  if (!g) throw new Error('could not build gift');
  return g;
}

export function parseGift(event: NostrEvent): Gift | null {
  if (!event || event.kind !== KIND_GIFT || !strictVerify(event)) return null;
  const hostPk = tagValue(event, 'p');
  const ref = tagValue(event, 'a');
  const amountTag = tag(event, 'amount');
  const xof = parseAmount(amountTag?.[1]);
  const method = tagValue(event, 'method');
  if (!isHex(hostPk, 64) || !ref || !ref.startsWith(`${KIND_CEREMONY}:${hostPk}:`)) return null;
  if (!xof || amountTag?.[2] !== 'XOF') return null;
  if (method !== 'ecash' && method !== 'cash') return null;
  let sats: number | undefined;
  let th: string | undefined;
  if (method === 'ecash') {
    sats = Number(tagValue(event, 'sats'));
    th = tagValue(event, 'token');
    if (!Number.isSafeInteger(sats) || sats <= 0 || !isHex(th, 64)) return null;
  }
  return {
    id: event.id,
    giverPk: event.pubkey,
    giverName: cleanText(tagValue(event, 'name') ?? '', 60) || 'Invité',
    hostPk,
    ceremonyRef: ref,
    xof,
    method,
    sats,
    tokenHash: th,
    message: cleanText(event.content),
    createdAt: event.created_at,
    event,
  };
}

/* ------------------------------------------------------------------ receipt */

export function createReceipt(sk: Uint8Array, gift: Gift, status: Receipt['status'], message = ''): Receipt {
  const tags: string[][] = [
    ['e', gift.id],
    ['p', gift.giverPk],
    ['a', gift.ceremonyRef],
    ['amount', String(gift.xof), 'XOF'],
    ['status', status],
  ];
  const event = finalizeEvent({ kind: KIND_RECEIPT, created_at: now(), tags, content: cleanText(message) }, sk);
  const r = parseReceipt(event);
  if (!r) throw new Error('could not build receipt');
  return r;
}

export function parseReceipt(event: NostrEvent): Receipt | null {
  if (!event || event.kind !== KIND_RECEIPT || !strictVerify(event)) return null;
  const giftId = tagValue(event, 'e');
  const giverPk = tagValue(event, 'p');
  const xof = parseAmount(tagValue(event, 'amount'));
  const status = tagValue(event, 'status');
  if (!isHex(giftId, 64) || !isHex(giverPk, 64) || !xof) return null;
  if (status !== 'redeemed' && status !== 'received') return null;
  return {
    id: event.id,
    giftId,
    hostPk: event.pubkey,
    giverPk,
    xof,
    status,
    message: cleanText(event.content),
    createdAt: event.created_at,
    event,
  };
}

/** A receipt only counts if the host of the gift signed it, for that exact gift and amount. */
export function receiptMatches(gift: Gift, receipt: Receipt): boolean {
  return (
    receipt.giftId === gift.id &&
    receipt.hostPk === gift.hostPk &&
    receipt.giverPk === gift.giverPk &&
    receipt.xof === gift.xof &&
    // cash is only ever 'received'; ecash is 'redeemed' once cashed, or 'received' when checked offline (handed over)
    (receipt.status === 'received' || (gift.method === 'ecash' && receipt.status === 'redeemed'))
  );
}

export function parseEnvelope(content: string): EnvelopePayload | null {
  try {
    if (content.length > 60_000) return null;
    const p = JSON.parse(content) as EnvelopePayload;
    if (p?.t === 'gift' && p.gift) return p;
    if (p?.t === 'receipt' && p.receipt && p.gift) return p;
    if (p?.t === 'reject' && isHex(p.giftId, 64)) return p;
    return null;
  } catch {
    return null;
  }
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
