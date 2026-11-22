// Zusammenfassung über einen OpenAI-kompatiblen Endpunkt (Ollama, llama.cpp, vLLM),
// entweder auf localhost oder im Firmennetz. Welche Origins erlaubt sind,
// legt der Betreiber über die CSP fest (OHRWURM_LLM_ORIGINS).
import type { LlmSettings } from './types';

interface Msg {
  role: 'system' | 'user';
  content: string;
}

const SYSTEM =
  'Du bist ein sorgfältiger Protokollführer. Du arbeitest ausschließlich mit dem gelieferten Transkript. ' +
  'Erfinde nichts. Nenne Personen so, wie sie im Transkript stehen. Kennzeichne Unklares ausdrücklich. ' +
  'Das Transkript stammt aus automatischer Spracherkennung und kann Hörfehler enthalten. Antworte auf Deutsch in Markdown.';

export function llmOriginAllowed(url: string, allowed: string[]): boolean {
  try {
    return allowed.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

async function chat(cfg: LlmSettings, messages: Msg[], signal: AbortSignal): Promise<string> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, stream: false }),
  });
  if (!res.ok) throw new Error(`LLM-Endpunkt: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('LLM-Antwort ohne Inhalt');
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > max && cur) {
      out.push(cur);
      cur = '';
    }
    cur += `${line}\n`;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export async function listModels(cfg: LlmSettings, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/models`, {
    signal,
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}

/**
 * Map-Reduce: erst jeden Abschnitt (ggf. in Teilen) zusammenfassen,
 * dann ein Gesamtprotokoll mit Beschlüssen und Aufgaben erstellen.
 */
export async function summarize(
  cfg: LlmSettings,
  title: string,
  secs: { title: string; text: string }[],
  onProgress: (msg: string) => void,
  signal: AbortSignal,
  chunkChars = 12_000,
): Promise<string> {
  const partials: string[] = [];
  const work = secs.filter((s) => s.text.trim());
  if (!work.length) throw new Error('Das Protokoll ist noch leer');
  for (const [i, s] of work.entries()) {
    const parts = chunks(s.text, chunkChars);
    const notes: string[] = [];
    for (const [j, part] of parts.entries()) {
      onProgress(`Abschnitt ${i + 1}/${work.length}${parts.length > 1 ? `, Teil ${j + 1}/${parts.length}` : ''} …`);
      notes.push(
        await chat(
          cfg,
          [
            { role: 'system', content: SYSTEM },
            {
              role: 'user',
              content:
                `Abschnitt „${s.title}“ der Sitzung „${title}“. Fasse diesen Ausschnitt in Stichpunkten zusammen. ` +
                `Halte fest: wer welche Position vertritt, Zahlen, Beschlüsse, Aufgaben (wer/was/bis wann) und offene Fragen.\n\n${part}`,
            },
          ],
          signal,
        ),
      );
    }
    partials.push(`### ${s.title}\n${notes.join('\n')}`);
  }
  onProgress('Gesamtprotokoll wird erstellt …');
  return chat(
    cfg,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Erstelle aus diesen Abschnittsnotizen der Sitzung „${title}“ ein Ergebnisprotokoll mit den Überschriften ` +
          '„Überblick“, „Ergebnisse je Tagesordnungspunkt“, „Beschlüsse“, „Aufgaben“ (Tabelle: Wer | Was | Bis wann) und „Offene Punkte“. ' +
          `Verwende Überschriften ab Ebene 3 (###).\n\n${partials.join('\n\n')}`,
      },
    ],
    signal,
  );
}
