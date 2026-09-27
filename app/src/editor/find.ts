// Find in draft (Ctrl+F): one slim row in CodeMirror's top panel slot, with
// replace on a second row that opens with Ctrl+H (⌘⌥F on macOS, where ⌘H
// hides the app) or its toggle. Replaces
// CodeMirror's default panel; the search itself is still @codemirror/search.

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { type EditorView, type Panel, runScopeHandlers, type ViewUpdate } from '@codemirror/view';
import { escapeHtml, isMac, shortcut } from '../format';
import { icon } from '../icons';

/** Opens the replace row: Ctrl+H, or ⌘⌥F on macOS, where ⌘H hides the app. */
export const REPLACE_KEY = { key: 'Mod-h', mac: 'Mod-Alt-f' };
const REPLACE_KEYS = shortcut(isMac ? 'Mod+Alt+F' : 'Mod+H');

/** Stop counting here, so a long draft with a common query stays cheap. */
const MAX_COUNT = 999;

const panels = new WeakMap<EditorView, FindPanel>();

export function createFindPanel(view: EditorView): Panel {
  const panel = new FindPanel(view);
  panels.set(view, panel);
  return panel;
}

/** Opens find with the replace row showing. */
export function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  panels.get(view)?.showReplace(true);
  return true;
}

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private countEl: HTMLElement;
  private replaceRow: HTMLElement;
  private replaceToggle: HTMLButtonElement;
  private countTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    const tool = (name: string, iconName: Parameters<typeof icon>[0], label: string) =>
      `<button class="tool" name="${name}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label.replace(/ \(.*\)$/, ''))}">${icon(iconName)}</button>`;
    const option = (name: string, text: string, label: string) =>
      `<button class="find-opt" name="${name}" title="${label}" aria-label="${label}" aria-pressed="false">${text}</button>`;

    this.dom = document.createElement('div');
    this.dom.className = 'find';
    this.dom.setAttribute('role', 'search');
    this.dom.innerHTML = `
      <div class="find-row">
        <label class="find-field">
          ${icon('search', 14)}
          <input name="search" main-field="true" placeholder="Find" aria-label="Find" spellcheck="false">
          <span class="find-count" hidden></span>
        </label>
        ${option('case', 'Aa', 'Match case')}
        ${option('re', '.*', 'Regular expression')}
        ${option('word', '<u>ab</u>', 'Whole word')}
        <span class="find-sep"></span>
        ${tool('prev', 'up', 'Previous match (Shift+Enter)')}
        ${tool('next', 'down', 'Next match (Enter)')}
        <span class="find-spacer"></span>
        ${tool('toggle-replace', 'replace', `Replace (${REPLACE_KEYS})`)}
        ${tool('close', 'close', 'Close (Esc)')}
      </div>
      <div class="find-row" hidden>
        <label class="find-field">
          ${icon('replace', 14)}
          <input name="replace" placeholder="Replace with" aria-label="Replace with" spellcheck="false">
        </label>
        <button class="btn" name="replace">Replace</button>
        <button class="btn" name="replace-all">Replace all</button>
      </div>`;
    const $ = <T extends HTMLElement>(sel: string) => this.dom.querySelector<T>(sel)!;
    this.searchField = $('input[name=search]');
    this.replaceField = $('input[name=replace]');
    this.countEl = $('.find-count');
    this.replaceRow = this.dom.querySelectorAll<HTMLElement>('.find-row')[1];
    this.replaceToggle = $('button[name=toggle-replace]');
    this.fill();

    this.dom.addEventListener('input', () => this.commit());
    this.dom.addEventListener('keydown', (e) => this.onKey(e));
    this.dom.addEventListener('click', (e) => {
      const name = (e.target as HTMLElement).closest('button')?.getAttribute('name');
      if (name) this.onButton(name);
    });
  }

  mount() {
    this.searchField.select();
    this.recount();
  }

  update(u: ViewUpdate) {
    for (const tr of u.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.fill();
        }
      }
    }
    if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) {
      this.recountSoon();
    }
  }

  destroy() {
    if (this.countTimer) clearTimeout(this.countTimer);
  }

  /** Shows or hides the replace row. Focus goes to find until there's something to find. */
  showReplace(on: boolean) {
    this.replaceRow.hidden = !on;
    this.replaceToggle.setAttribute('aria-pressed', String(on));
    (on && this.searchField.value ? this.replaceField : this.searchField).focus();
  }

  private fill() {
    const q = this.query;
    this.searchField.value = q.search;
    this.replaceField.value = q.replace;
    this.setPressed('case', q.caseSensitive);
    this.setPressed('re', q.regexp);
    this.setPressed('word', q.wholeWord);
  }

  private setPressed(name: string, on: boolean) {
    this.dom.querySelector(`button[name=${name}]`)!.setAttribute('aria-pressed', String(on));
  }

  private pressed(name: string): boolean {
    return this.dom.querySelector(`button[name=${name}]`)!.getAttribute('aria-pressed') === 'true';
  }

  private commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.pressed('case'),
      regexp: this.pressed('re'),
      wholeWord: this.pressed('word'),
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  private onButton(name: string) {
    const v = this.view;
    if (name === 'case' || name === 're' || name === 'word') {
      this.setPressed(name, !this.pressed(name));
      this.commit();
      this.searchField.focus();
    } else if (name === 'prev') findPrevious(v);
    else if (name === 'next') findNext(v);
    else if (name === 'toggle-replace') this.showReplace(this.replaceRow.hidden !== false);
    else if (name === 'close') closeSearchPanel(v);
    else if (name === 'replace') replaceNext(v);
    else if (name === 'replace-all') replaceAll(v);
  }

  private onKey(e: KeyboardEvent) {
    // Escape, F3 and the like, bound by searchKeymap to this scope.
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }

  private recountSoon() {
    if (this.countTimer) clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => this.recount(), 120);
  }

  /** "2 of 4" when the selection is a match, "4 matches" when it isn't. */
  private recount() {
    this.countTimer = null;
    const el = this.countEl;
    const q = this.query;
    el.hidden = !q.search;
    el.classList.remove('none');
    if (!q.search) return;
    if (!q.valid) {
      el.textContent = 'Invalid pattern';
      el.classList.add('none');
      return;
    }
    const { from, to } = this.view.state.selection.main;
    const cursor = q.getCursor(this.view.state);
    let count = 0;
    let current = 0;
    for (let m = cursor.next(); !m.done && count <= MAX_COUNT; m = cursor.next()) {
      count++;
      if (m.value.from === from && m.value.to === to) current = count;
    }
    if (!count) {
      el.textContent = 'No results';
      el.classList.add('none');
    } else if (count > MAX_COUNT) {
      el.textContent = `${MAX_COUNT}+ matches`;
    } else if (current) {
      el.textContent = `${current} of ${count}`;
    } else {
      el.textContent = count === 1 ? '1 match' : `${count} matches`;
    }
  }
}
