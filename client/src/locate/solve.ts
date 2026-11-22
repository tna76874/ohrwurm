// Einmessen: Ablaufplan, Abstände aus Zwei-Wege-Laufzeiten (BeepBeep) und
// Netzwerk-Lokalisierung. Alles deterministisch: Jedes Gerät berechnet aus
// denselben Messungen dieselbe Karte.
//
// Abstand A↔B ohne gemeinsame Uhr: A und B nehmen beide durchgehend auf und
// chirpen nacheinander. Jedes Gerät misst in Samples seiner eigenen Uhr, wie weit
// der fremde Chirp hinter dem eigenen liegt:
//   ΔA/fsA = (tB − tA) + d/c − sA/c        ΔB/fsB = (tB − tA) − d/c + sB/c
//   ⇒ d = c/2 · (ΔA/fsA − ΔB/fsB) + (sA + sB)/2      (s = Lautsprecher→Mikro im Gerät)
// Abweichende Audio-Takte (±50 ppm) erzeugen einen Fehler proportional zum
// Zeitabstand T = tB − tA. Runde 2 läuft in umgekehrter Reihenfolge, dadurch
// lässt sich dieser Fehler je Paar exakt herausrechnen.

export const SPEED_OF_SOUND = 343;
/** Typischer Abstand Lautsprecher → Mikrofon im selben Gerät (m). */
export const SELF_PATH = 0.1;
export const SLOT_MS = 450;
/** Chirp beginnt so viel nach Slot-Anfang (Puffer für ungenaue Uhren). */
export const LEAD_MS = 60;
/** Bis hierhin vor dem Start zählen Beitritte (Zeit zum Verteilen im Mesh). */
export const JOIN_CUTOFF_MS = 2_500;
/** Abstand zwischen Beitrittsende und erstem Slot. */
export const START_DELAY_MS = 1_200;
/** Zeit für Auswertung und Verteilen der Messungen nach dem letzten Slot. */
export const ANALYSIS_MS = 8_000;

export interface Emission {
  round: number;
  /** Index in der sortierten Teilnehmerliste */
  idx: number;
  slot: number;
  code: number;
}

export interface Plan {
  peers: string[];
  start: number;
  slotMs: number;
  codes: number;
  slots: number;
  emissions: Emission[];
}

/** Mehrere Chirp-Codes gleichzeitig verkürzen die Phase bei vielen Geräten. */
export const codesFor = (n: number) => (n > 24 ? 2 : 1);

export function makePlan(peers: string[], start: number, codes = codesFor(peers.length), slotMs = SLOT_MS): Plan {
  const n = peers.length;
  const emissions: Emission[] = [];
  const s1 = Math.ceil(n / codes);
  for (let i = 0; i < n; i++) emissions.push({ round: 0, idx: i, slot: Math.floor(i / codes), code: i % codes });
  // Runde 2 rückwärts; bei mehreren Codes um eins versetzt, damit nicht wieder
  // dieselben Geräte gleichzeitig senden.
  const off = codes > 1 ? 1 : 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i + off;
    const slot = s1 + Math.floor(j / codes);
    s2 = Math.max(s2, slot - s1 + 1);
    emissions.push({ round: 1, idx: i, slot, code: j % codes });
  }
  return { peers, start, slotMs, codes, slots: s1 + s2, emissions };
}

export const emitTime = (p: Plan, e: Emission) => p.start + e.slot * p.slotMs + LEAD_MS;
export const planEnd = (p: Plan) => p.start + p.slots * p.slotMs;

/** Kurzer, stabiler Hash einer Teilnehmerliste (FNV-1a). */
export function listHash(peers: string[]): string {
  let h = 0x811c9dc5;
  for (const ch of peers.join(',')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------- Messung eines Geräts ----------

export interface Measurement {
  /** Wer gemessen hat */
  by: string;
  /** Teilnehmerliste, mit der das Gerät gerechnet hat */
  peers: string[];
  fs: number;
  /** Sample-Position je Emission (Reihenfolge wie plan.emissions), −1 = nicht gehört */
  p: number[];
  /** SNR je Emission */
  q: number[];
}

export interface Edge {
  i: number;
  j: number;
  d: number;
  w: number;
}

/**
 * Paarabstände aus allen Messungen einer Runde.
 * Nur Messungen mit derselben Teilnehmerliste wie `plan` werden verwendet.
 */
export function distances(plan: Plan, meas: Measurement[]): Edge[] {
  const n = plan.peers.length;
  const idxOf = new Map(plan.peers.map((p, i) => [p, i]));
  const byIdx: (Measurement | undefined)[] = new Array(n);
  const hash = listHash(plan.peers);
  for (const m of meas) {
    const i = idxOf.get(m.by);
    if (i === undefined || listHash(m.peers) !== hash || m.p.length !== plan.emissions.length || !(m.fs > 8000)) continue;
    byIdx[i] = m;
  }
  // em[round][idx] → Index in emissions
  const em: number[][] = [new Array(n).fill(-1), new Array(n).fill(-1)];
  plan.emissions.forEach((e, k) => (em[e.round][e.idx] = k));

  const edges: Edge[] = [];
  for (let a = 0; a < n; a++) {
    const A = byIdx[a];
    if (!A) continue;
    for (let b = a + 1; b < n; b++) {
      const B = byIdx[b];
      if (!B) continue;
      const rounds: { d: number; T: number; q: number }[] = [];
      for (let r = 0; r < 2; r++) {
        const ka = em[r][a];
        const kb = em[r][b];
        if (ka < 0 || kb < 0) continue;
        if (plan.emissions[ka].slot === plan.emissions[kb].slot) continue; // gleichzeitig gesendet
        const aa = A.p[ka];
        const ab = A.p[kb];
        const ba = B.p[ka];
        const bb = B.p[kb];
        if (aa < 0 || ab < 0 || ba < 0 || bb < 0) continue;
        const dA = (ab - aa) / A.fs;
        const dB = (bb - ba) / B.fs;
        const d = (SPEED_OF_SOUND / 2) * (dA - dB) + SELF_PATH;
        const q = Math.min(A.q[kb], B.q[ka]);
        rounds.push({ d, T: (dA + dB) / 2, q });
      }
      let d: number;
      let w: number;
      if (rounds.length === 2) {
        const [r1, r2] = rounds;
        const dT = r2.T - r1.T;
        if (Math.abs(dT) > 0.5) {
          // d_r = d + k·T_r  →  exakte Elimination des Taktfehlers k
          const k = (r2.d - r1.d) / dT;
          // k = c/2·(εA − εB); mehr als ~300 ppm ist physikalisch unplausibel → Ausreißer
          if (Math.abs(k) > (SPEED_OF_SOUND / 2) * 3e-4) continue;
          d = r1.d - k * r1.T;
        } else {
          if (Math.abs(r1.d - r2.d) > 0.4) continue;
          d = (r1.d + r2.d) / 2;
        }
        w = 1;
      } else if (rounds.length === 1) {
        d = rounds[0].d;
        w = Math.abs(rounds[0].T) < 2 ? 0.6 : 0.25; // Taktfehler nicht korrigierbar
      } else continue;
      if (!(d > 0.05 && d < 30)) continue;
      const q = Math.min(...rounds.map((r) => r.q));
      w *= Math.min(1, q / 20);
      edges.push({ i: a, j: b, d, w });
    }
  }
  return edges;
}

// ---------- Lokalisierung ----------

export interface Placed {
  x: number;
  y: number;
  /** Anzahl gemessener Nachbarn */
  degree: number;
  /** mittlere Abweichung zu den gemessenen Abständen (m) */
  residual: number;
  sure: boolean;
}

/** Klassische MDS über die vollständige (per kürzesten Wegen ergänzte) Distanzmatrix. */
function classicalMds(D: Float64Array[], nodes: number[]): [number, number][] {
  const m = nodes.length;
  const B = Array.from({ length: m }, () => new Float64Array(m));
  const rowMean = new Float64Array(m);
  let all = 0;
  for (let a = 0; a < m; a++) {
    for (let b = 0; b < m; b++) {
      const v = D[nodes[a]][nodes[b]] ** 2;
      B[a][b] = v;
      rowMean[a] += v / m;
    }
    all += rowMean[a] / m;
  }
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) B[a][b] = -0.5 * (B[a][b] - rowMean[a] - rowMean[b] + all);
  const vecs: Float64Array[] = [];
  const vals: number[] = [];
  for (let e = 0; e < 2; e++) {
    let v = new Float64Array(m);
    for (let a = 0; a < m; a++) v[a] = Math.sin(1 + a * (e + 1.7)) + 0.01 * a; // deterministischer Start
    let lambda = 0;
    for (let it = 0; it < 300; it++) {
      const w = new Float64Array(m);
      for (let a = 0; a < m; a++) {
        let s = 0;
        for (let b = 0; b < m; b++) s += B[a][b] * v[b];
        w[a] = s;
      }
      // Deflation: bereits gefundene Eigenvektoren herausprojizieren
      for (const u of vecs) {
        let dot = 0;
        for (let a = 0; a < m; a++) dot += w[a] * u[a];
        for (let a = 0; a < m; a++) w[a] -= dot * u[a];
      }
      const norm = Math.hypot(...w);
      if (norm < 1e-12) break;
      for (let a = 0; a < m; a++) w[a] /= norm;
      lambda = norm;
      v = w;
    }
    vecs.push(v);
    vals.push(lambda);
  }
  return nodes.map((_, a) => [vecs[0][a] * Math.sqrt(vals[0]), vecs[1][a] * Math.sqrt(vals[1])]);
}

/**
 * Berechnet 2D-Positionen aus lückenhaften, verrauschten Paarabständen.
 * MDS-MAP als Start, dann gewichtete Stress-Minimierung nur auf gemessenen
 * Kanten (Ausreißer werden in einer zweiten Runde verworfen).
 * Rückgabe in Metern, zentriert; Drehung/Spiegelung beliebig.
 */
export function localize(n: number, edges: Edge[]): (Placed | null)[] {
  const adj: Edge[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.i].push(e);
    adj[e.j].push(e);
  }
  // Größte Zusammenhangskomponente
  const comp = new Int32Array(n).fill(-1);
  let bestComp = -1;
  let bestSize = 0;
  for (let s = 0, c = 0; s < n; s++) {
    if (comp[s] >= 0 || !adj[s].length) continue;
    const stack = [s];
    comp[s] = c;
    let size = 0;
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const e of adj[u]) {
        const v = e.i === u ? e.j : e.i;
        if (comp[v] < 0) {
          comp[v] = c;
          stack.push(v);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestComp = c;
    }
    c++;
  }
  const out: (Placed | null)[] = new Array(n).fill(null);
  if (bestSize < 2) return out;
  const nodes = [...Array(n).keys()].filter((i) => comp[i] === bestComp);
  const local = new Map(nodes.map((v, k) => [v, k]));
  const m = nodes.length;

  // Kürzeste Wege (Floyd–Warshall) als Schätzung für nicht gemessene Paare
  const D = Array.from({ length: n }, () => new Float64Array(n).fill(Infinity));
  for (const v of nodes) D[v][v] = 0;
  for (const e of edges) {
    if (comp[e.i] !== bestComp) continue;
    D[e.i][e.j] = Math.min(D[e.i][e.j], e.d);
    D[e.j][e.i] = D[e.i][e.j];
  }
  for (const k of nodes) for (const i of nodes) for (const j of nodes) if (D[i][k] + D[k][j] < D[i][j]) D[i][j] = D[i][k] + D[k][j];

  const X: [number, number][] = m >= 3 ? classicalMds(D, nodes) : [[0, 0], [D[nodes[0]][nodes[1]], 0]];

  let active = edges.filter((e) => comp[e.i] === bestComp);
  const stress = (iters: number) => {
    const ladj: { k: number; d: number; w: number }[][] = Array.from({ length: m }, () => []);
    for (const e of active) {
      const a = local.get(e.i)!;
      const b = local.get(e.j)!;
      const w = e.w / (e.d * e.d);
      ladj[a].push({ k: b, d: e.d, w });
      ladj[b].push({ k: a, d: e.d, w });
    }
    // Schwache Kopplung an die Wegschätzung hält die globale Form (verhindert Falten).
    const weak: { k: number; d: number; w: number }[][] = Array.from({ length: m }, () => []);
    if (m > 3) {
      for (let a = 0; a < m; a++) {
        const have = new Set(ladj[a].map((x) => x.k));
        for (let b = 0; b < m; b++) {
          if (a === b || have.has(b)) continue;
          const d = D[nodes[a]][nodes[b]];
          if (Number.isFinite(d) && d > 0) weak[a].push({ k: b, d, w: 0.02 / (d * d) });
        }
      }
    }
    for (let it = 0; it < iters; it++) {
      for (let a = 0; a < m; a++) {
        let sx = 0;
        let sy = 0;
        let sw = 0;
        for (const list of [ladj[a], weak[a]]) {
          for (const { k, d, w } of list) {
            const dx = X[a][0] - X[k][0];
            const dy = X[a][1] - X[k][1];
            const cur = Math.hypot(dx, dy) || 1e-9;
            sx += w * (X[k][0] + (d * dx) / cur);
            sy += w * (X[k][1] + (d * dy) / cur);
            sw += w;
          }
        }
        if (sw > 0) X[a] = [sx / sw, sy / sw];
      }
    }
  };
  stress(250);
  // Ausreißer verwerfen: Kanten mit großer Abweichung
  const resid = (e: Edge) => Math.abs(Math.hypot(X[local.get(e.i)!][0] - X[local.get(e.j)!][0], X[local.get(e.i)!][1] - X[local.get(e.j)!][1]) - e.d);
  const rs = active.map(resid).sort((a, b) => a - b);
  const med = rs[rs.length >> 1] ?? 0;
  const limit = Math.max(0.25, 4 * med);
  const kept = active.filter((e) => resid(e) <= limit);
  if (kept.length !== active.length) {
    active = kept;
    stress(250);
  }

  let cx = 0;
  let cy = 0;
  for (const p of X) {
    cx += p[0] / m;
    cy += p[1] / m;
  }
  const deg = new Map<number, number[]>();
  for (const e of active) {
    const r = resid(e);
    deg.set(e.i, [...(deg.get(e.i) ?? []), r]);
    deg.set(e.j, [...(deg.get(e.j) ?? []), r]);
  }
  for (const v of nodes) {
    const p = X[local.get(v)!];
    const rr = deg.get(v) ?? [];
    const residual = rr.length ? Math.sqrt(rr.reduce((s, r) => s + r * r, 0) / rr.length) : Infinity;
    out[v] = { x: p[0] - cx, y: p[1] - cy, degree: rr.length, residual, sure: rr.length >= 3 && residual < 0.3 };
  }
  return out;
}

/**
 * Dreht die Karte so, dass `front` (das Gerät, das das Einmessen angefordert hat –
 * meist der Bildschirm vorne) oben in der Mitte liegt.
 */
export function orient(pos: (Placed | null)[], front: number): (Placed | null)[] {
  const f = pos[front];
  if (!f || Math.hypot(f.x, f.y) < 1e-6) return pos;
  const ang = Math.atan2(f.y, f.x);
  const rot = -Math.PI / 2 - ang; // Ziel: Richtung −y (oben)
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return pos.map((p) => (p ? { ...p, x: p.x * c - p.y * s, y: p.x * s + p.y * c } : null));
}
