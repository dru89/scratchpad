// Connections to scratchpadd. Each editor window gets its own connection,
// which this process only pipes (every window is its own device, per
// docs/design.md). The app itself holds one more, as the `ui` client that
// receives capture and open commands. Whoever finds nothing listening starts
// the daemon; its lock file settles any race.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { daemonBinary, dataDir, socketPath } from './paths';

let lastSpawn = 0;

function spawnDaemon() {
  if (Date.now() - lastSpawn < 2000) return;
  lastSpawn = Date.now();
  mkdirSync(dataDir(), { recursive: true });
  const log = openSync(join(dataDir(), 'daemon.log'), 'a');
  const child = spawn(daemonBinary(), [], { detached: true, stdio: ['ignore', log, log] });
  child.on('error', (e) => console.error(`scratchpad: couldn't start ${daemonBinary()}: ${e.message}`));
  child.unref();
}

export interface LinkEvents {
  onLine(line: string): void;
  onStatus(connected: boolean): void;
}

/** A line-oriented socket to the daemon that reconnects until closed. */
export class DaemonLink {
  private socket: Socket | null = null;
  private closed = false;
  private retry = 50;

  constructor(private events: LinkEvents) {
    this.attempt();
  }

  get connected() {
    return this.socket !== null;
  }

  send(line: string) {
    this.socket?.write(line + '\n');
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }

  private attempt() {
    if (this.closed) return;
    const socket = createConnection(socketPath());
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('connect', () => {
      this.socket = socket;
      this.retry = 50;
      this.events.onStatus(true);
    });
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.events.onLine(line);
      }
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') spawnDaemon();
    });
    socket.on('close', () => {
      const wasConnected = this.socket === socket;
      this.socket = null;
      if (wasConnected) this.events.onStatus(false);
      if (!this.closed) setTimeout(() => this.attempt(), (this.retry = Math.min(this.retry * 2, 1000)));
    });
  }
}

type Handler = (params: any) => void;

/** The app's own JSON-RPC connection: the `ui` client. */
export class AppClient {
  private link: DaemonLink;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Handler>();

  constructor() {
    this.link = new DaemonLink({
      onLine: (line) => this.receive(line),
      onStatus: (connected) => {
        if (connected) {
          this.call('hello', {
            protocol: 1,
            client: { kind: 'app', version: '0.1.0' },
            capabilities: ['ui'],
          }).catch((e) => console.error('scratchpad: hello failed', e));
        } else {
          for (const p of this.pending.values()) p.reject(new Error('disconnected from scratchpadd'));
          this.pending.clear();
        }
      },
    });
  }

  on(method: string, handler: Handler) {
    this.handlers.set(method, handler);
  }

  call<T = any>(method: string, params: object = {}): Promise<T> {
    if (!this.link.connected) return Promise.reject(new Error('not connected to scratchpadd'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.link.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
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
      this.handlers.get(msg.method)?.(msg.params);
    }
  }
}
