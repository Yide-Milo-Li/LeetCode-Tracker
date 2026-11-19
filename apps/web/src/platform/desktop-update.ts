import { useSyncExternalStore } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { isTauri } from './index.ts';

type Phase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing';

interface UpdateState {
  info?: { version: string; enabled: boolean };
  phase: Phase;
  version?: string;
  percent?: number;
  failure?: 'check' | 'download' | 'install';
  dismissedVersion?: string;
}

export const releasePage = 'https://github.com/Yide-Milo-Li/LeetCode-Tracker/releases';

// One session shared by the startup notice and Settings. Downloads survive navigation.
let state: UpdateState = { phase: 'idle' };
let startup: Promise<void> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getState() { return state; }

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

export function useDesktopUpdate() {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function startDesktopUpdates() {
  if (!isTauri()) return;
  startup ??= invoke<NonNullable<UpdateState['info']>>('desktop_update_info')
    .then(async info => {
      setState({ info });
      if (info.enabled) await checkDesktopUpdate();
    })
    .catch(() => setState({ failure: 'check' }));
}

export async function checkDesktopUpdate() {
  if (!state.info?.enabled || !['idle', 'current', 'available'].includes(state.phase)) return;
  const previous = state.phase;
  setState({ phase: 'checking', failure: undefined });
  try {
    const version = await invoke<string | null>('check_desktop_update');
    setState({ phase: version ? 'available' : 'current', version: version ?? undefined });
  } catch {
    setState({ phase: previous, failure: 'check' });
  }
}

export function dismissDesktopUpdate(version: string) {
  setState({ dismissedVersion: version });
}

export async function downloadDesktopUpdate() {
  if (state.phase !== 'available') return;
  setState({ phase: 'downloading', failure: undefined, percent: undefined });
  try {
    const progress = new Channel<number>(percent => {
      if (state.phase === 'downloading') setState({ percent });
    });
    await invoke('download_desktop_update', { progress });
    setState({ phase: 'downloaded' });
  } catch {
    setState({ phase: 'available', failure: 'download' });
  }
}

export async function installDesktopUpdate() {
  if (state.phase !== 'downloaded') return;
  setState({ phase: 'installing', failure: undefined });
  try {
    await invoke('install_desktop_update');
  } catch {
    setState({ phase: 'downloaded', failure: 'install' });
  }
}
