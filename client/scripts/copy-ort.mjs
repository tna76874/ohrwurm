// Kopiert die ONNX-Runtime-WASM-Dateien nach public/ort, damit der Browser sie
// vom eigenen Server lädt (statt von einem CDN – das würde die CSP blockieren).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [
  'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist',
  'node_modules/onnxruntime-web/dist',
];
const src = candidates.find((d) => existsSync(d));
if (!src) {
  console.error('onnxruntime-web nicht gefunden');
  process.exit(1);
}
const dest = 'public/ort';
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs')));
if (files.length === 0) {
  console.error(`keine ort-wasm-Dateien in ${src}`);
  process.exit(1);
}
for (const f of files) copyFileSync(join(src, f), join(dest, f));
console.log(`ONNX Runtime: ${files.length} Dateien aus ${src} nach ${dest} kopiert`);
