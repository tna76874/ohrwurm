#!/bin/sh
# Lädt Whisper-ONNX-Modelle nach /models/<org>/<name>/.
# Pflicht: Dateien für WASM (q8). Optional: Dateien für WebGPU (fp32-Encoder, q4-Decoder).
set -eu

BASE="${HF_BASE:-https://huggingface.co}"
REQUIRED="config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json
onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx"
OPTIONAL="onnx/encoder_model.onnx onnx/decoder_model_merged_q4.onnx"

fetch() {
  repo="$1"; file="$2"; required="$3"
  dest="/models/$repo/$file"
  if [ -s "$dest" ]; then echo "  vorhanden  $file"; return 0; fi
  mkdir -p "$(dirname "$dest")"
  echo "  lade       $file"
  if curl -fL --retry 3 --silent --show-error -o "$dest.part" "$BASE/$repo/resolve/main/$file"; then
    mv "$dest.part" "$dest"
  else
    rm -f "$dest.part"
    if [ "$required" = 1 ]; then echo "FEHLER: $repo/$file fehlt" >&2; return 1; fi
    echo "  (optional, nicht verfügbar)"
  fi
}

[ "$#" -gt 0 ] || { echo "Aufruf: fetch-models.sh <org/modell> ..." >&2; exit 2; }
for repo in "$@"; do
  echo "$repo"
  for f in $REQUIRED; do fetch "$repo" "$f" 1; done
  for f in $OPTIONAL; do fetch "$repo" "$f" 0; done
done
echo "Fertig."
