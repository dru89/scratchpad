// What the preload script exposes (app/electron/preload.ts).

export type WindowKind = 'main' | 'capture' | 'draft';

export interface WindowPrefs {
  draftId?: string;
  pinned?: boolean;
  loadedAt?: number;
  float?: boolean;
  sidebar?: boolean;
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
  contextMenu(items: { id: string; label: string }[]): Promise<string | null>;
  copyRich(markdown: string): Promise<void>;
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
  snippet?: string;
}
