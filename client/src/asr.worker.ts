// Spracherkennung im Web Worker: Whisper über transformers.js (WebGPU oder WASM).
// Modelle und ONNX-Runtime kommen ausschließlich vom eigenen Server.
import { env, pipeline } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = true;
const onnx = (env.backends as unknown as { onnx?: { wasm?: { wasmPaths?: string } } }).onnx;
if (onnx?.wasm) onnx.wasm.wasmPaths = `${self.location.origin}/ort/`;

type Device = 'webgpu' | 'wasm';
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

let asr: Asr | null = null;
let ready: Promise<void> | null = null;
let language: string | undefined = 'de';
let chain: Promise<void> = Promise.resolve();

async function webgpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function create(model: string, device: Device): Promise<Asr> {
  const dtype =
    device === 'webgpu'
      ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
      : { encoder_model: 'q8', decoder_model_merged: 'q8' };
  const make = pipeline as unknown as (task: string, model: string, opts: Record<string, unknown>) => Promise<Asr>;
  return make('automatic-speech-recognition', model, {
    device,
    dtype,
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) =>
      post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total }),
  });
}

async function load(model: string, device: 'auto' | Device, lang: string) {
  language = lang === 'auto' ? undefined : lang;
  let dev: Device = device === 'auto' ? ((await webgpuAvailable()) ? 'webgpu' : 'wasm') : device;
  try {
    asr = await create(model, dev);
  } catch (e) {
    if (dev !== 'webgpu') throw e;
    post({ type: 'progress', status: 'fallback' });
    dev = 'wasm';
    asr = await create(model, dev);
  }
  post({ type: 'ready', device: dev, model });
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; id?: number; model?: string; device?: 'auto' | Device; language?: string; audio?: Float32Array };
  if (m.type === 'load') {
    ready = load(m.model!, m.device ?? 'auto', m.language ?? 'de');
    ready.catch((err: unknown) => post({ type: 'error', message: String((err as Error)?.message ?? err) }));
    return;
  }
  if (m.type === 'transcribe') {
    // Seriell abarbeiten: eine ONNX-Session verträgt keine parallelen Läufe.
    chain = chain.then(async () => {
      try {
        await ready;
        if (!asr) throw new Error('Modell nicht geladen');
        const out = await asr(m.audio!, { language, task: 'transcribe' });
        const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
        post({ type: 'result', id: m.id, text: String(text ?? '') });
      } catch (err) {
        post({ type: 'error', id: m.id, message: String((err as Error)?.message ?? err) });
      }
    });
  }
};
