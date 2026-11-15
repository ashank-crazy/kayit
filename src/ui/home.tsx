import { useState } from 'preact/hooks';
import type { Engine } from '../core/engine';
import { totals, suggest } from '../core/ledger';
import { satsToXof } from '../core/money';
import { t, fmtDate } from '../app/i18n';
import { Btn, Card, Money, Notice, Screen, Sats, go, useEngine } from './kit';
import { initials } from './welcome';

export function Home(props: { engine: Engine; onLock: () => void; demo?: { pin: string; role: 'host' | 'guest' } }) {
  const e = props.engine;
  const st = useEngine(e);
  const [link, setLink] = useState('');
  const tot = totals(st.entries);
  const sats = e.balanceSats();
  const today = Math.floor(Date.now() / 1000) - 86400;
  const invites = e.invitations().filter((c) => c.start >= today);
  const mine = e.ceremonies();
  const pendingCount = st.pending.length;

  return (
    <Screen>
      <header class="home-head">
        <span class="avatar big">{initials(st.settings.name)}</span>
        <div class="grow">
          <div class="muted small">Kayit</div>
          <h1 class="hello">{t('hello', { name: st.settings.name.split(' ')[0] })}</h1>
        </div>
        <button class="icon-btn" onClick={() => go('settings')} aria-label={t('settings')}>
          ⚙
        </button>
        <button class="icon-btn" onClick={props.onLock} aria-label={t('lock')}>
          🔒
        </button>
      </header>

      {pendingCount > 0 && (
        <Notice kind="warn">
          <button class="link" onClick={() => go(`ceremony/${mine[0]?.id ?? ''}`)}>
            {pendingCount} × {t('s_awaiting_my_ok')} →
          </button>
        </Notice>
      )}

      <div class="grid2">
        <Card class="tile tile-owe" onClick={() => go('cahier')}>
          <div class="tile-label">{t('i_owe')}</div>
          <Money xof={tot.iOwe} class="tile-amount" />
          <div class="muted small">{t('to_people', { n: tot.peopleIOwe })}</div>
        </Card>
        <Card class="tile tile-owed" onClick={() => go('cahier')}>
          <div class="tile-label">{t('owed_to_me')}</div>
          <Money xof={tot.owedToMe} class="tile-amount" />
          <div class="muted small">{t('from_people', { n: tot.peopleOweMe })}</div>
        </Card>
      </div>

      <Card class="caisse-card" onClick={() => go('caisse')}>
        <div class="row">
          <div class="grow">
            <div class="tile-label">{t('caisse')}</div>
            <Money xof={satsToXof(sats, st.rate)} class="tile-amount" />
            <Sats sats={sats} />
          </div>
          <span aria-hidden="true">›</span>
        </div>
      </Card>

      <h2 class="section-title">{t('upcoming')}</h2>
      {invites.length === 0 && <p class="muted">{t('no_upcoming')}</p>}
      <div class="stack">
        {invites.map((c) => {
          const s = suggest(st.entries, c.hostPk, st.settings.multiplier, c.capXof);
          const given = st.entries.some((x) => x.ceremonyRef === c.ref && x.direction === 'out' && x.status !== 'rejected');
          // an envelope prepared at home opens straight to its QR, ready to hand over at the door
          const prep = st.outbox.find((o) => o.state === 'prepared' && st.entries.some((x) => x.id === o.giftId && x.ceremonyRef === c.ref));
          return (
            <Card onClick={() => go(prep ? `envelope/${prep.giftId}` : `give/${encodeURIComponent(c.ref)}`)}>
              <div class="row">
                <div class="date-chip">
                  <strong>{fmtDate(c.start, { day: 'numeric' })}</strong>
                  <span>{fmtDate(c.start, { month: 'short' })}</span>
                </div>
                <div class="grow">
                  <strong>{c.title}</strong>
                  <div class="muted small">{c.hostName}</div>
                </div>
                <div class="right">
                  {prep ? (
                    <span class="badge badge-awaiting-receipt">✉ {t('e_prepared')}</span>
                  ) : given ? (
                    <span class="badge badge-cosigned">✓</span>
                  ) : (
                    <>
                      <div class="muted small">{s.owed > 0 ? t('to_bring') : t('suggested')}</div>
                      <Money xof={s.owed > 0 ? s.owed : s.suggested} />
                    </>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <h2 class="section-title">{t('my_ceremonies')}</h2>
      <div class="stack">
        {mine.map((c) => {
          const lines = st.entries.filter((x) => x.ceremonyRef === c.ref && x.direction === 'in' && x.status === 'cosigned');
          return (
            <Card onClick={() => go(`ceremony/${c.id}`)}>
              <div class="row">
                <div class="date-chip host">
                  <strong>{fmtDate(c.start, { day: 'numeric' })}</strong>
                  <span>{fmtDate(c.start, { month: 'short' })}</span>
                </div>
                <div class="grow">
                  <strong>{c.title}</strong>
                  <div class="muted small">{t('gifts_n', { n: lines.length })}</div>
                </div>
                <Money xof={lines.reduce((a, x) => a + x.xof, 0)} sutura={st.settings.sutura} />
              </div>
            </Card>
          );
        })}
        <Btn onClick={() => go('host')}>{t('host_new')}</Btn>
      </div>

      <form
        class="open-link"
        onSubmit={(ev) => {
          ev.preventDefault();
          const m = link.match(/#\/(invite|i)\/([A-Za-z0-9_-]+)/);
          if (m) go(`${m[1]}/${m[2]}`);
        }}
      >
        <label class="field">
          <span class="field-label">{t('open_link')}</span>
          <div class="row">
            <input class="grow" placeholder={t('paste_link')} value={link} onInput={(ev) => setLink(ev.currentTarget.value)} />
            <Btn kind="ghost" type="submit" disabled={!/#\/(invite|i)\//.test(link)}>
              {t('open')}
            </Btn>
          </div>
        </label>
      </form>

      {props.demo && (
        <Notice>
          <strong>Démo</strong> · {props.demo.role === 'host' ? 'Fatou' : 'Awa'} PIN {props.demo.role === 'host' ? '2222' : '1111'}{' '}
          <button class="link" onClick={() => open(location.href.split('#')[0] + '#/', '_blank')}>
            {t('open_other_tab')} ↗
          </button>
        </Notice>
      )}

      <nav class="tabbar">
        <button class="active" onClick={() => go('')}>
          {t('home')}
        </button>
        <button onClick={() => go('cahier')}>{t('cahier')}</button>
        <button onClick={() => go('caisse')}>{t('caisse')}</button>
      </nav>
    </Screen>
  );
}
