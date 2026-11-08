import { create } from 'zustand';
import type { AppSnapshot, Language, ModelProgress, SessionSnapshot } from '../types';

export const previewSnapshot: AppSnapshot = {
  settings: {
    shortcut: 'Alt+Shift+Space', mode: 'dictate', autoInsert: true, language: 'zh-CN',
    asr: { provider: 'local', modelDir: '', baseUrl: '', model: '' },
    llm: { provider: 'disabled', baseUrl: 'http://127.0.0.1:8080/v1', model: '' },
  },
  session: { id: 0, revision: 0, phase: 'idle', transcript: '', partialTranscript: '', output: '', error: null, notice: null, level: 0, elapsedMs: 0 },
  asrKeyConfigured: false, llmKeyConfigured: false, modelReady: false, platform: 'preview', accessibilityGranted: false,
};

export interface DictationEntry {
  id: number;
  text: string;
  /** 原始转写，仅在与最终文字不同时保留，供对照。 */
  rawTranscript: string;
  durationMs: number;
  createdAt: number;
  /** The same entry receives the current utterance until this session finishes. */
  partialText?: string;
  live?: boolean;
  revision?: number;
}

interface AppStore {
  snapshot: AppSnapshot; connected: boolean; error: string | null; pending: string[]; progress: ModelProgress | null;
  entries: DictationEntry[];
  /** 点击某条记录的润色/写作后，结果应写回该条而不是新增记录。 */
  polishTargetId: number | null;
  setSnapshot: (snapshot: AppSnapshot) => void;
  setSession: (session: SessionSnapshot) => void;
  setProgress: (progress: ModelProgress) => void;
  setError: (error: string | null) => void;
  begin: (action: string) => boolean;
  end: (action: string) => void;
  updateEntryText: (id: number, text: string) => void;
  removeEntry: (id: number) => void;
  addManualEntry: () => void;
  setPolishTarget: (id: number | null) => void;
  setLanguage: (language: Language) => void;
}

const phaseOrder: Record<SessionSnapshot['phase'], number> = {
  idle: 0, recording: 1, transcribing: 2, generating: 3,
  done: 4, error: 4, cancelled: 4,
};

/** Late progress events must never replace a newer task or reopen a finished one. */
export function newestSession(current: SessionSnapshot, incoming: SessionSnapshot): SessionSnapshot {
  if (incoming.id < current.id) return current;
  if (incoming.id > current.id) return incoming;
  if (current.revision > 0 && incoming.revision > 0) {
    if (incoming.revision < current.revision) return current;
    if (incoming.revision > current.revision) return incoming;
  }
  if (phaseOrder[incoming.phase] < phaseOrder[current.phase]) return current;
  if (phaseOrder[current.phase] === 4 && incoming.phase !== current.phase) return current;
  if (incoming.phase === 'recording' && incoming.elapsedMs < current.elapsedMs) return current;
  return incoming;
}

/**
 * 把一次完成的会话落成听写记录：
 * - 录音中 → 同一词条显示已确认语句和可修正的当前半句；
 * - 录音完成 → 更新同一词条，不新增第二条；
 * - 界面上发起的润色/写作（elapsedMs = 0）→ 写回 polishTargetId 指向的记录；
 * - 取消 → 移除未完成的实时词条；失败 → 保留已确认文字。
 */
export function applySessionToEntries(
  entries: DictationEntry[], polishTargetId: number | null, session: SessionSnapshot,
): DictationEntry[] {
  if (['recording', 'transcribing'].includes(session.phase)) {
    if (!session.transcript && !session.partialTranscript) return entries;
    const index = entries.findIndex((entry) => entry.id === session.id);
    if (index >= 0 && !entries[index].live) return entries;
    if (index >= 0 && entries[index].revision && session.revision < entries[index].revision!) return entries;
    const entry: DictationEntry = {
      id: session.id,
      text: session.transcript,
      rawTranscript: '',
      durationMs: session.elapsedMs,
      createdAt: index >= 0 ? entries[index].createdAt : Date.now(),
      partialText: session.partialTranscript,
      live: true,
      revision: session.revision,
    };
    if (index >= 0) {
      const copy = [...entries];
      copy[index] = { ...copy[index], ...entry };
      return copy;
    }
    return [entry, ...entries];
  }
  if (session.phase === 'cancelled') {
    // Rust advances the ID to invalidate late work when cancelling.
    return entries.filter((entry) => !(entry.id + 1 === session.id && entry.live));
  }
  if (session.phase === 'error') {
    return entries.map((entry) => entry.id === session.id && entry.live
      ? { ...entry, partialText: undefined, live: false, revision: session.revision }
      : entry);
  }
  if (session.phase === 'done') {
    const text = session.output || session.transcript;
    if (text.trim() && session.elapsedMs === 0 && polishTargetId !== null) {
      return entries.map((entry) =>
        entry.id === polishTargetId ? { ...entry, text: session.output || entry.text } : entry,
      );
    }
    if (text.trim() && session.elapsedMs > 0) {
      const index = entries.findIndex((entry) => entry.id === session.id);
      const entry: DictationEntry = {
        id: session.id,
        text,
        rawTranscript: session.transcript && session.transcript !== text ? session.transcript : '',
        durationMs: session.elapsedMs,
        createdAt: index >= 0 ? entries[index].createdAt : Date.now(),
        partialText: undefined,
        live: false,
        revision: session.revision,
      };
      if (index >= 0) {
        const copy = [...entries];
        copy[index] = entry;
        return copy;
      }
      return [entry, ...entries];
    }
  }
  return entries;
}

const settleSession = (state: {
  snapshot: AppSnapshot; entries: DictationEntry[]; polishTargetId: number | null;
}, session: SessionSnapshot) => {
  const settled = phaseOrder[session.phase] === 4;
  return {
    snapshot: { ...state.snapshot, session },
    entries: applySessionToEntries(state.entries, state.polishTargetId, session),
    polishTargetId: settled ? null : state.polishTargetId,
  };
};

export const useAppStore = create<AppStore>((set, get) => ({
  snapshot: previewSnapshot, connected: false, error: null, pending: [], progress: null,
  entries: [], polishTargetId: null,
  setSnapshot: (snapshot) => set((state) => {
    const session = newestSession(state.snapshot.session, snapshot.session);
    return { ...settleSession(state, session), snapshot: { ...snapshot, session }, connected: true };
  }),
  setSession: (incoming) => set((state) => settleSession(state, newestSession(state.snapshot.session, incoming))),
  setProgress: (progress) => set({ progress }),
  setError: (error) => set({ error }),
  begin: (action) => {
    if (get().pending.includes(action)) return false;
    set((state) => ({ pending: [...state.pending, action], error: null }));
    return true;
  },
  end: (action) => set((state) => ({ pending: state.pending.filter((entry) => entry !== action) })),
  updateEntryText: (id, text) => set((state) => ({
    entries: state.entries.map((entry) => (entry.id === id ? { ...entry, text } : entry)),
  })),
  removeEntry: (id) => set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),
  addManualEntry: () => set((state) => ({
    entries: [{ id: Date.now(), text: '', rawTranscript: '', durationMs: 0, createdAt: Date.now() }, ...state.entries],
  })),
  setPolishTarget: (polishTargetId) => set({ polishTargetId }),
  setLanguage: (language) => set((state) => state.snapshot.settings.language === language ? state : ({
    snapshot: { ...state.snapshot, settings: { ...state.snapshot.settings, language } },
  })),
}));
