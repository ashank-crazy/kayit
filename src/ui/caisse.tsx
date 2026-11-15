import { useEffect, useState } from 'preact/hooks';
import type { Engine } from '../core/engine';
import { parseXof, xofToSats, satsToXof, formatSats, formatXof } from '../core/money';
import { quotePayout, type TopUp } from '../core/wallet';
import { t, fmtDate } from '../app/i18n';
import { loadConfig } from '../app/config';
import { Btn, Card, Field, Money, Notice, Qr, Screen, Sats, Toast, copy, errMsg, go, useEngine, useToast } from './kit';

export function Caisse(props: { engine: Engine }) {
  const e = props.engine;
  const st = useEngine(e);
  const sats = e.balanceSats();
  const [mode, setMode] = useState<'idle' | 'topup' | 'invoice' | 'withdraw'>('idle');
  const [amount, setAmount] = useState('10 000');
  const [topup, setTopup] = useState<TopUp | null>(null);
  const [inv, setInv] = useState('');
  const [quote, setQuote] = useState<{ sats: number; fee: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testMint, setTestMint] = useState(false);
  const [toast, setToast] = useToast();

  useEffect(() => {
    loadConfig().then((c) => setTestMint(c.testMint && c.mint === st.mint));
  }, [st.mint]);

  // while an invoice is on screen, check it every 2 s
  useEffect(() => {
    if (mode !== 'invoice' || !topup) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const added = await e.checkTopUps();
        if (added) {
          setToast(`${t('paid')} +${formatSats(added)}`);
          setMode('idle');
          setTopup(null);
          return;
        }
      } catch {
        /* keep polling */
      }
      setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [mode, topup?.quote]);

  const rate1000 = xofToSats(1000, st.rate);
  const now = Math.floor(Date.now() / 1000);

  return (
    <Screen title={t('caisse')} back="">
      <Card class="center caisse-card">
        <div class="tile-label">{t('balance')}</div>
        <Money xof={satsToXof(sats, st.rate)} class="huge" />
        <Sats sats={sats} />
        <p class="muted small">{t('rate_line', { xof: formatXof(1000), sats: formatSats(rate1000), source: st.rate.source })}</p>
      </Card>

      {err && <Notice kind="error">{err}</Notice>}

      {mode === 'idle' && (
        <div class="stack">
          <Btn onClick={() => setMode('topup')}>{t('topup')}</Btn>
          <Btn kind="ghost" onClick={() => setMode('withdraw')}>
            {t('withdraw')}
          </Btn>
        </div>
      )}

      {mode === 'topup' && (
        <form
          class="stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setErr(null);
            const xof = parseXof(amount);
            if (!xof) return setErr(t('amount'));
            setBusy(true);
            try {
              setTopup(await e.topUp(xofToSats(xof, st.rate)));
              setMode('invoice');
            } catch (x) {
              setErr(errMsg(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t('topup_amount')}>
            <input value={amount} inputMode="numeric" onInput={(ev) => setAmount(ev.currentTarget.value)} />
          </Field>
          <div class="row gap">
            <Btn type="submit" busy={busy}>
              {t('next')}
            </Btn>
            <Btn kind="quiet" type="button" onClick={() => setMode('idle')}>
              {t('cancel')}
            </Btn>
          </div>
        </form>
      )}

      {mode === 'invoice' && topup && (
        <Card class="center">
          <h2>{t('invoice_title')}</h2>
          <p class="muted">
            {formatSats(topup.sats)} ≈ {formatXof(satsToXof(topup.sats, st.rate))}
          </p>
          <a href={`lightning:${topup.invoice}`} class="qr-link">
            <Qr text={topup.invoice.toUpperCase()} label={t('invoice_title')} />
          </a>
          <p class="muted small">{testMint ? t('test_mint_hint') : t('invoice_hint')}</p>
          <p class="waiting">{t('waiting_payment')}</p>
          <div class="row gap center">
            <Btn kind="ghost" onClick={async () => setToast((await copy(topup.invoice)) ? t('copied') : topup.invoice.slice(0, 24))}>
              {t('copy_invoice')}
            </Btn>
            <Btn kind="quiet" onClick={() => setMode('idle')}>
              {t('cancel')}
            </Btn>
          </div>
        </Card>
      )}

      {mode === 'withdraw' && (
        <form
          class="stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setErr(null);
            setBusy(true);
            try {
              if (!quote) {
                setQuote(await quotePayout(st.mint, inv));
              } else {
                const r = await e.payOut(inv);
                setToast(r.paid ? t('payout_ok') : t('waiting_payment'));
                setMode('idle');
                setInv('');
                setQuote(null);
              }
            } catch (x) {
              setErr(errMsg(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t('withdraw')}>
            <textarea rows={3} value={inv} placeholder={t('withdraw_ph')} onInput={(ev) => { setInv(ev.currentTarget.value); setQuote(null); }} autocapitalize="none" spellcheck={false} />
          </Field>
          {quote && <Notice>{t('withdraw_quote', { sats: formatSats(quote.sats), fee: formatSats(quote.fee) })}</Notice>}
          <div class="row gap">
            <Btn type="submit" busy={busy} disabled={!/^(lightning:)?ln/i.test(inv.trim())}>
              {quote ? t('pay') : t('next')}
            </Btn>
            <Btn kind="quiet" type="button" onClick={() => { setMode('idle'); setQuote(null); }}>
              {t('cancel')}
            </Btn>
          </div>
        </form>
      )}

      {st.outbox.length > 0 && (
        <>
          <h2 class="section-title">{t('envelopes')}</h2>
          <ul class="lines">
            {[...st.outbox].reverse().map((o) => (
              <li class="line">
                <div class="grow">
                  <strong>{o.hostName}</strong> · <span class="muted">{o.ceremonyTitle}</span>
                  <div class="muted small">
                    {o.state === 'prepared' ? (
                      <button class="link" onClick={() => go(`envelope/${o.giftId}`)}>
                        {t('e_prepared')} →
                      </button>
                    ) : o.state === 'sent' || o.state === 'handed' ? (
                      now < o.locktime ? (
                        `${t(o.state === 'sent' ? 'e_sent' : 'e_handed')} · ${t('reclaim_after', { date: fmtDate(o.locktime) })}`
                      ) : (
                        t(o.state === 'sent' ? 'e_sent' : 'e_handed')
                      )
                    ) : o.state === 'opened' ? (
                      t('e_opened')
                    ) : (
                      t('e_reclaimed')
                    )}
                  </div>
                </div>
                <div class="right">
                  <Money xof={o.xof} />
                  {(o.state === 'sent' || o.state === 'prepared' || o.state === 'handed') && now >= o.locktime && (
                    <Btn kind="quiet" onClick={() => e.reclaim(o.giftId).then((n) => setToast(`+${formatSats(n)}`)).catch((x) => setErr(errMsg(x)))}>
                      {t('reclaim')}
                    </Btn>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p class="muted small center mono">{t('mint_line', { mint: st.mint.replace(/^https?:\/\//, '') })}</p>
      <Toast msg={toast} />
      <nav class="tabbar">
        <button onClick={() => go('')}>{t('home')}</button>
        <button onClick={() => go('cahier')}>{t('cahier')}</button>
        <button class="active" onClick={() => go('caisse')}>
          {t('caisse')}
        </button>
      </nav>
    </Screen>
  );
}
