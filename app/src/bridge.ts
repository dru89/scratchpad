// What the preload script exposes (app/electron/preload.ts).

export type WindowKind = 'main' | 'capture' | 'draft';

export interface WindowPrefs {
  draftId?: string;
  pinned?: boolean;
  loadedAt?: number;
  float?: boolean;
  sidebar?: boolean;
  sidebarWidth?: number;
}

export interface WindowInfo {
  kind: WindowKind;
  prefs: WindowPrefs;
  idleMs: number;
  platform: string;
}

export interface Summon {
  mode?: 'summon' | 'new' | 'load' | string;
  draftId?: string;
}

/** A context menu item: `id` "-" is a separator, and an item with a submenu has no action of its own. */
export interface MenuItem {
  id: string;
  label: string;
  submenu?: MenuItem[];
}

export interface Bridge {
  daemon: {
    send(line: string): void;
    onLine(cb: (line: string) => void): void;
    onStatus(cb: (s: { connected: boolean }) => void): void;
  };
  info(): Promise<WindowInfo>;
  savePrefs(patch: WindowPrefs): Promise<void>;
  setTitle(title: string): void;
  setFloat(on: boolean): Promise<boolean>;
  hide(): void;
  close(): void;
  onSummon(cb: (p: Summon) => void): void;
  openDraft(id: string): Promise<void>;
  openInCapture(id: string): Promise<void>;
  showMain(): Promise<void>;
  contextMenu(items: MenuItem[]): Promise<string | null>;
  /** Actions from the Draft menu, for this window's draft. */
  onMenuAction(cb: (action: string) => void): void;
  copyRich(markdown: string): Promise<void>;
  copyText(text: string): Promise<void>;
  /** Asks, then empties the Trash. */
  emptyTrash(): Promise<void>;
  /** Asks where, then saves the draft as a .md file; the path, or null if cancelled. */
  exportDraft(id: string): Promise<string | null>;
  quit(): Promise<void>;
}

declare global {
  interface Window {
    scratchpad: Bridge;
  }
}

export const bridge = (): Bridge => window.scratchpad;

export type DraftState = 'inbox' | 'archived' | 'trashed';

export interface DraftSummary {
  id: string;
  title: string;
  state: DraftState;
  createdAt: number;
  modifiedAt: number;
  trashedAt?: number;
  /** The text after the title, stripped of markdown. */
  preview?: string;
  snippet?: string;
}
