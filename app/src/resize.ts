// Resizing the sidebar by dragging its edge. Double-click the edge to go back
// to the default width; with the edge focused, arrow keys resize too. The
// width is saved with the window's other preferences.

const DEFAULT_WIDTH = 272;
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;
const KEY_STEP = 16;

const clamp = (w: number) => Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w)));

export function installSidebarResize(sidebar: HTMLElement, initial: number | undefined, save: (width: number) => void) {
  const handle = document.createElement('div');
  handle.className = 'sidebar-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the sidebar');
  handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
  handle.setAttribute('aria-valuemax', String(MAX_WIDTH));
  handle.tabIndex = 0;
  handle.dataset.tip = 'Drag to resize, double-click to reset';
  sidebar.appendChild(handle);

  let width = clamp(initial ?? DEFAULT_WIDTH);
  const apply = (w: number) => {
    width = clamp(w);
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
  };
  apply(width);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = sidebar.getBoundingClientRect().left;
    let frame = 0;
    const move = (ev: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apply(ev.clientX - left));
    };
    const up = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      save(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });

  handle.addEventListener('dblclick', () => {
    apply(DEFAULT_WIDTH);
    save(width);
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next =
      e.key === 'ArrowLeft' ? width - step : e.key === 'ArrowRight' ? width + step : e.key === 'Home' ? MIN_WIDTH : e.key === 'End' ? MAX_WIDTH : null;
    if (next === null) return;
    e.preventDefault();
    apply(next);
    save(width);
  });
}
