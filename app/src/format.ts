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
