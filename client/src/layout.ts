import { appConfig, logout, userName } from './auth';
import { logo } from './logo';
import type { Relay, RelayStatus } from './relay';
import { fill, h, pill } from './ui';

const STATUS: Record<RelayStatus, [string, 'ok' | 'warn' | 'bad' | 'muted']> = {
  online: ['verbunden', 'ok'],
  connecting: ['verbinde …', 'warn'],
  offline: ['offline – Daten bleiben lokal', 'bad'],
  noauth: ['nicht angemeldet', 'bad'],
};

export function brand(): HTMLElement {
  return h('a', { class: 'brand', href: '#/' }, logo(), h('span', { class: 'wordmark' }, 'Ohrwurm'));
}

export function header(relay: Relay | null): { el: HTMLElement; dispose: () => void } {
  const status = h('span');
  const name = userName();
  const el = h(
    'header',
    { class: 'top' },
    brand(),
    h(
      'div',
      { class: 'top-right' },
      appConfig().auth === 'dev' ? pill('Dev-Anmeldung', 'warn', 'Nur für Tests: keine echte Identitätsprüfung') : null,
      status,
      name ? h('span', { class: 'avatar', title: name }, initials(name)) : null,
      name ? h('button', { class: 'link', onclick: () => void logout() }, 'Abmelden') : null,
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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Stabile, freundliche Farbe pro Person. */
export function personColor(key: string): string {
  let hsh = 0;
  for (let i = 0; i < key.length; i++) hsh = (hsh * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hsh) % 360} 55% 45%)`;
}

export function privacyNote() {
  return h(
    'footer',
    { class: 'footnote' },
    h('strong', null, '🤫 Kein Ton verlässt dein Gerät. '),
    'Die Spracherkennung läuft hier im Browser. Nur Text wird verschlüsselt mit den anderen Geräten der Sitzung geteilt – ' +
      'der Server sieht ausschließlich Chiffrat. Jedes Gerät hat eine vollständige Kopie des Protokolls.',
  );
}
