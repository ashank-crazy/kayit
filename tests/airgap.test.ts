import { describe, it, expect } from 'vitest';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { packMessage, unpackMessage, toFrames, FrameCollector, FRAME_BYTES } from '../src/core/airgap';
import { packBackup, unpackBackup } from '../src/core/transport';
import { bytesToB64Url } from '../src/core/protocol';
import { deflate } from '../src/core/zip';

const gift = finalizeEvent({ kind: 9330, created_at: 1795000000, tags: [['amount', '10000']], content: 'Barkeel Aïda !' }, generateSecretKey());
// stand-in for a 4 KB envelope: random bytes do not compress, so this is a worst case
const token = 'cashuB' + bytesToB64Url(globalThis.crypto.getRandomValues(new Uint8Array(4000)));

/** Draw a QR the way a phone screen would show it, then read it back like a camera would. */
function renderAndRead(text: string): string | null {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = 4;
  const quiet = 3;
  const size = (n + quiet * 2) * cell;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c))
        for (let y = 0; y < cell; y++)
          for (let x = 0; x < cell; x++) {
            const i = (((r + quiet) * cell + y) * size + (c + quiet) * cell + x) * 4;
            px[i] = px[i + 1] = px[i + 2] = 0;
          }
  return jsQR(px, size, size)?.data ?? null;
}

describe('hand-over by QR animation', () => {
  it('packs an envelope and gets the same gift and token back', async () => {
    const packed = await packMessage({ kind: 'envelope', gift, token });
    const plain = (x: unknown) => JSON.parse(JSON.stringify(x)); // drops nostr-tools' in-memory "verified" mark
    const m = await unpackMessage(packed);
    expect(plain(m)).toEqual(plain({ kind: 'envelope', gift, token }));
    const r = await unpackMessage(await packMessage({ kind: 'receipt', receipt: gift, gift }));
    expect(plain(r)).toEqual(plain({ kind: 'receipt', receipt: gift, gift }));
  });

  it('rebuilds the payload from frames in any order, with repeats and noise', async () => {
    const packed = await packMessage({ kind: 'envelope', gift, token });
    const frames = toFrames(packed);
    expect(frames.length).toBe(Math.ceil(packed.length / FRAME_BYTES));
    const col = new FrameCollector();
    expect(col.add('https://example.com')).toBeNull();
    const other = toFrames(await packMessage({ kind: 'receipt', receipt: gift, gift }));
    col.add(other[0]); // a neighbour's code drifts into view
    const order = [...frames].reverse();
    let last = null;
    for (const f of [...order, order[0], order[1]]) last = col.add(f) ?? last;
    expect(last?.payload).toEqual(packed);
  });

  it('every frame is a QR a camera can read', async () => {
    const frames = toFrames(await packMessage({ kind: 'envelope', gift, token }));
    for (const f of frames) expect(renderAndRead(f)).toBe(f);
  });

  it('stops decompressing a hostile payload at 64 KB', async () => {
    const bomb = await deflate(new Uint8Array(4 * 1024 * 1024)); // 4 MB of zeros, ~4 KB compressed
    expect(bomb.length).toBeLessThan(FRAME_BYTES * 40);
    await expect(unpackMessage(bomb)).rejects.toThrow('too large');
  });

  it('refuses a frame set that does not match its checksum', async () => {
    const frames = toFrames(await packMessage({ kind: 'envelope', gift, token }));
    const col = new FrameCollector();
    const bad = frames[0].replace(/:([A-Za-z0-9_-])([A-Za-z0-9_-]*)$/, (_, a, rest) => `:${a === 'A' ? 'B' : 'A'}${rest}`);
    let p = col.add(bad);
    for (const f of frames.slice(1)) p = col.add(f);
    expect(p?.payload).toBeUndefined();
  });
});

describe('backup in parts', () => {
  it('splits a large notebook and joins it back', async () => {
    const big = { entries: Array.from({ length: 300 }, () => bytesToB64Url(globalThis.crypto.getRandomValues(new Uint8Array(200)))) };
    const { id, parts } = await packBackup(big);
    expect(parts.length).toBeGreaterThan(1);
    expect(await unpackBackup(id, parts)).toEqual(big);
    await expect(unpackBackup(id, [...parts].reverse())).rejects.toThrow();
  });
});
