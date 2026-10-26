import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { readBootstrap } from './bootstrap';
import type { Settings } from './types';

interface SettingsCtx {
  settings: Settings;
  /** True once `get_settings` has answered at least once. */
  synced: boolean;
  update: (patch: Partial<Settings>) => Promise<Settings>;
  reset: () => Promise<Settings>;
}

const SettingsContext = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  // Never null: the bootstrap script runs before the first render.
  const [settings, setSettings] = useState<Settings>(readBootstrap);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    let alive = true;

    void invoke<Settings>('get_settings')
      .then((next) => {
        if (alive) setSettings(next);
      })
      .catch((error) => {
        // Keep the bootstrap value — it came from Rust as well, so it is still
        // the source of truth. Do not invent a frontend default here.
        console.error('[Placemill] get_settings failed, keeping bootstrap:', error);
      })
      .finally(() => {
        if (alive) setSynced(true);
      });

    const unlisten = listen<Settings>('settings:changed', (event) => {
      if (alive) setSettings(event.payload);
    });

    return () => {
      alive = false;
      void unlisten.then((un) => un());
    };
  }, []);

  // The command returns the normalized settings, so the panel always renders
  // what Rust actually stored rather than what the user typed.
  //
  // Calls are serialized: every response carries a full snapshot, so two rapid
  // toggles finishing out of order would otherwise let the older one win.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const run = useCallback((command: string, patch?: Partial<Settings>) => {
    const next = queueRef.current.then(() =>
      patch === undefined
        ? invoke<Settings>(command)
        : invoke<Settings>(command, { patch }),
    );
    // Keep the chain alive after a failure so one rejected save does not block
    // every later attempt.
    queueRef.current = next.catch(() => undefined);
    return next.then((value) => {
      setSettings(value);
      return value;
    });
  }, []);

  const update = useCallback(
    (patch: Partial<Settings>) => run('update_settings', patch),
    [run],
  );

  const reset = useCallback(() => run('reset_settings'), [run]);

  const value = useMemo<SettingsCtx>(
    () => ({ settings, synced, update, reset }),
    [settings, synced, update, reset],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>');
  return ctx;
}
