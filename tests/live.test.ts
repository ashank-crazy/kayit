/**
 * End-to-end happy path with real protocols: a local Nostr relay, the public Cashu test mint
 * (testnut.cashu.space, FakeWallet: invoices are auto-paid, no real sats) and two engines.
 *
 *   Awa hosts a ngénte. Fatou tops up her caisse over Lightning, sends a locked envelope of 10 000 F,
 *   Awa's engine verifies and opens it and signs a receipt, Fatou's notebook shows the line co-signed.
 *   Then a cash gift is confirmed, and Fatou restores her notebook on a "new phone" from 12 words.
 *
 * Run with: npm run test:live  (needs internet for the test mint)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRelay } from '../server/relay.mjs';
import { Engine, emptyState, type State } from '../src/core/engine';
import { identityFromMnemonic, newMnemonic } from '../src/core/keys';
import { balances, splits } from '../src/core/ledger';
import { FALLBACK_RATE } from '../src/core/money';
import { packMessage, unpackMessage, toFrames, FrameCollector, type AirMessage } from '../src/core/airgap';

/** Send a message through the QR frame path, as the camera would read it. */
async function overQr(m: AirMessage): Promise<AirMessage> {
  const col = new FrameCollector();
  let payload: Uint8Array | undefined;
  for (const f of toFrames(await packMessage(m))) payload = col.add(f)?.payload ?? payload;
  return unpackMessage(payload!);
}

const LIVE = process.env.KAYIT_LIVE === '1';
const MINT = process.env.KAYIT_MINT || 'https://testnut.cashu.space';
const PORT = 7790 + Math.floor(Math.random() * 100);
const RELAYS = [`ws://127.0.0.1:${PORT}`];

function until(cond: () => boolean, ms = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

function engine(name: string, mnemonic = newMnemonic()) {
  const id = identityFromMnemonic(mnemonic);
  const st: State = { ...emptyState(name, MINT, RELAYS), rate: FALLBACK_RATE };
  return { e: new Engine(id, st, async () => undefined), mnemonic };
}

describe.skipIf(!LIVE)('live: envelope from Fatou to Awa', () => {
  let relay: Awaited<ReturnType<typeof createRelay>>;
  const awa = engine('Awa Diop');
  const fatou = engine('Fatou Ndiaye');

  beforeAll(() => {
    relay = createRelay({ port: PORT });
  });
  afterAll(async () => {
    awa.e.stop();
    fatou.e.stop();
    await relay.close();
  });

  it('runs the whole ceremony', async () => {
    awa.e.start();
    fatou.e.start();
    // the live rate would make the test depend on the market; pin it
    awa.e.state.rate = FALLBACK_RATE;
    fatou.e.state.rate = FALLBACK_RATE;

    // Fatou already owes Awa 5 000 F from her own wedding (an old paper line, linked to Awa's key)
    await fatou.e.addPaperEntry({ direction: 'in', name: 'Awa Diop', key: awa.e.id.pk, xof: 5000, ceremonyTitle: 'Mon mariage', date: 1741400000 });

    const c = await awa.e.hostCeremony({ title: 'Ngénte de bébé Aïda', type: 'ngente', start: Math.floor(Date.now() / 1000) + 86400 * 7, capXof: 20000 });

    const t = await fatou.e.topUp(40_000);
    expect(t.invoice.startsWith('ln')).toBe(true);
    // the test mint marks invoices paid after a few seconds
    let added = 0;
    for (let i = 0; i < 20 && added === 0; i++) {
      added = await fatou.e.checkTopUps();
      if (!added) await new Promise((r) => setTimeout(r, 700));
    }
    expect(added).toBe(40_000);
    expect(fatou.e.balanceSats()).toBe(40_000);

    const arrivals: string[] = [];
    awa.e.onArrival((a) => arrivals.push(`${a.name}:${a.xof}:${a.status}`));

    const gift = await fatou.e.giveEcash(c, 10_000, 'Barkeel Aïda');
    // the engine may have fetched the live BTC price meanwhile, so read the amount from the signed gift
    const sats = gift.sats!;
    expect(sats).toBeGreaterThan(0);
    expect(fatou.e.balanceSats()).toBeLessThanOrEqual(40_000 - sats);

    await until(() => awa.e.state.entries.some((e) => e.id === gift.id && e.status === 'cosigned'));
    expect(awa.e.balanceSats()).toBeGreaterThanOrEqual(sats);
    expect(arrivals).toContain(`Fatou Ndiaye:10000:cosigned`);

    await until(() => fatou.e.state.entries.some((e) => e.id === gift.id && e.status === 'cosigned'));
    expect(fatou.e.state.outbox.find((o) => o.giftId === gift.id)?.state).toBe('opened');

    // 10 000 returned on a 5 000 debt = 5 000 repaid + 5 000 new advance
    const sp = splits(fatou.e.state.entries).get(gift.id)!;
    expect(sp).toEqual({ repaid: 5000, advance: 5000 });
    expect(balances(fatou.e.state.entries).find((b) => b.key === awa.e.id.pk)?.balance).toBe(-5000);

    // cash gift: Fatou says she also handed 2 000 F to the host's sister in cash; Awa confirms
    const cash = await fatou.e.giveCash(c, 2000, 'pour les invités');
    await until(() => awa.e.state.pending.some((p) => p.gift.id === cash.id));
    await awa.e.confirmCash(cash.id);
    await until(() => fatou.e.state.entries.some((e) => e.id === cash.id && e.status === 'cosigned'));

    // envelope locked to Awa cannot be opened by anyone else (re-delivery to a stranger is ignored)
    const stranger = engine('Stranger');
    const env = fatou.e.state.outbox.find((o) => o.giftId === gift.id)!;
    await expect(
      import('../src/core/wallet').then((W) => W.inspectEnvelope(env.token, MINT, stranger.e.id.lockPk)),
    ).resolves.toMatchObject({ ok: false });

    // envelope handed over in person: prepared at home (online), checked and receipted with NO network
    await awa.e.refreshMintKeys();
    const hand = await fatou.e.prepareEnvelope(c, 5000, 'De la part de la famille Ndiaye');
    expect(fatou.e.state.outbox.find((o) => o.giftId === hand.id)?.state).toBe('prepared');
    const shown = await overQr(fatou.e.handoverMessage(hand.id));
    const awaBefore = awa.e.balanceSats();
    const realFetch = globalThis.fetch;
    let blocked = 0;
    globalThis.fetch = (async () => {
      blocked++;
      throw new TypeError('offline');
    }) as typeof fetch;
    let accepted: Awaited<ReturnType<typeof awa.e.acceptHanded>>;
    try {
      // a stranger's phone refuses the envelope
      await expect(engine('Stranger').e.acceptHanded(shown)).rejects.toThrow('not-for-me');
      // a token swapped after signing is refused
      const other = fatou.e.state.outbox.find((o) => o.giftId === gift.id)!.token;
      await expect(awa.e.acceptHanded({ ...shown, token: other } as AirMessage)).rejects.toThrow('token-mismatch');
      accepted = await awa.e.acceptHanded(shown);
      // Fatou scans the receipt from Awa's screen, still offline
      await fatou.e.acceptScannedReceipt(await overQr({ kind: 'receipt', receipt: accepted.receipt, gift: accepted.gift.event }));
      await new Promise((r) => setTimeout(r, 300)); // the background cash-in tries, and fails, offline
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(blocked).toBeGreaterThan(0); // the mint really was unreachable meanwhile
    expect(accepted.already).toBe(false);
    expect(awa.e.state.entries.find((e) => e.id === hand.id)?.status).toBe('cosigned');
    expect(fatou.e.state.entries.find((e) => e.id === hand.id)?.status).toBe('cosigned');
    expect(fatou.e.state.outbox.find((o) => o.giftId === hand.id)?.state).toBe('handed');
    expect(awa.e.toRedeemSats()).toBeGreaterThanOrEqual(hand.sats!); // the token also carries the swap fee
    expect(awa.e.balanceSats()).toBe(awaBefore);
    // the network is back: Awa's phone cashes the envelope
    await awa.e.flushHanded();
    expect(awa.e.toRedeemSats()).toBe(0);
    expect(awa.e.balanceSats()).toBeGreaterThanOrEqual(awaBefore + hand.sats!);
    // …and tells Fatou over Nostr that it is cashed
    await until(() => fatou.e.state.outbox.find((o) => o.giftId === hand.id)?.state === 'opened');
    expect((await awa.e.acceptHanded(shown)).already).toBe(true);

    // Fatou loses her phone: restore from the 12 words on a new device
    await fatou.e.backupNow();
    await fatou.e.backupNow(); // the second save goes to the other slot
    // a third save cut off after its first part (tab closed) must not damage the backup already there
    {
      const { finalizeEvent } = await import('nostr-tools/pure');
      const { SimplePool } = await import('nostr-tools/pool');
      const nip44 = await import('nostr-tools/nip44');
      const pool = new SimplePool();
      const key = nip44.getConversationKey(fatou.e.id.sk, fatou.e.id.pk);
      const [manifest] = await pool.querySync(RELAYS, { kinds: [30078], authors: [fatou.e.id.pk], '#d': ['kayit:backup:v2'] });
      const live = JSON.parse(nip44.decrypt(manifest.content, key)) as { slot: 'a' | 'b' };
      const other = live.slot === 'a' ? 'b' : 'a';
      const cut = finalizeEvent({ kind: 30078, created_at: manifest.created_at + 1, tags: [['d', `kayit:backup:v2:${other}:0`]], content: nip44.encrypt(JSON.stringify({ id: 'unfinished', i: 0, p: 'AAAA' }), key) }, fatou.e.id.sk);
      await Promise.any(pool.publish(RELAYS, cut));
      pool.close(RELAYS);
    }
    const phone2 = engine('?', fatou.mnemonic);
    const r = await phone2.e.restoreFromRelays();
    expect(r.fromBackup).toBe(true);
    const restored = phone2.e.state.entries.filter((e) => e.status === 'cosigned').map((e) => e.id).sort();
    expect(restored).toEqual([gift.id, cash.id, hand.id].sort());
    expect(phone2.e.balanceSats()).toBe(fatou.e.balanceSats());
  });
});
