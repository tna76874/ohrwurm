// Das Mesh: Jedes Gerät hält eine vollständige, signierte Kopie des Op-Logs und
// gleicht sie mit allen anderen ab. Es gibt keinen Host – fällt ein Gerät aus,
// haben die anderen längst alles.
//
// Sync-Protokoll (über den Relay, Ende-zu-Ende-verschlüsselt mit dem Gruppenschlüssel):
//   ops   – neue Ops (live an alle) oder Antwort auf want (direkt)
//   hello – "das ist mein Stand" beim (Wieder-)Beitritt, an alle
//   sv    – Stand als Antwort auf hello bzw. periodisch
//   want  – "schick mir Ops von Autor a ab Sequenz n", direkt an ein Gerät, das sie hat
import { importVerifyKey, open, peerIdFor, seal, sign, verify } from './crypto';
import type { Relay, RelayMsg } from './relay';
import { kv, opStore } from './store';
import type { Envelope, Identity, MeshSession, Op, OpBody, SV } from './types';

const BATCH_BYTES = 110_000;
const WANT_TIMEOUT_MS = 8_000;
const SV_INTERVAL_MS = 90_000;
const MAX_PENDING = 20_000;
const reID = /^[A-Za-z0-9_-]{16,64}$/;

export interface Presence {
  pub: string;
  user: Identity;
  online: boolean;
}

export const canon = (a: string, s: number, l: number, t: number, b: OpBody) => JSON.stringify([a, s, l, t, b]);

function validOp(op: unknown): op is Op {
  const o = op as Op;
  return (
    !!o && typeof o.a === 'string' && reID.test(o.a) && Number.isInteger(o.s) && o.s >= 1 &&
    Number.isInteger(o.l) && o.l >= 0 && Number.isFinite(o.t) && typeof o.sig === 'string' &&
    !!o.b && typeof o.b === 'object' && typeof o.b.type === 'string' && JSON.stringify(o.b).length < 60_000
  );
}

export class Mesh {
  readonly ops = new Map<string, Map<number, Op>>();
  readonly presence = new Map<string, Presence>();
  readonly peerSv = new Map<string, SV>();
  joined = false;
  error: string | null = null;
  /** Peers, deren Relay-Identität einer früheren Bestätigung widerspricht. */
  readonly conflicts = new Set<string>();

  private have = new Map<string, number>();
  private keys = new Map<string, CryptoKey>();
  private pending = new Map<string, Op[]>();
  private inflight = new Map<string, number>();
  private lamport = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private ingestChain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private changeTimer?: number;
  private intervals: number[] = [];
  private offs: (() => void)[] = [];

  constructor(
    private relay: Relay,
    public ms: MeshSession,
    private key: CryptoKey,
    private memberInfo: () => { name: string; device: string },
  ) {}

  get sid() {
    return this.ms.sid;
  }
  get me() {
    return this.ms.peer;
  }

  async start() {
    for (const op of await opStore.all(this.sid)) this.insert(op);
    for (const [a, m] of this.ops) {
      const first = m.get(1);
      if (first?.b.type === 'member') this.keys.set(a, await importVerifyKey(first.b.signPub));
    }
    if (!this.ops.get(this.me)?.has(1)) {
      const { name, device } = this.memberInfo();
      await this.create({ type: 'member', signPub: this.ms.signPub, name, device });
    }
    this.offs.push(this.relay.on((m) => void this.onRelay(m)));
    this.offs.push(this.relay.onReady(() => this.relay.send({ t: 'join', session: this.sid, peer: this.me, pub: this.ms.signPub })));
    this.offs.push(
      this.relay.onStatus((s) => {
        if (s !== 'online') {
          this.joined = false;
          this.presence.forEach((p) => (p.online = false));
          this.changed();
        }
      }),
    );
    this.intervals.push(window.setInterval(() => this.planWants(), 3_000));
    const jitter = SV_INTERVAL_MS * (0.7 + Math.random() * 0.6);
    this.intervals.push(window.setInterval(() => this.broadcast({ k: 'sv', sv: this.sv() }), jitter));
    this.changed();
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.offs.forEach((f) => f());
    clearTimeout(this.changeTimer);
    clearTimeout(this.announceTimer);
    this.relay.send({ t: 'leave', session: this.sid });
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed() {
    this.changeTimer ??= window.setTimeout(() => {
      this.changeTimer = undefined;
      this.listeners.forEach((f) => f());
    }, 150);
  }

  // ---------- Lokale Ops ----------

  /** Erzeugt, signiert, speichert und verteilt eine eigene Op. Serialisiert. */
  create(body: OpBody): Promise<Op> {
    const run = async () => {
      const s = (this.have.get(this.me) ?? 0) + 1;
      const l = ++this.lamport;
      const t = Math.round(this.relay.now());
      const sig = await sign(this.ms.signKeyPair.privateKey, canon(this.me, s, l, t, body));
      const op: Op = { a: this.me, s, l, t, b: body, sig };
      await opStore.putMany(this.sid, [op]);
      if (body.type === 'member') this.keys.set(this.me, await importVerifyKey(body.signPub));
      this.insert(op);
      this.broadcast({ k: 'ops', ops: [op] });
      this.changed();
      return op;
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ---------- Zustand ----------

  private insert(op: Op) {
    let m = this.ops.get(op.a);
    if (!m) this.ops.set(op.a, (m = new Map()));
    m.set(op.s, op);
    if (op.l > this.lamport) this.lamport = op.l;
    let h = this.have.get(op.a) ?? 0;
    while (m.has(h + 1)) h++;
    this.have.set(op.a, h);
  }

  sv(): SV {
    return Object.fromEntries(this.have);
  }

  *allOps(): Generator<Op> {
    for (const m of this.ops.values()) yield* m.values();
  }

  get opCount(): number {
    let n = 0;
    this.ops.forEach((m) => (n += m.size));
    return n;
  }

  /** Online-Geräte, die nachweislich alles haben, was dieses Gerät hat. */
  replicas(): number {
    const mine = this.sv();
    let n = 0;
    for (const [peer, sv] of this.peerSv) {
      if (peer === this.me || !this.presence.get(peer)?.online) continue;
      if (Object.entries(mine).every(([a, s]) => (sv[a] ?? 0) >= s)) n++;
    }
    return n;
  }

  /** Wie viele Ops fehlen diesem Gerät laut bekanntem Stand der anderen? */
  missing(): number {
    let n = 0;
    const best = new Map<string, number>();
    this.peerSv.forEach((sv) => Object.entries(sv).forEach(([a, s]) => best.set(a, Math.max(best.get(a) ?? 0, s))));
    best.forEach((s, a) => (n += Math.max(0, s - (this.have.get(a) ?? 0))));
    return n;
  }

  private announceTimer?: number;
  private announceSoon() {
    clearTimeout(this.announceTimer);
    this.announceTimer = window.setTimeout(() => this.broadcast({ k: 'sv', sv: this.sv() }), 2_000 + Math.random() * 2_000);
  }

  // ---------- Netzwerk ----------

  private async send(to: string, env: Envelope) {
    const data = await seal(this.key, this.sid, env);
    this.relay.send({ t: 'send', session: this.sid, to, data });
  }
  private broadcast(env: Envelope) {
    void this.send('*', env);
  }

  private attest(peer: string, user: Identity) {
    const known = this.ms.attested[peer];
    if (!known) {
      this.ms.attested[peer] = user;
      void kv.set(`mesh:${this.sid}`, this.ms);
    } else if (known.sub !== user.sub) this.conflicts.add(peer);
  }

  private async onRelay(m: RelayMsg) {
    if (m.session !== this.sid) return;
    switch (m.t) {
      case 'joined':
        this.joined = true;
        this.error = null;
        for (const p of (m.peers as (Presence & { peer: string })[]) ?? []) {
          this.presence.set(p.peer, { pub: p.pub, user: p.user, online: p.online });
          this.attest(p.peer, p.user);
        }
        this.broadcast({ k: 'hello', sv: this.sv() });
        break;
      case 'presence': {
        const peer = String(m.peer);
        this.presence.set(peer, { pub: String(m.pub), user: m.user as Identity, online: m.online === true });
        this.attest(peer, m.user as Identity);
        if (m.online !== true) this.peerSv.delete(peer);
        break;
      }
      case 'recv': {
        let env: Envelope;
        try {
          env = await open<Envelope>(this.key, this.sid, String(m.data));
        } catch {
          return; // falscher Schlüssel oder manipuliert
        }
        await this.onEnvelope(String(m.from), env);
        break;
      }
      case 'error':
        if (m.code === 'replaced' || m.code === 'peertaken') this.error = String(m.msg);
        else if (m.code === 'offline') return;
        break;
      default:
        return;
    }
    this.changed();
  }

  private async onEnvelope(from: string, env: Envelope) {
    switch (env.k) {
      case 'ops':
        if (Array.isArray(env.ops)) await this.ingestMany(from, env.ops);
        break;
      case 'hello': {
        this.peerSv.set(from, env.sv ?? {});
        const mine = this.sv();
        if (Object.entries(mine).some(([a, s]) => (env.sv?.[a] ?? 0) < s)) void this.send(from, { k: 'sv', sv: mine });
        this.planWants();
        break;
      }
      case 'sv':
        this.peerSv.set(from, env.sv ?? {});
        this.planWants();
        break;
      case 'want':
        if (typeof env.a === 'string' && Number.isInteger(env.from)) await this.serve(from, env.a, env.from);
        break;
    }
  }

  private ingestMany(from: string, ops: unknown[]): Promise<void> {
    const run = async () => {
      const fresh: Op[] = [];
      const hint = this.peerSv.get(from) ?? {};
      for (const op of ops.slice(0, 10_000)) {
        if (!validOp(op)) continue;
        if ((hint[op.a] ?? 0) < op.s) hint[op.a] = op.s;
        this.inflight.delete(op.a);
        await this.ingest(op, fresh);
      }
      this.peerSv.set(from, hint);
      if (fresh.length) {
        await opStore.putMany(this.sid, fresh);
        this.changed();
        // Nach einem Nachholen den neuen Stand bekanntgeben (gebündelt), damit
        // andere sehen, dass dieses Gerät jetzt eine vollständige Kopie hat.
        if (fresh.length > 1) this.announceSoon();
      }
      this.planWants();
    };
    const p = this.ingestChain.then(run);
    this.ingestChain = p.catch(() => undefined);
    return p;
  }

  private async ingest(op: Op, fresh: Op[]) {
    if (this.ops.get(op.a)?.has(op.s)) return;
    if (op.s === 1 && op.b.type === 'member') {
      if (typeof op.b.signPub !== 'string' || (await peerIdFor(op.b.signPub)) !== op.a) return;
      const key = await importVerifyKey(op.b.signPub);
      if (!(await verify(key, op.sig, canon(op.a, op.s, op.l, op.t, op.b)))) return;
      this.keys.set(op.a, key);
      this.insert(op);
      fresh.push(op);
      const waiting = this.pending.get(op.a) ?? [];
      this.pending.delete(op.a);
      for (const w of waiting) await this.ingest(w, fresh);
      return;
    }
    const key = this.keys.get(op.a);
    if (!key) {
      const list = this.pending.get(op.a) ?? [];
      if (list.length < MAX_PENDING) list.push(op);
      this.pending.set(op.a, list);
      return;
    }
    if (!(await verify(key, op.sig, canon(op.a, op.s, op.l, op.t, op.b)))) return;
    this.insert(op);
    fresh.push(op);
  }

  /** Fordert fehlende Ops gezielt bei einem Gerät an, das sie hat (bevorzugt beim Autor). */
  private planWants() {
    if (!this.joined) return;
    const now = Date.now();
    const candidates = new Map<string, { peer: string; seq: number }[]>();
    for (const [peer, sv] of this.peerSv) {
      if (peer === this.me || !this.presence.get(peer)?.online) continue;
      for (const [a, s] of Object.entries(sv)) {
        if (s > (this.have.get(a) ?? 0)) {
          const list = candidates.get(a) ?? [];
          list.push({ peer, seq: s });
          candidates.set(a, list);
        }
      }
    }
    for (const [a, list] of candidates) {
      if ((this.inflight.get(a) ?? 0) > now) continue;
      const author = list.find((c) => c.peer === a);
      const max = Math.max(...list.map((c) => c.seq));
      const best = list.filter((c) => c.seq === max);
      const pick = author ?? best[Math.floor(Math.random() * best.length)];
      this.inflight.set(a, now + WANT_TIMEOUT_MS);
      void this.send(pick.peer, { k: 'want', a, from: (this.have.get(a) ?? 0) + 1 });
    }
  }

  private async serve(to: string, a: string, from: number) {
    const m = this.ops.get(a);
    if (!m) return;
    const list = [...m.values()].filter((o) => o.s >= from).sort((x, y) => x.s - y.s).slice(0, 5_000);
    let batch: Op[] = [];
    let size = 0;
    for (const op of list) {
      const n = JSON.stringify(op).length;
      if (batch.length && size + n > BATCH_BYTES) {
        await this.send(to, { k: 'ops', ops: batch });
        batch = [];
        size = 0;
      }
      batch.push(op);
      size += n;
    }
    if (batch.length) await this.send(to, { k: 'ops', ops: batch });
  }
}
