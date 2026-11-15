/** deflate-raw through the platform's CompressionStream (browsers and Node 18+): no extra dependency. */
async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      // stop as soon as the output passes the limit: a few KB of hostile input cannot expand to MBs
      await reader.cancel().catch(() => undefined);
      throw new Error('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate-raw'));
}

export function inflate(data: Uint8Array, max?: number): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate-raw'), max);
}
