//! Settings contain no credentials. API keys live in the OS credential store.

use crate::{providers, types::AppSettings};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, sync::Mutex};

const SERVICE: &str = "app.flowvoice.credentials";
const SETTINGS_FILE: &str = "settings.json";
// Serialize same-entry operations: Windows credential stores can race across threads.
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

pub fn load_settings(config_dir: &Path) -> Result<AppSettings, String> {
    let path = config_dir.join(SETTINGS_FILE);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AppSettings::default())
        }
        Err(_) => return Err("无法读取应用设置，请检查配置目录权限".into()),
    };
    if bytes.len() > 128 * 1024 {
        return Err("设置文件异常：文件过大".into());
    }
    let settings: AppSettings = serde_json::from_slice(&bytes).map_err(|_| {
        "设置文件格式无效；请修复或移走 settings.json 后重启，原文件未覆盖".to_string()
    })?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    providers::validate_asr(&settings.asr)?;
    providers::validate_llm(&settings.llm)
}

pub fn save_settings(config_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    validate_settings(settings)?;
    fs::create_dir_all(config_dir).map_err(|_| "无法创建应用配置目录".to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| "无法编码应用设置".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(config_dir)
        .map_err(|_| "无法创建设置临时文件".to_string())?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "无法写入应用设置，请检查磁盘空间和目录权限".to_string())?;
    // Same-directory persist replaces the previous file atomically on both
    // Windows and Unix; failed writes never truncate the previous settings.
    temporary
        .persist(config_dir.join(SETTINGS_FILE))
        .map_err(|_| "无法保存应用设置，旧设置仍然保留".to_string())?;
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(config_dir) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialScope {
    account: String,
}

/// Credentials are bound to protocol location as well as their purpose. Changing
/// the endpoint/provider never forwards another service's previously saved key.
pub fn credential_scope(
    kind: &str,
    settings: &AppSettings,
) -> Result<Option<CredentialScope>, String> {
    let (provider, base, route) = match kind {
        "asr" if settings.asr.provider == "local" => return Ok(None),
        "asr" => (
            &settings.asr.provider,
            &settings.asr.base_url,
            "/audio/transcriptions",
        ),
        "llm" if settings.llm.provider == "disabled" => return Ok(None),
        "llm" => (
            &settings.llm.provider,
            &settings.llm.base_url,
            "/chat/completions",
        ),
        _ => return Err("未知密钥用途".into()),
    };
    if !matches!(provider.as_str(), "local" | "cloud") {
        return Err("未知模型服务类型".into());
    }
    let mut url = reqwest::Url::parse(base.trim())
        .map_err(|_| "服务地址无效，请先保存模型配置".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务地址无效，请先保存模型配置".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix(route).unwrap_or(path).to_owned();
    url.set_path(&path);
    let digest = Sha256::digest(format!("{provider}\n{url}"));
    Ok(Some(CredentialScope {
        account: format!("{kind}-{provider}-{digest:x}"),
    }))
}

fn entry(scope: &CredentialScope) -> Result<keyring::Entry, String> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) {
        return Err("当前平台尚未配置系统凭据存储".into());
    }
    keyring::Entry::new(SERVICE, &scope.account).map_err(|_| "无法打开系统凭据存储".into())
}

pub fn get_key(scope: &CredentialScope) -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "系统凭据存储状态异常".to_string())?;
    match entry(scope)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取 API Key，请解锁系统钥匙串或重新保存密钥".into()),
    }
}

pub fn set_key(scope: &CredentialScope, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("API Key 为空、过长或包含无效字符".into());
    }
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "系统凭据存储状态异常".to_string())?;
    entry(scope)?
        .set_password(value)
        .map_err(|_| "无法保存 API Key 到系统凭据存储".into())
}

pub fn delete_key(scope: &CredentialScope) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "系统凭据存储状态异常".to_string())?;
    match entry(scope)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法从系统凭据存储删除 API Key".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_follow_endpoint_and_provider_not_model_name() {
        let mut settings = AppSettings::default();
        settings.llm.provider = "cloud".into();
        settings.llm.base_url = "https://EXAMPLE.com:443/api/v1/".into();
        let original = credential_scope("llm", &settings).unwrap();
        settings.llm.base_url = "https://example.com/api/v1/chat/completions".into();
        settings.llm.model = "different-model".into();
        assert_eq!(credential_scope("llm", &settings).unwrap(), original);
        settings.llm.base_url = "https://other.example/api/v1".into();
        assert_ne!(credential_scope("llm", &settings).unwrap(), original);
        settings.llm.base_url = "http://127.0.0.1:8080/v1".into();
        let cloud_loopback = credential_scope("llm", &settings).unwrap();
        settings.llm.provider = "local".into();
        assert_ne!(credential_scope("llm", &settings).unwrap(), cloud_loopback);
        assert!(credential_scope("asr", &settings).unwrap().is_none());
    }

    #[test]
    fn settings_round_trip_without_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let settings = load_settings(dir.path()).unwrap();
        save_settings(dir.path(), &settings).unwrap();
        let mut next = settings;
        next.auto_insert = false;
        save_settings(dir.path(), &next).unwrap();
        assert!(!load_settings(dir.path()).unwrap().auto_insert);
        let disk = fs::read_to_string(dir.path().join(SETTINGS_FILE)).unwrap();
        assert!(!disk.contains("apiKey"));
        assert!(!disk.contains("password"));
    }

    #[test]
    fn invalid_save_preserves_previous_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = AppSettings::default();
        save_settings(dir.path(), &settings).unwrap();
        let previous = fs::read(dir.path().join(SETTINGS_FILE)).unwrap();
        settings.llm.provider = "local".into();
        settings.llm.base_url = "https://example.com/v1".into();
        settings.llm.model = "test".into();
        assert!(save_settings(dir.path(), &settings).is_err());
        assert_eq!(fs::read(dir.path().join(SETTINGS_FILE)).unwrap(), previous);
    }

    #[test]
    fn malformed_settings_are_not_silently_reset() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), "{broken").unwrap();
        assert!(load_settings(dir.path()).is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join(SETTINGS_FILE)).unwrap(),
            "{broken"
        );
    }
}
