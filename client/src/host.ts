// Host: empfängt, entschlüsselt, führt zusammen, fasst zusammen, exportiert.
import QRCode from 'qrcode';
import { appConfig, userName, verifyPeerToken } from './auth';
import { deriveSessionKey, open, seal, shortFp } from './crypto';
import { header, privacyNote } from './layout';
import { listModels, llmOriginAllowed, summarize } from './llm';
import { merge, paragraphs, sections, speakerLabel, toJSON, toMarkdown } from './merge';
import { micPanel, type Spoken } from './micpanel';
import type { Relay, RelayMsg } from './relay';
import { deleteSessionData, kv, rows } from './store';
import type { H2P, HostSession, Identity, P2H, Segment } from './types';
import { confirmButton, download, fill, fmtTime, h, pill, slug } from './ui';

export function hostView(app: HTMLElement, relay: Relay, sid: string): () => void {
  const hd = header(relay);
  const cleanups: (() => void)[] = [hd.dispose];
  let hs: HostSession;
  const segs = new Map<string, Segment>();
  const keys = new Map<string, Promise<CryptoKey>>();
  const online = new Set<string>();
  let relayState: 'pending' | 'hosting' | 'gone' | 'replaced' = 'pending';
  let showDups = false;
  let renderTimer: number | undefined;
  let summaryAbort: AbortController | undefined;

  const save = () => kv.set(`host:${sid}`, hs);

  // ---------- Elemente ----------
  const banner = h('div');
  const titleInput = h('input', { type: 'text', maxlength: 120 });
  const pills = h('div', { class: 'pills' });
  const qrImg = h('img', { class: 'qr', alt: 'QR-Code zum Beitreten' });
  const linkInput = h('input', { type: 'text', readonly: true });
  const peersEl = h('div', { class: 'list' });
  const transcriptEl = h('div', { class: 'transcript' });
  const topInput = h('input', { type: 'text', maxlength: 120, placeholder: 'Titel des nächsten Tagesordnungspunkts' });
  const recButton = h('button', { onclick: () => void toggleRecording() });
  const hostSpeaker = h('input', { type: 'text', maxlength: 64, placeholder: 'Name der sprechenden Person' });
  const llmUrl = h('input', { type: 'url', placeholder: 'http://localhost:11434/v1' });
  const llmModel = h('input', { type: 'text', placeholder: 'z. B. qwen3:14b', list: 'llm-models' });
  const llmModels = h('datalist', { id: 'llm-models' });
  const llmKey = h('input', { type: 'password', placeholder: 'optional', autocomplete: 'off' });
  const llmStatus = h('div', { class: 'small' });
  const llmButton = h('button', { class: 'primary', onclick: () => void runSummary() }, 'Zusammenfassung erstellen');
  const summaryEl = h('div');

  const panel = micPanel({ now: () => relay.now(), onSpoken: (s) => void addOwn(s) });
  cleanups.push(() => panel.dispose());

  // ---------- Krypto ----------
  function keyFor(peer: string): Promise<CryptoKey> | null {
    const rec = hs.peers[peer];
    if (!rec) return null;
    let k = keys.get(peer);
    if (!k) {
      k = deriveSessionKey(hs.keyPair.privateKey, rec.pub, sid);
      keys.set(peer, k);
    }
    return k;
  }

  async function sendTo(peer: string, msg: H2P) {
    const k = keyFor(peer);
    if (!k) return;
    relay.send({ t: 'send', session: sid, to: peer, data: await seal(await k, `${sid}|${peer}|h2p`, msg) });
  }

  const ackQueue = new Map<string, number[]>();
  const rackQueue = new Map<string, number[]>();
  let ackTimer: number | undefined;
  function queueAck(q: Map<string, number[]>, peer: string, seqs: number[]) {
    q.set(peer, [...(q.get(peer) ?? []), ...seqs]);
    ackTimer ??= window.setTimeout(() => {
      ackTimer = undefined;
      ackQueue.forEach((s, p) => void sendTo(p, { k: 'ack', seqs: s }));
      rackQueue.forEach((s, p) => void sendTo(p, { k: 'rack', seqs: s }));
      ackQueue.clear();
      rackQueue.clear();
    }, 300);
  }

  const stateMsg = (): H2P => ({ k: 'state', recording: hs.recording, title: hs.title });
  const broadcastState = () => online.forEach((p) => void sendTo(p, stateMsg()));

  // ---------- Relay-Nachrichten ----------
  async function upsertPeer(peer: string, pub: string, user: Identity): Promise<boolean> {
    const rec = hs.peers[peer];
    if (rec && rec.pub !== pub) {
      fill(banner, h('div', { class: 'card error' }, `Warnung: Gerät ${peer} meldet einen anderen Schlüssel als zuvor. Ignoriert.`));
      return false;
    }
    if (!rec) {
      hs.peers[peer] = { peer, pub, user };
      await save();
    }
    return true;
  }

  async function onPeerMsg(from: string, msg: P2H) {
    const rec = hs.peers[from];
    if (!rec) return;
    switch (msg.k) {
      case 'hello':
        rec.device = { ua: String(msg.device?.ua ?? '').slice(0, 160), asr: String(msg.device?.asr ?? '').slice(0, 80) };
        if (typeof msg.idToken === 'string') rec.verified = await verifyPeerToken(msg.idToken, rec.user.sub);
        await save();
        scheduleRender();
        break;
      case 'seg': {
        const ok =
          Number.isInteger(msg.seq) && msg.seq > 0 && Number.isFinite(msg.t0) && Number.isFinite(msg.t1) &&
          typeof msg.text === 'string' && msg.text.length <= 5000 && typeof msg.speaker === 'string';
        if (!ok) return;
        const id = `${sid}|${from}|${msg.seq}`;
        if (!segs.has(id)) {
          const s: Segment = {
            id, sid, peer: from, seq: msg.seq, t0: msg.t0, t1: msg.t1,
            text: msg.text.trim(), rms: Number(msg.rms) || 0, speaker: msg.speaker.trim().slice(0, 64),
          };
          await rows.put('segments', s);
          segs.set(id, s);
          scheduleRender();
        }
        queueAck(ackQueue, from, [msg.seq]);
        break;
      }
      case 'retract': {
        const seqs = (Array.isArray(msg.seqs) ? msg.seqs : []).filter((n) => Number.isInteger(n)).slice(0, 1000);
        for (const seq of seqs) await markRetracted(`${sid}|${from}|${seq}`, from, seq);
        queueAck(rackQueue, from, seqs);
        scheduleRender();
        break;
      }
    }
  }

  async function markRetracted(id: string, peer: string, seq: number) {
    const s = segs.get(id) ?? { id, sid, peer, seq, t0: 0, t1: 0, text: '', rms: 0, speaker: '' }; // Grabstein
    if (s.retracted) return;
    s.retracted = true;
    segs.set(id, s);
    await rows.put('segments', s);
  }

  async function onMsg(m: RelayMsg) {
    if (m.session !== sid) return;
    switch (m.t) {
      case 'hosting':
        relayState = 'hosting';
        online.clear();
        for (const p of (m.peers as { peer: string; pub: string; user: Identity; online: boolean }[]) ?? []) {
          if ((await upsertPeer(p.peer, p.pub, p.user)) && p.online) online.add(p.peer);
        }
        broadcastState();
        break;
      case 'peer':
        if (!(await upsertPeer(String(m.peer), String(m.pub), m.user as Identity))) return;
        if (m.online) {
          online.add(String(m.peer));
          void sendTo(String(m.peer), stateMsg());
        } else online.delete(String(m.peer));
        break;
      case 'recv': {
        const from = String(m.from);
        const k = keyFor(from);
        if (!k) return;
        try {
          await onPeerMsg(from, await open<P2H>(await k, `${sid}|${from}|p2h`, String(m.data)));
        } catch {
          /* nicht entschlüsselbar → ignorieren */
        }
        return;
      }
      case 'ended':
        relayState = 'gone';
        hs.ended = true;
        await save();
        break;
      case 'error':
        if (m.code === 'nosession') {
          relayState = 'gone';
          hs.ended = true;
          await save();
        } else if (m.code === 'replaced') relayState = 'replaced';
        else fill(banner, h('div', { class: 'card warn' }, String(m.msg)));
        break;
      default:
        return;
    }
    scheduleRender();
  }

  // ---------- Aktionen ----------
  async function addOwn(s: Spoken) {
    if (!hs.recording || hs.ended) return;
    hs.hostSeq += 1;
    const seg: Segment = {
      id: `${sid}|host|${hs.hostSeq}`, sid, peer: 'host', seq: hs.hostSeq,
      t0: Math.round(s.t0), t1: Math.round(s.t1), text: s.text, rms: s.rms,
      speaker: hs.hostSpeaker || userName(),
    };
    await save();
    await rows.put('segments', seg);
    segs.set(seg.id, seg);
    scheduleRender();
  }

  async function toggleRecording() {
    hs.recording = !hs.recording;
    await save();
    broadcastState();
    scheduleRender();
  }

  async function addTop() {
    const title = topInput.value.trim();
    if (!title) return;
    hs.agenda.push({ t: relay.now(), title });
    topInput.value = '';
    await save();
    scheduleRender();
  }

  function sectionTexts() {
    const lines = merge([...segs.values()]).map((l) => ({ ...l, speaker: speakerLabel(hs, l) }));
    return sections(lines, hs.agenda).map((s) => ({
      title: s.title,
      text: paragraphs(s.lines).map((p) => `[${fmtTime(p.t0)}] ${p.speaker}: ${p.text}`).join('\n'),
    }));
  }

  async function saveLlm() {
    hs.llm = { url: llmUrl.value.trim(), model: llmModel.value.trim(), apiKey: llmKey.value || undefined };
    await save();
  }

  async function fetchModels() {
    await saveLlm();
    try {
      const ids = await listModels(hs.llm!);
      fill(llmModels, ids.map((id) => h('option', { value: id })));
      fill(llmStatus, h('span', { class: 'ok' }, `${ids.length} Modelle gefunden`));
    } catch (e) {
      fill(llmStatus, h('span', { class: 'bad' }, `Modelle nicht abrufbar: ${(e as Error).message}`));
    }
  }

  async function runSummary() {
    if (summaryAbort) {
      summaryAbort.abort();
      return;
    }
    await saveLlm();
    const cfg = hs.llm!;
    if (!cfg.url || !cfg.model) {
      fill(llmStatus, h('span', { class: 'bad' }, 'Bitte Endpunkt und Modell angeben.'));
      return;
    }
    summaryAbort = new AbortController();
    llmButton.textContent = 'Abbrechen';
    try {
      const text = await summarize(cfg, hs.title, sectionTexts(), (m) => fill(llmStatus, m), summaryAbort.signal);
      hs.summary = { text, created: Date.now(), model: cfg.model };
      await save();
      fill(llmStatus, h('span', { class: 'ok' }, 'Zusammenfassung erstellt.'));
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'Abgebrochen.' : `Fehler: ${(e as Error).message}`;
      fill(llmStatus, h('span', { class: 'bad' }, msg));
    } finally {
      summaryAbort = undefined;
      llmButton.textContent = 'Zusammenfassung erstellen';
      scheduleRender();
    }
  }

  function exportFile(kind: 'md' | 'json') {
    const base = `ohrwurm-${new Date(hs.created).toISOString().slice(0, 10)}-${slug(hs.title)}`;
    const all = [...segs.values()].sort((a, b) => a.t0 - b.t0);
    if (kind === 'md') download(`${base}.md`, 'text/markdown', toMarkdown(hs, all));
    else download(`${base}.json`, 'application/json', toJSON(hs, all));
  }

  // ---------- Darstellung ----------
  function scheduleRender() {
    renderTimer ??= window.setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 200);
  }

  function render() {
    panel.setBlocked(hs.ended ? 'Sitzung beendet' : hs.recording ? null : 'Protokoll pausiert');
    fill(
      banner,
      relayState === 'gone' ? h('div', { class: 'card warn' }, 'Die Sitzung ist auf dem Server beendet oder abgelaufen. Alle Daten sind weiterhin lokal verfügbar und exportierbar.') : null,
      relayState === 'replaced' ? h('div', { class: 'card warn' }, 'Die Host-Rolle wurde in einem anderen Tab übernommen. Bitte nur ein Host-Fenster offen halten.') : null,
    );
    const count = [...segs.values()].filter((s) => !s.retracted).length;
    fill(
      pills,
      pill(relayState === 'hosting' ? 'Host aktiv' : relayState === 'pending' ? 'verbinde Host …' : 'nicht aktiv', relayState === 'hosting' ? 'ok' : 'warn'),
      pill(`${online.size} Geräte online`, online.size ? 'ok' : 'muted'),
      pill(`${count} Beiträge`),
      pill(hs.recording ? '● Protokoll läuft' : 'Protokoll pausiert', hs.recording ? 'ok' : 'warn'),
    );
    recButton.textContent = hs.recording ? 'Protokoll für alle pausieren' : 'Protokoll fortsetzen';
    recButton.className = hs.recording ? 'danger' : 'primary';

    const peers = Object.values(hs.peers);
    const counts = new Map<string, number>();
    segs.forEach((s) => !s.retracted && counts.set(s.peer, (counts.get(s.peer) ?? 0) + 1));
    fill(
      peersEl,
      peers.length
        ? peers.map((p) => {
            const label = h('input', { type: 'text', value: p.label ?? '', placeholder: p.user.name, maxlength: 64 });
            label.addEventListener('change', () => {
              p.label = label.value.trim() || undefined;
              void save().then(scheduleRender);
            });
            return h(
              'div',
              { class: 'item' },
              h(
                'div',
                null,
                h('strong', null, p.user.name),
                ' ',
                pill(online.has(p.peer) ? 'online' : 'offline', online.has(p.peer) ? 'ok' : 'muted'),
                ' ',
                appConfig().auth === 'oidc' ? pill(p.verified ? 'IdP-geprüft' : 'nur Relay-bestätigt', p.verified ? 'ok' : 'warn') : null,
                h('div', { class: 'small muted' }, `${counts.get(p.peer) ?? 0} Beiträge · ${p.device?.asr ?? '–'} · ${p.device?.ua ?? ''}`),
              ),
              h('label', { class: 'small' }, 'Anzeigename (Tisch, Rolle)', label),
            );
          })
        : h('p', { class: 'muted' }, 'Noch keine Geräte beigetreten.'),
    );

    const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80;
    const lines = merge([...segs.values()]);
    const secs = sections(lines, hs.agenda, showDups);
    fill(
      transcriptEl,
      secs.map((s) =>
        h(
          'div',
          { class: 'section' },
          h('h4', null, s.title),
          s.lines
            .map((l) =>
              h(
                'div',
                { class: `line ${l.dupOf ? 'dup' : ''}` },
                h('span', { class: 'time' }, fmtTime(l.t0)),
                h('span', { class: 'who', title: l.peer === 'host' ? 'Host-Gerät' : (hs.peers[l.peer]?.label || hs.peers[l.peer]?.user.name) }, speakerLabel(hs, l)),
                h('span', { class: 'text' }, l.text, l.dupOf ? h('em', { class: 'small muted' }, ' (Doppelung, ausgeblendet im Export)') : null),
                h('button', { class: 'link small', title: 'Aus dem Protokoll entfernen', onclick: () => void markRetracted(l.id, l.peer, l.seq).then(scheduleRender) }, '✕'),
              ),
            ),
        ),
      ),
      lines.length ? null : h('p', { class: 'muted' }, 'Noch keine Beiträge. Sobald jemand spricht, erscheint hier das Protokoll.'),
    );
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;

    const allowed = appConfig().llmOrigins;
    const warn = llmUrl.value && !llmOriginAllowed(llmUrl.value, allowed);
    if (warn) fill(llmStatus, h('span', { class: 'bad' }, `Dieser Endpunkt ist vom Betreiber nicht freigegeben (erlaubt: ${allowed.join(', ') || 'keine'}).`));
    fill(summaryEl, hs.summary ? h('div', null, h('h4', null, `Zusammenfassung (${hs.summary.model}, ungeprüft)`), h('pre', { class: 'summary' }, hs.summary.text)) : null);
  }

  async function init() {
    const loaded = await kv.get<HostSession>(`host:${sid}`);
    if (!loaded) {
      fill(app, hd.el, h('main', null, h('div', { class: 'card error' }, 'Diese Sitzung ist auf diesem Gerät nicht vorhanden. Host kann nur das Gerät sein, auf dem die Sitzung gestartet wurde.'), h('a', { class: 'button', href: '#/' }, 'Zur Startseite')));
      return;
    }
    hs = loaded;
    for (const s of await rows.bySid<Segment>('segments', sid)) segs.set(s.id, s);

    titleInput.value = hs.title;
    titleInput.addEventListener('change', () => {
      hs.title = titleInput.value.trim() || 'Sitzung';
      void save().then(broadcastState);
    });
    hostSpeaker.value = hs.hostSpeaker ?? userName();
    hostSpeaker.addEventListener('change', () => {
      hs.hostSpeaker = hostSpeaker.value.trim().slice(0, 64) || undefined;
      void save();
    });
    topInput.addEventListener('keydown', (e) => e.key === 'Enter' && void addTop());
    llmUrl.value = hs.llm?.url ?? 'http://localhost:11434/v1';
    llmModel.value = hs.llm?.model ?? '';
    llmKey.value = hs.llm?.apiKey ?? '';
    llmUrl.addEventListener('change', () => void saveLlm().then(render));

    const link = `${location.origin}/#/join/${sid}/${hs.fp}`;
    linkInput.value = link;
    qrImg.src = await QRCode.toDataURL(link, { margin: 1, width: 260, errorCorrectionLevel: 'M' });

    const dupToggle = h('input', { type: 'checkbox' });
    dupToggle.addEventListener('change', () => {
      showDups = dupToggle.checked;
      render();
    });

    fill(
      app,
      hd.el,
      h(
        'main',
        { class: 'wide' },
        banner,
        h(
          'div',
          { class: 'cols' },
          h(
            'div',
            { class: 'col' },
            h('section', { class: 'card' }, h('label', null, 'Titel der Sitzung', titleInput), pills, h('div', { class: 'row' }, recButton)),
            h(
              'section',
              { class: 'card' },
              h('h3', null, 'Einladen'),
              qrImg,
              h('div', { class: 'row' }, linkInput, h('button', { onclick: () => void navigator.clipboard?.writeText(link) }, 'Kopieren')),
              h('p', { class: 'small' }, 'Sicherheitscode: ', h('strong', { class: 'mono' }, shortFp(hs.fp)), ' – Teilnehmende sehen denselben Code. Den Link nur über einen vertrauenswürdigen Weg (QR-Code im Raum) verteilen.'),
            ),
            h('section', { class: 'card' }, h('h3', null, 'Geräte'), peersEl),
            h('section', { class: 'card' }, h('h3', null, 'Eigenes Mikrofon'), h('label', null, 'Wer spricht an diesem Gerät?', hostSpeaker)),
            panel.el,
          ),
          h(
            'div',
            { class: 'col' },
            h(
              'section',
              { class: 'card' },
              h('h3', null, 'Protokoll'),
              h('div', { class: 'row' }, topInput, h('button', { onclick: () => void addTop() }, 'TOP beginnen')),
              h('label', { class: 'small inline' }, dupToggle, ' Doppelungen anzeigen'),
              transcriptEl,
            ),
            h(
              'section',
              { class: 'card' },
              h('h3', null, 'KI-Zusammenfassung'),
              h('p', { class: 'small muted' }, 'OpenAI-kompatibler Endpunkt auf diesem Rechner (z. B. Ollama) oder im Firmennetz. Der Text geht direkt von diesem Browser dorthin.'),
              h('div', { class: 'grid' }, h('label', null, 'Endpunkt', llmUrl), h('label', null, 'Modell', llmModel, llmModels), h('label', null, 'API-Key', llmKey)),
              h('div', { class: 'row' }, llmButton, h('button', { onclick: () => void fetchModels() }, 'Modelle abrufen')),
              llmStatus,
              summaryEl,
            ),
            h(
              'section',
              { class: 'card' },
              h('h3', null, 'Export & Abschluss'),
              h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => exportFile('md') }, 'Protokoll (Markdown)'), h('button', { onclick: () => exportFile('json') }, 'Rohdaten (JSON)')),
              h(
                'div',
                { class: 'row' },
                confirmButton('Sitzung beenden', 'Wirklich für alle beenden?', () => {
                  hs.recording = false;
                  void save();
                  relay.send({ t: 'end', session: sid });
                }),
                confirmButton('Lokale Daten löschen', 'Alles unwiderruflich löschen?', () => {
                  relay.send({ t: 'end', session: sid });
                  void deleteSessionData(sid).then(() => (location.hash = '#/'));
                }),
              ),
            ),
            privacyNote(),
          ),
        ),
      ),
    );
    render();
    cleanups.push(relay.on((m) => void onMsg(m)));
    cleanups.push(relay.onReady(() => relay.send({ t: 'host', session: sid })));
  }

  void init();
  return () => {
    summaryAbort?.abort();
    clearTimeout(renderTimer);
    cleanups.forEach((f) => f());
  };
}
