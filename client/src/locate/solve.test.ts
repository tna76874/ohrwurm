import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Op, OpBody } from '../types';
import { JOIN_MS, QUORUM, VOTE_WINDOW_MS, buildLoc, mapPoints, phaseOf } from './model';
import { listHash, localize, makePlan, orient, planEnd, type Edge } from './solve';
import { alignedRms, gauss, rng } from './testutil';

test('Ablaufplan: jede Person sendet zweimal, zweite Runde rückwärts', () => {
  for (const n of [1, 2, 7, 25, 100]) {
    const peers = Array.from({ length: n }, (_, i) => `p${i}`);
    const p = makePlan(peers, 0);
    assert.equal(p.emissions.length, 2 * n);
    for (let i = 0; i < n; i++) assert.equal(p.emissions.filter((e) => e.idx === i).length, 2);
    // Gleicher Slot nur mit verschiedenen Codes
    const seen = new Set<string>();
    for (const e of p.emissions) {
      const k = `${e.slot}:${e.code}`;
      assert.ok(!seen.has(k), `Slot doppelt belegt: ${k}`);
      seen.add(k);
      assert.ok(e.code < p.codes && e.slot < p.slots);
    }
    if (n > 1) {
      const r2 = p.emissions.filter((e) => e.round === 1);
      assert.ok(r2[0].slot >= r2[n - 1].slot, 'Runde 2 läuft rückwärts');
    }
  }
  const big = makePlan(Array.from({ length: 100 }, (_, i) => `p${i}`), 0);
  assert.ok(planEnd(big) / 1000 < 50, `100 Geräte dauern ${planEnd(big) / 1000} s`);
});

test('listHash ist stabil und unterscheidet Listen', () => {
  assert.equal(listHash(['a', 'b']), listHash(['a', 'b']));
  assert.notEqual(listHash(['a', 'b']), listHash(['a', 'c']));
});

test('100 Plätze im Saal: Lokalisierung aus lückenhaften, verrauschten Abständen', () => {
  const r = rng(42);
  // 10 Reihen à 10 Plätze, 1 m Abstand, etwas versetzt
  const truth = Array.from({ length: 100 }, (_, i) => ({ x: (i % 10) * 1.0 + (r() - 0.5) * 0.3, y: Math.floor(i / 10) * 1.1 + (r() - 0.5) * 0.3 }));
  const edges: Edge[] = [];
  let outliers = 0;
  for (let i = 0; i < 100; i++) {
    for (let j = i + 1; j < 100; j++) {
      const d = Math.hypot(truth[i].x - truth[j].x, truth[i].y - truth[j].y);
      if (d > 5 || r() < 0.1) continue; // Reichweite, Verdeckung
      let m = d + 0.03 * gauss(r);
      if (r() < 0.02) {
        m += 1 + r() * 2; // Ausreißer (Echo statt Direktschall)
        outliers++;
      }
      edges.push({ i, j, d: m, w: 1 });
    }
  }
  assert.ok(outliers > 10);
  const t0 = Date.now();
  const pos = localize(100, edges);
  const ms = Date.now() - t0;
  assert.ok(pos.every(Boolean), 'alle verortet');
  const rms = alignedRms(pos.map((p) => p!), truth);
  console.log(`    100 Plätze, ${edges.length} Abstände (${outliers} Ausreißer): Karte ${(rms * 100).toFixed(1)} cm, ${ms} ms`);
  assert.ok(rms < 0.15, `RMS ${rms}`);
  assert.ok(pos.filter((p) => p!.sure).length > 90);
});

test('Einzelnes Gerät ohne Nachbarn bleibt unverortet', () => {
  const pos = localize(4, [
    { i: 0, j: 1, d: 1, w: 1 },
    { i: 1, j: 2, d: 1, w: 1 },
    { i: 0, j: 2, d: 1.4, w: 1 },
  ]);
  assert.ok(pos[0] && pos[1] && pos[2]);
  assert.equal(pos[3], null);
});

test('orient: das einmessende Gerät liegt oben', () => {
  const pos = orient(
    [
      { x: 2, y: 0, degree: 3, residual: 0, sure: true },
      { x: -1, y: 1, degree: 3, residual: 0, sure: true },
      { x: -1, y: -1, degree: 3, residual: 0, sure: true },
    ],
    0,
  );
  assert.ok(Math.abs(pos[0]!.x) < 1e-9 && pos[0]!.y < -1.9);
});

// ---------- Ops → Runden ----------

let seq = 0;
const op = (a: string, t: number, b: OpBody): Op => ({ a, s: ++seq, l: seq, t, b, sig: '' });
const members = new Set(['anna', 'ben', 'clara', 'david', 'emma', 'fritz']);

test(`„Wo bin ich?“ startet erst ab ${QUORUM} Stimmen – dann für alle`, () => {
  const ops = [op('anna', 1_000, { type: 'locate', id: 'r1aaaa' }), op('ben', 2_000, { type: 'locate', id: 'r2bbbb' }), op('clara', 3_000, { type: 'locate', id: 'r3cccc' })];
  let loc = buildLoc(ops, members);
  assert.equal(loc.rounds.length, 0);
  assert.equal(loc.votes.length, 3);
  // Doppelte Stimme zählt nicht
  ops.push(op('anna', 3_500, { type: 'locate', id: 'r4aaaa' }));
  assert.equal(buildLoc(ops, members).rounds.length, 0);
  ops.push(op('david', 4_000, { type: 'locate', id: 'r5dddd' }));
  loc = buildLoc(ops, members);
  assert.equal(loc.rounds.length, 1);
  const r = loc.rounds[0];
  assert.equal(r.id, 'r5dddd');
  assert.equal(r.by, 'anna', 'wer zuerst getippt hat, ist vorne');
  assert.deepEqual(r.plan.peers, ['anna', 'ben', 'clara', 'david']);
  assert.equal(r.at, 4_000 + JOIN_MS);
  assert.equal(loc.votes.length, 0);
  // Andere treten bis kurz vor dem Start bei, spätere zählen nicht
  ops.push(op('emma', r.cutoff - 10, { type: 'locjoin', id: 'r5dddd' }), op('fritz', r.cutoff + 10, { type: 'locjoin', id: 'r5dddd' }));
  const r2 = buildLoc(ops, members).rounds[0];
  assert.deepEqual(r2.plan.peers, ['anna', 'ben', 'clara', 'david', 'emma']);
  assert.equal(phaseOf(r2, r2.at - 1), 'join');
  assert.equal(phaseOf(r2, r2.plan.start + 10), 'run');
  assert.equal(phaseOf(r2, planEnd(r2.plan) + 10), 'analyze');
  assert.equal(phaseOf(r2, r2.end + 10), 'done');
  // Stimmen während der laufenden Runde zählen nicht
  ops.push(...['anna', 'ben', 'clara', 'david'].map((p, i) => op(p, r2.at + i, { type: 'locate', id: `x${i}xxxx` })));
  assert.equal(buildLoc(ops, members).rounds.length, 1);
});

test('Stimmen verfallen, „sofort“ startet ohne Quorum, Fremde zählen nicht', () => {
  const ops = [op('anna', 0, { type: 'locate', id: 'v1aaaa' }), op('ben', 1, { type: 'locate', id: 'v2bbbb' }), op('clara', 2, { type: 'locate', id: 'v3cccc' })];
  ops.push(op('david', VOTE_WINDOW_MS + 100, { type: 'locate', id: 'v4dddd' }));
  assert.equal(buildLoc(ops, members).rounds.length, 0, 'alte Stimmen verfallen');
  ops.push(op('mallory', VOTE_WINDOW_MS + 200, { type: 'locate', id: 'v5mmmm', force: true }));
  assert.equal(buildLoc(ops, members).rounds.length, 0, 'Nicht-Mitglied');
  ops.push(op('emma', VOTE_WINDOW_MS + 300, { type: 'locate', id: 'v6eeee', force: true }));
  const loc = buildLoc(ops, members);
  assert.equal(loc.rounds.length, 1);
  assert.deepEqual(loc.rounds[0].voters, ['david', 'emma']);
});

test('Manuelle Plätze überschreiben die Messung, Ansicht lässt sich drehen', () => {
  const ops = [op('anna', 0, { type: 'seat', peer: 'ben', x: 1.5, y: -2 }), op('ben', 5, { type: 'locview', rot: 5, flip: true })];
  const loc = buildLoc(ops, members);
  const { points } = mapPoints(loc);
  assert.deepEqual(points.map((p) => [p.peer, p.x, p.y, p.source]), [['ben', 1.5, -2, 'manual']]);
  assert.deepEqual(loc.view, { rot: 1, flip: true });
  ops.push(op('clara', 9, { type: 'seat', peer: 'ben', x: null, y: null }));
  assert.equal(mapPoints(buildLoc(ops, members)).points.length, 0);
});
