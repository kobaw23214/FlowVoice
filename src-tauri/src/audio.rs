//! Bounded in-memory microphone capture. The CPAL stream stays on its owning thread.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc::{self, Receiver, Sender},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const MAX_RECORDING_SECONDS: u64 = 120;

#[derive(Debug)]
pub struct RecordedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub duration_ms: u64,
    pub limit_reached: bool,
}

enum Command {
    Stop,
    Cancel,
}

pub struct Recorder {
    command: Sender<Command>,
    worker: Option<JoinHandle<Result<RecordedAudio, String>>>,
}

pub fn microphone_sample_rate() -> Result<u32, String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("没有找到可用麦克风。请连接输入设备并检查系统声音设置。")?;
    let config = device
        .default_input_config()
        .map_err(|error| format!("无法读取麦克风配置：{error}"))?;
    let sample_rate = config.sample_rate().0;
    (sample_rate > 0)
        .then_some(sample_rate)
        .ok_or_else(|| "麦克风采样率无效".into())
}

impl Recorder {
    /// Call outside the UI thread: opening an input device may show a system permission prompt.
    pub fn start(
        on_level: impl Fn(f32) + Send + Sync + 'static,
        on_audio: impl Fn(Vec<f32>) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let (command, commands) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("flowvoice-microphone".into())
            .spawn(move || {
                let result = record(commands, &ready_tx, on_level, on_audio);
                if let Err(error) = &result {
                    let _ = ready_tx.try_send(Err(error.clone()));
                }
                result
            })
            .map_err(|error| format!("无法启动录音线程：{error}"))?;
        match ready_rx.recv_timeout(Duration::from_secs(30)) {
            Ok(Ok(())) => Ok(Self {
                command,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(_) => {
                // A pending OS permission prompt can outlive this call. Once it resolves,
                // the disconnected ready receiver makes the worker drop its stream.
                let _ = command.send(Command::Cancel);
                Err("打开麦克风超时。请在系统设置中允许麦克风访问后重试。".into())
            }
        }
    }

    pub fn stop(mut self) -> Result<RecordedAudio, String> {
        let _ = self.command.send(Command::Stop);
        self.worker
            .take()
            .ok_or("录音已经结束")?
            .join()
            .map_err(|_| "录音线程异常退出".to_string())?
    }

    pub fn cancel(mut self) {
        let _ = self.command.send(Command::Cancel);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.command.send(Command::Cancel);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct RecordingBuffer {
    samples: Vec<f32>,
    max_samples: usize,
}

impl RecordingBuffer {
    fn append<T: Copy>(&mut self, input: &[T], channels: usize, normalize: fn(T) -> f32) -> f32 {
        if channels == 0 {
            return 0.0;
        }
        let mut square_sum = 0.0;
        let mut count = 0;
        for frame in input.chunks_exact(channels) {
            if self.samples.len() == self.max_samples {
                break;
            }
            let sample = frame
                .iter()
                .map(|&value| {
                    let value = normalize(value);
                    if value.is_finite() {
                        value.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    }
                })
                .sum::<f32>()
                / channels as f32;
            self.samples.push(sample);
            square_sum += sample * sample;
            count += 1;
        }
        if count == 0 {
            0.0
        } else {
            (square_sum / count as f32).sqrt()
        }
    }
}

fn normalize_f32(sample: f32) -> f32 {
    sample
}
fn normalize_i16(sample: i16) -> f32 {
    sample as f32 / 32768.0
}
fn normalize_u16(sample: u16) -> f32 {
    (sample as f32 - 32768.0) / 32768.0
}

fn build_stream<T: cpal::SizedSample + Copy + 'static>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    buffer: Arc<Mutex<RecordingBuffer>>,
    level: Arc<AtomicU32>,
    full: Arc<AtomicBool>,
    errors: mpsc::SyncSender<String>,
    normalize: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    let channels = config.channels as usize;
    device
        .build_input_stream(
            config,
            move |input: &[T], _| {
                // No allocation, UI dispatch, inference or disk writes on the realtime callback.
                // The worker only reads this mutex after dropping the stream.
                if let Ok(mut recording) = buffer.try_lock() {
                    let rms = recording.append(input, channels, normalize);
                    level.store(rms.to_bits(), Ordering::Relaxed);
                    if recording.samples.len() == recording.max_samples {
                        full.store(true, Ordering::Release);
                    }
                }
            },
            move |error| {
                let _ = errors.try_send(format!("麦克风连接中断：{error}"));
            },
            None,
        )
        .map_err(|error| format!("无法打开麦克风，请检查麦克风权限和设备状态：{error}"))
}

fn record(
    commands: Receiver<Command>,
    ready: &mpsc::SyncSender<Result<(), String>>,
    on_level: impl Fn(f32),
    on_audio: impl Fn(Vec<f32>),
) -> Result<RecordedAudio, String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or("没有找到可用麦克风。请连接输入设备并检查系统声音设置。")?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("无法读取麦克风配置：{error}"))?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let sample_rate = config.sample_rate.0;
    if config.channels == 0 || sample_rate == 0 || sample_rate > 192_000 {
        return Err("不支持当前麦克风配置，请使用采样率不超过 192 kHz 的输入设备。".into());
    }
    let max_samples = sample_rate as usize * MAX_RECORDING_SECONDS as usize;
    let mut samples = Vec::new();
    samples
        .try_reserve_exact(max_samples)
        .map_err(|_| "没有足够内存开始录音，请关闭部分应用后重试。")?;
    let buffer = Arc::new(Mutex::new(RecordingBuffer {
        samples,
        max_samples,
    }));
    let level = Arc::new(AtomicU32::new(0));
    let full = Arc::new(AtomicBool::new(false));
    let (errors_tx, errors_rx) = mpsc::sync_channel(1);
    let stream = match format {
        cpal::SampleFormat::F32 => build_stream(
            &device,
            &config,
            buffer.clone(),
            level.clone(),
            full.clone(),
            errors_tx,
            normalize_f32,
        ),
        cpal::SampleFormat::I16 => build_stream(
            &device,
            &config,
            buffer.clone(),
            level.clone(),
            full.clone(),
            errors_tx,
            normalize_i16,
        ),
        cpal::SampleFormat::U16 => build_stream(
            &device,
            &config,
            buffer.clone(),
            level.clone(),
            full.clone(),
            errors_tx,
            normalize_u16,
        ),
        other => {
            return Err(format!(
                "暂不支持麦克风采样格式 {other}，请更换系统默认输入设备。"
            ))
        }
    }?;
    stream
        .play()
        .map_err(|error| format!("无法开始录音：{error}"))?;
    if ready.send(Ok(())).is_err() {
        return Err("录音已取消".into());
    }
    let started = Instant::now();
    let mut delivered = 0;
    let limit_reached;
    loop {
        if let Ok(error) = errors_rx.try_recv() {
            return Err(error);
        }
        if full.load(Ordering::Acquire) || started.elapsed().as_secs() >= MAX_RECORDING_SECONDS {
            limit_reached = true;
            break;
        }
        match commands.recv_timeout(Duration::from_millis(50)) {
            Ok(Command::Stop) => {
                limit_reached = false;
                break;
            }
            Ok(Command::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("录音已取消".into())
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                on_level(f32::from_bits(level.load(Ordering::Relaxed)))
            }
        }
        let samples = buffer.lock().map_err(|_| "录音缓冲区不可用")?;
        // The microphone callback never waits for ASR. Copy at 100 ms cadence;
        // if the callback briefly owns the buffer, the next pass includes it.
        if samples.samples.len() >= delivered + sample_rate as usize / 10 {
            let audio = samples.samples[delivered..].to_vec();
            delivered = samples.samples.len();
            drop(samples);
            on_audio(audio);
        }
    }
    drop(stream);
    if let Ok(error) = errors_rx.try_recv() {
        return Err(error);
    }
    if let Ok(samples) = buffer.lock() {
        if samples.samples.len() > delivered {
            on_audio(samples.samples[delivered..].to_vec());
        }
    }
    let mut recording = buffer.lock().map_err(|_| "录音缓冲区不可用")?;
    let samples = std::mem::take(&mut recording.samples);
    if samples.is_empty() {
        return Err("没有采集到音频，请检查麦克风权限后重新录音。".into());
    }
    Ok(RecordedAudio {
        duration_ms: samples.len() as u64 * 1000 / sample_rate as u64,
        samples,
        sample_rate,
        limit_reached,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsigned_silence_and_signed_endpoints_are_normalized() {
        assert_eq!(normalize_u16(32768), 0.0);
        assert_eq!(normalize_u16(0), -1.0);
        assert_eq!(normalize_i16(i16::MIN), -1.0);
        assert!(normalize_i16(i16::MAX) < 1.0);
    }

    #[test]
    fn stereo_is_downmixed_and_recording_is_bounded() {
        let mut buffer = RecordingBuffer {
            samples: Vec::with_capacity(2),
            max_samples: 2,
        };
        let level = buffer.append(&[1.0, -1.0, 0.5, 0.5, 1.0, 1.0], 2, normalize_f32);
        assert_eq!(buffer.samples, vec![0.0, 0.5]);
        assert!((level - 0.35355338).abs() < 0.00001);
        buffer.append(&[1.0, 1.0], 2, normalize_f32);
        assert_eq!(buffer.samples.len(), 2);
    }

    #[test]
    fn invalid_samples_do_not_poison_audio_or_meter() {
        let mut buffer = RecordingBuffer {
            samples: Vec::with_capacity(3),
            max_samples: 3,
        };
        let level = buffer.append(&[f32::NAN, f32::INFINITY, 2.0], 1, normalize_f32);
        assert_eq!(buffer.samples, vec![0.0, 0.0, 1.0]);
        assert!(level.is_finite());
    }
}
