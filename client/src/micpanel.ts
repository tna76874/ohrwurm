// Gesprächsbutton + Spracherkennungs-Einstellungen, gemeinsam für Host und Teilnehmer.
import { cleanText, loadAsrSettings, saveAsrSettings, transcriber, type AsrSettings } from './asr';
import { Mic } from './audio';
import { appConfig } from './auth';
import { fill, h } from './ui';

export interface Spoken {
  t0: number;
  t1: number;
  rms: number;
  text: string;
}

export interface MicPanel {
  el: HTMLElement;
  /** null = erlaubt, sonst Grund für die Sperre (Mikrofon wird gestoppt). */
  setBlocked(reason: string | null): void;
  asrLabel(): string;
  dispose(): void;
}

type Mode = 'toggle' | 'hold';

export function micPanel(opts: { now: () => number; onSpoken: (s: Spoken) => void }): MicPanel {
  const models = appConfig().models;
  const settings: AsrSettings = loadAsrSettings(models);
  let mode: Mode = (localStorage.getItem('ohrwurm.micmode') as Mode) || 'toggle';
  let blocked: string | null = null;
  let stopAfterStart = false;
  let lastError = '';

  const mic = new Mic(opts.now);
  const button = h('button', { class: 'mic', type: 'button' });
  const level = h('div', { class: 'level-bar' });
  const status = h('div', { class: 'small muted' });
  const asrStatus = h('div', { class: 'small' });

  const modelSel = h(
    'select',
    { onchange: () => apply({ model: modelSel.value }) },
    models.map((m) => h('option', { value: m, selected: m === settings.model }, m.split('/').pop())),
  );
  const devSel = h(
    'select',
    { onchange: () => apply({ device: devSel.value as AsrSettings['device'] }) },
    [
      ['auto', 'automatisch'],
      ['webgpu', 'WebGPU'],
      ['wasm', 'WASM (CPU)'],
    ].map(([v, l]) => h('option', { value: v, selected: v === settings.device }, l)),
  );
  const langSel = h(
    'select',
    { onchange: () => apply({ language: langSel.value }) },
    [
      ['de', 'Deutsch'],
      ['en', 'Englisch'],
      ['auto', 'automatisch'],
    ].map(([v, l]) => h('option', { value: v, selected: v === settings.language }, l)),
  );
  const modeSel = h(
    'select',
    {
      onchange: () => {
        mode = modeSel.value as Mode;
        localStorage.setItem('ohrwurm.micmode', mode);
        void mic.stop('mode');
        render();
      },
    },
    h('option', { value: 'toggle', selected: mode === 'toggle' }, 'Antippen = an/aus'),
    h('option', { value: 'hold', selected: mode === 'hold' }, 'Gedrückt halten'),
  );

  function apply(p: Partial<AsrSettings>) {
    Object.assign(settings, p);
    saveAsrSettings(settings);
    transcriber.load(settings);
  }

  async function start() {
    if (blocked || mic.state !== 'off') return;
    lastError = '';
    stopAfterStart = false;
    try {
      await mic.start();
      if (stopAfterStart) await mic.stop('released');
    } catch (e) {
      lastError = `Das Mikro lässt sich nicht einschalten – bitte im Browser den Mikrofon-Zugriff erlauben. (${(e as Error).message})`;
      render();
    }
  }
  function stop(reason: string) {
    if (mic.state === 'starting') stopAfterStart = true;
    void mic.stop(reason);
  }

  button.addEventListener('click', () => {
    if (mode !== 'toggle') return;
    if (mic.state === 'off') void start();
    else stop('user');
  });
  button.addEventListener('pointerdown', (e) => {
    if (mode !== 'hold') return;
    button.setPointerCapture(e.pointerId);
    void start();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(ev, () => {
      if (mode === 'hold') stop('released');
    });
  }
  button.addEventListener('contextmenu', (e) => e.preventDefault());

  const onKey = (e: KeyboardEvent) => {
    if (mode !== 'hold' || e.code !== 'Space' || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    e.preventDefault();
    if (e.type === 'keydown') void start();
    else stop('released');
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  mic.onState = (s, reason) => {
    if (s === 'off') {
      level.style.width = '0';
      level.classList.remove('speech');
    }
    if (reason === 'auto') lastError = 'Nach einer Weile Stille hat sich das Mikro von selbst ausgeschaltet.';
    render();
  };
  mic.onLevel = (rms, speech) => {
    level.style.width = `${Math.min(100, Math.sqrt(rms) * 220)}%`;
    level.classList.toggle('speech', speech);
  };
  mic.onUtterance = (u) => {
    transcriber
      .transcribe(u.audio)
      .then((raw) => {
        const text = cleanText(raw);
        if (text) opts.onSpoken({ t0: u.t0, t1: u.t1, rms: u.rms, text });
      })
      .catch((e: Error) => {
        lastError = `Ein Satz konnte nicht erkannt werden. (${e.message})`;
        render();
      });
  };

  const offAsr = transcriber.onState(() => render());

  function render() {
    const s = transcriber.state;
    const noModel = models.length === 0;
    const asrReady = s.phase === 'ready' || s.phase === 'loading';
    button.disabled = !!blocked || noModel || !asrReady;
    button.classList.toggle('on', mic.state !== 'off');
    if (blocked) button.textContent = blocked;
    else if (mic.state === 'on') button.textContent = mode === 'hold' ? '● Ich höre zu … loslassen = fertig' : '● Ich höre zu … nochmal tippen = fertig';
    else if (mic.state === 'starting') button.textContent = 'Einen Moment …';
    else if (s.phase === 'loading') button.textContent = '⏳ Wird vorbereitet …';
    else button.textContent = mode === 'hold' ? '🎙 Gedrückt halten und sprechen' : '🎙 Antippen und sprechen';

    if (noModel) fill(asrStatus, h('span', { class: 'bad' }, 'Die Spracherkennung ist auf dem Server noch nicht eingerichtet (Admin: make models).'));
    else if (s.phase === 'loading') {
      const pct = Math.round((s.progress ?? 0) * 100);
      fill(asrStatus, h('div', { class: 'prep' }, h('div', { class: 'prep-bar', style: `width:${pct}%` })), `Einmalige Vorbereitung der Spracherkennung … ${pct} %`, s.message ? ` · ${s.message}` : '');
    } else if (s.phase === 'ready') fill(asrStatus, h('span', { class: 'ok', title: `${s.model} · ${s.device?.toUpperCase()}` }, '✓ Bereit zum Mitschreiben'), s.queue ? ` · schreibe mit (${s.queue}) …` : '');
    else if (s.phase === 'error') fill(asrStatus, h('span', { class: 'bad' }, `Die Spracherkennung hat ein Problem – bitte die Seite neu laden. (${s.message})`));
    else fill(asrStatus, '');

    fill(
      status,
      mic.state === 'off'
        ? '🤫 Das Mikro ist aus – es wird nichts aufgenommen.'
        : 'Der Ton bleibt auf diesem Gerät. Geteilt wird nur der erkannte Text.',
      lastError ? h('div', { class: 'warn' }, lastError) : null,
    );
  }

  transcriber.load(settings);
  render();

  const el = h(
    'section',
    { class: 'card micpanel' },
    button,
    h('div', { class: 'level' }, level),
    status,
    asrStatus,
    h(
      'details',
      { class: 'settings' },
      h('summary', null, '⚙️ Technik-Einstellungen (meist nicht nötig)'),
      h('div', { class: 'grid' }, h('label', null, 'Knopf', modeSel), h('label', null, 'Sprache', langSel), h('label', null, 'Erkennungsmodell', modelSel), h('label', null, 'Rechnen mit', devSel)),
    ),
  );

  return {
    el,
    setBlocked(reason) {
      blocked = reason;
      if (reason) stop('blocked');
      render();
    },
    asrLabel: () => `${(transcriber.state.model ?? '').split('/').pop()}/${transcriber.state.device ?? '?'}`,
    dispose() {
      void mic.stop('dispose');
      offAsr();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    },
  };
}
