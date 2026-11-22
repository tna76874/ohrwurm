// Die gemeinsame Sitzung: Jedes Gerät ist gleichberechtigt, sieht das ganze
// Protokoll und darf korrigieren, Sprecher zuordnen, markieren und mit dem
// eigenen LLM zusammenfassen.
import QRCode from 'qrcode';
import { appConfig, userName } from './auth';
import { exportPublicKey, generateSigningKey, importGroupKey, keyCode, peerIdFor, randomB64u } from './crypto';
import { header, initials, personColor, privacyNote } from './layout';
import { correct, listModels, llmOriginAllowed, normalizeBase, summarize, type Correction } from './llm';
import { emptyState, logo } from './logo';
import { merge, paragraphs, sections, speakerOf, toJSON, toMarkdown, type Line } from './merge';
import { Mesh } from './mesh';
import { micPanel, type Spoken } from './micpanel';
import type { Relay } from './relay';
import { buildView, memberName, type SessionView } from './state';
import { deleteSessionData, kv } from './store';
import type { LlmSettings, MeshSession } from './types';
import { toPdf } from './pdf';
import { roomMap } from './roommap';
import { confirmButton, download, downloadBlob, fill, fmtTime, h, pill, slug } from './ui';

const LLM_KEY = 'ohrwurm.llm';

function loadLlm(): LlmSettings {
  try {
    return { url: 'http://localhost:11434/v1', model: '', ...(JSON.parse(localStorage.getItem(LLM_KEY) || '{}') as Partial<LlmSettings>) };
  } catch {
    return { url: 'http://localhost:11434/v1', model: '' };
  }
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} auf ${os}`;
}

export function sessionView(app: HTMLElement, relay: Relay, sid: string, keyFromLink?: string): () => void {
  const hd = header(relay);
  const cleanups: (() => void)[] = [hd.dispose];
  let mesh: Mesh | undefined;
  let ms: MeshSession;
  let view: SessionView | undefined;
  let editing: string | null = null;
  let showDups = false;
  let showHidden = false;
  let onlyFlagged = false;
  let busy: AbortController | undefined;
  let localSummary: { text: string; model: string } | null = null;
  let corrections: (Correction & { ok: boolean })[] = [];
  const llm = loadLlm();

  // ---------- Elemente ----------
  const banner = h('div');
  const titleInput = h('input', { type: 'text', class: 'title-input', maxlength: 120, 'aria-label': 'Titel der Sitzung' });
  const pills = h('div', { class: 'pills' });
  const pauseBtn = h('button', { onclick: () => void togglePause() });
  const invite = h('section', { class: 'card invite', hidden: true });
  const inviteBtn = h('button', { class: 'primary', onclick: () => (invite.hidden = !invite.hidden) }, '📲 Leute einladen');
  const membersEl = h('div', { class: 'members' });
  const speakerInput = h('input', { type: 'text', maxlength: 64, list: 'ohrwurm-speakers', placeholder: 'Name der sprechenden Person' });
  const speakersList = h('datalist', { id: 'ohrwurm-speakers' });
  const topInput = h('input', { type: 'text', maxlength: 120, placeholder: 'Nächster Tagesordnungspunkt …' });
  const transcriptEl = h('div', { class: 'transcript' });
  const summariesEl = h('div');
  const llmUrl = h('input', { type: 'url', value: llm.url, placeholder: 'z. B. http://localhost:1234 (LM Studio) oder http://localhost:11434 (Ollama)' });
  const llmModel = h('input', { type: 'text', value: llm.model, placeholder: 'z. B. qwen3:14b', list: 'llm-models' });
  const llmModels = h('datalist', { id: 'llm-models' });
  const llmKey = h('input', { type: 'password', value: llm.apiKey ?? '', placeholder: 'optional', autocomplete: 'off' });
  const glossary = h('textarea', { rows: 2, placeholder: 'Namen & Fachbegriffe, z. B. „Kubernetes, Frau Özdemir, KPI“' });
  const scopeSel = h(
    'select',
    null,
    h('option', { value: 'last' }, 'die letzten 50 Beiträge'),
    h('option', { value: 'flagged' }, 'nur markierte ⚑'),
    h('option', { value: 'all' }, 'das ganze Protokoll'),
  );
  const llmStatus = h('div', { class: 'small' });
  const assistantOut = h('div');
  const sumBtn = h('button', { class: 'primary', onclick: () => void runSummary() }, '📝 Zusammenfassen');
  const corBtn = h('button', { onclick: () => void runCorrect() }, '🪄 Korrekturvorschläge');

  const panel = micPanel({ now: () => relay.now(), onSpoken: (s) => void addSpoken(s) });
  cleanups.push(() => panel.dispose());

  const map = roomMap({
    now: () => relay.now(),
    mesh: () => mesh,
    onAssign: (seg, peer) => void assignTo(seg, peer),
    onPhase: () => render(),
    lastSpeaker: () => {
      const ls = visibleLines();
      const last = ls[ls.length - 1];
      return view && last && relay.now() - last.t1 < 20_000 ? speakerOf(view, last) : null;
    },
  });
  cleanups.push(() => map.dispose());

  // ---------- Aktionen ----------
  async function addSpoken(s: Spoken) {
    if (!mesh || !view?.recording || mesh.error) return;
    await mesh.create({ type: 'seg', t0: Math.round(s.t0), t1: Math.round(s.t1), text: s.text, rms: s.rms, speaker: ms.speaker || userName() });
  }

  /** Beitrag der Person zuordnen, die auf dem Raumplan angetippt wurde. */
  async function assignTo(seg: string, peer: string) {
    if (!mesh || !view) return;
    const line = view.segs.find((s) => s.id === seg);
    const name = memberName(view, peer);
    if (line && speakerOf(view, line) !== name) await mesh.create({ type: 'speaker', seg, speaker: name });
  }

  async function togglePause() {

    if (!mesh || !view) return;
    await mesh.create({ type: 'pause', recording: !view.recording });
  }

  async function addTop() {
    const title = topInput.value.trim();
    if (!mesh || !title) return;
    topInput.value = '';
    await mesh.create({ type: 'agenda', id: randomB64u(8), title, t: Math.round(relay.now()) });
  }

  function saveLlm() {
    llm.url = normalizeBase(llmUrl.value);
    llmUrl.value = llm.url;
    llm.model = llmModel.value.trim();
    llm.apiKey = llmKey.value || undefined;
    localStorage.setItem(LLM_KEY, JSON.stringify(llm));
    renderAssistantStatus();
  }

  function visibleLines(): Line[] {
    return view ? merge(view.segs).filter((l) => !l.dupOf) : [];
  }

  function sectionTexts() {
    if (!view) return [];
    const v = view;
    return sections(visibleLines(), v.agenda).map((s) => ({
      title: s.title,
      text: paragraphs(s.lines, (l) => speakerOf(v, l)).map((p) => `[${fmtTime(p.t0)}] ${p.speaker}: ${p.text}`).join('\n'),
    }));
  }

  function guard(): boolean {
    saveLlm();
    if (!llm.url || !llm.model) {
      fill(llmStatus, h('span', { class: 'bad' }, 'Bitte Endpunkt und Modell angeben.'));
      return false;
    }
    if (!busy && !renderAssistantStatus()) return false;
    if (busy) {
      busy.abort();
      return false;
    }
    return true;
  }

  async function withBusy(btn: HTMLButtonElement, label: string, fn: (signal: AbortSignal) => Promise<void>) {
    busy = new AbortController();
    const old = btn.textContent;
    btn.textContent = '⏹ Abbrechen';
    try {
      await fn(busy.signal);
    } catch (e) {
      fill(llmStatus, h('span', { class: 'bad' }, (e as Error).name === 'AbortError' ? 'Abgebrochen.' : `${label}: ${(e as Error).message}`));
    } finally {
      busy = undefined;
      btn.textContent = old;
      renderAssistant();
    }
  }

  async function runSummary() {
    if (!guard()) return;
    await withBusy(sumBtn, 'Zusammenfassung', async (signal) => {
      const text = await summarize(llm, view?.title ?? 'Sitzung', sectionTexts(), (m) => fill(llmStatus, m), signal);
      localSummary = { text, model: llm.model };
      fill(llmStatus, h('span', { class: 'ok' }, 'Fertig! Erst einmal nur bei dir – teilen kannst du sie unten.'));
    });
  }

  async function runCorrect() {
    if (!guard() || !view) return;
    const v = view;
    let lines = visibleLines();
    if (scopeSel.value === 'last') lines = lines.slice(-50);
    if (scopeSel.value === 'flagged') lines = lines.filter((l) => l.flagged);
    if (!lines.length) {
      fill(llmStatus, 'Keine passenden Beiträge.');
      return;
    }
    await withBusy(corBtn, 'Korrektur', async (signal) => {
      const res = await correct(llm, lines.map((l) => ({ id: l.id, speaker: speakerOf(v, l), text: l.text })), glossary.value, (m) => fill(llmStatus, m), signal);
      corrections = res.map((c) => ({ ...c, ok: true }));
      fill(llmStatus, h('span', { class: 'ok' }, res.length ? `${res.length} Vorschläge – bitte kurz prüfen.` : 'Alles sauber, keine Korrekturen nötig. 🎉'));
    });
  }

  async function applyCorrections() {
    if (!mesh) return;
    const chosen = corrections.filter((c) => c.ok);
    corrections = [];
    for (const c of chosen) await mesh.create({ type: 'edit', seg: c.id, text: c.text, via: 'llm' });
    fill(llmStatus, h('span', { class: 'ok' }, `${chosen.length} Korrekturen übernommen und mit allen geteilt.`));
    renderAssistant();
  }

  async function fetchModels() {
    saveLlm();
    if (!renderAssistantStatus()) return;
    try {
      const ids = await listModels(llm);
      fill(llmModels, ids.map((id) => h('option', { value: id })));
      fill(llmStatus, h('span', { class: 'ok' }, `${ids.length} Modelle gefunden.`));
    } catch (e) {
      fill(llmStatus, h('span', { class: 'bad' }, `Modelle nicht abrufbar: ${(e as Error).message}`));
    }
  }

  async function exportFile(kind: 'md' | 'json' | 'pdf') {
    if (!mesh || !view) return;
    const first = view.segs[0]?.t0 ?? Date.now();
    const base = `ohrwurm-${new Date(first).toISOString().slice(0, 10)}-${slug(view.title)}`;
    if (kind === 'pdf') {
      const blob = await toPdf(view, sid);
      downloadBlob(`${base}.pdf`, blob);
    } else if (kind === 'md') download(`${base}.md`, 'text/markdown', toMarkdown(view, sid));
    else download(`${base}.json`, 'application/json', toJSON(mesh, view));
  }

  // ---------- Bearbeiten ----------
  function editText(l: Line, body: HTMLElement) {
    if (!mesh) return;
    editing = l.id;
    const ta = h('textarea', { class: 'edit', rows: Math.min(8, Math.ceil(l.text.length / 60) + 1) });
    ta.value = l.text;
    const done = async (save: boolean) => {
      const v = ta.value.trim();
      editing = null;
      if (save && v && v !== l.text) await mesh!.create({ type: 'edit', seg: l.id, text: v });
      render();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') void done(false);
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void done(true);
    });
    fill(
      body,
      ta,
      h(
        'div',
        { class: 'row tight' },
        h('button', { class: 'primary small', onclick: () => void done(true) }, 'Speichern'),
        h('button', { class: 'small', onclick: () => void done(false) }, 'Abbrechen'),
        h('span', { class: 'small muted' }, 'Strg+Enter speichert · Esc bricht ab'),
      ),
    );
    ta.focus();
  }

  function editSpeaker(l: Line, slot: HTMLElement) {
    if (!mesh || !view) return;
    editing = l.id;
    const current = speakerOf(view, l);
    const input = h('input', { type: 'text', class: 'who-edit', list: 'ohrwurm-speakers', maxlength: 64 });
    input.value = current;
    let finished = false;
    const done = async (save: boolean) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      editing = null;
      if (save && v && v !== current) await mesh!.create({ type: 'speaker', seg: l.id, speaker: v });
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void done(true);
      if (e.key === 'Escape') void done(false);
    });
    input.addEventListener('blur', () => void done(true));
    fill(slot, input);
    input.focus();
    input.select();
  }

  // ---------- Darstellung ----------
  function lineEl(l: Line): HTMLElement {
    const v = view!;
    const sp = speakerOf(v, l);
    const who = h('div', { class: 'who-slot' });
    const body = h('div', { class: 'body' });
    const metaBits: (HTMLElement | string)[] = [];
    if (l.edits.length) {
      const names = [...new Set(l.edits.map((e) => memberName(v, e.by)))].join(', ');
      const hist = [`Original: ${l.origText}`, ...l.edits.map((e) => `${fmtTime(e.at)} ${memberName(v, e.by)}${e.via === 'llm' ? ' (KI-Vorschlag)' : ''}: ${e.value}`)].join('\n');
      metaBits.push(h('span', { class: 'meta', title: hist }, `${l.edits.some((e) => e.via === 'llm') ? '🪄' : '✎'} ${names}`));
    }
    if (l.speakerChanges.length) {
      const last = l.speakerChanges[l.speakerChanges.length - 1];
      metaBits.push(h('span', { class: 'meta', title: `Ursprünglich: ${l.origSpeaker || memberName(v, l.author)}` }, `↪ zugeordnet von ${memberName(v, last.by)}`));
    }
    if (l.dupOf) metaBits.push(h('span', { class: 'meta' }, 'Doppelung (anderes Gerät hat denselben Satz)'));
    if (l.hidden) metaBits.push(h('span', { class: 'meta' }, `ausgeblendet von ${memberName(v, l.hiddenBy ?? '')}`));

    fill(
      who,
      h(
        'button',
        { class: 'who', style: `--c:${personColor(sp)}`, title: 'Klicken: anderer Person zuordnen', onclick: () => editSpeaker(l, who) },
        h('span', { class: 'avatar sm', style: `background:${personColor(sp)}` }, initials(sp)),
        h('span', { class: 'who-name' }, sp),
      ),
    );
    fill(body, h('span', { class: 'text', title: 'Doppelklick zum Bearbeiten', ondblclick: () => editText(l, body) }, l.text), metaBits.length ? h('div', { class: 'metas' }, metaBits) : null);

    return h(
      'div',
      { class: `line${l.author === mesh!.me ? ' mine' : ''}${l.dupOf ? ' dup' : ''}${l.hidden ? ' hidden' : ''}${l.flagged ? ' flagged' : ''}`, 'data-id': l.id },
      h('span', { class: 'time' }, fmtTime(l.t0)),
      who,
      body,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'icon', title: 'Auf dem Raumplan einer Person zuordnen', onclick: () => map.startAssign({ seg: l.id, text: l.text }) }, '📍'),
        h('button', { class: 'icon', title: 'Text bearbeiten', onclick: () => editText(l, body) }, '✎'),
        h('button', { class: `icon${l.flagged ? ' on' : ''}`, title: l.flagged ? 'Markierung entfernen' : 'Zum Prüfen markieren', onclick: () => void mesh!.create({ type: 'flag', seg: l.id, flagged: !l.flagged }) }, '⚑'),
        h('button', { class: 'icon', title: l.hidden ? 'Wieder einblenden' : 'Aus dem Protokoll ausblenden', onclick: () => void mesh!.create({ type: 'hide', seg: l.id, hidden: !l.hidden }) }, l.hidden ? '↺' : '✕'),
      ),
    );
  }

  function renderTranscript() {
    if (!view || !mesh || editing) return;
    const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120;
    let lines = merge(view.segs, showHidden);
    if (onlyFlagged) lines = lines.filter((l) => l.flagged);
    const secs = sections(lines, view.agenda, showDups);
    const hasAny = view.segs.length > 0;
    fill(
      transcriptEl,
      hasAny
        ? secs.map((s) =>
            h(
              'div',
              { class: 'section' },
              h(
                'h4',
                null,
                s.title,
                s.id ? h('button', { class: 'icon small', title: 'Tagesordnungspunkt entfernen', onclick: () => void mesh!.create({ type: 'agenda', id: s.id!, title: '', t: s.t, deleted: true }) }, '✕') : null,
              ),
              s.lines.map(lineEl),
            ),
          )
        : emptyState('Noch ist es still …', 'Sobald jemand ins Mikro spricht, erscheint hier das gemeinsame Protokoll.'),
    );
    if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function renderMembers() {
    if (!view || !mesh) return;
    const v = view;
    fill(
      membersEl,
      v.members.map((m) => {
        const name = m.attested?.name ?? m.name;
        return h(
          'div',
          { class: `member${m.online ? ' online' : ''}` },
          h('span', { class: 'avatar', style: `background:${personColor(name)}` }, initials(name), h('span', { class: 'presence' })),
          h(
            'div',
            null,
            h('div', null, h('strong', null, name), m.peer === mesh!.me ? h('span', { class: 'small muted' }, ' (du)') : null),
            h(
              'div',
              { class: 'small muted' },
              `${m.segs} Beiträge · ${m.edits} Korrekturen · ${m.device}`,
              m.conflict ? h('span', { class: 'bad' }, ' · Identität widersprüchlich!') : !m.attested ? h('span', { class: 'warn' }, ' · unbestätigt') : null,
            ),
          ),
        );
      }),
    );
  }

  /** true, wenn der Endpunkt laut Freigabeliste (CSP) erreichbar ist. */
  function renderAssistantStatus(): boolean {
    const allowed = appConfig().llmOrigins;
    if (llm.url && !llmOriginAllowed(llm.url, allowed)) {
      fill(
        llmStatus,
        h('span', { class: 'bad' }, `Diese Adresse ist auf diesem Server nicht freigegeben. Erlaubt: ${allowed.join(', ') || 'keine'}. `),
        h('span', { class: 'muted' }, '(Admin: OHRWURM_LLM_ORIGINS ergänzen)'),
      );
      return false;
    }
    if (llmStatus.querySelector('.bad')) fill(llmStatus);
    return true;
  }

  function renderAssistant() {
    const parts: HTMLElement[] = [];
    if (localSummary) {
      const s = localSummary;
      parts.push(
        h(
          'div',
          { class: 'result' },
          h('h4', null, `Deine Zusammenfassung (${s.model})`),
          h('pre', { class: 'summary' }, s.text),
          h(
            'div',
            { class: 'row tight' },
            h('button', { class: 'primary small', onclick: () => void mesh?.create({ type: 'summary', model: s.model, text: s.text }).then(() => ((localSummary = null), renderAssistant())) }, '📤 Mit allen teilen'),
            h('button', { class: 'small', onclick: () => ((localSummary = null), renderAssistant()) }, 'Verwerfen'),
          ),
        ),
      );
    }
    if (corrections.length) {
      parts.push(
        h(
          'div',
          { class: 'result' },
          h('h4', null, `Korrekturvorschläge (${corrections.length})`),
          corrections.map((c) => {
            const cb = h('input', { type: 'checkbox', checked: c.ok });
            cb.addEventListener('change', () => (c.ok = cb.checked));
            return h('label', { class: 'correction' }, cb, h('div', null, h('del', null, c.before), h('ins', null, c.text)));
          }),
          h(
            'div',
            { class: 'row tight' },
            h('button', { class: 'primary small', onclick: () => void applyCorrections() }, '✔ Ausgewählte übernehmen'),
            h('button', { class: 'small', onclick: () => ((corrections = []), renderAssistant()) }, 'Verwerfen'),
          ),
        ),
      );
    }
    fill(assistantOut, parts);
  }

  function renderSummaries() {
    if (!view) return;
    const v = view;
    fill(
      summariesEl,
      v.summaries.length
        ? v.summaries.map((s, i) =>
            h('details', { class: 'shared-summary', open: i === 0 }, h('summary', null, `${memberName(v, s.by)} · ${fmtTime(s.at)} · ${s.model}`), h('pre', { class: 'summary' }, s.text)),
          )
        : h('p', { class: 'small muted' }, 'Noch keine geteilten Zusammenfassungen. Jede:r kann eine erstellen und teilen.'),
    );
  }

  function render() {
    if (!mesh) return;
    view = buildView(mesh);
    const v = view;
    if (ms.title !== v.title) {
      ms.title = v.title;
      void kv.set(`mesh:${sid}`, ms);
    }
    if (document.activeElement !== titleInput) titleInput.value = v.title;
    document.title = `${v.title} · Ohrwurm`;

    const othersOnline = v.members.filter((m) => m.online && m.peer !== mesh!.me).length;
    const replicas = mesh.replicas();
    const missing = mesh.missing();
    fill(
      pills,
      pill(mesh.joined ? `👥 ${othersOnline === 1 ? '1 weiteres Gerät' : `${othersOnline} weitere Geräte`} dabei` : '📴 offline – alles bleibt hier gespeichert', mesh.joined ? 'ok' : 'warn'),
      missing > 0
        ? pill(`⟳ Protokoll wird geladen (${missing}) …`, 'warn')
        : pill(replicas ? '✓ Alles gespeichert & gesichert' : '✓ Gespeichert auf diesem Gerät', 'ok', replicas ? `Auch auf ${replicas} weiteren Geräten vollständig vorhanden` : 'Sobald andere dabei sind, wird automatisch mit ihnen geteilt'),
      pill(v.recording ? '● Protokoll läuft' : `⏸ Pause (${memberName(v, v.recordingBy ?? '')})`, v.recording ? 'rec' : 'warn'),
    );
    pauseBtn.textContent = v.recording ? '⏸️ Für alle pausieren' : '▶️ Weiter mitschreiben';
    pauseBtn.className = v.recording ? '' : 'primary';
    panel.setBlocked(mesh.error ? 'Gesperrt' : (map.blockReason() ?? (v.recording ? null : `Pausiert von ${memberName(v, v.recordingBy ?? '')}`)));

    fill(
      banner,
      mesh.error ? h('div', { class: 'card error' }, mesh.error) : null,
      mesh.conflicts.size ? h('div', { class: 'card warn' }, 'Achtung: Für mindestens ein Gerät meldet der Server eine andere Person als zuvor. Betroffene Einträge sind markiert.') : null,
    );

    const names = new Set<string>(v.members.map((m) => m.attested?.name ?? m.name));
    v.segs.forEach((s) => s.speaker && names.add(s.speaker));
    fill(speakersList, [...names].sort().map((n) => h('option', { value: n })));

    renderMembers();
    renderTranscript();
    renderSummaries();
    map.update(v);
  }

  /** Drei Sätze, die reichen, um mitzumachen. Lässt sich wegklicken. */
  function onboarding(): HTMLElement | null {
    if (localStorage.getItem('ohrwurm.onboarded')) return null;
    const card: HTMLElement = h(
      'section',
      { class: 'card onboarding' },
      h('h3', null, 'So einfach geht’s'),
      h(
        'ol',
        { class: 'steps' },
        h('li', null, h('span', { class: 'step-icon' }, '🎙'), h('div', null, h('strong', null, 'Antippen und sprechen.'), ' Wenn du fertig bist, nochmal tippen.')),
        h('li', null, h('span', { class: 'step-icon' }, '📜'), h('div', null, h('strong', null, 'Alle sehen den Text.'), ' Er erscheint sofort im gemeinsamen Protokoll.')),
        h('li', null, h('span', { class: 'step-icon' }, '✎'), h('div', null, h('strong', null, 'Fehler? Einfach korrigieren.'), ' Doppelt auf den Text tippen – oder auf den Namen, wenn es jemand anderes gesagt hat.')),
      ),
      h('button', { class: 'primary', onclick: () => (localStorage.setItem('ohrwurm.onboarded', '1'), card.remove()) }, 'Verstanden 👍'),
    );
    return card;
  }

  // ---------- Aufbau ----------
  async function init() {
    let stored = await kv.get<MeshSession>(`mesh:${sid}`);
    if (!stored) {
      if (!keyFromLink) {
        fill(app, hd.el, h('main', null, emptyState('Diese Sitzung kennt dein Gerät noch nicht', 'Bitte öffne den Einladungslink oder scanne den QR-Code.'), h('p', { class: 'center' }, h('a', { class: 'button', href: '#/' }, 'Zur Startseite'))));
        return;
      }
      const kp = await generateSigningKey();
      const signPub = await exportPublicKey(kp.publicKey);
      stored = { sid, key: keyFromLink, signKeyPair: kp, signPub, peer: await peerIdFor(signPub), joined: Date.now(), speaker: userName(), attested: {} };
      await kv.set(`mesh:${sid}`, stored);
    } else if (keyFromLink && keyFromLink !== stored.key) {
      fill(app, hd.el, h('main', null, h('div', { class: 'card error' }, 'Dieser Link enthält einen anderen Schlüssel als die gespeicherte Sitzung. Bitte den Link prüfen.')));
      return;
    }
    ms = stored;
    if (keyFromLink) history.replaceState(null, '', `#/s/${sid}`); // Schlüssel nicht in der Adresszeile stehen lassen
    const key = await importGroupKey(ms.key);

    mesh = new Mesh(relay, ms, key, () => ({ name: userName(), device: deviceLabel() }));
    cleanups.push(mesh.onChange(render));
    cleanups.push(() => mesh?.stop());
    await mesh.start();
    const newTitle = sessionStorage.getItem(`ohrwurm.newtitle.${sid}`);
    if (newTitle) {
      sessionStorage.removeItem(`ohrwurm.newtitle.${sid}`);
      await mesh.create({ type: 'title', title: newTitle });
    }

    const link = `${location.origin}/#/s/${sid}/${ms.key}`;
    const code = await keyCode(ms.key);
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 300, errorCorrectionLevel: 'H', color: { dark: '#1d2b26', light: '#ffffff' } });
    const linkInput = h('input', { type: 'text', readonly: true, value: link });
    fill(
      invite,
      h('div', { class: 'invite-grid' }, h('div', { class: 'qr-wrap' }, h('img', { class: 'qr', src: qr, alt: 'QR-Code zum Beitreten' }), logo('logo qr-logo')), h(
        'div',
        null,
        h('h3', null, 'Alle an Bord holen'),
        h('p', null, 'Mit der Handykamera scannen – fertig. Jedes Gerät, das beitritt, bekommt das ganze Protokoll und kann selbst weitere Leute einladen.'),
        h('div', { class: 'row' }, linkInput, h('button', { onclick: () => void navigator.clipboard?.writeText(link) }, 'Kopieren')),
        h('p', { class: 'small' }, 'Sicherheitscode ', h('strong', { class: 'mono' }, code), ' – alle Geräte zeigen denselben. Der Link ist der Schlüssel: nur im Raum zeigen, nicht öffentlich posten.'),
      )),
    );

    titleInput.addEventListener('change', () => void mesh?.create({ type: 'title', title: titleInput.value.trim() || 'Sitzung' }));
    speakerInput.value = ms.speaker;
    speakerInput.addEventListener('change', () => {
      ms.speaker = speakerInput.value.trim().slice(0, 64);
      void kv.set(`mesh:${sid}`, ms);
    });
    topInput.addEventListener('keydown', (e) => e.key === 'Enter' && void addTop());
    for (const el of [llmUrl, llmModel, llmKey]) el.addEventListener('change', saveLlm);
    glossary.value = localStorage.getItem(`ohrwurm.glossary.${sid}`) ?? '';
    glossary.addEventListener('change', () => localStorage.setItem(`ohrwurm.glossary.${sid}`, glossary.value));

    const toggle = (label: string, set: (v: boolean) => void) => {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        set(cb.checked);
        renderTranscript();
      });
      return h('label', { class: 'chip' }, cb, label);
    };

    fill(
      app,
      hd.el,
      h(
        'main',
        { class: 'wide' },
        banner,
        map.banner,
        h('section', { class: 'card session-head' }, h('div', { class: 'head-main' }, titleInput, pills), h('div', { class: 'row tight' }, inviteBtn, pauseBtn)),
        invite,
        onboarding(),
        h(
          'div',
          { class: 'cols' },
          h(
            'div',
            { class: 'col' },
            h('section', { class: 'card' }, h('h3', null, '🎙 Dein Mikro'), h('label', null, 'Wer spricht hier?', speakerInput, speakersList), h('p', { class: 'small muted' }, 'Am Tischgerät einfach vor dem Beitrag den Namen wechseln. Falsch zugeordnet? Im Protokoll auf den Namen tippen.')),
            panel.el,
            h('section', { class: 'card members-card' }, h('h3', null, '👥 Wer ist dabei?'), membersEl),
          ),
          h(
            'div',
            { class: 'col' },
            map.el,
            h(
              'section',
              { class: 'card' },
              h('h3', null, '📜 Gemeinsames Protokoll'),
              h('p', { class: 'small muted' }, 'Alle dürfen mithelfen: Doppelklick korrigiert den Text, ein Klick auf den Namen ordnet den Beitrag jemand anderem zu, ⚑ markiert Stellen zum Prüfen.'),
              h('div', { class: 'row' }, topInput, h('button', { onclick: () => void addTop() }, '➕ TOP beginnen')),
              h('div', { class: 'chips' }, toggle('Doppelungen', (v) => (showDups = v)), toggle('Ausgeblendete', (v) => (showHidden = v)), toggle('Nur markierte ⚑', (v) => (onlyFlagged = v))),
              transcriptEl,
            ),
            h('section', { class: 'card' }, h('h3', null, '📌 Zusammenfassungen'), summariesEl),
            h(
              'details',
              { class: 'card fold assistant' },
              h('summary', null, h('span', { class: 'fold-title' }, '🤖 KI-Helfer'), h('span', { class: 'small muted' }, ' – fasst zusammen und schlägt Korrekturen vor (optional)')),
              h('p', { class: 'small muted' }, 'Nutzt ein KI-Modell auf deinem Rechner (z. B. Ollama) oder im Firmennetz. Was dabei herauskommt, siehst erst nur du – teilen ist ein Klick.'),
              h('div', { class: 'row' }, sumBtn, corBtn, h('span', { class: 'small muted' }, 'für'), scopeSel),
              llmStatus,
              assistantOut,
              h('label', null, 'Namen & Fachbegriffe (hilft bei Korrekturen)', glossary),
              h(
                'details',
                { class: 'settings' },
                h('summary', null, '⚙️ Verbindung zum KI-Modell'),
                h('div', { class: 'grid' }, h('label', null, 'Adresse', llmUrl), h('label', null, 'Modell', llmModel, llmModels), h('label', null, 'Schlüssel (falls nötig)', llmKey)),
                h('button', { class: 'link', onclick: () => void fetchModels() }, 'Verfügbare Modelle abrufen'),
              ),
            ),
            h(
              'section',
              { class: 'card' },
              h('h3', null, '📦 Protokoll mitnehmen'),
              h('p', { class: 'small muted' }, 'Jederzeit, auf jedem Gerät – immer mit allen Korrekturen.'),
              h('div', { class: 'row' }, h('button', { class: 'primary big', onclick: () => void exportFile('pdf') }, '📄 Protokoll als PDF'), h('button', { onclick: () => void exportFile('md') }, 'Als Text (Markdown)')),
              h(
                'details',
                { class: 'settings' },
                h('summary', null, 'Mehr'),
                h('div', { class: 'row' }, h('button', { onclick: () => void exportFile('json') }, 'Alle Rohdaten (JSON, signiert)'), confirmButton('Kopie auf diesem Gerät löschen', 'Wirklich löschen?', () => {
                  mesh?.stop();
                  void deleteSessionData(sid).then(() => (location.hash = '#/'));
                })),
              ),
            ),
          ),
        ),
        privacyNote(),
      ),
    );
    renderAssistantStatus();
    render();
  }

  void init();
  return () => {
    busy?.abort();
    cleanups.forEach((f) => f());
  };
}
