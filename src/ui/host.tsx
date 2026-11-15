import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Engine, Arrival } from '../core/engine';
import type { CeremonyType } from '../core/protocol';
import { invitationLink, parseGift } from '../core/protocol';
import { parseXof, formatXof } from '../core/money';
import { t, fmtDate, lang } from '../app/i18n';
import { Btn, Card, Field, Money, Notice, Qr, Screen, StatusBadge, Toast, copy, errMsg, go, useEngine, useToast } from './kit';

function defaultDate(): string {
  const d = new Date(Date.now() + 7 * 86400_000);
  return d.toISOString().slice(0, 10);
}

export function HostNew(props: { engine: Engine }) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<CeremonyType>('ngente');
  const [day, setDay] = useState(defaultDate());
  const [cap, setCap] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Screen title={t('host_new')} back="">
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          const capXof = cap.trim() ? parseXof(cap) : undefined;
          if (cap.trim() && !capXof) return setErr(t('pacte'));
          if (!title.trim()) return setErr(t('ceremony_title'));
          setBusy(true);
          try {
            const start = Math.floor(new Date(`${day}T10:00:00`).getTime() / 1000);
            const c = await props.engine.hostCeremony({ title: title.trim(), type, start, capXof: capXof ?? undefined });
            go(`ceremony/${c.id}/invite`);
          } catch (e2) {
            setErr(errMsg(e2));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('ceremony_title')}>
          <input value={title} placeholder={t('ceremony_title_ph')} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={80} required />
        </Field>
        <Field label={t('ceremony_type')}>
          <div class="seg">
            {(['ngente', 'mariage', 'deuil', 'autre'] as CeremonyType[]).map((k) => (
              <button type="button" class={type === k ? 'on' : ''} onClick={() => setType(k)}>
                {t(`t_${k}` as 't_ngente')}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('ceremony_date')}>
          <input type="date" value={day} onInput={(e) => setDay(e.currentTarget.value)} required />
        </Field>
        <Field label={t('pacte')} hint={t('pacte_hint')} error={err}>
          <input value={cap} inputMode="numeric" placeholder="10 000" onInput={(e) => setCap(e.currentTarget.value)} />
        </Field>
        <Btn type="submit" busy={busy}>
          {t('create_ceremony')}
        </Btn>
      </form>
    </Screen>
  );
}

export function InviteSheet(props: { engine: Engine; id: string }) {
  const c = props.engine.ceremonies().find((x) => x.id === props.id);
  const [toast, setToast] = useToast();
  if (!c) return <Screen title="?" back="" children={<Notice kind="error">404</Notice>} />;
  const link = invitationLink(location.href, c);
  const msg = t('invite_msg', { host: c.hostName, title: c.title, date: fmtDate(c.start, { weekday: 'long', day: 'numeric', month: 'long' }) });
  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: c.title, text: msg, url: link });
        return;
      } catch {
        /* fall back to WhatsApp */
      }
    }
    open(`https://wa.me/?text=${encodeURIComponent(`${msg}\n${link}`)}`, '_blank', 'noopener');
  };
  return (
    <Screen title={t('invite')} back={`ceremony/${c.id}`}>
      <Card class="center">
        <h2>{c.title}</h2>
        <p class="muted">{fmtDate(c.start, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <Qr text={link} label={t('invite_scan')} />
        <p class="muted small">{t('invite_scan')}</p>
        {c.capXof && <span class="badge">{t('cap_badge', { amount: formatXof(c.capXof) })}</span>}
      </Card>
      <div class="stack">
        <Btn onClick={share}>{t('invite_share')}</Btn>
        <Btn
          kind="ghost"
          onClick={async () => {
            setToast((await copy(link)) ? t('copied') : link);
          }}
        >
          {t('invite_copy')}
        </Btn>
        <Btn kind="quiet" onClick={() => go(`ceremony/${c.id}`)}>
          {t('board')} →
        </Btn>
      </div>
      <Toast msg={toast} />
    </Screen>
  );
}

function speak(text: string): void {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang() === 'fr' ? 'fr-FR' : 'en-GB';
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch {
    /* no voice on this device */
  }
}

function spokenAmount(xof: number): string {
  return new Intl.NumberFormat(lang() === 'fr' ? 'fr-FR' : 'en-GB').format(xof);
}

export function Board(props: { engine: Engine; id: string }) {
  const e = props.engine;
  const st = useEngine(e);
  const c = e.ceremonies().find((x) => x.id === props.id);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!c) return;
    return e.onArrival((a: Arrival) => {
      if (a.ceremonyRef !== c.ref) return;
      setFlash(a.giftId);
      if (e.state.settings.griot && a.status === 'cosigned') speak(t('griot_line', { name: a.name, amount: spokenAmount(a.xof) }));
      setTimeout(() => setFlash(null), 4000);
    });
  }, [e, c?.ref]);

  const lines = useMemo(() => (c ? e.entriesFor(c.ref).filter((x) => x.direction === 'in') : []), [st, c?.ref]);
  if (!c) return <Screen title="?" back="" children={<Notice kind="error">404</Notice>} />;
  const signed = lines.filter((x) => x.status === 'cosigned');
  const sum = signed.reduce((a, x) => a + x.xof, 0);
  const pending = st.pending.filter((p) => parseGift(p.gift)?.ceremonyRef === c.ref);

  return (
    <Screen
      title={t('board')}
      back=""
      actions={
        <button class="icon-btn" onClick={() => go(`ceremony/${c.id}/invite`)} aria-label={t('invite')}>
          ⧉
        </button>
      }
    >
      <section class="board-head">
        <div class="muted small">
          {fmtDate(c.start, { weekday: 'long', day: 'numeric', month: 'long' })}
          {c.capXof ? ` · ${t('cap_badge', { amount: formatXof(c.capXof) })}` : ''}
        </div>
        <h2>{c.title}</h2>
        <div class="board-total">
          <Money xof={sum} sutura={st.settings.sutura} class="huge" />
          <span class="muted">{t('gifts_n', { n: signed.length })}</span>
        </div>
        <div class="toggles">
          <label class="switch">
            <input type="checkbox" checked={st.settings.griot} onChange={(ev) => e.updateSettings({ griot: ev.currentTarget.checked })} />
            <span>{t('griot')}</span>
          </label>
          <label class="switch">
            <input type="checkbox" checked={st.settings.sutura} onChange={(ev) => e.updateSettings({ sutura: ev.currentTarget.checked })} />
            <span>{t('sutura')}</span>
          </label>
        </div>
      </section>

      {err && <Notice kind="error">{err}</Notice>}

      {pending.map((p) => {
        const g = parseGift(p.gift)!;
        return (
          <Card class={`pending ${flash === g.id ? 'flash' : ''}`}>
            {p.problem ? (
              <>
                <strong>{t('pending_problem')}</strong>
                <p class="muted small">
                  {g.giverName} · {formatXof(g.xof)} · {p.problem}
                </p>
                <Btn kind="quiet" onClick={() => e.dismissPending(g.id)}>
                  {t('dismiss')}
                </Btn>
              </>
            ) : (
              <>
                <p>
                  <strong>{g.giverName}</strong> {t('says_cash', { amount: formatXof(g.xof) })}
                </p>
                <div class="row gap">
                  <Btn
                    busy={busyId === g.id}
                    onClick={async () => {
                      setBusyId(g.id);
                      try {
                        await e.confirmCash(g.id);
                      } catch (x) {
                        setErr(errMsg(x));
                      } finally {
                        setBusyId(null);
                      }
                    }}
                  >
                    {t('confirm_cash')}
                  </Btn>
                  <Btn kind="ghost" onClick={() => e.rejectCash(g.id).catch((x) => setErr(errMsg(x)))}>
                    {t('reject_cash')}
                  </Btn>
                </div>
              </>
            )}
          </Card>
        );
      })}

      {lines.length === 0 && pending.length === 0 && <p class="muted center board-empty">{t('board_empty')}</p>}
      <ul class="board-list">
        {lines
          .filter((x) => x.status !== 'awaiting-my-ok')
          .map((x) => (
            <li class={flash === x.id ? 'flash' : ''} onClick={() => go(`entry/${encodeURIComponent(x.id)}`)}>
              <div class="grow">
                <strong>{x.counterpartName}</strong>
                {x.message && <div class="muted small">« {x.message} »</div>}
                <StatusBadge status={x.status} />
              </div>
              <div class="right">
                <Money xof={x.xof} sutura={st.settings.sutura} />
                <div class="muted small">{x.method === 'ecash' ? t('m_ecash') : t('m_cash')}</div>
              </div>
            </li>
          ))}
      </ul>
    </Screen>
  );
}
