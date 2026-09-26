// Ctrl+K: jump to any draft in the Inbox or Archive by title or text. Enter
// opens it in this window; Ctrl+Enter opens it in its own window.

import { bridge, type DraftSummary } from './bridge';
import type { DraftController } from './controller';
import { escapeHtml, relativeTime } from './format';
import type { Rpc } from './rpc';

export class Switcher {
  private el: HTMLElement;
  private input: HTMLInputElement;
  private listEl: HTMLElement;
  private results: DraftSummary[] = [];
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(
    private rpc: Rpc,
    private controller: DraftController,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'switcher';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="switcher-box" role="dialog" aria-label="Open a draft">
        <input type="search" placeholder="Find a draft" spellcheck="false">
        <div class="switcher-list" role="listbox"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.input = this.el.querySelector('input')!;
    this.listEl = this.el.querySelector('.switcher-list')!;

    this.input.addEventListener('input', () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.search(), 80);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.listEl.addEventListener('click', (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>('[data-index]')?.dataset.index);
      if (!Number.isNaN(i)) void this.choose(i, e.ctrlKey || e.metaKey);
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.input.value = '';
    this.input.focus();
    void this.search();
  }

  close() {
    this.el.hidden = true;
    this.results = [];
    this.listEl.innerHTML = '';
    this.controller.focus();
  }

  private async search() {
    const seq = ++this.seq;
    const query = this.input.value.trim();
    const r = await this.rpc
      .call<{ drafts: DraftSummary[] }>('drafts.list', { states: ['inbox', 'archived'], query: query || undefined, limit: 30 })
      .catch(() => ({ drafts: [] as DraftSummary[] }));
    if (seq !== this.seq) return;
    this.results = r.drafts;
    this.index = 0;
    this.render();
  }

  private render() {
    const now = Date.now();
    this.listEl.innerHTML = this.results.length
      ? this.results
          .map(
            (d, i) => `<div class="switcher-item${i === this.index ? ' active' : ''}" data-index="${i}" role="option">
              <div class="item-row"><span class="item-title">${escapeHtml(d.title)}</span>
              <span class="item-time">${d.state === 'archived' ? 'Archive · ' : ''}${relativeTime(d.modifiedAt, now)}</span></div>
              ${d.snippet ? `<div class="item-snippet">${escapeHtml(d.snippet)}</div>` : ''}
            </div>`,
          )
          .join('')
      : `<div class="empty">No matches</div>`;
    this.listEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.results.length;
      if (n) this.index = (this.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void this.choose(this.index, e.ctrlKey || e.metaKey);
    }
  }

  private async choose(i: number, newWindow: boolean) {
    const d = this.results[i];
    if (!d) return;
    this.close();
    if (newWindow) await bridge().openDraft(d.id);
    else await this.controller.load(d.id);
  }
}
