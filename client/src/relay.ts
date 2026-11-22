// WebSocket-Verbindung zum Relay inkl. Wiederverbindung und Zeitsynchronisation.
import type { Identity } from './types';

export type RelayMsg = { t: string; [k: string]: unknown };
export type RelayStatus = 'connecting' | 'online' | 'offline' | 'noauth';

export class Relay {
  status: RelayStatus = 'offline';
  user?: Identity;
  private ws?: WebSocket;
  private listeners = new Set<(m: RelayMsg) => void>();
  private readyHooks = new Set<() => void>();
  private statusHooks = new Set<(s: RelayStatus) => void>();
  private offset = 0;
  private bestRtt = Infinity;
  private lastSync = 0;
  private pingTimer?: number;
  private retry = 0;
  private started = false;

  constructor(private token: () => Promise<string | null>) {}

  start() {
    if (this.started) return;
    this.started = true;
    void this.open();
  }

  private setStatus(s: RelayStatus) {
    this.status = s;
    this.statusHooks.forEach((f) => f(s));
  }

  private async open() {
    this.setStatus('connecting');
    let token: string | null = null;
    try {
      token = await this.token();
    } catch {
      token = null;
    }
    if (!token) {
      this.setStatus('noauth');
      return;
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token }));
    ws.onmessage = (e) => {
      let m: RelayMsg;
      try {
        m = JSON.parse(String(e.data)) as RelayMsg;
      } catch {
        return;
      }
      switch (m.t) {
        case 'authok':
          this.user = m.user as Identity;
          this.retry = 0;
          this.setStatus('online');
          this.ping();
          this.pingTimer = window.setInterval(() => this.ping(), 10_000);
          this.readyHooks.forEach((f) => f());
          return;
        case 'autherror':
          this.setStatus('noauth');
          this.ws = undefined;
          ws.close();
          return;
        case 'pong':
          this.onPong(m);
          return;
      }
      this.listeners.forEach((f) => f(m));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.pingTimer);
      this.setStatus('offline');
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => void this.open(), delay);
    };
  }

  send(m: Record<string, unknown>): boolean {
    if (this.status !== 'online' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  on(f: (m: RelayMsg) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Wird bei jeder (Wieder-)Verbindung aufgerufen, sofort falls schon online. */
  onReady(f: () => void): () => void {
    this.readyHooks.add(f);
    if (this.status === 'online') f();
    return () => this.readyHooks.delete(f);
  }

  onStatus(f: (s: RelayStatus) => void): () => void {
    this.statusHooks.add(f);
    f(this.status);
    return () => this.statusHooks.delete(f);
  }

  /** Gemeinsame Zeitbasis aller Clients (Serverzeit in ms). */
  now(): number {
    return Date.now() + this.offset;
  }

  private ping() {
    this.send({ t: 'ping', c: Date.now() });
  }

  private onPong(m: RelayMsg) {
    const now = Date.now();
    const rtt = now - Number(m.c);
    if (!(rtt >= 0)) return;
    if (rtt <= this.bestRtt * 1.5 || now - this.lastSync > 60_000) {
      this.offset = Number(m.s) + rtt / 2 - now;
      this.bestRtt = Math.min(this.bestRtt, rtt);
      this.lastSync = now;
    }
  }
}
