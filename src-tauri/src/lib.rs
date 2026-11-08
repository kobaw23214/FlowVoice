mod audio;
mod dictation;
mod i18n;
mod models;
mod platform;
mod providers;
mod session;
mod storage;
mod streaming;
mod types;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use types::{AppSettings, AppSnapshot, SessionSnapshot};

struct Inner {
    settings: AppSettings,
    session: SessionSnapshot,
    recorder: Option<audio::Recorder>,
    recording_settings: Option<AppSettings>,
    target: Option<platform::InputTarget>,
    started: Option<Instant>,
    cancellation: session::Cancellation,
    streaming: Option<StreamingSession>,
}

struct StreamingSession {
    sender: mpsc::SyncSender<streaming::Chunk>,
    worker: Option<std::thread::JoinHandle<()>>,
    insertion: Arc<Mutex<dictation::Insertion>>,
}
struct AppState {
    inner: Mutex<Inner>,
    config_dir: PathBuf,
    model_dir: PathBuf,
    downloading: AtomicBool,
    event_revision: AtomicU64,
    hotkey_down: AtomicBool,
    shortcut_recording: AtomicU64,
    shortcut_released: AtomicBool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DictationSegment {
    pub(crate) id: u64,
    pub(crate) text: String,
    pub(crate) stable: bool,
}

fn emit_dictation_segment(app: &AppHandle, segment: &DictationSegment) {
    let _ = app.emit("flowvoice://dictation-segment", segment);
}

/// Local partial text is revisable. Confirmed segments may be appended to the
/// original editor, but are never reordered into new entries by the UI.
fn emit_local_segment(
    app: &AppHandle,
    id: u64,
    text: String,
    stable: bool,
    insertion: &Arc<Mutex<dictation::Insertion>>,
) {
    let state = app.state::<AppState>();
    {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if inner.session.id != id
            || (!stable && inner.session.phase != "recording")
            || (stable && !matches!(inner.session.phase.as_str(), "recording" | "transcribing"))
        {
            return;
        }
        if stable {
            inner.session.transcript = dictation::append_fragment(&inner.session.transcript, &text);
            inner.session.partial_transcript.clear();
        } else {
            inner.session.partial_transcript = text.clone();
        }
        let insert = if stable && inner.settings.auto_insert && inner.settings.mode == "dictate" {
            insertion.lock().ok().and_then(|insertion| {
                match insertion.next_chunk(&inner.session.transcript) {
                    Ok(delta) => Some(delta),
                    Err(error) => {
                        inner.session.notice = Some(error);
                        inner.target = None;
                        None
                    }
                }
            })
        } else {
            None
        };
        let segment = DictationSegment {
            id,
            text: if stable {
                inner.session.transcript.clone()
            } else {
                text
            },
            stable,
        };
        // Serialize target validation, insertion and its acknowledgement with
        // stop/cancel. Otherwise finish can observe a stale acknowledgement
        // and send the last fragment to the editor a second time.
        if let Some(text) = insert.as_ref().filter(|text| !text.is_empty()) {
            let target = inner.target.clone();
            if let Some(target) = target {
                match platform::append_live(&text, &target) {
                    Ok(()) => {
                        if let Ok(mut insertion) = insertion.lock() {
                            insertion.mark_sent(&inner.session.transcript);
                        }
                    }
                    Err(error) => {
                        inner.session.notice =
                            Some(format!("实时追加已停止，完整文字会保留在工作台。{error}"));
                        inner.target = None;
                    }
                }
            }
        }
        // Assign the event revision while the session lock is still held, so
        // this older update cannot be published after a newer terminal state.
        emit_dictation_segment(app, &segment);
        emit_session(app, &inner.session);
    }
}

fn emit_session(app: &AppHandle, session: &SessionSnapshot) {
    let mut session = session.clone();
    let state = app.state::<AppState>();
    session.revision = state.event_revision.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("flowvoice://session", session);
}

fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn busy(phase: &str) -> bool {
    matches!(phase, "recording" | "transcribing" | "generating")
}

fn shortcut_released(
    inner: &Inner,
    recording_id: &AtomicU64,
    released: &AtomicBool,
) -> Option<u64> {
    released.store(true, Ordering::SeqCst);
    let expected_id = recording_id.swap(0, Ordering::SeqCst);
    (expected_id > 0 && inner.session.id == expected_id && inner.session.phase == "recording")
        .then_some(expected_id)
}

fn shortcut_started(recording_id: &AtomicU64, released: &AtomicBool, session_id: u64) -> bool {
    recording_id.store(session_id, Ordering::SeqCst);
    if released.swap(false, Ordering::SeqCst) {
        recording_id.store(0, Ordering::SeqCst);
        true
    } else {
        false
    }
}

fn snapshot(app: &AppHandle) -> Result<AppSnapshot, String> {
    let state = app.state::<AppState>();
    let (settings, session) = {
        let inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        (inner.settings.clone(), inner.session.clone())
    };
    let asr_key_configured = storage::credential_scope("asr", &settings)
        .ok()
        .flatten()
        .and_then(|scope| storage::get_key(&scope).ok().flatten())
        .is_some();
    let llm_key_configured = storage::credential_scope("llm", &settings)
        .ok()
        .flatten()
        .and_then(|scope| storage::get_key(&scope).ok().flatten())
        .is_some();
    Ok(AppSnapshot {
        model_ready: providers::local_model_ready(&settings.asr.model_dir),
        settings,
        session,
        asr_key_configured,
        llm_key_configured,
        platform: std::env::consts::OS.into(),
        accessibility_granted: platform::accessibility_granted(),
    })
}

#[tauri::command]
fn get_snapshot(app: AppHandle) -> Result<AppSnapshot, String> {
    snapshot(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSnapshot, String> {
    let mut settings = settings;
    settings.shortcut = types::normalize_shortcut(&settings.shortcut);
    if !matches!(settings.mode.as_str(), "dictate" | "polish" | "compose") {
        return Err("请选择有效的输入模式".into());
    }
    if !matches!(settings.language.as_str(), "zh-CN" | "zh-TW" | "en") {
        return Err("请选择有效的界面语言".into());
    }
    let shortcut: Shortcut = settings
        .shortcut
        .parse()
        .map_err(|_| {
            format!(
                "快捷键格式不正确，例如 {}",
                AppSettings::default().shortcut
            )
        })?;
    let state = app.state::<AppState>();
    {
        let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        if busy(&inner.session.phase) {
            return Err("请先结束当前任务，再保存设置".into());
        }
        let changed = settings.shortcut != inner.settings.shortcut;
        if changed {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|_| "快捷键已被占用，请换一个组合".to_string())?;
        }
        if let Err(error) = storage::save_settings(&state.config_dir, &settings) {
            if changed {
                let _ = app.global_shortcut().unregister(shortcut);
            }
            return Err(error);
        }
        if changed {
            let _ = app
                .global_shortcut()
                .unregister(inner.settings.shortcut.as_str());
        }
        inner.settings = settings;
    }
    let language = {
        let state = app.state::<AppState>();
        let inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        inner.settings.language.clone()
    };
    update_tray_language(&app, &language)?;
    let value = snapshot(&app)?;
    let _ = app.emit("flowvoice://settings", &value);
    Ok(value)
}

fn update_tray_language(app: &AppHandle, language: &str) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("main-tray") else {
        return Ok(());
    };
    let labels = i18n::tray_labels(language);
    let open = MenuItem::with_id(app, "open", labels.open, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let cancel = MenuItem::with_id(app, "cancel", labels.cancel, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(app, &[&open, &cancel, &quit])
        .map_err(|error| error.to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(labels.tooltip)).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_api_key(app: AppHandle, kind: String, key: String) -> Result<AppSnapshot, String> {
    {
        let state = app.state::<AppState>();
        let inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        if busy(&inner.session.phase) {
            return Err("请先结束当前任务，再修改 API Key".into());
        }
        let scope = storage::credential_scope(&kind, &inner.settings)?
            .ok_or("当前服务不需要 API Key，请先保存本地服务或云端服务配置")?;
        if key.trim().is_empty() {
            storage::delete_key(&scope)?;
        } else {
            storage::set_key(&scope, key.trim())?;
        }
    }
    snapshot(&app)
}

fn fail(app: &AppHandle, id: u64, error: String) {
    let state = app.state::<AppState>();
    if let Ok(mut inner) = state.inner.lock() {
        if !session::accepts_result(inner.session.id, &inner.session.phase, id) {
            return;
        }
        inner.session.phase = "error".into();
        inner.session.error = Some(error);
        inner.session.level = 0.0;
        emit_session(app, &inner.session);
        hide_overlay(app);
    };
}

fn record_start_failure(inner: &mut Inner, expected_id: u64, error: String) -> bool {
    if inner.session.id != expected_id || busy(&inner.session.phase) {
        return false;
    }
    // A failed start is a new attempt, including after a terminal result. The UI
    // intentionally ignores phase changes on an already completed task ID.
    inner.cancellation.cancel();
    inner.session = SessionSnapshot {
        id: expected_id + 1,
        phase: "error".into(),
        error: Some(error),
        ..SessionSnapshot::default()
    };
    inner.recording_settings = None;
    inner.target = None;
    inner.started = None;
    true
}

fn begin_recording(app: &AppHandle, external: bool, expected_id: u64) -> Result<(), String> {
    let state = app.state::<AppState>();
    let id;
    {
        let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        if inner.session.id != expected_id {
            return Ok(());
        }
        if busy(&inner.session.phase) {
            return Err("已有任务正在进行，请结束或取消后重试".into());
        }
        id = inner.session.id + 1;
        let prepared = (|| {
            if inner.settings.asr.provider == "local"
                && !providers::local_model_ready(&inner.settings.asr.model_dir)
            {
                return Err("请先在「模型服务」下载或导入 SenseVoice 本地模型".to_string());
            }
            if inner.settings.mode != "dictate" && inner.settings.llm.provider == "disabled" {
                return Err("请先配置语言模型，或切换到「实时输入」".to_string());
            }
            let target = if external {
                platform::capture_target().ok()
            } else {
                None
            };
            let handle = app.clone();
            let local = inner.settings.asr.provider == "local";
            let insertion = Arc::new(Mutex::new(dictation::Insertion::default()));
            let (audio_tx, audio_rx) = streaming::bounded_channel();
            let mut streaming_session = None;
            if local {
                let settings = inner.settings.asr.clone();
                let rate = audio::microphone_sample_rate()?;
                let partial_insertion = insertion.clone();
                let stable_insertion = insertion.clone();
                let partial_handle = app.clone();
                let stable_handle = app.clone();
                let worker = std::thread::spawn(move || {
                    streaming::run_local(
                        audio_rx,
                        settings,
                        rate,
                        move |text| {
                            emit_local_segment(
                                &partial_handle,
                                id,
                                text,
                                false,
                                &partial_insertion,
                            );
                        },
                        move |text| {
                            emit_local_segment(&stable_handle, id, text, true, &stable_insertion);
                        },
                    );
                });
                streaming_session = Some(StreamingSession {
                    sender: audio_tx,
                    worker: Some(worker),
                    insertion,
                });
            }
            let recorder = audio::Recorder::start(
                move |level| {
                    let state = handle.state::<AppState>();
                    if let Ok(mut current) = state.inner.try_lock() {
                        if current.session.id == id && current.session.phase == "recording" {
                            current.session.level = level;
                        }
                    };
                },
                {
                    let sender = streaming_session
                        .as_ref()
                        .map(|session| session.sender.clone());
                    move |audio| {
                        if let Some(sender) = &sender {
                            let _ = sender.try_send(streaming::Chunk::Audio(audio));
                        }
                    }
                },
            )?;
            Ok((recorder, target, streaming_session))
        })();
        let (recorder, target, streaming_session) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                if record_start_failure(&mut inner, expected_id, error.clone()) {
                    emit_session(app, &inner.session);
                    hide_overlay(app);
                }
                return Err(error);
            }
        };
        inner.session = SessionSnapshot {
            id,
            phase: "recording".into(),
            ..SessionSnapshot::default()
        };
        inner.cancellation.cancel();
        inner.cancellation = session::Cancellation::new();
        inner.recorder = Some(recorder);
        inner.recording_settings = Some(inner.settings.clone());
        inner.target = target;
        inner.started = Some(Instant::now());
        inner.streaming = streaming_session;
        emit_session(app, &inner.session);
    }
    if external {
        if let Some(window) = app.get_webview_window("overlay") {
            // This getter waits for the UI thread, so it must run without the
            // state lock that the UI's cancellation command also needs.
            let position = if let Ok(Some(monitor)) = window.current_monitor() {
                let scale = monitor.scale_factor();
                let size = monitor.size().to_logical::<f64>(scale);
                let origin = monitor.position().to_logical::<f64>(scale);
                Some(tauri::LogicalPosition::new(
                    origin.x + (size.width - 340.0) / 2.0,
                    origin.y + size.height - 150.0,
                ))
            } else {
                None
            };
            // These setters enqueue UI messages without waiting. Serialize the
            // check and enqueue with cancel, so a late show cannot resurrect it.
            let inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
            if inner.session.id != id || inner.session.phase != "recording" {
                return Ok(());
            }
            if let Some(position) = position {
                let _ = window.set_position(position);
            }
            let _ = window.show();
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let should_stop = {
                let state = handle.state::<AppState>();
                let Ok(mut inner) = state.inner.lock() else {
                    break;
                };
                if inner.session.id != id || inner.session.phase != "recording" {
                    break;
                }
                inner.session.elapsed_ms = inner
                    .started
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                emit_session(&handle, &inner.session);
                inner.session.elapsed_ms >= 120_000
            };
            if should_stop {
                let _ = finish_recording(handle.clone(), Some(id)).await;
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn start_recording(app: AppHandle) -> Result<(), String> {
    let expected_id = app
        .state::<AppState>()
        .inner
        .lock()
        .map_err(|_| "应用状态暂不可用")?
        .session
        .id;
    tauri::async_runtime::spawn_blocking(move || begin_recording(&app, false, expected_id))
        .await
        .map_err(|_| "录音任务启动失败".to_string())?
}

async fn read_key(scope: Option<storage::CredentialScope>) -> Result<Option<String>, String> {
    let Some(scope) = scope else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || storage::get_key(&scope))
        .await
        .map_err(|_| "读取凭据失败".to_string())?
}

async fn finish_recording(app: AppHandle, expected_id: Option<u64>) -> Result<(), String> {
    let (recorder, settings, id, target, cancellation, streaming_session) = {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        if expected_id.is_some_and(|id| id != inner.session.id) {
            return Ok(());
        }
        let recorder = inner.recorder.take().ok_or("当前没有录音任务")?;
        let settings = inner
            .recording_settings
            .take()
            .unwrap_or_else(|| inner.settings.clone());
        // New partial hypotheses must stop immediately. Only the already
        // queued final stable fragment is accepted while this phase runs.
        inner.session.phase = "transcribing".into();
        inner.session.partial_transcript.clear();
        inner.session.level = 0.0;
        emit_session(&app, &inner.session);
        (
            recorder,
            settings,
            inner.session.id,
            inner.target.clone(),
            inner.cancellation.clone(),
            inner.streaming.take(),
        )
    };
    let result = async {
        let Some(audio) = cancellation
            .run(tauri::async_runtime::spawn_blocking(move || {
                recorder.stop()
            }))
            .await
        else {
            return Ok(());
        };
        let audio = audio.map_err(|_| "录音任务结束失败".to_string())??;
        if audio.samples.is_empty() {
            return Err("没有录到声音，请检查麦克风权限和输入设备".to_string());
        }
        // Debug only: set FLOWVOICE_DUMP_AUDIO to inspect exactly what was captured.
        if std::env::var_os("FLOWVOICE_DUMP_AUDIO").is_some() {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: audio.sample_rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            if let Ok(mut writer) =
                hound::WavWriter::create(std::env::temp_dir().join("flowvoice-debug.wav"), spec)
            {
                for sample in &audio.samples {
                    let _ = writer.write_sample(*sample);
                }
                let _ = writer.finalize();
            }
        }
        let streamed = if let Some(mut streaming_session) = streaming_session {
            let _ = streaming_session
                .sender
                .send(streaming::Chunk::Finish(Vec::new()));
            if let Some(worker) = streaming_session.worker.take() {
                let _ = worker.join();
            }
            let state = app.state::<AppState>();
            let inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
            if !session::accepts_result(inner.session.id, &inner.session.phase, id) {
                return Ok(());
            }
            let unsent = streaming_session
                .insertion
                .lock()
                .ok()
                .and_then(|insertion| insertion.next_chunk(&inner.session.transcript).ok());
            (inner.session.transcript.clone(), unsent)
        } else {
            let Some(key) = cancellation
                .run(read_key(storage::credential_scope("asr", &settings)?))
                .await
            else {
                return Ok(());
            };
            let Some(transcript) = cancellation
                .run(providers::transcribe(
                    &settings.asr,
                    audio.samples,
                    audio.sample_rate,
                    key?,
                ))
                .await
            else {
                return Ok(());
            };
            (transcript?, None)
        };
        let (transcript, unsent) = streamed;
        if transcript.trim().is_empty() {
            return Err("没有识别到文字，请靠近麦克风再试一次".to_string());
        }
        {
            let state = app.state::<AppState>();
            let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
            if !session::accepts_result(inner.session.id, &inner.session.phase, id) {
                return Ok(());
            }
            inner.session.transcript = transcript.clone();
            inner.session.partial_transcript.clear();
            inner.session.elapsed_ms = audio.duration_ms;
            if audio.limit_reached {
                inner.session.notice = Some("已达到单次 120 秒上限".into());
            }
            if settings.mode != "dictate" {
                inner.session.phase = "generating".into();
            }
            emit_session(&app, &inner.session);
        }
        let output = if settings.mode == "dictate" {
            transcript
        } else {
            let Some(key) = cancellation
                .run(read_key(storage::credential_scope("llm", &settings)?))
                .await
            else {
                return Ok(());
            };
            let Some(output) = cancellation
                .run(providers::generate(
                    &settings.llm,
                    &settings.mode,
                    &transcript,
                    key?,
                ))
                .await
            else {
                return Ok(());
            };
            output?
        };
        complete(
            &app,
            id,
            output,
            if settings.auto_insert && settings.mode == "dictate" && unsent.is_some() {
                target
                    .clone()
                    .map(|target| (target, unsent.unwrap_or_default()))
            } else {
                None
            },
            target,
        );
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = &result {
        fail(&app, id, error.clone());
    }
    result
}

fn complete(
    app: &AppHandle,
    id: u64,
    output: String,
    target: Option<(platform::InputTarget, String)>,
    live_target: Option<platform::InputTarget>,
) {
    let state = app.state::<AppState>();
    if let Ok(mut inner) = state.inner.lock() {
        if !session::accepts_result(inner.session.id, &inner.session.phase, id) {
            return;
        }
        inner.session.output = output.clone();
        inner.session.phase = "done".into();
        inner.session.partial_transcript.clear();
        inner.session.level = 0.0;
        if let Some((target, unsent)) = target.filter(|(_, text)| !text.is_empty()) {
            // A final fragment may arrive after finish captured its target;
            // use that same validated target rather than sending twice.
            let target = live_target.unwrap_or(target);
            inner.session.notice = Some(match platform::append_live(&unsent, &target) {
                Ok(()) => "已向原输入窗口写入文字；请检查目标应用是否接收".into(),
                Err(error) => format!("文字已保留，可复制使用。{error}"),
            });
        }
        emit_session(app, &inner.session);
        hide_overlay(app);
    };
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<(), String> {
    finish_recording(app, None).await
}

#[tauri::command]
fn cancel_session(app: AppHandle) -> Result<(), String> {
    let recorder = {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        inner.cancellation.cancel();
        inner.session.id += 1;
        inner.session.phase = "cancelled".into();
        inner.session.level = 0.0;
        inner.session.error = None;
        inner.session.notice = Some("任务已取消，后续结果不会写入其他应用".into());
        inner.session.partial_transcript.clear();
        inner.recording_settings = None;
        inner.target = None;
        inner.started = None;
        inner.streaming.take();
        emit_session(&app, &inner.session);
        hide_overlay(&app);
        inner.recorder.take()
    };
    if let Some(recorder) = recorder {
        std::thread::spawn(move || recorder.cancel());
    }
    Ok(())
}

#[tauri::command]
async fn generate_text(app: AppHandle, text: String, mode: String) -> Result<(), String> {
    if !matches!(mode.as_str(), "polish" | "compose") {
        return Err("请选择润色或帮我写".into());
    }
    if text.trim().is_empty() {
        return Err("请先输入内容或录制一段语音".into());
    }
    let (id, settings, cancellation) = {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        if busy(&inner.session.phase) {
            return Err("请先结束当前任务".into());
        }
        let id = inner.session.id + 1;
        inner.session = SessionSnapshot {
            id,
            phase: "generating".into(),
            transcript: text.clone(),
            ..SessionSnapshot::default()
        };
        inner.cancellation.cancel();
        inner.cancellation = session::Cancellation::new();
        inner.target = None;
        emit_session(&app, &inner.session);
        (id, inner.settings.clone(), inner.cancellation.clone())
    };
    let result = async {
        let Some(key) = cancellation
            .run(read_key(storage::credential_scope("llm", &settings)?))
            .await
        else {
            return Ok(None);
        };
        let Some(output) = cancellation
            .run(providers::generate(&settings.llm, &mode, &text, key?))
            .await
        else {
            return Ok(None);
        };
        output.map(Some)
    }
    .await;
    match result {
        Ok(Some(output)) => {
            complete(&app, id, output, None, None);
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(error) => {
            fail(&app, id, error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    platform::copy_text(&text)
}

#[tauri::command]
fn insert_result(state: State<'_, AppState>) -> Result<(), String> {
    let inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
    if inner.session.phase != "done" || inner.session.output.trim().is_empty() {
        return Err("当前没有可写入的完整结果".into());
    }
    let target = inner
        .target
        .as_ref()
        .ok_or("本次没有记录外部输入窗口，请复制结果使用")?;
    platform::paste_to_target(&inner.session.output, target)
}

#[tauri::command]
fn request_accessibility() -> bool {
    platform::request_accessibility()
}

#[tauri::command]
async fn download_model(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("模型正在下载，请等待完成".into());
    }
    struct DownloadGuard<'a>(&'a AtomicBool);
    impl Drop for DownloadGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = DownloadGuard(&state.downloading);
    let initial_model_dir = state
        .inner
        .lock()
        .map_err(|_| "应用状态暂不可用")?
        .settings
        .asr
        .model_dir
        .clone();
    let dir = state.model_dir.clone();
    let result = models::download(&app, &dir).await;
    if let Err(error) = &result {
        let _ = app.emit(
            "flowvoice://model-progress",
            models::ModelProgress {
                downloaded: 0,
                total: 0,
                status: error.clone(),
            },
        );
        return result;
    }
    {
        let mut inner = state.inner.lock().map_err(|_| "应用状态暂不可用")?;
        // A download is allowed to finish in the background, but must not undo
        // a model directory explicitly selected while that download was running.
        if inner.settings.asr.model_dir == initial_model_dir {
            let mut settings = inner.settings.clone();
            settings.asr.model_dir = dir.to_string_lossy().into_owned();
            storage::save_settings(&state.config_dir, &settings)?;
            inner.settings = settings;
        }
    }
    let _ = app.emit("flowvoice://settings", snapshot(&app)?);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    let state = app.state::<AppState>();
                    if event.state == ShortcutState::Released {
                        state.hotkey_down.store(false, Ordering::SeqCst);
                        let expected_id = state.inner.try_lock().ok().and_then(|inner| {
                            shortcut_released(
                                &inner,
                                &state.shortcut_recording,
                                &state.shortcut_released,
                            )
                        });
                        if let Some(expected_id) = expected_id {
                            let handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = finish_recording(handle, Some(expected_id)).await;
                            });
                        }
                        return;
                    }
                    if state.hotkey_down.swap(true, Ordering::SeqCst) {
                        return;
                    }
                    state.shortcut_recording.store(0, Ordering::SeqCst);
                    state.shortcut_released.store(false, Ordering::SeqCst);
                    // Capture identity at the key event, not when the async task
                    // eventually gets CPU. A queued press must not start a new
                    // recording after cancellation has already advanced the ID.
                    let requested = state
                        .inner
                        .try_lock()
                        .ok()
                        .map(|inner| (inner.session.phase.clone(), inner.session.id));
                    let Some((phase, id)) = requested else {
                        return;
                    };
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if busy(&phase) {
                            return;
                        }
                        let other = handle.clone();
                        // begin_recording publishes failures with a fresh attempt
                        // ID. Reporting against this old ID would be stale.
                        let started = tauri::async_runtime::spawn_blocking(move || {
                            begin_recording(&other, true, id)
                        })
                        .await
                        .unwrap_or_else(|_| Err("录音启动失败".into()));
                        if started.is_ok() {
                            let shortcut_state = handle.state::<AppState>();
                            if shortcut_started(
                                &shortcut_state.shortcut_recording,
                                &shortcut_state.shortcut_released,
                                id + 1,
                            ) {
                                let _ = finish_recording(handle, Some(id + 1)).await;
                            }
                        }
                    });
                })
                .build(),
        )
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let model_dir = app
                .path()
                .app_local_data_dir()?
                .join("models")
                .join("sensevoice-small-int8");
            let (mut settings, load_notice) = match storage::load_settings(&config_dir) {
                Ok(settings) => (settings, None),
                Err(error) => (AppSettings::default(), Some(error)),
            };
            // Migrate only the original shipped default. Custom shortcuts stay
            // untouched when the same configuration is opened on another OS.
            settings.shortcut = types::normalize_shortcut(&settings.shortcut);
            if cfg!(target_os = "windows") && settings.shortcut == "Alt+Shift+Space" {
                settings.shortcut = AppSettings::default().shortcut;
            }
            if settings.asr.model_dir.is_empty() {
                settings.asr.model_dir = model_dir.to_string_lossy().into_owned();
            }
            let shortcut = settings.shortcut.clone();
            app.manage(AppState {
                inner: Mutex::new(Inner {
                    settings,
                    session: SessionSnapshot {
                        notice: load_notice,
                        ..SessionSnapshot::default()
                    },
                    recorder: None,
                    recording_settings: None,
                    target: None,
                    started: None,
                    cancellation: session::Cancellation::new(),
                    streaming: None,
                }),
                config_dir,
                model_dir,
                downloading: AtomicBool::new(false),
                event_revision: AtomicU64::new(0),
                hotkey_down: AtomicBool::new(false),
                shortcut_recording: AtomicU64::new(0),
                shortcut_released: AtomicBool::new(false),
            });
            if let Err(error) = app.global_shortcut().register(shortcut.as_str()) {
                if let Ok(mut inner) = app.state::<AppState>().inner.lock() {
                    inner.session.notice =
                        Some(format!("快捷键未注册，请在偏好设置中更换：{error}"));
                }
            }
            let language = app
                .state::<AppState>()
                .inner
                .lock()
                .map_err(|_| "应用状态暂不可用")?
                .settings
                .language
                .clone();
            let labels = i18n::tray_labels(&language);
            let open = MenuItem::with_id(app, "open", labels.open, true, None::<&str>)?;
            let cancel = MenuItem::with_id(app, "cancel", labels.cancel, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &cancel, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip(labels.tooltip)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "cancel" => {
                        let _ = cancel_session(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => (),
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            save_settings,
            save_api_key,
            start_recording,
            stop_recording,
            cancel_session,
            generate_text,
            copy_text,
            insert_result,
            download_model,
            request_accessibility
        ])
        .run(tauri::generate_context!())
        .expect("FlowVoice could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_state(phase: &str) -> Inner {
        Inner {
            settings: AppSettings::default(),
            session: SessionSnapshot {
                id: 7,
                phase: phase.into(),
                output: "old result".into(),
                ..SessionSnapshot::default()
            },
            recorder: None,
            recording_settings: None,
            target: None,
            started: None,
            cancellation: session::Cancellation::new(),
            streaming: None,
        }
    }

    #[test]
    fn failed_recording_start_gets_new_attempt_after_terminal_state() {
        for phase in ["done", "cancelled", "error"] {
            let mut inner = terminal_state(phase);
            assert!(record_start_failure(&mut inner, 7, "麦克风不可用".into()));
            assert_eq!(inner.session.id, 8);
            assert_eq!(inner.session.phase, "error");
            assert_eq!(inner.session.error.as_deref(), Some("麦克风不可用"));
            assert!(inner.session.output.is_empty());
            // A late duplicate failure must not allocate yet another attempt.
            assert!(!record_start_failure(&mut inner, 7, "late error".into()));
            assert_eq!(inner.session.id, 8);
        }
    }

    #[test]
    fn failed_recording_start_cannot_replace_busy_or_newer_session() {
        for phase in ["recording", "transcribing", "generating"] {
            let mut inner = terminal_state(phase);
            assert!(!record_start_failure(&mut inner, 7, "start failed".into()));
            assert_eq!(inner.session.phase, phase);
            assert_eq!(inner.session.id, 7);
            assert!(!inner.cancellation.is_cancelled());
        }
        let mut inner = terminal_state("done");
        assert!(!record_start_failure(&mut inner, 6, "stale start".into()));
        assert_eq!(inner.session.phase, "done");
        assert_eq!(inner.session.output, "old result");
    }

    #[test]
    fn task_phases_guard_settings_and_new_sessions() {
        for phase in ["recording", "transcribing", "generating"] {
            assert!(busy(phase));
        }
        for phase in ["idle", "done", "cancelled", "error"] {
            assert!(!busy(phase));
        }
    }
    #[test]
    fn default_settings_never_send_audio_to_cloud() {
        let settings = AppSettings::default();
        assert_eq!(settings.asr.provider, "local");
        assert_eq!(settings.llm.provider, "disabled");
        assert_eq!(settings.mode, "dictate");
        assert_eq!(settings.language, "zh-CN");
        assert!(settings.shortcut.parse::<Shortcut>().is_ok());
    }

    #[test]
    fn recorder_emitted_shortcut_strings_parse() {
        for shortcut in [
            "Alt+Shift+Space",
            "CommandOrControl+KeyJ",
            "CommandOrControl+Shift+Digit1",
            "Alt+KeyQ",
            "CommandOrControl+Alt+ArrowUp",
        ] {
            shortcut
                .parse::<Shortcut>()
                .unwrap_or_else(|error| panic!("{shortcut}: {error}"));
        }
    }

    #[test]
    fn shortcut_release_only_finishes_the_recording_it_started() {
        let recording_id = AtomicU64::new(0);
        let released = AtomicBool::new(false);
        let mut inner = terminal_state("idle");
        assert_eq!(shortcut_released(&inner, &recording_id, &released), None);
        inner.session.phase = "recording".into();
        inner.session.id = 8;
        released.store(false, Ordering::SeqCst);
        assert!(!shortcut_started(&recording_id, &released, 8));
        assert_eq!(shortcut_released(&inner, &recording_id, &released), Some(8));
        assert_eq!(recording_id.load(Ordering::SeqCst), 0);
        assert_eq!(shortcut_released(&inner, &recording_id, &released), None);
    }

    #[test]
    fn shortcut_released_before_the_microphone_is_ready_still_stops() {
        let recording_id = AtomicU64::new(0);
        let released = AtomicBool::new(true);
        assert!(shortcut_started(&recording_id, &released, 9));
        assert_eq!(recording_id.load(Ordering::SeqCst), 0);
        assert!(!released.load(Ordering::SeqCst));
    }
}
