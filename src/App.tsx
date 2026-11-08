import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowRight, AudioLines, Check, ChevronRight, Cloud, Copy,
  Download, FileText, FolderOpen, Keyboard, LayoutDashboard, LoaderCircle,
  Mic, Monitor, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Square, Trash2, X,
} from 'lucide-react';
import { command, desktop, runAction, useBackend } from './lib/tauri/bridge';
import { browserPlatform, defaultShortcut, normalizeShortcut, shortcutLabel, shortcutRecording, type DesktopPlatform } from './lib/platform';
import { useAppStore, type DictationEntry } from './stores/appStore';
import type { AppSettings, AppSnapshot, InputMode, SessionPhase } from './types';
import './App.css';

type Page = 'workspace' | 'models' | 'settings';
const modes: { id: InputMode; label: string; hint: string; icon: typeof Mic }[] = [
  { id: 'dictate', label: '实时输入', hint: '边说边写进同一词条', icon: Mic },
  { id: 'polish', label: '润色改写', hint: '整理口述，表达更清晰', icon: Sparkles },
  { id: 'compose', label: '帮我写', hint: '说出要求，生成内容', icon: FileText },
];
const phaseNames: Record<SessionPhase, string> = {
  idle: '准备好，开始说话', recording: '正在聆听你的声音', transcribing: '正在识别语音',
  generating: '正在整理文字', done: '文字已准备好', error: '这次处理未完成', cancelled: '录音已取消',
};
const isBusy = (phase: SessionPhase) => ['recording', 'transcribing', 'generating'].includes(phase);
const formatTime = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`;
const formatDuration = (ms: number) => {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h > 0 ? `${h}小时${m}分` : m > 0 ? `${m}分${s.toString().padStart(2, '0')}秒` : `${s}秒`;
};
const formatClock = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
function ShortcutRecorder({ value, platform, onChange }: { value: string; platform: DesktopPlatform; onChange: (next: string) => void }) {
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
  return <button type="button" className={`shortcut-recorder ${recording ? 'recording' : ''}`} onClick={() => setRecording(!recording)} aria-pressed={recording} aria-label={recording ? '正在录制全局快捷键，按 Esc 取消' : `全局录音快捷键：${shortcutLabel(value, platform)}`}>
    <Keyboard size={15} />
    <span>{recording ? '请按下组合键，Esc 取消' : shortcutLabel(value, platform)}</span>
  </button>;
}

function Brand() {
  return <div className="brand"><div className="brand-symbol"><AudioLines size={23} strokeWidth={2.5} /></div><span>FlowVoice<span className="brand-dot">.</span></span></div>;
}
function Badge({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span className={`badge ${muted ? 'badge-muted' : ''}`}><span className="status-dot" />{children}</span>;
}
function AppHeader({ page }: { page: Page }) {
  const details = {
    workspace: { eyebrow: 'YOUR VOICE, IN FLOW', title: '让想法，自然成文', description: '说出你的想法，剩下的交给 FlowVoice。' },
    models: { eyebrow: 'MAKE IT YOURS', title: '选择你的模型', description: '识别与写作独立配置，本地、云端，自由组合。' },
    settings: { eyebrow: 'A LITTLE MORE YOU', title: '按你的习惯来', description: '设置快捷键，让语音输入融入日常。' },
  }[page];
  return <header className="page-heading"><div><span className="eyebrow">{details.eyebrow}</span><h1>{details.title}<span className="heading-dot">。</span></h1><p>{details.description}</p></div><div className="page-heading-mark">{page === 'workspace' ? <AudioLines size={25} /> : page === 'models' ? <SlidersHorizontal size={24} /> : <Settings2 size={24} />}</div></header>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function Waveform({ active, level = 0 }: { active: boolean; level?: number }) {
  return <div className={`waveform ${active ? 'waveform-active' : ''}`} aria-hidden="true">{Array.from({ length: 31 }, (_, i) => <span key={i} style={{ height: `${active ? 6 + Math.min(1, level * 4) * (10 + (1 - Math.abs(i - 15) / 16) * 38) : 4}px`, animationDelay: `${(i % 7) * -0.12}s` }} />)}</div>;
}
function Workspace({ navigate }: { navigate: (page: Page) => void }) {
  const { snapshot, pending, entries } = useAppStore();
  const { settings, session } = snapshot;
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
        <section className="mode-selector" aria-label="输入模式">{modes.map(({ id, label, hint, icon: Icon }) => <button key={id} className={`mode-option ${settings.mode === id ? 'selected' : ''}`} onClick={() => changeMode(id)} disabled={!desktop || busy || pending.includes('mode')} aria-pressed={settings.mode === id}><span className="mode-icon"><Icon size={20} /></span><span><strong>{label}</strong><small>{hint}</small></span>{settings.mode === id && <span className="mode-check"><Check size={11} /></span>}</button>)}</section>
    <section className={`record-card ${recording ? 'is-recording' : ''}`}>
      <div className="record-topline"><span className="mini-label"><span className={`status-dot ${recording ? 'recording-dot' : ''}`} />{recording ? '麦克风正在使用' : '语音工作台'}</span><span className="timer">{formatTime(session.elapsedMs)}</span></div>
      <div className="record-content"><button className={`record-button ${recording ? 'record-button-active' : ''}`} aria-label={recording ? '结束录音' : '开始录音'} onClick={record} disabled={!desktop || !ready || (busy && !recording) || pending.includes('record')}>
        {pending.includes('record') || (busy && !recording) ? <LoaderCircle className="spin" size={31} /> : recording ? <Square size={25} fill="currentColor" /> : <Mic size={33} strokeWidth={1.7} />}
      </button><h2>{phaseNames[session.phase]}</h2><p>{recording ? '松开快捷键或点击按钮，结束录音' : !ready ? '先在模型服务中准备语音识别模型' : settings.mode === 'compose' ? '告诉我想写什么，以及语气、长度和用途' : '点击麦克风，或按住全局快捷键说话'}</p><Waveform active={recording} level={session.level} />
      {busy ? <button className="text-button cancel-link" onClick={() => void runAction('cancel', () => command('cancel_session'))} disabled={pending.includes('cancel')}><X size={13} />取消本次任务</button> : <div className="shortcut-hint"><kbd>{shortcutLabel(desktop ? settings.shortcut : defaultShortcut(platform), platform)}</kbd><span>按住说话，松开结束</span></div>}</div>
      <div className="record-footer"><span>{settings.asr.provider === 'local' ? <Monitor size={14} /> : <Cloud size={14} />}{settings.asr.provider === 'local' ? 'SenseVoice · 本地' : `${settings.asr.model || '语音识别'} · 云端`}<span className="footer-dot">·</span>{settings.asr.provider === 'local' ? '音频留在你的电脑' : '音频发送至已配置的服务'}</span><button className="text-button" onClick={() => navigate('models')}>模型设置 <ChevronRight size={14} /></button></div>
    </section>
    {(session.error || session.notice) && <div className={`notice ${session.error ? 'notice-error' : ''}`} role={session.error ? 'alert' : 'status'}>{session.error || session.notice}</div>}
    {settings.mode !== 'dictate' && settings.llm.provider !== 'disabled' && <div className="model-flow-note"><Sparkles size={13} /><span>{settings.llm.model || '语言模型'} · {settings.llm.provider === 'local' ? '本地写作服务' : '云端写作服务，转写文字将发送至该服务'}</span></div>}
    {settings.mode !== 'dictate' && settings.llm.provider === 'disabled' && <div className="notice">此模式需要语言模型。<button className="inline-link" onClick={() => navigate('models')}>前往配置</button>，或选择实时输入。</div>}
    <section className="result-card"><div className="section-heading"><h2><FileText size={17} />文字结果</h2><div className="result-actions"><button className="quiet-button" onClick={() => useAppStore.getState().addManualEntry()}>＋ 手动输入</button></div></div>
      <div className="stats-row" aria-label="听写统计">
        <div className="stat-item"><span className="stat-value">{stats.totalMs ? formatDuration(stats.totalMs) : '—'}</span><span className="stat-label">总听写时长</span></div>
        <div className="stat-item"><span className="stat-value">{stats.totalChars ? `${stats.totalChars.toLocaleString('zh-CN')} 字` : '—'}</span><span className="stat-label">输入量</span></div>
        <div className="stat-item"><span className="stat-value">{stats.speed ? `${stats.speed} 字/分` : '—'}</span><span className="stat-label">平均速度</span></div>
      </div>
      <div className="entry-list">
        {entries.length === 0 && <div className="entry-empty">每次听写都会形成一条独立记录，出现在这里。<br />默认不保存原始音频；记录仅保留在本次会话。</div>}
        {entries.map((entry) => <div className="dictation-entry" key={entry.id}>
          <div className="entry-meta">
            <span className="entry-time">{formatClock(entry.createdAt)}</span>
            {entry.durationMs > 0 && <span>听写 {formatDuration(entry.durationMs)}</span>}
            {entry.live && <span className="entry-live"><span className="status-dot" />正在识别</span>}
            <span>{entry.text.length + (entry.partialText?.length || 0)} 字</span>
            <div className="entry-actions">
              <button className="quiet-button" disabled={entry.live || !entry.text || pending.includes('copy')} onClick={() => void copyEntry(entry)}>{copiedId === entry.id ? <Check size={14} /> : <Copy size={14} />}{copiedId === entry.id ? '已复制' : '复制'}</button>
              <button className="quiet-button" disabled={!desktop || !entry.text.trim() || busy || settings.llm.provider === 'disabled' || pending.includes('generate')} onClick={() => runEntryGenerate(entry, 'polish')}><Sparkles size={14} />润色</button>
              <button className="quiet-button" disabled={!desktop || !entry.text.trim() || busy || settings.llm.provider === 'disabled' || pending.includes('generate')} onClick={() => runEntryGenerate(entry, 'compose')}><ArrowRight size={14} />写作</button>
              <button className="quiet-button entry-delete" aria-label="删除这条记录" disabled={busy} onClick={() => useAppStore.getState().removeEntry(entry.id)}><Trash2 size={14} /></button>
            </div>
          </div>
          {entry.live ? <div className="entry-editor entry-live-text" aria-live="polite" aria-label="实时识别文字">{entry.text}<span>{entry.partialText || '正在聆听下一句…'}</span></div> : <textarea className="entry-editor" aria-label="听写文字，可编辑" value={entry.text} onChange={(event) => useAppStore.getState().updateEntryText(entry.id, event.target.value)} placeholder="输入或粘贴文字，可交给 AI 润色或续写。" spellCheck={false} />}
          {entry.rawTranscript && <details className="transcript"><summary>查看原始转写</summary><p>{entry.rawTranscript}</p></details>}
        </div>)}
      </div>
    </section>
    <div className="getting-started"><div className="help-icon"><Keyboard size={20} /></div><div><strong>在常用输入框，随时开口</strong><p>将光标放入微信、文档或浏览器输入框，再按快捷键。实时输入按语句追加，AI 结果先预览。</p></div><button aria-label="查看输入偏好" onClick={() => navigate('settings')}><ArrowRight size={19} /></button></div>
  </>;
}
function Models() {
  const { snapshot, pending, progress } = useAppStore();
  const [draft, setDraft] = useState<AppSettings>(snapshot.settings);
  const [asrKey, setAsrKey] = useState('');
  const [llmKey, setLlmKey] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(snapshot.settings); }, [snapshot.settings]);
  const updateAsr = (patch: Partial<AppSettings['asr']>) => { if ('provider' in patch || 'baseUrl' in patch) setAsrKey(''); setSaved(false); setDraft((value) => ({ ...value, asr: { ...value.asr, ...patch } })); };
  const updateLlm = (patch: Partial<AppSettings['llm']>) => { if ('provider' in patch || 'baseUrl' in patch) setLlmKey(''); setSaved(false); setDraft((value) => ({ ...value, llm: { ...value.llm, ...patch } })); };
  const chooseDir = () => void runAction('directory', async () => {
    const path = await open({ directory: true, multiple: false, title: '选择 SenseVoice 模型目录' });
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
  return <>    <section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><AudioLines size={20} /></span><div><h2>语音识别</h2><p>把你的声音转成文字</p></div><span className="step-number">01</span></div><div className="settings-body"><div className="segmented"><button className={draft.asr.provider === 'local' ? 'active' : ''} onClick={() => updateAsr({ provider: 'local' })}><Monitor size={15} />本地模型</button><button className={draft.asr.provider === 'cloud' ? 'active' : ''} onClick={() => updateAsr({ provider: 'cloud' })}><Cloud size={15} />云端服务</button></div>
      {draft.asr.provider === 'local' ? <><div className="local-model"><div className="model-art"><AudioLines size={28} /></div><div><strong>SenseVoice Small <span className="model-chip">INT8</span></strong><p>中文优先 · 本地推理 · 模型约 240 MB</p></div><Badge muted={!snapshot.modelReady}>{snapshot.modelReady ? '已就绪' : '待准备'}</Badge></div><Field label="模型目录" hint="选择包含 model.int8.onnx 与 tokens.txt 的目录。"><div className="input-with-button"><input value={draft.asr.modelDir} onChange={(e) => updateAsr({ modelDir: e.target.value })} placeholder="下载模型，或选择已有模型目录" /><button aria-label="选择模型目录" disabled={!desktop || pending.includes('directory')} onClick={chooseDir}><FolderOpen size={18} /></button></div></Field><div className="download-row"><button className="secondary-button" disabled={!desktop || downloading || busy} onClick={() => void runAction('download', () => command('download_model'))}>{downloading ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}{downloading ? '正在下载模型…' : '下载 SenseVoice 模型'}</button><span>仅下载时需要联网</span></div>{progress && <div className="download-progress"><div><span>{progress.status}</span><span>{progress.total ? `${percentage}%` : `${(progress.downloaded / 1024 / 1024).toFixed(1)} MB`}</span></div><progress value={progress.downloaded} max={progress.total || Math.max(progress.downloaded, 1)} /></div>}</> : <><div className="data-note"><Cloud size={16} /><p>录音将发送到下面配置的服务。需支持 OpenAI 兼容的音频转写接口。</p></div><Field label="API Base URL" hint="例如 https://api.example.com/v1；不要填写完整的 /audio/transcriptions 地址。"><input value={draft.asr.baseUrl} onChange={(e) => updateAsr({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" /></Field><Field label="模型 ID"><input value={draft.asr.model} onChange={(e) => updateAsr({ model: e.target.value })} placeholder="例如 whisper-1" autoComplete="off" /></Field><Field label={`API Key${!asrEndpointSaved ? ' · 服务变更待保存' : snapshot.asrKeyConfigured ? ' · 已配置' : ''}`} hint="留空保留已有密钥；密钥由桌面端安全存储。"><input type="password" value={asrKey} onChange={(e) => { setAsrKey(e.target.value); setSaved(false); }} placeholder={asrEndpointSaved && snapshot.asrKeyConfigured ? '输入新密钥以替换' : '输入服务的 API Key'} autoComplete="new-password" /></Field></>}
    </div></section>
    <section className="settings-card"><div className="settings-card-header"><span className="setting-icon violet"><Sparkles size={20} /></span><div><h2>语言模型</h2><p>润色表达，或按你的要求写作</p></div><span className="step-number">02</span></div><div className="settings-body"><div className="segmented segmented-three">{([{ id: 'disabled', label: '暂不使用', icon: Square }, { id: 'local', label: '本地服务', icon: Monitor }, { id: 'cloud', label: '云端服务', icon: Cloud }] as const).map(({ id, label, icon: Icon }) => <button key={id} className={draft.llm.provider === id ? 'active' : ''} onClick={() => updateLlm({ provider: id, ...(id === 'local' && !draft.llm.baseUrl.startsWith('http://127.') && !draft.llm.baseUrl.startsWith('http://localhost') ? { baseUrl: 'http://127.0.0.1:8080/v1' } : {}) })}><Icon size={14} />{label}</button>)}</div>
      {draft.llm.provider === 'disabled' ? <div className="disabled-model"><Sparkles size={25} strokeWidth={1.4} /><strong>先让声音变成文字</strong><p>实时输入无需语言模型。准备好后，再开启润色与写作。</p></div> : <><div className="data-note">{draft.llm.provider === 'local' ? <Monitor size={16} /> : <Cloud size={16} />}<p>{draft.llm.provider === 'local' ? '连接已启动的本机 OpenAI 兼容服务，例如 llama.cpp 或 Ollama。此版本不代为启动模型服务。' : '转写或你提交的文字将发送到所选服务。需支持 OpenAI 兼容的 Chat Completions 接口。'}</p></div><Field label="API Base URL" hint={draft.llm.provider === 'local' ? '本地模式仅允许 localhost、127.0.0.1 或 [::1] 回环地址。' : '填写服务的 API 前缀，一般以 /v1 结尾。'}><input value={draft.llm.baseUrl} onChange={(e) => updateLlm({ baseUrl: e.target.value })} placeholder={draft.llm.provider === 'local' ? 'http://127.0.0.1:8080/v1' : 'https://api.example.com/v1'} autoComplete="off" /></Field><Field label="模型 ID"><input value={draft.llm.model} onChange={(e) => updateLlm({ model: e.target.value })} placeholder={draft.llm.provider === 'local' ? '填写本地服务加载的模型名称' : '填写服务商提供的模型 ID'} autoComplete="off" /></Field><Field label={`API Key${!llmEndpointSaved ? ' · 服务变更待保存' : snapshot.llmKeyConfigured ? ' · 已配置' : ''}`} hint="留空保留已有密钥；未启用鉴权的本地服务可不填写。"><input type="password" value={llmKey} onChange={(e) => { setLlmKey(e.target.value); setSaved(false); }} placeholder="输入 API Key（按服务要求）" autoComplete="new-password" /></Field></>}
    </div></section><div className="save-bar"><span>{busy ? '当前任务结束后可保存设置' : saved ? '模型设置已保存' : '设置在保存后生效；不会自动切换到云端'}</span><button className="primary-button" disabled={!desktop || pending.includes('settings') || busy} onClick={save}>{pending.includes('settings') ? <LoaderCircle className="spin" size={15} /> : saved ? <Check size={15} /> : null}{saved ? '已保存' : '保存模型设置'}</button></div></>;
}
function Preferences() {
  const { snapshot, pending } = useAppStore();
  const platform = (desktop ? snapshot.platform : browserPlatform()) as DesktopPlatform;
  const [shortcut, setShortcut] = useState(desktop ? snapshot.settings.shortcut : defaultShortcut(platform));
  const [autoInsert, setAutoInsert] = useState(snapshot.settings.autoInsert);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setShortcut(desktop ? snapshot.settings.shortcut : defaultShortcut(platform)); setAutoInsert(snapshot.settings.autoInsert); }, [snapshot.settings]);
  const save = () => void runAction('settings', async () => { useAppStore.getState().setSnapshot(await command<AppSnapshot>('save_settings', { settings: { ...snapshot.settings, shortcut: normalizeShortcut(shortcut, platform), autoInsert } })); setSaved(true); });
  return <><section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><Keyboard size={21} /></span><div><h2>录音与输入</h2><p>在不同应用之间保持顺畅</p></div></div><div className="settings-body"><Field label="全局录音快捷键" hint={platform === 'macos' ? '点击右侧按钮后直接按下组合键（需至少含一个 ⌘、⌥、⇧ 或 Ctrl 修饰键）；按住开始录音，松开结束。' : '点击右侧按钮后直接按下组合键（需至少含一个 Ctrl、Alt、Shift 或 Win 修饰键）；按住开始录音，松开结束。'}><ShortcutRecorder value={shortcut} platform={platform} onChange={(next) => { setShortcut(next); setSaved(false); }} /></Field><div className="setting-row"><div><strong>实时输入自动回填</strong><p>本地识别按语句追加到原输入框；AI 生成结果先预览。</p></div><button type="button" role="switch" aria-label="实时输入自动回填" aria-checked={autoInsert} className={`toggle ${autoInsert ? 'on' : ''}`} onClick={() => { setAutoInsert(!autoInsert); setSaved(false); }}><span /></button></div><div className="data-note"><ShieldCheck size={16} /><p>目标窗口变化或无法安全输入时保留结果供复制。默认不保存原始录音，本地识别失败不会自动上传云端。</p></div></div></section>
    {platform === 'macos' && <section className="settings-card"><div className="settings-card-header"><span className="setting-icon"><ShieldCheck size={20} /></span><div><h2>系统权限</h2><p>macOS 跨应用输入需要辅助功能权限</p></div><Badge muted={!snapshot.accessibilityGranted}>{snapshot.accessibilityGranted ? '已授权' : '待授权'}</Badge></div><div className="settings-body permission-row"><p>首次录音时系统会请求麦克风权限。启用辅助功能后，FlowVoice 才能向其他应用输入文字。</p><button className="secondary-button" disabled={!desktop || pending.includes('permission')} onClick={() => void runAction('permission', async () => { await command('request_accessibility'); useAppStore.getState().setSnapshot(await command<AppSnapshot>('get_snapshot')); })}>检查并请求权限<ArrowRight size={14} /></button></div></section>}
    <div className="save-bar"><span>{saved ? '偏好设置已保存' : '快捷键如被占用，保存时会提示'}</span><button className="primary-button" disabled={!desktop || pending.includes('settings') || isBusy(snapshot.session.phase)} onClick={save}>{saved && <Check size={15} />}{pending.includes('settings') ? '保存中…' : saved ? '已保存' : '保存偏好设置'}</button></div></>;
}
function Overlay() {
  const { snapshot, pending } = useAppStore();
  const { session } = snapshot;
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  return <div className="overlay-shell"><div className="overlay-dot"><AudioLines size={23} /></div><div className="overlay-info"><strong>{phaseNames[session.phase]}</strong><span>{session.partialTranscript || session.transcript || (session.phase === 'recording' ? `正在聆听 · ${formatTime(session.elapsedMs)}` : session.error || session.notice || 'FlowVoice')}</span></div>{session.phase === 'recording' ? <><Waveform active level={session.level} /><button aria-label="结束录音" disabled={pending.includes('record')} onClick={() => void runAction('record', () => command('stop_recording'))}><Square size={15} fill="currentColor" /></button></> : ['transcribing', 'generating'].includes(session.phase) ? <LoaderCircle className="spin" size={20} /> : null}{isBusy(session.phase) && <button aria-label="取消录音" onClick={() => void runAction('cancel', () => command('cancel_session'))}><X size={18} /></button>}</div>;
}
function App() {
  useBackend();
  const [page, setPage] = useState<Page>('workspace');
  const { error } = useAppStore();
  if (new URLSearchParams(window.location.search).has('overlay')) return <Overlay />;
  const items: { id: Page; label: string; icon: typeof Mic }[] = [
    { id: 'workspace', label: '工作台', icon: LayoutDashboard },
    { id: 'models', label: '模型服务', icon: SlidersHorizontal },
    { id: 'settings', label: '偏好设置', icon: Settings2 },
  ];
  return <div className="app-shell"><aside className="sidebar"><Brand /><span className="sidebar-section-label">创作空间</span><nav aria-label="主导航">{items.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}><span className="nav-icon"><Icon size={18} strokeWidth={1.9} /></span><span>{label}</span>{page === id && <span className="nav-active-dot" />}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={17} /><strong>模型由你选择</strong><p>本地保护隐私<br />云端拓展能力</p><button onClick={() => setPage('models')}>管理模型 <ArrowRight size={13} /></button></div><div className="sidebar-footer"><span className="app-version">FlowVoice <span>v0.1.0</span></span><button aria-label="查看偏好设置与使用帮助" onClick={() => setPage('settings')}><Settings2 size={16} /></button></div></div></aside><div className="main-shell"><main className={`page-content page-${page}`}>{!desktop && <div className="preview-banner"><Monitor size={16} /><span>浏览器预览 · 录音、模型下载和设置保存需在桌面应用中使用。</span></div>}<AppHeader page={page} />{error && <div className="notice notice-error dismissible" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => useAppStore.getState().setError(null)}><X size={15} /></button></div>}{page === 'workspace' ? <Workspace navigate={setPage} /> : page === 'models' ? <Models /> : <Preferences />}<footer className="page-footer"><span>少一点敲击，多一点心流。</span><AudioLines size={16} /></footer></main></div></div>;
}
export default App;
