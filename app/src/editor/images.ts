// Pasted and dropped images (docs/design.md#attachments). The daemon keeps
// the bytes as an attachment and the draft gets an ordinary markdown image,
// ![](attachment:<name>), which shows as the picture when it's on a line of
// its own. On the line being edited the markdown shows too, above the
// picture, so the picture stays put while the cursor passes through.

import { syntaxTree } from '@codemirror/language';
import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';
import { touches } from './livepreview';

/** What the daemon takes (crates/core/src/attachments.rs). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** A line that's only an attachment image, the way pasting writes one. */
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(attachment:([0-9a-f]{32}\.(?:png|jpg|gif|webp))(?:\s+"[^"\n]*")?\)\s*$/;

export interface ImageHost {
  /** Stores an image and returns its attachment name. */
  add(bytes: Uint8Array): Promise<string>;
  /** Says why an image couldn't be added. */
  failed(message: string): void;
}

// ---- which lines are images ------------------------------------------------

class ImageLine extends RangeValue {
  constructor(
    readonly name: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: RangeValue) {
    return other instanceof ImageLine && other.name === this.name && other.alt === this.alt;
  }
}

function scan(state: EditorState, from: number, to: number): Range<ImageLine>[] {
  const out: Range<ImageLine>[] = [];
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos);
    const m = IMAGE_LINE.exec(line.text);
    if (m) out.push(new ImageLine(m[2], m[1]).range(line.from, line.to));
    pos = line.to + 1;
  }
  return out;
}

/**
 * The image lines, kept up to date by rescanning only the lines a change
 * touches, so a long draft doesn't cost a full pass per keystroke.
 */
const imageLines = StateField.define<RangeSet<ImageLine>>({
  create: (state) => RangeSet.of(scan(state, 0, state.doc.length)),
  update(set, tr) {
    if (!tr.docChanged) return set;
    set = set.map(tr.changes);
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const from = tr.state.doc.lineAt(fromB).from;
      const to = tr.state.doc.lineAt(toB).to;
      set = set.update({ filterFrom: from, filterTo: to, filter: () => false, add: scan(tr.state, from, to) });
    });
    return set;
  },
});

const CODE = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock']);

function inCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    if (CODE.has(node.name)) return true;
    if (!node.parent) return false;
    node = node.parent;
  }
}

/** The image lines as [from, to, name], for tests. */
export function imageLineRanges(state: EditorState): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (let it = state.field(imageLines).iter(); it.value; it.next()) out.push([it.from, it.to, it.value.name]);
  return out;
}

// ---- showing them ------------------------------------------------------------

/** Sizes of the images this window has shown, so a redrawn one takes its space at once. */
const sizes = new Map<string, { w: number; h: number }>();

/** Natural size, but no wider than the text and no taller than --image-max-height. */
function fit(img: HTMLImageElement, { w, h }: { w: number; h: number }) {
  img.style.aspectRatio = `${w} / ${h}`;
  img.style.width = `min(100%, ${w}px, calc(var(--image-max-height) * ${w / h}))`;
}

class ImageWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.name === this.name && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-image';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.draggable = false;
    const known = sizes.get(this.name);
    if (known) fit(img, known);
    img.addEventListener('load', () => {
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      sizes.set(this.name, size);
      fit(img, size);
      view.requestMeasure();
    });
    img.addEventListener('error', () => {
      const missing = document.createElement('div');
      missing.className = 'cm-image-missing';
      missing.textContent = this.alt ? `${this.alt} (image not found)` : 'Image not found';
      wrap.replaceChildren(missing);
      view.requestMeasure();
    });
    img.src = `attachment:${this.name}`;
    wrap.append(img);
    return wrap;
  }
  /** Clicks place the cursor on the image's line, which shows its markdown. */
  ignoreEvent() {
    return false;
  }
}

/** The markdown of an image on the line being edited: quiet, like other revealed syntax. */
const source = Decoration.line({ class: 'cm-image-source' });

const images = EditorView.decorations.compute([imageLines, 'selection'], (state) => {
  const out: Range<Decoration>[] = [];
  for (let it = state.field(imageLines).iter(); it.value; it.next()) {
    const { from, to } = it;
    if (inCode(state, from)) continue;
    const widget = new ImageWidget(it.value.name, it.value.alt);
    if (touches(state, from, to)) {
      out.push(source.range(from), Decoration.widget({ widget, block: true, side: 1 }).range(to));
    } else {
      out.push(Decoration.replace({ widget, block: true }).range(from, to));
    }
  }
  return Decoration.set(out, true);
});

/** Whether line `n` shows as a picture. */
function isImageLine(state: EditorState, n: number): boolean {
  if (n < 1 || n > state.doc.lines) return false;
  const line = state.doc.line(n);
  let found = false;
  state.field(imageLines).between(line.from, line.to, (from) => {
    found = from === line.from && !inCode(state, from);
    return false;
  });
  return found;
}

/**
 * Up and Down step onto a picture's line, which shows its markdown, instead
 * of jumping over the picture, so the keyboard can reach it to edit or
 * delete it.
 */
function stepOntoImage(forward: boolean) {
  return (view: EditorView) => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const { doc } = view.state;
    const line = doc.lineAt(sel.head);
    const target = line.number + (forward ? 1 : -1);
    if (!isImageLine(view.state, target)) return false;
    // Still inside a wrapped line: an ordinary move.
    if (doc.lineAt(view.moveVertically(sel, forward).head).number === line.number) return false;
    const next = doc.line(target);
    view.dispatch({ selection: { anchor: forward ? next.from : next.to }, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

// ---- adding them -----------------------------------------------------------

/** Where an image is going while the daemon stores it, mapped through any typing meanwhile. */
const addPending = StateEffect.define<{ id: number; pos: number }>();
const removePending = StateEffect.define<number>();

class PendingWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-image-pending';
    el.textContent = 'Adding image…';
    return el;
  }
}

const pending = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addPending)) {
        const deco = Decoration.widget({ widget: new PendingWidget(), side: 1, id: e.value.id });
        set = set.update({ add: [deco.range(e.value.pos)] });
      } else if (e.is(removePending)) {
        set = set.update({ filter: (_from, _to, d) => d.spec.id !== e.value });
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function pendingPos(state: EditorState, id: number): number | null {
  const set = state.field(pending, false);
  for (let it = set?.iter(); it?.value; it.next()) if (it.value.spec.id === id) return it.from;
  return null;
}

/**
 * The markdown for images at `pos`, each on a line of its own, with the
 * cursor on the line after them so typing carries on below.
 */
export function imageInsert(state: EditorState, pos: number, names: string[]) {
  const line = state.doc.lineAt(pos);
  const lead = state.doc.sliceString(line.from, pos).trim() ? '\n' : '';
  const insert = lead + names.map((n) => `![](attachment:${n})`).join('\n') + '\n';
  return { changes: { from: pos, insert }, selection: { anchor: pos + insert.length } };
}

let nextId = 1;

async function addImages(view: EditorView, files: File[], pos: number, host: ImageHost) {
  const id = nextId++;
  view.dispatch({ effects: addPending.of({ id, pos }) });
  const names: string[] = [];
  let problem: string | null = null;
  for (const file of files) {
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      names.push(await host.add(new Uint8Array(await file.arrayBuffer())));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }
  // The window may have moved on to another draft while the daemon worked.
  const at = pendingPos(view.state, id);
  if (at === null) return;
  const effects = removePending.of(id);
  view.dispatch(names.length ? { ...imageInsert(view.state, at, names), effects, userEvent: 'input.paste', scrollIntoView: true } : { effects });
  if (problem) host.failed(`Couldn't add ${files.length > 1 ? 'an image' : 'the image'}: ${problem}`);
}

function imageFiles(data: DataTransfer | null): File[] {
  return data ? [...data.files].filter((f) => IMAGE_TYPES.includes(f.type)) : [];
}

export function imagePasting(host: ImageHost): Extension {
  return [
    imageLines,
    images,
    pending,
    Prec.high(
      keymap.of([
        { key: 'ArrowUp', run: stepOntoImage(false) },
        { key: 'ArrowDown', run: stepOntoImage(true) },
      ]),
    ),
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = imageFiles(e.clipboardData);
        if (!files.length) return false;
        // Spreadsheets put a picture of the cells beside their text: paste
        // the text. A copied image file comes with only its own name.
        const names = new Set(files.map((f) => f.name));
        const text = e.clipboardData?.getData('text/plain').trim() ?? '';
        if (text && !text.split(/[\r\n]+/).every((l) => names.has(l.trim()))) return false;
        e.preventDefault();
        const { from, to } = view.state.selection.main;
        if (to > from) view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: 'delete' });
        void addImages(view, files, from, host);
        return true;
      },
      drop(e, view) {
        const files = imageFiles(e.dataTransfer);
        if (!files.length) return false;
        e.preventDefault();
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
        void addImages(view, files, pos, host);
        return true;
      },
    }),
  ];
}
