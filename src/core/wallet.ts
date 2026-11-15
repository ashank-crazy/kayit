/**
 * "Ma caisse": a Cashu ecash wallet that tops up and pays out over Lightning.
 *
 * Ecash fits ndawtal well: like a cash envelope it can be prepared at home and handed over, the mint cannot
 * see who gave what to whom (blind signatures), and an envelope can be LOCKED to the host's key (NUT-11) so
 * nobody else can open it. If the host never opens it, the giver takes it back after the lock expires.
 */
import {
  Wallet,
  MintQuoteState,
  getEncodedToken,
  getTokenMetadata,
  serializeProofs,
  deserializeProofs,
  sumProofs,
  verifyP2PKSpendingConditions,
  CheckStateEnum,
  type Proof,
  type MintQuoteBolt11Response,
} from '@cashu/cashu-ts';

export type StoredProofs = string[];

export interface TopUp {
  quote: string;
  invoice: string;
  sats: number;
  expiry: number | null;
}

export interface Inspection {
  ok: boolean;
  sats: number;
  reason?: 'bad-token' | 'wrong-mint' | 'not-locked-to-me' | 'bad-signature' | 'empty';
}

const wallets = new Map<string, Promise<Wallet>>();

export function normalizeMint(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function loadWallet(mintUrl: string): Promise<Wallet> {
  const key = normalizeMint(mintUrl);
  let w = wallets.get(key);
  if (!w) {
    w = (async () => {
      const wallet = new Wallet(key);
      await wallet.loadMint();
      return wallet;
    })();
    wallets.set(key, w);
    w.catch(() => wallets.delete(key));
  }
  return w;
}

export function toStored(proofs: Proof[]): StoredProofs {
  return serializeProofs(proofs);
}

export function fromStored(stored: StoredProofs): Proof[] {
  return stored.length ? deserializeProofs(stored) : [];
}

export function total(stored: StoredProofs | Proof[]): number {
  const proofs = (stored.length && typeof stored[0] === 'string' ? fromStored(stored as StoredProofs) : stored) as Proof[];
  return proofs.length ? sumProofs(proofs).toNumber() : 0;
}

/* -------------------------------------------------------------- top up (Lightning in) */

export async function createTopUp(mintUrl: string, sats: number): Promise<TopUp> {
  const w = await loadWallet(mintUrl);
  const q = await w.createMintQuoteBolt11(sats, 'Kayit');
  return { quote: q.quote, invoice: q.request, sats, expiry: q.expiry };
}

/** Returns new proofs once the invoice is paid, or null while it is still unpaid. */
export async function claimTopUp(mintUrl: string, t: TopUp): Promise<Proof[] | null> {
  const w = await loadWallet(mintUrl);
  const q: MintQuoteBolt11Response = await w.checkMintQuoteBolt11(t.quote);
  if (q.state === MintQuoteState.ISSUED) throw new Error('already claimed');
  if (q.state !== MintQuoteState.PAID) return null;
  return w.mintProofsBolt11(t.sats, q);
}

/* -------------------------------------------------------------- pay out (Lightning out) */

export async function quotePayout(mintUrl: string, invoice: string): Promise<{ sats: number; fee: number }> {
  const w = await loadWallet(mintUrl);
  const q = await w.createMeltQuoteBolt11(invoice.trim().replace(/^lightning:/i, ''));
  return { sats: q.amount.toNumber(), fee: q.fee_reserve.toNumber() };
}

export async function payOut(mintUrl: string, invoice: string, stored: StoredProofs): Promise<{ keep: Proof[]; paid: boolean; preimage: string | null }> {
  const w = await loadWallet(mintUrl);
  const q = await w.createMeltQuoteBolt11(invoice.trim().replace(/^lightning:/i, ''));
  const need = q.amount.add(q.fee_reserve);
  const { keep, send } = await w.send(need, fromStored(stored), { includeFees: true });
  const res = await w.meltProofsBolt11(q, send);
  const paid = res.quote.state === 'PAID';
  return { keep: [...keep, ...res.change], paid, preimage: res.quote.payment_preimage ?? null };
}

/* -------------------------------------------------------------- envelopes */

/**
 * Lock `sats` to the host's key. Until `locktime` only the host can open it; after that the giver's
 * refund key can take it back. Sender pays the host's future swap fee.
 */
export async function makeEnvelope(
  mintUrl: string,
  stored: StoredProofs,
  sats: number,
  hostLockPk: string,
  locktime: number,
  myLockPk: string,
): Promise<{ keep: Proof[]; token: string }> {
  const w = await loadWallet(mintUrl);
  const proofs = fromStored(stored);
  if (total(proofs) < sats) throw new Error('insufficient funds');
  const { keep, send } = await w.ops
    .send(sats, proofs)
    .asP2PK({ pubkey: hostLockPk, locktime, refundKeys: [myLockPk] })
    .includeFees(true)
    .run();
  const token = getEncodedToken({ mint: normalizeMint(mintUrl), proofs: send, unit: 'sat' });
  return { keep, token };
}

/** Offline checks before redeeming: right mint, locked to me, signed by the mint (NUT-12 DLEQ). */
export async function inspectEnvelope(token: string, expectedMint: string, myLockPk: string): Promise<Inspection> {
  let meta;
  try {
    meta = getTokenMetadata(token);
  } catch {
    return { ok: false, sats: 0, reason: 'bad-token' };
  }
  if (normalizeMint(meta.mint) !== normalizeMint(expectedMint) || meta.unit !== 'sat') {
    return { ok: false, sats: 0, reason: 'wrong-mint' };
  }
  const w = await loadWallet(expectedMint);
  const decoded = w.decodeToken(token);
  if (!decoded.proofs.length) return { ok: false, sats: 0, reason: 'empty' };
  const mine = myLockPk.toLowerCase();
  for (const p of decoded.proofs) {
    try {
      const v = verifyP2PKSpendingConditions(p);
      const keys = v.main.pubkeys.map((k) => k.toLowerCase());
      if (!keys.includes(mine) && !keys.includes(mine.slice(2))) return { ok: false, sats: 0, reason: 'not-locked-to-me' };
    } catch {
      return { ok: false, sats: 0, reason: 'not-locked-to-me' };
    }
  }
  const check = await w.verifyMintSignatures(decoded.proofs, { require: true });
  if (check.invalid.length) return { ok: false, sats: 0, reason: 'bad-signature' };
  return { ok: true, sats: sumProofs(decoded.proofs).toNumber() };
}

/** Open an envelope locked to me (host) or, after expiry, take it back (giver's refund key). */
export async function openEnvelope(mintUrl: string, token: string, lockSkHex: string): Promise<Proof[]> {
  const w = await loadWallet(mintUrl);
  return w.receive(token, { privkey: lockSkHex });
}

export async function envelopeState(mintUrl: string, token: string): Promise<'unspent' | 'spent' | 'pending'> {
  const w = await loadWallet(mintUrl);
  const { proofs } = w.decodeToken(token);
  const states = await w.checkProofsStates(proofs);
  if (states.some((s) => s.state === CheckStateEnum.SPENT)) return 'spent';
  if (states.some((s) => s.state === CheckStateEnum.PENDING)) return 'pending';
  return 'unspent';
}

/** Drop proofs the mint says are spent (after a restore from backup, for instance). */
export async function pruneSpent(mintUrl: string, stored: StoredProofs): Promise<StoredProofs> {
  const proofs = fromStored(stored);
  if (!proofs.length) return stored;
  const w = await loadWallet(mintUrl);
  const { unspent, pending } = await w.groupProofsByState(proofs);
  return toStored([...unspent, ...pending]);
}
