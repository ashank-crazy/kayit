# Kayit threat model

Scope: the Kayit PWA, the bundled server (`server/serve.mjs` + `server/relay.mjs`), the Cashu mint it talks to and
the Nostr relays it uses. Version 0.1, test mint only.

## What we protect

| Asset | Why it matters |
|---|---|
| **Ecash proofs** in the caisse and in envelopes | They are money. Whoever holds unlocked proofs can spend them. |
| **The 12‑word seed** | It derives the Nostr identity and the ecash lock key, and restores everything. |
| **The notebook** (who gave what to whom) | Social and financial history. Leaking it causes shame (*gàcce*); forging it causes disputes. |
| **Integrity of each line** | The whole point: a gift amount must not be inflated, denied or invented later. |
| **Guests' privacy at the ceremony** | Who gave how much is sensitive; *sutura* (discretion) is a value, not a feature. |

## Who we defend against

1. **Someone who picks up an unlocked or locked phone** at the ceremony.
2. **A guest or host who later disputes a gift** ("I gave 10 000" / "you gave 5 000").
3. **Someone who intercepts the invitation link or relay traffic**, including a malicious relay.
4. **A malicious or compromised web server** hosting the app.
5. **A dishonest mint** (custodial risk).
6. **A malformed or hostile event** crafted to crash or confuse the app.

Out of scope for v0.1: a fully compromised phone OS or browser, a malicious browser extension, coercion of the user.

## Threats and mitigations

### 1. Phone in the wrong hands

| Threat | Mitigation |
|---|---|
| Reading the notebook or seed from storage | Seed and a random 256‑bit data key are sealed under the PIN with PBKDF2‑SHA256 (310 000 rounds) → AES‑256‑GCM. All state in `localStorage` is AES‑GCM encrypted with the data key. Only the profile list (name, public key, random id) and a one‑tab lock heartbeat are stored in clear. |
| Guessing the PIN on screen | After 5 misses, a wait of 30 s that doubles with each further miss (max 1 h). The counter is in `localStorage`, so reloads and new tabs do not reset it. |
| Shoulder surfing at the ceremony | *Sutura* mode hides amounts on the board; the seed is shown only after re‑entering the PIN. |
| **Residual risk** | A 4–8 digit PIN can be brute‑forced offline by someone who copies browser storage: PBKDF2 slows each guess, but the PIN space is small for a PC. Users should keep a device lock. A future version can use WebAuthn / platform keystore to bind the vault to the device. |

### 2. Disputed gifts

| Threat | Mitigation |
|---|---|
| Host claims less was received | The giver holds the host's **signed receipt** (kind 9331) naming the gift id and amount. |
| Giver claims more was given | The gift (kind 9330) is **signed by the giver** at send time, and its `sha256(token)` binds it to the exact ecash token. The receipt references that exact gift id. |
| Either side edits a stored event | Every event is re‑verified on display with `strictVerify`, which checks a clean copy (nostr‑tools caches a "verified" flag that survives object spread; we found and closed that hole, see `tests/core.test.ts`). |
| Fake cash gift ("I gave 5 000 in cash") | Cash gifts land in the host's *to confirm* list and count for nobody until the host signs a receipt. The host can reject. |
| Paper lines typed in later | Marked *papier* everywhere and never shown as proven. |

### 3. Interception and malicious relays

| Threat | Mitigation |
|---|---|
| Stealing an envelope in transit | The token is **P2PK‑locked (NUT‑11)** to the host's lock key; only that key can redeem it. The giver's key is the only refund key, after `ceremony start + 30 days`. |
| Relay reads gift contents or the social graph | Gifts, tokens and receipts travel as **NIP‑59 gift wraps**: the relay sees a random throwaway sender key, the recipient key and ciphertext. Backups are NIP‑44 encrypted to self. |
| Relay or server learns the ceremony | The signed ceremony travels in the **URL fragment** (`#/invite/…`), which browsers never send to servers. |
| Relay drops or delays messages | Messages go to several relays; sending succeeds on the first that accepts. A self‑copy of each envelope restores it on the giver's new phone, so it can still be reclaimed. Unopened envelopes can be reclaimed after the locktime. |
| Replay of an old gift | Gifts are keyed by event id; a second copy is ignored. A token already redeemed is detected (`already-opened`). |
| Forged ceremony with the attacker's lock key | The ceremony is signed by the host; the invitation screen shows the host's name and a short key fingerprint. Envelopes are locked to the key **inside the signed ceremony**. Residual risk: a convincing fake host name on a link from an unknown sender — users should open links from people they know. |

### 4. Malicious web server

| Threat | Mitigation |
|---|---|
| Serving modified JavaScript | Out of reach for a web app in general. Reduced by: self‑hostable server (one command), no third‑party scripts or CDNs, strict CSP (`script-src 'self'`, `object-src 'none'`, `base-uri 'self'`). |
| Pointing the app at an attacker's mint | Mint and relays come from `/kayit-config.json`; a different mint is shown in the caisse and in technical settings, and a ceremony on another mint is refused when giving (`other-mint`). |
| Tracking | No analytics, no cookies, no fonts or images from other origins, `Referrer-Policy: no-referrer`. |

### 5. Dishonest mint

Cashu mints are custodial: a mint can refuse to redeem or disappear. Mitigations in v0.1: amounts per ceremony are
small, the host's redemption happens immediately on arrival (sats are not left in transit), the caisse lets users
withdraw to their own Lightning wallet at any time, and envelopes are checked with **DLEQ proofs (NUT‑12)** against the mint's published keys, so the host
knows the signatures are valid before redeeming. Next: let a community choose a mint it trusts, or a
federation, and show the mint's identity at top‑up.

### 6. Hostile input

| Threat | Mitigation |
|---|---|
| Huge or malformed events | Relay limit 128 KB per message, 20 subscriptions per connection, 120 events per minute per connection; signature verified before storing. |
| Bad amounts | Integers only, `0 < xof ≤ 50 000 000`, checked in `assertAmount` / `parseXof` and again when parsing every event. |
| Text injection | Names, titles and messages capped (≤ 280 chars) and stripped of control characters; rendered as text by Preact (no `innerHTML` except the locally generated QR SVG). |
| Path traversal on the server | Paths are normalised and must stay under `dist/`. |
| Unexpected envelope payloads | Discriminated union parsed field by field; anything that does not verify is dropped silently. |

## Secrets handling

- No secrets in the repository. The Docker mint seed in `docker-compose.yml` is a **test** FakeWallet seed.
- No secrets in logs. The server logs only its start‑up lines; the relay logs nothing per event.
- Private keys exist in memory only while a notebook is open; locking the tab drops them.

## Logging and privacy

- The bundled server writes no access log.
- The relay stores signed events to a JSONL file. Kayit only publishes gift wraps and encrypted backups, so the
  file holds no names, amounts or ceremony details in clear.
- Error messages shown to the user never include keys or tokens.

## Least privilege

- The ecash **lock key** is a separate derivation (NIP‑06 account 1) from the Nostr identity (account 0).
- The web app asks for no device permissions (camera, microphone and location are disabled by
  `Permissions-Policy` on the bundled server).
- The Docker image runs as the unprivileged `node` user.
