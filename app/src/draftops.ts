// What you can do to a draft by id, shared by the Draft menu (for a window's
// own draft) and the sidebar's context menu (for any draft).

import { bridge, type DraftSummary } from './bridge';
import type { Rpc } from './rpc';

export type CopyWhat = 'contents' | 'rich' | 'title' | 'link' | 'id';

/** Opens the draft in the app, in its own window. The daemon's draft_link. */
export const draftLink = (id: string) => `scratchpad://open/${id}`;

export type DraftDetail = DraftSummary & { text: string };

export const getDraft = (rpc: Rpc, id: string) => rpc.call<DraftDetail>('drafts.get', { id });

/**
 * Copies part of a draft and returns what the toast should say. `open` is
 * the window's own copy of the draft, which can be a keystroke ahead of the
 * daemon's.
 */
export async function copyDraft(rpc: Rpc, id: string, what: CopyWhat, open?: { text: string; title: string }): Promise<string> {
  if (what === 'link') {
    await bridge().copyText(draftLink(id));
    return 'Copied link';
  }
  if (what === 'id') {
    await bridge().copyText(id);
    return 'Copied ID';
  }
  const d = open ?? (await getDraft(rpc, id));
  if (what === 'title') {
    await bridge().copyText(d.title);
    return 'Copied title';
  }
  if (what === 'rich') {
    await bridge().copyRich(d.text);
    return 'Copied as rich text';
  }
  await bridge().copyText(d.text);
  return 'Copied contents';
}

/** Makes a new Inbox draft with the same text and returns its id. */
export async function duplicateDraft(rpc: Rpc, text: string): Promise<string> {
  const copy = await rpc.call<DraftSummary>('drafts.create', { text });
  return copy.id;
}

/** The Copy submenu, for context menus. */
export const COPY_ITEMS = [
  { id: 'copy:contents', label: 'Contents' },
  { id: 'copy:rich', label: 'Rich Text' },
  { id: 'copy:title', label: 'Title' },
  { id: 'copy:link', label: 'Link' },
  { id: 'copy:id', label: 'ID' },
];
