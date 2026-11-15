/**
 * Phone-to-phone transfer with no network: a payload is compressed, cut into frames and shown as a short
 * looping QR animation; the other phone's camera collects the frames and rebuilds it.
 *
 * Why animated: a locked envelope is 4–6 KB of ecash (every proof carries its own lock, signature and
 * DLEQ proof). Compressed it is ~2–2.5 KB, still far too dense for one QR on a phone screen. ~300 bytes
 * per frame keeps each QR at version ~14, which a mid-range phone camera reads instantly.
 *
 * Frame text:  KY1:<id>:<index>:<count>:<base64url chunk>
 *   id = first 6 bytes of sha256(payload), so frames from two different envelopes never mix, and the
 *   rebuilt payload is checked against it.
 * Payload:     kind byte, then the kind's body, all deflate-raw compressed.
 *   1 envelope  = u16 length + gift event JSON, then the Cashu token as raw CBOR (cashuB without base64)
 *   2 receipt   = receipt event JSON + "\n" + gift event JSON
 *
 * Nothing here is trusted: the receiver verifies every signature, lock and mint proof afterwards.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { NostrEvent } from 'nostr-tools/pure';
import { bytesToB64Url, b64UrlToBytes } from './protocol';
import { deflate, inflate } from './zip';

export const FRAME_BYTES = 300;
const MAX_FRAMES = 40;
const MAX_PAYLOAD = 64 * 1024;
const PREFIX = 'KY1';

export type AirMessage = { kind: 'envelope'; gift: NostrEvent; token: string } | { kind: 'receipt'; receipt: NostrEvent; gift: NostrEvent };

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function packMessage(m: AirMessage): Promise<Uint8Array> {
  let body: Uint8Array;
  if (m.kind === 'envelope') {
    if (!m.token.startsWith('cashuB')) throw new Error('only cashuB tokens can be handed over');
    const gift = enc.encode(JSON.stringify(m.gift));
    if (gift.length > 0xffff) throw new Error('gift too large');
    const cbor = b64UrlToBytes(m.token.slice(6));
    body = new Uint8Array(1 + 2 + gift.length + cbor.length);
    body[0] = 1;
    body[1] = gift.length >> 8;
    body[2] = gift.length & 0xff;
    body.set(gift, 3);
    body.set(cbor, 3 + gift.length);
  } else {
    const text = enc.encode(`${JSON.stringify(m.receipt)}\n${JSON.stringify(m.gift)}`);
    body = new Uint8Array(1 + text.length);
    body[0] = 2;
    body.set(text, 1);
  }
  return deflate(body);
}

export async function unpackMessage(packed: Uint8Array): Promise<AirMessage> {
  const body = await inflate(packed, MAX_PAYLOAD);
  if (body[0] === 1) {
    const len = (body[1] << 8) | body[2];
    const gift = JSON.parse(dec.decode(body.subarray(3, 3 + len))) as NostrEvent;
    const token = 'cashuB' + bytesToB64Url(body.subarray(3 + len));
    return { kind: 'envelope', gift, token };
  }
  if (body[0] === 2) {
    const [r, g] = dec.decode(body.subarray(1)).split('\n');
    return { kind: 'receipt', receipt: JSON.parse(r) as NostrEvent, gift: JSON.parse(g) as NostrEvent };
  }
  throw new Error('unknown message');
}

function frameId(payload: Uint8Array): string {
  return bytesToB64Url(sha256(payload).slice(0, 6));
}

export function toFrames(payload: Uint8Array, size = FRAME_BYTES): string[] {
  const count = Math.max(1, Math.ceil(payload.length / size));
  if (count > MAX_FRAMES) throw new Error('payload too large for a QR animation');
  const id = frameId(payload);
  return Array.from({ length: count }, (_, i) => `${PREFIX}:${id}:${i}:${count}:${bytesToB64Url(payload.subarray(i * size, (i + 1) * size))}`);
}

export interface Progress {
  have: number;
  total: number;
  payload?: Uint8Array;
}

/** Collects frames in any order; ignores duplicates, garbage and frames of other transfers. */
export class FrameCollector {
  private id: string | null = null;
  private parts: (Uint8Array | undefined)[] = [];

  add(text: string): Progress | null {
    const m = /^KY1:([A-Za-z0-9_-]{8}):(\d{1,2}):(\d{1,2}):([A-Za-z0-9_-]*)$/.exec(text.trim());
    if (!m) return null;
    const [, id, iS, nS, data] = m;
    const i = Number(iS);
    const n = Number(nS);
    if (n < 1 || n > MAX_FRAMES || i >= n) return null;
    if (this.id !== id) {
      this.id = id; // a new transfer started: drop the old one
      this.parts = new Array(n);
    }
    if (this.parts.length !== n) return null;
    if (!this.parts[i]) {
      try {
        this.parts[i] = b64UrlToBytes(data);
      } catch {
        return null;
      }
    }
    const have = this.parts.filter(Boolean).length;
    if (have < n) return { have, total: n };
    const size = this.parts.reduce((a, p) => a + p!.length, 0);
    const payload = new Uint8Array(size);
    let o = 0;
    for (const p of this.parts) {
      payload.set(p!, o);
      o += p!.length;
    }
    if (frameId(payload) !== id) {
      this.reset();
      return { have: 0, total: n };
    }
    return { have, total: n, payload };
  }

  reset(): void {
    this.id = null;
    this.parts = [];
  }
}
