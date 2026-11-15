/**
 * Keys. One 12-word phrase (NIP-06) derives two sibling keys:
 *  - account 0: the Nostr identity that signs notebook entries;
 *  - account 1: the ecash lock key that gift envelopes are locked to (NUT-11).
 * Keeping them apart means a leaked lock key cannot sign entries in your name, and the other way round.
 */
import { generateSeedWords, validateWords, privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface Identity {
  sk: Uint8Array;
  /** x-only hex pubkey, Nostr style */
  pk: string;
  lockSkHex: string;
  /** compressed (02-prefixed) pubkey used in NUT-11 secrets */
  lockPk: string;
}

export function newMnemonic(): string {
  return generateSeedWords();
}

export function normalizeMnemonic(words: string): string {
  return words.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(words: string): boolean {
  try {
    return validateWords(normalizeMnemonic(words));
  } catch {
    return false;
  }
}

export function identityFromMnemonic(mnemonic: string): Identity {
  const m = normalizeMnemonic(mnemonic);
  if (!isValidMnemonic(m)) throw new Error('invalid recovery words');
  const sk = privateKeyFromSeedWords(m, undefined, 0);
  const lockSk = privateKeyFromSeedWords(m, undefined, 1);
  return {
    sk,
    pk: getPublicKey(sk),
    lockSkHex: bytesToHex(lockSk),
    lockPk: '02' + getPublicKey(lockSk),
  };
}

export function shortKey(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 6)}…${pk.slice(-4)}` : pk;
}
