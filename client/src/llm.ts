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

/**
 * Macht aus Eingaben wie „localhost:1234“ oder „http://localhost:11434/“ die
 * OpenAI-kompatible Basis-URL „http://localhost:1234/v1“.
 */
export function normalizeBase(input: string): string {
  let s = input.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${path || '/v1'}`;
  } catch {
    return s;
  }
}

export function llmOriginAllowed(url: string, allowed: string[]): boolean {
  try {
    const origin = new URL(normalizeBase(url)).origin;
    return origin === location.origin || allowed.includes(origin);
  } catch {
    return false;
  }
}

/** fetch mit verständlicher Fehlermeldung, wenn der Browser gar nicht durchkommt. */
async function llmFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(
      `Keine Verbindung zu ${new URL(url).origin}. Läuft das KI-Programm (LM Studio, Ollama)? ` +
        'Bei LM Studio im Server-Tab „Enable CORS“ einschalten, bei Ollama OLLAMA_ORIGINS setzen. ' +
        'Fragt der Browser nach Zugriff auf lokale Geräte, bitte erlauben.',
    );
  }
}

async function chat(cfg: LlmSettings, messages: Msg[], signal: AbortSignal): Promise<string> {
  const res = await llmFetch(`${normalizeBase(cfg.url)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, stream: false }),
  });
  if (!res.ok) throw new Error(`KI-Endpunkt antwortet mit HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
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
  const res = await llmFetch(`${normalizeBase(cfg.url)}/models`, {
    signal,
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`KI-Endpunkt antwortet mit HTTP ${res.status}`);
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

export interface Correction {
  id: string;
  before: string;
  text: string;
}

function parseJsonArray(raw: string): unknown[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Korrekturvorschläge für Erkennungsfehler. Das Modell bekommt nummerierte Zeilen
 * und liefert nur geänderte Zeilen zurück. Übernommen wird erst, was ein Mensch bestätigt.
 */
export async function correct(
  cfg: LlmSettings,
  lines: { id: string; speaker: string; text: string }[],
  glossary: string,
  onProgress: (msg: string) => void,
  signal: AbortSignal,
  perChunk = 40,
): Promise<Correction[]> {
  const out: Correction[] = [];
  const byKey = new Map<string, { id: string; text: string }>();
  for (let i = 0; i < lines.length; i += perChunk) {
    const chunk = lines.slice(i, i + perChunk);
    onProgress(`Prüfe Zeilen ${i + 1}–${i + chunk.length} von ${lines.length} …`);
    const numbered = chunk.map((l, j) => {
      const key = String(i + j + 1);
      byKey.set(key, l);
      return { nr: key, sprecher: l.speaker, text: l.text };
    });
    const answer = await chat(
      cfg,
      [
        {
          role: 'system',
          content:
            'Du korrigierst Transkripte aus automatischer Spracherkennung. Korrigiere nur offensichtliche Erkennungsfehler: ' +
            'Rechtschreibung, Zeichensetzung, falsch verstandene Wörter, Eigennamen und Fachbegriffe. ' +
            'Formuliere nicht um, kürze nicht, ergänze nichts, ändere nie den Sinn. ' +
            'Antworte ausschließlich mit einem JSON-Array der Form [{"nr":"…","text":"…"}] – nur für Zeilen, die du änderst. ' +
            'Wenn nichts zu korrigieren ist, antworte mit [].',
        },
        {
          role: 'user',
          content: `${glossary.trim() ? `Bekannte Namen und Fachbegriffe: ${glossary.trim()}\n\n` : ''}${JSON.stringify(numbered)}`,
        },
      ],
      signal,
    );
    for (const item of parseJsonArray(answer)) {
      const r = item as { nr?: unknown; text?: unknown };
      const src = byKey.get(String(r.nr));
      if (!src || typeof r.text !== 'string') continue;
      const text = r.text.trim();
      if (text && text !== src.text.trim()) out.push({ id: src.id, before: src.text, text });
    }
  }
  return out;
}
