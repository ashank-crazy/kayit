/**
 * The Kayit engine: one person's notebook, caisse and inbox. UI-agnostic; the web app and the
 * live test drive the same code.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import type { Identity } from './keys';
import {
  createCeremony,
  createGift,
  createReceipt,
  parseCeremony,
  parseGift,
  parseReceipt,
  receiptMatches,
  tokenHash,
  randomId,
  cleanText,
  now,
  type Ceremony,
  type CeremonyType,
  type Gift,
  type EnvelopePayload,
} from './protocol';
import { type Entry, type Direction, upsertEntry, nameKey } from './ledger';
import { FALLBACK_RATE, fetchRate, xofToSats, assertAmount, type Rate } from './money';
import * as W from './wallet';
import * as T from './transport';

export interface Settings {
  name: string;
  lang: 'fr' | 'en';
  /** 1 = give back what you received; 2 = the "on double" custom */
  multiplier: number;
  griot: boolean;
  /** sutura (discretion): hide amounts on the ceremony screen */
  sutura: boolean;
}

export interface OutEnvelope {
  giftId: string;
  token: string;
  mint: string;
  locktime: number;
  hostPk: string;
  hostName: string;
  ceremonyTitle: string;
  sats: number;
  xof: number;
  state: 'sent' | 'opened' | 'reclaimed';
  at: number;
}

export interface PendingIn {
  gift: NostrEvent;
  token?: string;
  receivedAt: number;
  problem?: string;
}

export interface State {
  v: 1;
  settings: Settings;
  mint: string;
  relays: string[];
  proofs: W.StoredProofs;
  topups: W.TopUp[];
  myCeremonies: NostrEvent[];
  invitations: NostrEvent[];
  entries: Entry[];
  outbox: OutEnvelope[];
  pending: PendingIn[];
  processed: string[];
  rate: Rate;
  lastSync?: number;
  updatedAt: number;
}

export interface Arrival {
  ceremonyRef: string;
  giftId: string;
  name: string;
  xof: number;
  method: 'ecash' | 'cash';
  status: Entry['status'];
  message: string;
  at: number;
}

export function emptyState(name: string, mint: string, relays: string[], lang: 'fr' | 'en' = 'fr'): State {
  return {
    v: 1,
    settings: { name: cleanText(name, 60), lang, multiplier: 2, griot: true, sutura: false },
    mint: W.normalizeMint(mint),
    relays,
    proofs: [],
    topups: [],
    myCeremonies: [],
    invitations: [],
    entries: [],
    outbox: [],
    pending: [],
    processed: [],
    rate: FALLBACK_RATE,
    updatedAt: Date.now(),
  };
}

type Listener = () => void;
type ArrivalListener = (a: Arrival) => void;

const LOCK_GRACE_DAYS = 30;

export class Engine {
  state: State;
  readonly id: Identity;
  private persistFn: (s: State) => Promise<void>;
  private listeners = new Set<Listener>();
  private arrivalListeners = new Set<ArrivalListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private unsub: (() => void) | null = null;
  private backupTimer: ReturnType<typeof setTimeout> | null = null;
  online = false;
  lastError: string | null = null;

  constructor(id: Identity, state: State, persist: (s: State) => Promise<void>) {
    this.id = id;
    this.state = state;
    this.persistFn = persist;
  }

  /* ------------------------------------------------------------ plumbing */

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onArrival(fn: ArrivalListener): () => void {
    this.arrivalListeners.add(fn);
    return () => this.arrivalListeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Serialize everything that touches proofs or the notebook. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(mut: (s: State) => State, backup = true): Promise<void> {
    this.state = { ...mut(this.state), updatedAt: Date.now() };
    await this.persistFn(this.state);
    this.emit();
    if (backup) this.scheduleBackup();
  }

  private scheduleBackup(): void {
    if (this.backupTimer) clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      this.backupNow().catch(() => undefined);
    }, 4000);
  }

  async backupNow(): Promise<number> {
    const n = await T.publishBackup(this.id.sk, this.id.pk, this.state.relays, this.state);
    await this.commit((s) => ({ ...s, lastSync: now() }), false);
    return n;
  }

  /* ------------------------------------------------------------ lifecycle */

  start(): void {
    this.stop();
    this.unsub = T.subscribeInbox(
      this.id.sk,
      this.id.pk,
      this.state.relays,
      this.state.lastSync,
      (m) => {
        this.exclusive(() => this.handleInbound(m)).catch((e) => this.fail(e));
      },
      () => {
        this.online = true;
        this.emit();
      },
    );
    fetchRate()
      .then((rate) => this.commit((s) => ({ ...s, rate }), false))
      .catch(() => undefined);
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.online = false;
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.emit();
  }

  /* ------------------------------------------------------------ reads */

  balanceSats(): number {
    return W.total(this.state.proofs);
  }

  ceremonies(): Ceremony[] {
    return this.state.myCeremonies.map(parseCeremony).filter((c): c is Ceremony => !!c).sort((a, b) => b.start - a.start);
  }

  invitations(): Ceremony[] {
    return this.state.invitations.map(parseCeremony).filter((c): c is Ceremony => !!c).sort((a, b) => a.start - b.start);
  }

  findCeremony(ref: string): Ceremony | undefined {
    return [...this.ceremonies(), ...this.invitations()].find((c) => c.ref === ref);
  }

  entriesFor(ref: string): Entry[] {
    return this.state.entries.filter((e) => e.ceremonyRef === ref).sort((a, b) => b.at - a.at);
  }

  /* ------------------------------------------------------------ caisse */

  async topUp(sats: number): Promise<W.TopUp> {
    assertAmount(sats);
    const t = await W.createTopUp(this.state.mint, sats);
    await this.commit((s) => ({ ...s, topups: [...s.topups, t] }), false);
    return t;
  }

  /** Claim any paid top-ups. Returns sats added. */
  checkTopUps(): Promise<number> {
    return this.exclusive(async () => {
      let added = 0;
      for (const t of this.state.topups) {
        try {
          const proofs = await W.claimTopUp(this.state.mint, t);
          if (!proofs) continue;
          added += W.total(proofs);
          await this.commit((s) => ({
            ...s,
            proofs: [...s.proofs, ...W.toStored(proofs)],
            topups: s.topups.filter((x) => x.quote !== t.quote),
          }));
        } catch (e) {
          if (e instanceof Error && e.message === 'already claimed') {
            await this.commit((s) => ({ ...s, topups: s.topups.filter((x) => x.quote !== t.quote) }), false);
          } else throw e;
        }
      }
      return added;
    });
  }

  payOut(invoice: string): Promise<{ paid: boolean; preimage: string | null }> {
    return this.exclusive(async () => {
      const r = await W.payOut(this.state.mint, invoice, this.state.proofs);
      await this.commit((s) => ({ ...s, proofs: W.toStored(r.keep) }));
      return { paid: r.paid, preimage: r.preimage };
    });
  }

  /* ------------------------------------------------------------ hosting */

  async hostCeremony(opts: { title: string; type: CeremonyType; start: number; capXof?: number }): Promise<Ceremony> {
    if (opts.capXof !== undefined) assertAmount(opts.capXof);
    const c = createCeremony(this.id.sk, {
      hostName: this.state.settings.name,
      title: opts.title,
      type: opts.type,
      start: opts.start,
      lockPk: this.id.lockPk,
      mint: this.state.mint,
      relays: this.state.relays,
      capXof: opts.capXof,
    });
    await this.commit((s) => ({ ...s, myCeremonies: [...s.myCeremonies, c.event] }));
    return c;
  }

  async addInvitation(c: Ceremony): Promise<void> {
    if (c.hostPk === this.id.pk) return;
    if (this.state.invitations.some((e) => e.id === c.event.id)) return;
    await this.commit((s) => ({ ...s, invitations: [...s.invitations.filter((e) => parseCeremony(e)?.ref !== c.ref), c.event] }));
  }

  /* ------------------------------------------------------------ giving */

  /** Prepare an ecash envelope locked to the host, sign the gift, and deliver both over Nostr. */
  giveEcash(c: Ceremony, xof: number, message = ''): Promise<Gift> {
    assertAmount(xof);
    return this.exclusive(async () => {
      if (c.capXof && xof > c.capXof) throw new Error('over-cap');
      if (W.normalizeMint(c.mint) !== this.state.mint) throw new Error('other-mint');
      const sats = xofToSats(xof, this.state.rate);
      if (this.balanceSats() < sats) throw new Error('insufficient');
      const locktime = Math.max(c.start, now()) + LOCK_GRACE_DAYS * 86400;
      const { keep, token } = await W.makeEnvelope(this.state.mint, this.state.proofs, sats, c.lockPk, locktime, this.id.lockPk);
      const gift = createGift(this.id.sk, { ceremony: c, giverName: this.state.settings.name, xof, method: 'ecash', sats, token, message });
      const env: OutEnvelope = {
        giftId: gift.id,
        token,
        mint: this.state.mint,
        locktime,
        hostPk: c.hostPk,
        hostName: c.hostName,
        ceremonyTitle: c.title,
        sats,
        xof,
        state: 'sent',
        at: now(),
      };
      await this.commit((s) => ({
        ...s,
        proofs: W.toStored(keep),
        outbox: [...s.outbox, env],
        entries: upsertEntry(s.entries, this.outEntry(gift, c)),
      }));
      await this.addInvitation(c);
      await T.sendEnvelope(this.id.sk, this.id.pk, c.hostPk, { t: 'gift', gift: gift.event, token, ceremony: c.event }, this.relaysFor(c));
      return gift;
    });
  }

  /** Record a cash gift I handed over. The host confirms it from their phone. */
  giveCash(c: Ceremony, xof: number, message = ''): Promise<Gift> {
    assertAmount(xof);
    return this.exclusive(async () => {
      if (c.capXof && xof > c.capXof) throw new Error('over-cap');
      const gift = createGift(this.id.sk, { ceremony: c, giverName: this.state.settings.name, xof, method: 'cash', message });
      await this.commit((s) => ({ ...s, entries: upsertEntry(s.entries, this.outEntry(gift, c)) }));
      await this.addInvitation(c);
      await T.sendEnvelope(this.id.sk, this.id.pk, c.hostPk, { t: 'gift', gift: gift.event, ceremony: c.event }, this.relaysFor(c));
      return gift;
    });
  }

  /** After the lock expires, take back an envelope the host never opened. */
  reclaim(giftId: string): Promise<number> {
    return this.exclusive(async () => {
      const env = this.state.outbox.find((o) => o.giftId === giftId);
      if (!env || env.state !== 'sent') throw new Error('nothing to reclaim');
      if (now() < env.locktime) throw new Error('still-locked');
      const st = await W.envelopeState(env.mint, env.token);
      if (st === 'spent') {
        await this.commit((s) => ({ ...s, outbox: s.outbox.map((o) => (o.giftId === giftId ? { ...o, state: 'opened' } : o)) }));
        return 0;
      }
      const proofs = await W.openEnvelope(env.mint, env.token, this.id.lockSkHex);
      await this.commit((s) => ({
        ...s,
        proofs: [...s.proofs, ...W.toStored(proofs)],
        outbox: s.outbox.map((o) => (o.giftId === giftId ? { ...o, state: 'reclaimed' } : o)),
        entries: s.entries.map((e) => (e.id === giftId ? { ...e, status: 'reclaimed' } : e)),
      }));
      return W.total(proofs);
    });
  }

  private relaysFor(c: Ceremony): string[] {
    return [...new Set([...c.relays, ...this.state.relays])].slice(0, 6);
  }

  private outEntry(gift: Gift, c: Ceremony | undefined, receipt?: NostrEvent): Entry {
    return {
      id: gift.id,
      direction: 'out',
      counterpartKey: gift.hostPk,
      counterpartName: c?.hostName ?? 'Hôte',
      ceremonyTitle: c?.title ?? '—',
      ceremonyRef: gift.ceremonyRef,
      ceremonyDate: c?.start ?? gift.createdAt,
      xof: gift.xof,
      method: gift.method,
      sats: gift.sats,
      status: receipt ? 'cosigned' : 'awaiting-receipt',
      at: gift.createdAt,
      message: gift.message,
      gift: gift.event,
      receipt,
    };
  }

  private inEntry(gift: Gift, c: Ceremony | undefined, status: Entry['status'], receipt?: NostrEvent): Entry {
    return {
      id: gift.id,
      direction: 'in',
      counterpartKey: gift.giverPk,
      counterpartName: gift.giverName,
      ceremonyTitle: c?.title ?? '—',
      ceremonyRef: gift.ceremonyRef,
      ceremonyDate: c?.start ?? gift.createdAt,
      xof: gift.xof,
      method: gift.method,
      sats: gift.sats,
      status,
      at: gift.createdAt,
      message: gift.message,
      gift: gift.event,
      receipt,
    };
  }

  /* ------------------------------------------------------------ host side */

  async handleInbound(m: T.Inbound): Promise<void> {
    if (this.state.processed.includes(m.wrapId)) return;
    const p = m.payload;
    try {
      if (p.t === 'gift') await this.onGift(m.senderPk, p);
      else if (p.t === 'receipt') await this.onReceipt(m.senderPk, p);
      else if (p.t === 'reject') await this.onReject(m.senderPk, p);
    } finally {
      await this.commit((s) => ({ ...s, processed: [...s.processed, m.wrapId].slice(-2000) }), false);
    }
  }

  private async onGift(senderPk: string, p: Extract<EnvelopePayload, { t: 'gift' }>): Promise<void> {
    const gift = parseGift(p.gift);
    if (!gift || gift.giverPk !== senderPk) return;
    const ceremony = (p.ceremony && parseCeremony(p.ceremony)) || this.findCeremony(gift.ceremonyRef);
    if (ceremony && ceremony.ref !== gift.ceremonyRef) return;

    // A copy of something I sent (restore on a new phone).
    if (gift.giverPk === this.id.pk) {
      if (ceremony) await this.addInvitation(ceremony);
      const existing = this.state.entries.find((e) => e.id === gift.id);
      if (!existing) await this.commit((s) => ({ ...s, entries: upsertEntry(s.entries, this.outEntry(gift, ceremony)) }));
      if (p.token && !this.state.outbox.some((o) => o.giftId === gift.id) && ceremony) {
        const env: OutEnvelope = {
          giftId: gift.id, token: p.token, mint: ceremony.mint, locktime: Math.max(ceremony.start, gift.createdAt) + LOCK_GRACE_DAYS * 86400,
          hostPk: gift.hostPk, hostName: ceremony.hostName, ceremonyTitle: ceremony.title, sats: gift.sats ?? 0, xof: gift.xof, state: 'sent', at: gift.createdAt,
        };
        await this.commit((s) => ({ ...s, outbox: [...s.outbox, env] }));
      }
      return;
    }

    if (gift.hostPk !== this.id.pk) return;
    const mine = this.ceremonies().find((c) => c.ref === gift.ceremonyRef);
    if (!mine) return; // not one of my ceremonies: ignore
    const existing = this.state.entries.find((e) => e.id === gift.id);
    if (existing && existing.status !== 'awaiting-my-ok') return;

    if (gift.method === 'cash') {
      if (existing) return;
      await this.commit((s) => ({
        ...s,
        entries: upsertEntry(s.entries, this.inEntry(gift, mine, 'awaiting-my-ok')),
        pending: [...s.pending, { gift: gift.event, receivedAt: now() }],
      }));
      this.announce(gift, 'awaiting-my-ok');
      return;
    }

    // ecash: verify everything before touching the mint
    const token = p.token;
    let problem: string | undefined;
    if (!token || tokenHash(token) !== gift.tokenHash) problem = 'token-mismatch';
    else {
      const check = await W.inspectEnvelope(token, mine.mint, this.id.lockPk);
      if (!check.ok) problem = check.reason;
      else if (check.sats < (gift.sats ?? 0)) problem = 'short';
    }
    if (problem) {
      await this.commit((s) => ({ ...s, pending: [...s.pending, { gift: gift.event, token, receivedAt: now(), problem }] }));
      return;
    }
    let proofs;
    try {
      proofs = await W.openEnvelope(mine.mint, token!, this.id.lockSkHex);
    } catch (e) {
      const st = await W.envelopeState(mine.mint, token!).catch(() => 'unknown');
      await this.commit((s) => ({
        ...s,
        pending: [...s.pending, { gift: gift.event, token, receivedAt: now(), problem: st === 'spent' ? 'already-opened' : String((e as Error).message ?? e) }],
      }));
      return;
    }
    const receipt = createReceipt(this.id.sk, gift, 'redeemed', 'Jërëjëf');
    await this.commit((s) => ({
      ...s,
      proofs: [...s.proofs, ...W.toStored(proofs)],
      entries: upsertEntry(s.entries, this.inEntry(gift, mine, 'cosigned', receipt.event)),
    }));
    this.announce(gift, 'cosigned');
    await T.sendEnvelope(this.id.sk, this.id.pk, gift.giverPk, { t: 'receipt', receipt: receipt.event, gift: gift.event, ceremony: mine.event }, this.relaysFor(mine)).catch((e) => this.fail(e));
  }

  private announce(gift: Gift, status: Entry['status']): void {
    const a: Arrival = {
      ceremonyRef: gift.ceremonyRef,
      giftId: gift.id,
      name: gift.giverName,
      xof: gift.xof,
      method: gift.method,
      status,
      message: gift.message,
      at: gift.createdAt,
    };
    for (const l of this.arrivalListeners) l(a);
  }

  /** Host confirms "yes, she handed me this cash". */
  confirmCash(giftId: string): Promise<void> {
    return this.exclusive(async () => {
      const pend = this.state.pending.find((x) => x.gift.id === giftId);
      const gift = pend && parseGift(pend.gift);
      if (!gift || gift.method !== 'cash') throw new Error('nothing to confirm');
      const c = this.findCeremony(gift.ceremonyRef);
      const receipt = createReceipt(this.id.sk, gift, 'received', 'Jërëjëf');
      await this.commit((s) => ({
        ...s,
        pending: s.pending.filter((x) => x.gift.id !== giftId),
        entries: upsertEntry(s.entries, this.inEntry(gift, c, 'cosigned', receipt.event)),
      }));
      this.announce(gift, 'cosigned');
      await T.sendEnvelope(this.id.sk, this.id.pk, gift.giverPk, { t: 'receipt', receipt: receipt.event, gift: gift.event, ceremony: c?.event }, this.state.relays);
    });
  }

  rejectCash(giftId: string, reason = 'not-received'): Promise<void> {
    return this.exclusive(async () => {
      const pend = this.state.pending.find((x) => x.gift.id === giftId);
      const gift = pend && parseGift(pend.gift);
      if (!gift) throw new Error('nothing to reject');
      await this.commit((s) => ({
        ...s,
        pending: s.pending.filter((x) => x.gift.id !== giftId),
        entries: s.entries.map((e) => (e.id === giftId ? { ...e, status: 'rejected' } : e)),
      }));
      await T.sendEnvelope(this.id.sk, this.id.pk, gift.giverPk, { t: 'reject', giftId, reason, hostPk: this.id.pk }, this.state.relays);
    });
  }

  dismissPending(giftId: string): Promise<void> {
    return this.commit((s) => ({ ...s, pending: s.pending.filter((x) => x.gift.id !== giftId) }));
  }

  /* ------------------------------------------------------------ giver side */

  private async onReceipt(senderPk: string, p: Extract<EnvelopePayload, { t: 'receipt' }>): Promise<void> {
    const receipt = parseReceipt(p.receipt);
    const gift = parseGift(p.gift);
    if (!receipt || !gift || receipt.hostPk !== senderPk || !receiptMatches(gift, receipt)) return;

    if (gift.giverPk === this.id.pk) {
      // the host acknowledged my gift
      const c = this.findCeremony(gift.ceremonyRef);
      await this.commit((s) => ({
        ...s,
        entries: upsertEntry(s.entries, { ...this.outEntry(gift, c, receipt.event), counterpartName: c?.hostName ?? s.entries.find((e) => e.id === gift.id)?.counterpartName ?? 'Hôte' }),
        outbox: s.outbox.map((o) => (o.giftId === gift.id && receipt.status === 'redeemed' ? { ...o, state: 'opened' } : o)),
      }));
    } else if (receipt.hostPk === this.id.pk) {
      // my own copy of a receipt I issued (restore on a new phone without a backup)
      const carried = p.ceremony ? parseCeremony(p.ceremony) : null;
      if (carried && carried.hostPk === this.id.pk && carried.ref === gift.ceremonyRef && !this.ceremonies().some((x) => x.ref === carried.ref)) {
        await this.commit((s) => ({ ...s, myCeremonies: [...s.myCeremonies, carried.event] }));
      }
      const c = this.findCeremony(gift.ceremonyRef);
      await this.commit((s) => ({ ...s, entries: upsertEntry(s.entries, this.inEntry(gift, c, 'cosigned', receipt.event)) }));
    }
  }

  private async onReject(senderPk: string, p: Extract<EnvelopePayload, { t: 'reject' }>): Promise<void> {
    const e = this.state.entries.find((x) => x.id === p.giftId);
    if (!e || e.direction !== 'out' || e.counterpartKey !== senderPk || e.method !== 'cash') return;
    await this.commit((s) => ({ ...s, entries: s.entries.map((x) => (x.id === p.giftId ? { ...x, status: 'rejected' } : x)) }));
  }

  /* ------------------------------------------------------------ paper lines */

  addPaperEntry(opts: { direction: Direction; name: string; xof: number; ceremonyTitle: string; date: number; key?: string }): Promise<void> {
    assertAmount(opts.xof);
    const e: Entry = {
      id: 'paper:' + randomId(),
      direction: opts.direction,
      counterpartKey: opts.key ?? nameKey(opts.name),
      counterpartName: cleanText(opts.name, 60),
      ceremonyTitle: cleanText(opts.ceremonyTitle, 80),
      ceremonyDate: opts.date,
      xof: opts.xof,
      method: 'paper',
      status: 'paper',
      at: opts.date,
    };
    return this.commit((s) => ({ ...s, entries: [...s.entries, e] }));
  }

  deleteEntry(id: string): Promise<void> {
    // only paper lines can be deleted; signed lines are history
    return this.commit((s) => ({ ...s, entries: s.entries.filter((e) => !(e.id === id && e.status === 'paper')) }));
  }

  updateSettings(patch: Partial<Settings>): Promise<void> {
    return this.commit((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  }

  /* ------------------------------------------------------------ restore */

  /** Pull the encrypted backup and every wrapped message, then drop ecash that was spent meanwhile. */
  restoreFromRelays(): Promise<{ fromBackup: boolean; messages: number }> {
    return this.exclusive(async () => {
      const b = await T.fetchBackup<State>(this.id.sk, this.id.pk, this.state.relays);
      if (b && b.state?.v === 1) {
        const keepRelays = this.state.relays;
        this.state = { ...b.state, relays: keepRelays.length ? keepRelays : b.state.relays, processed: [] };
      }
      const inbox = await T.fetchInbox(this.id.sk, this.id.pk, this.state.relays);
      inbox.sort((a, b2) => a.at - b2.at);
      for (const m of inbox) await this.handleInbound(m).catch(() => undefined);
      try {
        const pruned = await W.pruneSpent(this.state.mint, this.state.proofs);
        await this.commit((s) => ({ ...s, proofs: pruned }), false);
      } catch {
        /* offline: keep proofs as they are */
      }
      await this.commit((s) => s, false);
      return { fromBackup: !!b, messages: inbox.length };
    });
  }
}
