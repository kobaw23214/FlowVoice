import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowRight, AudioLines, Check, ChevronRight, Cloud, Copy,
  Download, FileText, FolderOpen, Keyboard, LayoutDashboard, LoaderCircle,
  Languages, Mic, Monitor, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Square, Trash2, X,
} from 'lucide-react';
import { command, desktop, runAction, useBackend } from './lib/tauri/bridge';
import { browserPlatform, defaultShortcut, normalizeShortcut, shortcutLabel, shortcutRecording, type DesktopPlatform } from './lib/platform';
import { useAppStore, type DictationEntry } from './stores/appStore';
import type { AppSettings, AppSnapshot, InputMode, Language, SessionPhase } from './types';
import { durationLabel, languageOptions, phaseLabel, useI18n, type Translations } from './lib/i18n';
import './App.css';

type Page = 'workspace' | 'models' | 'settings';
const modes: { id: InputMode; icon: typeof Mic }[] = [
  { id: 'dictate', icon: Mic },
  { id: 'polish', icon: Sparkles },
  { id: 'compose', icon: FileText },
];
const isBusy = (phase: SessionPhase) => ['recording', 'transcribing', 'generating'].includes(phase);
const formatTime = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
function ShortcutRecorder({ value, platform, t, onChange }: { value: string; platform: DesktopPlatform; t: Translations; onChange: (next: string) => void }) {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { setRecording(false); return; }
      const next = shortcutRecording(event);
      if (!next) return;
      onChange(next);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);
  return <button type="button" className={`shortcut-recorder ${recording ? 'recording' : ''}`} onClick={() => setRecording(!recording)} aria-pressed={recording} aria-label={recording ? t.recordingShortcut : `${t.shortcutButton}：${shortcutLabel(value, platform, t.space)}`}>
    <Keyboard size={15} />
    <span>{recording ? t.pressShortcut : shortcutLabel(value, platform, t.space)}</span>
  </button>;
}

function Brand() {
  return <div className="brand"><div className="brand-symbol"><AudioLines size={23} strokeWidth={2.5} /></div><span>FlowVoice<span className="brand-dot">.</span></span></div>;
}
function Badge({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span className={`badge ${muted ? 'badge-muted' : ''}`}><span className="status-dot" />{children}</span>;
}
function AppHeader({ page }: { page: Page }) {
  const t = useI18n();
  const details = {
    workspace: { eyebrow: t.workspaceEyebrow, title: t.workspaceTitle, description: t.workspaceDescription },
    models: { eyebrow: t.modelsEyebrow, title: t.modelsTitle, description: t.modelsDescription },
    settings: { eyebrow: t.settingsEyebrow, title: t.settingsTitle, description: t.settingsDescription },
  }[page];
  return <header className="page-heading"><div><span className="eyebrow">{details.eyebrow}</span><h1>{details.title}<span className="heading-dot">{t.headingPunctuation}</span></h1><p>{details.description}</p></div><div className="page-heading-mark">{page === 'workspace' ? <AudioLines size={25} /> : page === 'models' ? <SlidersHorizontal size={24} /> : <Settings2 size={24} />}</div></header>;
}
function Field({ label, hint, grouped = false, children }: { label: string; hint?: string; grouped?: boolean; children: ReactNode }) {
  return grouped
    ? <div className="field" role="group" aria-label={label}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</div>
    : <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Waveform({ active, level = 0 }: { active: boolean; level?: number }) {
  return <div className={`waveform ${active ? 'waveform-active' : ''}`} aria-hidden="true">{Array.from({ length: 31 }, (_, i) => <span key={i} style={{ height: `${active ? 6 + Math.min(1, level * 4) * (10 + (1 - Math.abs(i - 15) / 16) * 38) : 4}px`, animationDelay: `${(i % 7) * -0.12}s` }} />)}</div>;
}
function Workspace({ navigate }: { navigate: (page: Page) => void }) {
  const { snapshot, pending, entries } = useAppStore();
  const { settings, session } = snapshot;
  const t = useI18n();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  useEffect(() => { if (copiedId === null) return; const timer = window.setTimeout(() => setCopiedId(null), 1800); return () => window.clearTimeout(timer); }, [copiedId]);
  const busy = isBusy(session.phase);
  const recording = session.phase === 'recording';
  const platform = (desktop ? snapshot.platform : browserPlatform()) as DesktopPlatform;
  const ready = settings.asr.provider === 'cloud' || snapshot.modelReady;
  const changeMode = (mode: InputMode) => void runAction('mode', async () => useAppStore.getState().setSnapshot(await command<AppSnapshot>('save_settings', { settings: { ...settings, mode } })));
  const record = () => void runAction('record', () => command(recording ? 'stop_recording' : 'start_recording'));
  const stats = useMemo(() => {
    const totalMs = entries.reduce((sum, entry) => sum + entry.durationMs, 0);
    const totalChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    const minutes = totalMs / 60000;
    return { totalMs, totalChars, speed: minutes > 0 ? Math.round(totalChars / minutes) : null };
  }, [entries]);
  const copyEntry = async (entry: DictationEntry) => {
    const ok = await runAction('copy', async () => desktop ? command('copy_text', { text: entry.text }) : navigator.clipboard.writeText(entry.text));
    if (ok) setCopiedId(entry.id);
  };
  const runEntryGenerate = (entry: DictationEntry, mode: 'polish' | 'compose') => {
    useAppStore.getState().setPolishTarget(entry.id);
    void runAction('generate', () => command('generate_text', { text: entry.text, mode }))
      .then((ok) => { if (!ok) useAppStore.getState().setPolishTarget(null); });
  };
  return <>
        <section className="mode-selector" aria-label={t.inputModes}>{modes.map(({ id, icon: Icon }) => <button key={id} className={`mode-option ${settings.mode === id ? 'selected' : ''}`} onClick={() => changeMode(id)} disabled={!desktop || busy || pending.includes('mode')} aria-pressed={settings.mode === id}><span className="mode-icon"><Icon size={20} /></span><span><strong>{t[id]}</strong><small>{t[`${id}Hint`]}</small></span>{settings.mode === id && <span className="mode-check"><Check size={11} /></span>}</button>)}</section>
    <section className={`record-card ${recording ? 'is-recording' : ''}`}>
      <div className="record-topline"><span className="mini-label"><span className={`status-dot ${recording ? 'recording-dot' : ''}`} />{recording ? t.microphoneActive : t.voiceWorkspace}</span><span className="timer">{formatTime(session.elapsedMs)}</span></div>
      <div className="record-content"><button className={`record-button ${recording ? 'record-button-active' : ''}`} aria-label={recording ? t.stopRecording : t.startRecording} onClick={record} disabled={!desktop || !ready || (busy && !recording) || pending.includes('record')}>
        {pending.includes('record') || (busy && !recording) ? <LoaderCircle className="spin" size={31} /> : recording ? <Square size={25} fill="currentColor" /> : <Mic size={33} strokeWidth={1.7} />}
      </button><h2>{phaseLabel(t, session.phase)}</h2><p>{recording ? t.releaseToStop : !ready ? t.prepareModel : settings.mode === 'compose' ? t.composePrompt : t.startPrompt}</p><Waveform active={recording} level={session.level} />
      {busy ? <button className="text-button cancel-link" onClick={() => void runAction('cancel', () => command('cancel_session'))} disabled={pending.includes('cancel')}><X size={13} />{t.cancelTask}</button> : <div className="shortcut-hint"><kbd>{shortcutLabel(desktop ? settings.shortcut : defaultShortcut(platform), platform, t.space)}</kbd><span>{t.holdToTalk}</span></div>}</div>
      <div className="record-footer"><span>{settings.asr.provider === 'local' ? <Monitor size={14} /> : <Cloud size={14} />}{settings.asr.provider === 'local' ? `SenseVoice · ${t.local}` : `${settings.asr.model || t.speechRecognition} · ${t.cloud}`}<span className="footer-dot">·</span>{settings.asr.provider === 'local' ? t.audioStaysLocal : t.audioSentToProvider}</span><button className="text-button" onClick={() => navigate('models')}>{t.modelSettings} <ChevronRight size={14} /></button></div>
    </section>
    {(session.error || session.notice) && <div className={`notice ${session.error ? 'notice-error' : ''}`} role={session.error ? 'alert' : 'status'}>{session.error || session.notice}</div>}
    {settings.mode !== 'dictate' && settings.llm.provider !== 'disabled' && <div className="model-flow-note"><Sparkles size={13} /><span>{settings.llm.model || t.languageModel} · {settings.llm.provider === 'local' ? t.localWritingService : t.cloudWritingService}</span></div>}
    {settings.mode !== 'dictate' && settings.llm.provider === 'disabled' && <div className="notice">{t.llmRequired}<button className="inline-link" onClick={() => navigate('models')}>{t.configure}</button>{t.orDictate}</div>}
    <section className="result-card"><div className="section-heading"><h2><FileText size={17} />{t.textResult}</h2><div className="result-actions"><button className="quiet-button" onClick={() => useAppStore.getState().addManualEntry()}>{t.manualInput}</button></div></div>
      <div className="stats-row" aria-label={t.dictationStats}>
        <div className="stat-item"><span className="stat-value">{stats.totalMs ? durationLabel(t, stats.totalMs, settings.language) : '—'}</span><span className="stat-label">{t.totalDuration}</span></div>
        <div className="stat-item"><span className="stat-value">{stats.totalChars ? `${stats.totalChars.toLocaleString(settings.language)} ${t.chars}` : '—'}</span><span className="stat-label">{t.inputAmount}</span></div>
        <div className="stat-item"><span className="stat-value">{stats.speed ? `${stats.speed} ${t.charsPerMinute}` : '—'}</span><span className="stat-label">{t.averageSpeed}</span></div>
      </div>
      <div className="entry-list">
        {entries.length === 0 && <div className="entry-empty">{t.emptyEntries}<br />{t.audioNotStored}</div>}
        {entries.map((entry) => <div className="dictation-entry" key={entry.id}>
          <div className="entry-meta">
            <span className="entry-time">{new Date(entry.createdAt).toLocaleTimeString(settings.language, { hour: '2-digit', minute: '2-digit' })}</span>
            {entry.durationMs > 0 && <span>{t.dictationFor} {durationLabel(t, entry.durationMs, settings.language)}</span>}
            {entry.live && <span className="entry-live"><span className="status-dot" />{t.recognizing}</span>}
            <span>{entry.text.length + (entry.partialText?.length || 0)} {t.chars}</span>
            <div className="entry-actions">
              <button className="quiet-button" disabled={entry.live || !entry.text || pending.includes('copy')} onClick={() => void copyEntry(entry)}>{copiedId === entry.id ? <Check size={14} /> : <Copy size={14} />}{copiedId === entry.id ? t.copied : t.copy}</button>
              <button className="quiet-button" disabled={!desktop || !entry.text.trim() || busy || settings.llm.provider === 'disabled' || pending.includes('generate')} onClick={() => runEntryGenerate(entry, 'polish')}><Sparkles size={14} />{t.polishAction}</button>
              <button className="quiet-button" disabled={!desktop || !entry.text.trim() || busy || settings.llm.provider === 'disabled' || pending.includes('generate')} onClick={() => runEntryGenerate(entry, 'compose')}><ArrowRight size={14} />{t.composeAction}</button>
              <button className="quiet-button entry-delete" aria-label={t.deleteEntry} disabled={busy} onClick={() => useAppStore.getState().removeEntry(entry.id)}><Trash2 size={14} /></button>
            </div>
          </div>
          {entry.live ? <div className="entry-editor entry-live-text" aria-live="polite" aria-label={t.liveTranscript}>{entry.text}<span>{entry.partialText || t.listeningNext}</span></div> : <textarea className="entry-editor" aria-label={t.editableTranscript} value={entry.text} onChange={(event) => useAppStore.getState().updateEntryText(entry.id, event.target.value)} placeholder={t.transcriptPlaceholder} spellCheck={false} />}
          {entry.rawTranscript && <details className="transcript"><summary>{t.viewRawTranscript}</summary><p>{entry.rawTranscript}</p></details>}
        </div>)}
      </div>
    </section>
    <div className="getting-started"><div className="help-icon"><Keyboard size={20} /></div><div><strong>{t.quickStartTitle}</strong><p>{t.quickStartDescription}</p></div><button aria-label={t.inputPreferences} onClick={() => navigate('settings')}><ArrowRight size={19} /></button></div>
  </>;
}
function Models() {
  const { snapshot, pending, progress } = useAppStore();
  const t = useI18n();
  const [draft, setDraft] = useState<AppSettings>(snapshot.settings);
  const [asrKey, setAsrKey] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(snapshot.settings); }, [snapshot.settings]);
  const updateAsr = (patch: Partial<AppSettings['asr']>) => { if ('provider' in patch || 'baseUrl' in patch) setAsrKey(''); setSaved(false); setDraft((value) => ({ ...value, asr: { ...value.asr, ...patch } })); };
  const updateLlm = (patch: Partial<AppSettings['llm']>) => { if ('provider' in patch || 'baseUrl' in patch) setLlmKey(''); setSaved(false); setDraft((value) => ({ ...value, llm: { ...value.llm, ...patch } })); };
  const chooseDir = () => void runAction('directory', async () => {
    const path = await open({ directory: true, multiple: false, title: t.chooseModelDirectory });
    if (typeof path === 'string') updateAsr({ modelDir: path });
  });
  const save = () => void runAction('settings', async () => {
    const store = useAppStore.getState();
    store.setSnapshot(await command<AppSnapshot>('save_settings', { settings: draft }));
    if (asrKey.trim()) { store.setSnapshot(await command<AppSnapshot>('save_api_key', { kind: 'asr', key: asrKey.trim() })); setAsrKey(''); }
    if (llmKey.trim()) { store.setSnapshot(await command<AppSnapshot>('save_api_key', { kind: 'llm', key: llmKey.trim() })); setLlmKey(''); }
    setSaved(true);
  });
  const asrEndpointSaved = draft.asr.provider === snapshot.settings.asr.provider && draft.asr.baseUrl === snapshot.settings.asr.baseUrl;
  const llmEndpointSaved = draft.llm.provider === snapshot.settings.llm.provider && draft.llm.baseUrl === snapshot.settings.llm.baseUrl;
  const downloading = pending.includes('download');
  const percentage = progress?.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : 0;
  const busy = isBusy(snapshot.session.phase);
  return <>    <section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><AudioLines size={20} /></span><div><h2>{t.asrTitle}</h2><p>{t.asrDescription}</p></div><span className="step-number">01</span></div><div className="settings-body"><div className="segmented"><button className={draft.asr.provider === 'local' ? 'active' : ''} onClick={() => updateAsr({ provider: 'local' })}><Monitor size={15} />{t.localModel}</button><button className={draft.asr.provider === 'cloud' ? 'active' : ''} onClick={() => updateAsr({ provider: 'cloud' })}><Cloud size={15} />{t.cloudService}</button></div>
      {draft.asr.provider === 'local' ? <><div className="local-model"><div className="model-art"><AudioLines size={28} /></div><div><strong>SenseVoice Small <span className="model-chip">INT8</span></strong><p>{t.localModelDescription}</p></div><Badge muted={!snapshot.modelReady}>{snapshot.modelReady ? t.ready : t.notReady}</Badge></div><Field label={t.modelDirectory} hint={t.modelDirectoryHint}><div className="input-with-button"><input value={draft.asr.modelDir} onChange={(e) => updateAsr({ modelDir: e.target.value })} placeholder={t.modelDirectoryPlaceholder} /><button aria-label={t.chooseModelDirectoryShort} disabled={!desktop || pending.includes('directory')} onClick={chooseDir}><FolderOpen size={18} /></button></div></Field><div className="download-row"><button className="secondary-button" disabled={!desktop || downloading || busy} onClick={() => void runAction('download', () => command('download_model'))}>{downloading ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{downloading ? t.downloadingModel : t.downloadModel}</button><span>{t.downloadOnlyOnline}</span></div>{progress && <div className="download-progress"><div><span>{progress.status}</span><span>{progress.total ? `${percentage}%` : `${(progress.downloaded / 1024 / 1024).toFixed(1)} MB`}</span></div><progress value={progress.downloaded} max={progress.total || Math.max(progress.downloaded, 1)} /></div>}</> : <><div className="data-note"><Cloud size={16} /><p>{t.cloudAsrNotice}</p></div><Field label="API Base URL" hint={t.baseUrlHint}><input value={draft.asr.baseUrl} onChange={(e) => updateAsr({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" /></Field><Field label={t.modelId}><input value={draft.asr.model} onChange={(e) => updateAsr({ model: e.target.value })} placeholder={t.modelIdPlaceholder} autoComplete="off" /></Field><Field label={`API Key${!asrEndpointSaved ? ` · ${t.pendingProviderSave}` : snapshot.asrKeyConfigured ? ` · ${t.configured}` : ''}`} hint={t.apiKeyHint}><input type="password" value={asrKey} onChange={(e) => { setAsrKey(e.target.value); setSaved(false); }} placeholder={asrEndpointSaved && snapshot.asrKeyConfigured ? t.replaceApiKey : t.enterApiKey} autoComplete="new-password" /></Field></>}
    </div></section>
    <section className="settings-card"><div className="settings-card-header"><span className="setting-icon violet"><Sparkles size={20} /></span><div><h2>{t.llmTitle}</h2><p>{t.llmDescription}</p></div><span className="step-number">02</span></div><div className="settings-body"><div className="segmented segmented-three">{([{ id: 'disabled', label: t.disabled, icon: Square }, { id: 'local', label: t.localService, icon: Monitor }, { id: 'cloud', label: t.cloudService, icon: Cloud }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={draft.llm.provider === id ? 'active' : ''} onClick={() => updateLlm({ provider: id, ...(id === 'local' && !draft.llm.baseUrl.startsWith('http://127.') && !draft.llm.baseUrl.startsWith('http://localhost') ? { baseUrl: 'http://127.0.0.1:8080/v1' } : {}) })}><Icon size={14} />{label}</button>)}</div>
      {draft.llm.provider === 'disabled' ? <div className="disabled-model"><Sparkles size={25} strokeWidth={1.4} /><strong>{t.llmDisabledTitle}</strong><p>{t.llmDisabledDescription}</p></div> : <><div className="data-note">{draft.llm.provider === 'local' ? <Monitor size={16} /> : <Cloud size={16} />}<p>{draft.llm.provider === 'local' ? t.localLlmNotice : t.cloudLlmNotice}</p></div><Field label="API Base URL" hint={draft.llm.provider === 'local' ? t.localUrlHint : t.cloudUrlHint}><input value={draft.llm.baseUrl} onChange={(e) => updateLlm({ baseUrl: e.target.value })} placeholder={draft.llm.provider === 'local' ? 'http://127.0.0.1:8080/v1' : 'https://api.example.com/v1'} autoComplete="off" /></Field><Field label={t.modelId}><input value={draft.llm.model} onChange={(e) => updateLlm({ model: e.target.value })} placeholder={draft.llm.provider === 'local' ? t.localModelIdPlaceholder : t.cloudModelIdPlaceholder} autoComplete="off" /></Field><Field label={`API Key${!llmEndpointSaved ? ` · ${t.pendingProviderSave}` : snapshot.llmKeyConfigured ? ` · ${t.configured}` : ''}`} hint={t.llmApiKeyHint}><input type="password" value={llmKey} onChange={(e) => { setLlmKey(e.target.value); setSaved(false); }} placeholder={t.apiKeyPlaceholder} autoComplete="new-password" /></Field></>}
    </div></section><div className="save-bar"><span>{busy ? t.saveWhenIdle : saved ? t.modelSettingsSaved : t.settingsApplyNotice}</span><button className="primary-button" disabled={!desktop || pending.includes('settings') || busy} onClick={save}>{pending.includes('settings') ? <LoaderCircle className="spin" size={15} /> : saved ? <Check size={15} /> : null}{saved ? t.saved : t.saveModelSettings}</button></div></>;
}
function Preferences() {
  const { snapshot, pending } = useAppStore();
  const t = useI18n();
  const platform = (desktop ? snapshot.platform : browserPlatform()) as DesktopPlatform;
  const [shortcut, setShortcut] = useState(desktop ? snapshot.settings.shortcut : defaultShortcut(platform));
  const [autoInsert, setAutoInsert] = useState(snapshot.settings.autoInsert);
  const [language, setLanguage] = useState<Language>(snapshot.settings.language);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setShortcut(desktop ? snapshot.settings.shortcut : defaultShortcut(platform)); setAutoInsert(snapshot.settings.autoInsert); setLanguage(snapshot.settings.language); }, [snapshot.settings]);
  useEffect(() => { if (!desktop) useAppStore.getState().setLanguage(language); }, [language]);
  const changeLanguage = (next: Language) => {
    if (next === language || pending.includes('language')) return;
    setLanguage(next);
    setSaved(false);
    if (!desktop) return;
    void runAction('language', async () => {
      const settings = useAppStore.getState().snapshot.settings;
      useAppStore.getState().setSnapshot(await command<AppSnapshot>('save_settings', { settings: { ...settings, language: next } }));
    });
  };
  const save = () => void runAction('settings', async () => { useAppStore.getState().setSnapshot(await command<AppSnapshot>('save_settings', { settings: { ...snapshot.settings, shortcut: normalizeShortcut(shortcut, platform), autoInsert, language } })); setSaved(true); });
  return <><section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><Languages size={21} /></span><div><h2>{t.appearanceLanguage}</h2><p>{t.appearanceLanguageDescription}</p></div></div><div className="settings-body"><Field label={t.interfaceLanguage} hint={t.languageHint} grouped><div className="segmented language-selector">{languageOptions.map((option) => <button key={option.value} className={language === option.value ? 'active' : ''} aria-pressed={language === option.value} disabled={pending.includes('language') || isBusy(snapshot.session.phase)} onClick={() => changeLanguage(option.value)}>{option.label}</button>)}</div></Field></div></section>
    <section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><Keyboard size={21} /></span><div><h2>{t.recordingInput}</h2><p>{t.recordingInputDescription}</p></div></div><div className="settings-body"><Field label={t.globalShortcut} hint={platform === 'macos' ? t.shortcutHintMac : t.shortcutHintWindows} grouped><ShortcutRecorder value={shortcut} platform={platform} t={t} onChange={(next) => { setShortcut(next); setSaved(false); }} /></Field><div className="setting-row"><div><strong>{t.autoInsert}</strong><p>{t.autoInsertDescription}</p></div><button type="button" role="switch" aria-label={t.autoInsert} aria-checked={autoInsert} className={`toggle ${autoInsert ? 'on' : ''}`} onClick={() => { setAutoInsert(!autoInsert); setSaved(false); }}><span /></button></div><div className="data-note"><ShieldCheck size={16} /><p>{t.inputSafetyNotice}</p></div></div></section>
    {platform === 'macos' && <section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><ShieldCheck size={20} /></span><div><h2>{t.systemPermissions}</h2><p>{t.accessibilityDescription}</p></div><Badge muted={!snapshot.accessibilityGranted}>{snapshot.accessibilityGranted ? t.granted : t.notGranted}</Badge></div><div className="settings-body permission-row"><p>{t.permissionsDescription}</p><button className="secondary-button" disabled={!desktop || pending.includes('permission')} onClick={() => void runAction('permission', async () => { await command('request_accessibility'); useAppStore.getState().setSnapshot(await command<AppSnapshot>('get_snapshot')); })}>{t.requestPermission}<ArrowRight size={14} /></button></div></section>}
    <div className="save-bar"><span>{saved ? t.preferencesSaved : t.shortcutConflictHint}</span><button className="primary-button" disabled={!desktop || pending.includes('settings') || pending.includes('language') || isBusy(snapshot.session.phase)} onClick={save}>{saved && <Check size={15} />}{pending.includes('settings') ? t.saving : saved ? t.saved : t.savePreferences}</button></div></>;
}
function Overlay() {
  const { snapshot, pending } = useAppStore();
  const { session } = snapshot;
  const t = useI18n();
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  return <div className="overlay-shell"><div className="overlay-dot"><AudioLines size={23} /></div><div className="overlay-info"><strong>{phaseLabel(t, session.phase)}</strong><span>{session.partialTranscript || session.transcript || (session.phase === 'recording' ? `${t.listening} · ${formatTime(session.elapsedMs)}` : session.error || session.notice || 'FlowVoice')}</span></div>{session.phase === 'recording' ? <><Waveform active level={session.level} /><button aria-label={t.stopRecording} disabled={pending.includes('record')} onClick={() => void runAction('record', () => command('stop_recording'))}><Square size={15} fill="currentColor" /></button></> : ['transcribing', 'generating'].includes(session.phase) ? <LoaderCircle className="spin" size={20} /> : null}{isBusy(session.phase) && <button aria-label={t.cancelRecording} onClick={() => void runAction('cancel', () => command('cancel_session'))}><X size={18} /></button>}</div>;
}
function App() {
  useBackend();
  const [page, setPage] = useState<Page>('workspace');
  const { error } = useAppStore();
  const t = useI18n();
  if (new URLSearchParams(window.location.search).has('overlay')) return <Overlay />;
  const items: { id: Page; label: string; icon: typeof Mic }[] = [
    { id: 'workspace', label: t.workspace, icon: LayoutDashboard },
    { id: 'models', label: t.models, icon: SlidersHorizontal },
    { id: 'settings', label: t.preferences, icon: Settings2 },
  ];
  return <div className="app-shell"><aside className="sidebar"><Brand /><span className="sidebar-section-label">{t.navSection}</span><nav aria-label={t.navSection}>{items.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}><span className="nav-icon"><Icon size={18} strokeWidth={1.9} /></span><span>{label}</span>{page === id && <span className="nav-active-dot" />}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={17} /><strong>{t.modelChoiceTitle}</strong><p>{t.modelChoiceLocal}<br />{t.modelChoiceCloud}</p><button onClick={() => setPage('models')}>{t.manageModels} <ArrowRight size={13} /></button></div><div className="sidebar-footer"><span className="app-version">FlowVoice <span>v0.1.0</span></span><button aria-label={t.settingsHelp} onClick={() => setPage('settings')}><Settings2 size={16} /></button></div></div></aside><div className="main-shell"><main className={`page-content page-${page}`}>{!desktop && <div className="preview-banner"><Monitor size={16} /><span>{t.previewNotice}</span></div>}<AppHeader page={page} />{error && <div className="notice notice-error dismissible" role="alert"><span>{error}</span><button aria-label={t.dismissError} onClick={() => useAppStore.getState().setError(null)}><X size={15} /></button></div>}{page === 'workspace' ? <Workspace navigate={setPage} /> : page === 'models' ? <Models /> : <Preferences />}<footer className="page-footer"><span>{t.footer}</span><AudioLines size={16} /></footer></main></div></div>;
}
export default App;
