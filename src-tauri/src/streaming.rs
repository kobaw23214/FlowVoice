//! Incremental SenseVoice decoding alongside bounded microphone capture.
//! Partial text is revisable; pause-delimited segments are stable.

use crate::{providers, types::AsrSettings};
use std::sync::mpsc::{Receiver, SyncSender};

pub(crate) enum Chunk {
    Audio(Vec<f32>),
    Finish(Vec<f32>),
}

pub(crate) fn bounded_channel() -> (SyncSender<Chunk>, Receiver<Chunk>) {
    // Bound queued audio to roughly 30 seconds of 100 ms microphone chunks.
    // The full recording remains in the audio buffer even if ASR falls behind.
    std::sync::mpsc::sync_channel(300)
}

pub(crate) fn block_on_cloud(
    settings: &AsrSettings,
    samples: &[f32],
    sample_rate: u32,
) -> Result<String, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "无法启动语音识别任务".to_string())?;
    runtime.block_on(providers::transcribe(
        settings,
        samples.to_vec(),
        sample_rate,
        None,
    ))
}

#[derive(Default)]
struct PendingSpeech {
    samples: Vec<f32>,
    pending: Vec<f32>,
    prefix: Vec<f32>,
    silence_ms: u64,
    sample_rate: u32,
    next_partial: usize,
}

impl PendingSpeech {
    fn append(&mut self, audio: Vec<f32>, sample_rate: u32) {
        self.sample_rate = sample_rate;
        // One 100 ms RMS value is deliberately cheap and adaptive. This is a
        // segmenter, not a replacement for a speech-trained endpoint detector.
        let rms = (audio.iter().map(|x| x * x).sum::<f32>() / audio.len().max(1) as f32).sqrt();
        let speech = rms >= 0.005;
        if speech {
            if !self.pending.is_empty() {
                self.samples.append(&mut self.pending);
            }
            self.samples.extend(audio);
            self.silence_ms = 0;
        } else {
            self.pending.extend(audio);
            if !self.samples.is_empty() {
                self.silence_ms += 100;
            }
        }
    }

    fn stable(&mut self) -> Option<(Vec<f32>, u32)> {
        let duration = self.samples.len() as u64 * 1000 / self.sample_rate.max(1) as u64;
        if self.silence_ms >= 600 && duration >= 650 || duration >= 10_000 && self.silence_ms >= 100
        {
            Some((self.take(), self.sample_rate))
        } else {
            None
        }
    }

    fn take(&mut self) -> Vec<f32> {
        self.silence_ms = 0;
        self.next_partial = 0;
        let mut samples = std::mem::take(&mut self.prefix);
        samples.append(&mut self.samples);
        samples.append(&mut self.pending);
        let overlap = (self.sample_rate as usize / 4).min(samples.len());
        self.prefix = samples[samples.len() - overlap..].to_vec();
        samples
    }

    fn partial_due(&self) -> bool {
        !self.samples.is_empty()
            && self.silence_ms == 0
            && self.samples.len() >= self.next_partial.max(self.sample_rate as usize * 7 / 10)
    }
}

pub(crate) fn run_local(
    receiver: Receiver<Chunk>,
    settings: AsrSettings,
    sample_rate: u32,
    mut partial: impl FnMut(String),
    mut stable: impl FnMut(String),
) {
    let mut speech = PendingSpeech::default();
    while let Ok(chunk) = receiver.recv() {
        let (audio, finished) = match chunk {
            Chunk::Audio(audio) => (audio, false),
            Chunk::Finish(audio) => (audio, true),
        };
        if audio.is_empty() && !finished {
            continue;
        }
        let mut offset = 0;
        while offset < audio.len() {
            let count = (sample_rate as usize / 10).min(audio.len() - offset);
            speech.append(audio[offset..offset + count].to_vec(), sample_rate);
            offset += count;
            if let Some((samples, rate)) = speech.stable() {
                if let Ok(text) = providers::transcribe_samples(&settings, &samples, rate) {
                    if !text.trim().is_empty() {
                        stable(text);
                    }
                }
            }
        }
        if finished {
            let remaining = speech.take();
            if remaining.len() >= sample_rate as usize / 3 {
                if let Ok(text) = providers::transcribe_samples(&settings, &remaining, sample_rate)
                {
                    if !text.trim().is_empty() {
                        stable(text);
                    }
                }
            }
            break;
        }
        if speech.partial_due() {
            speech.next_partial = speech.samples.len() + sample_rate as usize * 8 / 10;
            let mut samples = speech.prefix.clone();
            samples.extend_from_slice(&speech.samples);
            if let Ok(text) = providers::transcribe_samples(&settings, &samples, sample_rate) {
                if !text.trim().is_empty() {
                    partial(text);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(rate: u32, loud: bool) -> Vec<f32> {
        vec![if loud { 0.08 } else { 0.0 }; rate as usize / 10]
    }

    #[test]
    fn pauses_commit_without_creating_new_entries() {
        let mut speech = PendingSpeech::default();
        for _ in 0..12 {
            speech.append(chunk(16_000, true), 16_000);
        }
        assert!(speech.stable().is_none());
        for _ in 0..6 {
            speech.append(chunk(16_000, false), 16_000);
        }
        let (samples, _) = speech.stable().unwrap();
        assert!(samples.len() >= 16_000);
        assert!(speech.samples.is_empty());
        assert!(!speech.prefix.is_empty());
    }

    #[test]
    fn final_short_utterance_is_not_lost() {
        let mut speech = PendingSpeech::default();
        for _ in 0..4 {
            speech.append(chunk(16_000, true), 16_000);
        }
        assert!(speech.stable().is_none());
        assert_eq!(speech.take().len(), 6_400);
    }

    #[test]
    #[ignore = "requires explicit local SenseVoice model and WAV paths"]
    fn real_audio_emits_incremental_results() {
        let model_dir = std::env::var("FLOWVOICE_TEST_MODEL_DIR").unwrap();
        let wav = std::env::var("FLOWVOICE_TEST_WAV").unwrap();
        let mut reader = hound::WavReader::open(wav).unwrap();
        let sample_rate = reader.spec().sample_rate;
        let samples = reader
            .samples::<i16>()
            .map(|sample| sample.unwrap() as f32 / 32768.0)
            .collect::<Vec<_>>();
        let (sender, receiver) = std::sync::mpsc::channel();
        for chunk in samples.chunks(sample_rate as usize / 10) {
            sender.send(Chunk::Audio(chunk.to_vec())).unwrap();
        }
        sender.send(Chunk::Finish(Vec::new())).unwrap();
        drop(sender);
        let settings = AsrSettings {
            provider: "local".into(),
            model_dir,
            base_url: String::new(),
            model: String::new(),
        };
        let mut stable_count = 0;
        run_local(
            receiver,
            settings,
            sample_rate,
            |text| println!("partial: {text}"),
            |text| {
                stable_count += 1;
                println!("stable: {text}");
                assert!(!text.is_empty());
            },
        );
        assert!(stable_count > 0);
    }
}
