export interface AsrState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  model?: string;
  device?: string;
  progress?: number;
  message?: string;
  queue: number;
}

export interface AsrSettings {
  model: string;
  device: 'auto' | 'webgpu' | 'wasm';
  language: string;
}

const SETTINGS = 'ohrwurm.asr';

export function loadAsrSettings(models: string[]): AsrSettings {
  let s: Partial<AsrSettings> = {};
  try {
    s = JSON.parse(localStorage.getItem(SETTINGS) || '{}') as Partial<AsrSettings>;
  } catch {
    /* Standardwerte */
  }
  const fallback = models.find((m) => m.endsWith('whisper-base')) ?? models[0] ?? '';
  return {
    model: s.model && models.includes(s.model) ? s.model : fallback,
    device: s.device ?? 'auto',
    language: s.language ?? 'de',
  };
}

export function saveAsrSettings(s: AsrSettings) {
  localStorage.setItem(SETTINGS, JSON.stringify(s));
}

class Transcriber {
  state: AsrState = { phase: 'idle', queue: 0 };
  private worker?: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  private files = new Map<string, { loaded: number; total: number }>();
  private listeners = new Set<(s: AsrState) => void>();
  private key = '';

  onState(f: (s: AsrState) => void): () => void {
    this.listeners.add(f);
    f(this.state);
    return () => this.listeners.delete(f);
  }

  private set(p: Partial<AsrState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((f) => f(this.state));
  }

  load(s: AsrSettings) {
    const key = `${s.model}|${s.device}|${s.language}`;
    if (!s.model || (key === this.key && this.state.phase !== 'error')) return;
    this.key = key;
    this.worker?.terminate();
    this.pending.forEach((p) => p.reject(new Error('Modell gewechselt')));
    this.pending.clear();
    this.files.clear();
    const w = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (e: MessageEvent) => this.onMessage(e.data as Record<string, unknown>);
    w.onerror = (e) => this.set({ phase: 'error', message: e.message || 'Fehler im Spracherkennungs-Worker' });
    this.set({ phase: 'loading', model: s.model, device: undefined, progress: 0, message: undefined, queue: 0 });
    w.postMessage({ type: 'load', model: s.model, device: s.device, language: s.language });
  }

  private onMessage(m: Record<string, unknown>) {
    switch (m.type) {
      case 'progress': {
        if (m.status === 'fallback') {
          this.set({ message: 'WebGPU nicht nutzbar – weiter mit WASM' });
          return;
        }
        if (typeof m.file === 'string' && typeof m.total === 'number' && m.total > 0) {
          this.files.set(m.file, { loaded: Number(m.loaded) || 0, total: m.total });
          let loaded = 0;
          let total = 0;
          this.files.forEach((f) => {
            loaded += f.loaded;
            total += f.total;
          });
          this.set({ progress: total ? loaded / total : 0 });
        }
        return;
      }
      case 'ready':
        this.set({ phase: 'ready', device: String(m.device), progress: 1, message: undefined });
        return;
      case 'result': {
        const p = this.pending.get(Number(m.id));
        this.pending.delete(Number(m.id));
        this.set({ queue: this.pending.size });
        p?.resolve(String(m.text ?? ''));
        return;
      }
      case 'error': {
        if (m.id != null) {
          const p = this.pending.get(Number(m.id));
          this.pending.delete(Number(m.id));
          this.set({ queue: this.pending.size });
          p?.reject(new Error(String(m.message)));
        } else {
          this.set({ phase: 'error', message: String(m.message) });
        }
      }
    }
  }

  transcribe(audio: Float32Array): Promise<string> {
    if (!this.worker || this.state.phase === 'error' || this.state.phase === 'idle') {
      return Promise.reject(new Error('Kein Spracherkennungsmodell geladen'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.set({ queue: this.pending.size });
      this.worker!.postMessage({ type: 'transcribe', id, audio }, [audio.buffer]);
    });
  }
}

export const transcriber = new Transcriber();

// Typische Whisper-Halluzinationen bei Stille oder Rauschen.
const JUNK = [
  /^untertitel/i,
  /amara\.org/i,
  /^copyright/i,
  /(zuschauen|zuhören|zusehen)[.!]?$/i,
  /^\W*$/,
  /^[[(*].*[\])*]$/,
  /^(musik|applaus|lachen)[.!]?$/i,
  /^(thank you|thanks for watching)[.!]?$/i,
];

export function cleanText(t: string): string | null {
  const s = t.replace(/\s+/g, ' ').trim();
  if (!s || JUNK.some((r) => r.test(s))) return null;
  return s;
}
