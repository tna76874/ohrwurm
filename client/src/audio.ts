// Mikrofonzugriff. Grundsatz: Das Mikrofon ist aus, bis der Mensch vor dem
// Gerät es einschaltet. Beim Ausschalten wird der Audio-Track wirklich beendet,
// sodass auch die Mikrofonanzeige von Browser/Betriebssystem erlischt.

export interface Utterance {
  audio: Float32Array;
  t0: number;
  t1: number;
  rms: number;
}

export type MicState = 'off' | 'starting' | 'on';

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export class Mic {
  state: MicState = 'off';
  autoOffMs = 90_000;
  onUtterance?: (u: Utterance) => void;
  onLevel?: (rms: number, speech: boolean) => void;
  onState?: (s: MicState, reason?: string) => void;

  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private wake?: WakeLockSentinelLike;
  private lastSpeech = 0;
  private idleTimer?: number;
  private stopping = false;

  constructor(private now: () => number) {}

  private set(s: MicState, reason?: string) {
    this.state = s;
    this.onState?.(s, reason);
  }

  async start() {
    if (this.state !== 'off') return;
    this.set('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule('/worklet.js');
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'ohrwurm-vad');
      this.node.port.onmessage = (e: MessageEvent) => this.onWorklet(e.data as Record<string, unknown>);
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.node).connect(mute).connect(this.ctx.destination);
      await this.ctx.resume();
      try {
        const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
        this.wake = await wl?.request('screen');
      } catch {
        /* Wake Lock optional */
      }
      this.lastSpeech = Date.now();
      this.idleTimer = window.setInterval(() => {
        if (Date.now() - this.lastSpeech > this.autoOffMs) void this.stop('auto');
      }, 1000);
      this.set('on');
    } catch (e) {
      await this.teardown();
      this.set('off', 'error');
      throw e;
    }
  }

  private onWorklet(m: Record<string, unknown>) {
    if (m.type === 'level') {
      if (m.speech) this.lastSpeech = Date.now();
      this.onLevel?.(Number(m.rms), Boolean(m.speech));
    } else if (m.type === 'segment') {
      const audio = m.samples as Float32Array;
      const t1 = this.now();
      const t0 = t1 - (audio.length / 16000) * 1000;
      this.lastSpeech = Date.now();
      this.onUtterance?.({ audio, t0, t1, rms: Number(m.rms) });
    }
  }

  /** Beendet die Aufnahme. Ein laufender Satz wird noch abgeschlossen. */
  async stop(reason?: string) {
    if (this.state !== 'on' || this.stopping) return;
    this.stopping = true;
    try {
      this.node?.port.postMessage({ type: 'flush' });
      await new Promise((r) => setTimeout(r, 150));
      await this.teardown();
      this.set('off', reason);
    } finally {
      this.stopping = false;
    }
  }

  private async teardown() {
    clearInterval(this.idleTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.node = undefined;
    try {
      await this.ctx?.close();
    } catch {
      /* bereits geschlossen */
    }
    this.ctx = undefined;
    try {
      await this.wake?.release();
    } catch {
      /* egal */
    }
    this.wake = undefined;
  }
}
