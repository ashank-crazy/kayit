/**
 * Profiles on this device. Each profile = one sealed vault (PIN) + one sealed notebook state.
 * Several profiles can live on one phone (a family often shares one), and the demo uses two.
 * Which profile is open is remembered per browser tab only, so two tabs can play host and guest.
 */
import { Engine, emptyState, type State } from '../core/engine';
import { identityFromMnemonic, newMnemonic, normalizeMnemonic, type Identity } from '../core/keys';
import { createVault, openVault, rekeyVault, dataKey, sealJson, openJson, type SealedVault, type SealedBox } from '../core/vault';
import { randomId } from '../core/protocol';
import { loadConfig } from './config';
import { lang } from './i18n';

export interface ProfileMeta {
  id: string;
  name: string;
  pk: string;
  demo?: { pin: string; role: 'host' | 'guest' };
  createdAt: number;
}

const K_PROFILES = 'kayit:profiles';
const kVault = (id: string) => `kayit:vault:${id}`;
const kState = (id: string) => `kayit:state:${id}`;
const kTab = 'kayit:tab-profile';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown): void {
  localStorage.setItem(key, JSON.stringify(v));
}

export function listProfiles(): ProfileMeta[] {
  return readJson<ProfileMeta[]>(K_PROFILES, []);
}

function saveProfiles(p: ProfileMeta[]): void {
  writeJson(K_PROFILES, p);
}

export function tabProfile(): string | null {
  try {
    return sessionStorage.getItem(kTab);
  } catch {
    return null;
  }
}

function setTabProfile(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(kTab, id);
    else sessionStorage.removeItem(kTab);
  } catch {
    /* private mode */
  }
}

export interface OpenSession {
  meta: ProfileMeta;
  engine: Engine;
  mnemonic: string;
}

function persister(id: string, key: CryptoKey): (s: State) => Promise<void> {
  let chain = Promise.resolve();
  return (s: State) => {
    chain = chain.then(async () => {
      const box = await sealJson(key, s);
      localStorage.setItem(kState(id), JSON.stringify(box));
    });
    return chain;
  };
}

async function makeSession(meta: ProfileMeta, mnemonic: string, key: CryptoKey, state: State): Promise<OpenSession> {
  const id: Identity = identityFromMnemonic(mnemonic);
  const engine = new Engine(id, state, persister(meta.id, key));
  setTabProfile(meta.id);
  return { meta, engine, mnemonic };
}

export async function createProfile(name: string, pin: string, mnemonic = newMnemonic(), demo?: ProfileMeta['demo']): Promise<OpenSession> {
  const cfg = await loadConfig();
  const m = normalizeMnemonic(mnemonic);
  const ident = identityFromMnemonic(m);
  const { vault, secrets } = await createVault(pin, m);
  const meta: ProfileMeta = { id: randomId(), name: name.trim().slice(0, 60), pk: ident.pk, demo, createdAt: Date.now() };
  writeJson(kVault(meta.id), vault);
  const key = await dataKey(secrets);
  const state = emptyState(meta.name, cfg.mint, cfg.relays, lang());
  localStorage.setItem(kState(meta.id), JSON.stringify(await sealJson(key, state)));
  saveProfiles([...listProfiles().filter((p) => p.pk !== meta.pk), meta]);
  return makeSession(meta, m, key, state);
}

export async function unlockProfile(id: string, pin: string): Promise<OpenSession> {
  const meta = listProfiles().find((p) => p.id === id);
  if (!meta) throw new Error('unknown profile');
  if (openElsewhere(id)) throw new Error('open-elsewhere');
  const vault = readJson<SealedVault | null>(kVault(id), null);
  if (!vault) throw new Error('vault missing');
  const secrets = await openVault(pin, vault);
  const key = await dataKey(secrets);
  const box = readJson<SealedBox | null>(kState(id), null);
  const cfg = await loadConfig();
  const state = box ? await openJson<State>(key, box) : emptyState(meta.name, cfg.mint, cfg.relays);
  return makeSession(meta, secrets.mnemonic, key, state);
}

export async function changePin(id: string, oldPin: string, newPin: string): Promise<void> {
  const vault = readJson<SealedVault | null>(kVault(id), null);
  if (!vault) throw new Error('vault missing');
  writeJson(kVault(id), await rekeyVault(oldPin, newPin, vault));
  saveProfiles(listProfiles().map((p) => (p.id === id ? { ...p, demo: undefined } : p)));
}

export function forgetProfile(id: string): void {
  localStorage.removeItem(kVault(id));
  localStorage.removeItem(kState(id));
  saveProfiles(listProfiles().filter((p) => p.id !== id));
  if (tabProfile() === id) setTabProfile(null);
}

export function lockTab(): void {
  setTabProfile(null);
}

/* One tab per notebook: two tabs writing the same encrypted state would overwrite each other's proofs. */
const TAB_ID = randomId();
const kOpen = (id: string) => `kayit:open:${id}`;

export function openElsewhere(id: string): boolean {
  const v = readJson<{ tab: string; at: number } | null>(kOpen(id), null);
  return !!v && v.tab !== TAB_ID && Date.now() - v.at < 8000;
}

export function heartbeat(id: string): void {
  writeJson(kOpen(id), { tab: TAB_ID, at: Date.now() });
}

export function release(id: string): void {
  const v = readJson<{ tab: string } | null>(kOpen(id), null);
  if (v?.tab === TAB_ID) localStorage.removeItem(kOpen(id));
}

export function renameProfile(id: string, name: string): void {
  saveProfiles(listProfiles().map((p) => (p.id === id ? { ...p, name } : p)));
}
