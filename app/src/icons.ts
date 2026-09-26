// Stroke icons on a 24px grid: 1.75 stroke, round caps and joins, drawn at
// 18px in the toolbar. Parts marked .i-fill fill in when a toggle is pressed,
// so a toggle's state reads by shape as well as color. See
// docs/visual-design.md#iconography.

const paths = {
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  new: '<path d="M12 5.5v13M5.5 12h13"/>',
  pin: '<path class="i-fill" d="M8.8 3.8h6.4l-.9 5 3.2 3.4v1.9H6.5v-1.9l3.2-3.4z"/><path d="M12 14.1v6.1"/>',
  float:
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path class="i-fill" d="M3 8.5v-2A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v2z"/><path d="M8.5 16l3.5-3.5 3.5 3.5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  archive:
    '<rect class="i-fill" x="3" y="4" width="18" height="4.5" rx="1.25"/><path d="M4.75 8.5v9.75a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2V8.5M10 12.5h4"/>',
  trash:
    '<path d="M4 6.5h16M9.5 6.5V5A1.5 1.5 0 0 1 11 3.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path class="i-fill" d="M6 6.5l.85 12.1a2 2 0 0 0 2 1.9h6.3a2 2 0 0 0 2-1.9L18 6.5z"/>',
  window: '<path d="M10.5 4.5h-4A2.5 2.5 0 0 0 4 7v10.5A2.5 2.5 0 0 0 6.5 20H17a2.5 2.5 0 0 0 2.5-2.5v-4"/><path d="M14 3.5h6.5V10M20.5 3.5l-8 8"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  inbox: '<path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/><path d="M6 5h12l2.5 8.5V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4.5z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  up: '<path d="M6.5 14.5L12 9l5.5 5.5"/>',
  down: '<path d="M6.5 9.5L12 15l5.5-5.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  replace: '<path d="M4 8h12.5M13.5 4.5L17 8l-3.5 3.5"/><path d="M20 16H7.5M10.5 12.5L7 16l3.5 3.5"/>',
};

export type IconName = keyof typeof paths;

export function icon(name: IconName, size = 18): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}
