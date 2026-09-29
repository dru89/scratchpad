// Pasting formatted text (docs/design.md#pasting). HTML on the clipboard
// becomes markdown, so headings, bold, lists, links, code and tables from
// Google Docs, Word, Slack, Confluence or a web page arrive as the markdown
// the editor shows. Formatting comes from tags and from inline styles, since
// Google Docs marks bold with font-weight rather than <b>.

import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insideNode } from './livepreview';

interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  s?: boolean;
  code?: boolean;
  href?: string;
  /** A line break. */
  br?: boolean;
  /** Markdown already, like an image: no escaping. */
  raw?: boolean;
}

type Block =
  | { kind: 'para'; runs: Run[] }
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Item[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; rows: Run[][][] }
  | { kind: 'rule' };

interface Item {
  task: 'open' | 'done' | null;
  blocks: Block[];
}

type ListBlock = Extract<Block, { kind: 'list' }>;

interface Ctx {
  b?: boolean;
  i?: boolean;
  s?: boolean;
  code?: boolean;
  href?: string;
  /** Inside a heading, which is bold already. */
  heading?: boolean;
}

const SKIP = new Set(['head', 'script', 'style', 'title', 'meta', 'link', 'noscript', 'template', 'svg', 'button', 'select', 'textarea', 'iframe', 'object']);
/** Containers whose boundaries are line breaks, the way they render. */
const LINES = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'address', 'center', 'dl', 'dt', 'dd', 'form', 'fieldset', 'details', 'summary', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption']);
const MONO = /\b(mono|monospace|courier|consolas|menlo|monaco|source code|fira code)\b/;

function styles(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const at = decl.indexOf(':');
    if (at > 0) out[decl.slice(0, at).trim().toLowerCase()] = decl.slice(at + 1).trim().toLowerCase();
  }
  return out;
}

function hidden(el: Element): boolean {
  const s = styles(el);
  return s.display === 'none' || s.visibility === 'hidden' || s['mso-list'] === 'ignore';
}

/** The formatting an inline element adds. A style wins over its tag: Google Docs wraps a whole paste in <b style="font-weight:normal">. */
function format(el: Element, ctx: Ctx): Ctx {
  const tag = el.localName;
  const s = styles(el);
  const next = { ...ctx };
  if (tag === 'b' || tag === 'strong') next.b = true;
  if (tag === 'i' || tag === 'em') next.i = true;
  if (tag === 's' || tag === 'del' || tag === 'strike') next.s = true;
  if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') next.code = true;
  const weight = s['font-weight'];
  if (weight) next.b = weight === 'bold' || weight === 'bolder' || Number.parseInt(weight, 10) >= 600;
  if (s['font-style']) next.i = s['font-style'] === 'italic' || s['font-style'] === 'oblique';
  if ((s['text-decoration'] ?? s['text-decoration-line'] ?? '').includes('line-through')) next.s = true;
  if (MONO.test(s['font-family'] ?? '')) next.code = true;
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    next.href = /^(https?:|mailto:)/i.test(href) ? href : undefined;
  }
  if (ctx.heading) next.b = false;
  return next;
}

function run(text: string, ctx: Ctx): Run {
  return { text, b: ctx.b, i: ctx.i, s: ctx.s, code: ctx.code, href: ctx.href };
}

/** A <pre>'s text, with line breaks where its markup has them. */
function preText(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += (child as Text).data;
    else if (child.nodeType === 1) {
      const el = child as Element;
      if (el.localName === 'br') out += '\n';
      else if (!SKIP.has(el.localName)) {
        const block = LINES.has(el.localName) || el.localName === 'p';
        if (block && out && !out.endsWith('\n')) out += '\n';
        out += preText(el);
        if (block && !out.endsWith('\n')) out += '\n';
      }
    }
  }
  return out;
}

/** Word's list paragraphs: <p style="mso-list:l0 level2 lfo1"> with the bullet in a span to skip. */
function wordListItem(el: Element): { level: number; ordered: boolean } | null {
  const m = /level(\d+)/.exec(styles(el)['mso-list'] ?? '');
  if (!m) return null;
  const marker = [...el.querySelectorAll('span')].find((s) => styles(s)['mso-list'] === 'ignore')?.textContent?.trim() ?? '';
  return { level: Number(m[1]), ordered: /^([0-9]+|[a-z]|[ivxlc]+)[.)]/i.test(marker) };
}

class Walker {
  blocks: Block[] = [];
  private runs: Run[] = [];
  /** Word list levels being built, deepest last. */
  private wordLists: ListBlock[] = [];

  flush() {
    if (this.runs.some((r) => r.br || r.raw || r.text.trim())) this.blocks.push({ kind: 'para', runs: this.runs });
    this.runs = [];
  }

  private push(block: Block) {
    this.flush();
    this.wordLists = [];
    this.blocks.push(block);
  }

  private lineBreak() {
    const last = this.runs.at(-1);
    if (last && !last.br) this.runs.push({ text: '', br: true });
  }

  walk(node: Node, ctx: Ctx) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        this.runs.push(run((child as Text).data, ctx));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.localName;
      if (SKIP.has(tag) || hidden(el)) continue;
      if (tag === 'br') {
        this.runs.push({ text: '', br: true });
      } else if (tag === 'img') {
        const src = el.getAttribute('src') ?? '';
        // A data: URL would bury the text in base64; remote images keep their link.
        if (/^https?:/i.test(src)) {
          const alt = (el.getAttribute('alt') ?? '').replace(/[[\]\n]/g, ' ').trim();
          this.runs.push({ text: `![${alt}](${destination(src)})`, raw: true });
        }
      } else if (tag === 'p' && wordListItem(el)) {
        this.wordItem(el, ctx);
      } else if (tag === 'p') {
        this.flush();
        this.wordLists = [];
        this.walk(el, ctx);
        this.flush();
      } else if (/^h[1-6]$/.test(tag)) {
        const inner = new Walker();
        inner.walk(el, { ...ctx, heading: true, b: false });
        inner.flush();
        const runs = inner.blocks.flatMap((b) => ('runs' in b ? [...b.runs, { text: ' ' }] : []));
        this.push({ kind: 'heading', level: Number(tag[1]), runs });
      } else if (tag === 'ul' || tag === 'ol') {
        this.push(list(el, ctx));
      } else if (tag === 'blockquote') {
        const inner = new Walker();
        inner.walk(el, ctx);
        inner.flush();
        this.push({ kind: 'quote', blocks: inner.blocks });
      } else if (tag === 'pre') {
        const lang = /(?:language|lang)-([\w+#-]+)/.exec(`${el.className} ${el.querySelector('code')?.className ?? ''}`)?.[1] ?? '';
        this.push({ kind: 'code', lang, text: preText(el).replace(/\n+$/, '') });
      } else if (tag === 'hr') {
        this.push({ kind: 'rule' });
      } else if (tag === 'table' && isDataTable(el)) {
        this.push({ kind: 'table', rows: tableRows(el, ctx) });
      } else if (tag === 'li') {
        // A stray <li> outside a list.
        this.push({ kind: 'list', ordered: false, start: 1, items: [item(el, ctx)] });
      } else if (LINES.has(tag) || tag === 'table') {
        this.lineBreak();
        this.walk(el, ctx);
        this.lineBreak();
      } else {
        this.walk(el, format(el, ctx));
      }
    }
  }

  private wordItem(el: Element, ctx: Ctx) {
    const { level, ordered } = wordListItem(el)!;
    this.flush();
    const inner = new Walker();
    inner.walk(el, ctx);
    inner.flush();
    const entry: Item = { task: null, blocks: inner.blocks };
    if (!this.wordLists.length) {
      const root: ListBlock = { kind: 'list', ordered, start: 1, items: [] };
      this.blocks.push(root);
      this.wordLists = [root];
    }
    while (this.wordLists.length > level && this.wordLists.length > 1) this.wordLists.pop();
    while (this.wordLists.length < level) {
      const parent = this.wordLists.at(-1)!;
      if (!parent.items.length) parent.items.push({ task: null, blocks: [] });
      const nested: ListBlock = { kind: 'list', ordered, start: 1, items: [] };
      parent.items.at(-1)!.blocks.push(nested);
      this.wordLists.push(nested);
    }
    this.wordLists.at(-1)!.items.push(entry);
  }
}

function item(li: Element, ctx: Ctx): Item {
  const box = li.querySelector('input[type="checkbox"]');
  const inner = new Walker();
  inner.walk(li, ctx);
  inner.flush();
  return { task: box ? (box.hasAttribute('checked') ? 'done' : 'open') : null, blocks: inner.blocks };
}

function list(el: Element, ctx: Ctx): ListBlock {
  const block: ListBlock = {
    kind: 'list',
    ordered: el.localName === 'ol',
    start: Number.parseInt(el.getAttribute('start') ?? '1', 10) || 1,
    items: [],
  };
  for (const child of el.children) {
    if (child.localName === 'li') block.items.push(item(child, ctx));
    else if (child.localName === 'ul' || child.localName === 'ol') {
      // A list nested directly in a list, as some editors write it: it belongs to the item before.
      if (!block.items.length) block.items.push({ task: null, blocks: [] });
      block.items.at(-1)!.blocks.push(list(child, ctx));
    }
  }
  return block;
}

function ownRows(table: Element): Element[] {
  return [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
}

/** A table of data rather than one laying out an email: two columns or more, and no tables inside. */
function isDataTable(table: Element): boolean {
  if (table.querySelector('table')) return false;
  return ownRows(table).some((tr) => [...tr.children].filter((c) => c.localName === 'td' || c.localName === 'th').length > 1);
}

function tableRows(table: Element, ctx: Ctx): Run[][][] {
  return ownRows(table).map((tr) => {
    const cells: Run[][] = [];
    for (const cell of tr.children) {
      if (cell.localName !== 'td' && cell.localName !== 'th') continue;
      const inner = new Walker();
      inner.walk(cell, ctx);
      inner.flush();
      const runs = inner.blocks.flatMap((b, n) => [...(n ? [{ text: '', br: true }] : []), ...('runs' in b ? b.runs : [])]);
      cells.push(runs);
      const span = Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1;
      for (let n = 1; n < span; n++) cells.push([]);
    }
    return cells;
  });
}

// ---- writing markdown --------------------------------------------------------

const DELIMS = { b: '**', i: '*', s: '~~' } as const;
type Delim = keyof typeof DELIMS;

/** A link destination, in angle brackets when it has spaces or parentheses. */
function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}

/**
 * Backslashes where text would otherwise read as markdown, and nowhere else,
 * since every one shows in the editor: a lone "5 * 3" stays as it is.
 */
function escapeText(text: string, cell: boolean): string {
  let out = text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/~~/g, '\\~\\~')
    .replace(/\](?=\()/g, '\\]')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&');
  // * and _ only where they could open or close emphasis: next to text, and
  // for _, not inside a word, where it can't.
  out = out.replace(/\*/g, (m, at: number, s: string) => (/\s/.test(s[at - 1] ?? ' ') && /\s/.test(s[at + 1] ?? ' ') ? m : '\\*'));
  out = out.replace(/_/g, (m, at: number, s: string) => {
    const before = s[at - 1] ?? ' ';
    const after = s[at + 1] ?? ' ';
    const word = /[\p{L}\p{N}]/u;
    if (word.test(before) && word.test(after)) return m;
    return /\s/.test(before) && /\s/.test(after) ? m : '\\_';
  });
  return cell ? out.replace(/\|/g, '\\|') : out;
}

/** A line that would start a block: a heading, list, quote or rule. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}(?=\s|$)|[-+*](?=\s|$)|>|=+\s*$|-{3,}\s*$)/, '$1\\$2')
    .replace(/^(\s*\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((t) => t.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** Whitespace collapsed as HTML renders it, code runs merged, and links that just repeat their address made plain. */
function normalize(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const text = r.br || r.raw ? r.text : r.text.replace(/[\s ]+/g, ' ');
    const prev = out.at(-1);
    if (prev && r.code && prev.code && !prev.br && prev.href === r.href && prev.b === r.b && prev.i === r.i && prev.s === r.s) {
      prev.text += text;
    } else {
      out.push({ ...r, text });
    }
  }
  // A link whose text is its own address becomes the bare address, which is
  // a link in markdown too.
  for (let start = 0; start < out.length; ) {
    const href = out[start].href;
    let end = start + 1;
    while (href && end < out.length && out[end].href === href) end++;
    if (href) {
      const text = out
        .slice(start, end)
        .map((r) => r.text)
        .join('')
        .trim();
      if (text === href || `mailto:${text}` === href) {
        for (let n = start; n < end; n++) out[n] = { ...out[n], href: undefined, raw: !out[n].code };
      }
    }
    start = end;
  }
  return out;
}

/** Inline runs as markdown: marks opened and closed as they change, whitespace kept outside the delimiters. */
function writeRuns(runs: Run[], cell = false): string {
  let out = '';
  const open: { key: Delim | 'href'; href?: string }[] = [];
  let space = false;
  let lineStart = true;
  const wanted = (r: Run, m: { key: Delim | 'href'; href?: string }) => (m.key === 'href' ? r.href === m.href : !!r[m.key]);
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      const m = open.pop()!;
      out += m.key === 'href' ? `](${destination(m.href!)})` : DELIMS[m.key];
    }
  };
  for (const r of normalize(runs)) {
    if (r.br) {
      closeTo(0);
      space = false;
      out = out.replace(/ +$/, '') + (cell ? ' ' : '\n');
      lineStart = true;
      continue;
    }
    const core = r.text.trim();
    if (!core) {
      if (r.text && !lineStart) space = true;
      continue;
    }
    let keep = open.findIndex((m) => !wanted(r, m));
    if (keep < 0) keep = open.length;
    closeTo(keep);
    if ((space || /^\s/.test(r.text)) && !lineStart) out += ' ';
    space = false;
    if (r.href && !open.some((m) => m.key === 'href')) {
      out += '[';
      open.push({ key: 'href', href: r.href });
    }
    for (const key of ['b', 'i', 's'] as const) {
      if (r[key] && !open.some((m) => m.key === key)) {
        out += DELIMS[key];
        open.push({ key });
      }
    }
    out += r.code ? codeSpan(core) : r.raw ? core : escapeText(core, cell);
    lineStart = false;
    if (/\s$/.test(r.text)) space = true;
  }
  closeTo(0);
  return out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function writeBlock(block: Block): string {
  switch (block.kind) {
    case 'para':
      return writeRuns(block.runs)
        .split('\n')
        .map(escapeLineStart)
        .join('\n');
    case 'heading': {
      const text = writeRuns(block.runs).replace(/\n/g, ' ');
      return text ? `${'#'.repeat(block.level)} ${text}` : '';
    }
    case 'rule':
      return '---';
    case 'code': {
      const longest = Math.max(2, ...(block.text.match(/`+/g) ?? []).map((t) => t.length));
      const fence = '`'.repeat(longest + 1);
      return `${fence}${block.lang}\n${block.text}\n${fence}`;
    }
    case 'quote':
      return block.blocks
        .map(writeBlock)
        .filter(Boolean)
        .join('\n\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'list':
      return block.items
        .map((entry, n) => {
          const marker = block.ordered ? `${block.start + n}.` : '-';
          const task = entry.task === 'done' ? ' [x]' : entry.task === 'open' ? ' [ ]' : '';
          const lines = entry.blocks.map(writeBlock).filter(Boolean).join('\n').split('\n');
          return lines.map((line, k) => (k ? (line ? `\t${line}` : '') : `${marker}${task} ${line}`.trimEnd())).join('\n');
        })
        .join('\n');
    case 'table': {
      const width = Math.max(...block.rows.map((r) => r.length));
      if (!width) return '';
      const row = (cells: Run[][]) =>
        `| ${Array.from({ length: width }, (_, n) => writeRuns(cells[n] ?? [], true)).join(' | ')} |`;
      const [head, ...body] = block.rows;
      return [row(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(row)].join('\n');
    }
  }
}

/** Whether the HTML is all code, as a code editor or terminal copies it: its own text is what was copied. */
function isCodeCopy(body: HTMLElement): boolean {
  const walker = body.ownerDocument.createTreeWalker(body, 4);
  let any = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    any = true;
    let code = false;
    for (let el = node.parentElement; el && el !== body.parentElement; el = el.parentElement) {
      const s = styles(el);
      if (el.localName === 'pre' || el.localName === 'code' || MONO.test(s['font-family'] ?? '') || s['white-space']?.startsWith('pre')) {
        code = true;
        break;
      }
    }
    if (!code) return false;
  }
  return any;
}

/**
 * Markdown for clipboard HTML, or null when the clipboard's plain text
 * should be pasted instead: for a copy from a code editor, or HTML with no
 * text.
 */
export function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body || isCodeCopy(doc.body)) return null;
  const walker = new Walker();
  walker.walk(doc.body, {});
  walker.flush();
  const md = walker.blocks
    .map(writeBlock)
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md || null;
}

/** Text compared without markdown escapes or spacing, to tell whether HTML carried any formatting. */
function bare(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/\s+/g, ' ').trim();
}

/** The markup "Copy as Rich Text" adds (app/electron/main.ts): its plain text is the draft's own markdown. */
export const OWN_HTML = '<meta name="generator" content="scratchpad">';

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock']);
const BLOCK_START = /^(#{1,6} |[-+] |\d+\. |> |\||```|---$)/;

/** What a paste of `md` inserts at the cursor: a table, list or heading starts on a line of its own. */
function placed(state: EditorState, md: string): string {
  const { from, to } = state.selection.main;
  const before = state.doc.sliceString(state.doc.lineAt(from).from, from);
  const after = state.doc.sliceString(to, state.doc.lineAt(to).to);
  const lines = md.split('\n');
  const lead = before.trim() && BLOCK_START.test(lines[0]) ? '\n' : '';
  const trail = after.trim() && lines.length > 1 && BLOCK_START.test(lines.at(-1)!) ? '\n' : '';
  return lead + md + trail;
}

export const richPasting = EditorView.domEventHandlers({
  paste(e, view) {
    const data = e.clipboardData;
    const html = data?.getData('text/html');
    if (!data || !html || html.includes(OWN_HTML)) return false;
    const { from, to } = view.state.selection.main;
    if (insideNode(view.state, from, CODE_NODES) || insideNode(view.state, to, CODE_NODES)) return false;
    const md = htmlToMarkdown(html);
    const plain = data.getData('text/plain');
    // No formatting worth keeping: the plain text keeps the source's own spacing.
    if (md === null || (plain && bare(md) === bare(plain))) return false;
    e.preventDefault();
    view.dispatch(view.state.replaceSelection(placed(view.state, md)), { userEvent: 'input.paste', scrollIntoView: true });
    return true;
  },
});
