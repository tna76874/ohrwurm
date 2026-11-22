// Signalverarbeitung fürs Einmessen: Chirp erzeugen und im eigenen Mikrofonsignal
// wiederfinden (Matched Filter über FFT, Hüllkurve, erster Peak statt stärkstem,
// damit Echos nicht gewinnen). Reine Funktionen, ohne DOM – testbar in Node.

export const CHIRP = {
  /** Frequenzband in Hz. Oberhalb dessen, was die meisten Erwachsenen hören. */
  f0: 17_500,
  f1: 20_500,
  /** Dauer in s */
  dur: 0.04,
  /** Anteil der Ein-/Ausblendung (Tukey), verhindert hörbares Knacken. */
  taper: 0.25,
  amp: 0.9,
};

/** Signal-Rausch-Verhältnis (Peak zu Median der Hüllkurve), ab dem ein Fund zählt. */
export const MIN_SNR = 7;

/** Chirp-Code 0 = aufwärts, 1 = abwärts. Beide sind gegeneinander nahezu orthogonal. */
export function chirpAt(t: number, code: number): number {
  const { f0, f1, dur, taper } = CHIRP;
  if (t < 0 || t >= dur) return 0;
  const [a, b] = code === 1 ? [f1, f0] : [f0, f1];
  const phase = 2 * Math.PI * (a * t + ((b - a) * t * t) / (2 * dur));
  const edge = taper * dur * 0.5;
  let w = 1;
  if (t < edge) w = 0.5 - 0.5 * Math.cos((Math.PI * t) / edge);
  else if (t > dur - edge) w = 0.5 - 0.5 * Math.cos((Math.PI * (dur - t)) / edge);
  return w * Math.sin(phase);
}

export function chirp(fs: number, code: number): Float32Array<ArrayBuffer> {
  const n = Math.round(CHIRP.dur * fs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = CHIRP.amp * chirpAt(i / fs, code);
  return out;
}

// ---------- FFT (radix 2, in place) ----------

export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

const tplCache = new Map<string, { re: Float64Array; im: Float64Array; len: number }>();

function template(fs: number, code: number, size: number) {
  const key = `${fs}:${code}:${size}`;
  let t = tplCache.get(key);
  if (!t) {
    const c = chirp(fs, code);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    re.set(c);
    fft(re, im);
    t = { re, im, len: c.length };
    if (tplCache.size > 16) tplCache.clear();
    tplCache.set(key, t);
  }
  return t;
}

export interface Detection {
  /** Sample-Position (Anfang des Chirps) im Signal, mit Sub-Sample-Genauigkeit */
  pos: number;
  snr: number;
}

/**
 * Sucht den Chirp `code` im Signal zwischen `from` und `from + len` (Sample-Indizes).
 * Gibt die erste deutliche Ankunft zurück (Direktschall vor Echo) oder null.
 */
export function detect(sig: Float32Array, fs: number, code: number, from: number, len: number, minSnr = MIN_SNR): Detection | null {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(sig.length, Math.floor(from + len));
  if (b - a < 16) return null;
  const tplLen = Math.round(CHIRP.dur * fs);
  const size = pow2(b - a + tplLen);
  const t = template(fs, code, size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = a; i < b; i++) re[i - a] = sig[i];
  fft(re, im);
  // Kreuzkorrelation = IFFT(X · conj(T)); nur positive Frequenzen (doppelt) →
  // analytisches Signal, dessen Betrag die Hüllkurve ist.
  const half = size >> 1;
  for (let k = 0; k < size; k++) {
    const xr = re[k];
    const xi = im[k];
    let r = xr * t.re[k] + xi * t.im[k];
    let i = xi * t.re[k] - xr * t.im[k];
    if (k === 0 || k === half) {
      /* unverändert */
    } else if (k < half) {
      r *= 2;
      i *= 2;
    } else {
      r = 0;
      i = 0;
    }
    re[k] = r;
    im[k] = i;
  }
  fft(re, im, true);
  const n = b - a - tplLen;
  if (n < 8) return null;
  const env = new Float64Array(n);
  let max = 0;
  for (let k = 0; k < n; k++) {
    env[k] = Math.hypot(re[k], im[k]);
    if (env[k] > max) max = env[k];
  }
  if (max <= 0) return null;
  const sorted = Float64Array.from(env).sort();
  const median = sorted[n >> 1] || 1e-12;
  const snr = max / median;
  if (snr < minSnr) return null;
  // Erste Stelle über der halben Maximalhöhe, dann das lokale Maximum dahinter.
  let k = 0;
  while (k < n && env[k] < 0.5 * max) k++;
  const span = Math.max(4, Math.round(fs / (CHIRP.f1 - CHIRP.f0)) * 2);
  let best = k;
  for (let j = k; j < Math.min(n, k + span); j++) if (env[j] > env[best]) best = j;
  // Echter Treffer = schmaler Peak (~fs/Bandbreite). Ein lauter Chirp mit dem
  // anderen Code erzeugt dagegen ein breites Plateau → verwerfen.
  const lvl = 0.5 * env[best];
  let lo = best;
  let hi = best;
  while (lo > 0 && env[lo - 1] >= lvl) lo--;
  while (hi < n - 1 && env[hi + 1] >= lvl) hi++;
  if (hi - lo > 2 * span) return null;
  // Parabolische Interpolation für Sub-Sample-Genauigkeit.
  let off = 0;
  if (best > 0 && best < n - 1) {
    const y0 = env[best - 1];
    const y1 = env[best];
    const y2 = env[best + 1];
    const den = y0 - 2 * y1 + y2;
    if (den < 0) off = (0.5 * (y0 - y2)) / den;
  }
  return { pos: a + best + off, snr: env[best] / median };
}
