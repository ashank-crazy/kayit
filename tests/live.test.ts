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

    // Fatou loses her phone: restore from the 12 words on a new device
    await fatou.e.backupNow();
    const phone2 = engine('?', fatou.mnemonic);
    const r = await phone2.e.restoreFromRelays();
    expect(r.fromBackup).toBe(true);
    const restored = phone2.e.state.entries.filter((e) => e.status === 'cosigned').map((e) => e.id).sort();
    expect(restored).toEqual([gift.id, cash.id].sort());
    expect(phone2.e.balanceSats()).toBe(fatou.e.balanceSats());
  });
});
