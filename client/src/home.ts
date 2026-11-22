import { appConfig, devLogin, login } from './auth';
import { newGroupKey, randomB64u } from './crypto';
import { header, privacyNote } from './layout';
import { emptyState, logo } from './logo';
import type { Relay } from './relay';
import { deleteSessionData, kv, opStore } from './store';
import type { MeshSession } from './types';
import { confirmButton, fill, fmtDate, h } from './ui';

function hero(sub: string) {
  return h(
    'section',
    { class: 'hero' },
    logo('logo hero-logo'),
    h('h1', null, 'Ohrwurm'),
    h('p', { class: 'tagline' }, 'Jedes Wort bleibt hängen.'),
    h('p', { class: 'muted' }, sub),
  );
}

export function loginView(app: HTMLElement, onLoggedIn: () => void, error: string | null): () => void {
  const cfg = appConfig();
  const err = error ? h('div', { class: 'card error' }, error) : null;
  let body: HTMLElement;
  if (cfg.auth === 'dev') {
    const name = h('input', { type: 'text', maxlength: 64, placeholder: 'Dein Name', autofocus: true });
    const go = () => {
      if (!name.value.trim()) return;
      devLogin(name.value);
      onLoggedIn();
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    body = h(
      'section',
      { class: 'card narrow' },
      h('h2', null, 'Wie heißt du?'),
      h('p', { class: 'small warn' }, 'Testmodus ohne Single Sign-on – jeder Name ist erlaubt.'),
      h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: go }, 'Los geht’s')),
    );
  } else {
    body = h(
      'section',
      { class: 'card narrow center' },
      h('h2', null, 'Willkommen!'),
      h('p', null, 'Melde dich mit dem Konto deiner Organisation an.'),
      h('button', { class: 'primary big', onclick: () => void login(location.hash) }, `Anmelden über ${new URL(cfg.issuer!).host}`),
    );
  }
  const hd = header(null);
  fill(app, hd.el, h('main', null, hero('Gemeinsames Gesprächsprotokoll für Sitzungen, Konferenzen und Workshops.'), err, body, privacyNote()));
  return hd.dispose;
}

export function homeView(app: HTMLElement, relay: Relay): () => void {
  const hd = header(relay);
  const msg = h('div');
  const title = h('input', { type: 'text', maxlength: 120, placeholder: 'Worum geht’s? z. B. Teamrunde Oktober' });
  const link = h('input', { type: 'text', placeholder: 'Einladungslink einfügen' });
  const list = h('div', { class: 'list' });

  function create() {
    const sid = randomB64u(16);
    const key = newGroupKey();
    const t = title.value.trim();
    if (t) sessionStorage.setItem(`ohrwurm.newtitle.${sid}`, t);
    location.hash = `#/s/${sid}/${key}`;
  }

  function join() {
    const v = link.value.trim();
    const i = v.indexOf('#/s/');
    if (i < 0) {
      fill(msg, h('div', { class: 'card error' }, 'Hm, das sieht nicht nach einem Ohrwurm-Einladungslink aus.'));
      return;
    }
    location.hash = v.slice(i);
  }
  title.addEventListener('keydown', (e) => e.key === 'Enter' && create());
  link.addEventListener('keydown', (e) => e.key === 'Enter' && join());

  async function renderList() {
    const keys = (await kv.keys()).filter((k) => k.startsWith('mesh:'));
    const items: HTMLElement[] = [];
    for (const k of keys) {
      const s = await kv.get<MeshSession>(k);
      if (!s) continue;
      const n = await opStore.count(s.sid);
      items.push(
        h(
          'div',
          { class: 'item' },
          h('div', null, h('strong', null, s.title || 'Sitzung'), h('div', { class: 'small muted' }, `${fmtDate(s.joined)} · ${n} Einträge auf diesem Gerät`)),
          h(
            'div',
            { class: 'row tight' },
            h('a', { class: 'button', href: `#/s/${s.sid}` }, 'Öffnen'),
            confirmButton('Löschen', 'Wirklich löschen?', () => void deleteSessionData(s.sid).then(renderList)),
          ),
        ),
      );
    }
    fill(list, items.length ? items : emptyState('Noch ganz leer hier', 'Starte eine Sitzung oder tritt per QR-Code einer bei.'));
  }

  fill(
    app,
    hd.el,
    h(
      'main',
      null,
      hero('Alle im Raum transkribieren mit, alle sehen alles, alle dürfen korrigieren.'),
      msg,
      h(
        'div',
        { class: 'cards-2' },
        h(
          'section',
          { class: 'card' },
          h('h2', null, '✨ Neue Sitzung'),
          h('p', { class: 'small muted' }, 'Du bekommst einen QR-Code für alle anderen. Niemand ist Chef – jedes Gerät hat das ganze Protokoll.'),
          h('div', { class: 'row' }, title, h('button', { class: 'primary', onclick: create }, 'Starten')),
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', null, '👋 Mitmachen'),
          h('p', { class: 'small muted' }, 'QR-Code mit der Kamera scannen – oder den Link hier einfügen.'),
          h('div', { class: 'row' }, link, h('button', { onclick: join }, 'Beitreten')),
        ),
      ),
      h('section', { class: 'card' }, h('h2', null, 'Deine Sitzungen auf diesem Gerät'), list),
      privacyNote(),
    ),
  );
  void renderList();
  return hd.dispose;
}
