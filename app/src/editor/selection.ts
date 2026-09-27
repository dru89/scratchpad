// How a selection looks. CodeMirror's own selection layer sits under the
// text, so a code block's background hides it, and it measures every line
// from the first line's left edge, which leaves slivers beside indented list
// items. This layer draws above the text, translucent, one line at a time:
// each piece ends at the line's text, and a selected line break shows as a
// short block after it, so a triple-clicked line reads as that line alone.

import { EditorSelection } from '@codemirror/state';
import { type EditorView, layer, RectangleMarker } from '@codemirror/view';

const CLASS = 'cm-selectionBackground';
/** The width of the block that stands for a selected line break. */
const BREAK_PX = 7;

function markers(view: EditorView): RectangleMarker[] {
  const out: RectangleMarker[] = [];
  const { doc } = view.state;
  const { from: vFrom, to: vTo } = view.viewport;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const baseLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX;
  const baseTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY;

  for (const range of view.state.selection.ranges) {
    if (range.empty) continue;
    const end = Math.min(range.to, vTo);
    for (let pos = Math.max(range.from, vFrom); pos <= end; ) {
      const line = doc.lineAt(pos);
      const a = Math.max(range.from, line.from);
      const b = Math.min(range.to, line.to);
      if (b > a) out.push(...RectangleMarker.forRange(view, CLASS, EditorSelection.range(a, b)));
      if (range.to > line.to) {
        const at = view.coordsAtPos(line.to, -1);
        if (at) {
          const left = (at.right - baseLeft) / view.scaleX;
          out.push(new RectangleMarker(CLASS, left, (at.top - baseTop) / view.scaleY, BREAK_PX, (at.bottom - at.top) / view.scaleY));
        }
      }
      pos = line.to + 1;
    }
  }
  return out;
}

export const selectionLayer = layer({
  above: true,
  class: 'cm-sp-selection',
  markers,
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged || u.focusChanged,
});
