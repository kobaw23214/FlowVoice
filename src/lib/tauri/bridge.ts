import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { AppSnapshot, ModelProgress, SessionSnapshot } from '../../types';

export const desktop = isTauri();
export async function command<T = void>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop) throw new Error('请在 FlowVoice 桌面应用中使用此功能。浏览器仅用于界面预览。');
  return invoke<T>(name, args);
}
export async function runAction(name: string, action: () => Promise<unknown>): Promise<boolean> {
  const store = useAppStore.getState();
  if (!store.begin(name)) return false;
  try { await action(); return true; }
  catch (error) { store.setError(error instanceof Error ? error.message : String(error)); return false; }
  finally { store.end(name); }
}
export function useBackend() {
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const unsubscribers: UnlistenFn[] = [];
    const register = async <T,>(event: string, callback: (payload: T) => void) => {
      const unlisten = await listen<T>(event, ({ payload }) => { if (!disposed) callback(payload); });
      if (disposed) unlisten(); else unsubscribers.push(unlisten);
    };
    const connect = async () => {
      const store = useAppStore.getState();
      try {
        await Promise.all([
          register<SessionSnapshot>('flowvoice://session', store.setSession),
          register<ModelProgress>('flowvoice://model-progress', store.setProgress),
          register<AppSnapshot>('flowvoice://settings', store.setSnapshot),
        ]);
        if (disposed) return;
        const snapshot = await command<AppSnapshot>('get_snapshot');
        if (!disposed) store.setSnapshot(snapshot);
      } catch (error) { if (!disposed) store.setError(`连接桌面服务失败：${String(error)}`); }
    };
    void connect();
    return () => { disposed = true; unsubscribers.forEach((unlisten) => unlisten()); };
  }, []);
}
