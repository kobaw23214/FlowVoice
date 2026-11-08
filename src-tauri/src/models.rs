use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BASE: &str = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07";
const FILES: &[(&str, u64, &str)] = &[
    (
        "model.int8.onnx",
        239_233_841,
        "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    ),
    (
        "tokens.txt",
        315_894,
        "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
    ),
    (
        "LICENSE",
        71,
        "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17",
    ),
];

#[derive(Clone, Serialize)]
pub struct ModelProgress {
    pub downloaded: u64,
    pub total: u64,
    pub status: String,
}

async fn verify(path: &Path, size: u64, digest: &str) -> bool {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return false;
    };
    if file.metadata().await.map(|m| m.len()).unwrap_or(0) != size {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => hash.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hash.finalize()) == digest
}

pub async fn download(app: &AppHandle, dir: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|_| "无法创建模型目录".to_string())?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(1200))
        .build()
        .map_err(|_| "无法创建下载连接".to_string())?;
    let total = FILES.iter().map(|f| f.1).sum();
    let mut done = 0;
    for &(name, size, digest) in FILES {
        let target = dir.join(name);
        if verify(&target, size, digest).await {
            done += size;
            let _ = app.emit(
                "flowvoice://model-progress",
                ModelProgress {
                    downloaded: done,
                    total,
                    status: format!("已校验 {name}"),
                },
            );
            continue;
        }
        // Unique temp files and atomic rename never expose a partially downloaded model.
        let temporary =
            tempfile::NamedTempFile::new_in(dir).map_err(|_| "无法写入模型目录".to_string())?;
        let mut file = tokio::fs::File::from_std(
            temporary
                .reopen()
                .map_err(|_| "无法写入模型文件".to_string())?,
        );
        let response = client
            .get(format!("{BASE}/{name}"))
            .send()
            .await
            .map_err(|_| "模型下载失败，请检查网络后重试".to_string())?
            .error_for_status()
            .map_err(|_| "模型服务暂不可用，请稍后重试".to_string())?;
        let mut stream = response.bytes_stream();
        let mut hash = Sha256::new();
        let mut received = 0;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "模型下载中断，请重试".to_string())?;
            received += chunk.len() as u64;
            if received > size {
                return Err("模型大小与固定版本不匹配，已停止下载".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|_| "模型写入失败，请检查磁盘空间".to_string())?;
            hash.update(&chunk);
            if last_emit.elapsed() > Duration::from_millis(150) {
                let _ = app.emit(
                    "flowvoice://model-progress",
                    ModelProgress {
                        downloaded: done + received,
                        total,
                        status: format!("正在下载 {name}"),
                    },
                );
                last_emit = Instant::now();
            }
        }
        if received != size || format!("{:x}", hash.finalize()) != digest {
            return Err("模型完整性校验失败，请重新下载".into());
        }
        file.flush().await.map_err(|_| "模型保存失败".to_string())?;
        file.sync_all()
            .await
            .map_err(|_| "模型保存失败".to_string())?;
        drop(file);
        temporary
            .persist(&target)
            .map_err(|_| "无法完成模型保存".to_string())?;
        done += size;
    }
    let _ = app.emit(
        "flowvoice://model-progress",
        ModelProgress {
            downloaded: total,
            total,
            status: "下载完成，已通过 SHA-256 校验".into(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_corrupted_or_truncated_existing_download() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("model");
            let original = b"verified model bytes";
            let digest = format!("{:x}", Sha256::digest(original));
            assert!(!verify(&path, original.len() as u64, &digest).await);
            std::fs::write(&path, original).unwrap();
            assert!(verify(&path, original.len() as u64, &digest).await);
            let mut corrupted = original.to_vec();
            corrupted[0] ^= 1;
            std::fs::write(&path, &corrupted).unwrap();
            assert!(!verify(&path, original.len() as u64, &digest).await);
            std::fs::write(&path, &original[..5]).unwrap();
            assert!(!verify(&path, original.len() as u64, &digest).await);
        });
    }
}
