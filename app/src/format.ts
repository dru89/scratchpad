// Small display helpers.

/** "now", "5m", "3h", "Mon", "Sep 12", "Sep 12, 2025". */
export function relativeTime(ms: number, now = Date.now()): string {
  const secs = Math.max(0, (now - ms) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  const date = new Date(ms);
  if (secs < 6 * 86_400) return date.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
}

/**
 * The title this window shows while you type: the first line with text,
 * markdown stripped. The daemon's titles (crates/core/src/title.rs) are the
 * authority for lists; this keeps the window's own title instant.
 */
export function localTitle(text: string): string {
  for (const raw of text.split('\n', 200)) {
    let line = raw.trim();
    if (!line || /^(```|~~~)/.test(line) || /^([-*_=]\s*){3,}$/.test(line)) continue;
    if (/^[|:\-\s]+$/.test(line) && line.includes('-') && line.includes('|')) continue;
    for (let prev = ''; prev !== line; ) {
      prev = line;
      line = line
        .replace(/^>\s?/, '')
        .replace(/^#{1,6}(\s+|$)/, '')
        .replace(/^([-*+]|\d{1,9}[.)])\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        .trim();
    }
    line = line.replace(/^\|/, '').replace(/\|$/, '').trim();
    // Protect escaped characters so they aren't read as syntax.
    const escaped: string[] = [];
    line = line.replace(/\\(.)/g, (_, c: string) => `\u0000${escaped.push(c) - 1}\u0001`);
    line = line
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?=[^\w*]|$)/g, '$1$2')
      .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1$2')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\u0000(\d+)\u0001/g, (_, i: string) => escaped[Number(i)])
      .replace(/\s+/g, ' ')
      .trim();
    if (line) return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  }
  return '';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');
const KEY_GLYPHS: Record<string, string> = { Mod: isMac ? '⌘' : 'Ctrl', Enter: '↵', Backspace: '⌫', Up: '↑', Down: '↓' };

const MAC_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Mod'];
const MAC_GLYPHS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Enter: '↩', Backspace: '⌫' };

/**
 * A shortcut as text, for tooltips: shortcut('Mod+Shift+P') is "Ctrl+Shift+P",
 * or "⇧⌘P" on macOS, with the modifiers in the order macOS menus use.
 */
export function shortcut(keys: string, mac = isMac): string {
  const parts = keys.split('+');
  if (!mac) return parts.map((k) => (k === 'Mod' ? 'Ctrl' : k)).join('+');
  const key = parts.pop()!;
  parts.sort((a, b) => MAC_MODIFIERS.indexOf(a) - MAC_MODIFIERS.indexOf(b));
  return [...parts, key].map((k) => MAC_GLYPHS[k] ?? k).join('');
}

/** Keycaps, one per key: kbd('Mod+Shift+A'). Mod is Ctrl, or ⌘ on macOS. */
export function kbd(keys: string): string {
  return keys
    .split('+')
    .map((k) => `<kbd class="kbd">${escapeHtml(KEY_GLYPHS[k] ?? k)}</kbd>`)
    .join('');
}

/** The words and "quoted phrases" of a search, the way the daemon splits them. */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const term = (m[1] ?? m[2]).trim();
    if (term) terms.push(term);
  }
  return terms;
}

/** Escapes text and wraps each case-insensitive match of any term in <mark>. */
export function markMatches(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const hits: [number, number][] = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    for (let at = lower.indexOf(t); t && at >= 0; at = lower.indexOf(t, at + t.length)) hits.push([at, at + t.length]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [from, to] of hits) {
    if (from < pos) continue;
    out += `${escapeHtml(text.slice(pos, from))}<mark>${escapeHtml(text.slice(from, to))}</mark>`;
    pos = to;
  }
  return out + escapeHtml(text.slice(pos));
}
