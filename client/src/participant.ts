// Teilnehmer: transkribiert lokal und sendet verschlüsselt an den Host.
import { appConfig, idToken, userName } from './auth';
import { b64uDecode, b64uEncode, deriveSessionKey, exportPublicKey, fingerprint, generateKeyPair, open, seal, sha256, shortFp } from './crypto';
import { header, privacyNote } from './layout';
import { micPanel, type Spoken } from './micpanel';
import type { Relay, RelayMsg } from './relay';
import { deleteSessionData, kv, rows } from './store';
import type { H2P, OutEntry, P2H, PartSession, SegPayload } from './types';
import { confirmButton, fill, fmtTime, h, pill } from './ui';

export function participantView(app: HTMLElement, relay: Relay, sid: string, fp: string): () => void {
  const hd = header(relay);
  const cleanups: (() => void)[] = [hd.dispose];
  let ps: PartSession | undefined;
  let key: CryptoKey | null = null;
  let hostOnline = false;
  let recording = true;
  let fatal: string | null = null;
  let ended = false;
  let notice = '';
  const entries = new Map<number, OutEntry>();

  const pills = h('div', { class: 'pills' });
  const banner = h('div');
  const titleEl = h('h2', null, 'Sitzung');
  const listEl = h('div', { class: 'list' });
  const speaker = h('input', { type: 'text', maxlength: 64, placeholder: 'Name der sprechenden Person' });
  const panel = micPanel({ now: () => relay.now(), onSpoken: (s) => void addSegment(s) });
  cleanups.push(() => panel.dispose());

  speaker.addEventListener('change', () => {
    if (!ps) return;
    ps.speaker = speaker.value.trim().slice(0, 64);
    void save();
  });

  const save = () => (ps ? kv.set(`part:${sid}`, ps) : Promise.resolve());
  const aadOut = () => `${sid}|${ps!.peer}|p2h`;
  const aadIn = () => `${sid}|${ps!.peer}|h2p`;

  function blockReason(): string | null {
    if (fatal) return 'Gesperrt';
    if (ended) return 'Sitzung beendet';
    if (!recording) return 'Protokoll pausiert (Moderation)';
    return null;
  }

  function render() {
    panel.setBlocked(blockReason());
    titleEl.textContent = ps?.title || 'Sitzung';
    fill(
      banner,
      fatal ? h('div', { class: 'card error' }, fatal) : null,
      ended && !fatal ? h('div', { class: 'card warn' }, 'Die Sitzung wurde beendet. Deine Beiträge bleiben lokal, bis du sie löschst.') : null,
      notice ? h('div', { class: 'card warn' }, notice) : null,
    );
    fill(
      pills,
      key ? pill(`🔒 Host-Schlüssel geprüft · ${shortFp(fp)}`, 'ok', 'Der Schlüssel des Hosts passt zum Fingerprint im Einladungslink') : pill(`Fingerprint ${shortFp(fp)}`, 'muted'),
      pill(hostOnline ? 'Host online' : 'Host offline – Beiträge werden zwischengespeichert', hostOnline ? 'ok' : 'warn'),
      !recording ? pill('Protokoll pausiert', 'warn') : null,
    );
  }

  function renderList() {
    const items = [...entries.values()].sort((a, b) => b.seq - a.seq);
    fill(
      listEl,
      items.length
        ? items.map((e) =>
            h(
              'div',
              { class: `item ${e.retracted ? 'retracted' : ''}` },
              h(
                'div',
                null,
                h('div', { class: 'small muted' }, `${fmtTime(e.seg.t0)} · ${e.seg.speaker} · `, e.retracted ? 'zurückgezogen' : e.acked ? '✓ beim Host gespeichert' : '⏳ wird gesendet'),
                h('div', null, e.seg.text),
              ),
              e.retracted ? null : h('button', { class: 'link', onclick: () => void retract(e) }, 'Zurückziehen'),
            ),
          )
        : h('p', { class: 'muted' }, 'Noch keine Beiträge von diesem Gerät.'),
    );
  }

  async function sendSealed(obj: P2H): Promise<boolean> {
    if (!key || !ps) return false;
    const data = await seal(key, aadOut(), obj);
    return relay.send({ t: 'send', session: sid, to: 'host', data });
  }

  async function sendEntry(e: OutEntry) {
    if (await sendSealed(e.seg)) {
      e.lastSent = Date.now();
      await rows.put('outbox', e);
    }
  }

  async function flush(force: boolean) {
    if (!key || (!force && !hostOnline)) return;
    const now = Date.now();
    const retracts: number[] = [];
    let n = 0;
    for (const e of [...entries.values()].sort((a, b) => a.seq - b.seq)) {
      if (e.retracted) {
        if (!e.retractAcked) retracts.push(e.seq);
        continue;
      }
      if (e.acked || (!force && e.lastSent && now - e.lastSent < 10_000)) continue;
      if (n++ >= 100) break;
      await sendEntry(e);
    }
    if (retracts.length) await sendSealed({ k: 'retract', seqs: retracts });
  }

  async function addSegment(s: Spoken) {
    if (!ps || blockReason()) return;
    ps.seq += 1;
    const seq = ps.seq;
    const seg: SegPayload = {
      k: 'seg',
      seq,
      t0: Math.round(s.t0),
      t1: Math.round(s.t1),
      text: s.text,
      rms: s.rms,
      speaker: ps.speaker || userName(),
    };
    const e: OutEntry = { id: `${sid}|${seq}`, sid, seq, seg, acked: false };
    entries.set(seq, e);
    await save();
    await rows.put('outbox', e);
    renderList();
    await sendEntry(e);
  }

  async function retract(e: OutEntry) {
    e.retracted = true;
    await rows.put('outbox', e);
    renderList();
    await sendSealed({ k: 'retract', seqs: [e.seq] });
  }

  async function onHost(msg: H2P) {
    switch (msg.k) {
      case 'ack':
      case 'rack':
        for (const seq of msg.seqs) {
          const e = entries.get(seq);
          if (!e) continue;
          if (msg.k === 'ack') e.acked = true;
          else e.retractAcked = true;
          await rows.put('outbox', e);
        }
        renderList();
        break;
      case 'state':
        recording = msg.recording;
        if (ps && msg.title && ps.title !== msg.title) {
          ps.title = msg.title;
          await save();
        }
        render();
        break;
    }
  }

  async function onMsg(m: RelayMsg) {
    if (!ps || m.session !== sid) return;
    switch (m.t) {
      case 'joined': {
        const hostPub = String(m.hostPub);
        if ((await fingerprint(hostPub)) !== fp || (ps.hostPub && ps.hostPub !== hostPub)) {
          fatal =
            'WARNUNG: Der Schlüssel des Hosts passt nicht zum Fingerprint im Einladungslink. ' +
            'Möglicherweise wird die Verbindung manipuliert. Es werden keine Daten gesendet.';
          key = null;
          render();
          return;
        }
        if (!ps.hostPub) {
          ps.hostPub = hostPub;
          await save();
        }
        key ??= await deriveSessionKey(ps.keyPair.privateKey, hostPub, sid);
        hostOnline = m.online === true;
        const token = appConfig().auth === 'oidc' ? ((await idToken()) ?? undefined) : undefined;
        await sendSealed({ k: 'hello', name: userName(), idToken: token, device: { ua: navigator.userAgent.slice(0, 160), asr: panel.asrLabel() } });
        await flush(true);
        render();
        break;
      }
      case 'hoststatus':
        hostOnline = m.online === true;
        render();
        if (hostOnline) void flush(true);
        break;
      case 'recv': {
        if (!key || m.from !== 'host') return;
        try {
          await onHost(await open<H2P>(key, aadIn(), String(m.data)));
        } catch {
          /* nicht entschlüsselbar → ignorieren */
        }
        break;
      }
      case 'ended':
        ended = true;
        ps.ended = true;
        await save();
        render();
        break;
      case 'error':
        if (m.code === 'nosession') {
          ended = true;
          notice = 'Diese Sitzung gibt es auf dem Server nicht (mehr).';
        } else if (m.code === 'peertaken' || m.code === 'replaced') {
          fatal = String(m.msg);
        } else {
          notice = String(m.msg);
        }
        render();
        break;
    }
  }

  async function init() {
    ps = await kv.get<PartSession>(`part:${sid}`);
    if (!ps) {
      const keyPair = await generateKeyPair();
      const pub = await exportPublicKey(keyPair.publicKey);
      const peer = b64uEncode(await sha256(b64uDecode(pub))).slice(0, 22);
      ps = { sid, fp, keyPair, pub, peer, seq: 0, joined: Date.now(), speaker: userName() };
      await save();
    } else if (ps.fp !== fp) {
      fatal = 'Diese Sitzung ist auf diesem Gerät mit einem anderen Fingerprint gespeichert. Bitte den Einladungslink prüfen.';
    }
    ended = !!ps.ended;
    speaker.value = ps.speaker;
    for (const e of await rows.bySid<OutEntry>('outbox', sid)) entries.set(e.seq, e);
    render();
    renderList();
    if (fatal) return;
    cleanups.push(relay.on((m) => void onMsg(m)));
    cleanups.push(relay.onReady(() => relay.send({ t: 'join', session: sid, peer: ps!.peer, pub: ps!.pub })));
    const timer = window.setInterval(() => void flush(false), 10_000);
    cleanups.push(() => clearInterval(timer));
  }

  fill(
    app,
    hd.el,
    h(
      'main',
      null,
      banner,
      h('section', { class: 'card' }, titleEl, pills, h('label', null, 'Wer spricht an diesem Gerät?', speaker), h('p', { class: 'small muted' }, 'Bei einem Tischgerät vor jedem Beitrag den Namen anpassen.')),
      panel.el,
      h('section', { class: 'card' }, h('h3', null, 'Meine Beiträge'), listEl),
      h(
        'section',
        { class: 'card' },
        h('h3', null, 'Lokale Daten'),
        h('p', { class: 'small muted' }, 'Deine Beiträge liegen zusätzlich auf diesem Gerät, damit nichts verloren geht, falls der Host kurz offline ist.'),
        confirmButton('Meine lokalen Daten dieser Sitzung löschen', 'Wirklich löschen?', () => {
          relay.send({ t: 'leave', session: sid });
          void deleteSessionData(sid).then(() => (location.hash = '#/'));
        }),
      ),
      privacyNote(),
    ),
  );
  void init();
  return () => {
    relay.send({ t: 'leave', session: sid });
    cleanups.forEach((f) => f());
  };
}
