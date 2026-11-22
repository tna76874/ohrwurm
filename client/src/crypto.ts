// Ende-zu-Ende-Verschlüsselung zwischen Teilnehmer und Host.
// ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, alles über WebCrypto.
// Private Schlüssel sind nicht exportierbar und verlassen das Gerät nie.

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

export function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(k: CryptoKey): Promise<string> {
  return b64uEncode(await crypto.subtle.exportKey('raw', k));
}

function importPublicKey(pub: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64uDecode(pub) as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** Fingerprint eines öffentlichen Schlüssels (132 Bit, base64url). */
export async function fingerprint(pub: string): Promise<string> {
  return b64uEncode(await sha256(b64uDecode(pub))).slice(0, 22);
}

/** Kurzform zum Vorlesen/Vergleichen. */
export function shortFp(fp: string): string {
  return `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}`.toUpperCase();
}

export async function deriveSessionKey(priv: CryptoKey, otherPub: string, sid: string): Promise<CryptoKey> {
  const pub = await importPublicKey(otherPub);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(sid), info: te.encode('ohrwurm/v1') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Verschlüsselt ein Objekt; aad bindet Session, Peer und Richtung. */
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
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: te.encode(aad) },
    key,
    raw.slice(12),
  );
  return JSON.parse(td.decode(pt)) as T;
}
