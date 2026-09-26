// The idle rule (docs/design.md#windows): when the main or capture window is
// summoned and its draft has sat untouched too long, it opens on a new draft.

export interface IdleInput {
  pinned: boolean;
  /** False while the window shows an unsaved new draft. */
  hasDraft: boolean;
  now: number;
  /** When the draft was loaded into this window. */
  loadedAt: number;
  /** The draft's meta.modifiedAt, stamped by whichever device edited it. */
  modifiedAt: number;
  /** When this window last changed the text (may not be stamped yet). */
  lastLocalEdit: number;
  idleMs: number;
}

export function shouldRollOver(p: IdleInput): boolean {
  if (p.pinned || !p.hasDraft) return false;
  return p.now - Math.max(p.loadedAt, p.modifiedAt, p.lastLocalEdit) > p.idleMs;
}
