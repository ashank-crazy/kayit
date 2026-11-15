/**
 * The cahier de ndawtal as data.
 *
 * Every line is a gift between two people at one ceremony. "in" means I received it (so I owe that person),
 * "out" means I gave it. Custom says a gift is returned at the giver's next ceremony, often doubled, so a
 * returned gift is really two things: a repayment and a new advance. Kayit makes that split visible.
 */
import type { NostrEvent } from 'nostr-tools/pure';
import { roundToNote } from './money';

export type Direction = 'in' | 'out';
export type EntryMethod = 'ecash' | 'cash' | 'paper';
export type EntryStatus =
  | 'cosigned' // gift signed by giver + receipt signed by host
  | 'awaiting-receipt' // I gave; host has not acknowledged yet
  | 'awaiting-my-ok' // someone says they gave me cash; I must confirm
  | 'paper' // written by me only (old notebook / guest without Kayit)
  | 'rejected'
  | 'reclaimed'; // envelope never opened; giver took the sats back after the lock expired

export interface Entry {
  id: string;
  direction: Direction;
  counterpartKey: string; // pk hex, or "name:<normalized>" for paper entries
  counterpartName: string;
  ceremonyTitle: string;
  ceremonyRef?: string;
  ceremonyDate: number; // unix seconds
  xof: number;
  method: EntryMethod;
  sats?: number;
  status: EntryStatus;
  at: number; // unix seconds the gift was made
  message?: string;
  gift?: NostrEvent;
  receipt?: NostrEvent;
}

export interface Split {
  repaid: number;
  advance: number;
}

export interface PersonBalance {
  key: string;
  name: string;
  /** > 0: I owe them. < 0: they owe me. */
  balance: number;
  lines: number;
  lastAt: number;
}

export function nameKey(name: string): string {
  return (
    'name:' +
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Lines that count toward what people owe each other. */
export function counts(e: Entry): boolean {
  return e.status !== 'rejected' && e.status !== 'reclaimed' && e.status !== 'awaiting-my-ok';
}

function signedAmount(e: Entry): number {
  return e.direction === 'in' ? e.xof : -e.xof;
}

export function balances(entries: Entry[]): PersonBalance[] {
  const map = new Map<string, PersonBalance>();
  for (const e of entries) {
    if (!counts(e)) continue;
    const p = map.get(e.counterpartKey) ?? { key: e.counterpartKey, name: e.counterpartName, balance: 0, lines: 0, lastAt: 0 };
    p.balance += signedAmount(e);
    p.lines += 1;
    if (e.at >= p.lastAt) {
      p.lastAt = e.at;
      p.name = e.counterpartName || p.name;
    }
    map.set(e.counterpartKey, p);
  }
  return [...map.values()].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || b.lastAt - a.lastAt);
}

export function balanceWith(entries: Entry[], key: string): number {
  let b = 0;
  for (const e of entries) if (e.counterpartKey === key && counts(e)) b += signedAmount(e);
  return b;
}

/** For each counted line, how much of it settles an older debt and how much is a fresh advance. */
export function splits(entries: Entry[]): Map<string, Split> {
  const out = new Map<string, Split>();
  const running = new Map<string, number>(); // > 0: I owe them
  const ordered = [...entries].filter(counts).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const e of ordered) {
    const b = running.get(e.counterpartKey) ?? 0;
    let repaid: number;
    if (e.direction === 'out') {
      repaid = Math.min(e.xof, Math.max(b, 0));
      running.set(e.counterpartKey, b - e.xof);
    } else {
      repaid = Math.min(e.xof, Math.max(-b, 0));
      running.set(e.counterpartKey, b + e.xof);
    }
    out.set(e.id, { repaid, advance: e.xof - repaid });
  }
  return out;
}

export interface Totals {
  iOwe: number;
  owedToMe: number;
  peopleIOwe: number;
  peopleOweMe: number;
  received: number;
  given: number;
}

export function totals(entries: Entry[]): Totals {
  const bs = balances(entries);
  const t: Totals = { iOwe: 0, owedToMe: 0, peopleIOwe: 0, peopleOweMe: 0, received: 0, given: 0 };
  for (const b of bs) {
    if (b.balance > 0) {
      t.iOwe += b.balance;
      t.peopleIOwe++;
    } else if (b.balance < 0) {
      t.owedToMe += -b.balance;
      t.peopleOweMe++;
    }
  }
  for (const e of entries) {
    if (!counts(e)) continue;
    if (e.direction === 'in') t.received += e.xof;
    else t.given += e.xof;
  }
  return t;
}

export interface Suggestion {
  /** what I still owe this person */
  owed: number;
  /** what custom (my chosen multiplier) suggests giving */
  suggested: number;
  /** the part of the suggestion that is a new advance they will owe me */
  newAdvance: number;
  capped: boolean;
  reason: 'repay' | 'usual' | 'none';
}

/**
 * What to bring to this person's ceremony. multiplier = 1 returns exactly what you owe; 2 is the
 * "on double" custom. A ceremony cap (a "pacte" agreed by the family) always wins.
 */
export function suggest(entries: Entry[], key: string, multiplier: number, capXof?: number): Suggestion {
  const owed = Math.max(0, balanceWith(entries, key));
  let suggested: number;
  let reason: Suggestion['reason'];
  if (owed > 0) {
    suggested = roundToNote(owed * multiplier);
    reason = 'repay';
  } else {
    const mine = entries.filter((e) => e.direction === 'out' && counts(e)).map((e) => e.xof).sort((a, b) => a - b);
    suggested = mine.length ? roundToNote(mine[Math.floor(mine.length / 2)]) : 2000;
    reason = mine.length ? 'usual' : 'none';
  }
  let capped = false;
  if (capXof && suggested > capXof) {
    suggested = capXof;
    capped = true;
  }
  return { owed, suggested, newAdvance: Math.max(0, suggested - owed), capped, reason };
}

export function upsertEntry(entries: Entry[], e: Entry): Entry[] {
  const i = entries.findIndex((x) => x.id === e.id);
  if (i < 0) return [...entries, e];
  const next = entries.slice();
  next[i] = { ...entries[i], ...e };
  return next;
}
