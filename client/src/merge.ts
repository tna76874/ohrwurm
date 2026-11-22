// Zusammenführen: Hören mehrere Geräte denselben Satz, bleibt die beste Quelle
// stehen, die anderen werden als Doppelung markiert. Deterministisch – alle
// Geräte kommen zum selben Ergebnis.
import type { Mesh } from './mesh';
import { memberName, type AgendaView, type SegView, type SessionView } from './state';
import { fmtDate, fmtTime } from './ui';

export interface Line extends SegView {
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

function overlap(a: SegView, b: SegView): number {
  const inter = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0);
  const shorter = Math.min(a.t1 - a.t0, b.t1 - b.t0);
  return shorter > 0 ? Math.max(0, inter) / shorter : 0;
}

/** Bearbeitete Zeilen gewinnen (Menschen haben sie geprüft), sonst die lautere Quelle. */
const score = (s: SegView) => (s.edits.length ? 1e6 : 0) + s.rms * Math.log(2 + s.text.length);

export function merge(segs: SegView[], includeHidden = false): Line[] {
  const live = segs.filter((s) => (includeHidden || !s.hidden) && s.text.trim());
  const out: Line[] = [];
  for (const s of live) {
    let dup: Line | undefined;
    if (!s.hidden) {
      for (let i = out.length - 1; i >= 0; i--) {
        const o = out[i];
        if (o.t0 < s.t0 - 30_000) break;
        if (o.dupOf || o.hidden || o.author === s.author) continue;
        if (overlap(o, s) >= 0.3 && similarity(o.origText, s.origText) >= 0.45) {
          dup = o;
          break;
        }
      }
    }
    if (!dup) out.push({ ...s });
    else if (score(s) > score(dup) || (score(s) === score(dup) && s.id < dup.id)) {
      dup.dupOf = s.id;
      out.push({ ...s });
    } else out.push({ ...s, dupOf: dup.id });
  }
  return out;
}

export interface Section {
  id: string | null;
  title: string;
  t: number;
  lines: Line[];
}

export function sections(lines: Line[], agenda: AgendaView[], includeDups = false): Section[] {
  const out: Section[] = [{ id: null, title: 'Vor dem ersten Tagesordnungspunkt', t: 0, lines: [] }];
  agenda.forEach((a, i) => out.push({ id: a.id, title: `TOP ${i + 1}: ${a.title}`, t: a.t, lines: [] }));
  for (const l of lines) {
    if (l.dupOf && !includeDups) continue;
    let idx = 0;
    for (let i = 1; i < out.length; i++) if (l.t0 >= out[i].t) idx = i;
    out[idx].lines.push(l);
  }
  return out.filter((s, i) => i > 0 || s.lines.length > 0);
}

/** Aufeinanderfolgende Beiträge derselben Person werden zu einem Absatz. */
export function paragraphs(lines: Line[], name: (l: Line) => string): { speaker: string; t0: number; text: string }[] {
  const out: { speaker: string; t0: number; t1: number; text: string }[] = [];
  for (const l of lines) {
    const sp = name(l);
    const last = out[out.length - 1];
    if (last && last.speaker === sp && l.t0 - last.t1 < 5000) {
      last.text += ` ${l.text}`;
      last.t1 = l.t1;
    } else out.push({ speaker: sp, t0: l.t0, t1: l.t1, text: l.text });
  }
  return out;
}

export const speakerOf = (view: SessionView, s: SegView) => s.speaker || memberName(view, s.author);

export function toMarkdown(view: SessionView, sid: string): string {
  const lines = merge(view.segs);
  const secs = sections(lines, view.agenda);
  const name = (l: Line) => speakerOf(view, l);
  const first = view.segs[0]?.t0;
  const edited = view.segs.filter((s) => !s.hidden && (s.edits.length || s.speakerChanges.length)).length;
  const out: string[] = [];
  out.push(`# ${view.title}`, '');
  if (first) out.push(`- Beginn: ${fmtDate(first)}`);
  out.push(`- Sitzung: \`${sid}\``);
  out.push(`- ${view.members.length} Geräte · ${lines.filter((l) => !l.dupOf).length} Beiträge · ${edited} gemeinsam überarbeitet`);
  out.push('- Erstellt mit 🐛 Ohrwurm – automatische Transkription, gemeinsam korrigiert.', '');
  out.push('## Teilnehmende Geräte', '');
  for (const m of view.members) {
    out.push(`- ${m.attested?.name ?? m.name}${m.attested ? '' : ' (unbestätigt)'} – ${m.segs} Beiträge, ${m.edits} Korrekturen`);
  }
  out.push('');
  for (const s of view.summaries.slice(0, 1)) {
    out.push(`## Zusammenfassung (KI: ${s.model}, geteilt von ${memberName(view, s.by)})`, '', s.text.trim(), '');
  }
  out.push('## Wortprotokoll', '');
  for (const s of secs) {
    out.push(`### ${s.title}`, '');
    if (!s.lines.length) out.push('_Keine Beiträge._', '');
    for (const p of paragraphs(s.lines, name)) out.push(`**${fmtTime(p.t0)} · ${p.speaker}:** ${p.text}`, '');
  }
  return out.join('\n');
}

/** Vollständiges, signiertes Op-Log – damit lässt sich alles nachvollziehen und prüfen. */
export function toJSON(mesh: Mesh, view: SessionView): string {
  return JSON.stringify(
    {
      format: 'ohrwurm/mesh-v1',
      session: mesh.sid,
      exported: new Date().toISOString(),
      title: view.title,
      members: view.members.map((m) => ({ peer: m.peer, name: m.name, attested: m.attested })),
      ops: [...mesh.allOps()].sort((a, b) => a.l - b.l || (a.a < b.a ? -1 : 1)),
    },
    null,
    2,
  );
}
