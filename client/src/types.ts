export interface Identity {
  sub: string;
  name: string;
}

// ---------- Op-Log (signiert, repliziert auf alle Geräte) ----------

export type OpBody =
  | { type: 'member'; signPub: string; name: string; device: string }
  | { type: 'seg'; t0: number; t1: number; text: string; rms: number; speaker: string }
  | { type: 'edit'; seg: string; text: string; via?: 'llm' }
  | { type: 'speaker'; seg: string; speaker: string }
  | { type: 'hide'; seg: string; hidden: boolean }
  | { type: 'flag'; seg: string; flagged: boolean }
  | { type: 'agenda'; id: string; title: string; t: number; deleted?: boolean }
  | { type: 'title'; title: string }
  | { type: 'pause'; recording: boolean }
  | { type: 'summary'; model: string; text: string }
  // Raumplan: „Wo bin ich?“-Einmessen per Ultraschall-Chirp
  | { type: 'locate'; id: string; force?: boolean }
  | { type: 'locjoin'; id: string }
  | { type: 'locmeas'; id: string; peers: string[]; fs: number; p: number[]; q: number[] }
  | { type: 'seat'; peer: string; x: number | null; y: number | null }
  | { type: 'locview'; rot: number; flip: boolean };

/** Ein Eintrag im Op-Log: Autor (Peer-ID), Sequenz, Lamport-Uhr, Zeit, Inhalt, Signatur. */
export interface Op {
  a: string;
  s: number;
  l: number;
  t: number;
  b: OpBody;
  sig: string;
}

/** Stand je Autor: höchste lückenlos vorhandene Sequenznummer. */
export type SV = Record<string, number>;

/** Verschlüsselte Nachrichten zwischen Geräten. */
export type Envelope =
  | { k: 'ops'; ops: Op[] }
  | { k: 'hello'; sv: SV }
  | { k: 'sv'; sv: SV }
  | { k: 'want'; a: string; from: number };

// ---------- Lokale Sitzungsdaten ----------

export interface MeshSession {
  sid: string;
  /** Gruppenschlüssel (base64url), steht auch im Einladungslink. */
  key: string;
  signKeyPair: CryptoKeyPair;
  signPub: string;
  peer: string;
  joined: number;
  speaker: string;
  /** Vom Relay bestätigte Identitäten je Peer (erste Bestätigung gewinnt). */
  attested: Record<string, Identity>;
  title?: string;
}

export interface LlmSettings {
  url: string;
  model: string;
  apiKey?: string;
}
