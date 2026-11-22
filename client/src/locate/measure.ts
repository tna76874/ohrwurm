// Auswertung der eigenen Aufnahme: Für jede geplante Emission im passenden
// Zeitfenster nach dem Chirp suchen.
import { CHIRP, detect } from './dsp';
import { LEAD_MS, emitTime, type Plan } from './solve';

/** Suchfenster relativ zum Slot-Anfang (ms). Deckt Uhr-Ungenauigkeit (±40 ms)
 * und Audio-Latenzen (bis ~300 ms) ab, ohne in den nächsten Slot zu reichen. */
export const WINDOW_FROM_MS = -40;
export const WINDOW_TO_MS = 400;

/**
 * @param rec       Mikrofonaufnahme (ungefiltert)
 * @param fs        Abtastrate der Aufnahme
 * @param recStart  Mesh-Zeit (ms), die Sample 0 entspricht (ungefähr, ±Latenz)
 */
export async function measure(rec: Float32Array, fs: number, recStart: number, plan: Plan, onProgress?: (f: number) => void): Promise<{ p: number[]; q: number[] }> {
  const p: number[] = [];
  const q: number[] = [];
  const chirpMs = CHIRP.dur * 1000;
  for (const [k, e] of plan.emissions.entries()) {
    const slotStart = emitTime(plan, e) - LEAD_MS;
    const from = ((slotStart + WINDOW_FROM_MS - recStart) / 1000) * fs;
    const len = ((WINDOW_TO_MS - WINDOW_FROM_MS + chirpMs) / 1000) * fs;
    const d = detect(rec, fs, e.code, from, len);
    p.push(d ? Math.round(d.pos * 100) / 100 : -1);
    q.push(d ? Math.round(d.snr) : 0);
    if (k % 8 === 7) {
      onProgress?.((k + 1) / plan.emissions.length);
      await new Promise((r) => setTimeout(r, 0)); // Oberfläche nicht blockieren
    }
  }
  return { p, q };
}
