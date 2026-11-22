// Sicht auf die Einmess-Ops: Runden, Beitritte, Messungen, manuelle Plätze.
// Deterministisch aus dem Op-Log, wie der Rest der Sitzung.
import type { Op } from '../types';
import { ANALYSIS_MS, JOIN_CUTOFF_MS, START_DELAY_MS, distances, localize, makePlan, orient, planEnd, type Measurement, type Placed, type Plan } from './solve';

/** So lange können andere nach dem Auslösen noch „Mitmachen“ tippen. */
export const JOIN_MS = 15_000;
/** Ab so vielen Geräten, die „Wo bin ich?“ getippt haben, startet es für alle. */
export const QUORUM = 4;
/** Stimmen verfallen nach dieser Zeit. */
export const VOTE_WINDOW_MS = 5 * 60_000;

export interface LocRound {
  id: string;
  /** Wer zuerst „Wo bin ich?“ getippt hat – meist der Bildschirm vorne, liegt oben auf der Karte */
  by: string;
  /** Alle, die vor dem Auslösen getippt haben (automatisch dabei) */
  voters: string[];
  /** Zeitpunkt der Anfrage (Mesh-Zeit) */
  t: number;
  /** Ende der Beitrittsphase */
  at: number;
  /** Bis hierhin zählen Beitritte */
  cutoff: number;
  plan: Plan;
  /** Ende inkl. Auswertung */
  end: number;
  meas: Measurement[];
}

export interface Seat {
  x: number;
  y: number;
}

export interface LocState {
  rounds: LocRound[];
  /** Offene Stimmen für die nächste Runde (noch nicht ausgelöst) */
  votes: { peer: string; t: number }[];
  /** Manuell gesetzte Plätze (im Koordinatensystem der Messung), null = zurückgesetzt */
  seats: Map<string, Seat | null>;
  view: { rot: number; flip: boolean };
}

interface Reg<T> {
  l: number;
  a: string;
  v: T;
}
function put<T>(m: Map<string, Reg<T>>, key: string, op: Op, v: T) {
  const cur = m.get(key);
  if (!cur || op.l > cur.l || (op.l === cur.l && op.a > cur.a)) m.set(key, { l: op.l, a: op.a, v });
}

const reId = /^[A-Za-z0-9_-]{4,32}$/;
const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

export function buildLoc(ops: Op[], members: Set<string>): LocState {
  const requests: Op[] = [];
  const joins = new Map<string, Map<string, number>>();
  const meas = new Map<string, Map<string, Measurement>>();
  const seats = new Map<string, Reg<Seat | null>>();
  const view = new Map<string, Reg<{ rot: number; flip: boolean }>>();

  for (const op of ops) {
    const b = op.b;
    if (!members.has(op.a)) continue;
    switch (b.type) {
      case 'locate':
        if (typeof b.id === 'string' && reId.test(b.id)) requests.push(op);
        break;
      case 'locjoin': {
        if (typeof b.id !== 'string') break;
        const m = joins.get(b.id) ?? new Map<string, number>();
        m.set(op.a, Math.min(m.get(op.a) ?? Infinity, op.t));
        joins.set(b.id, m);
        break;
      }
      case 'locmeas': {
        if (typeof b.id !== 'string' || !Array.isArray(b.peers) || !Array.isArray(b.p) || !Array.isArray(b.q)) break;
        if (!b.peers.every((p) => typeof p === 'string') || !b.p.every(fin) || !b.q.every(fin) || b.p.length !== b.q.length || !fin(b.fs)) break;
        const m = meas.get(b.id) ?? new Map<string, Measurement>();
        if (!m.has(op.a)) m.set(op.a, { by: op.a, peers: b.peers.slice(0, 2_000), fs: b.fs, p: b.p, q: b.q });
        meas.set(b.id, m);
        break;
      }
      case 'seat':
        if (typeof b.peer !== 'string') break;
        put(seats, b.peer, op, fin(b.x) && fin(b.y) ? { x: b.x as number, y: b.y as number } : null);
        break;
      case 'locview':
        put(view, 'v', op, { rot: (((Math.round(Number(b.rot) || 0) % 4) + 4) % 4), flip: b.flip === true });
        break;
    }
  }

  // „Wo bin ich?“ ist eine Stimme. Sobald QUORUM verschiedene Geräte innerhalb
  // von VOTE_WINDOW_MS getippt haben (oder jemand „sofort“ wählt), startet die
  // Runde für alle. Stimmen während einer laufenden Runde zählen nicht.
  requests.sort((x, y) => x.t - y.t || (x.a < y.a ? -1 : 1));
  const rounds: LocRound[] = [];
  let busyUntil = -Infinity;
  const pending = new Map<string, number>();
  for (const op of requests) {
    if (op.t < busyUntil) continue;
    for (const [p, t] of pending) if (t < op.t - VOTE_WINDOW_MS) pending.delete(p);
    if (!pending.has(op.a)) pending.set(op.a, op.t);
    const force = (op.b as { force?: boolean }).force === true;
    if (pending.size < QUORUM && !force) continue;
    const id = (op.b as { id: string }).id;
    const voters = [...pending].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1)).map(([p]) => p);
    pending.clear();
    const at = op.t + JOIN_MS;
    const cutoff = at - JOIN_CUTOFF_MS;
    const peers = new Set<string>(voters);
    for (const [p, t] of joins.get(id) ?? []) if (t >= op.t - 1_000 && t <= cutoff) peers.add(p);
    const plan = makePlan([...peers].sort(), at + START_DELAY_MS);
    const end = planEnd(plan) + ANALYSIS_MS;
    rounds.push({ id, by: voters[0], voters, t: op.t, at, cutoff, plan, end, meas: [...(meas.get(id)?.values() ?? [])] });
    busyUntil = end;
  }

  return {
    rounds,
    votes: [...pending].map(([peer, t]) => ({ peer, t })),
    seats: new Map([...seats].map(([k, r]) => [k, r.v])),
    view: view.get('v')?.v ?? { rot: 0, flip: false },
  };
}

export type Phase = 'join' | 'run' | 'analyze' | 'done';

export function phaseOf(r: LocRound, now: number): Phase {
  if (now < r.at) return 'join';
  if (now < planEnd(r.plan)) return 'run';
  if (now < r.end && r.meas.length < r.plan.peers.length) return 'analyze';
  return 'done';
}

export interface MapPoint extends Seat {
  peer: string;
  /** 'measured' = akustisch, 'manual' = von Hand gesetzt */
  source: 'measured' | 'manual';
  sure: boolean;
}

const solveCache = new Map<string, (Placed | null)[]>();

/** Positionen aller Geräte: letzte Runde mit Ergebnis, überlagert von manuellen Plätzen. */
export function mapPoints(loc: LocState): { points: MapPoint[]; round?: LocRound } {
  let round: LocRound | undefined;
  let placed: (Placed | null)[] = [];
  for (let i = loc.rounds.length - 1; i >= 0; i--) {
    const r = loc.rounds[i];
    if (r.meas.length < 2) continue;
    const key = `${r.id}:${r.meas.map((m) => m.by).sort().join(',')}`;
    let res = solveCache.get(key);
    if (!res) {
      res = orient(localize(r.plan.peers.length, distances(r.plan, r.meas)), r.plan.peers.indexOf(r.by));
      if (solveCache.size > 20) solveCache.clear();
      solveCache.set(key, res);
    }
    if (res.some(Boolean)) {
      round = r;
      placed = res;
      break;
    }
  }
  const points = new Map<string, MapPoint>();
  if (round) {
    round.plan.peers.forEach((peer, i) => {
      const p = placed[i];
      if (p) points.set(peer, { peer, x: p.x, y: p.y, source: 'measured', sure: p.sure });
    });
  }
  for (const [peer, s] of loc.seats) {
    if (s) points.set(peer, { peer, x: s.x, y: s.y, source: 'manual', sure: true });
  }
  return { points: [...points.values()], round };
}
