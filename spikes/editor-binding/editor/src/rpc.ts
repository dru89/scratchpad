// JSON-RPC client over the preload bridge. The main process owns the socket;
// this side only sees lines and connection status.

interface SpikeBridge {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onStatus(cb: (s: { connected: boolean }) => void): void;
  broadcast(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  openWindow(query: Record<string, string>): Promise<void>;
  save(name: string, data: unknown): Promise<string>;
  quit(): Promise<void>;
}

declare global {
  interface Window {
    spike: SpikeBridge;
  }
}

type Listener = (params: any) => void;

export class Rpc {
  connected = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Listener[]>();
  private connectListeners: (() => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  constructor() {
    window.spike.onLine((line) => this.receive(line));
    window.spike.onStatus(({ connected }) => {
      this.connected = connected;
      if (connected) {
        this.call('hello', { protocol: 1, client: { kind: 'window' } })
          .then(() => this.connectListeners.forEach((f) => f()))
          .catch((e) => console.error('hello failed', e));
      } else {
        for (const p of this.pending.values()) p.reject(new Error('disconnected'));
        this.pending.clear();
        this.disconnectListeners.forEach((f) => f());
      }
    });
  }

  call<T = any>(method: string, params: object = {}): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('disconnected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.spike.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  on(method: string, fn: Listener): () => void {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
    return () => this.handlers.set(method, (this.handlers.get(method) ?? []).filter((f) => f !== fn));
  }

  onConnect(fn: () => void) {
    this.connectListeners.push(fn);
  }

  onDisconnect(fn: () => void) {
    this.disconnectListeners.push(fn);
  }

  private receive(line: string) {
    const msg = JSON.parse(line);
    if (msg.id != null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
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
