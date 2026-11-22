// Zusammenführen der Segmente aller Geräte zu einem Protokoll.
// Hören mehrere Geräte denselben Redner, bleibt die beste Quelle stehen.
import type { AgendaItem, HostSession, Segment } from './types';
import { fmtDate, fmtTime } from './ui';

export interface Line extends Segment {
  dupOf?: string;
}

function words(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => B.has(w) && inter++);
  return inter / (A.size + B.size - inter);
}

function overlap(a: Segment, b: Segment): number {
  const inter = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
  const shorter = Math.min(a.t1 - a.t0, b.t1 - b.t0);
  return shorter > 0 ? Math.max(0, inter) / shorter : 0;
}

const score = (s: Segment) => s.rms * Math.log(2 + s.text.length);

export function merge(segments: Segment[]): Line[] {
  const live = segments.filter((s) => !s.retracted && s.text.trim()).sort((a, b) => a.t0 - b.t0);
  const out: Line[] = [];
  for (const s of live) {
    let dup: Line | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      const o = out[i];
      if (o.t0 < s.t0 - 30_000) break;
      if (o.dupOf || o.peer === s.peer) continue;
      if (overlap(o, s) >= 0.3 && similarity(o.text, s.text) >= 0.45) {
        dup = o;
        break;
      }
    }
    if (!dup) out.push({ ...s });
    else if (score(s) > score(dup)) {
      dup.dupOf = s.id;
      out.push({ ...s });
    } else out.push({ ...s, dupOf: dup.id });
  }
  return out;
}

export interface Section {
  title: string;
  t: number;
  lines: Line[];
}

export function sections(lines: Line[], agenda: AgendaItem[], includeDups = false): Section[] {
  const tops = [...agenda].sort((a, b) => a.t - b.t);
  const out: Section[] = [{ title: 'Vor dem ersten Tagesordnungspunkt', t: 0, lines: [] }];
  tops.forEach((a, i) => out.push({ title: `TOP ${i + 1}: ${a.title}`, t: a.t, lines: [] }));
  for (const l of lines) {
    if (l.dupOf && !includeDups) continue;
    let idx = 0;
    for (let i = 1; i < out.length; i++) if (l.t0 >= out[i].t) idx = i;
    out[idx].lines.push(l);
  }
  return out.filter((s, i) => i > 0 || s.lines.length > 0);
}

/** Aufeinanderfolgende Beiträge derselben Person werden zu einem Absatz. */
export function paragraphs(lines: Line[]): { speaker: string; t0: number; text: string }[] {
  const out: { speaker: string; t0: number; t1: number; text: string }[] = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.speaker === l.speaker && l.t0 - last.t1 < 5000) {
      last.text += ` ${l.text}`;
      last.t1 = l.t1;
    } else out.push({ speaker: l.speaker, t0: l.t0, t1: l.t1, text: l.text });
  }
  return out;
}

export function speakerLabel(hs: HostSession, s: Segment): string {
  return s.speaker || hs.peers[s.peer]?.label || hs.peers[s.peer]?.user.name || 'Unbekannt';
}

export function toMarkdown(hs: HostSession, segments: Segment[]): string {
  const lines = merge(segments).map((l) => ({ ...l, speaker: speakerLabel(hs, l) }));
  const secs = sections(lines, hs.agenda);
  const counts = new Map<string, number>();
  segments.filter((s) => !s.retracted).forEach((s) => counts.set(s.peer, (counts.get(s.peer) ?? 0) + 1));
  const out: string[] = [];
  out.push(`# ${hs.title || 'Protokoll'}`, '');
  out.push(`- Beginn: ${fmtDate(hs.created)}`);
  out.push(`- Session: \`${hs.sid}\``);
  out.push(`- Erstellt mit Ohrwurm. Automatische Transkription, kann Fehler enthalten.`, '');
  out.push('## Geräte', '');
  out.push(`- Host-Gerät – ${counts.get('host') ?? 0} Beiträge`);
  for (const p of Object.values(hs.peers)) {
    const v = p.verified ? 'IdP-geprüft' : 'Relay-bestätigt';
    out.push(`- ${p.label || p.user.name} (${v}) – ${counts.get(p.peer) ?? 0} Beiträge`);
  }
  out.push('');
  if (hs.summary) {
    out.push(`## Zusammenfassung (KI, ${hs.summary.model}, ungeprüft)`, '', hs.summary.text.trim(), '');
  }
  out.push('## Wortprotokoll', '');
  for (const s of secs) {
    out.push(`### ${s.title}`, '');
    if (!s.lines.length) out.push('_Keine Beiträge._', '');
    for (const p of paragraphs(s.lines)) out.push(`**${fmtTime(p.t0)} · ${p.speaker}:** ${p.text}`, '');
  }
  return out.join('\n');
}

export function toJSON(hs: HostSession, segments: Segment[]): string {
  const session: Partial<HostSession> = { ...hs };
  delete session.keyPair;
  if (hs.llm) session.llm = { url: hs.llm.url, model: hs.llm.model }; // ohne API-Key
  return JSON.stringify({ format: 'ohrwurm/v1', session, segments }, null, 2);
}
