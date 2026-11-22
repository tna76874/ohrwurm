// Kryptografie über WebCrypto:
// - Gruppenschlüssel (AES-256-GCM) aus dem Einladungslink verschlüsselt alles.
// - Jedes Gerät signiert seine Ops mit einem eigenen ECDSA-P-256-Schlüssel.
//   Private Schlüssel sind nicht exportierbar und verlassen das Gerät nie.

const te = new TextEncoder();
const td = new TextDecoder();

export function b64uEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64u(n = 32): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(n)));
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? te.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

// ---------- Gruppenschlüssel ----------

export const newGroupKey = () => randomB64u(32);

export function importGroupKey(raw: string): Promise<CryptoKey> {
  const bytes = b64uDecode(raw);
  if (bytes.length !== 32) throw new Error('ungültiger Gruppenschlüssel');
  return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Kurzer, vorlesbarer Code zum Vergleichen, ob alle denselben Schlüssel haben. */
export async function keyCode(raw: string): Promise<string> {
  const h = b64uEncode(await sha256(b64uDecode(raw))).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
}

export async function seal(key: CryptoKey, aad: string, obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, te.encode(JSON.stringify(obj))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64uEncode(out);
}

export async function open<T>(key: CryptoKey, aad: string, data: string): Promise<T> {
  const raw = b64uDecode(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: te.encode(aad) }, key, raw.slice(12));
  return JSON.parse(td.decode(pt)) as T;
}

// ---------- Signaturen ----------

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export function generateSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(k: CryptoKey): Promise<string> {
  return b64uEncode(await crypto.subtle.exportKey('raw', k));
}

export function importVerifyKey(pub: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64uDecode(pub) as BufferSource, ECDSA, false, ['verify']);
}

/** Peer-ID = Hash des Signaturschlüssels → nicht fälschbar. */
export async function peerIdFor(pub: string): Promise<string> {
  return b64uEncode(await sha256(b64uDecode(pub))).slice(0, 22);
}

export async function sign(priv: CryptoKey, data: string): Promise<string> {
  return b64uEncode(await crypto.subtle.sign(SIGN, priv, te.encode(data)));
}

export async function verify(pub: CryptoKey, sig: string, data: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(SIGN, pub, b64uDecode(sig) as BufferSource, te.encode(data));
  } catch {
    return false;
  }
}
