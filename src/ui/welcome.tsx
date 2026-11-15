import { useState } from 'preact/hooks';
import { listProfiles, unlockProfile, createProfile, renameProfile, type OpenSession, type ProfileMeta } from '../app/session';
import { createDemo, fundFromTestMint, DEMO_PINS } from '../app/demo';
import { isValidMnemonic, newMnemonic, normalizeMnemonic } from '../core/keys';
import { isValidPin } from '../core/vault';
import { t, lang, setLang } from '../app/i18n';
import { Btn, Card, Field, Notice, PinPad, Screen, errMsg } from './kit';

type Step =
  | { s: 'home' }
  | { s: 'unlock'; p: ProfileMeta }
  | { s: 'create' }
  | { s: 'words'; name: string; pin: string; words: string }
  | { s: 'restore' };

// Wrong PINs survive reloads and new tabs: 5 free tries, then 30 s, doubling with each further miss (max 1 h).
const FAILS = 'kayit:pin-fails';

function readFails(): { n: number; at: number } {
  try {
    const f = JSON.parse(localStorage.getItem(FAILS) ?? '{"n":0,"at":0}') as { n: number; at: number };
    return Number.isFinite(f.n) && Number.isFinite(f.at) ? f : { n: 0, at: 0 };
  } catch {
    return { n: 0, at: 0 };
  }
}

function lockedFor(): number {
  const f = readFails();
  if (f.n < 5) return 0;
  const ms = Math.min(30_000 * 2 ** (f.n - 5), 3_600_000);
  return Math.max(0, Math.ceil((f.at + ms - Date.now()) / 1000));
}

function noteFail(ok: boolean): void {
  try {
    if (ok) return localStorage.removeItem(FAILS);
    localStorage.setItem(FAILS, JSON.stringify({ n: readFails().n + 1, at: Date.now() }));
  } catch {
    /* storage blocked: the PBKDF2 cost still applies */
  }
}

export function Welcome(props: { onOpen: (s: OpenSession) => void; inviteWaiting: boolean }) {
  const [step, setStep] = useState<Step>({ s: 'home' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [, setLangTick] = useState(0);
  const profiles = listProfiles();

  const back = () => {
    setErr(null);
    setStep({ s: 'home' });
  };

  if (step.s === 'unlock') {
    const wait = lockedFor();
    return (
      <Screen title={step.p.name} back={back}>
        {step.p.demo && <Notice>Démo · PIN {step.p.demo.pin}</Notice>}
        <PinPad
          label={t('pin_for', { name: step.p.name })}
          error={wait ? t('wait_seconds', { s: wait }) : err}
          busy={busy}
          onDone={async (pin) => {
            if (lockedFor()) return setErr(t('wait_seconds', { s: lockedFor() }));
            setBusy(true);
            setErr(null);
            try {
              const s = await unlockProfile(step.p.id, pin);
              noteFail(true);
              props.onOpen(s);
            } catch (x) {
              if (x instanceof Error && x.message === 'open-elsewhere') {
                setErr(t('open_elsewhere'));
              } else {
                noteFail(false);
                setErr(t('wrong_pin'));
              }
            } finally {
              setBusy(false);
            }
          }}
        />
      </Screen>
    );
  }

  if (step.s === 'create') return <CreateForm onBack={back} onNext={(name, pin) => setStep({ s: 'words', name, pin, words: newMnemonic() })} />;

  if (step.s === 'words') {
    return (
      <Screen title={t('words_title')} back={() => setStep({ s: 'create' })}>
        <Notice kind="warn">{t('words_body')}</Notice>
        <ol class="words">
          {step.words.split(' ').map((w) => (
            <li>{w}</li>
          ))}
        </ol>
        {err && <Notice kind="error">{err}</Notice>}
        <Btn
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              props.onOpen(await createProfile(step.name, step.pin, step.words));
            } catch (e) {
              setErr(errMsg(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('words_ok')}
        </Btn>
      </Screen>
    );
  }

  if (step.s === 'restore') return <RestoreForm onBack={back} onOpen={props.onOpen} />;

  return (
    <Screen>
      <div class="lang-switch">
        {(['fr', 'en'] as const).map((l) => (
          <button
            class={lang() === l ? 'on' : ''}
            onClick={() => {
              setLang(l);
              setLangTick((x) => x + 1);
            }}
          >
            {l === 'fr' ? 'Français' : 'English'}
          </button>
        ))}
      </div>
      <div class="hero">
        <div class="logo" aria-hidden="true">
          <span>K</span>
        </div>
        <h1 class="brand">Kayit</h1>
        <p class="tagline">{t('tagline')}</p>
      </div>
      {props.inviteWaiting && <Notice kind="info">{t('need_profile')}</Notice>}
      {profiles.length > 0 && (
        <section>
          <h2 class="section-title">{t('profiles_here')}</h2>
          <div class="stack">
            {profiles.map((p) => (
              <Card onClick={() => setStep({ s: 'unlock', p })}>
                <div class="row">
                  <span class="avatar">{initials(p.name)}</span>
                  <span class="grow">
                    <strong>{p.name}</strong>
                    {p.demo && <span class="muted small"> · démo PIN {p.demo.pin}</span>}
                  </span>
                  <span aria-hidden="true">›</span>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
      <div class="stack gap-top">
        <Btn onClick={() => setStep({ s: 'create' })}>{t('create')}</Btn>
        <Btn kind="ghost" onClick={() => setStep({ s: 'restore' })}>
          {t('restore')}
        </Btn>
        {!profiles.some((p) => p.demo) && (
          <>
            <Btn
              kind="quiet"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const { awa, fatou } = await createDemo();
                  // fill Fatou's caisse before anyone opens her notebook (the test mint pays itself)
                  setProgress(t('demo_funding', { s: '' }));
                  await fundFromTestMint(fatou.engine, 60_000, (n) => setProgress(t('demo_funding', { s: `${n} s` }))).catch(() => 0);
                  setProgress(null);
                  props.onOpen(awa);
                } catch (e) {
                  setErr(errMsg(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('demo')}
            </Btn>
            <p class="muted small center">
              {t('demo_hint')} Awa {DEMO_PINS.awa} · Fatou {DEMO_PINS.fatou}
            </p>
          </>
        )}
        {progress && <Notice>{progress}</Notice>}
        {err && <Notice kind="error">{err}</Notice>}
      </div>
    </Screen>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function CreateForm(props: { onBack: () => void; onNext: (name: string, pin: string) => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Screen title={t('create')} back={props.onBack}>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setErr(t('your_name'));
          if (!isValidPin(pin)) return setErr(t('choose_pin'));
          if (pin !== pin2) return setErr(t('pins_differ'));
          props.onNext(name.trim(), pin);
        }}
      >
        <Field label={t('your_name')}>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} autocomplete="name" maxLength={60} required />
        </Field>
        <Field label={t('choose_pin')}>
          <input value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} inputMode="numeric" type="password" maxLength={8} autocomplete="new-password" />
        </Field>
        <Field label={t('repeat_pin')} error={err}>
          <input value={pin2} onInput={(e) => setPin2(e.currentTarget.value.replace(/\D/g, ''))} inputMode="numeric" type="password" maxLength={8} autocomplete="new-password" />
        </Field>
        <Btn type="submit">{t('next')}</Btn>
      </form>
    </Screen>
  );
}

function RestoreForm(props: { onBack: () => void; onOpen: (s: OpenSession) => void }) {
  const [words, setWords] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Screen title={t('restore_title')} back={props.onBack}>
      <form
        class="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          if (!isValidMnemonic(words)) return setErr(t('restore_bad'));
          if (!isValidPin(pin)) return setErr(t('choose_pin'));
          setBusy(true);
          setInfo(t('restoring'));
          try {
            const s = await createProfile(name.trim() || '…', pin, normalizeMnemonic(words));
            const r = await s.engine.restoreFromRelays();
            if (!name.trim() && s.engine.state.settings.name) {
              renameProfile(s.meta.id, s.engine.state.settings.name);
              s.meta.name = s.engine.state.settings.name;
            }
            setInfo(r.fromBackup || r.messages ? t('restored', { n: s.engine.state.entries.length }) : t('restored_none'));
            props.onOpen(s);
          } catch (e2) {
            setErr(errMsg(e2));
            setInfo(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t('restore_body')}>
          <textarea rows={3} value={words} onInput={(e) => setWords(e.currentTarget.value)} autocapitalize="none" autocorrect="off" spellcheck={false} />
        </Field>
        <Field label={t('your_name')}>
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} maxLength={60} />
        </Field>
        <Field label={t('choose_pin')} error={err}>
          <input value={pin} onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, ''))} inputMode="numeric" type="password" maxLength={8} />
        </Field>
        {info && <Notice>{info}</Notice>}
        <Btn type="submit" busy={busy}>
          {t('restore_title')}
        </Btn>
      </form>
    </Screen>
  );
}
