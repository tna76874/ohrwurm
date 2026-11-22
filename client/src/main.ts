import './style.css';
import { handleCallback, idToken, isLoggedIn, loadConfig } from './auth';
import { homeView, loginView } from './home';
import { Relay } from './relay';
import { sessionView } from './session';
import { requestPersistence } from './store';
import { h } from './ui';

async function boot() {
  const app = document.getElementById('app')!;
  try {
    await loadConfig();
  } catch (e) {
    app.replaceChildren(h('main', null, h('div', { class: 'card error' }, `Konfiguration nicht ladbar: ${(e as Error).message}`)));
    return;
  }
  let authError: string | null = null;
  try {
    await handleCallback();
  } catch (e) {
    authError = (e as Error).message;
  }
  void requestPersistence();

  const relay = new Relay(idToken);
  let dispose: (() => void) | undefined;

  const route = () => {
    dispose?.();
    dispose = undefined;
    window.scrollTo(0, 0);
    if (!isLoggedIn()) {
      dispose = loginView(app, () => route(), authError);
      return;
    }
    relay.start();
    const [view, a, b] = location.hash.replace(/^#\/?/, '').split('/');
    if (view === 's' && a) dispose = sessionView(app, relay, a, b || undefined);
    else dispose = homeView(app, relay);
  };

  relay.onStatus((s) => {
    if (s === 'noauth' && isLoggedIn()) authError = 'Die Anmeldung ist abgelaufen. Bitte neu anmelden.';
  });
  window.addEventListener('hashchange', route);
  route();
}

void boot();
