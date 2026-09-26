// Binds a CodeMirror view to a session's LoroText (proven in
// spikes/editor-binding). Local transactions are replayed onto the text and
// committed; imported changes become CodeMirror changes, which carry the
// selection along. Undo is Loro's UndoManager, so it only reverts this
// window's own edits.
//
// Written instead of loro-codemirror, which drops text changes that share an
// import batch with a meta change.

import { Annotation, type ChangeSpec, type Extension, Transaction } from '@codemirror/state';
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type Cursor, UndoManager } from 'loro-crdt';
import type { DocSession } from './session';

export const remote = Annotation.define<'remote' | 'undo'>();

export interface Binding {
  extension: Extension;
  undo(): boolean;
  redo(): boolean;
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
          const kind =
            batch.by === 'import' ? 'remote' : batch.by === 'local' && batch.origin === 'undo' ? 'undo' : null;
          if (!kind) return; // this window's typing and meta stamps are already in the editor
          for (const event of batch.events) {
            if (event.target !== session.body.id || event.diff.type !== 'text') continue;
            // Each event is relative to the text after the previous one.
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
            if (kind === 'undo') {
              tr.changes.iterChangedRanges((_fa, _ta, _fb, toB) => (lastUndoEnd = Math.max(lastUndoEnd, toB)));
            }
          }
        });

        undoManager.setOnPush((isUndo) => {
          const sel = (isUndo && preEditSelection) || view.state.selection.main;
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
            // Redo leaves the cursor at the end of what it restored.
            if (end >= 0) queueMicrotask(() => view.dispatch({ selection: { anchor: end }, scrollIntoView: true }));
            return;
          }
          const [anchor, head] = value.cursors as Cursor[];
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
          session.noteLocalEdit();
        }
      }

      destroy() {
        this.unsubscribe();
        undoManager.setOnPush(undefined);
        undoManager.setOnPop(undefined);
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
    undo,
    redo,
  };
}
