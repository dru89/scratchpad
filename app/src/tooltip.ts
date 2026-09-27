// Tooltips for anything with data-tip: its label, and its shortcut as
// keycaps when it has data-keys ("Mod+Shift+P"). Ours instead of title
// attributes, which Electron shows late or not at all on macOS and can't
// hold keycaps. One shows after a short hover or on keyboard focus, and
// moving on to the next tool shows the next one at once.

import { escapeHtml, kbd } from './format';

const DELAY_MS = 450;
/** How long after one tooltip hides the next shows without the delay. */
const WARM_MS = 600;
const GAP_PX = 6;

export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);

  let target: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt = 0;

  const show = (el: HTMLElement) => {
    if (!el.isConnected || !el.dataset.tip) return;
    target = el;
    const keys = el.dataset.keys ? `<span class="tip-keys">${kbd(el.dataset.keys)}</span>` : '';
    tip.innerHTML = `<span>${escapeHtml(el.dataset.tip)}</span>${keys}`;
    tip.hidden = false;
    // Below the element, or above it when there's no room (the capture
    // window's toolbar is at the bottom).
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const top = r.bottom + GAP_PX + t.height <= innerHeight ? r.bottom + GAP_PX : r.top - GAP_PX - t.height;
    const left = Math.max(GAP_PX, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - GAP_PX));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  const hide = () => {
    clearTimeout(timer);
    if (!tip.hidden) hiddenAt = Date.now();
    tip.hidden = true;
    target = null;
  };

  const arm = (el: HTMLElement) => {
    clearTimeout(timer);
    target = el;
    if (!tip.hidden || Date.now() - hiddenAt < WARM_MS) show(el);
    else timer = setTimeout(() => show(el), DELAY_MS);
  };

  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-tip]');
    if (el === target) return;
    if (el) arm(el);
    else hide();
  });
  document.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    if (el.dataset?.tip && el.matches(':focus-visible')) arm(el);
  });
  document.addEventListener('focusout', hide);
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(type, hide, true);
  window.addEventListener('blur', hide);
}
