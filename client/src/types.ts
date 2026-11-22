export interface Identity {
  sub: string;
  name: string;
}

/** Verschlüsselte Nutzlast Teilnehmer → Host. */
export interface SegPayload {
  k: 'seg';
  seq: number;
  t0: number;
  t1: number;
  text: string;
  rms: number;
  speaker: string;
}
export type P2H =
  | { k: 'hello'; name: string; idToken?: string; device: DeviceInfo }
  | SegPayload
  | { k: 'retract'; seqs: number[] };

/** Verschlüsselte Nutzlast Host → Teilnehmer. */
export type H2P =
  | { k: 'ack'; seqs: number[] }
  | { k: 'rack'; seqs: number[] }
  | { k: 'state'; recording: boolean; title: string };

export interface DeviceInfo {
  ua: string;
  asr?: string;
}

export interface Segment {
  id: string;
  sid: string;
  peer: string;
  seq: number;
  t0: number;
  t1: number;
  text: string;
  rms: number;
  speaker: string;
  retracted?: boolean;
}

export interface PeerRec {
  peer: string;
  pub: string;
  user: Identity;
  label?: string;
  verified?: boolean;
  device?: DeviceInfo;
}

export interface AgendaItem {
  t: number;
  title: string;
}

export interface LlmSettings {
  url: string;
  model: string;
  apiKey?: string;
}

export interface HostSession {
  sid: string;
  title: string;
  created: number;
  keyPair: CryptoKeyPair;
  pub: string;
  fp: string;
  peers: Record<string, PeerRec>;
  agenda: AgendaItem[];
  recording: boolean;
  hostSeq: number;
  hostSpeaker?: string;
  llm?: LlmSettings;
  summary?: { text: string; created: number; model: string };
  ended?: boolean;
}

export interface PartSession {
  sid: string;
  fp: string;
  keyPair: CryptoKeyPair;
  pub: string;
  peer: string;
  seq: number;
  joined: number;
  speaker: string;
  hostPub?: string;
  title?: string;
  ended?: boolean;
}

export interface OutEntry {
  id: string;
  sid: string;
  seq: number;
  seg: SegPayload;
  acked: boolean;
  retracted?: boolean;
  retractAcked?: boolean;
  lastSent?: number;
}
