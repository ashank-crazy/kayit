/**
 * Everything at rest is encrypted. A PIN unlocks a vault that holds the recovery words and a random
 * data key; the data key encrypts the notebook and the ecash proofs (which are bearer money).
 * Uses only WebCrypto: PBKDF2-SHA256 + AES-256-GCM.
 *
 * A short PIN can be brute-forced by someone who copies the phone's storage, so the PIN guards against
 * casual access (a borrowed phone) and the 12 words remain the real backup. See docs/THREAT_MODEL.md.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ITERATIONS = 310_000;

export interface SealedBox {
  v: 1;
  iv: string;
  ct: string;
}

export interface SealedVault extends SealedBox {
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
}

export interface VaultSecrets {
  mnemonic: string;
  /** base64 raw AES key used for the notebook */
  dataKey: string;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto unavailable (needs https or localhost)');
  return s;
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function random(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

async function pinKey(pin: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, plaintext: string): Promise<SealedBox> {
  const iv = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

async function open(key: CryptoKey, box: SealedBox): Promise<string> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return dec.decode(pt);
}

export async function createVault(pin: string, mnemonic: string, iter = PBKDF2_ITERATIONS): Promise<{ vault: SealedVault; secrets: VaultSecrets }> {
  if (!isValidPin(pin)) throw new Error('PIN must be 4 to 8 digits');
  const secrets: VaultSecrets = { mnemonic, dataKey: b64(random(32)) };
  const salt = random(16);
  const box = await seal(await pinKey(pin, salt, iter), JSON.stringify(secrets));
  return { vault: { ...box, kdf: 'PBKDF2-SHA256', iter, salt: b64(salt) }, secrets };
}

/** Throws on a wrong PIN (AES-GCM authentication fails). */
export async function openVault(pin: string, vault: SealedVault): Promise<VaultSecrets> {
  const key = await pinKey(pin, unb64(vault.salt), vault.iter);
  try {
    return JSON.parse(await open(key, vault)) as VaultSecrets;
  } catch {
    throw new Error('wrong PIN');
  }
}

export async function rekeyVault(oldPin: string, newPin: string, vault: SealedVault): Promise<SealedVault> {
  const secrets = await openVault(oldPin, vault);
  if (!isValidPin(newPin)) throw new Error('PIN must be 4 to 8 digits');
  const salt = random(16);
  const box = await seal(await pinKey(newPin, salt, vault.iter), JSON.stringify(secrets));
  return { ...box, kdf: 'PBKDF2-SHA256', iter: vault.iter, salt: b64(salt) };
}

export async function dataKey(secrets: VaultSecrets): Promise<CryptoKey> {
  return subtle().importKey('raw', unb64(secrets.dataKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealJson(key: CryptoKey, value: unknown): Promise<SealedBox> {
  return seal(key, JSON.stringify(value));
}

export async function openJson<T>(key: CryptoKey, box: SealedBox): Promise<T> {
  return JSON.parse(await open(key, box)) as T;
}
