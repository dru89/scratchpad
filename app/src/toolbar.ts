// The strip of actions for a draft: across the top of the main and draft
// windows, and along the bottom of the capture window. Actions are grouped by
// what they touch; pin, float, archive and trash are toggles (aria-pressed).
// See docs/visual-design.md#toolbar.

import type { WindowKind } from './bridge';
import type { DraftController } from './controller';
import { escapeHtml, kbd } from './format';
import { type IconName, icon } from './icons';

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

interface Tool {
  action: keyof Actions;
  icon: IconName;
  label: string;
  /** Its shortcut, like "Mod+Shift+P", shown as keycaps in the tooltip. */
  keys: string;
  /** Makes it a toggle. */
  pressed?: boolean;
  disabled?: boolean;
  /** A visible label; the capture window shows one on a pressed toggle. */
  text?: string;
}

function tool(t: Tool): string {
  return `<button class="tool" data-action="${t.action}" data-tip="${escapeHtml(t.label)}" data-keys="${t.keys}" aria-label="${escapeHtml(t.label)}"${
    t.pressed === undefined ? '' : ` aria-pressed="${t.pressed}"`
  }${t.disabled ? ' disabled' : ''}>${icon(t.icon)}${t.text ? `<span class="tool-label">${escapeHtml(t.text)}</span>` : ''}</button>`;
}

const group = (...tools: string[]) => `<div class="tool-group">${tools.join('')}</div>`;

function badge(text: string, opts: { lead: string; warn?: boolean; title?: string }): string {
  return `<span class="badge${opts.warn ? ' warn' : ''}"${opts.title ? ` data-tip="${escapeHtml(opts.title)}"` : ''}>${opts.lead}${escapeHtml(text)}</span>`;
}

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
    const kind: WindowKind = c.kind;
    const capture = kind === 'capture';
    const noDraft = !c.draftId;
    const archived = c.state === 'archived';
    const trashed = c.state === 'trashed';
    const pinned = c.pinned;
    const floating = this.status.floating;

    const pin = tool({
      action: 'pin',
      icon: 'pin',
      label: pinned ? 'Unpin' : 'Pin: keep this draft when you come back',
      keys: 'Mod+Shift+P',
      pressed: pinned,
      text: capture && pinned ? 'Pinned' : '',
    });
    const float = tool({
      action: 'float',
      icon: 'float',
      label: floating ? 'Stop floating on top' : 'Float on top',
      keys: 'Mod+Shift+F',
      pressed: floating,
      text: capture && floating ? 'On top' : '',
    });
    const copy = tool({ action: 'copyRich', icon: 'copy', label: 'Copy as rich text', keys: 'Mod+Shift+C', disabled: noDraft });
    const archive = tool({
      action: 'archive',
      icon: 'archive',
      label: archived ? 'Move to Inbox' : 'Archive',
      keys: 'Mod+Shift+A',
      pressed: archived,
      disabled: noDraft,
    });
    const trash = tool({
      action: 'trash',
      icon: 'trash',
      label: trashed ? 'Restore from Trash' : 'Move to Trash',
      keys: 'Mod+Shift+Backspace',
      pressed: trashed,
      disabled: noDraft,
    });
    const openWindow = tool({ action: 'openWindow', icon: 'window', label: 'Open in its own window', keys: 'Mod+Shift+O', disabled: noDraft });

    let badges = '';
    if (archived) badges += badge('Archived', { lead: icon('archive', 13) });
    if (trashed) badges += badge('In Trash', { lead: icon('trash', 13), warn: true, title: 'Deleted 30 days after it was trashed' });
    if (!this.status.connected) {
      badges += badge('Offline', {
        lead: '<span class="badge-dot"></span>',
        warn: true,
        title: 'Reconnecting to scratchpadd. Your typing is kept.',
      });
    }
    // The capture window shows no title: its first line is right there.
    const title = `<div class="toolbar-title">${capture ? '' : `<span class="title-text">${escapeHtml(c.title)}</span>`}${badges}</div>`;

    if (capture) {
      const done = `<button class="btn" data-action="done" data-tip="Done: file it and start fresh" data-keys="Mod+Enter">${icon('done')}Done${kbd('Mod+Enter')}</button>`;
      this.el.innerHTML = `${group(pin, float)}${title}<div class="tools">${group(copy, archive, trash, openWindow)}${done}</div>`;
    } else if (kind === 'draft') {
      this.el.innerHTML = `${title}<div class="tools">${group(float)}${group(copy)}${group(archive, trash)}</div>`;
    } else {
      const lead = group(
        tool({ action: 'toggleSidebar', icon: 'sidebar', label: 'Toggle sidebar', keys: 'Mod+\\' }),
        tool({ action: 'newDraft', icon: 'new', label: 'New draft', keys: 'Mod+N' }),
      );
      this.el.innerHTML = `${lead}${title}<div class="tools">${group(pin, float)}${group(copy)}${group(archive, trash)}${group(openWindow)}</div>`;
    }
  }
}
