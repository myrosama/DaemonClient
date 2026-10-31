//! The scheduler's running part: one task owns the `State`, runs each started
//! job as its own abortable task and hands results to whoever still waits.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use tokio::sync::{mpsc, oneshot};
use tokio::task::AbortHandle;

use super::bucket::Instant;
use super::state::{Action, JobId, Outcome, State, SubId};
use super::{Class, Kind, Limits};
use crate::CoreError;

/// Downloads one file by its key (a Telegram `file_id`).
pub type Fetch = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Bytes, CoreError>> + Send>> + Send + Sync,
>;

type Answer = Result<Bytes, CoreError>;

enum Msg {
    Read {
        sub: SubId,
        key: String,
        class: Class,
        reply: oneshot::Sender<Answer>,
    },
    Send {
        sub: SubId,
        reply: oneshot::Sender<()>,
    },
    Leave {
        sub: SubId,
    },
    /// The `Scheduler` was dropped (sign-out): stop everything.
    Stop,
    Finished {
        job: JobId,
        attempt: u64,
        answer: Answer,
    },
}

pub struct Scheduler {
    tx: mpsc::UnboundedSender<Msg>,
    next_sub: AtomicU64,
}

/// A wanted file. Dropping it says nobody here waits any more.
pub struct Ticket {
    sub: SubId,
    tx: mpsc::UnboundedSender<Msg>,
    reply: oneshot::Receiver<Answer>,
}

/// The right to send one upload part. Dropping it frees the slot.
pub struct Permit {
    sub: SubId,
    tx: mpsc::UnboundedSender<Msg>,
}

impl Scheduler {
    /// Starts the scheduler on the current tokio runtime.
    pub fn start(limits: Limits, fetch: Fetch) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(
            State::new(limits.clone(), Instant::now()),
            limits,
            fetch,
            rx,
        ));
        Self {
            tx,
            next_sub: AtomicU64::new(1),
        }
    }

    pub fn read(&self, key: String, class: Class) -> Ticket {
        let sub = self.next_sub.fetch_add(1, Ordering::Relaxed);
        let (reply, rx) = oneshot::channel();
        let _ = self.tx.send(Msg::Read {
            sub,
            key,
            class,
            reply,
        });
        Ticket {
            sub,
            tx: self.tx.clone(),
            reply: rx,
        }
    }

    pub async fn send_slot(&self) -> Result<Permit, CoreError> {
        let sub = self.next_sub.fetch_add(1, Ordering::Relaxed);
        let (reply, rx) = oneshot::channel();
        // Made first, so a caller that gives up while waiting also leaves.
        let permit = Permit {
            sub,
            tx: self.tx.clone(),
        };
        let _ = self.tx.send(Msg::Send { sub, reply });
        rx.await.map_err(|_| stopped())?;
        Ok(permit)
    }
}

impl Drop for Scheduler {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
    }
}

impl Ticket {
    pub async fn wait(mut self) -> Answer {
        (&mut self.reply).await.unwrap_or_else(|_| Err(stopped()))
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Leave { sub: self.sub });
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Leave { sub: self.sub });
    }
}

fn stopped() -> CoreError {
    CoreError::Internal("the scheduler stopped".to_owned())
}

/// Sends the job's answer when the job task ends, however it ends: a panic
/// becomes an error instead of a waiter left hanging; an abort's report is
/// ignored (its attempt is no longer the running one).
struct Report {
    job: JobId,
    attempt: u64,
    tx: mpsc::UnboundedSender<Msg>,
    answer: Option<Answer>,
}

impl Report {
    fn finish(mut self, answer: Answer) {
        self.answer = Some(answer);
    }
}

impl Drop for Report {
    fn drop(&mut self) {
        let answer = self
            .answer
            .take()
            .unwrap_or_else(|| Err(CoreError::Internal("a core task stopped".to_owned())));
        let _ = self.tx.send(Msg::Finished {
            job: self.job,
            attempt: self.attempt,
            answer,
        });
    }
}

async fn run(mut state: State, limits: Limits, fetch: Fetch, mut rx: mpsc::UnboundedReceiver<Msg>) {
    // Job reports come on their own channel, so only the `Scheduler` and its
    // tickets and permits keep `rx` open; dropping the `Scheduler` stops it.
    let (done_tx, mut done_rx) = mpsc::unbounded_channel();
    let mut readers: HashMap<SubId, oneshot::Sender<Answer>> = HashMap::new();
    let mut senders: HashMap<String, oneshot::Sender<()>> = HashMap::new();
    let mut running: HashMap<JobId, (u64, AbortHandle)> = HashMap::new();
    let mut attempts = 0u64;
    loop {
        let wake = state.next_wakeup();
        let msg = tokio::select! {
            msg = rx.recv() => match msg {
                Some(msg) => Some(msg),
                None => break,
            },
            Some(done) = done_rx.recv() => Some(done),
            () = tokio::time::sleep_until(wake.unwrap_or_else(Instant::now)), if wake.is_some() => None,
        };
        let now = Instant::now();
        let mut answer = None;
        let actions = match msg {
            None => state.tick(now),
            Some(Msg::Read {
                sub,
                key,
                class,
                reply,
            }) => {
                readers.insert(sub, reply);
                state.subscribe(sub, key, Kind::Read, class, now)
            }
            Some(Msg::Send { sub, reply }) => {
                senders.insert(sub.to_string(), reply);
                state.subscribe(sub, sub.to_string(), Kind::Send, Class::Background, now)
            }
            Some(Msg::Stop) => break,
            Some(Msg::Leave { sub }) => {
                readers.remove(&sub);
                senders.remove(&sub.to_string());
                state.unsubscribe(sub, now)
            }
            Some(Msg::Finished {
                job,
                attempt,
                answer: done,
            }) => {
                if running.get(&job).map(|(a, _)| *a) != Some(attempt) {
                    continue; // from a cancelled run
                }
                running.remove(&job);
                let outcome = match &done {
                    Ok(_) => Outcome::Done,
                    Err(CoreError::RateLimited { retry_after }) => {
                        Outcome::RateLimited(*retry_after)
                    }
                    Err(_) => Outcome::Failed,
                };
                answer = Some(done);
                state.finished(job, outcome, now)
            }
        };
        for action in actions {
            match action {
                Action::Start {
                    key,
                    kind: Kind::Send,
                    ..
                } => {
                    if let Some(reply) = senders.remove(&key) {
                        let _ = reply.send(());
                    }
                }
                Action::Start {
                    job,
                    key,
                    kind: Kind::Read,
                } => {
                    attempts += 1;
                    let report = Report {
                        job,
                        attempt: attempts,
                        tx: done_tx.clone(),
                        answer: None,
                    };
                    let (fetch, timeout) = (fetch.clone(), limits.job_timeout);
                    let task = tokio::spawn(async move {
                        report.finish(match tokio::time::timeout(timeout, fetch(key)).await {
                            Ok(answer) => answer,
                            Err(_) => {
                                Err(CoreError::Network("the storage took too long".to_owned()))
                            }
                        });
                    });
                    running.insert(job, (attempts, task.abort_handle()));
                }
                Action::Cancel { job } => {
                    if let Some((_, task)) = running.remove(&job) {
                        task.abort();
                    }
                }
                Action::Finish { subs, .. } => {
                    for sub in subs {
                        if let (Some(reply), Some(answer)) = (readers.remove(&sub), &answer) {
                            let _ = reply.send(answer.clone());
                        }
                    }
                }
            }
        }
    }
    // Waiters still holding tickets get "stopped"; nothing keeps fetching.
    for (_, task) in running.values() {
        task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn counting(
        answer: impl Fn(String, usize) -> Pin<Box<dyn Future<Output = Result<Bytes, CoreError>> + Send>>
        + Send
        + Sync
        + 'static,
    ) -> (Fetch, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let fetch: Fetch =
            Arc::new(move |key| answer(key, counter.fetch_add(1, Ordering::SeqCst) + 1));
        (fetch, calls)
    }

    #[tokio::test(start_paused = true)]
    async fn two_requests_for_one_file_make_one_fetch_and_errors_reach_both() {
        let (fetch, calls) = counting(|key, _| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                if key == "bad" {
                    Err(CoreError::NotFound)
                } else {
                    Ok(Bytes::from(key))
                }
            })
        });
        let scheduler = Scheduler::start(Limits::default(), fetch);
        let (a, b) = (
            scheduler.read("f".into(), Class::Visible),
            scheduler.read("f".into(), Class::Opened),
        );
        let (a, b) = tokio::join!(a.wait(), b.wait());
        assert_eq!(
            (a.unwrap(), b.unwrap()),
            (Bytes::from("f"), Bytes::from("f"))
        );
        let (a, b) = (
            scheduler.read("bad".into(), Class::Visible),
            scheduler.read("bad".into(), Class::Visible),
        );
        let (a, b) = tokio::join!(a.wait(), b.wait());
        assert!(matches!(
            (a, b),
            (Err(CoreError::NotFound), Err(CoreError::NotFound))
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_the_last_ticket_aborts_the_fetch() {
        struct Flag(Arc<AtomicUsize>);
        impl Drop for Flag {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicUsize::new(0));
        let seen = dropped.clone();
        let (fetch, _) = counting(move |_, _| {
            let flag = Flag(seen.clone());
            Box::pin(async move {
                let _flag = flag;
                std::future::pending::<()>().await;
                Ok(Bytes::new())
            })
        });
        let scheduler = Scheduler::start(Limits::default(), fetch);
        let ticket = scheduler.read("f".into(), Class::Visible);
        tokio::time::sleep(Duration::from_millis(1)).await;
        drop(ticket);
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert_eq!(
            dropped.load(Ordering::SeqCst),
            1,
            "the fetch was not stopped"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_fetch_fails_after_the_job_timeout() {
        let (fetch, _) = counting(|_, _| Box::pin(async { std::future::pending().await }));
        let limits = Limits {
            job_timeout: Duration::from_secs(5),
            ..Limits::default()
        };
        let scheduler = Scheduler::start(limits, fetch);
        let started = tokio::time::Instant::now();
        let result = scheduler.read("f".into(), Class::Visible).wait().await;
        assert!(matches!(result, Err(CoreError::Network(_))), "{result:?}");
        assert_eq!(started.elapsed(), Duration::from_secs(5));
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limited_read_is_tried_again_after_the_pause() {
        let (fetch, calls) = counting(|_, call| {
            Box::pin(async move {
                if call == 1 {
                    Err(CoreError::RateLimited { retry_after: 3 })
                } else {
                    Ok(Bytes::from("ok"))
                }
            })
        });
        let scheduler = Scheduler::start(Limits::default(), fetch);
        let started = tokio::time::Instant::now();
        assert_eq!(
            scheduler
                .read("f".into(), Class::Visible)
                .wait()
                .await
                .unwrap(),
            Bytes::from("ok")
        );
        assert!(started.elapsed() >= Duration::from_secs(3));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn one_upload_part_at_a_time() {
        let (fetch, _) = counting(|_, _| Box::pin(async { Ok(Bytes::new()) }));
        let scheduler = Scheduler::start(Limits::default(), fetch);
        let first = scheduler.send_slot().await.unwrap();
        let second = scheduler.send_slot();
        tokio::pin!(second);
        assert!(
            tokio::time::timeout(Duration::from_secs(60), &mut second)
                .await
                .is_err(),
            "two at once"
        );
        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), second)
                .await
                .is_ok()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_panicking_fetch_is_an_error_and_dropping_the_scheduler_stops_everything() {
        let (fetch, calls) = counting(|key, _| {
            Box::pin(async move {
                if key == "boom" {
                    panic!("a fetch panicked");
                }
                std::future::pending().await
            })
        });
        let scheduler = Scheduler::start(Limits::default(), fetch);
        let result = scheduler.read("boom".into(), Class::Visible).wait().await;
        assert!(matches!(result, Err(CoreError::Internal(_))), "{result:?}");
        let waiting = scheduler.read("slow".into(), Class::Visible);
        tokio::time::sleep(Duration::from_millis(1)).await;
        drop(scheduler); // signing out
        let result = waiting.wait().await;
        assert!(matches!(result, Err(CoreError::Internal(_))), "{result:?}");
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert_eq!(
            Arc::strong_count(&calls),
            1,
            "the scheduler task is still running"
        );
    }
}
