// What one window shows: either a new, unsaved draft or one open draft. A
// new draft is created in the daemon on the first keystroke; a draft that's
// empty when the window moves on is discarded outright (docs/design.md).

import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { type Binding, createBinding } from './binding';
import { bridge, type DraftState, type DraftSummary, type WindowKind, type WindowPrefs } from './bridge';
import { editorExtensions } from './editor/setup';
import { localTitle } from './format';
import { shouldRollOver } from './idle';
import type { Rpc } from './rpc';
import { DocSession } from './session';

export class DraftController {
  readonly view: EditorView;
  session: DocSession | null = null;
  pinned: boolean;
  loadedAt: number;
  /** Called when the open draft is deleted elsewhere. */
  onRemoved: () => void = () => this.newDraft();

  private binding: Binding | null = null;
  private slot = new Compartment();
  private creating = false;
  /** A draft made for this window whose first open failed; retry it instead of making another. */
  private createdId: string | null = null;
  /** Bumped whenever the window switches drafts, to drop stale async work. */
  private generation = 0;
  private listeners = new Set<() => void>();
  private offMeta: (() => void) | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parent: HTMLElement,
    private rpc: Rpc,
    readonly kind: WindowKind,
    prefs: WindowPrefs,
    private idleMs: number,
  ) {
    this.pinned = !!prefs.pinned;
    this.loadedAt = prefs.loadedAt ?? Date.now();
    this.view = new EditorView({ parent, state: this.freshState('') });
  }

  get draftId(): string | null {
    return this.session?.id ?? null;
  }

  get title(): string {
    return localTitle(this.view.state.doc.toString()) || 'New draft';
  }

  get state(): DraftState {
    return this.session?.state() ?? 'inbox';
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.listeners.forEach((f) => f());
  }

  private emitSoon() {
    if (!this.emitTimer) this.emitTimer = setTimeout(() => this.emit(), 150);
  }

  private freshState(doc: string, binding: Extension = []): EditorState {
    const placeholder = this.kind === 'capture' ? 'Dump a thought…' : 'Start typing…';
    return EditorState.create({
      doc,
      extensions: [this.slot.of(binding), editorExtensions({ placeholder, onUpdate: (u) => this.onUpdate(u) })],
    });
  }

  private onUpdate(u: ViewUpdate) {
    if (!u.docChanged) return;
    if (!this.session && !this.creating && u.state.doc.toString().trim() !== '') void this.create();
    this.emitSoon();
  }

  async init(draftId?: string) {
    if (draftId) {
      try {
        await this.load(draftId, { restore: true });
        return;
      } catch (e) {
        console.warn(`couldn't reopen ${draftId}:`, e);
      }
    }
    this.showEmpty();
  }

  /** Switches to a new, unsaved draft. */
  newDraft() {
    this.release();
    this.showEmpty();
    this.save();
    this.focus();
  }

  private showEmpty() {
    this.generation++;
    this.createdId = null;
    this.session = null;
    this.binding = null;
    this.view.setState(this.freshState(''));
    this.loadedAt = Date.now();
    this.emit();
  }

  /** Opens an existing draft in this window. */
  async load(id: string, opts: { restore?: boolean } = {}) {
    if (id === this.session?.id) return this.focus();
    await this.rpc.whenReady();
    const generation = ++this.generation;
    const session = new DocSession(id, this.rpc);
    try {
      await session.open();
    } catch (e) {
      session.close();
      throw e;
    }
    if (generation !== this.generation) return session.close();
    this.release();
    this.attach(session);
    this.view.setState(this.freshState(session.text(), this.binding!.extension));
    this.view.scrollDOM.scrollTop = 0;
    if (!opts.restore) this.loadedAt = Date.now();
    this.save();
    this.emit();
    this.focus();
  }

  private attach(session: DocSession) {
    this.session = session;
    this.binding = createBinding(session);
    session.onRemoved = () => {
      if (this.session === session) this.onRemoved();
    };
    this.offMeta = session.meta.subscribe(() => this.emitSoon());
  }

  /** Turns the unsaved draft into a real one on its first keystroke. */
  private async create() {
    this.creating = true;
    const generation = this.generation;
    try {
      await this.rpc.whenReady();
      this.createdId ??= (await this.rpc.call<DraftSummary>('drafts.create', { text: this.view.state.doc.toString() })).id;
      const session = new DocSession(this.createdId, this.rpc);
      try {
        await session.open();
      } catch (e) {
        session.close();
        throw e;
      }
      this.createdId = null;
      if (generation !== this.generation) {
        // The window moved on while the draft was being made; it stays in the Inbox.
        session.close();
        return;
      }
      // Anything typed while the draft was being created goes in as an edit.
      const current = this.view.state.doc.toString();
      if (current !== session.text()) {
        session.body.update(current);
        session.doc.commit({ origin: 'typing' });
        session.noteLocalEdit();
      }
      this.attach(session);
      this.view.dispatch({ effects: this.slot.reconfigure(this.binding!.extension) });
      this.loadedAt = Date.now();
      this.save();
      this.emit();
    } catch (e) {
      console.error('creating the draft failed; will retry on the next keystroke', e);
    } finally {
      this.creating = false;
    }
  }

  /** For when the window goes away. */
  dispose() {
    this.release();
  }

  /** Leaves the current draft, discarding it if it's empty. */
  private release() {
    const session = this.session;
    if (!session) return;
    this.offMeta?.();
    this.offMeta = null;
    this.session = null;
    this.binding = null;
    const blank = session.isBlank();
    session.close();
    if (blank) this.rpc.call('drafts.discard', { id: session.id }).catch(() => {});
  }

  applyIdleRule() {
    const s = this.session;
    const roll = shouldRollOver({
      pinned: this.pinned,
      hasDraft: s !== null,
      now: Date.now(),
      loadedAt: this.loadedAt,
      modifiedAt: s?.modifiedAt() ?? 0,
      lastLocalEdit: s?.lastLocalEdit ?? 0,
      idleMs: this.idleMs,
    });
    if (roll) this.newDraft();
  }

  setPinned(on: boolean) {
    this.pinned = on;
    this.save();
    this.emit();
  }

  async setState(state: DraftState) {
    if (!this.session) return;
    await this.rpc.call('drafts.setState', { id: this.session.id, state });
  }

  /** The selection, or the whole draft when nothing is selected. */
  markdownForCopy(): string {
    const sel = this.view.state.selection.main;
    return sel.empty ? this.view.state.doc.toString() : this.view.state.sliceDoc(sel.from, sel.to);
  }

  isBlank(): boolean {
    return this.view.state.doc.toString().trim() === '';
  }

  focus() {
    this.view.focus();
  }

  private save() {
    void bridge().savePrefs({ draftId: this.session?.id, pinned: this.pinned, loadedAt: this.loadedAt });
  }
}
