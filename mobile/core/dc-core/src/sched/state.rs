//! The scheduler's decisions, without I/O: it is told what was asked for,
//! what left, what finished and what time it is, and answers with what to
//! start, cancel or deliver. Nuke's rules (RESEARCH §9b) and ours (SPEC §4.9);
//! the tests below are the specification.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use super::bucket::{Instant, TokenBucket};
use super::{Class, Kind, Limits};

pub type JobId = u64;
pub type SubId = u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Start {
        job: JobId,
        key: String,
        kind: Kind,
    },
    /// Stop a running job: nobody waits for it any more, or it was pre-empted.
    Cancel {
        job: JobId,
    },
    /// Deliver the job's result (or error) to these subscribers.
    Finish {
        job: JobId,
        subs: Vec<SubId>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Failed,
    /// Telegram said wait this many seconds: the job is queued again, first.
    RateLimited(u64),
}

/// The longest pause a rate limit can cause (Task 1.3's cap).
const MAX_PAUSE: Duration = Duration::from_secs(24 * 60 * 60);
/// A job rate limited this often fails with it instead of trying forever.
const RATE_LIMITS_BEFORE_GIVING_UP: u8 = 3;

struct Job {
    key: String,
    kind: Kind,
    subs: BTreeMap<SubId, Class>,
    seq: u64,
    /// Queued again after a pre-emption or a rate limit: goes first in its class.
    front: bool,
    /// The class it started in while it runs; its slot is counted by it.
    running: Option<Class>,
    rate_limits: u8,
}

impl Job {
    /// The highest class among the job's subscribers.
    fn class(&self) -> Class {
        self.subs
            .values()
            .copied()
            .max()
            .unwrap_or(Class::Background)
    }
}

pub struct State {
    limits: Limits,
    bucket: TokenBucket,
    reads_paused_until: Option<Instant>,
    now: Instant,
    next_job: JobId,
    next_seq: u64,
    jobs: HashMap<JobId, Job>,
    reads: HashMap<String, JobId>,
    subs: HashMap<SubId, JobId>,
}

impl State {
    pub fn new(limits: Limits, now: Instant) -> Self {
        let bucket = TokenBucket::new(limits.reads_per_sec, limits.read_burst, now);
        Self {
            limits,
            bucket,
            reads_paused_until: None,
            now,
            next_job: 0,
            next_seq: 0,
            jobs: HashMap::new(),
            reads: HashMap::new(),
            subs: HashMap::new(),
        }
    }

    /// Someone wants `key`. Reads for the same key share one job.
    pub fn subscribe(
        &mut self,
        sub: SubId,
        key: String,
        kind: Kind,
        class: Class,
        now: Instant,
    ) -> Vec<Action> {
        self.now = now;
        self.next_seq += 1;
        let seq = self.next_seq;
        let shared = if kind == Kind::Read {
            self.reads.get(&key).copied()
        } else {
            None
        };
        let job_id = match shared.and_then(|id| self.jobs.get_mut(&id).map(|job| (id, job))) {
            Some((id, job)) => {
                job.subs.insert(sub, class);
                // On screen, the newest request goes first.
                if job.running.is_none() && class == Class::Visible && job.class() == Class::Visible
                {
                    job.seq = seq;
                }
                id
            }
            None => {
                let id = self.next_job;
                self.next_job += 1;
                if kind == Kind::Read {
                    self.reads.insert(key.clone(), id);
                }
                let subs = BTreeMap::from([(sub, class)]);
                self.jobs.insert(
                    id,
                    Job {
                        key,
                        kind,
                        subs,
                        seq,
                        front: false,
                        running: None,
                        rate_limits: 0,
                    },
                );
                id
            }
        };
        self.subs.insert(sub, job_id);
        self.fill()
    }

    /// `sub` no longer waits. The last one leaving drops the job: a queued job
    /// never runs (and spends no token), a running one is cancelled.
    pub fn unsubscribe(&mut self, sub: SubId, now: Instant) -> Vec<Action> {
        self.now = now;
        let mut actions = vec![];
        if let Some(job_id) = self.subs.remove(&sub)
            && let Some(job) = self.jobs.get_mut(&job_id)
        {
            job.subs.remove(&sub);
            if job.subs.is_empty() {
                if job.running.is_some() {
                    actions.push(Action::Cancel { job: job_id });
                }
                self.remove(job_id);
            }
        }
        actions.extend(self.fill());
        actions
    }

    pub fn finished(&mut self, job_id: JobId, outcome: Outcome, now: Instant) -> Vec<Action> {
        self.now = now;
        let mut actions = vec![];
        if let Some(job) = self
            .jobs
            .get_mut(&job_id)
            .filter(|job| job.running.is_some())
        {
            match outcome {
                Outcome::Done | Outcome::Failed => {
                    let subs = job.subs.keys().copied().collect();
                    self.remove(job_id);
                    actions.push(Action::Finish { job: job_id, subs });
                }
                Outcome::RateLimited(secs) => {
                    // At least a second, so a `retry_after: 0` cannot spin.
                    let wait = Duration::from_secs(secs.max(1)).min(MAX_PAUSE);
                    self.reads_paused_until = self.reads_paused_until.max(now.checked_add(wait));
                    job.running = None;
                    job.front = true;
                    job.rate_limits += 1;
                    if job.rate_limits >= RATE_LIMITS_BEFORE_GIVING_UP {
                        let subs = job.subs.keys().copied().collect();
                        self.remove(job_id);
                        actions.push(Action::Finish { job: job_id, subs });
                    }
                }
            }
        }
        actions.extend(self.fill());
        actions
    }

    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        self.now = now;
        self.fill()
    }

    /// When to call `tick` again: the end of a rate-limit pause, or the next
    /// token for a queued read. `None` when nothing waits on time.
    pub fn next_wakeup(&mut self) -> Option<Instant> {
        let now = self.now;
        if !self
            .jobs
            .values()
            .any(|j| j.running.is_none() && j.kind == Kind::Read)
        {
            return None;
        }
        if let Some(until) = self.reads_paused_until.filter(|until| *until > now) {
            return Some(until);
        }
        let wait = self.bucket.wait(now);
        (!wait.is_zero()).then(|| now + wait)
    }

    #[cfg(test)]
    fn is_running(&self, job: JobId) -> bool {
        self.jobs.get(&job).is_some_and(|j| j.running.is_some())
    }

    /// D17: while an opened item runs or is about to, nothing below it starts.
    /// One waiting out a rate-limit pause holds nothing up.
    fn suspended(&self, reads_paused: bool) -> bool {
        self.jobs
            .values()
            .any(|j| j.class() == Class::Opened && (j.running.is_some() || !reads_paused))
    }

    fn remove(&mut self, job_id: JobId) {
        if let Some(job) = self.jobs.remove(&job_id) {
            if job.kind == Kind::Read && self.reads.get(&job.key) == Some(&job_id) {
                self.reads.remove(&job.key);
            }
            for sub in job.subs.keys() {
                self.subs.remove(sub);
            }
        }
    }

    /// Starts everything the rules allow, best first.
    fn fill(&mut self) -> Vec<Action> {
        let now = self.now;
        let mut actions = vec![];
        let reads_paused = self.reads_paused_until.is_some_and(|until| until > now);
        // D17: an opened item pre-empts background reads (prefetch); thumbnails
        // and upload parts already running finish.
        if self.suspended(reads_paused) {
            for (id, job) in self.jobs.iter_mut() {
                if job.running.is_some()
                    && job.kind == Kind::Read
                    && job.class() == Class::Background
                {
                    job.running = None;
                    job.front = true;
                    actions.push(Action::Cancel { job: *id });
                }
            }
        }
        // shortcut: every event scans all jobs, O(n); fine for screens of
        // thumbnails — use an ordered index if prefetch queues thousands (1.8).
        loop {
            let suspended = self.suspended(reads_paused);
            let has_token = self.bucket.wait(now).is_zero();
            let (mut total, mut next, mut background, mut sending) = (0, 0, 0, 0);
            for job in self.jobs.values() {
                let Some(started) = job.running else { continue };
                total += 1;
                match started {
                    Class::Next => next += 1,
                    Class::Background => background += 1,
                    _ => {}
                }
                if job.kind == Kind::Send {
                    sending += 1;
                }
            }
            let limits = &self.limits;
            let eligible = |job: &Job| {
                let class = job.class();
                !(suspended && class < Class::Opened)
                    && !(job.kind == Kind::Read && reads_paused)
                    && total < limits.max_running
                    && !(class < Class::Opened
                        && total >= limits.max_running.saturating_sub(limits.reserved_high))
                    && !(class == Class::Next && next >= limits.max_next)
                    && !(class == Class::Background && background >= limits.max_background)
                    && !(job.kind == Kind::Send && sending >= limits.max_sending)
                    && !(job.kind == Kind::Read && class != Class::Opened && !has_token)
            };
            // Best first: class, then re-queued work, then newest on screen /
            // oldest elsewhere.
            let order = |job: &Job| {
                let class = job.class();
                let age = if class == Class::Visible {
                    job.seq
                } else {
                    u64::MAX - job.seq
                };
                (class, job.front, age)
            };
            let best = self
                .jobs
                .iter()
                .filter(|(_, j)| j.running.is_none() && eligible(j))
                .max_by_key(|(_, j)| order(j))
                .map(|(id, _)| *id);
            let Some(id) = best else { break };
            let Some(job) = self.jobs.get_mut(&id) else {
                break;
            };
            job.running = Some(job.class());
            job.front = false;
            if job.kind == Kind::Read {
                // The opened item never waits for a token, but spends one if there.
                let took = self.bucket.try_take(now);
                debug_assert!(
                    took || job.class() == Class::Opened,
                    "a read started without a token"
                );
            }
            actions.push(Action::Start {
                job: id,
                key: job.key.clone(),
                kind: job.kind,
            });
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::Duration;

    /// Plenty of tokens, so tests about slots are not about the bucket.
    fn unlimited(max_running: usize, reserved_high: usize) -> Limits {
        Limits {
            max_running,
            reserved_high,
            reads_per_sec: 1e9,
            read_burst: 1e9,
            ..Limits::default()
        }
    }

    struct Harness {
        state: State,
        now: Instant,
        next_sub: SubId,
        job_of: HashMap<String, JobId>,
        started: Vec<String>,
        cancelled: Vec<JobId>,
        finished: Vec<(JobId, Vec<SubId>)>,
    }

    impl Harness {
        fn new(limits: Limits) -> Self {
            let now = Instant::now();
            Self {
                state: State::new(limits, now),
                now,
                next_sub: 0,
                job_of: HashMap::new(),
                started: vec![],
                cancelled: vec![],
                finished: vec![],
            }
        }
        fn record(&mut self, actions: Vec<Action>) {
            for a in actions {
                match a {
                    Action::Start { job, key, .. } => {
                        self.job_of.insert(key.clone(), job);
                        self.started.push(key);
                    }
                    Action::Cancel { job } => self.cancelled.push(job),
                    Action::Finish { job, subs } => self.finished.push((job, subs)),
                }
            }
        }
        fn want(&mut self, key: &str, kind: Kind, class: Class) -> SubId {
            self.next_sub += 1;
            let sub = self.next_sub;
            let actions = self
                .state
                .subscribe(sub, key.to_owned(), kind, class, self.now);
            self.record(actions);
            sub
        }
        fn read(&mut self, key: &str, class: Class) -> SubId {
            self.want(key, Kind::Read, class)
        }
        fn leave(&mut self, sub: SubId) {
            let actions = self.state.unsubscribe(sub, self.now);
            self.record(actions);
        }
        fn end(&mut self, key: &str, outcome: Outcome) {
            let job = self.job_of[key];
            let actions = self.state.finished(job, outcome, self.now);
            self.record(actions);
        }
        fn advance(&mut self, by: Duration) {
            self.now += by;
            let actions = self.state.tick(self.now);
            self.record(actions);
        }
        fn take_started(&mut self) -> Vec<String> {
            std::mem::take(&mut self.started)
        }
    }

    #[test]
    fn respects_the_concurrency_limit() {
        let mut h = Harness::new(unlimited(2, 0));
        h.read("a", Class::Background);
        h.read("b", Class::Background);
        h.read("c", Class::Background);
        assert_eq!(h.take_started(), ["a", "b"]);
        h.end("a", Outcome::Done);
        assert_eq!(h.take_started(), ["c"]);
    }

    #[test]
    fn higher_classes_start_first() {
        let mut h = Harness::new(unlimited(1, 0));
        h.read("filler", Class::Background);
        h.read("b", Class::Background);
        h.read("v", Class::Visible);
        h.read("n", Class::Next);
        h.take_started();
        for (done, next) in [("filler", "n"), ("n", "v"), ("v", "b")] {
            h.end(done, Outcome::Done);
            assert_eq!(h.take_started(), [next]);
        }
    }

    #[test]
    fn first_come_first_served_except_newest_first_on_screen() {
        let mut h = Harness::new(unlimited(1, 0));
        h.read("filler", Class::Next);
        h.read("b1", Class::Background);
        h.read("b2", Class::Background);
        h.read("v1", Class::Visible);
        h.read("v2", Class::Visible);
        h.take_started();
        for (done, next) in [("filler", "v2"), ("v2", "v1"), ("v1", "b1"), ("b1", "b2")] {
            h.end(done, Outcome::Done);
            assert_eq!(h.take_started(), [next]);
        }
    }

    #[test]
    fn a_pending_job_follows_its_highest_subscriber_and_drops_when_it_leaves() {
        let mut h = Harness::new(unlimited(1, 0));
        h.read("filler", Class::Next);
        h.read("v", Class::Visible);
        h.read("b", Class::Background);
        h.read("b", Class::Next);
        h.take_started();
        h.end("filler", Outcome::Done);
        assert_eq!(h.take_started(), ["b"], "raised to Next, it goes first");
        // Again, but the Next subscriber leaves before a slot frees.
        let mut h = Harness::new(unlimited(1, 0));
        h.read("filler", Class::Next);
        h.read("b", Class::Background);
        let next2 = h.read("b", Class::Next);
        h.read("v", Class::Visible);
        h.leave(next2);
        h.take_started();
        h.end("filler", Outcome::Done);
        assert_eq!(
            h.take_started(),
            ["v"],
            "back to Background, it waits behind Visible"
        );
    }

    #[test]
    fn only_a_new_request_from_the_screen_makes_a_thumbnail_newest() {
        let mut h = Harness::new(unlimited(1, 0));
        h.read("filler", Class::Next);
        h.read("v1", Class::Visible);
        h.read("v2", Class::Visible);
        h.read("v1", Class::Background);
        h.take_started();
        h.end("filler", Outcome::Done);
        assert_eq!(
            h.take_started(),
            ["v2"],
            "a background request does not reorder the screen"
        );
        let mut h = Harness::new(unlimited(1, 0));
        h.read("filler", Class::Next);
        h.read("v1", Class::Visible);
        h.read("v2", Class::Visible);
        h.read("v1", Class::Visible);
        h.take_started();
        h.end("filler", Outcome::Done);
        assert_eq!(
            h.take_started(),
            ["v1"],
            "asked again from the screen, it is the newest"
        );
    }

    #[test]
    fn a_running_job_keeps_the_slot_it_started_in() {
        let mut h = Harness::new(unlimited(6, 0));
        for k in ["g1", "g2", "g3"] {
            h.read(k, Class::Background);
        }
        assert_eq!(h.take_started(), ["g1", "g2"]);
        h.read("g1", Class::Visible);
        assert!(
            h.take_started().is_empty(),
            "raising g1 frees no Background slot"
        );
    }

    #[test]
    fn only_the_opened_item_takes_the_reserved_slot() {
        let mut h = Harness::new(unlimited(3, 1));
        h.read("v1", Class::Visible);
        h.read("n1", Class::Next);
        h.read("n2", Class::Next);
        h.read("v2", Class::Visible);
        assert_eq!(
            h.take_started(),
            ["v1", "n1"],
            "Next leaves it free too (SPEC §4.9)"
        );
        h.read("open", Class::Opened);
        assert_eq!(h.take_started(), ["open"]);
    }

    #[test]
    fn each_class_has_its_own_cap() {
        let mut h = Harness::new(unlimited(6, 0));
        for k in ["n1", "n2", "n3"] {
            h.read(k, Class::Next);
        }
        for k in ["g1", "g2", "g3"] {
            h.read(k, Class::Background);
        }
        assert_eq!(h.take_started(), ["n1", "n2", "g1", "g2"]);
        let mut h = Harness::new(unlimited(6, 0));
        h.want("s1", Kind::Send, Class::Background);
        h.want("s2", Kind::Send, Class::Background);
        assert_eq!(h.take_started(), ["s1"], "one upload part at a time");
    }

    #[test]
    fn cancelled_pending_work_never_runs_and_spends_no_token() {
        let mut h = Harness::new(Limits {
            reads_per_sec: 1.0,
            read_burst: 1.0,
            ..Limits::default()
        });
        h.read("a", Class::Background);
        let b = h.read("b", Class::Background);
        assert_eq!(h.take_started(), ["a"]);
        h.leave(b);
        h.advance(Duration::from_secs(1));
        assert!(h.take_started().is_empty());
        h.read("c", Class::Background);
        assert_eq!(h.take_started(), ["c"], "b's token was never spent");
        assert!(
            h.cancelled.is_empty(),
            "a pending job is dropped, not cancelled"
        );
    }

    #[test]
    fn an_opened_item_suspends_everything_below_it_until_it_is_done() {
        let mut h = Harness::new(unlimited(6, 1));
        h.read("v1", Class::Visible);
        h.read("open", Class::Opened);
        h.read("v2", Class::Visible);
        h.want("s", Kind::Send, Class::Background);
        assert_eq!(h.take_started(), ["v1", "open"]);
        h.end("v1", Outcome::Done);
        assert!(
            h.take_started().is_empty(),
            "running work finishes, nothing new starts"
        );
        h.end("open", Outcome::Done);
        assert_eq!(h.take_started(), ["v2", "s"]);
    }

    #[test]
    fn an_opened_item_preempts_background_reads_but_not_thumbnails_or_uploads() {
        let mut h = Harness::new(unlimited(3, 0));
        h.read("bg", Class::Background);
        h.read("v", Class::Visible);
        h.want("s", Kind::Send, Class::Background);
        assert_eq!(h.take_started(), ["bg", "v", "s"]);
        let bg = h.job_of["bg"];
        h.read("open", Class::Opened);
        assert_eq!(h.cancelled, [bg]);
        assert_eq!(h.take_started(), ["open"]);
        h.end("open", Outcome::Done);
        assert_eq!(
            h.take_started(),
            ["bg"],
            "the pre-empted read is queued again"
        );
    }

    #[test]
    fn reads_wait_for_tokens_in_order_and_the_opened_item_skips_the_bucket() {
        let mut h = Harness::new(Limits {
            reads_per_sec: 1.0,
            read_burst: 2.0,
            ..Limits::default()
        });
        for k in ["b1", "b2", "n1"] {
            h.read(k, Class::Next);
        }
        assert_eq!(h.take_started(), ["b1", "b2"]);
        h.end("b1", Outcome::Done);
        assert!(h.take_started().is_empty(), "no token yet");
        assert_eq!(h.state.next_wakeup(), Some(h.now + Duration::from_secs(1)));
        h.read("open", Class::Opened);
        assert_eq!(h.take_started(), ["open"], "the opened item needs no token");
        h.end("open", Outcome::Done);
        h.advance(Duration::from_secs(1));
        assert_eq!(h.take_started(), ["n1"]);
    }

    #[test]
    fn requests_for_one_file_share_one_job_until_the_last_leaves() {
        let mut h = Harness::new(unlimited(6, 0));
        let a = h.read("f", Class::Visible);
        let b = h.read("f", Class::Visible);
        assert_eq!(h.take_started(), ["f"]);
        h.leave(a);
        assert!(h.cancelled.is_empty());
        let c = h.read("f", Class::Visible);
        h.end("f", Outcome::Failed);
        assert_eq!(
            h.finished,
            [(h.job_of["f"], vec![b, c])],
            "a late joiner and an error reach everyone"
        );
        h.read("f", Class::Visible);
        assert_eq!(h.take_started(), ["f"], "new work after the job ended");
        let job = h.job_of["f"];
        let only = h.next_sub;
        h.leave(only);
        assert_eq!(h.cancelled, [job], "the last one leaving cancels it");
        h.read("f", Class::Visible);
        assert_eq!(h.take_started(), ["f"], "new work after it was cancelled");
    }

    #[test]
    fn opening_a_photo_that_is_being_prefetched_stops_the_other_prefetches() {
        let mut h = Harness::new(unlimited(6, 0));
        h.read("p1", Class::Background);
        h.read("p2", Class::Background);
        h.take_started();
        let p2 = h.job_of["p2"];
        h.read("p1", Class::Opened);
        assert_eq!(h.cancelled, [p2]);
    }

    #[test]
    fn the_opened_item_spends_a_token_when_there_is_one() {
        let mut h = Harness::new(Limits {
            reads_per_sec: 1.0,
            read_burst: 1.0,
            ..Limits::default()
        });
        h.read("open", Class::Opened);
        h.end("open", Outcome::Done);
        h.read("v", Class::Visible);
        assert_eq!(
            h.take_started(),
            ["open"],
            "the thumbnail waits for the next token"
        );
    }

    #[test]
    fn a_zero_wait_still_pauses_a_second_and_three_rate_limits_give_up() {
        let mut h = Harness::new(unlimited(6, 0));
        let sub = h.read("o", Class::Opened);
        h.take_started();
        h.end("o", Outcome::RateLimited(0));
        assert!(h.take_started().is_empty(), "no hot retry loop");
        h.advance(Duration::from_secs(1));
        assert_eq!(h.take_started(), ["o"]);
        h.end("o", Outcome::RateLimited(0));
        h.advance(Duration::from_secs(1));
        h.take_started();
        h.end("o", Outcome::RateLimited(0));
        assert_eq!(
            h.finished,
            [(h.job_of["o"], vec![sub])],
            "the third one reaches the waiter"
        );
    }

    #[test]
    fn an_opened_photo_waiting_out_a_pause_does_not_hold_up_uploads() {
        let mut h = Harness::new(unlimited(6, 0));
        h.read("o", Class::Opened);
        h.end("o", Outcome::RateLimited(60));
        h.want("s", Kind::Send, Class::Background);
        assert_eq!(h.take_started(), ["o", "s"]);
    }

    #[test]
    fn a_rate_limit_pauses_all_reads_and_queues_the_job_first() {
        let mut h = Harness::new(unlimited(6, 0));
        h.read("a", Class::Visible);
        h.take_started();
        h.end("a", Outcome::RateLimited(10));
        h.read("b", Class::Visible);
        h.want("s", Kind::Send, Class::Background);
        assert_eq!(h.take_started(), ["s"], "uploads are paced separately");
        h.read("o", Class::Opened);
        assert!(
            h.take_started().is_empty(),
            "the opened photo waits out the pause too"
        );
        h.advance(Duration::from_secs(9));
        assert!(h.take_started().is_empty());
        h.advance(Duration::from_secs(1));
        assert_eq!(h.take_started(), ["o"]);
        h.end("o", Outcome::Done);
        assert_eq!(h.take_started(), ["a", "b"], "the paused job goes first");
    }

    #[derive(Debug, Default)]
    struct Scroll {
        started: usize,
        finished: usize,
        cancelled: usize,
        most_at_once: usize,
    }

    fn settle(
        h: &mut Harness,
        running: &mut Vec<(String, Instant)>,
        run: &mut Scroll,
        fetch: Duration,
    ) {
        let batch = h.take_started();
        run.most_at_once = run.most_at_once.max(batch.len());
        run.started += batch.len();
        let now = h.now;
        running.extend(batch.into_iter().map(|key| (key, now)));
        running.retain(|(key, since)| {
            if now.saturating_duration_since(*since) < fetch {
                return true;
            }
            if h.state.is_running(h.job_of[key]) {
                h.end(key, Outcome::Done);
            }
            false
        });
    }

    /// Gate 2 for 1.4: a scroll through 10,000 thumbnails, 30 on screen. Each
    /// 8 ms frame (120 Hz) `per_frame` tiles appear at the bottom and as many
    /// leave at the top — Flutter builds the new tiles, then disposes the old.
    /// A fetch takes `fetch`. A photo is tapped halfway. Then the scroll stops
    /// and the final screen must load in full.
    fn scroll(per_frame: usize, fetch: Duration) -> Scroll {
        let limits = Limits::default();
        let mut h = Harness::new(limits.clone());
        let start = h.now;
        let mut run = Scroll::default();
        let mut running = vec![];
        let mut screen: std::collections::VecDeque<SubId> = (0..30)
            .map(|i| h.read(&format!("t{i}"), Class::Visible))
            .collect();
        settle(&mut h, &mut running, &mut run, fetch);
        let frames = (10_000 - 30) / per_frame;
        for frame in 0..frames {
            for i in 0..per_frame {
                let tile = 30 + frame * per_frame + i;
                screen.push_back(h.read(&format!("t{tile}"), Class::Visible));
            }
            for sub in screen.drain(..per_frame).collect::<Vec<_>>() {
                h.leave(sub);
            }
            settle(&mut h, &mut running, &mut run, fetch);
            if frame == frames / 2 {
                h.read("opened", Class::Opened);
                assert_eq!(
                    h.take_started(),
                    ["opened"],
                    "the tapped photo starts at once, alone"
                );
                h.end("opened", Outcome::Done);
            }
            h.advance(Duration::from_millis(8));
            settle(&mut h, &mut running, &mut run, fetch);
        }
        let secs = h.now.saturating_duration_since(start).as_secs_f64();
        assert!(
            run.started as f64 <= limits.read_burst + limits.reads_per_sec * secs + 1.0,
            "{run:?} in {secs} s"
        );
        assert!(run.most_at_once as f64 <= limits.read_burst, "{run:?}");
        let during = run.started;
        for _ in 0..500 {
            h.advance(Duration::from_millis(10));
            settle(&mut h, &mut running, &mut run, fetch);
        }
        let served: std::collections::HashSet<SubId> = h
            .finished
            .iter()
            .flat_map(|(_, subs)| subs.iter().copied())
            .collect();
        assert!(
            screen.iter().all(|sub| served.contains(sub)),
            "the final screen did not load"
        );
        assert!(
            run.started - during <= 30,
            "only the final screen loads after the scroll"
        );
        run.finished = h.finished.len() - 1; // not the tapped photo
        run.cancelled = h.cancelled.len();
        run
    }

    #[test]
    fn gate2_a_fast_fling_is_held_to_the_rate() {
        // 480 tiles a second: each is on screen 60 ms, less than one fetch.
        println!("fast fling: {:?}", scroll(4, Duration::from_millis(150)));
    }

    #[test]
    fn gate2_a_steady_scroll_fetches_what_stays_on_screen() {
        let run = scroll(1, Duration::from_millis(150));
        println!("steady scroll: {run:?}");
        assert!(
            run.finished * 10 >= run.started * 9,
            "most started fetches were wasted"
        );
    }
}
