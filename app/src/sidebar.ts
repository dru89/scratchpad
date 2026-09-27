// The main window's list: Inbox, Archive, or Trash, newest first, with a
// filter box. Stays current through the daemon's drafts.changed/removed
// notifications.

import { bridge, type DraftState, type DraftSummary } from './bridge';
import type { DraftController } from './controller';
import { COPY_ITEMS, type CopyWhat, copyDraft, duplicateDraft, getDraft } from './draftops';
import { escapeHtml, kbd, markMatches, relativeTime, searchTerms } from './format';
import { icon } from './icons';
import type { Rpc } from './rpc';

const TABS: { state: DraftState; label: string }[] = [
  { state: 'inbox', label: 'Inbox' },
  { state: 'archived', label: 'Archive' },
  { state: 'trashed', label: 'Trash' },
];

const label = (state: DraftState) => TABS.find((t) => t.state === state)!.label;

/** What an empty list says: a fact, and how to change it. */
function emptyState(tab: DraftState, query: string): string {
  if (query) {
    return `<div class="empty"><p class="empty-title">No drafts match “${escapeHtml(query)}”</p><p class="empty-hint">${kbd('Esc')} clears the filter</p></div>`;
  }
  const [iconName, title, hint] =
    tab === 'archived'
      ? (['archive', 'Nothing archived', `${kbd('Mod+Shift+A')} files a draft here<br>when you’re done with it`] as const)
      : tab === 'trashed'
        ? (['trash', 'Trash is empty', 'Drafts here are deleted<br>after 30 days'] as const)
        : (['inbox', 'Nothing in the Inbox', `${kbd('Mod+N')} starts a draft`] as const);
  return `<div class="empty">${icon(iconName, 22)}<p class="empty-title">${title}</p><p class="empty-hint">${hint}</p></div>`;
}

export class Sidebar {
  tab: DraftState = 'inbox';
  private query = '';
  private items: DraftSummary[] = [];
  private listEl: HTMLElement;
  private metaEl: HTMLElement;
  private filterEl: HTMLInputElement;
  private tabsEl: HTMLElement;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private root: HTMLElement,
    private rpc: Rpc,
    private controller: DraftController,
    private ui: { toast(message: string): void; info(id: string): void },
  ) {
    root.innerHTML = `
      <div class="tabs" role="tablist"></div>
      <label class="filter-field">
        ${icon('search', 15)}
        <input class="filter" type="search" placeholder="Filter Inbox" spellcheck="false" aria-label="Filter drafts">
        ${kbd('Esc')}
      </label>
      <div class="list-meta" hidden></div>
      <div class="list" role="listbox" tabindex="-1"></div>`;
    this.tabsEl = root.querySelector('.tabs')!;
    this.filterEl = root.querySelector('.filter')!;
    this.metaEl = root.querySelector('.list-meta')!;
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
    const sep = { id: '-', label: '' };
    const items = [
      { id: 'window', label: 'Open in New Window' },
      { id: 'capture', label: 'Open in Capture Window' },
      sep,
      d.state === 'archived' ? { id: 'inbox', label: 'Move to Inbox' } : { id: 'archived', label: 'Archive' },
      d.state === 'trashed' ? { id: 'inbox', label: 'Restore from Trash' } : { id: 'trashed', label: 'Move to Trash' },
      sep,
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'info', label: 'Get Info' },
      { id: 'copy', label: 'Copy', submenu: COPY_ITEMS },
      ...(this.tab === 'trashed' ? [sep, { id: 'empty', label: 'Empty Trash…' }] : []),
    ];
    const choice = await bridge().contextMenu(items);
    try {
      if (choice === 'window') await bridge().openDraft(id);
      else if (choice === 'capture') await bridge().openInCapture(id);
      else if (choice === 'inbox' || choice === 'archived' || choice === 'trashed') {
        await this.rpc.call('drafts.setState', { id, state: choice });
      } else if (choice === 'duplicate') {
        const copy = await duplicateDraft(this.rpc, (await getDraft(this.rpc, id)).text);
        if (this.tab !== 'inbox') this.setTab('inbox');
        await this.controller.load(copy);
        this.ui.toast('Duplicated');
      } else if (choice === 'info') this.ui.info(id);
      else if (choice?.startsWith('copy:')) this.ui.toast(await copyDraft(this.rpc, id, choice.slice(5) as CopyWhat));
      else if (choice === 'empty') await bridge().emptyTrash();
    } catch {
      this.ui.toast("That didn't work: scratchpadd isn't reachable");
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
        `<button class="tab${t.state === this.tab ? ' active' : ''}" data-tab="${t.state}" role="tab" aria-selected="${t.state === this.tab}" data-tip="${t.label}" data-keys="Mod+${n + 1}">${t.label}</button>`,
    ).join('');
    this.filterEl.placeholder = `Filter ${label(this.tab)}`;
  }

  private renderSoon() {
    if (!this.renderTimer) this.renderTimer = setTimeout(() => this.render(), 50);
  }

  render() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    const now = Date.now();
    this.metaEl.hidden = !this.query || !this.items.length;
    this.metaEl.textContent = `${this.items.length} in ${label(this.tab)}`;
    if (!this.items.length) {
      this.listEl.innerHTML = emptyState(this.tab, this.query);
      return;
    }
    const terms = searchTerms(this.query);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.id;
    this.listEl.innerHTML = this.items
      .map((d) => {
        const selected = d.id === this.controller.draftId ? ' selected' : '';
        // While filtering, the text around the match takes the preview's place.
        const text = d.snippet ? markMatches(d.snippet, terms) : escapeHtml(d.preview ?? '');
        return `<div class="item${selected}" data-id="${d.id}" role="option" tabindex="0">
          <div class="item-title">${markMatches(d.title, terms)}</div>
          ${text ? `<div class="item-snippet">${text}</div>` : ''}
          <div class="item-time">${relativeTime(d.modifiedAt, now)}</div>
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
