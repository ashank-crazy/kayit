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
import { KIND_ENVELOPE, KIND_BACKUP, BACKUP_D, parseEnvelope, type EnvelopePayload, now } from './protocol';

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

export async function publishBackup(sk: Uint8Array, pk: string, relays: string[], state: unknown): Promise<number> {
  const key = nip44.getConversationKey(sk, pk);
  const content = nip44.encrypt(JSON.stringify(state), key);
  const ev = finalizeEvent({ kind: KIND_BACKUP, created_at: now(), tags: [['d', BACKUP_D]], content }, sk);
  return publishAll(relays, ev);
}

export async function fetchBackup<T>(sk: Uint8Array, pk: string, relays: string[]): Promise<{ state: T; at: number } | null> {
  const events = await getPool().querySync(relays, { kinds: [KIND_BACKUP], authors: [pk], '#d': [BACKUP_D] }, { maxWait: 6000 });
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return null;
  const key = nip44.getConversationKey(sk, pk);
  return { state: JSON.parse(nip44.decrypt(latest.content, key)) as T, at: latest.created_at };
}

/** Everything ever wrapped to me, for a full rebuild after restore. */
export async function fetchInbox(sk: Uint8Array, pk: string, relays: string[]): Promise<Inbound[]> {
  const wraps = await getPool().querySync(relays, { kinds: [1059], '#p': [pk] }, { maxWait: 6000 });
  return wraps.map((w) => openWrap(w, sk)).filter((m): m is Inbound => !!m);
}

export function closePool(relays: string[]): void {
  pool?.close(relays);
}
