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
 * When a draft was last modified, for a sidebar row where the time has its
 * own line: "Just now", "12 minutes ago", "Today at 3:04 PM", "Yesterday at
 * 3:04 PM", "Monday at 3:04 PM", "Sep 12", "Sep 12, 2025". The time of day
 * follows the locale's clock.
 */
export function longTime(ms: number, now = Date.now(), locale?: string): string {
  const mins = Math.floor(Math.max(0, now - ms) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const date = new Date(ms);
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const days = dayNumber(new Date(now)) - dayNumber(date);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  if (days < 7) return `${date.toLocaleDateString(locale, { weekday: 'long' })} at ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Days since the epoch in local time, so "yesterday" follows the calendar, not 24 hours. */
const dayNumber = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

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
const KEY_GLYPHS: Record<string, string> = { Enter: '↵', Backspace: '⌫', Up: '↑', Down: '↓' };

/** macOS modifier glyphs, in the order macOS menus list them. */
const MAC_MODIFIERS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const MAC_ORDER = Object.keys(MAC_MODIFIERS);

/**
 * Keycaps, one per key: kbd('Mod+Shift+A'). Mod is Ctrl; on macOS it's ⌘,
 * the other modifiers are glyphs too, and they come in menu order (⇧⌘A).
 */
export function kbd(keys: string, mac = isMac): string {
  let parts = keys.split('+');
  if (mac) {
    const key = parts.pop()!;
    parts = [...parts.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).map((k) => MAC_MODIFIERS[k] ?? k), key];
  }
  return parts
    .map((k) => `<kbd class="kbd">${escapeHtml(k === 'Mod' ? 'Ctrl' : (KEY_GLYPHS[k] ?? k))}</kbd>`)
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
