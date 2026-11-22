type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> | null;

/** Minimaler DOM-Helfer ohne Framework. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function fill(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'protokoll'
  );
}

/** Button mit Bestätigung im zweiten Klick (keine confirm()-Dialoge). */
export function confirmButton(label: string, confirmLabel: string, onConfirm: () => void, cls = 'danger'): HTMLButtonElement {
  let armed = false;
  let timer: number | undefined;
  const b = h('button', { class: cls }, label);
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      b.classList.add('armed');
      timer = window.setTimeout(() => {
        armed = false;
        b.textContent = label;
        b.classList.remove('armed');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    b.textContent = label;
    b.classList.remove('armed');
    onConfirm();
  });
  return b;
}

export function pill(text: string, kind: 'ok' | 'warn' | 'bad' | 'muted' = 'muted', title?: string) {
  return h('span', { class: `pill ${kind}`, title }, text);
}
