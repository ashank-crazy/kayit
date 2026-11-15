/**
 * Handing an envelope over in person, with no network: the guest's phone plays a short QR animation,
 * the host's phone camera reads it, checks it offline and shows a receipt QR back.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import type { Engine } from '../core/engine';
import { FrameCollector, packMessage, toFrames, unpackMessage, type AirMessage } from '../core/airgap';
import { formatXof, formatSats } from '../core/money';
import type { Gift } from '../core/protocol';
import type { NostrEvent } from 'nostr-tools/pure';
import { t, fmtDate, type Key } from '../app/i18n';
import { Btn, Card, Money, Notice, Screen, StatusBadge, errMsg, useEngine } from './kit';

/* ------------------------------------------------------------ QR animation */

const CHANNEL = 'kayit-airgap';

export function AnimatedQr(props: { message: AirMessage; label: string; demo?: boolean }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    let live = true;
    packMessage(props.message).then((p) => live && setFrames(toFrames(p)));
    return () => {
      live = false;
    };
  }, [props.message]);
  const svgs = useMemo(
    () =>
      (frames ?? []).map((f) => {
        const qr = qrcode(0, 'L');
        qr.addData(f);
        qr.make();
        return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
      }),
    [frames],
  );
  useEffect(() => {
    if (!frames || frames.length < 2) return;
    const id = setInterval(() => setI((x) => (x + 1) % frames.length), 220);
    return () => clearInterval(id);
  }, [frames]);
  // demo: two notebooks on one computer cannot film each other, so frames also go to the other tab
  useEffect(() => {
    if (!props.demo || !frames || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL);
    let k = 0;
    const id = setInterval(() => ch.postMessage(frames[k++ % frames.length]), 220);
    return () => {
      clearInterval(id);
      ch.close();
    };
  }, [frames, props.demo]);
  if (!svgs.length) return <div class="qr qr-anim" aria-busy="true" />;
  return (
    <div class="qr-anim-wrap">
      <div class="qr qr-anim" role="img" aria-label={props.label} dangerouslySetInnerHTML={{ __html: svgs[i % svgs.length] }} />
      {svgs.length > 1 && (
        <div class="qr-dots" aria-hidden="true">
          {svgs.map((_, k) => (
            <span class={k === i % svgs.length ? 'on' : ''} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ camera scanner */

type Detect = (v: HTMLVideoElement, c: HTMLCanvasElement) => Promise<string[]>;

async function makeDetector(): Promise<Detect> {
  const BD = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): { detect(s: CanvasImageSource): Promise<{ rawValue: string }[]> }; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (BD && (!BD.getSupportedFormats || (await BD.getSupportedFormats()).includes('qr_code'))) {
    const d = new BD({ formats: ['qr_code'] });
    return async (v) => (await d.detect(v)).map((r) => r.rawValue);
  }
  // no built-in reader (iPhone, Firefox): load the small JS decoder only now
  const jsQR = (await import('jsqr')).default;
  return async (v, c) => {
    const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
    return r ? [r.data] : [];
  };
}

export function Scanner(props: { onMessage: (m: AirMessage) => void; hint: string; demo?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState<{ have: number; total: number } | null>(null);
  const [noCamera, setNoCamera] = useState(false);
  const done = useRef(false);
  const collector = useMemo(() => new FrameCollector(), []);

  const feed = (text: string) => {
    if (done.current) return;
    const p = collector.add(text);
    if (!p) return;
    setProgress({ have: p.have, total: p.total });
    if (p.payload) {
      done.current = true;
      unpackMessage(p.payload)
        .then(props.onMessage)
        .catch(() => {
          done.current = false;
          collector.reset();
          setProgress(null);
        });
    }
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const detect = await makeDetector();
        const tick = async () => {
          if (stopped || done.current) return;
          try {
            if (v.readyState >= 2) for (const text of await detect(v, canvas.current!)) feed(text);
          } catch {
            /* a blurry frame: keep going */
          }
          timer = setTimeout(tick, 90);
        };
        tick();
      } catch {
        setNoCamera(true);
      }
    })();
    let ch: BroadcastChannel | null = null;
    if (props.demo && typeof BroadcastChannel !== 'undefined') {
      ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = (e) => typeof e.data === 'string' && feed(e.data);
    }
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      ch?.close();
    };
  }, []);

  return (
    <div class="scanner">
      <div class="scanner-view">
        <video ref={video} playsInline muted />
        <span class="scanner-frame" aria-hidden="true" />
      </div>
      <canvas ref={canvas} hidden />
      <p class="muted small center" aria-live="polite">
        {progress ? t('scan_progress', { have: progress.have, total: progress.total }) : props.hint}
      </p>
      {props.demo && <Notice>{t('scan_demo')}</Notice>}
      {noCamera && !props.demo && <Notice kind="warn">{t('scan_no_camera')}</Notice>}
    </div>
  );
}

/* ------------------------------------------------------------ reasons */

const REASONS: Record<string, Key> = {
  'not-for-me': 'r_not_for_me',
  'not-my-ceremony': 'r_not_my_ceremony',
  'token-mismatch': 'r_token_mismatch',
  'not-locked-to-me': 'r_not_locked',
  'bad-signature': 'r_bad_signature',
  'bad-token': 'r_bad_signature',
  'wrong-mint': 'r_wrong_mint',
  short: 'r_short',
  empty: 'r_short',
  'no-mint-keys': 'r_no_keys',
  'lock-expiring': 'r_lock_expiring',
  'unknown-gift': 'r_unknown_gift',
  'not-an-envelope': 'r_bad_signature',
  'not-a-receipt': 'r_unknown_gift',
};

function reason(x: unknown): string {
  const m = x instanceof Error ? x.message : String(x);
  return REASONS[m] ? t(REASONS[m]) : errMsg(x);
}

/* ------------------------------------------------------------ guest: show my envelope */

export function EnvelopeScreen(props: { engine: Engine; giftId: string; demo: boolean }) {
  const e = props.engine;
  const st = useEngine(e);
  const env = st.outbox.find((o) => o.giftId === props.giftId);
  const entry = st.entries.find((x) => x.id === props.giftId);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const message = useMemo(() => (env && entry?.gift ? e.handoverMessage(props.giftId) : null), [env?.giftId, entry?.gift?.id]);
  if (!env || !entry) return <Screen title="?" back="caisse" children={<Notice kind="error">404</Notice>} />;
  const done = entry.status === 'cosigned';
  return (
    <Screen title={t('env_title', { host: env.hostName })} back="">
      <Card class="center">
        <Money xof={env.xof} class="huge" />
        <p class="muted">
          {env.ceremonyTitle} · {formatSats(env.sats)}
        </p>
        <StatusBadge status={entry.status} />
      </Card>
      {done ? (
        <Notice kind="ok">{t('env_done', { host: env.hostName })}</Notice>
      ) : env.state === 'prepared' ? (
        scanning ? (
          <Scanner
            demo={props.demo}
            hint={t('scan_receipt_hint')}
            onMessage={(m) =>
              e
                .acceptScannedReceipt(m)
                .then(() => setScanning(false))
                .catch((x) => {
                  setErr(reason(x));
                  setScanning(false);
                })
            }
          />
        ) : (
          <>
            <Card class="center">{message && <AnimatedQr message={message} label={t('env_show', { host: env.hostName })} demo={props.demo} />}</Card>
            <p class="muted small center">{t('env_show', { host: env.hostName })}</p>
          </>
        )
      ) : (
        <Notice>{t('env_sent_online')}</Notice>
      )}
      {err && <Notice kind="error">{err}</Notice>}
      {!done && env.state === 'prepared' && (
        <div class="stack">
          <Btn kind={scanning ? 'quiet' : 'primary'} onClick={() => { setErr(null); setScanning(!scanning); }}>
            {scanning ? t('cancel') : t('env_scan_receipt', { host: env.hostName })}
          </Btn>
          <Btn
            kind="ghost"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await e.sendPrepared(env.giftId);
              } catch (x) {
                setErr(errMsg(x));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('env_send_online')}
          </Btn>
          <p class="muted small center">{t('env_back_after', { date: fmtDate(env.locktime, { day: 'numeric', month: 'long', year: 'numeric' }) })}</p>
        </div>
      )}
    </Screen>
  );
}

/* ------------------------------------------------------------ host: scan envelopes at the door */

export function ScanScreen(props: { engine: Engine; id: string; demo: boolean }) {
  const e = props.engine;
  useEngine(e); // re-render when an envelope is cashed
  const c = e.ceremonies().find((x) => x.id === props.id);
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ gift: Gift; receipt: NostrEvent; already: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!c) return <Screen title="?" back="" children={<Notice kind="error">404</Notice>} />;
  const next = () => {
    setResult(null);
    setErr(null);
    setRound((r) => r + 1);
  };
  const pending = e.toRedeemSats();
  return (
    <Screen title={t('scan_title')} back={`ceremony/${c.id}`}>
      <p class="muted center">{c.title}</p>
      {!result && !err && (
        <Scanner
          key={round}
          demo={props.demo}
          hint={t('scan_hint')}
          onMessage={(m) =>
            e
              .acceptHanded(m)
              .then(setResult)
              .catch((x) => setErr(t('hand_bad', { reason: reason(x) })))
          }
        />
      )}
      {err && (
        <>
          <Notice kind="error">{err}</Notice>
          <Btn onClick={next}>{t('retry')}</Btn>
        </>
      )}
      {result && (
        <>
          <Notice kind="ok">
            {result.already ? t('hand_already') : t('hand_ok', { amount: formatXof(result.gift.xof), name: result.gift.giverName })}
          </Notice>
          <Card class="center">
            <AnimatedQr message={{ kind: 'receipt', receipt: result.receipt, gift: result.gift.event }} label={t('hand_show_receipt', { name: result.gift.giverName })} demo={props.demo} />
            <p class="muted small">{t('hand_show_receipt', { name: result.gift.giverName })}</p>
          </Card>
          <Btn onClick={next}>{t('hand_next')} →</Btn>
        </>
      )}
      {pending > 0 && <p class="muted small center">{t('to_redeem', { sats: formatSats(pending) })}</p>}
    </Screen>
  );
}
