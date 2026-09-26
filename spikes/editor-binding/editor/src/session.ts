// A window's own copy of one draft, kept in step with the daemon. Local
// commits go up as Loro updates; the daemon's updates come down and are
// imported. After a disconnect, `open` compares versions and each side sends
// only what the other is missing.

import { LoroDoc, type LoroMap, type LoroText, VersionVector } from 'loro-crdt';
import { fromB64, type Rpc, toB64 } from './rpc';

// Stamp modifiedAt after a pause in typing, or every 30s during nonstop typing.
// Any commit mid-burst (even one excluded from undo) splits the undo group, and
// a pause already ends the group, so stamping on the pause never splits one.
const STAMP_AFTER_IDLE_MS = 1500;
const STAMP_MAX_WAIT_MS = 30_000;

export class DocSession {
  readonly doc = new LoroDoc();
  readonly body: LoroText;
  readonly meta: LoroMap;
  opened = false;
  readonly stats = { pushes: 0, pushBytes: 0, remoteUpdates: 0, remoteBytes: 0, lastRemoteAt: 0, stamps: 0 };
  private openListeners: (() => void)[] = [];
  private stampTimer: ReturnType<typeof setTimeout> | null = null;
  private firstUnstampedEdit = 0;

  constructor(
    readonly id: string,
    private rpc: Rpc,
  ) {
    this.body = this.doc.getText('body');
    this.meta = this.doc.getMap('meta');
    this.doc.subscribeLocalUpdates((update) => this.push(update));
    rpc.on('doc.update', (p) => {
      if (p.id !== this.id) return;
      const bytes = fromB64(p.update);
      this.stats.remoteUpdates++;
      this.stats.remoteBytes += bytes.length;
      this.stats.lastRemoteAt = performance.now();
      this.doc.import(bytes);
    });
    rpc.onDisconnect(() => {
      this.opened = false;
    });
  }

  /** Opens (or reopens) the draft on the daemon and trades missing history. */
  async open(): Promise<{ bytes: number; rpcMs: number; importMs: number }> {
    const local = this.doc.oplogVersion();
    const t0 = performance.now();
    const res = await this.rpc.call<{ data: string; version: string }>('doc.open', {
      id: this.id,
      version: local.length() > 0 ? toB64(local.encode()) : undefined,
    });
    const t1 = performance.now();
    const data = fromB64(res.data);
    this.doc.import(data);
    const t2 = performance.now();
    const daemon = VersionVector.decode(fromB64(res.version));
    const cmp = this.doc.oplogVersion().compare(daemon);
    if (cmp === undefined || cmp > 0) {
      await this.rpc.call('doc.push', { id: this.id, update: toB64(this.doc.export({ mode: 'update', from: daemon })) });
    }
    this.opened = true;
    this.openListeners.forEach((f) => f());
    return { bytes: data.length, rpcMs: t1 - t0, importMs: t2 - t1 };
  }

  onOpen(fn: () => void) {
    this.openListeners.push(fn);
  }

  /** Called after every local edit; stamps meta.modifiedAt once typing pauses. */
  scheduleStamp() {
    const now = performance.now();
    if (!this.stampTimer) this.firstUnstampedEdit = now;
    else clearTimeout(this.stampTimer);
    const wait = Math.min(STAMP_AFTER_IDLE_MS, Math.max(0, this.firstUnstampedEdit + STAMP_MAX_WAIT_MS - now));
    this.stampTimer = setTimeout(() => {
      this.stampTimer = null;
      this.meta.set('modifiedAt', Date.now());
      this.doc.commit({ origin: 'meta.stamp' });
      this.stats.stamps++;
    }, wait);
  }

  private push(update: Uint8Array) {
    // While disconnected, local changes stay in the doc; `open` sends them later.
    if (!this.opened) return;
    this.stats.pushes++;
    this.stats.pushBytes += update.length;
    this.rpc.call('doc.push', { id: this.id, update: toB64(update) }).catch(() => {});
  }
}
