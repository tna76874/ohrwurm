import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHIRP, chirpAt, detect, fft } from './dsp';
import { gauss, rng } from './testutil';

const FS = 48_000;

/** Signal mit Chirps an (gebrochenen) Sample-Positionen plus Rauschen. */
function signal(len: number, chirps: { pos: number; amp: number; code: number }[], noise: number, seed = 1) {
  const r = rng(seed);
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) s[i] = noise * gauss(r);
  for (const c of chirps) {
    const a = Math.floor(c.pos);
    const n = Math.ceil(CHIRP.dur * FS) + 2;
    for (let k = a; k < a + n && k < len; k++) s[k] += c.amp * CHIRP.amp * chirpAt((k - c.pos) / FS, c.code);
  }
  return s;
}

test('FFT: Hin- und Rücktransformation ergibt das Original', () => {
  const r = rng(3);
  const re = Float64Array.from({ length: 64 }, () => r() - 0.5);
  const im = new Float64Array(64);
  const orig = Float64Array.from(re);
  fft(re, im);
  fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('Chirp wird mit Sub-Sample-Genauigkeit gefunden, auch leise im Rauschen', () => {
  for (const [pos, amp] of [
    [5_000.37, 0.5],
    [12_345.8, 0.02],
    [801.5, 0.008],
  ]) {
    const s = signal(20_000, [{ pos, amp, code: 0 }], 0.01, Math.round(pos));
    const d = detect(s, FS, 0, 0, s.length);
    assert.ok(d, `nicht gefunden bei amp=${amp}`);
    assert.ok(Math.abs(d.pos - pos) < 1.5, `pos ${d.pos} statt ${pos}`);
  }
});

test('Erster Peak gewinnt: stärkeres Echo nach dem Direktschall wird ignoriert', () => {
  const direct = 6_000.25;
  const s = signal(20_000, [{ pos: direct, amp: 0.05, code: 0 }, { pos: direct + 240, amp: 0.08, code: 0 }], 0.003);
  const d = detect(s, FS, 0, 0, s.length);
  assert.ok(d);
  assert.ok(Math.abs(d.pos - direct) < 1.5, `Echo gewählt: ${d.pos}`);
});

test('Nur Rauschen → kein Fund', () => {
  const s = signal(30_000, [], 0.05, 9);
  assert.equal(detect(s, FS, 0, 0, s.length), null);
});

test('Auf- und Abwärts-Chirp lassen sich trennen', () => {
  const s = signal(20_000, [{ pos: 4_000, amp: 0.3, code: 0 }, { pos: 9_000, amp: 0.3, code: 1 }], 0.005);
  const up = detect(s, FS, 0, 0, s.length);
  const down = detect(s, FS, 1, 0, s.length);
  assert.ok(up && Math.abs(up.pos - 4_000) < 1.5, `up ${up?.pos}`);
  assert.ok(down && Math.abs(down.pos - 9_000) < 1.5, `down ${down?.pos}`);
});

test('Lauter Chirp mit anderem Code täuscht keinen Treffer vor', () => {
  // Nachbar sendet laut Code 0, gesucht wird ein weit entferntes Gerät mit Code 1
  const s = signal(20_000, [{ pos: 5_000, amp: 1, code: 0 }], 0.002, 5);
  assert.equal(detect(s, FS, 1, 0, s.length), null);
  // …und ein leiser echter Code-1-Chirp daneben wird trotzdem gefunden, wenn er deutlich ist
  const t = signal(20_000, [{ pos: 5_000, amp: 0.2, code: 0 }, { pos: 12_000.5, amp: 0.2, code: 1 }], 0.002, 6);
  const d = detect(t, FS, 1, 0, t.length);
  assert.ok(d && Math.abs(d.pos - 12_000.5) < 1.5, `pos ${d?.pos}`);
});

test('Suchfenster: Chirp außerhalb wird nicht gemeldet', () => {
  const s = signal(30_000, [{ pos: 20_000, amp: 0.5, code: 0 }], 0.01);
  assert.equal(detect(s, FS, 0, 0, 10_000), null);
});
