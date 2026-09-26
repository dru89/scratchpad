// JSON-RPC to the daemon over this window's own connection, which the main
// process only pipes.

import { bridge } from './bridge';

type Listener = (params: any) => void;

export class Rpc {
  /** Connected and past the hello handshake. */
  ready = false;
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Set<Listener>>();
  private connectListeners = new Set<() => void>();
  private disconnectListeners = new Set<() => void>();

  constructor() {
    bridge().daemon.onLine((line) => this.receive(line));
    bridge().daemon.onStatus(({ connected }) => {
      this.connected = connected;
      if (connected) {
        this.request('hello', { protocol: 1, client: { kind: 'window', version: '0.1.0' } })
          .then(() => {
            this.ready = true;
            this.connectListeners.forEach((f) => f());
          })
          .catch((e) => console.error('hello failed', e));
      } else {
        this.ready = false;
        for (const p of this.pending.values()) p.reject(new Error('disconnected from scratchpadd'));
        this.pending.clear();
        this.disconnectListeners.forEach((f) => f());
      }
    });
  }

  /** Resolves once the daemon connection is up. */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onConnect(() => {
        off();
        resolve();
      });
    });
  }

  call<T = any>(method: string, params: object = {}): Promise<T> {
    if (!this.ready) return Promise.reject(new Error('not connected to scratchpadd'));
    return this.request(method, params);
  }

  private request<T>(method: string, params: object): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('not connected to scratchpadd'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      bridge().daemon.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  on(method: string, fn: Listener): () => void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(fn);
    this.handlers.set(method, set);
    return () => set.delete(fn);
  }

  onConnect(fn: () => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  onDisconnect(fn: () => void): () => void {
    this.disconnectListeners.add(fn);
    return () => this.disconnectListeners.delete(fn);
  }

  private receive(line: string) {
    const msg = JSON.parse(line);
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
    }
  }
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
