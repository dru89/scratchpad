// The strip above the editor: the draft's title and state, and its actions.

import type { WindowKind } from './bridge';
import type { DraftController } from './controller';
import { escapeHtml } from './format';
import { icons } from './icons';

export interface Actions {
  toggleSidebar(): void;
  newDraft(): void;
  done(): void;
  pin(): void;
  float(): void;
  copyRich(): void;
  archive(): void;
  trash(): void;
  openWindow(): void;
}

interface Button {
  id: keyof Actions;
  icon: string;
  label: string;
  kinds: WindowKind[];
  active?: () => boolean;
  needsDraft?: boolean;
}

const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';

export class Toolbar {
  constructor(
    private el: HTMLElement,
    private controller: DraftController,
    private actions: Actions,
    private status: { floating: boolean; connected: boolean },
  ) {
    controller.onChange(() => this.render());
    el.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action as keyof Actions;
      if (id) this.actions[id]();
    });
    this.render();
  }

  render() {
    const c = this.controller;
    const kind = c.kind;
    const state = c.state;
    const buttons: Button[] = [
      { id: 'newDraft', icon: icons.plus, label: `New draft (${mod}N)`, kinds: ['main'] },
      { id: 'pin', icon: icons.pin, label: `Pin: don't roll over to a new draft (${mod}Shift+P)`, kinds: ['main', 'capture'], active: () => c.pinned },
      { id: 'float', icon: icons.float, label: `Float on top (${mod}Shift+F)`, kinds: ['main', 'capture', 'draft'], active: () => this.status.floating },
      { id: 'copyRich', icon: icons.copy, label: `Copy as rich text (${mod}Shift+C)`, kinds: ['main', 'capture', 'draft'], needsDraft: true },
      {
        id: 'archive',
        icon: state === 'archived' ? icons.inbox : icons.archive,
        label: state === 'archived' ? 'Move to Inbox' : `Archive (${mod}Shift+A)`,
        kinds: ['main', 'draft', 'capture'],
        needsDraft: true,
      },
      {
        id: 'trash',
        icon: state === 'trashed' ? icons.inbox : icons.trash,
        label: state === 'trashed' ? 'Restore from Trash' : `Move to Trash (${mod}Shift+Backspace)`,
        kinds: ['main', 'draft', 'capture'],
        needsDraft: true,
      },
      { id: 'openWindow', icon: icons.window, label: `Open in new window (${mod}Shift+O)`, kinds: ['main', 'capture'], needsDraft: true },
      { id: 'done', icon: icons.check, label: `Done: keep it and start fresh (${mod}Enter)`, kinds: ['capture'] },
    ];
    const badge = state === 'archived' ? 'Archived' : state === 'trashed' ? 'In Trash' : '';
    const html = buttons
      .filter((b) => b.kinds.includes(kind))
      .map((b) => {
        const disabled = b.needsDraft && !c.draftId;
        const active = b.active?.() ? ' active' : '';
        return `<button class="tool${active}" data-action="${b.id}" title="${escapeHtml(b.label)}" aria-label="${escapeHtml(b.label)}"${disabled ? ' disabled' : ''}>${b.icon}</button>`;
      })
      .join('');
    const sidebarButton =
      kind === 'main'
        ? `<button class="tool" data-action="toggleSidebar" title="Toggle sidebar (${mod}\\)" aria-label="Toggle sidebar">${icons.sidebar}</button>`
        : '';
    this.el.innerHTML = `
      ${sidebarButton}
      <div class="toolbar-title">
        <span class="title-text">${escapeHtml(c.title)}</span>
        ${badge ? `<span class="badge">${badge}</span>` : ''}
        ${this.status.connected ? '' : '<span class="badge warn" title="Reconnecting to scratchpadd; your typing is kept">Offline</span>'}
      </div>
      <div class="tools">${html}</div>`;
  }
}
