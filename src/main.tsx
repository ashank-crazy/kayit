import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { heartbeat, lockTab, release, type OpenSession } from './app/session';
import { setLang, t } from './app/i18n';
import { go, useRoute, Notice } from './ui/kit';
import { Welcome } from './ui/welcome';
import { Home } from './ui/home';
import { HostNew, InviteSheet, Board } from './ui/host';
import { InviteLanding, InviteCodeLanding, GiveByRef } from './ui/give';
import { Cahier, Person, EntryDetail, PaperForm } from './ui/cahier';
import { Caisse } from './ui/caisse';
import { Settings } from './ui/settings';
import { EnvelopeScreen, ScanScreen } from './ui/airgap';
import { useEngine } from './ui/kit';

function App() {
  const route = useRoute();
  const [session, setSession] = useState<OpenSession | null>(null);

  useEffect(() => {
    if (!session) return;
    const e = session.engine;
    setLang(e.state.settings.lang);
    e.start();
    heartbeat(session.meta.id);
    const hb = setInterval(() => heartbeat(session.meta.id), 3000);
    const bye = () => release(session.meta.id);
    addEventListener('pagehide', bye);
    // envelopes received in person while offline are cashed as soon as the network is back
    const back = () => e.flushHanded().catch(() => undefined);
    addEventListener('online', back);
    return () => {
      clearInterval(hb);
      removeEventListener('pagehide', bye);
      removeEventListener('online', back);
      bye();
      e.stop();
    };
  }, [session]);

  const lock = () => {
    lockTab();
    setSession(null);
    go('');
  };

  if (!session) return <Welcome onOpen={setSession} inviteWaiting={route[0] === 'invite' || route[0] === 'i'} />;
  return (
    <>
      <Status session={session} />
      <Routes route={route} session={session} onLock={lock} />
    </>
  );
}

function Status(props: { session: OpenSession }) {
  const e = props.session.engine;
  useEngine(e);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(!navigator.onLine);
    addEventListener('online', on);
    addEventListener('offline', on);
    return () => {
      removeEventListener('online', on);
      removeEventListener('offline', on);
    };
  }, []);
  if (offline) return <div class="statusbar off">{t('offline')}</div>;
  if (e.lastError) return <div class="statusbar err">{e.lastError}</div>;
  return null;
}

function Routes(props: { route: string[]; session: OpenSession; onLock: () => void }) {
  const e = props.session.engine;
  const [a, b, c] = props.route;
  switch (a) {
    case undefined:
    case '':
      return <Home engine={e} onLock={props.onLock} demo={props.session.meta.demo} />;
    case 'host':
      return <HostNew engine={e} />;
    case 'ceremony':
      if (c === 'invite') return <InviteSheet engine={e} id={b} />;
      if (c === 'scan') return <ScanScreen engine={e} id={b} demo={!!props.session.meta.demo} />;
      return <Board engine={e} id={b} />;
    case 'envelope':
      return <EnvelopeScreen engine={e} giftId={b ?? ''} demo={!!props.session.meta.demo} />;
    case 'invite':
      return <InviteLanding engine={e} payload={b ?? ''} />;
    case 'i':
      return <InviteCodeLanding engine={e} code={b ?? ''} />;
    case 'give':
      return <GiveByRef engine={e} ref_={b ?? ''} />;
    case 'cahier':
      return <Cahier engine={e} />;
    case 'person':
      return <Person engine={e} k={b ?? ''} />;
    case 'entry':
      return <EntryDetail engine={e} id={b ?? ''} />;
    case 'paper':
      return <PaperForm engine={e} />;
    case 'caisse':
      return <Caisse engine={e} />;
    case 'settings':
      return <Settings session={props.session} onLock={props.onLock} />;
    default:
      return <Notice kind="error">404</Notice>;
  }
}

render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  // phones with no built-in QR reader (iPhone) fetch the fallback reader once while online, so the
  // service worker has it for an envelope scanned later with no network
  if (!('BarcodeDetector' in globalThis)) setTimeout(() => import('jsqr').catch(() => undefined), 5000);
}
