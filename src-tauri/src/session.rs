//! Cancellation is shared by every asynchronous stage of a single task.
//!
//! Dropping an HTTP future stops local waiting/network work. A blocking native
//! inference or OS credential call already in progress may still finish; its
//! result is discarded and cannot start the next stage.

use std::future::Future;
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct Cancellation {
    signal: watch::Sender<bool>,
}

impl Cancellation {
    pub(crate) fn new() -> Self {
        let (signal, _) = watch::channel(false);
        Self { signal }
    }

    pub(crate) fn cancel(&self) {
        // send_replace retains the flag even between stage subscriptions.
        self.signal.send_replace(true);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        *self.signal.borrow()
    }

    pub(crate) async fn run<F: Future>(&self, work: F) -> Option<F::Output> {
        let mut receiver = self.signal.subscribe();
        if *receiver.borrow() {
            return None;
        }
        let cancelled = async move {
            loop {
                if *receiver.borrow() {
                    return;
                }
                if receiver.changed().await.is_err() {
                    return;
                }
            }
        };
        futures_util::pin_mut!(cancelled, work);
        // select polls its first argument first: cancellation wins when both
        // branches are ready, before a not-yet-started next stage is polled.
        match futures_util::future::select(cancelled, work).await {
            futures_util::future::Either::Left(_) => None,
            futures_util::future::Either::Right((value, _)) => {
                (!self.is_cancelled()).then_some(value)
            }
        }
    }
}

pub(crate) fn accepts_result(current_id: u64, phase: &str, result_id: u64) -> bool {
    current_id == result_id && phase != "cancelled"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn cancelled_before_stage_does_not_poll_network_work() {
        runtime().block_on(async {
            let cancellation = Cancellation::new();
            cancellation.cancel();
            let polled = AtomicBool::new(false);
            assert!(cancellation
                .run(async {
                    polled.store(true, Ordering::SeqCst);
                })
                .await
                .is_none());
            assert!(!polled.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn cancel_during_credentials_prevents_next_request() {
        runtime().block_on(async {
            let cancellation = Cancellation::new();
            let task_cancellation = cancellation.clone();
            let requests = Arc::new(AtomicUsize::new(0));
            let task_requests = requests.clone();
            let (ready, credential) = tokio::sync::oneshot::channel::<()>();
            let task = tokio::spawn(async move {
                task_cancellation.run(credential).await?.ok()?;
                task_cancellation
                    .run(async {
                        task_requests.fetch_add(1, Ordering::SeqCst);
                    })
                    .await
            });
            tokio::task::yield_now().await;
            cancellation.cancel();
            let _ = ready.send(());
            assert!(task.await.unwrap().is_none());
            assert_eq!(requests.load(Ordering::SeqCst), 0);
        });
    }

    #[test]
    fn cancel_drops_inflight_future_and_rejects_late_result() {
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        runtime().block_on(async {
            let cancellation = Cancellation::new();
            let task_cancellation = cancellation.clone();
            let dropped = Arc::new(AtomicBool::new(false));
            let flag = DropFlag(dropped.clone());
            let (started, pending) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                task_cancellation
                    .run(async move {
                        let _flag = flag;
                        let _ = started.send(());
                        std::future::pending::<()>().await;
                    })
                    .await
            });
            pending.await.unwrap();
            cancellation.cancel();
            assert!(task.await.unwrap().is_none());
            assert!(dropped.load(Ordering::SeqCst));
            assert!(!accepts_result(3, "recording", 1));
            assert!(!accepts_result(1, "cancelled", 1));
            assert!(accepts_result(1, "generating", 1));
        });
    }
}
