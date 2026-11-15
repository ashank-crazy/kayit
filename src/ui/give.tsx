import { useEffect, useState } from 'preact/hooks';
import type { Engine } from '../core/engine';
import type { Ceremony } from '../core/protocol';
import { parseInvitation } from '../core/protocol';
import { suggest, balanceWith } from '../core/ledger';
import { formatXof, parseXof, xofToSats, satsToXof, formatSats } from '../core/money';
import { normalizeMint } from '../core/wallet';
import { shortKey } from '../core/keys';
import { t, fmtDate } from '../app/i18n';
import { Btn, Card, Field, Money, Notice, Screen, errMsg, go, useEngine } from './kit';

/** Opened from a long WhatsApp / QR link: validate the signed ceremony, keep it, then show the give screen. */
export function InviteLanding(props: { engine: Engine; payload: string }) {
  const c = parseInvitation(props.payload);
  useEffect(() => {
    if (c && c.hostPk !== props.engine.id.pk) props.engine.addInvitation(c).catch(() => undefined);
  }, [props.payload]);
  if (!c) return <Screen title="Kayit" back="" children={<Notice kind="error">{t('invalid_invite')}</Notice>} />;
  return <CeremonyLanding engine={props.engine} c={c} />;
}

/** Opened from a short link (#/i/<code>): fetch the encrypted ceremony from relays, check it, show it. */
export function InviteCodeLanding(props: { engine: Engine; code: string }) {
  const [c, setC] = useState<Ceremony | null | undefined>(undefined);
  useEffect(() => {
    setC(undefined);
    props.engine
      .openInviteCode(props.code)
      .then(setC)
      .catch(() => setC(null));
  }, [props.code]);
  if (c === undefined) return <Screen title="Kayit" back="" children={<p class="muted center">{t('opening_invite')}</p>} />;
  if (c === null) return <Screen title="Kayit" back="" children={<Notice kind="error">{t('invite_not_found')}</Notice>} />;
  return <CeremonyLanding engine={props.engine} c={c} />;
}

function CeremonyLanding(props: { engine: Engine; c: Ceremony }) {
  const c = props.c;
  if (c.hostPk === props.engine.id.pk) {
    return (
      <Screen title={c.title} back="">
        <Notice>{t('own_invite')}</Notice>
        <Btn onClick={() => go(`ceremony/${c.id}`)}>{t('board')} →</Btn>
      </Screen>
    );
  }
  return <Give engine={props.engine} ceremony={c} />;
}

export function GiveByRef(props: { engine: Engine; ref_: string }) {
  const c = props.engine.findCeremony(props.ref_);
  if (!c) return <Screen title="?" back="" children={<Notice kind="error">{t('invalid_invite')}</Notice>} />;
  return <Give engine={props.engine} ceremony={c} />;
}

function Give(props: { engine: Engine; ceremony: Ceremony }) {
  const e = props.engine;
  const st = useEngine(e);
  const c = props.ceremony;
  const s = suggest(st.entries, c.hostPk, st.settings.multiplier, c.capXof);
  const [amount, setAmount] = useState(String(s.suggested));
  const [message, setMessage] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'ecash' | 'cash' | 'hand' | null>(null);
  const [done, setDone] = useState<'ecash' | 'cash' | null>(null);

  const xof = parseXof(amount);
  const sats = xof ? xofToSats(xof, st.rate) : 0;
  const have = e.balanceSats();
  const overCap = !!(xof && c.capXof && xof > c.capXof);
  const sameMint = normalizeMint(c.mint) === st.mint;
  const already = st.entries.filter((x) => x.ceremonyRef === c.ref && x.direction === 'out' && x.status !== 'rejected' && x.status !== 'reclaimed');

  if (done) {
    return (
      <Screen title={c.title} back="">
        <Card class="center done-card">
          <div class="done-mark" aria-hidden="true">
            ✓
          </div>
          <h2>{done === 'ecash' ? t('sent_title') : t('cash_sent_title')}</h2>
          <p>{done === 'ecash' ? t('sent_body', { host: c.hostName }) : t('cash_sent_body', { host: c.hostName })}</p>
        </Card>
        <Btn onClick={() => go('cahier')}>{t('cahier')} →</Btn>
      </Screen>
    );
  }

  const send = async (method: 'ecash' | 'cash' | 'hand') => {
    setErr(null);
    if (!xof) return setErr(t('amount'));
    if (overCap) return setErr(t('over_cap', { amount: formatXof(c.capXof!) }));
    setBusy(method);
    try {
      if (method === 'hand') {
        const g = await e.prepareEnvelope(c, xof, message);
        return go(`envelope/${g.id}`);
      }
      if (method === 'ecash') await e.giveEcash(c, xof, message);
      else await e.giveCash(c, xof, message);
      setDone(method);
    } catch (x) {
      const m = x instanceof Error ? x.message : '';
      setErr(m === 'insufficient' ? t('not_enough') : m === 'over-cap' ? t('over_cap', { amount: formatXof(c.capXof!) }) : m === 'other-mint' ? t('other_mint') : errMsg(x));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title={t('invited_by', { host: c.hostName })} back="">
      <Card class="invite-card">
        <div class="muted small">{fmtDate(c.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <h2>{c.title}</h2>
        <div class="muted">
          {c.hostName} <span class="small mono" title={c.hostPk}>· {shortKey(c.hostPk)}</span>
        </div>
        {c.capXof && <span class="badge">{t('cap_badge', { amount: formatXof(c.capXof) })}</span>}
      </Card>

      {already.length === 0 && <Card class="advice">
        <p>
          {s.owed > 0 ? t('you_owe_host', { amount: formatXof(s.owed), host: c.hostName }) : t('you_owe_nothing', { host: c.hostName })}
        </p>
        {s.owed > 0 && <p>{t('custom_x', { m: String(st.settings.multiplier).replace('.', ','), amount: formatXof(Math.round(s.owed * st.settings.multiplier)) })}</p>}
        {s.capped && <p class="muted">{t('capped_note', { amount: formatXof(c.capXof!) })}</p>}
        {xof && xof > s.owed && s.owed > 0 && <p class="muted small">{t('advance_note', { amount: formatXof(xof - s.owed), host: c.hostName })}</p>}
        <p class="muted small">{t('mult_hint')}</p>
      </Card>}

      {already.length > 0 && (
        <Notice kind="ok">
          ✓ {already.map((x) => formatXof(x.xof)).join(' + ')} · <button class="link" onClick={() => go('cahier')}>{t('cahier')}</button>
        </Notice>
      )}

      <div class="stack">
        <Field label={t('amount')} error={overCap ? t('over_cap', { amount: formatXof(c.capXof!) }) : null}>
          <div class="amount-input">
            <input value={amount} inputMode="numeric" onInput={(ev) => setAmount(ev.currentTarget.value)} aria-describedby="sats-hint" />
            <span class="suffix">F</span>
          </div>
          <span id="sats-hint" class="field-hint">
            {xof ? t('in_sats', { sats: formatSats(sats) }) : ''} · {t('caisse')}: <Money xof={satsToXof(have, st.rate)} />
          </span>
        </Field>
        <div class="chips">
          {[s.owed, s.suggested, 2000, 5000, 10000]
            .filter((v, i, a) => v > 0 && a.indexOf(v) === i && (!c.capXof || v <= c.capXof))
            .slice(0, 4)
            .map((v) => (
              <button class={`chip ${xof === v ? 'on' : ''}`} onClick={() => setAmount(String(v))}>
                {formatXof(v)}
              </button>
            ))}
        </div>
        <Field label={t('message')}>
          <input value={message} placeholder={t('message_ph')} maxLength={140} onInput={(ev) => setMessage(ev.currentTarget.value)} />
        </Field>
        {err && <Notice kind="error">{err}</Notice>}

        <Btn busy={busy === 'ecash'} disabled={!xof || overCap || !sameMint || busy !== null} onClick={() => send('ecash')}>
          {t('give_ecash')} {xof ? `· ${formatXof(xof)}` : ''}
        </Btn>
        <p class="muted small">{sameMint ? t('give_ecash_hint', { host: c.hostName }) : t('other_mint')}</p>
        {xof && sats > have && sameMint && (
          <Notice kind="warn">
            {t('not_enough')}{' '}
            <button class="link" onClick={() => go('caisse')}>
              {t('add_funds')} →
            </button>
          </Notice>
        )}
        <Btn kind="ghost" busy={busy === 'hand'} disabled={!xof || overCap || !sameMint || busy !== null} onClick={() => send('hand')}>
          {t('give_hand')}
        </Btn>
        <p class="muted small">{t('give_hand_hint', { host: c.hostName })}</p>
        <Btn kind="ghost" busy={busy === 'cash'} disabled={!xof || overCap || busy !== null} onClick={() => send('cash')}>
          {t('give_cash')}
        </Btn>
        <p class="muted small">{t('give_cash_hint', { host: c.hostName })}</p>
      </div>
      <p class="muted small center">
        {balanceWith(st.entries, c.hostPk) !== 0 && (
          <button class="link" onClick={() => go(`person/${encodeURIComponent(c.hostPk)}`)}>
            {c.hostName}: {t('cahier')} →
          </button>
        )}
      </p>
    </Screen>
  );
}
