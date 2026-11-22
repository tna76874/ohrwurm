import { appConfig, devLogin, login } from './auth';
import { exportPublicKey, fingerprint, generateKeyPair } from './crypto';
import { header, privacyNote } from './layout';
import type { Relay, RelayMsg } from './relay';
import { deleteSessionData, kv } from './store';
import type { HostSession, PartSession } from './types';
import { confirmButton, fill, fmtDate, h } from './ui';

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
      { class: 'card' },
      h('h2', null, 'Anmelden (Dev-Modus)'),
      h('p', { class: 'warn' }, 'Der Server läuft ohne OIDC. Jeder kann jeden Namen angeben – nur für Tests.'),
      h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: go }, 'Weiter')),
    );
  } else {
    body = h(
      'section',
      { class: 'card' },
      h('h2', null, 'Anmelden'),
      h('p', null, 'Die Anmeldung erfolgt über den Identity Provider deiner Organisation.'),
      h('button', { class: 'primary', onclick: () => void login(location.hash) }, `Anmelden über ${new URL(cfg.issuer!).host}`),
    );
  }
  const hd = header(null);
  fill(app, hd.el, h('main', null, err, body, privacyNote()));
  return hd.dispose;
}

export function homeView(app: HTMLElement, relay: Relay): () => void {
  const hd = header(relay);
  const cleanups: (() => void)[] = [hd.dispose];
  const msg = h('div');
  const title = h('input', { type: 'text', maxlength: 120, placeholder: 'Titel, z. B. Mitgliederversammlung 2026' });
  const link = h('input', { type: 'text', placeholder: 'Einladungslink einfügen' });
  const list = h('div', { class: 'list' });

  async function create() {
    fill(msg);
    const kp = await generateKeyPair();
    const pub = await exportPublicKey(kp.publicKey);
    const fp = await fingerprint(pub);
    const off = relay.on((m: RelayMsg) => {
      if (m.t === 'created') {
        off();
        const sid = String(m.session);
        const hs: HostSession = {
          sid,
          title: title.value.trim() || 'Sitzung',
          created: Date.now(),
          keyPair: kp,
          pub,
          fp,
          peers: {},
          agenda: [],
          recording: true,
          hostSeq: 0,
        };
        void kv.set(`host:${sid}`, hs).then(() => (location.hash = `#/host/${sid}`));
      } else if (m.t === 'error' && !m.session) {
        off();
        fill(msg, h('div', { class: 'card error' }, String(m.msg)));
      }
    });
    cleanups.push(off);
    if (!relay.send({ t: 'create', pub })) {
      off();
      fill(msg, h('div', { class: 'card error' }, 'Keine Verbindung zum Relay.'));
    }
  }

  function join() {
    const v = link.value.trim();
    const i = v.indexOf('#/join/');
    if (i < 0) {
      fill(msg, h('div', { class: 'card error' }, 'Das ist kein gültiger Ohrwurm-Einladungslink.'));
      return;
    }
    location.hash = v.slice(i);
  }

  async function renderList() {
    const keys = (await kv.keys()).filter((k) => k.startsWith('host:') || k.startsWith('part:'));
    const items: HTMLElement[] = [];
    for (const k of keys) {
      const role = k.startsWith('host:') ? 'Host' : 'Teilnahme';
      const s = await kv.get<HostSession | PartSession>(k);
      if (!s) continue;
      const href = role === 'Host' ? `#/host/${s.sid}` : `#/join/${s.sid}/${(s as PartSession).fp}`;
      const when = 'created' in s ? s.created : s.joined;
      items.push(
        h(
          'div',
          { class: 'item' },
          h('div', null, h('strong', null, s.title || 'Sitzung'), h('div', { class: 'small muted' }, `${role} · ${fmtDate(when)}${s.ended ? ' · beendet' : ''}`)),
          h(
            'div',
            { class: 'row' },
            h('a', { class: 'button', href }, 'Öffnen'),
            confirmButton('Löschen', 'Wirklich löschen?', () => void deleteSessionData(s.sid).then(renderList)),
          ),
        ),
      );
    }
    fill(list, items.length ? items : h('p', { class: 'muted' }, 'Noch keine Sitzungen auf diesem Gerät.'));
  }

  fill(
    app,
    hd.el,
    h(
      'main',
      null,
      msg,
      h('section', { class: 'card' }, h('h2', null, 'Neue Sitzung leiten'), h('p', { class: 'small muted' }, 'Dieses Gerät wird Host: Es empfängt und speichert das Protokoll.'), h('div', { class: 'row' }, title, h('button', { class: 'primary', onclick: () => void create() }, 'Sitzung starten'))),
      h('section', { class: 'card' }, h('h2', null, 'Teilnehmen'), h('p', { class: 'small muted' }, 'QR-Code scannen oder Einladungslink einfügen.'), h('div', { class: 'row' }, link, h('button', { onclick: join }, 'Beitreten'))),
      h('section', { class: 'card' }, h('h2', null, 'Auf diesem Gerät'), list),
      privacyNote(),
    ),
  );
  void renderList();
  return () => cleanups.forEach((f) => f());
}
