# Devpost submission — Kayit

Copy each block into the matching Devpost field.

**Deadline:** 21 Nov 2026, 01:30 IST (20 Nov 2026, 20:00 UTC / 20:00 Dakar).

---

## Project name

Kayit

## Tagline (≤ 200 chars)

The ndawtal notebook that can't be lost, forged or forgotten: ceremony gifts as Bitcoin ecash envelopes, co‑signed by giver and host.

## Links

- Code: https://github.com/ashank-crazy/kayit (public)
- Live MVP: https://ashank-crazy.github.io/kayit/ — tap **Essayer la démo**, PINs 1111 (Awa, host) and 2222 (Fatou, guest)
- Video (2:35): https://youtu.be/6YKSals4J0w

## Built with

bitcoin, lightning, cashu, ecash, nostr, typescript, preact, vite, node.js, websockets, pwa, webcrypto, qr-code, docker

---

## Inspiration

At every ngénte (naming day), wedding or funeral in Senegal, guests bring a **ndawtal**: an envelope of money
that someone writes down in a school exercise book. That book is a ledger of debts. Custom says you return a
ndawtal at the giver's own ceremony, usually doubled: half repays, half is a new advance.

The book is lost, burned, or stays with one sister. Amounts get disputed. People forget who they owe, and
returning too little is shaming. Relatives abroad can't hand over an envelope. And the griot calling out each
gift puts pressure on guests to give more than they can.

We wanted to keep the custom exactly as it is and give it a notebook that survives.

## What it does

Kayit is a phone notebook with a built‑in Bitcoin wallet.

- **The host** creates the ceremony (with an optional *pacte* cap, e.g. "no gift above 10 000 F") and shares an
  **invitation card** on WhatsApp: one image with the title, date and a small QR that still scans from a heavily
  compressed photo.
- **The guest** opens it. Kayit reads their notebook and suggests the custom amount:
  *"You owe Awa 5 000 F. Return 10 000 F = 5 000 F repaid + 5 000 F new advance."*
  They give by **ecash envelope** (sats locked so only the host can open them) or declare a **cash** gift the
  host confirms.
- **No network at the ceremony? No problem.** The guest prepares the envelope at home. In the courtyard, the
  host's phone scans it from the guest's screen as a short QR animation, checks it with no network (locked to her
  key, valid mint signatures, right amount), signs the receipt on the spot and cashes the sats later.
- **The host's board** lights up live. A *griot* mode reads names aloud; a *sutura* (discretion) mode hides amounts.
- **The cahier** shows who owes whom, person by person, with every return split into repayment and advance.
- **Every line is co‑signed**: the giver signs the gift, the host signs the receipt. Nobody can inflate, deny or
  invent a line later. The proof screen checks the signatures live.
- **Ma caisse** is a real wallet: top up over Lightning, withdraw to any Lightning wallet, reclaim an envelope the
  host never opened.
- **12 words restore everything** on a new phone, from Nostr relays, encrypted.

French first, English available, amounts in francs CFA with sats second.

**Who it's for.** The host — usually the mother, or the aunt who keeps the cahier — on a mid‑range Android with
WhatsApp and patchy data. Senegal has about 540 000 births a year, so about as many naming ceremonies (World Bank
crude birth rate 29.4 ‰). If 30–80 guests each bring a ndawtal (our assumption, the first thing a pilot
measures), that is 16–44 million gift lines a year before weddings and funerals. 11.3 million Senegalese are online
(DataReportal 2025), and WhatsApp is their most‑used platform.

## How we built it

- **Wallet:** Cashu ecash with `cashu-ts`. Envelopes are P2PK‑locked (NUT‑11) to the host's key, with the giver
  as refund key 30 days after the ceremony, and checked with DLEQ proofs (NUT‑12). Top‑up and withdrawal go over
  Lightning (mint and melt quotes).
- **Proof and transport:** Nostr. Three event kinds — a signed ceremony (NIP‑52 calendar kind 31923), a gift signed
  by the giver (9330) and a receipt signed by the host (9331). They travel inside NIP‑59 gift wraps, so relays see
  neither names nor amounts.
- **Compact invitations:** the short link carries a 16‑byte secret and 8 bytes of the host's key. The signed
  ceremony waits on relays, NIP‑44 encrypted with a key derived from the secret; the guest checks the host key
  prefix, so a forged carrier needs a 2⁶⁴ search. The QR shrinks from 121 × 121 to 37 × 37 modules.
- **Hand‑over with no network:** the envelope (signed gift + Cashu token as raw CBOR) is deflated and cut into
  300‑byte QR frames that loop on screen; the host's camera collects them in any order. Her phone checks the gift
  signature, token hash, a 1‑of‑1 P2PK lock with ≥ 2 days left and the DLEQ proofs against mint keys it cached
  while online, then shows a signed receipt back the same way.
- **Keys:** one NIP‑06 seed. Account 0 is the Nostr identity, account 1 the ecash lock key.
- **At rest:** PIN → PBKDF2‑SHA256 (310k) → AES‑256‑GCM over the seed and the whole state.
- **App:** Preact + Vite PWA, 171 KiB first load. Lighthouse mobile (slow 4G, 4× CPU): Performance 98, Accessibility 100, Best Practices 100; first paint 1.8 s.
- **Server:** one Node process that serves the app, runs a small Nostr relay at `/relay`, and tells the app
  which mint to use. `docker compose up` adds a local Cashu mint (nutshell, FakeWallet).
- **Backups:** the notebook is compressed and split into encrypted parts in two alternating slots, so it outgrows
  NIP‑44's 64 KB limit safely and a save cut off half‑way never damages the last good backup.
- **Tests:** unit tests for money, keys, vault, ledger, tamper checks, forged invite carriers, QR frames decoded
  by a real QR reader and a decompression bomb, plus a live end‑to‑end test that runs a real Lightning top‑up,
  envelope, receipt, cash gift, an in‑person hand‑over with every mint request blocked, and a 12‑word restore,
  against a relay and a Cashu mint.

## Challenges we ran into

- **A tampered event passed verification.** nostr‑tools caches a "verified" flag on the event object, and a
  spread copy carries it over, so an edited amount still looked valid. We now verify a clean copy everywhere and
  have a test that edits amounts and signatures.
- **Getting the maths of reciprocity right.** A return is not one number: it is part repayment and part new
  debt, and the split has to follow the running balance across years of lines.
- **Unreliable relays.** One popular relay was unreachable from our network and stalled every send. Sends now
  complete on the first relay that accepts.
- **An ecash envelope is too big for one QR.** Every proof carries its lock, signature and DLEQ proof: 4–6 KB of
  text. Raw CBOR plus deflate brings it to ~2–3 KB, and a looping animation of 300‑byte frames makes it readable by
  a mid‑range camera.
- **Backups outgrew Nostr.** After about 30 signed gifts the encrypted notebook passed NIP‑44's 64 KB limit. It is
  now compressed and split into parts.
- **Making a Bitcoin wallet feel like an envelope**, in French, in francs, for someone who has never heard of
  sats.

## Accomplishments that we're proud of

- A real, verifiable gift flow end to end: Lightning in, locked ecash envelope, signed gift, signed receipt,
  co‑signed line on both phones, restore from 12 words.
- Features that come from the custom, not from crypto: the 5 000 + 5 000 split, the *pacte* cap, *sutura* mode,
  the griot voice, cash gifts that still get a receipt.
- An envelope that changes hands in a courtyard with no signal, and still ends up as a line signed by both.
- Relays and servers never see who gave what.

## What we learned

Cashu's spending conditions (P2PK with refund keys) map almost perfectly onto a physical envelope: it is
addressed to one person, and it comes back if nobody opens it. Nostr gives us signatures and delivery for free.
The hard part was never the cryptography; it was the words on the screen.

## What's next for Kayit

1. A Wolof interface and a Wolof griot voice.
2. Printed envelopes for guests without a smartphone (safe on paper: only the host's key opens them).
3. Seed‑based ecash recovery (NUT‑13 / NIP‑60).
4. A CFA on/off ramp with a local Lightning exchange and mobile money.
5. A shared family notebook for co‑hosts.
6. A pilot with one neighbourhood association, measuring co‑signed gifts, disputes and restores.

---

## 3‑minute video script

Screen recording on a phone‑sized window, French UI, voice‑over in English (or French). Target 2:50.

| Time | Screen | Voice‑over |
|---|---|---|
| 0:00–0:25 | Photo or drawing of an exercise book; then the Kayit welcome screen | "At every naming day in Senegal, guests bring a ndawtal — an envelope of money — and someone writes it in a school notebook. That notebook is a ledger of debts: you return the gift at their ceremony, doubled. And it gets lost, disputed, forgotten." |
| 0:25–0:40 | Tap *Essayer la démo* | "Kayit is that notebook, on the phone, with a Bitcoin wallet inside. The demo creates two people: Awa, who is hosting her baby's ngénte, and Fatou, a guest." |
| 0:40–1:00 | Awa: invitation card, share sheet | "Awa creates the ceremony and agrees a cap with her family: no gift above 10 000 francs. She posts one invitation card on WhatsApp; its QR is small enough to scan even from a compressed photo." |
| 1:00–1:30 | Fatou: opens the invitation, advice card, amount chips | "Fatou opens it. Kayit reads her notebook: she owes Awa 5 000 from her own wedding. Custom says return it doubled, so it suggests 10 000 — 5 000 repaid, 5 000 as a new advance. She sends it as an envelope." |
| 1:30–1:45 | Awa's board: the arrival appears, griot voice speaks | "On Awa's phone the gift arrives live. The envelope is Bitcoin ecash locked to Awa's key — nobody else can open it, and if Awa never does, it goes back to Fatou." |
| 1:45–2:15 | Fatou: *Préparer pour remettre en main propre* → looping QR; Awa: *Scanner une enveloppe* → receipt QR; Fatou scans it | "In a courtyard there's often no signal. So Fatou can prepare the envelope at home. At the ceremony Awa's phone reads it from Fatou's screen, checks it with no network, and shows a signed receipt back. The sats are cashed when the network returns." |
| 2:15–2:35 | Cahier on both phones, then the proof screen | "Both notebooks now show *signé par les deux*. Fatou signed the gift, Awa signed the receipt. Nobody can change the amount later. Lose your phone? Twelve words bring it all back." |
| 2:35–2:55 | README architecture diagram, then logo | "A real Lightning wallet, one Docker command, 171 kilobytes on a mid‑range phone. Next: Wolof, a CFA on‑ramp and a pilot with a neighbourhood association. Kayit: the notebook that can't be lost, forged or forgotten." |

## Gallery images (in order)

1. `docs/screens/01-welcome.jpg` — Welcome
2. `docs/screens/02-home.jpg` — Home: what I owe, what I'm owed, upcoming ceremonies
3. `docs/screens/03-give.jpg` — Give: suggested return with repayment / advance split
4. `docs/screens/04-board.jpg` — Host board with live arrivals
5. `docs/screens/05-invite.jpg` — Invitation card with a small QR, ready for WhatsApp
6. `docs/screens/06-cahier.jpg` — The cahier: the balance with each person
7. `docs/screens/07-proof.jpg` — Proof: gift and receipt signatures
8. `docs/screens/08-caisse.jpg` — Ma caisse: the Lightning / ecash wallet
9. `docs/screens/09-handover.jpg` — Hand‑over with no network: the envelope as a looping QR
10. `docs/screens/10-receipt.jpg` — The host's phone checked it offline and shows the receipt back
