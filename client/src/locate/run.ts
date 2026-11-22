// Einmessen im Browser: ungefiltertes Mikrofon öffnen, eigene Chirps zu den
// geplanten Zeiten abspielen, alles aufnehmen und lokal auswerten. Geteilt werden
// nur die gefundenen Sample-Positionen – kein Ton.
import { chirp } from './dsp';
import { measure } from './measure';
import { emitTime, planEnd, type Plan } from './solve';

export class CalibrationError extends Error {}
export class NeedsGesture extends CalibrationError {}

export class Calibrator {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private sources: AudioBufferSourceNode[] = [];

  constructor(private now: () => number) {}

  get ready() {
    return !!this.ctx;
  }

  /** Muss aus einer Nutzergeste heraus aufgerufen werden (Autoplay, Mikrofon). */
  async prepare() {
    if (this.ctx) return;
    // iOS: ohne das schaltet der Stummschalter die Wiedergabe stumm.
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    try {
      if (session) session.type = 'play-and-record';
    } catch {
      /* optional */
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;
    if (ctx.sampleRate < 44_100) {
      await this.dispose();
      throw new CalibrationError(`Dieses Gerät arbeitet nur mit ${ctx.sampleRate} Hz – zu wenig für Ultraschall.`);
    }
    await ctx.audioWorklet.addModule('/rec-worklet.js');
    const src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'ohrwurm-rec');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node).connect(mute).connect(ctx.destination);
    // Ohne frische Nutzergeste bleibt der Kontext auf manchen Geräten (iOS) stumm.
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 800))]);
    if (ctx.state !== 'running') {
      await this.dispose();
      throw new NeedsGesture('Bitte einmal auf „Mitmachen“ tippen.');
    }
  }

  /** Mesh-Zeit (ms) → AudioContext-Zeit (s) */
  private toCtx(mesh: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    const nowCtx = ts?.contextTime && ts.performanceTime ? ts.contextTime + (performance.now() - ts.performanceTime) / 1000 : ctx.currentTime;
    return nowCtx + (mesh - this.now()) / 1000;
  }

  /**
   * Führt den Plan aus. Gibt die Messung zurück (Sample-Positionen je Emission).
   * `onProgress` bekommt 0…1 und einen Text.
   */
  async run(plan: Plan, myIdx: number, onProgress: (f: number, msg: string) => void): Promise<{ fs: number; p: number[]; q: number[] }> {
    const ctx = this.ctx;
    const node = this.node;
    if (!ctx || !node) throw new CalibrationError('Audio nicht vorbereitet');
    await ctx.resume();
    const fs = ctx.sampleRate;
    const recStartMesh = plan.start - 300;
    const recEndMesh = planEnd(plan) + 500;
    const from = Math.round(this.toCtx(recStartMesh) * fs);
    const to = Math.round(this.toCtx(recEndMesh) * fs);
    if (from <= Math.round(ctx.currentTime * fs)) throw new CalibrationError('Zu spät gestartet');
    const rec = new Float32Array(to - from);
    const done = new Promise<void>((resolve) => {
      const timeout = window.setTimeout(resolve, recEndMesh - this.now() + 3_000);
      node.port.onmessage = (e: MessageEvent) => {
        const d = e.data as { type: string; frame: number; samples: Float32Array };
        if (d.type === 'chunk') {
          const off = d.frame - from;
          if (off >= 0 && off < rec.length) rec.set(d.samples.subarray(0, rec.length - off), off);
        } else if (d.type === 'done') {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
    node.port.postMessage({ type: 'window', from, to });

    const buf = [0, 1].map((code) => {
      const c = chirp(fs, code);
      const b = ctx.createBuffer(1, c.length, fs);
      b.copyToChannel(c, 0);
      return b;
    });
    for (const e of plan.emissions) {
      if (e.idx !== myIdx) continue;
      const when = this.toCtx(emitTime(plan, e));
      if (when <= ctx.currentTime + 0.02) continue;
      const s = ctx.createBufferSource();
      s.buffer = buf[e.code];
      s.connect(ctx.destination);
      s.start(when);
      this.sources.push(s);
    }

    const tick = window.setInterval(() => {
      const f = (this.now() - plan.start) / (planEnd(plan) - plan.start);
      onProgress(Math.max(0, Math.min(1, f)) * 0.9, 'Bitte kurz still sein …');
    }, 200);
    try {
      await done;
    } finally {
      clearInterval(tick);
    }
    node.port.onmessage = null;
    onProgress(0.9, 'Werte aus …');
    // Sample 0 der Aufnahme entspricht Frame `from` → Mesh-Zeit recStartMesh
    const res = await measure(rec, fs, recStartMesh, plan, (f) => onProgress(0.9 + 0.1 * f, 'Werte aus …'));
    return { fs, ...res };
  }

  async dispose() {
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* schon fertig */
      }
    });
    this.sources = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.node?.disconnect();
    this.node = undefined;
    try {
      await this.ctx?.close();
    } catch {
      /* egal */
    }
    this.ctx = undefined;
    try {
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'auto';
    } catch {
      /* optional */
    }
  }
}
