// Get Info (Ctrl+I): a draft's place, dates, size, id and link, over the
// window like the quick switcher. Esc or a click outside closes it.

import { copyDraft, draftLink, getDraft } from './draftops';
import { escapeHtml, kbd } from './format';
import type { Rpc } from './rpc';

const PLACES = { inbox: 'Inbox', archived: 'Archive', trashed: 'Trash' };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export class InfoPanel {
  private el: HTMLElement;
  private box: HTMLElement;
  private id: string | null = null;

  constructor(
    private rpc: Rpc,
    private toast: (message: string) => void,
    private onClose: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'switcher info';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="switcher-box info-box" role="dialog" aria-label="Draft info" tabindex="-1"></div>`;
    document.body.appendChild(this.el);
    this.box = this.el.querySelector('.info-box')!;

    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.box.addEventListener('click', (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]')?.dataset.copy;
      if (what && this.id) void copyDraft(this.rpc, this.id, what as 'id' | 'link').then(this.toast);
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  async show(id: string) {
    const d = await getDraft(this.rpc, id);
    this.id = d.id;
    const words = d.text.trim() ? d.text.trim().split(/\s+/).length : 0;
    const chars = [...d.text].length;
    const row = (label: string, value: string) => `<dt>${label}</dt><dd>${value}</dd>`;
    const copyable = (value: string, what: string) =>
      `<code data-tip="${escapeHtml(value)}">${escapeHtml(value)}</code><button class="btn" data-copy="${what}">Copy</button>`;
    this.box.innerHTML = `
      <h2 class="info-title">${escapeHtml(d.title)}</h2>
      <dl class="info-rows">
        ${row('In', PLACES[d.state])}
        ${row('Created', when(d.createdAt))}
        ${row('Modified', when(d.modifiedAt))}
        ${d.trashedAt ? row('Trashed', when(d.trashedAt)) : ''}
        ${row('Length', `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}, ${chars.toLocaleString()} ${chars === 1 ? 'character' : 'characters'}`)}
        ${row('ID', copyable(d.id, 'id'))}
        ${row('Link', copyable(draftLink(d.id), 'link'))}
      </dl>
      <div class="switcher-foot"><span>${kbd('Esc')} close</span></div>`;
    this.el.hidden = false;
    this.box.focus();
  }

  close() {
    this.el.hidden = true;
    this.id = null;
    this.onClose();
  }
}
