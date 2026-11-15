import { useMemo, useState } from 'preact/hooks';
import type { Engine } from '../core/engine';
import { balances, splits, totals, suggest, type Entry } from '../core/ledger';
import { strictVerify } from '../core/protocol';
import { parseXof, formatXof, formatSats } from '../core/money';
import { shortKey } from '../core/keys';
import { t, fmtDate } from '../app/i18n';
import { Btn, Card, Field, Money, Notice, Screen, StatusBadge, go, useEngine, errMsg } from './kit';
import { initials } from './welcome';

function balanceLabel(b: number): string {
  if (b > 0) return t('balance_owe', { amount: formatXof(b) });
  if (b < 0) return t('balance_owed', { amount: formatXof(-b) });
  return t('balance_zero');
}

function Line(props: { e: Entry; split?: { repaid: number; advance: number }; showWho?: boolean }) {
  const e = props.e;
  return (
    <li class={`line line-${e.direction}`} onClick={() => go(`entry/${encodeURIComponent(e.id)}`)}>
      <div class="line-date">{fmtDate(e.at, { day: 'numeric', month: 'short', year: '2-digit' })}</div>
      <div class="grow">
        <div>
          {props.showWho !== false && <strong>{e.counterpartName} · </strong>}
          <span class="muted">{e.ceremonyTitle}</span>
        </div>
        <div class="line-meta">
          <StatusBadge status={e.status} />
          {props.split && props.split.repaid > 0 && props.split.advance > 0 && (
            <span class="muted small">
              {formatXof(props.split.repaid)} {t('repaid')} + {formatXof(props.split.advance)} {t('advance')}
            </span>
          )}
        </div>
      </div>
      <Money xof={e.direction === 'in' ? e.xof : -e.xof} sign class={e.direction === 'in' ? 'in' : 'out'} />
    </li>
  );
}

export function Cahier(props: { engine: Engine }) {
  const st = useEngine(props.engine);
  const [tab, setTab] = useState<'people' | 'lines'>('people');
  const people = useMemo(() => balances(st.entries), [st.entries]);
  const sp = useMemo(() => splits(st.entries), [st.entries]);
  const tot = totals(st.entries);
  const lines = [...st.entries].sort((a, b) => b.at - a.at);
  return (
    <Screen title={t('cahier')} back="">
      <div class="grid2">
        <Card class="tile tile-owe">
          <div class="tile-label">{t('i_owe')}</div>
          <Money xof={tot.iOwe} class="tile-amount" />
        </Card>
        <Card class="tile tile-owed">
          <div class="tile-label">{t('owed_to_me')}</div>
          <Money xof={tot.owedToMe} class="tile-amount" />
        </Card>
      </div>
      <div class="seg">
        <button class={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>
          {t('by_person')}
        </button>
        <button class={tab === 'lines' ? 'on' : ''} onClick={() => setTab('lines')}>
          {t('all_lines')}
        </button>
      </div>
      {st.entries.length === 0 && <p class="muted">{t('empty_cahier')}</p>}
      {tab === 'people' ? (
        <ul class="people">
          {people.map((p) => (
            <li onClick={() => go(`person/${encodeURIComponent(p.key)}`)}>
              <span class="avatar">{initials(p.name)}</span>
              <div class="grow">
                <strong>{p.name}</strong>
                <div class="muted small">
                  {t('lines_n', { n: p.lines })} · {fmtDate(p.lastAt, { month: 'short', year: 'numeric' })}
                </div>
              </div>
              <span class={`pill ${p.balance > 0 ? 'owe' : p.balance < 0 ? 'owed' : ''}`}>{balanceLabel(p.balance)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul class="lines cahier-paper">
          {lines.map((e) => (
            <Line e={e} split={sp.get(e.id)} />
          ))}
        </ul>
      )}
      <Btn kind="ghost" onClick={() => go('paper')}>
        + {t('add_paper')}
      </Btn>
      <nav class="tabbar">
        <button onClick={() => go('')}>{t('home')}</button>
        <button class="active" onClick={() => go('cahier')}>
          {t('cahier')}
        </button>
        <button onClick={() => go('caisse')}>{t('caisse')}</button>
      </nav>
    </Screen>
  );
}

export function Person(props: { engine: Engine; k: string }) {
  const st = useEngine(props.engine);
  const lines = st.entries.filter((e) => e.counterpartKey === props.k).sort((a, b) => b.at - a.at);
  const sp = splits(st.entries);
  const p = balances(st.entries).find((b) => b.key === props.k);
  const name = p?.name ?? lines[0]?.counterpartName ?? '?';
  const s = suggest(st.entries, props.k, st.settings.multiplier);
  return (
    <Screen title={name} back="cahier">
      <Card class="center">
        <span class="avatar big">{initials(name)}</span>
        <h2 class={`pill big ${p && p.balance > 0 ? 'owe' : p && p.balance < 0 ? 'owed' : ''}`}>{balanceLabel(p?.balance ?? 0)}</h2>
        {s.owed > 0 && (
          <p class="muted">
            {t('custom_x', { m: String(st.settings.multiplier).replace('.', ','), amount: formatXof(s.suggested) })}
          </p>
        )}
        {!props.k.startsWith('name:') && <p class="muted small mono">npub · {shortKey(props.k)}</p>}
      </Card>
      <ul class="lines cahier-paper">
        {lines.map((e) => (
          <Line e={e} split={sp.get(e.id)} showWho={false} />
        ))}
      </ul>
    </Screen>
  );
}

export function EntryDetail(props: { engine: Engine; id: string }) {
  const st = useEngine(props.engine);
  const e = st.entries.find((x) => x.id === props.id);
  if (!e) return <Screen title="?" back="cahier" children={<Notice kind="error">404</Notice>} />;
  const sp = splits(st.entries).get(e.id);
  const giftOk = e.gift ? strictVerify(e.gift) : false;
  const receiptOk = e.receipt ? strictVerify(e.receipt) : false;
  const giverName = e.direction === 'in' ? e.counterpartName : st.settings.name;
  const hostName = e.direction === 'in' ? st.settings.name : e.counterpartName;
  return (
    <Screen title={e.direction === 'in' ? t('dir_in') : t('dir_out')} back="cahier">
      <Card class="center">
        <Money xof={e.xof} class="huge" />
        <p>
          <strong>{e.counterpartName}</strong> · {e.ceremonyTitle}
        </p>
        <p class="muted">{fmtDate(e.at, { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <StatusBadge status={e.status} />
        {e.message && <p class="quote">« {e.message} »</p>}
        {sp && sp.repaid > 0 && (
          <p class="muted">
            {formatXof(sp.repaid)} {t('repaid')} + {formatXof(sp.advance)} {t('advance')}
          </p>
        )}
      </Card>
      <h2 class="section-title">{t('proof')}</h2>
      {e.method === 'paper' ? (
        <Notice>{t('proof_paper')}</Notice>
      ) : (
        <ul class="proofs">
          <li>
            <span class={giftOk ? 'ok' : 'bad'}>{giftOk ? '✓' : '✕'}</span>
            <div>
              <div>{t('proof_gift', { name: giverName })}</div>
              <div class="muted small mono">
                {t('event_id')} {e.gift?.id.slice(0, 16)}… · {giftOk ? t('proof_ok') : t('proof_bad')}
              </div>
            </div>
          </li>
          <li>
            <span class={e.receipt ? (receiptOk ? 'ok' : 'bad') : 'wait'}>{e.receipt ? (receiptOk ? '✓' : '✕') : '…'}</span>
            <div>
              <div>{e.receipt ? t('proof_receipt', { name: hostName }) : t('proof_none')}</div>
              {e.receipt && (
                <div class="muted small mono">
                  {t('event_id')} {e.receipt.id.slice(0, 16)}… · {receiptOk ? t('proof_ok') : t('proof_bad')}
                </div>
              )}
            </div>
          </li>
          {e.method === 'ecash' && e.sats && (
            <li>
              <span class="ok">⚡</span>
              <div>
                <div>
                  {t('m_ecash')} · {formatSats(e.sats)}
                </div>
                <div class="muted small">Cashu NUT-11 · NUT-12</div>
              </div>
            </li>
          )}
        </ul>
      )}
      {e.status === 'paper' && (
        <Btn
          kind="danger"
          onClick={async () => {
            await props.engine.deleteEntry(e.id);
            go('cahier');
          }}
        >
          {t('delete_line')}
        </Btn>
      )}
    </Screen>
  );
}

export function PaperForm(props: { engine: Engine }) {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [err, setErr] = useState<string | null>(null);
  const known = balances(props.engine.state.entries);
  return (
    <Screen title={t('paper_title')} back="cahier">
      <form
        class="stack"
        onSubmit={async (ev) => {
          ev.preventDefault();
          const xof = parseXof(amount);
          if (!name.trim()) return setErr(t('who'));
          if (!xof) return setErr(t('amount'));
          const match = known.find((k) => k.name.toLowerCase() === name.trim().toLowerCase());
          try {
            await props.engine.addPaperEntry({
              direction,
              name: name.trim(),
              xof,
              ceremonyTitle: title.trim() || '—',
              date: Math.floor(new Date(`${day}T12:00:00`).getTime() / 1000),
              key: match && !match.key.startsWith('name:') ? match.key : undefined,
            });
            go('cahier');
          } catch (x) {
            setErr(errMsg(x));
          }
        }}
      >
        <div class="seg">
          <button type="button" class={direction === 'in' ? 'on' : ''} onClick={() => setDirection('in')}>
            {t('dir_in')}
          </button>
          <button type="button" class={direction === 'out' ? 'on' : ''} onClick={() => setDirection('out')}>
            {t('dir_out')}
          </button>
        </div>
        <Field label={t('who')}>
          <input value={name} list="known-people" onInput={(e) => setName(e.currentTarget.value)} maxLength={60} required />
          <datalist id="known-people">
            {known.map((k) => (
              <option value={k.name} />
            ))}
          </datalist>
        </Field>
        <Field label={t('amount')}>
          <input value={amount} inputMode="numeric" placeholder="5 000" onInput={(e) => setAmount(e.currentTarget.value)} required />
        </Field>
        <Field label={t('ceremony')}>
          <input value={title} placeholder={t('ceremony_title_ph')} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={80} />
        </Field>
        <Field label={t('when')} error={err}>
          <input type="date" value={day} onInput={(e) => setDay(e.currentTarget.value)} />
        </Field>
        <Btn type="submit">{t('save')}</Btn>
      </form>
    </Screen>
  );
}
