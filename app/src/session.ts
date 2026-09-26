// A window's own copy of one draft, kept in step with the daemon: local
// commits go up as Loro updates, the daemon's come down and are imported,
// and after a reconnect each side sends only what the other is missing.
// Proven in spikes/editor-binding.

import { LoroDoc, type LoroMap, type LoroText, VersionVector } from 'loro-crdt';
import type { DraftState } from './bridge';
import { fromB64, type Rpc, toB64 } from './rpc';

// Stamp modifiedAt after a pause in typing, or every 30s during nonstop
// typing. Any commit mid-burst splits the undo group; a pause already ends
// the group, so stamping on the pause never splits one.
const STAMP_AFTER_IDLE_MS = 1500;
const STAMP_MAX_WAIT_MS = 30_000;

export class DocSession {
  readonly doc = new LoroDoc();
  readonly body: LoroText;
  readonly meta: LoroMap;
  opened = false;
  /** When this window last changed the text. */
  lastLocalEdit = 0;
  /** Called when the draft is deleted out from under this window. */
  onRemoved: (() => void) | null = null;
  private everOpened = false;
  private closed = false;
  private offs: (() => void)[] = [];
  private stampTimer: ReturnType<typeof setTimeout> | null = null;
  private firstUnstampedEdit = 0;

  constructor(
    readonly id: string,
    private rpc: Rpc,
  ) {
    this.body = this.doc.getText('body');
    this.meta = this.doc.getMap('meta');
    this.offs.push(this.doc.subscribeLocalUpdates((update) => this.push(update)));
    this.offs.push(
      rpc.on('doc.update', (p) => {
        if (p.id === this.id && !this.closed) this.doc.import(fromB64(p.update));
      }),
      rpc.on('doc.removed', (p) => {
        if (p.id === this.id) this.onRemoved?.();
      }),
      rpc.onDisconnect(() => {
        this.opened = false;
      }),
      rpc.onConnect(() => {
        if (this.everOpened && !this.closed) this.open().catch((e) => console.error(`reopen ${this.id} failed`, e));
      }),
    );
  }

  /** Opens (or reopens) the draft on the daemon and trades missing history. */
  async open(): Promise<void> {
    const local = this.doc.oplogVersion();
    const res = await this.rpc.call<{ data: string; version: string }>('doc.open', {
      id: this.id,
      version: local.length() > 0 ? toB64(local.encode()) : undefined,
    });
    this.doc.import(fromB64(res.data));
    const daemon = VersionVector.decode(fromB64(res.version));
    const cmp = this.doc.oplogVersion().compare(daemon);
    if (cmp === undefined || cmp > 0) {
      await this.rpc.call('doc.push', { id: this.id, update: toB64(this.doc.export({ mode: 'update', from: daemon })) });
    }
    this.opened = true;
    this.everOpened = true;
  }

  close() {
    this.flushStamp();
    this.closed = true;
    this.offs.forEach((off) => off());
    if (this.rpc.ready) this.rpc.call('doc.close', { id: this.id }).catch(() => {});
  }

  text(): string {
    return this.body.toString();
  }

  isBlank(): boolean {
    return this.text().trim() === '';
  }

  state(): DraftState {
    const s = this.meta.get('state');
    return s === 'archived' || s === 'trashed' ? s : 'inbox';
  }

  modifiedAt(): number {
    const m = this.meta.get('modifiedAt');
    return typeof m === 'number' ? m : typeof m === 'bigint' ? Number(m) : 0;
  }

  /** Called after every local edit. */
  noteLocalEdit() {
    const now = Date.now();
    this.lastLocalEdit = now;
    if (!this.stampTimer) this.firstUnstampedEdit = now;
    else clearTimeout(this.stampTimer);
    const wait = Math.min(STAMP_AFTER_IDLE_MS, Math.max(0, this.firstUnstampedEdit + STAMP_MAX_WAIT_MS - now));
    this.stampTimer = setTimeout(() => this.flushStamp(), wait);
  }

  private flushStamp() {
    if (!this.stampTimer) return;
    clearTimeout(this.stampTimer);
    this.stampTimer = null;
    this.meta.set('modifiedAt', Date.now());
    this.doc.commit({ origin: 'meta.stamp' });
  }

  private push(update: Uint8Array) {
    // While disconnected, changes stay in the doc; open() sends them later.
    if (!this.opened || this.closed) return;
    this.rpc.call('doc.push', { id: this.id, update: toB64(update) }).catch(() => {});
  }
}
