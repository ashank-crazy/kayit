import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import { heartbeat, lockTab, release, type OpenSession } from './app/session';
import { setLang, t } from './app/i18n';
import { go, useRoute, Notice } from './ui/kit';
import { Welcome } from './ui/welcome';
import { Home } from './ui/home';
import { HostNew, InviteSheet, Board } from './ui/host';
import { InviteLanding, GiveByRef } from './ui/give';
import { Cahier, Person, EntryDetail, PaperForm } from './ui/cahier';
import { Caisse } from './ui/caisse';
import { Settings } from './ui/settings';
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
    return () => {
      clearInterval(hb);
      removeEventListener('pagehide', bye);
      bye();
      e.stop();
    };
  }, [session]);

  const lock = () => {
    lockTab();
    setSession(null);
    go('');
  };

  if (!session) return <Welcome onOpen={setSession} inviteWaiting={route[0] === 'invite'} />;
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
      return c === 'invite' ? <InviteSheet engine={e} id={b} /> : <Board engine={e} id={b} />;
    case 'invite':
      return <InviteLanding engine={e} payload={b ?? ''} />;
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
}
