/**
 * Demo: two people with a real history, on this device.
 *   Awa Diop (host, PIN 1111) is organizing her daughter's ngénte next Saturday.
 *   Fatou Ndiaye (guest, PIN 2222) owes Awa 5 000 F from Fatou's wedding, and is invited.
 * Their old cahier lines are "paper" lines; everything they do from now on is signed and real
 * (test-mint ecash over Lightning, Nostr relays).
 */
import { createProfile, type OpenSession } from './session';
import { createCeremony } from '../core/protocol';
import { identityFromMnemonic, newMnemonic } from '../core/keys';
import type { Engine } from '../core/engine';

export const DEMO_PINS = { awa: '1111', fatou: '2222' } as const;

function date(y: number, m: number, d: number): number {
  return Math.floor(new Date(y, m - 1, d, 11).getTime() / 1000);
}

function nextSaturday(): number {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  d.setHours(10, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export async function createDemo(): Promise<{ awa: OpenSession; fatou: OpenSession }> {
  const awa = await createProfile('Awa Diop', DEMO_PINS.awa, newMnemonic(), { pin: DEMO_PINS.awa, role: 'host' });
  const fatou = await createProfile('Fatou Ndiaye', DEMO_PINS.fatou, newMnemonic(), { pin: DEMO_PINS.fatou, role: 'guest' });
  const A = awa.engine;
  const F = fatou.engine;

  // Ndèye Fall exists only as a key that signed an invitation to Awa
  const ndeye = identityFromMnemonic(newMnemonic());

  // --- Awa's old cahier
  const awaPaper: Array<[dir: 'in' | 'out', name: string, xof: number, title: string, at: number, key?: string]> = [
    ['out', 'Mame Diarra Ndiaye', 5000, 'Mariage de Mame Diarra', date(2023, 4, 15)],
    ['in', 'Khady Sarr', 2000, 'Ngénte de Moussa', date(2024, 2, 3)],
    ['in', 'Mame Diarra Ndiaye', 10000, 'Ngénte de Moussa', date(2024, 2, 3)],
    ['in', 'Ndèye Fall', 15000, 'Ngénte de Moussa', date(2024, 2, 3), ndeye.pk],
    ['out', 'Fatou Ndiaye', 5000, 'Mariage de Fatou', date(2025, 3, 8), F.id.pk],
    ['out', 'Khady Sarr', 4000, 'Baptême chez Khady', date(2025, 6, 21)],
    ['out', 'Coumba Diop', 3000, 'Mariage de Coumba', date(2025, 7, 12)],
    ['in', 'Aminata Sow', 5000, 'Tour de famille', date(2025, 12, 20)],
  ];
  for (const [direction, name, xof, ceremonyTitle, d, key] of awaPaper) {
    await A.addPaperEntry({ direction, name, xof, ceremonyTitle, date: d, key });
  }
  const ndeyeWedding = createCeremony(ndeye.sk, {
    hostName: 'Ndèye Fall',
    title: 'Mariage de Sokhna Fall',
    type: 'mariage',
    start: nextSaturday() + 21 * 86400,
    lockPk: ndeye.lockPk,
    mint: A.state.mint,
    relays: A.state.relays,
  });
  await A.addInvitation(ndeyeWedding);

  // Awa's ceremony, with a family pacte: no envelope above 10 000 F
  const aida = await A.hostCeremony({ title: 'Ngénte de bébé Aïda', type: 'ngente', start: nextSaturday(), capXof: 10000 });

  // --- Fatou's old cahier
  const fatouPaper: Array<[dir: 'in' | 'out', name: string, xof: number, title: string, at: number, key?: string]> = [
    ['in', 'Awa Diop', 5000, 'Mon mariage', date(2025, 3, 8), A.id.pk],
    ['in', 'Aminata Sow', 2500, 'Mon mariage', date(2025, 3, 8)],
    ['out', 'Aminata Sow', 5000, 'Baptême de Cheikh', date(2025, 9, 6)],
    ['in', 'Bineta Gueye', 3000, 'Mon mariage', date(2025, 3, 8)],
  ];
  for (const [direction, name, xof, ceremonyTitle, d, key] of fatouPaper) {
    await F.addPaperEntry({ direction, name, xof, ceremonyTitle, date: d, key });
  }
  await F.addInvitation(aida);
  return { awa, fatou };
}

/** Fill a caisse from the test mint (its invoices pay themselves after a few seconds). */
export async function fundFromTestMint(engine: Engine, sats: number, onTick?: (msg: string) => void): Promise<number> {
  await engine.topUp(sats);
  for (let i = 0; i < 30; i++) {
    const added = await engine.checkTopUps();
    if (added) return added;
    onTick?.(`${i + 1}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0;
}
