// Das Ohrwurm-Logo: ein Wurm, der sich zur Ohrmuschel einrollt – und zuhört.
// Farben kommen aus CSS-Variablen, damit es in hellem und dunklem Design passt.

const BODY =
  'M21 52c-8-3-11-12-10-21 1.5-12 11-20 22-19 10 .8 16 9 14.5 18-1.3 7.5-8 11-13.5 9-4.6-1.7-5.5-7.6-1.6-10';

export const LOGO_SVG = `
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="none" stroke-linecap="round">
    <path class="wave w1" d="M54 22c3.5 4 3.5 10 0 14" stroke="var(--logo-wave)" stroke-width="3.2"/>
    <path class="wave w2" d="M58.5 17c6 6.5 6 17.5 0 24" stroke="var(--logo-wave)" stroke-width="3.2" opacity=".7"/>
    <path d="${BODY}" stroke="var(--logo-body)" stroke-width="8.5"/>
    <path d="${BODY}" stroke="var(--logo-ring)" stroke-width="8.5" stroke-dasharray="1.3 5.5" opacity=".35"/>
  </g>
  <circle cx="21" cy="52" r="6.6" fill="var(--logo-body)"/>
  <circle cx="19.1" cy="50.4" r="2.2" fill="#fff"/>
  <circle cx="19.6" cy="50.8" r="1.15" fill="var(--logo-ink)"/>
  <circle cx="24.4" cy="54.2" r="1.5" fill="var(--logo-wave)" opacity=".75"/>
  <path d="M17.8 55.2q1.8 1.4 3.6.3" fill="none" stroke="var(--logo-ink)" stroke-width="1" stroke-linecap="round"/>
</svg>`;

export function logo(cls = 'logo'): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = cls;
  el.innerHTML = LOGO_SVG; // statischer, eigener Inhalt
  return el;
}

/** Kleine Illustration für leere Zustände. */
export function emptyState(title: string, text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'empty';
  box.append(logo('logo empty-logo'));
  const h = document.createElement('strong');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  box.append(h, p);
  return box;
}
