import { useState } from 'preact/hooks';
import { npubEncode } from 'nostr-tools/nip19';
import type { Engine } from '../core/engine';
import { changePin, forgetProfile, renameProfile, type OpenSession } from '../app/session';
import { isValidPin, openVault } from '../core/vault';
import { t, setLang, fmtDate, type Lang } from '../app/i18n';
import { Btn, Card, Field, Notice, PinPad, Screen, Toast, errMsg, useEngine, useToast } from './kit';

export function Settings(props: { session: OpenSession; onLock: () => void }) {
  const e: Engine = props.session.engine;
  const st = useEngine(e);
  const [name, setName] = useState(st.settings.name);
  const [showWords, setShowWords] = useState<'no' | 'pin' | 'yes'>('no');
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const npub = npubEncode(e.id.pk);

  return (
    <Screen title={t('settings')} back="">
      <Card>
        <Field label={t('name_label')}>
          <div class="row gap">
            <input class="grow" value={name} maxLength={60} onInput={(ev) => setName(ev.currentTarget.value)} />
            <Btn
              kind="ghost"
              disabled={!name.trim() || name === st.settings.name}
              onClick={async () => {
                await e.updateSettings({ name: name.trim() });
                renameProfile(props.session.meta.id, name.trim());
                setToast('✓');
              }}
            >
              {t('save')}
            </Btn>
          </div>
        </Field>
        <Field label={t('lang')}>
          <div class="seg">
            {(['fr', 'en'] as Lang[]).map((l) => (
              <button
                class={st.settings.lang === l ? 'on' : ''}
                onClick={async () => {
                  setLang(l);
                  await e.updateSettings({ lang: l });
                }}
              >
                {l === 'fr' ? 'Français' : 'English'}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t('multiplier')} hint={t('mult_hint')}>
          <div class="seg vertical">
            {[
              [1, t('mult_1')],
              [1.5, t('mult_15')],
              [2, t('mult_2')],
            ].map(([m, label]) => (
              <button class={st.settings.multiplier === m ? 'on' : ''} onClick={() => e.updateSettings({ multiplier: m as number })}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        <label class="switch">
          <input type="checkbox" checked={st.settings.griot} onChange={(ev) => e.updateSettings({ griot: ev.currentTarget.checked })} />
          <span>{t('griot')}</span>
        </label>
        <label class="switch">
          <input type="checkbox" checked={st.settings.sutura} onChange={(ev) => e.updateSettings({ sutura: ev.currentTarget.checked })} />
          <span>{t('sutura')}</span>
        </label>
      </Card>

      <Card>
        <h2 class="section-title">{t('backup')}</h2>
        <p class="muted small">{st.lastSync ? t('backup_last', { when: fmtDate(st.lastSync, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : t('backup_never')}</p>
        <Btn
          kind="ghost"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setToast(t('backup_ok', { n: await e.backupNow() }));
            } catch (x) {
              setToast(errMsg(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('backup_now')}
        </Btn>
        {showWords === 'no' && (
          <Btn kind="quiet" onClick={() => setShowWords('pin')}>
            {t('show_words')}
          </Btn>
        )}
        {showWords === 'pin' && (
          <PinPad
            label={t('enter_pin')}
            error={pinErr}
            onDone={async (pin) => {
              try {
                const vault = JSON.parse(localStorage.getItem(`kayit:vault:${props.session.meta.id}`) ?? 'null');
                await openVault(pin, vault);
                setPinErr(null);
                setShowWords('yes');
              } catch {
                setPinErr(t('wrong_pin'));
              }
            }}
          />
        )}
        {showWords === 'yes' && (
          <>
            <Notice kind="warn">{t('words_body')}</Notice>
            <ol class="words">
              {props.session.mnemonic.split(' ').map((w) => (
                <li>{w}</li>
              ))}
            </ol>
            <Btn kind="quiet" onClick={() => setShowWords('no')}>
              {t('done')}
            </Btn>
          </>
        )}
      </Card>

      <Card>
        <h2 class="section-title">{t('change_pin')}</h2>
        <form
          class="stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (!isValidPin(newPin)) return setToast(t('choose_pin'));
            try {
              await changePin(props.session.meta.id, oldPin, newPin);
              setOldPin('');
              setNewPin('');
              setToast(t('pin_changed'));
            } catch {
              setToast(t('wrong_pin'));
            }
          }}
        >
          <Field label={t('old_pin')}>
            <input type="password" inputMode="numeric" value={oldPin} maxLength={8} onInput={(ev) => setOldPin(ev.currentTarget.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={t('new_pin')}>
            <input type="password" inputMode="numeric" value={newPin} maxLength={8} onInput={(ev) => setNewPin(ev.currentTarget.value.replace(/\D/g, ''))} />
          </Field>
          <Btn kind="ghost" type="submit">
            {t('save')}
          </Btn>
        </form>
      </Card>

      <Card>
        <dl class="tech">
          <dt>{t('identity')}</dt>
          <dd class="mono">{npub.slice(0, 20)}…{npub.slice(-6)}</dd>
          <dt>{t('mint')}</dt>
          <dd class="mono">{st.mint}</dd>
          <dt>{t('relays')}</dt>
          <dd class="mono">{st.relays.join(' · ')}</dd>
        </dl>
      </Card>

      <div class="stack">
        <Btn kind="ghost" onClick={props.onLock}>
          {t('switch_profile')}
        </Btn>
        <Btn
          kind="danger"
          onClick={() => {
            if (!confirm(t('forget_confirm'))) return;
            e.stop();
            forgetProfile(props.session.meta.id);
            props.onLock();
          }}
        >
          {t('forget')}
        </Btn>
      </div>
      <Toast msg={toast} />
    </Screen>
  );
}
