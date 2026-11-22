// PDF-Export komplett im Browser (jsPDF, wird erst beim ersten Export geladen).
import { LOGO_SVG } from './logo';
import { merge, paragraphs, sections, speakerOf } from './merge';
import { memberName, type SessionView } from './state';
import { fmtDate, fmtTime } from './ui';

type RGB = [number, number, number];
const BRAND: RGB = [46, 139, 106];
const INK: RGB = [29, 43, 38];
const MUTED: RGB = [108, 116, 109];
const ACCENT: RGB = [255, 122, 89];
const CREAM: RGB = [251, 244, 230];

/** Standard-PDF-Schriften kennen nur WinAnsi: Emojis & Co. entfernen. */
const KEEP = new Set([...'€„“”‚‘’–—…•']);
function clean(s: string): string {
  return [...s.normalize('NFC')].filter((c) => c.charCodeAt(0) < 256 || KEEP.has(c)).join('').replace(/[ \t]+/g, ' ').trim();
}

/** Markdown der KI-Zusammenfassung in einfache Zeilen mit Stil übersetzen. */
function mdLines(md: string): { text: string; style: 'h' | 'li' | 'p' }[] {
  const out: { text: string; style: 'h' | 'li' | 'p' }[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line || /^\|?\s*:?-{3,}/.test(line)) continue;
    const strip = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1');
    if (line.startsWith('#')) out.push({ text: strip(line.replace(/^#+\s*/, '')), style: 'h' });
    else if (/^[-*•]\s+/.test(line)) out.push({ text: strip(line.replace(/^[-*•]\s+/, '')), style: 'li' });
    else if (/^\d+\.\s+/.test(line)) out.push({ text: strip(line), style: 'li' });
    else if (line.startsWith('|')) out.push({ text: strip(line.split('|').map((c) => c.trim()).filter(Boolean).join(' · ')), style: 'li' });
    else out.push({ text: strip(line), style: 'p' });
  }
  return out;
}

async function logoPng(): Promise<string | null> {
  const svg = LOGO_SVG.replace(/var\(--logo-body\)/g, '#2e8b6a')
    .replace(/var\(--logo-wave\)/g, '#ff7a59')
    .replace(/var\(--logo-ring\)/g, '#ffffff')
    .replace(/var\(--logo-ink\)/g, '#1d2b26')
    .replace('<svg ', '<svg width="256" height="256" ');
  try {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    c.getContext('2d')!.drawImage(img, 0, 0, 256, 256);
    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}

export async function toPdf(view: SessionView, sid: string): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const W = 210;
  const H = 297;
  const M = 18;
  const CW = W - 2 * M;
  const BOTTOM = H - 20;
  let y = 0;

  const color = (c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
  const font = (style: 'normal' | 'bold' | 'italic', size: number) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
  };
  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M;
    }
  };
  const write = (text: string, x: number, width: number, lineH: number) => {
    for (const ln of doc.splitTextToSize(clean(text), width) as string[]) {
      ensure(lineH);
      doc.text(ln, x, y);
      y += lineH;
    }
  };
  const heading = (text: string) => {
    ensure(16);
    y += 4;
    font('bold', 13);
    color(BRAND);
    doc.text(clean(text), M, y);
    y += 2;
    doc.setDrawColor(BRAND[0], BRAND[1], BRAND[2]);
    doc.setLineWidth(0.4);
    doc.line(M, y, M + 24, y);
    y += 6;
  };

  // ---------- Kopf ----------
  doc.setFillColor(CREAM[0], CREAM[1], CREAM[2]);
  doc.rect(0, 0, W, 42, 'F');
  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.rect(0, 42, W, 1.2, 'F');
  const logo = await logoPng();
  if (logo) doc.addImage(logo, 'PNG', M, 9, 24, 24);
  const tx = logo ? M + 30 : M;
  font('bold', 9);
  color(ACCENT);
  doc.text('GESPRÄCHSPROTOKOLL', tx, 16);
  font('bold', 20);
  color(INK);
  doc.text(doc.splitTextToSize(clean(view.title), W - tx - M)[0] as string, tx, 25);
  const lines = merge(view.segs);
  const visible = lines.filter((l) => !l.dupOf);
  const first = view.segs[0]?.t0;
  const last = view.segs[view.segs.length - 1]?.t1;
  font('normal', 9);
  color(MUTED);
  doc.text(
    clean(`${first ? `${fmtDate(first)}${last ? ` – ${fmtTime(last)}` : ''} · ` : ''}${view.members.length} Geräte · ${visible.length} Beiträge`),
    tx,
    32,
  );
  y = 54;

  // ---------- Teilnehmende ----------
  heading('Teilnehmende Geräte');
  font('normal', 10);
  color(INK);
  for (const m of view.members) {
    const name = m.attested?.name ?? m.name;
    write(`•  ${name}${m.attested ? '' : ' (unbestätigt)'} – ${m.segs} Beiträge, ${m.edits} Korrekturen`, M, CW, 5);
  }

  // ---------- Zusammenfassung ----------
  const summary = view.summaries[0];
  if (summary) {
    heading('Zusammenfassung');
    font('italic', 8.5);
    color(MUTED);
    write(`Automatisch erstellt (${summary.model}), geteilt von ${memberName(view, summary.by)} – bitte prüfen.`, M, CW, 4.5);
    y += 2;
    for (const l of mdLines(summary.text)) {
      if (l.style === 'h') {
        y += 2;
        font('bold', 10.5);
        color(INK);
        write(l.text, M, CW, 5.5);
      } else if (l.style === 'li') {
        font('normal', 10);
        color(INK);
        ensure(5);
        doc.text('•', M + 1, y);
        write(l.text, M + 5, CW - 5, 5);
      } else {
        font('normal', 10);
        color(INK);
        write(l.text, M, CW, 5);
      }
    }
  }

  // ---------- Wortprotokoll ----------
  heading('Wortprotokoll');
  for (const s of sections(lines, view.agenda)) {
    ensure(14);
    y += 2;
    font('bold', 11);
    color(INK);
    write(s.title, M, CW, 6);
    y += 1;
    if (!s.lines.length) {
      font('italic', 9.5);
      color(MUTED);
      write('Keine Beiträge.', M, CW, 5);
    }
    for (const p of paragraphs(s.lines, (l) => speakerOf(view, l))) {
      ensure(11);
      font('normal', 8.5);
      color(MUTED);
      doc.text(fmtTime(p.t0), M, y);
      font('bold', 10);
      color(BRAND);
      doc.text(clean(p.speaker), M + 16, y);
      y += 5;
      font('normal', 10);
      color(INK);
      write(p.text, M + 16, CW - 16, 5);
      y += 2;
    }
  }

  // ---------- Fußzeilen ----------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(234, 223, 200);
    doc.setLineWidth(0.3);
    doc.line(M, H - 12, W - M, H - 12);
    font('normal', 7.5);
    color(MUTED);
    doc.text(clean(`Ohrwurm · ${view.title} · Sitzung ${sid.slice(0, 8)}`), M, H - 7);
    doc.text(`Seite ${i} von ${pages}`, W - M, H - 7, { align: 'right' });
  }
  return doc.output('blob');
}
