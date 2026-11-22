// Hilfen für die Tests: Zufall mit Startwert, Ausrichten (Procrustes) für den Vergleich.

export function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

type P = { x: number; y: number };

/** RMS-Abstand nach bester Verschiebung, Drehung und ggf. Spiegelung. */
export function alignedRms(est: P[], truth: P[]): number {
  const n = est.length;
  const c = (ps: P[]) => ps.reduce((a, p) => ({ x: a.x + p.x / n, y: a.y + p.y / n }), { x: 0, y: 0 });
  const ce = c(est);
  const ct = c(truth);
  let best = Infinity;
  for (const mirror of [1, -1]) {
    const e = est.map((p) => ({ x: (p.x - ce.x) * mirror, y: p.y - ce.y }));
    const t = truth.map((p) => ({ x: p.x - ct.x, y: p.y - ct.y }));
    let sc = 0;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      sc += e[i].x * t[i].x + e[i].y * t[i].y;
      ss += e[i].x * t[i].y - e[i].y * t[i].x;
    }
    const a = Math.atan2(ss, sc);
    const co = Math.cos(a);
    const si = Math.sin(a);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = e[i].x * co - e[i].y * si;
      const y = e[i].x * si + e[i].y * co;
      sum += (x - t[i].x) ** 2 + (y - t[i].y) ** 2;
    }
    best = Math.min(best, Math.sqrt(sum / n));
  }
  return best;
}
