// One interface over the two shells, so everything else in the editor is
// identical between Tauri and Electron.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { writeHtml } from '@tauri-apps/plugin-clipboard-manager';

export type CaptureMode = 'warm' | 'cold';

export interface ShellInfo {
  shell: 'tauri' | 'electron' | 'browser';
  variant: string;
  autorun: boolean;
  pid: number;
  launchMs: number | null;
  [key: string]: unknown;
}

export interface CaptureTiming {
  label: string;
  mode: CaptureMode;
  /** Renderer's first-frame timestamp minus the shell's request timestamp. */
  ms: number;
  /** Same, but measured when the report arrived back in the shell process. */
  rttMs: number;
}

export interface Bridge {
  label: string;
  info(): Promise<ShellInfo>;
  loadFixture(name: string): Promise<string>;
  saveResult(name: string, data: unknown): Promise<string>;
  memory(): Promise<unknown>;
  copyRich(html: string, text: string): Promise<void>;
  keepAbove(on: boolean): Promise<string>;
  openCapture(mode: CaptureMode, autoHide: boolean): Promise<void>;
  reportFrame(ts: number): Promise<void>;
  captureTimings(): Promise<CaptureTiming[]>;
  onCaptureShown(cb: () => void): void;
  quit(): Promise<void>;
}

interface ElectronApi {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    spikeElectron?: ElectronApi;
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Wall-clock milliseconds with sub-ms precision, comparable across processes. */
export const wallNow = () => performance.timeOrigin + performance.now();

function electronBridge(api: ElectronApi): Bridge {
  const label = new URLSearchParams(location.search).get('label') ?? 'main';
  return {
    label,
    info: () => api.invoke('info'),
    loadFixture: (name) => api.invoke('loadFixture', name),
    saveResult: (name, data) => api.invoke('saveResult', name, data),
    memory: () => api.invoke('memory'),
    copyRich: (html, text) => api.invoke('copyRich', html, text),
    keepAbove: (on) => api.invoke('keepAbove', on),
    openCapture: (mode, autoHide) => api.invoke('openCapture', mode, autoHide),
    reportFrame: (ts) => api.invoke('reportFrame', ts),
    captureTimings: () => api.invoke('captureTimings'),
    onCaptureShown: (cb) => api.on('capture-shown', () => cb()),
    quit: () => api.invoke('quit'),
  };
}

function tauriBridge(): Bridge {
  const label = getCurrentWebviewWindow().label;
  return {
    label,
    info: () => invoke('info'),
    loadFixture: (name) => invoke('load_fixture', { name }),
    saveResult: (name, data) => invoke('save_result', { name, data }),
    memory: () => invoke('memory'),
    copyRich: (html, text) => writeHtml(html, text),
    keepAbove: (on) => invoke('keep_above', { on }),
    openCapture: (mode, autoHide) => invoke('open_capture', { mode, autoHide }),
    reportFrame: (ts) => invoke('report_frame', { ts }),
    captureTimings: () => invoke('capture_timings'),
    onCaptureShown: (cb) => {
      void listen<string>('capture-shown', (e) => {
        if (e.payload === label) cb();
      });
    },
    quit: () => invoke('quit'),
  };
}

/** Dev-only: `vite` serves fixtures/ as public files so the editor can be checked in a browser. */
function browserBridge(): Bridge {
  const unsupported = async () => {
    throw new Error('not available in a plain browser');
  };
  return {
    label: new URLSearchParams(location.search).get('label') ?? 'main',
    info: async () => ({ shell: 'browser', variant: 'browser', autorun: false, pid: 0, launchMs: null }),
    loadFixture: (name) => fetch(`./${name}`).then((r) => r.text()),
    saveResult: async (_name, data) => {
      console.log(data);
      return 'console';
    },
    memory: async () => null,
    copyRich: unsupported,
    keepAbove: unsupported,
    openCapture: unsupported,
    reportFrame: async () => {},
    captureTimings: async () => [],
    onCaptureShown: () => {},
    quit: async () => {},
  };
}

export function createBridge(): Bridge {
  if (window.spikeElectron) return electronBridge(window.spikeElectron);
  if (window.__TAURI_INTERNALS__) return tauriBridge();
  return browserBridge();
}
