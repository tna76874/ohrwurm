// Materialisierte Sicht auf das Op-Log. Alle Geräte berechnen aus denselben Ops
// dieselbe Sicht (Last-Writer-Wins nach Lamport-Uhr, Autor-ID als Tie-Break).
import { buildLoc, type LocState } from './locate/model';
import type { Mesh } from './mesh';
import type { Identity, Op } from './types';

export interface Change {
  by: string;
  at: number;
  value: string;
  via?: string;
}

export interface SegView {
  id: string;
  author: string;
  t0: number;
  t1: number;
  rms: number;
  text: string;
  origText: string;
  speaker: string;
  origSpeaker: string;
  hidden: boolean;
  hiddenBy?: string;
  flagged: boolean;
  edits: Change[];
  speakerChanges: Change[];
}

export interface Member {
  peer: string;
  name: string;
  device: string;
  attested?: Identity;
  conflict: boolean;
  online: boolean;
  segs: number;
  edits: number;
}

export interface AgendaView {
  id: string;
  title: string;
  t: number;
  by: string;
}

export interface SummaryView {
  id: string;
  by: string;
  at: number;
  model: string;
  text: string;
}

export interface SessionView {
  title: string;
  recording: boolean;
  recordingBy?: string;
  agenda: AgendaView[];
  segs: SegView[];
  members: Member[];
  summaries: SummaryView[];
  loc: LocState;
}

interface Reg<T> {
  l: number;
  a: string;
  t: number;
  v: T;
}

function put<T>(map: Map<string, Reg<T>>, key: string, op: Op, v: T) {
  const cur = map.get(key);
  if (!cur || op.l > cur.l || (op.l === cur.l && op.a > cur.a)) map.set(key, { l: op.l, a: op.a, t: op.t, v });
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export function buildView(mesh: Mesh): SessionView {
  const segs = new Map<string, SegView>();
  const text = new Map<string, Reg<string>>();
  const speaker = new Map<string, Reg<string>>();
  const hidden = new Map<string, Reg<boolean>>();
  const flagged = new Map<string, Reg<boolean>>();
  const agenda = new Map<string, Reg<{ title: string; t: number; deleted: boolean }>>();
  const single = new Map<string, Reg<unknown>>();
  const editLog = new Map<string, Change[]>();
  const speakerLog = new Map<string, Change[]>();
  const members = new Map<string, Member>();
  const summaries: SummaryView[] = [];
  const editCount = new Map<string, number>();
  const locOps: Op[] = [];

  const log = (m: Map<string, Change[]>, seg: string, c: Change) => {
    const list = m.get(seg) ?? [];
    list.push(c);
    m.set(seg, list);
  };

  for (const op of mesh.allOps()) {
    const b = op.b;
    switch (b.type) {
      case 'member':
        if (op.s === 1) {
          members.set(op.a, {
            peer: op.a,
            name: str(b.name, 64) || 'Unbekannt',
            device: str(b.device, 160),
            conflict: mesh.conflicts.has(op.a),
            online: false,
            segs: 0,
            edits: 0,
          });
        }
        break;
      case 'seg': {
        const t = str(b.text, 10_000);
        const sp = str(b.speaker, 64);
        segs.set(`${op.a}:${op.s}`, {
          id: `${op.a}:${op.s}`,
          author: op.a,
          t0: Number(b.t0) || op.t,
          t1: Number(b.t1) || op.t,
          rms: Number(b.rms) || 0,
          text: t,
          origText: t,
          speaker: sp,
          origSpeaker: sp,
          hidden: false,
          flagged: false,
          edits: [],
          speakerChanges: [],
        });
        break;
      }
      case 'edit':
        put(text, str(b.seg, 100), op, str(b.text, 10_000));
        log(editLog, str(b.seg, 100), { by: op.a, at: op.t, value: str(b.text, 10_000), via: b.via });
        editCount.set(op.a, (editCount.get(op.a) ?? 0) + 1);
        break;
      case 'speaker':
        put(speaker, str(b.seg, 100), op, str(b.speaker, 64));
        log(speakerLog, str(b.seg, 100), { by: op.a, at: op.t, value: str(b.speaker, 64) });
        editCount.set(op.a, (editCount.get(op.a) ?? 0) + 1);
        break;
      case 'hide':
        put(hidden, str(b.seg, 100), op, b.hidden === true);
        break;
      case 'flag':
        put(flagged, str(b.seg, 100), op, b.flagged === true);
        break;
      case 'agenda':
        put(agenda, str(b.id, 64), op, { title: str(b.title, 200), t: Number(b.t) || op.t, deleted: b.deleted === true });
        break;
      case 'title':
        put(single, 'title', op, str(b.title, 200));
        break;
      case 'pause':
        put(single, 'recording', op, b.recording !== false);
        break;
      case 'summary':
        summaries.push({ id: `${op.a}:${op.s}`, by: op.a, at: op.t, model: str(b.model, 100), text: str(b.text, 50_000) });
        break;
      case 'locate':
      case 'locjoin':
      case 'locmeas':
      case 'seat':
      case 'locview':
        locOps.push(op);
        break;
    }
  }

  for (const s of segs.values()) {
    const tr = text.get(s.id);
    if (tr) s.text = tr.v;
    const sr = speaker.get(s.id);
    if (sr) s.speaker = sr.v;
    const hr = hidden.get(s.id);
    if (hr?.v) {
      s.hidden = true;
      s.hiddenBy = hr.a;
    }
    s.flagged = flagged.get(s.id)?.v ?? false;
    s.edits = (editLog.get(s.id) ?? []).sort((x, y) => x.at - y.at);
    s.speakerChanges = (speakerLog.get(s.id) ?? []).sort((x, y) => x.at - y.at);
    const m = members.get(s.author);
    if (m) m.segs++;
  }

  for (const m of members.values()) {
    m.attested = mesh.ms.attested[m.peer];
    m.online = m.peer === mesh.me ? mesh.joined : mesh.presence.get(m.peer)?.online === true;
    m.edits = editCount.get(m.peer) ?? 0;
  }

  const rec = single.get('recording');
  return {
    title: (single.get('title')?.v as string | undefined) || 'Sitzung',
    recording: rec ? rec.v !== false : true,
    recordingBy: rec?.a,
    agenda: [...agenda.entries()]
      .filter(([, r]) => !r.v.deleted)
      .map(([id, r]) => ({ id, title: r.v.title, t: r.v.t, by: r.a }))
      .sort((x, y) => x.t - y.t),
    segs: [...segs.values()].sort((x, y) => x.t0 - y.t0),
    members: [...members.values()].sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name)),
    summaries: summaries.sort((x, y) => y.at - x.at),
    loc: buildLoc(locOps, new Set(members.keys())),
  };
}

/** Anzeigename eines Geräts: bevorzugt die vom Relay bestätigte Identität. */
export function memberName(view: SessionView, peer: string): string {
  const m = view.members.find((x) => x.peer === peer);
  return m?.attested?.name ?? m?.name ?? 'Unbekannt';
}
