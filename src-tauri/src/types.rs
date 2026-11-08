use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSettings {
    pub provider: String,
    pub model_dir: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub mode: String,
    pub auto_insert: bool,
    pub asr: AsrSettings,
    pub llm: LlmSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: if cfg!(target_os = "windows") {
                "Control+Shift+Space"
            } else {
                "Alt+Shift+Space"
            }
            .into(),
            mode: "dictate".into(),
            auto_insert: true,
            asr: AsrSettings {
                provider: "local".into(),
                model_dir: String::new(),
                base_url: String::new(),
                model: String::new(),
            },
            llm: LlmSettings {
                provider: "disabled".into(),
                base_url: "http://127.0.0.1:8080/v1".into(),
                model: String::new(),
            },
        }
    }
}

pub fn normalize_shortcut(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|key| match key {
            "CommandOrControl" | "CmdOrCtrl" if cfg!(target_os = "macos") => "Super",
            "CommandOrControl" | "CmdOrCtrl" => "Control",
            _ => key,
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod shortcut_tests {
    use super::*;

    #[test]
    fn global_shortcuts_use_explicit_modifiers() {
        let shortcut = normalize_shortcut("CommandOrControl+Shift+KeyJ");
        assert!(shortcut
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_ok());
        assert!(AppSettings::default()
            .shortcut
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_ok());
        if cfg!(target_os = "windows") {
            assert_eq!(shortcut, "Control+Shift+KeyJ");
        } else {
            assert_eq!(shortcut, "Super+Shift+KeyJ");
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: u64,
    #[serde(default)]
    pub revision: u64,
    pub phase: String,
    pub transcript: String,
    /// The current, revisable utterance. `transcript` contains committed speech.
    pub partial_transcript: String,
    pub output: String,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub level: f32,
    pub elapsed_ms: u64,
}

impl Default for SessionSnapshot {
    fn default() -> Self {
        Self {
            id: 0,
            revision: 0,
            phase: "idle".into(),
            transcript: String::new(),
            partial_transcript: String::new(),
            output: String::new(),
            error: None,
            notice: None,
            level: 0.0,
            elapsed_ms: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub settings: AppSettings,
    pub session: SessionSnapshot,
    pub asr_key_configured: bool,
    pub llm_key_configured: bool,
    pub model_ready: bool,
    pub platform: String,
    pub accessibility_granted: bool,
}
