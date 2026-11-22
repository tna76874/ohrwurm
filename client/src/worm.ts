// Overlay während „Wo bin ich?“: Wurmi kriecht über den Bildschirm und erreicht
// genau dann seinen Apfel, wenn das Einmessen vorbei ist. Der Fortschritt kommt
// aus der gemeinsamen Mesh-Zeit – auf allen Bildschirmen kriecht er im Gleichtakt.
import { h } from './ui';

const SVG = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 620;
const SEGMENTS = 16;
const SPACING = 15;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Deterministischer Zufall aus einem Text (alle Geräte: gleicher Weg). */
function rng(seed: string) {
  let x = 2166136261;
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100_000) / 100_000;
  };
}

/** Schlängelweg durch mehrere Wegpunkte (Catmull-Rom → kubische Bézier). */
function wanderPath(seed: string): { d: string; apple: [number, number] } {
  const r = rng(seed);
  const pts: [number, number][] = [[90, H - 120]];
  const n = 6;
  for (let i = 1; i < n; i++) pts.push([90 + (i / n) * (W - 260) + (r() - 0.5) * 120, 110 + r() * (H - 260)]);
  const apple: [number, number] = [W - 150, 170 + r() * (H - 340)];
  pts.push(apple);
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return { d, apple };
}

export interface WormOverlay {
  /** Zeigt das Overlay; `progress` liefert 0…1, `sub` eine Zusatzzeile. */
  show(seed: string, progress: () => number, sub: () => string): void;
  /** Wurmi hat den Apfel: kurz feiern, dann ausblenden. */
  finish(): void;
  hide(): void;
  readonly visible: boolean;
}

export function wormOverlay(): WormOverlay {
  let el: HTMLElement | null = null;
  let raf = 0;
  let hideTimer = 0;
  let done = false;
  let finishFn: (() => void) | null = null;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function hide() {
    cancelAnimationFrame(raf);
    clearTimeout(hideTimer);
    el?.remove();
    el = null;
    finishFn = null;
    document.body.classList.remove('worm-open');
  }

  function show(seed: string, progress: () => number, sub: () => string) {
    hide();
    done = false;
    const { d, apple } = wanderPath(seed);
    const stage = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'worm-stage', 'aria-hidden': 'true' });
    const trail = svg('path', { d, class: 'worm-trail' });
    const path = svg('path', { d, fill: 'none', stroke: 'none' });
    stage.append(trail, path);

    // Apfel
    const appleG = svg('g', { class: 'worm-apple', transform: `translate(${apple[0]} ${apple[1]})` });
    appleG.append(
      svg('path', { d: 'M0 -26c-14-10-40-6-40 20 0 22 18 40 30 40 5 0 7-3 10-3s5 3 10 3c12 0 30-18 30-40 0-26-26-30-40-20z', class: 'apple-body' }),
      svg('path', { d: 'M0 -26c0-8 2-14 6-18', class: 'apple-stem' }),
      svg('path', { d: 'M4 -34c8-12 22-12 26-6-8 8-18 9-26 6z', class: 'apple-leaf' }),
      svg('circle', { cx: 30, cy: -2, r: 12, class: 'apple-bite' }),
      svg('ellipse', { cx: -18, cy: -8, rx: 6, ry: 10, class: 'apple-shine' }),
    );
    stage.append(appleG);

    // Wurmi: Segmente vom Schwanz zum Kopf
    const body = svg('g', { class: 'worm-body' });
    const segs: SVGCircleElement[] = [];
    for (let i = SEGMENTS - 1; i >= 0; i--) {
      const r = 15 - (i / SEGMENTS) * 7;
      const c = svg('circle', { r, class: i % 2 ? 'seg alt' : 'seg' });
      segs[i] = c;
      body.append(c);
    }
    const head = svg('g', { class: 'worm-head' });
    head.append(
      svg('circle', { r: 19, class: 'seg head' }),
      svg('circle', { cx: 5, cy: -6, r: 6.5, class: 'eye' }),
      svg('circle', { cx: 6.5, cy: -5, r: 3.2, class: 'pupil' }),
      svg('circle', { cx: 10, cy: 7, r: 3.6, class: 'cheek' }),
      svg('path', { d: 'M2 8q5 5 11 1', class: 'mouth' }),
    );
    body.append(head);
    stage.append(body);

    const subEl = h('p', { class: 'worm-sub' });
    const title = h('h2', null, 'Pssst, bitte ganz leise sein …');
    const text = h('p', { class: 'worm-text' }, 'sonst findet Wurmi seinen Apfel nicht. 🍎');
    el = h(
      'div',
      { class: 'worm-overlay', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'worm-msg' }, title, text, subEl),
      stage,
      h('button', { class: 'worm-close link small', onclick: hide, title: 'Nur auf diesem Gerät ausblenden – das Einmessen läuft weiter' }, 'Ausblenden'),
    );
    document.body.append(el);
    document.body.classList.add('worm-open');

    const len = path.getTotalLength();
    const at = (l: number) => path.getPointAtLength(Math.max(0, Math.min(len, l)));
    let lastSub = '';
    const frame = (ts: number) => {
      const f = done ? 1 : Math.max(0, Math.min(1, progress()));
      // Kopf endet kurz vor dem Apfel, damit er hineinbeißen kann.
      const headL = (len - 34) * f;
      const t = still ? 0 : ts / 1000;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= SEGMENTS; i++) {
        const l = headL - i * SPACING;
        const p = at(l);
        const q = at(l + 2);
        const ang = Math.atan2(q.y - p.y, q.x - p.x);
        // Kriechbewegung: Welle läuft vom Kopf zum Schwanz
        const wig = done ? 0 : Math.sin(t * 7 - i * 0.7) * 6 * Math.min(1, i / 3);
        pts.push({ x: p.x - Math.sin(ang) * wig, y: p.y + Math.cos(ang) * wig });
      }
      for (let i = 0; i < SEGMENTS; i++) {
        segs[i].setAttribute('cx', pts[i + 1].x.toFixed(1));
        segs[i].setAttribute('cy', pts[i + 1].y.toFixed(1));
      }
      const hp = pts[0];
      const hq = at(headL + 2);
      let deg = (Math.atan2(hq.y - hp.y, hq.x - hp.x) * 180) / Math.PI;
      const flip = deg > 90 || deg < -90;
      if (done) deg = 0;
      head.setAttribute('transform', `translate(${hp.x.toFixed(1)} ${hp.y.toFixed(1)}) rotate(${deg.toFixed(1)})${flip && !done ? ' scale(1 -1)' : ''}`);
      const s = sub();
      if (s !== lastSub) subEl.textContent = lastSub = s;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    finishFn = () => {
      if (done) return;
      done = true;
      el?.classList.add('found');
      title.textContent = 'Mjam! Wurmi hat seinen Apfel gefunden.';
      text.textContent = 'Danke fürs Leisesein – der Raumplan wird jetzt berechnet. 🗺';
      hideTimer = window.setTimeout(hide, 3_200);
    };
  }

  return {
    show,
    finish() {
      finishFn?.();
    },
    hide,
    get visible() {
      return !!el;
    },
  };
}
