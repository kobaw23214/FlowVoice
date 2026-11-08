export type InputMode = 'dictate' | 'polish' | 'compose';
export type SessionPhase = 'idle' | 'recording' | 'transcribing' | 'generating' | 'done' | 'error' | 'cancelled';
export interface AppSettings {
  shortcut: string;
  mode: InputMode;
  autoInsert: boolean;
  asr: { provider: 'local' | 'cloud'; modelDir: string; baseUrl: string; model: string };
  llm: { provider: 'disabled' | 'local' | 'cloud'; baseUrl: string; model: string };
}
export interface SessionSnapshot {
  id: number; revision: number; phase: SessionPhase; transcript: string; partialTranscript: string; output: string;
  error: string | null; notice: string | null; level: number; elapsedMs: number;
}
export interface AppSnapshot {
  settings: AppSettings; session: SessionSnapshot;
  asrKeyConfigured: boolean; llmKeyConfigured: boolean;
  modelReady: boolean; platform: string; accessibilityGranted: boolean;
}
export interface ModelProgress { downloaded: number; total: number; status: string; }
