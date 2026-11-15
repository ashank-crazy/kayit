/**
 * Money helpers. The social unit of ndawtal is the CFA franc (XOF); sats are only the rail.
 * XOF is pegged to the euro at a fixed rate, so BTC/XOF = BTC/EUR x 655.957.
 */
export const XOF_PER_EUR = 655.957;
export const SATS_PER_BTC = 100_000_000;

export interface Rate {
  eurPerBtc: number;
  /** ms epoch when the rate was observed */
  at: number;
  source: string;
}

/** Used only until the first live fetch succeeds (mempool.space, 2026-11-15). */
export const FALLBACK_RATE: Rate = { eurPerBtc: 59_612, at: 1_794_738_006_000, source: 'built-in' };

export function xofPerSat(rate: Rate): number {
  return (rate.eurPerBtc * XOF_PER_EUR) / SATS_PER_BTC;
}

/** Sats needed to cover an amount in francs. Rounds up so the host never receives less than promised. */
export function xofToSats(xof: number, rate: Rate): number {
  assertAmount(xof);
  return Math.ceil(xof / xofPerSat(rate));
}

export function satsToXof(sats: number, rate: Rate): number {
  return Math.round(sats * xofPerSat(rate));
}

export function assertAmount(n: number): void {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('amount must be a positive whole number');
}

/** "10 000 F" — French grouping, which is what people write in their cahier. */
export function formatXof(xof: number): string {
  const s = Math.round(xof)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${s} F`;
}

export function formatSats(sats: number): string {
  const s = Math.round(sats)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${s} sats`;
}

/** Round a suggestion to the nearest 500 F, as people do with notes and coins. */
export function roundToNote(xof: number): number {
  if (xof <= 0) return 0;
  return Math.max(500, Math.round(xof / 500) * 500);
}

/** Parse what people type: "10 000", "10.000", "10k", "10000f". Returns null when unclear. */
export function parseXof(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/f(cfa)?$/, '').trim();
  const k = s.endsWith('k');
  const digits = (k ? s.slice(0, -1) : s).replace(/[\s  .,]/g, '');
  if (!/^\d{1,9}$/.test(digits)) return null;
  const n = Number(digits) * (k ? 1000 : 1);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

export async function fetchRate(fetchImpl: typeof fetch = fetch): Promise<Rate> {
  const res = await fetchImpl('https://mempool.space/api/v1/prices', { cache: 'no-store' });
  if (!res.ok) throw new Error(`rate http ${res.status}`);
  const body = (await res.json()) as { EUR?: unknown; time?: unknown };
  const eur = Number(body.EUR);
  if (!Number.isFinite(eur) || eur < 1000 || eur > 10_000_000) throw new Error('rate out of range');
  return { eurPerBtc: eur, at: Date.now(), source: 'mempool.space' };
}
