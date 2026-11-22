// OIDC Authorization Code Flow mit PKCE, komplett im Browser (öffentlicher Client).
import { decodeJwt } from 'jose';
import { b64uEncode, randomB64u, sha256 } from './crypto';

export interface AppConfig {
  auth: 'oidc' | 'dev';
  issuer?: string;
  clientId?: string;
  scopes?: string;
  llmOrigins: string[];
  models: string[];
}

let config: AppConfig;

export async function loadConfig(): Promise<AppConfig> {
  const r = await fetch('/api/config', { cache: 'no-store' });
  if (!r.ok) throw new Error(`Konfiguration: HTTP ${r.status}`);
  config = (await r.json()) as AppConfig;
  return config;
}

export const appConfig = () => config;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  jwks_uri: string;
}

let disc: Promise<Discovery> | undefined;
export function discovery(): Promise<Discovery> {
  disc ??= fetch(`${config.issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`).then((r) => {
    if (!r.ok) throw new Error(`OIDC-Discovery: HTTP ${r.status}`);
    return r.json() as Promise<Discovery>;
  });
  return disc;
}

interface Tokens {
  id: string;
  refresh?: string;
  exp: number;
  sub: string;
  name: string;
}

const TOKENS = 'ohrwurm.tokens';
const PKCE = 'ohrwurm.pkce';
const DEVNAME = 'ohrwurm.devname';

function saveTokens(t: Tokens) {
  sessionStorage.setItem(TOKENS, JSON.stringify(t));
}
function loadTokens(): Tokens | null {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS) || 'null') as Tokens | null;
  } catch {
    return null;
  }
}

const redirectUri = () => `${location.origin}/`;

export async function login(returnHash: string) {
  const d = await discovery();
  const verifier = randomB64u(48);
  const state = randomB64u(16);
  const nonce = randomB64u(16);
  const challenge = b64uEncode(await sha256(verifier));
  sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, nonce, returnHash }));
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId!,
    redirect_uri: redirectUri(),
    scope: config.scopes || 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  location.assign(u.toString());
}

function tokensFrom(json: Record<string, unknown>, prevRefresh?: string, nonce?: string): Tokens {
  const id = json.id_token;
  if (typeof id !== 'string') throw new Error('Kein ID-Token erhalten');
  const c = decodeJwt(id);
  if (nonce && c.nonce !== nonce) throw new Error('Nonce stimmt nicht überein');
  const name = c.name ?? c.preferred_username ?? c.email ?? c.sub;
  return {
    id,
    refresh: typeof json.refresh_token === 'string' ? json.refresh_token : prevRefresh,
    exp: c.exp ?? 0,
    sub: String(c.sub),
    name: String(name),
  };
}

async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
  const d = await discovery();
  const r = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!r.ok) throw new Error(`Token-Endpunkt: HTTP ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

/** Verarbeitet die Rückkehr vom IdP (?code=…). */
export async function handleCallback(): Promise<void> {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return;
  const saved = JSON.parse(sessionStorage.getItem(PKCE) || 'null') as {
    verifier: string;
    state: string;
    nonce: string;
    returnHash: string;
  } | null;
  sessionStorage.removeItem(PKCE);
  history.replaceState(null, '', `/${saved?.returnHash ?? ''}`);
  if (q.has('error')) throw new Error(`Anmeldung abgebrochen: ${q.get('error_description') || q.get('error')}`);
  if (!saved || saved.state !== q.get('state')) throw new Error('Ungültiger Anmeldestatus (state)');
  const json = await tokenRequest({
    grant_type: 'authorization_code',
    code: q.get('code')!,
    redirect_uri: redirectUri(),
    client_id: config.clientId!,
    code_verifier: saved.verifier,
  });
  saveTokens(tokensFrom(json, undefined, saved.nonce));
}

let refreshing: Promise<string | null> | undefined;

/** Liefert ein gültiges ID-Token (bzw. Dev-Token), erneuert bei Bedarf. */
export async function idToken(): Promise<string | null> {
  if (config.auth === 'dev') {
    const n = localStorage.getItem(DEVNAME);
    return n ? `dev:${n}` : null;
  }
  const t = loadTokens();
  if (!t) return null;
  if (t.exp * 1000 > Date.now() + 60_000) return t.id;
  if (!t.refresh) return null;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: config.clientId! })
    .then((json) => {
      const nt = tokensFrom(json, t.refresh);
      saveTokens(nt);
      return nt.id;
    })
    .catch(() => {
      sessionStorage.removeItem(TOKENS);
      return null;
    })
    .finally(() => (refreshing = undefined));
  return refreshing;
}

export function isLoggedIn(): boolean {
  return config.auth === 'dev' ? !!localStorage.getItem(DEVNAME) : !!loadTokens();
}

export function userName(): string {
  return (config.auth === 'dev' ? localStorage.getItem(DEVNAME) : loadTokens()?.name) ?? '';
}

export function devLogin(name: string) {
  localStorage.setItem(DEVNAME, name.trim().slice(0, 64));
}

export async function logout() {
  const t = loadTokens();
  sessionStorage.removeItem(TOKENS);
  localStorage.removeItem(DEVNAME);
  if (config.auth === 'oidc') {
    try {
      const d = await discovery();
      if (d.end_session_endpoint) {
        const u = new URL(d.end_session_endpoint);
        u.search = new URLSearchParams({
          client_id: config.clientId!,
          post_logout_redirect_uri: redirectUri(),
          ...(t ? { id_token_hint: t.id } : {}),
        }).toString();
        location.assign(u.toString());
        return;
      }
    } catch {
      /* lokal abmelden reicht */
    }
  }
  location.assign('/');
}

