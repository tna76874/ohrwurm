import { appConfig, logout, userName } from './auth';
import type { Relay, RelayStatus } from './relay';
import { fill, h, pill } from './ui';

const STATUS: Record<RelayStatus, [string, 'ok' | 'warn' | 'bad' | 'muted']> = {
  online: ['Relay verbunden', 'ok'],
  connecting: ['verbinde …', 'warn'],
  offline: ['Relay getrennt', 'bad'],
  noauth: ['nicht angemeldet', 'bad'],
};

export function header(relay: Relay | null): { el: HTMLElement; dispose: () => void } {
  const status = h('span');
  const el = h(
    'header',
    { class: 'top' },
    h('a', { class: 'brand', href: '#/' }, '🐛 Ohrwurm'),
    h(
      'div',
      { class: 'top-right' },
      appConfig().auth === 'dev' ? pill('DEV-Anmeldung', 'warn', 'Nur für Tests: keine echte Identitätsprüfung') : null,
      status,
      userName() ? h('span', { class: 'small' }, userName()) : null,
      userName() ? h('button', { class: 'link', onclick: () => void logout() }, 'Abmelden') : null,
    ),
  );
  const dispose = relay
    ? relay.onStatus((s) => {
        const [text, kind] = STATUS[s];
        fill(status, pill(text, kind));
      })
    : () => {};
  return { el, dispose };
}

export function privacyNote() {
  return h(
    'p',
    { class: 'small muted' },
    'Audio verlässt nie dieses Gerät. Transkripte werden Ende-zu-Ende-verschlüsselt an das Host-Gerät gesendet; ' +
      'der Server sieht nur Chiffrat. Daten liegen lokal im Browser (IndexedDB), bis du sie exportierst oder löschst.',
  );
}
