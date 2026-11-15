import { describe, it, expect } from 'vitest';
import { finalizeEvent } from 'nostr-tools/pure';
import { formatXof, parseXof, xofToSats, satsToXof, roundToNote, FALLBACK_RATE, XOF_PER_EUR, xofPerSat } from '../src/core/money';
import { balances, splits, suggest, totals, nameKey, type Entry } from '../src/core/ledger';
import {
  createCeremony,
  createGift,
  createReceipt,
  parseGift,
  parseReceipt,
  parseCeremony,
  receiptMatches,
  invitationLink,
  parseInvitation,
  tokenHash,
  KIND_GIFT,
} from '../src/core/protocol';
import { identityFromMnemonic, newMnemonic, isValidMnemonic } from '../src/core/keys';
import { createVault, openVault, rekeyVault, dataKey, sealJson, openJson } from '../src/core/vault';

const awa = identityFromMnemonic(newMnemonic());
const fatou = identityFromMnemonic(newMnemonic());

function ceremony() {
  return createCeremony(awa.sk, {
    hostName: 'Awa Diop',
    title: 'Ngénte de bébé Aïda',
    type: 'ngente',
    start: 1795000000,
    lockPk: awa.lockPk,
    mint: 'https://testnut.cashu.space',
    relays: ['wss://relay.example'],
    capXof: 10000,
  });
}

describe('money', () => {
  it('uses the fixed CFA peg', () => {
    expect(XOF_PER_EUR).toBe(655.957);
    const sats = xofToSats(10_000, FALLBACK_RATE);
    expect(satsToXof(sats, FALLBACK_RATE)).toBeGreaterThanOrEqual(10_000); // never short-changes the host
    expect((sats - 1) * xofPerSat(FALLBACK_RATE)).toBeLessThan(10_000);
  });
  it('parses what people type', () => {
    expect(parseXof('10 000')).toBe(10000);
    expect(parseXof('10.000 F')).toBe(10000);
    expect(parseXof('5k')).toBe(5000);
    expect(parseXof('2500fcfa')).toBe(2500);
    expect(parseXof('-3')).toBeNull();
    expect(parseXof('abc')).toBeNull();
    expect(parseXof('0')).toBeNull();
  });
  it('formats like a cahier', () => {
    expect(formatXof(10000)).toBe('10 000 F');
    expect(roundToNote(7260)).toBe(7500);
    expect(roundToNote(100)).toBe(500);
  });
});

describe('keys and vault', () => {
  it('derives separate identity and lock keys from 12 words', () => {
    const m = newMnemonic();
    expect(m.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(m)).toBe(true);
    const a = identityFromMnemonic(m);
    const b = identityFromMnemonic('  ' + m.toUpperCase().replace(/ /g, '   ') + ' ');
    expect(a.pk).toBe(b.pk);
    expect(a.lockPk.slice(2)).not.toBe(a.pk);
    expect(a.lockPk).toMatch(/^02[0-9a-f]{64}$/);
    expect(() => identityFromMnemonic('not twelve real words')).toThrow();
  });
  it('locks secrets under a PIN and rejects a wrong one', async () => {
    const { vault, secrets } = await createVault('2468', 'words here', 1000);
    expect(JSON.stringify(vault)).not.toContain('words here');
    expect((await openVault('2468', vault)).mnemonic).toBe('words here');
    await expect(openVault('1357', vault)).rejects.toThrow('wrong PIN');
    const v2 = await rekeyVault('2468', '97531', vault);
    expect((await openVault('97531', v2)).dataKey).toBe(secrets.dataKey);
    const key = await dataKey(secrets);
    const box = await sealJson(key, { proofs: ['secret'] });
    expect(JSON.stringify(box)).not.toContain('secret');
    expect(await openJson(key, box)).toEqual({ proofs: ['secret'] });
  });
});

describe('protocol', () => {
  it('round-trips a ceremony through an invitation link', () => {
    const c = ceremony();
    const link = invitationLink('https://kayit.example/app/?x=1#/home', c);
    expect(link.startsWith('https://kayit.example/app/?x=1#/invite/')).toBe(true);
    const back = parseInvitation(link.split('#/invite/')[1]);
    expect(back?.ref).toBe(c.ref);
    expect(back?.capXof).toBe(10000);
    expect(back?.hostName).toBe('Awa Diop');
  });

  it('rejects a tampered ceremony', () => {
    const c = ceremony();
    const forged = { ...c.event, tags: c.event.tags.map((t) => (t[0] === 'lock' ? ['lock', fatou.lockPk] : t)) };
    expect(parseCeremony(forged)).toBeNull();
  });

  it('builds gifts and receipts that check each other', () => {
    const c = ceremony();
    const token = 'cashuBfake';
    const g = createGift(fatou.sk, { ceremony: c, giverName: 'Fatou Ndiaye', xof: 10000, method: 'ecash', sats: 25000, token, message: 'Barkeel' });
    expect(g.tokenHash).toBe(tokenHash(token));
    expect(g.hostPk).toBe(awa.pk);
    const r = createReceipt(awa.sk, g, 'redeemed');
    expect(receiptMatches(g, r)).toBe(true);
    // a receipt for another amount, from someone else, or with the wrong status does not count
    const other = createGift(fatou.sk, { ceremony: c, giverName: 'Fatou', xof: 20000, method: 'ecash', sats: 50000, token });
    expect(receiptMatches(other, r)).toBe(false);
    const byFatou = createReceipt(fatou.sk, g, 'redeemed');
    expect(receiptMatches(g, byFatou)).toBe(false);
    const cashStatus = createReceipt(awa.sk, g, 'received');
    expect(receiptMatches(g, cashStatus)).toBe(false);
  });

  it('refuses tampered or malformed gifts', () => {
    const c = ceremony();
    const g = createGift(fatou.sk, { ceremony: c, giverName: 'Fatou', xof: 5000, method: 'cash' });
    const inflated = { ...g.event, tags: g.event.tags.map((t) => (t[0] === 'amount' ? ['amount', '50000', 'XOF'] : t)) };
    expect(parseGift(inflated)).toBeNull();
    const badAmount = finalizeEvent({ kind: KIND_GIFT, created_at: 1, content: '', tags: [['p', awa.pk], ['a', c.ref], ['amount', '-5', 'XOF'], ['method', 'cash']] }, fatou.sk);
    expect(parseGift(badAmount)).toBeNull();
    const wrongCeremonyHost = finalizeEvent(
      { kind: KIND_GIFT, created_at: 1, content: '', tags: [['p', fatou.pk], ['a', c.ref], ['amount', '5', 'XOF'], ['method', 'cash']] },
      fatou.sk,
    );
    expect(parseGift(wrongCeremonyHost)).toBeNull();
    expect(() => createGift(fatou.sk, { ceremony: c, giverName: 'F', xof: 5000, method: 'ecash' })).toThrow();
    expect(parseReceipt({ ...g.event })).toBeNull();
  });

  it('strips control characters from free text', () => {
    const c = ceremony();
    const g = createGift(fatou.sk, { ceremony: c, giverName: 'Fa\u0000tou', xof: 1000, method: 'cash', message: 'a\u0007b' });
    expect(g.giverName).toBe('Fa tou');
    expect(g.message).toBe('a b');
  });
});

describe('ledger', () => {
  const line = (id: string, direction: 'in' | 'out', who: string, xof: number, at: number, status: Entry['status'] = 'cosigned'): Entry => ({
    id,
    direction,
    counterpartKey: who,
    counterpartName: who,
    ceremonyTitle: 't',
    ceremonyDate: at,
    xof,
    method: 'cash',
    status,
    at,
  });

  const history: Entry[] = [
    line('1', 'out', 'mame', 5000, 100), // I gave Mame 5 000 at her wedding
    line('2', 'in', 'mame', 10000, 200), // she returned it doubled at my ngénte
    line('3', 'in', 'ndeye', 15000, 210),
    line('4', 'out', 'khady', 4000, 220),
    line('5', 'in', 'khady', 2000, 50),
    line('6', 'in', 'rejected', 9999, 300, 'rejected'),
    line('7', 'in', 'pending', 7777, 300, 'awaiting-my-ok'),
  ];

  it('nets each relationship', () => {
    const b = Object.fromEntries(balances(history).map((x) => [x.key, x.balance]));
    expect(b).toEqual({ mame: 5000, ndeye: 15000, khady: -2000 });
    const t = totals(history);
    expect(t.iOwe).toBe(20000);
    expect(t.owedToMe).toBe(2000);
    expect(t.peopleIOwe).toBe(2);
  });

  it('splits a doubled return into repayment and new advance', () => {
    const s = splits(history);
    expect(s.get('1')).toEqual({ repaid: 0, advance: 5000 });
    expect(s.get('2')).toEqual({ repaid: 5000, advance: 5000 });
    expect(s.get('4')).toEqual({ repaid: 2000, advance: 2000 });
    expect(s.has('6')).toBe(false);
  });

  it('suggests what to bring, and a pacte cap wins', () => {
    expect(suggest(history, 'ndeye', 1)).toMatchObject({ owed: 15000, suggested: 15000, newAdvance: 0, reason: 'repay' });
    expect(suggest(history, 'ndeye', 2)).toMatchObject({ suggested: 30000, newAdvance: 15000 });
    expect(suggest(history, 'ndeye', 2, 10000)).toMatchObject({ suggested: 10000, capped: true });
    expect(suggest(history, 'stranger', 2)).toMatchObject({ owed: 0, reason: 'usual', suggested: 5000 });
    expect(suggest([], 'x', 2)).toMatchObject({ suggested: 2000, reason: 'none' });
  });

  it('groups paper lines by normalized name', () => {
    expect(nameKey('  Ndèye   FALL ')).toBe('name:ndeye fall');
  });
});
