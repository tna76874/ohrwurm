// Ende-zu-Ende-Simulation des Einmessens: Geräte an zufälligen Plätzen, mit
// unterschiedlichen Abtastraten, Taktfehlern, Uhr-Abweichungen und Latenzen.
// Erzeugt die Aufnahme jedes Geräts physikalisch (Laufzeit, Dämpfung, Echo,
// Rauschen) und schickt sie durch dieselbe Auswertung wie im Browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHIRP, chirpAt } from './dsp';
import { measure } from './measure';
import { SPEED_OF_SOUND, distances, emitTime, localize, makePlan, planEnd, type Measurement } from './solve';
import { alignedRms, gauss, rng } from './testutil';

interface Device {
  id: string;
  x: number;
  y: number;
  fs: number;
  /** Abweichung des Audio-Takts */
  ppm: number;
  /** Fehler der Mesh-Uhr (ms): Gerät glaubt, es sei T + sync */
  sync: number;
  outLat: number;
  inLat: number;
  /** Lautsprecher → Mikro im Gerät (m), real je nach Modell verschieden */
  self: number;
}

async function simulate(n: number, seed: number, opts: { range?: number; width?: number; depth?: number } = {}) {
  const r = rng(seed);
  const W = opts.width ?? 8;
  const D = opts.depth ?? 6;
  const range = opts.range ?? 9;
  const devs: Device[] = Array.from({ length: n }, (_, i) => ({
    id: `dev${String(i).padStart(3, '0')}xxxxxxxxxxxx`,
    x: r() * W,
    y: r() * D,
    fs: r() < 0.7 ? 48_000 : 44_100,
    ppm: (r() - 0.5) * 80e-6,
    sync: (r() - 0.5) * 60,
    outLat: 5 + r() * 115,
    inLat: 5 + r() * 55,
    self: 0.04 + r() * 0.12,
  }));
  const peers = devs.map((d) => d.id).sort();
  const byId = new Map(devs.map((d) => [d.id, d]));
  const plan = makePlan(peers, 100_000);
  const recStart = plan.start - 300;
  const recEnd = planEnd(plan) + 500;
  const chirpLen = CHIRP.dur;

  // Emissionszeitpunkte in echter Zeit (s): geplant in Gerätezeit → echte Zeit + Ausgabelatenz
  const emits = plan.emissions.map((e) => {
    const d = byId.get(peers[e.idx])!;
    return { e, dev: d, t: (emitTime(plan, e) - d.sync + d.outLat) / 1000 };
  });

  const meas: Measurement[] = [];
  for (const dev of devs) {
    const fsTrue = dev.fs * (1 + dev.ppm);
    const len = Math.round(((recEnd - recStart) / 1000) * dev.fs);
    const rec = new Float32Array(len);
    const nr = rng(seed * 1000 + devs.indexOf(dev) + 1);
    for (let k = 0; k < len; k++) rec[k] = 0.002 * gauss(nr);
    // Sample 0 = Schall, der zur echten Zeit R am Mikro ankam
    const R = (recStart - dev.sync - dev.inLat) / 1000;
    for (const { dev: src, e, t } of emits) {
      const dist = src === dev ? dev.self : Math.hypot(src.x - dev.x, src.y - dev.y);
      if (dist > range) continue;
      const amp = src === dev ? 1 : Math.min(1, (0.1 / dist) * 0.6);
      const paths = [{ delay: dist / SPEED_OF_SOUND, a: amp }];
      if (src !== dev) paths.push({ delay: dist / SPEED_OF_SOUND + 0.003 + nr() * 0.006, a: amp * (0.4 + nr() * 0.9) }); // Echo, manchmal stärker
      for (const p of paths) {
        const arrival = t + p.delay;
        const k0 = Math.floor((arrival - R) * fsTrue);
        const k1 = Math.ceil((arrival + chirpLen - R) * fsTrue);
        for (let k = Math.max(0, k0); k <= k1 && k < len; k++) rec[k] += p.a * CHIRP.amp * chirpAt(R + k / fsTrue - arrival, e.code);
      }
    }
    const m = await measure(rec, dev.fs, recStart, plan);
    meas.push({ by: dev.id, peers, fs: dev.fs, ...m });
  }
  return { devs, peers, plan, meas, byId, range };
}

function check(sim: Awaited<ReturnType<typeof simulate>>, maxEdgeErr: number, maxRms: number) {
  const { peers, plan, meas, byId } = sim;
  const edges = distances(plan, meas);
  const errs = edges.map((e) => {
    const a = byId.get(peers[e.i])!;
    const b = byId.get(peers[e.j])!;
    return Math.abs(e.d - Math.hypot(a.x - b.x, a.y - b.y));
  });
  errs.sort((a, b) => a - b);
  const median = errs[errs.length >> 1];
  assert.ok(edges.length > 0, 'keine Abstände');
  assert.ok(median < maxEdgeErr, `Median-Abstandsfehler ${median.toFixed(3)} m`);
  const pos = localize(peers.length, edges);
  const placed = pos.map((p, i) => ({ p, d: byId.get(peers[i])! })).filter((x) => x.p);
  assert.ok(placed.length >= peers.length - 1, `nur ${placed.length}/${peers.length} verortet`);
  const rms = alignedRms(placed.map((x) => x.p!), placed.map((x) => ({ x: x.d.x, y: x.d.y })));
  assert.ok(rms < maxRms, `Karte weicht im Mittel ${rms.toFixed(3)} m ab`);
  return { edges: edges.length, median, rms };
}

test('8 Geräte, ein Chirp-Code: Abstände auf wenige cm, Karte auf <10 cm', async () => {
  const sim = await simulate(8, 7);
  assert.equal(sim.plan.codes, 1);
  const res = check(sim, 0.05, 0.1);
  assert.equal(res.edges, 28, 'alle Paare sollten sich hören');
  console.log(`    8 Geräte: ${res.edges} Abstände, Median-Fehler ${(res.median * 100).toFixed(1)} cm, Karte ${(res.rms * 100).toFixed(1)} cm`);
});

test('26 Geräte, zwei Chirp-Codes parallel, begrenzte Reichweite', async () => {
  const sim = await simulate(26, 11, { width: 12, depth: 8, range: 6 });
  assert.equal(sim.plan.codes, 2);
  const res = check(sim, 0.06, 0.15);
  console.log(`    26 Geräte: ${res.edges} Abstände, Median-Fehler ${(res.median * 100).toFixed(1)} cm, Karte ${(res.rms * 100).toFixed(1)} cm`);
});

test('Taktfehler wird durch die gespiegelte zweite Runde herausgerechnet', async () => {
  // Ohne Korrektur: 80 ppm über ~3 s ≈ 4 cm; mit großen Slots deutlich mehr.
  const sim = await simulate(10, 21);
  const res = check(sim, 0.04, 0.1);
  assert.ok(res.median < 0.04);
});
