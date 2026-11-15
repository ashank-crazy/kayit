import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, ButtonHTMLAttributes } from 'preact';
import qrcode from 'qrcode-generator';
import type { Engine, State } from '../core/engine';
import { formatXof, formatSats } from '../core/money';
import { t, type Key } from '../app/i18n';
import type { EntryStatus } from '../core/ledger';

/* ------------------------------------------------------------ routing */

export function parseHash(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const on = () => setR(parseHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function go(path: string): void {
  location.hash = '#/' + path.replace(/^\//, '');
  scrollTo(0, 0);
}

/* ------------------------------------------------------------ engine binding */

export function useEngine(engine: Engine): State {
  const [, force] = useState(0);
  useEffect(() => engine.subscribe(() => force((x) => x + 1)), [engine]);
  return engine.state;
}

/* ------------------------------------------------------------ primitives */

export function Screen(props: { title?: string; back?: string | (() => void); children: ComponentChildren; actions?: ComponentChildren }) {
  const onBack = () => (typeof props.back === 'function' ? props.back() : go(props.back ?? ''));
  return (
    <main class="screen">
      {(props.title || props.back) && (
        <header class="bar">
          {props.back !== undefined ? (
            <button class="icon-btn" onClick={onBack} aria-label={t('back')}>
              ←
            </button>
          ) : (
            <span />
          )}
          <h1>{props.title}</h1>
          <div class="bar-actions">{props.actions}</div>
        </header>
      )}
      {props.children}
    </main>
  );
}

export function Btn(props: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger' | 'quiet'; busy?: boolean; disabled?: boolean }) {
  const { kind = 'primary', busy, children, disabled, ...rest } = props;
  return (
    <button {...rest} class={`btn btn-${kind} ${rest.class ?? ''}`} disabled={disabled || busy} aria-busy={busy ? 'true' : undefined}>
      {busy ? t('working') : children}
    </button>
  );
}

export function Card(props: { children: ComponentChildren; class?: string; onClick?: () => void }) {
  return props.onClick ? (
    <button class={`card card-tap ${props.class ?? ''}`} onClick={props.onClick}>
      {props.children}
    </button>
  ) : (
    <section class={`card ${props.class ?? ''}`}>{props.children}</section>
  );
}

export function Money(props: { xof: number; sutura?: boolean; sign?: boolean; class?: string }) {
  if (props.sutura) return <span class={`money ${props.class ?? ''}`}>•••</span>;
  const s = props.sign && props.xof > 0 ? '+' : props.sign && props.xof < 0 ? '−' : '';
  return (
    <span class={`money ${props.class ?? ''}`}>
      {s}
      {formatXof(Math.abs(props.xof))}
    </span>
  );
}

export function Sats(props: { sats: number }) {
  return <span class="sats">{formatSats(props.sats)}</span>;
}

const statusKey: Record<EntryStatus, Key> = {
  cosigned: 's_cosigned',
  'awaiting-receipt': 's_awaiting_receipt',
  'awaiting-my-ok': 's_awaiting_my_ok',
  paper: 's_paper',
  rejected: 's_rejected',
  reclaimed: 's_reclaimed',
};

export function StatusBadge(props: { status: EntryStatus }) {
  const icon = props.status === 'cosigned' ? '✓✓' : props.status === 'paper' ? '✎' : props.status === 'rejected' ? '✕' : '…';
  return (
    <span class={`badge badge-${props.status}`}>
      <span aria-hidden="true">{icon}</span> {t(statusKey[props.status])}
    </span>
  );
}

export function Qr(props: { text: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, props.text.length > 600 ? 'L' : 'M');
    qr.addData(props.text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [props.text]);
  return <div class="qr" role="img" aria-label={props.label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Field(props: { label: string; hint?: string; children: ComponentChildren; error?: string | null }) {
  return (
    <label class="field">
      <span class="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span class="field-hint">{props.hint}</span>}
      {props.error && (
        <span class="field-error" role="alert">
          {props.error}
        </span>
      )}
    </label>
  );
}

export function Notice(props: { kind?: 'info' | 'warn' | 'ok' | 'error'; children: ComponentChildren }) {
  return (
    <div class={`notice notice-${props.kind ?? 'info'}`} role={props.kind === 'error' ? 'alert' : 'status'}>
      {props.children}
    </div>
  );
}

export function PinPad(props: { onDone: (pin: string) => void; label: string; error?: string | null; busy?: boolean; min?: number }) {
  const [pin, setPin] = useState('');
  const min = props.min ?? 4;
  // keys can arrive faster than renders, so the latest value lives in a ref
  const ref = useRef('');
  const set = (v: string) => {
    ref.current = v;
    setPin(v);
  };
  const press = (d: string) => {
    if (props.busy) return;
    if (d === '⌫') return set(ref.current.slice(0, -1));
    if (d === 'ok') {
      const v = ref.current;
      if (v.length >= min) {
        set('');
        props.onDone(v);
      }
      return;
    }
    if (ref.current.length < 8) set(ref.current + d);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Enter') press('ok');
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  });
  return (
    <div class="pinpad">
      <div class="pin-label">{props.label}</div>
      <div class="pin-dots" aria-live="polite" aria-label={`${pin.length}`}>
        {Array.from({ length: Math.max(min, pin.length) }, (_, i) => (
          <span class={i < pin.length ? 'dot on' : 'dot'} />
        ))}
      </div>
      {props.error && (
        <div class="field-error" role="alert">
          {props.error}
        </div>
      )}
      <div class="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'ok'].map((k) => (
          <button
            class={`pin-key ${k === 'ok' ? 'pin-ok' : ''}`}
            onClick={() => press(k)}
            disabled={props.busy || (k === 'ok' && pin.length < min)}
            aria-label={k === '⌫' ? 'effacer' : k === 'ok' ? 'valider' : k}
          >
            {k === 'ok' ? (props.busy ? '…' : 'OK') : k}
          </button>
        ))}
      </div>
    </div>
  );
}

export function copy(text: string): Promise<boolean> {
  return navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  ) ?? Promise.resolve(false);
}

export function useToast(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(id);
  }, [msg]);
  return [msg, setMsg];
}

export function Toast(props: { msg: string | null }) {
  return props.msg ? (
    <div class="toast" role="status">
      {props.msg}
    </div>
  ) : null;
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/fetch|network|Failed to|timeout|relay/i.test(m)) return t('err_network');
  return t('err_generic', { msg: m });
}
