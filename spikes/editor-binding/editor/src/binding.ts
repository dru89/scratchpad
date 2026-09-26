// Binds a CodeMirror view to the session's LoroText.
//
// Local edits: every CodeMirror transaction that isn't tagged as remote is
// replayed onto the LoroText and committed. Remote edits: Loro import events
// for the body container are turned into CodeMirror changes, which also maps
// the selection through them. Undo goes through Loro's UndoManager, which
// only reverts this window's own edits.
//
// Written instead of using loro-codemirror, whose event handler returns early
// on any non-text event in a batch (dropping the text changes that share a
// batch with a meta update) and re-dispatches accumulated changes when a batch
// has several text events.

import { Annotation, type ChangeSpec, type Extension, Transaction } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type Cursor, UndoManager } from 'loro-crdt';
import type { DocSession } from './session';

export const remote = Annotation.define<'remote' | 'undo'>();

export interface Binding {
  extension: Extension;
  undoManager: UndoManager;
  undo(view: EditorView): boolean;
  redo(view: EditorView): boolean;
}

export function createBinding(session: DocSession): Binding {
  const undoManager = new UndoManager(session.doc, {
    mergeInterval: 800,
    maxUndoSteps: 500,
    excludeOriginPrefixes: ['meta'],
  });

  // Selection just before the edit that opened the current undo group.
  let preEditSelection: { anchor: number; head: number } | null = null;
  // End of the text most recently changed by an undo or redo.
  let lastUndoEnd = -1;

  const plugin = ViewPlugin.fromClass(
    class {
      private unsubscribe: () => void;

      constructor(readonly view: EditorView) {
        this.unsubscribe = session.doc.subscribe((batch) => {
          // Loro tags both undo and redo commits with origin "undo".
          const kind = batch.by === 'import' ? 'remote' : batch.by === 'local' && batch.origin === 'undo' ? 'undo' : null;
          if (!kind) return; // our own typing and meta stamps are already in the editor
          for (const event of batch.events) {
            if (event.target !== session.body.id || event.diff.type !== 'text') continue;
            // Each event's positions are relative to the text after the
            // previous event, so dispatch them one at a time.
            const changes: ChangeSpec[] = [];
            let pos = 0;
            for (const d of event.diff.diff) {
              if (d.retain != null) pos += d.retain;
              else if (d.delete != null) {
                changes.push({ from: pos, to: pos + d.delete });
                pos += d.delete;
              } else if (d.insert != null) changes.push({ from: pos, insert: d.insert });
            }
            if (!changes.length) continue;
            const tr = view.state.update({
              changes,
              annotations: [remote.of(kind), Transaction.addToHistory.of(false)],
            });
            view.dispatch(tr);
            if (kind === 'undo') tr.changes.iterChangedRanges((_fa, _ta, _fb, toB) => (lastUndoEnd = Math.max(lastUndoEnd, toB)));
          }
        });

        undoManager.setOnPush((isUndo) => {
          const sel = (isUndo && preEditSelection) || view.state.selection.main;
          if ((window as any).spikeDebug) console.log(`onPush isUndo=${isUndo} save anchor=${sel.anchor} head=${sel.head} docLen=${view.state.doc.length}`);
          return {
            value: null,
            cursors: [session.body.getCursor(sel.anchor)!, session.body.getCursor(sel.head)!],
          };
        });
        // Fires after the undo or redo has been applied (and dispatched above).
        undoManager.setOnPop((isUndo, value) => {
          const end = lastUndoEnd;
          lastUndoEnd = -1;
          if (!isUndo) {
            // Redo puts the cursor at the end of what it restored, like CodeMirror's history.
            if (end >= 0) queueMicrotask(() => view.dispatch({ selection: { anchor: end }, scrollIntoView: true }));
            return;
          }
          const [anchor, head] = value.cursors as Cursor[];
          if ((window as any).spikeDebug) console.log(`onPop isUndo=${isUndo} restore=${anchor && session.doc.getCursorPos(anchor)?.offset}`);
          if (!anchor) return;
          queueMicrotask(() => {
            const a = session.doc.getCursorPos(anchor)?.offset;
            if (a == null) return;
            const h = (head && session.doc.getCursorPos(head)?.offset) ?? a;
            view.dispatch({ selection: { anchor: a, head: h }, scrollIntoView: true });
          });
        });
      }

      update(u: ViewUpdate) {
        let local = false;
        for (const tr of u.transactions) {
          if (!tr.docChanged || tr.annotation(remote)) continue;
          if (!local) preEditSelection = tr.startState.selection.main;
          local = true;
          let adj = 0;
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            const text = inserted.toString();
            if (toA > fromA) session.body.delete(fromA + adj, toA - fromA);
            if (text) session.body.insert(fromA + adj, text);
            adj += text.length - (toA - fromA);
          });
        }
        if (local) {
          session.doc.commit({ origin: 'typing' });
          session.scheduleStamp();
        }
      }

      destroy() {
        this.unsubscribe();
      }
    },
  );

  const undo = () => {
    undoManager.undo();
    return true;
  };
  const redo = () => {
    undoManager.redo();
    return true;
  };

  return {
    extension: [
      plugin,
      keymap.of([
        { key: 'Mod-z', run: undo, preventDefault: true },
        { key: 'Mod-y', run: redo, preventDefault: true },
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      ]),
    ],
    undoManager,
    undo,
    redo,
  };
}
