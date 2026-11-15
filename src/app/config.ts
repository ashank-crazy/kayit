/**
 * Runtime config. The bundled Node server (and Docker) serves ./kayit-config.json pointing at its own
 * relay and mint; a plain static host has none, so the public test mint and public relays are used.
 */
export interface AppConfig {
  mint: string;
  relays: string[];
  testMint: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  mint: 'https://testnut.cashu.space',
  relays: ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'],
  testMint: true,
};

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  try {
    const res = await fetch('./kayit-config.json', { cache: 'no-store' });
    if (res.ok) {
      const c = (await res.json()) as Partial<AppConfig> & { relayPath?: string };
      const relays = (c.relays ?? []).map((r) => (r.startsWith('/') ? sameOriginWs(r) : r));
      cached = {
        mint: c.mint || DEFAULT_CONFIG.mint,
        relays: relays.length ? relays : DEFAULT_CONFIG.relays,
        testMint: c.testMint ?? true,
      };
      return cached;
    }
  } catch {
    /* static hosting: fall through */
  }
  cached = DEFAULT_CONFIG;
  return cached;
}

function sameOriginWs(path: string): string {
  const u = new URL(path, location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
