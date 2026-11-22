// Raumplan: „Wo bin ich?“ – alle Geräte, die mitmachen, messen sich per
// Ultraschall gegenseitig ein. Die Karte zeigt, wer wo sitzt; ein Klick auf eine
// Person ordnet ihr einen Beitrag zu. Plätze lassen sich von allen verschieben.
import { initials, personColor } from './layout';
import { QUORUM, VOTE_WINDOW_MS, mapPoints, phaseOf, type LocRound, type Phase } from './locate/model';
import { CalibrationError, Calibrator, NeedsGesture } from './locate/run';
import { planEnd } from './locate/solve';
import type { Mesh } from './mesh';
import { randomB64u } from './crypto';
import { memberName, type SessionView } from './state';
import { fill, h } from './ui';
import { wormOverlay } from './worm';

const SVG = 'http://www.w3.org/2000/svg';

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined> = {}, ...kids: (Node | string | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

export interface AssignTarget {
  seg: string;
  text: string;
}

export interface RoomMap {
  el: HTMLElement;
  banner: HTMLElement;
  update(view: SessionView): void;
  /** Grund, das Mikro zu sperren (während des Einmessens), sonst null */
  blockReason(): string | null;
  startAssign(t: AssignTarget): void;
  dispose(): void;
}

export function roomMap(opts: {
  now: () => number;
  mesh: () => Mesh | undefined;
  onAssign: (seg: string, peer: string) => void;
  /** Phase hat gewechselt → Sitzung neu zeichnen (Mikro-Sperre) */
  onPhase: () => void;
  /** Wer hat zuletzt gesprochen (für die Hervorhebung)? */
  lastSpeaker: () => string | null;
}): RoomMap {
  let view: SessionView | undefined;
  let assign: AssignTarget | null = null;
  let placing: string | null = null;
  let dragging = false;
  let lastPhase = '';
  const cal = new Calibrator(opts.now);
  /** Runden, an denen dieses Gerät teilnehmen will (Audio vorbereitet) */
  const wanted = new Set<string>();
  const started = new Set<string>();
  /** Runden, für die schon automatisch versucht wurde, Audio zu öffnen */
  const autoTried = new Set<string>();
  let progress: { id: string; f: number; msg: string } | null = null;
  let preparedAt = 0;
  const worm = wormOverlay();
  let wormFor: string | null = null;
  let error = '';

  const banner = h('div', { class: 'loc-banner', hidden: true });
  const status = h('div', { class: 'small' });
  const hint = h('div', { class: 'loc-hint', hidden: true });
  const svgWrap = h('div', { class: 'loc-map' });
  const tray = h('div', { class: 'loc-tray' });
  const reqBtn = h('button', { class: 'primary', onclick: () => void request() }, '📍 Wo bin ich?');
  const rotBtn = h('button', { class: 'small', title: 'Karte um 90° drehen', onclick: () => setView(1, false) }, '⟳ Drehen');
  const flipBtn = h('button', { class: 'small', title: 'Karte spiegeln', onclick: () => setView(0, true) }, '⇋ Spiegeln');

  const el = h(
    'section',
    { class: 'card roommap' },
    h('h3', null, '🗺 Raumplan'),
    h(
      'p',
      { class: 'small muted' },
      `Tippe auf „Wo bin ich?“. Sobald ${QUORUM} Geräte getippt haben, startet das Einmessen für alle: Handys flach hinlegen, kurz still sein – die Geräte finden sich per fast unhörbarem Ton gegenseitig. Danach einen Beitrag auswählen (📍) und auf die Person tippen.`,
    ),
    h('div', { class: 'row tight' }, reqBtn, rotBtn, flipBtn),
    status,
    hint,
    svgWrap,
    tray,
  );

  const me = () => opts.mesh()?.me ?? '';
  const latest = (): LocRound | undefined => view?.loc.rounds[view.loc.rounds.length - 1];

  // ---------- Ablauf ----------

  async function prepare(quiet = false): Promise<boolean> {
    error = '';
    try {
      if (!cal.ready) preparedAt = opts.now();
      await cal.prepare();
      return true;
    } catch (e) {
      if (quiet && e instanceof NeedsGesture) return false;
      error = e instanceof CalibrationError ? e.message : `Mikrofon/Lautsprecher nicht verfügbar (${(e as Error).message})`;
      renderStatus();
      return false;
    }
  }

  const openVotes = () => (view?.loc.votes ?? []).filter((v) => opts.now() - v.t < VOTE_WINDOW_MS);
  const iVoted = () => openVotes().some((v) => v.peer === me());

  /** „Wo bin ich?“ = Stimme. Ab QUORUM Stimmen (oder sofort) startet es für alle. */
  async function request(force = false) {
    const mesh = opts.mesh();
    if (!mesh || active() || (iVoted() && !force)) return;
    // Mikrofon-Freigabe jetzt holen, solange die Geste frisch ist.
    if (!(await prepare())) return;
    await mesh.create({ type: 'locate', id: randomB64u(9), force: force || undefined });
  }

  async function join(r: LocRound) {
    const mesh = opts.mesh();
    if (!mesh || opts.now() > r.cutoff) return;
    if (!(await prepare())) return;
    wanted.add(r.id);
    if (!r.plan.peers.includes(me())) await mesh.create({ type: 'locjoin', id: r.id });
    renderBanner();
  }

  function setView(rot: number, flip: boolean) {
    const mesh = opts.mesh();
    if (!mesh || !view) return;
    const v = view.loc.view;
    void mesh.create({ type: 'locview', rot: (v.rot + rot) % 4, flip: flip ? !v.flip : v.flip });
  }

  const active = () => {
    const r = latest();
    return r ? phaseOf(r, opts.now()) !== 'done' : false;
  };

  async function runRound(r: LocRound) {
    const mesh = opts.mesh();
    if (!mesh) return;
    started.add(r.id);
    const idx = r.plan.peers.indexOf(me());
    progress = { id: r.id, f: 0, msg: 'Gleich geht’s los …' };
    try {
      const res = await cal.run(r.plan, idx, (f, msg) => {
        progress = { id: r.id, f, msg };
        renderBanner();
      });
      await mesh.create({ type: 'locmeas', id: r.id, peers: r.plan.peers, fs: res.fs, p: res.p, q: res.q });
      const heard = res.p.filter((x) => x >= 0).length - r.plan.emissions.filter((e) => e.idx === idx).length;
      progress = { id: r.id, f: 1, msg: heard > 0 ? `Fertig – ${heard} Töne anderer Geräte gehört.` : 'Fertig – leider keine anderen Geräte gehört.' };
    } catch (e) {
      error = `Einmessen fehlgeschlagen: ${(e as Error).message}`;
      progress = null;
    } finally {
      await cal.dispose();
      renderStatus();
      renderBanner();
    }
  }

  /** Wird regelmäßig aufgerufen: Zeitpunkte des Ablaufs auslösen. */
  function tick() {
    const r = latest();
    const now = opts.now();
    const phase: Phase | 'none' = r ? phaseOf(r, now) : 'none';
    if (r) {
      const inPlan = r.plan.peers.includes(me());
      // Wer abgestimmt hat, ist automatisch dabei – Audio ohne neue Geste öffnen,
      // wenn der Browser das erlaubt; sonst zeigt das Banner „Mitmachen“.
      if (phase === 'join' && inPlan && !wanted.has(r.id) && !autoTried.has(r.id)) {
        autoTried.add(r.id);
        void prepare(true).then((ok) => {
          if (ok) wanted.add(r.id);
          renderBanner();
        });
      }
      if (inPlan && wanted.has(r.id) && !started.has(r.id) && now >= r.at - 500 && now < r.plan.start - 200) void runRound(r);
    }
    // Audio wieder freigeben, wenn es nicht (mehr) gebraucht wird: zu spät, nicht
    // in der Teilnehmerliste gelandet oder die eigene Anfrage kam nie an.
    if (cal.ready && !(r && started.has(r.id))) {
      const inPlan = !!r && r.plan.peers.includes(me());
      const stale = !r || !wanted.has(r.id) ? now - preparedAt > 8_000 : phase !== 'join' || (now > r.cutoff + 1_500 && !inPlan);
      if (stale) void cal.dispose();
    }
    // Wurmi-Overlay: auf allen Geräten, solange Töne gesendet werden
    if (r && phase === 'run' && wormFor !== r.id) {
      wormFor = r.id;
      const n = r.plan.peers.length;
      worm.show(
        r.id,
        () => (opts.now() - r.plan.start) / (planEnd(r.plan) - r.plan.start),
        () => (r.plan.peers.includes(me()) && wanted.has(r.id) ? `Dein Gerät hört mit – zusammen mit ${n - 1} weiteren.` : `${n} Geräte hören gerade mit.`),
      );
    } else if (wormFor && (!r || r.id !== wormFor || phase !== 'run') && worm.visible) {
      worm.finish();
    }
    const key = `${r?.id}:${phase}`;
    if (key !== lastPhase) {
      lastPhase = key;
      renderMap();
      opts.onPhase();
    }
    renderBanner();
  }
  const timer = window.setInterval(tick, 250);

  // ---------- Darstellung ----------

  function renderStatus() {
    const r = latest();
    const bits: (string | HTMLElement)[] = [];
    if (error) bits.push(h('div', { class: 'bad' }, error));
    if (r && phaseOf(r, opts.now()) === 'done') {
      const { points } = mapPoints(view!.loc);
      const measured = points.filter((p) => p.source === 'measured').length;
      bits.push(
        h(
          'div',
          { class: 'muted' },
          `Letztes Einmessen: ${r.plan.peers.length} Geräte, ${r.meas.length} Messungen, ${measured} verortet.`,
          measured < r.plan.peers.length ? ' Wer fehlt, kann sich unten antippen und auf der Karte platzieren.' : '',
        ),
      );
    }
    fill(status, bits);
    reqBtn.disabled = active() || iVoted();
    reqBtn.textContent = iVoted() ? `📍 Wo bin ich? (${openVotes().length}/${QUORUM})` : '📍 Wo bin ich?';
  }

  function renderBanner() {
    const r = latest();
    const now = opts.now();
    if (!view) {
      banner.hidden = true;
      return;
    }
    const votes = openVotes();
    if ((!r || phaseOf(r, now) === 'done') && votes.length && !(progress?.id === r?.id && r && now < r.end + 6_000)) {
      const names = votes.map((v) => memberName(view!, v.peer)).join(', ');
      banner.hidden = false;
      fill(
        banner,
        h(
          'div',
          { class: 'card loc-card' },
          h('strong', null, `📍 Wo bin ich? – ${votes.length} von ${QUORUM} möchten den Raumplan einmessen`),
          h('div', { class: 'small' }, `${names}. Sobald ${QUORUM} Geräte getippt haben, geht es für alle los.`),
          h(
            'div',
            { class: 'row tight' },
            iVoted() ? h('span', { class: 'ok' }, '✓ Deine Stimme zählt.') : h('button', { class: 'primary big', onclick: () => void request() }, '🙋 Ich auch'),
            h('button', { class: 'small', title: 'Nicht warten – das Einmessen startet gleich für alle', onclick: () => void request(true) }, '⏩ Sofort für alle starten'),
          ),
        ),
      );
      return;
    }
    if (!r) {
      banner.hidden = true;
      return;
    }
    const phase = phaseOf(r, now);
    const inPlan = r.plan.peers.includes(me());
    const mine = wanted.has(r.id) && inPlan;
    let body: (string | HTMLElement)[] = [];
    if (phase === 'join') {
      const left = Math.max(0, Math.ceil((r.at - now) / 1000));
      const canJoin = now < r.cutoff && !wanted.has(r.id);
      body = [
        h('strong', null, `📍 Wo bin ich? – Einmessen startet in ${left} s`),
        h('div', { class: 'small' }, `Es geht für alle los! ${r.plan.peers.length} Geräte machen mit. Je mehr mitmachen, desto genauer wird der Raumplan.`),
        canJoin
          ? h('button', { class: 'primary big', onclick: () => void join(r) }, '🙋 Mitmachen')
          : mine
            ? h('div', { class: 'ok' }, '✓ Du bist dabei. Leg das Handy flach vor dich, Lautstärke hoch, nicht verdecken.')
            : wanted.has(r.id)
              ? h('div', { class: 'warn' }, 'Wird übertragen …')
              : h('div', { class: 'muted small' }, 'Beitritt geschlossen – du kannst dich danach von Hand platzieren.'),
      ];
    } else if (phase === 'run' || phase === 'analyze') {
      const f = progress?.id === r.id ? progress.f : Math.min(1, (now - r.plan.start) / (planEnd(r.plan) - r.plan.start));
      body = [
        h('strong', null, phase === 'run' ? '🔊 Einmessen läuft – bitte kurz still sein' : '🧮 Raumplan wird berechnet …'),
        h('div', { class: 'prep' }, h('div', { class: 'prep-bar', style: `width:${Math.round(Math.max(0, f) * 100)}%` })),
        h('div', { class: 'small muted' }, mine ? (progress?.id === r.id ? progress.msg : '') : 'Dieses Gerät hört diesmal nicht mit.', ` · ${r.meas.length}/${r.plan.peers.length} Messungen da`),
      ];
    } else if (progress?.id === r.id && now < r.end + 6_000) {
      body = [h('strong', null, '✓ Einmessen abgeschlossen'), h('div', { class: 'small' }, progress.msg)];
    } else {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    fill(banner, h('div', { class: 'card loc-card' }, body));
  }

  type Pt = { x: number; y: number };
  function tf(p: Pt): Pt {
    const v = view!.loc.view;
    let { x, y } = p;
    if (v.flip) x = -x;
    for (let i = 0; i < v.rot; i++) [x, y] = [-y, x];
    return { x, y };
  }
  function inv(p: Pt): Pt {
    const v = view!.loc.view;
    let { x, y } = p;
    for (let i = 0; i < v.rot; i++) [x, y] = [y, -x];
    if (v.flip) x = -x;
    return { x, y };
  }

  function svgPoint(svg: SVGSVGElement, e: MouseEvent): Pt {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  function renderHint() {
    if (assign) {
      fill(hint, h('span', null, '👉 Wer hat das gesagt? Tippe auf die Person: ', h('em', null, `„${assign.text.slice(0, 80)}${assign.text.length > 80 ? '…' : ''}“`)), h('button', { class: 'small', onclick: () => ((assign = null), renderMap()) }, 'Abbrechen'));
      hint.hidden = false;
    } else if (placing && view) {
      fill(hint, h('span', null, `👉 Tippe auf der Karte auf den Platz von ${memberName(view, placing)}.`), h('button', { class: 'small', onclick: () => ((placing = null), renderMap()) }, 'Abbrechen'));
      hint.hidden = false;
    } else hint.hidden = true;
  }

  function renderMap() {
    if (!view || dragging) return;
    const v = view;
    renderHint();
    renderStatus();
    const { points, round } = mapPoints(v.loc);
    const online = new Set(v.members.filter((m) => m.online || m.peer === me()).map((m) => m.peer));
    const shown = points.map((p) => ({ ...p, ...tf(p) }));
    const placed = new Set(points.map((p) => p.peer));
    const front = round?.by;
    const speaking = opts.lastSpeaker();

    // Wer noch keinen Platz hat
    const missing = v.members.filter((m) => !placed.has(m.peer) && (m.online || m.segs > 0));
    fill(
      tray,
      missing.length
        ? [
            h('span', { class: 'small muted' }, shown.length ? 'Ohne Platz: ' : 'Noch niemand auf der Karte. '),
            missing.map((m) => {
              const name = memberName(v, m.peer);
              return h(
                'button',
                {
                  class: `who${placing === m.peer ? ' on' : ''}`,
                  style: `--c:${personColor(name)}`,
                  title: assign ? `${name} zuordnen` : `${name} auf der Karte platzieren`,
                  onclick: () => {
                    if (assign) {
                      opts.onAssign(assign.seg, m.peer);
                      assign = null;
                    } else placing = placing === m.peer ? null : m.peer;
                    renderMap();
                  },
                },
                h('span', { class: 'avatar sm', style: `background:${personColor(name)}` }, initials(name)),
                h('span', { class: 'who-name' }, m.peer === me() ? `${name} (du)` : name),
              );
            }),
          ]
        : null,
    );

    if (!shown.length && !placing) {
      fill(svgWrap);
      svgWrap.hidden = true;
      return;
    }
    svgWrap.hidden = false;
    const xs = shown.map((p) => p.x);
    const ys = shown.map((p) => p.y);
    let [x0, x1, y0, y1] = xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [-2, 2, -1.5, 1.5];
    const pad = 0.9;
    const minW = 4;
    const minH = 3;
    if (x1 - x0 < minW) [x0, x1] = [(x0 + x1) / 2 - minW / 2, (x0 + x1) / 2 + minW / 2];
    if (y1 - y0 < minH) [y0, y1] = [(y0 + y1) / 2 - minH / 2, (y0 + y1) / 2 + minH / 2];
    x0 -= pad;
    y0 -= pad;
    x1 += pad;
    y1 += pad;
    const dense = shown.length > 30;
    const r = dense ? 0.24 : 0.32;

    const svg = s('svg', { viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}`, class: `loc-svg${assign ? ' assigning' : ''}${placing ? ' placing' : ''}`, role: 'img', 'aria-label': 'Raumplan' });
    // 1-m-Raster als Maßstab
    const grid = s('g', { class: 'loc-grid' });
    for (let gx = Math.ceil(x0); gx <= x1; gx++) grid.append(s('line', { x1: gx, x2: gx, y1: y0, y2: y1 }));
    for (let gy = Math.ceil(y0); gy <= y1; gy++) grid.append(s('line', { x1: x0, x2: x1, y1: gy, y2: gy }));
    svg.append(s('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: 'loc-bg' }), grid);
    svg.append(s('text', { x: x1 - 0.15, y: y1 - 0.15, class: 'loc-scale', 'text-anchor': 'end' }, 'Raster: 1 m'));

    svg.addEventListener('click', (e) => {
      if (!placing || (e.target as Element).closest('.loc-dot')) return;
      const p = inv(svgPoint(svg, e));
      const peer = placing;
      placing = null;
      void opts.mesh()?.create({ type: 'seat', peer, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
    });

    for (const p of shown) {
      const name = memberName(v, p.peer);
      const cls = ['loc-dot', p.peer === me() ? 'me' : '', p.sure ? '' : 'unsure', online.has(p.peer) ? '' : 'offline', name === speaking ? 'speaking' : '', p.source === 'manual' ? 'manual' : ''].filter(Boolean).join(' ');
      const g = s(
        'g',
        { class: cls, transform: `translate(${p.x} ${p.y})`, tabindex: 0, 'data-peer': p.peer, 'data-name': name },
        s('title', {}, `${name}${p.peer === me() ? ' (du)' : ''}${p.peer === front ? ' · hat eingemessen (vorne)' : ''}${p.source === 'manual' ? ' · von Hand gesetzt' : p.sure ? '' : ' · Position unsicher'}`),
        s('circle', { r: r + 0.08, class: 'ring' }),
        s('circle', { r, fill: personColor(name) }),
        s('text', { class: 'ini', 'font-size': r * 0.8, dy: r * 0.28 }, initials(name)),
        dense ? null : s('text', { class: 'name', y: r + 0.28, 'font-size': 0.2 }, p.peer === me() ? `${name} (du)` : name),
        p.peer === front ? s('text', { class: 'front', y: -r - 0.1, 'font-size': 0.26 }, '🖥') : null,
      );
      // Ziehen verschiebt den Platz (für alle), Tippen ordnet zu.
      let start: Pt | null = null;
      let moved = false;
      g.addEventListener('pointerdown', (e) => {
        if (assign) return;
        start = svgPoint(svg, e);
        moved = false;
        dragging = true;
        g.setPointerCapture(e.pointerId);
      });
      g.addEventListener('pointermove', (e) => {
        if (!start) return;
        const q = svgPoint(svg, e);
        if (Math.hypot(q.x - start.x, q.y - start.y) > 0.1) moved = true;
        if (moved) g.setAttribute('transform', `translate(${q.x} ${q.y})`);
      });
      const end = (e: PointerEvent, cancel: boolean) => {
        if (!start) return;
        const q = svgPoint(svg, e);
        start = null;
        dragging = false;
        if (moved && !cancel) {
          const w = inv(q);
          void opts.mesh()?.create({ type: 'seat', peer: p.peer, x: Math.round(w.x * 100) / 100, y: Math.round(w.y * 100) / 100 });
        } else renderMap();
      };
      g.addEventListener('pointerup', (e) => end(e, false));
      g.addEventListener('pointercancel', (e) => end(e, true));
      g.addEventListener('click', () => {
        if (assign) {
          opts.onAssign(assign.seg, p.peer);
          assign = null;
          renderMap();
        }
      });
      g.addEventListener('keydown', (e) => {
        if (assign && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          opts.onAssign(assign.seg, p.peer);
          assign = null;
          renderMap();
        }
      });
      svg.append(g);
    }
    fill(svgWrap, svg);
    const reset = points.filter((p) => p.source === 'manual');
    if (reset.length && round) {
      svgWrap.append(
        h('button', { class: 'link small', onclick: () => reset.forEach((p) => void opts.mesh()?.create({ type: 'seat', peer: p.peer, x: null, y: null })) }, `${reset.length} von Hand gesetzte Plätze auf die Messung zurücksetzen`),
      );
    }
  }

  return {
    el,
    banner,
    update(v) {
      view = v;
      renderMap();
      renderBanner();
    },
    blockReason() {
      const r = latest();
      if (!r) return null;
      const phase = phaseOf(r, opts.now());
      if (phase === 'run') return '🗺 Einmessen läuft …';
      if (phase === 'join' && wanted.has(r.id)) return '🗺 Gleich wird eingemessen …';
      return null;
    },
    startAssign(t) {
      assign = t;
      placing = null;
      renderMap();
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    dispose() {
      clearInterval(timer);
      worm.hide();
      void cal.dispose();
    },
  };
}

