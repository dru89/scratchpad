// The main window's list: Inbox, Archive, or Trash, newest first, with a
// filter box. Stays current through the daemon's drafts.changed/removed
// notifications.

import { bridge, type DraftState, type DraftSummary } from './bridge';
import type { DraftController } from './controller';
import { escapeHtml, relativeTime } from './format';
import type { Rpc } from './rpc';

const TABS: { state: DraftState; label: string }[] = [
  { state: 'inbox', label: 'Inbox' },
  { state: 'archived', label: 'Archive' },
  { state: 'trashed', label: 'Trash' },
];

export class Sidebar {
  tab: DraftState = 'inbox';
  private query = '';
  private items: DraftSummary[] = [];
  private listEl: HTMLElement;
  private filterEl: HTMLInputElement;
  private tabsEl: HTMLElement;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private root: HTMLElement,
    private rpc: Rpc,
    private controller: DraftController,
  ) {
    root.innerHTML = `
      <div class="tabs" role="tablist"></div>
      <input class="filter" type="search" placeholder="Filter" spellcheck="false" aria-label="Filter drafts">
      <div class="list" role="listbox" tabindex="-1"></div>`;
    this.tabsEl = root.querySelector('.tabs')!;
    this.filterEl = root.querySelector('.filter')!;
    this.listEl = root.querySelector('.list')!;

    this.tabsEl.addEventListener('click', (e) => {
      const state = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as DraftState;
      if (state) this.setTab(state);
    });
    this.filterEl.addEventListener('input', () => {
      this.query = this.filterEl.value.trim();
      this.refreshSoon(120);
    });
    this.filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.filterEl.value) {
        e.stopPropagation();
        this.filterEl.value = '';
        this.query = '';
        void this.refresh();
      } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        (this.listEl.querySelector('.item') as HTMLElement | null)?.focus();
      }
    });
    this.listEl.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) void this.open(id);
    });
    this.listEl.addEventListener('keydown', (e) => this.onListKey(e));
    this.listEl.addEventListener('contextmenu', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (!id) return;
      e.preventDefault();
      void this.contextMenu(id);
    });

    rpc.onConnect(() => void this.refresh());
    rpc.on('drafts.changed', (s: DraftSummary) => this.onChanged(s));
    rpc.on('drafts.removed', (p: { id: string }) => {
      this.items = this.items.filter((d) => d.id !== p.id);
      this.renderSoon();
    });
    controller.onChange(() => this.markSelected());
    // Keep relative times fresh.
    setInterval(() => this.render(), 60_000);
    this.renderTabs();
  }

  setTab(state: DraftState) {
    this.tab = state;
    this.renderTabs();
    void this.refresh();
  }

  focusFilter() {
    this.filterEl.focus();
    this.filterEl.select();
  }

  async refresh() {
    if (!this.rpc.ready) return;
    const r = await this.rpc.call<{ drafts: DraftSummary[] }>('drafts.list', {
      states: [this.tab],
      query: this.query || undefined,
      limit: 500,
    });
    this.items = r.drafts;
    this.render();
  }

  private refreshSoon(ms = 250) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
  }

  private onChanged(s: DraftSummary) {
    // With a filter, whether the draft still matches is the daemon's call.
    if (this.query) return this.refreshSoon();
    const i = this.items.findIndex((d) => d.id === s.id);
    if (s.state === this.tab) {
      if (i >= 0) this.items[i] = s;
      else this.items.push(s);
      this.items.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.id < b.id ? 1 : -1));
    } else if (i >= 0) {
      this.items.splice(i, 1);
    }
    this.renderSoon();
  }

  private async open(id: string) {
    if (id === this.controller.draftId) return this.controller.focus();
    await this.controller.load(id);
  }

  private async contextMenu(id: string) {
    const d = this.items.find((x) => x.id === id);
    if (!d) return;
    const items = [
      { id: 'window', label: 'Open in New Window' },
      { id: 'capture', label: 'Open in Capture Window' },
      { id: '-', label: '' },
      d.state === 'archived' ? { id: 'inbox', label: 'Move to Inbox' } : { id: 'archived', label: 'Archive' },
      d.state === 'trashed' ? { id: 'inbox', label: 'Restore from Trash' } : { id: 'trashed', label: 'Move to Trash' },
    ];
    const choice = await bridge().contextMenu(items);
    if (choice === 'window') await bridge().openDraft(id);
    else if (choice === 'capture') await bridge().openInCapture(id);
    else if (choice === 'inbox' || choice === 'archived' || choice === 'trashed') {
      await this.rpc.call('drafts.setState', { id, state: choice });
    }
  }

  private onListKey(e: KeyboardEvent) {
    const items = [...this.listEl.querySelectorAll<HTMLElement>('.item')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      next?.focus();
      if (i === 0 && e.key === 'ArrowUp') this.filterEl.focus();
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      void this.open(items[i].dataset.id!);
    }
  }

  private renderTabs() {
    this.tabsEl.innerHTML = TABS.map(
      (t, n) =>
        `<button class="tab${t.state === this.tab ? ' active' : ''}" data-tab="${t.state}" role="tab" title="${t.label} (Ctrl+${n + 1})">${t.label}</button>`,
    ).join('');
  }

  private renderSoon() {
    if (!this.renderTimer) this.renderTimer = setTimeout(() => this.render(), 50);
  }

  render() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    const now = Date.now();
    if (!this.items.length) {
      const empty = this.query ? 'No matches' : this.tab === 'inbox' ? 'Nothing here yet' : `Nothing in ${this.tab === 'trashed' ? 'the Trash' : 'the Archive'}`;
      this.listEl.innerHTML = `<div class="empty">${empty}</div>`;
      return;
    }
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.id;
    this.listEl.innerHTML = this.items
      .map((d) => {
        const selected = d.id === this.controller.draftId ? ' selected' : '';
        const snippet = d.snippet ? `<div class="item-snippet">${escapeHtml(d.snippet)}</div>` : '';
        return `<div class="item${selected}" data-id="${d.id}" role="option" tabindex="0">
          <div class="item-row"><span class="item-title">${escapeHtml(d.title)}</span><span class="item-time">${relativeTime(d.modifiedAt, now)}</span></div>
          ${snippet}
        </div>`;
      })
      .join('');
    if (focused) (this.listEl.querySelector(`[data-id="${focused}"]`) as HTMLElement | null)?.focus();
  }

  private markSelected() {
    for (const el of this.listEl.querySelectorAll<HTMLElement>('.item')) {
      el.classList.toggle('selected', el.dataset.id === this.controller.draftId);
    }
  }
}
