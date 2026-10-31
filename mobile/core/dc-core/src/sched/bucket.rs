//! A token bucket, ported from Nuke's `TokenBucket` (MIT, kean/Nuke). A token
//! is taken only when work actually starts, so work cancelled while it waited
//! never spends one. Time comes in as an argument: tests run on a fake clock.

use std::time::Duration;

pub use tokio::time::Instant;

#[derive(Debug)]
pub struct TokenBucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    /// `rate` tokens per second, at most `burst` saved up; starts full.
    pub fn new(rate: f64, burst: f64, now: Instant) -> Self {
        Self {
            rate,
            burst,
            tokens: burst,
            last: now,
        }
    }

    fn refill(&mut self, now: Instant) {
        // `saturating_duration_since`: time going backwards adds nothing.
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + self.rate * elapsed).min(self.burst);
        self.last = self.last.max(now);
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// How long until a token is there (zero when one is).
    pub fn wait(&mut self, now: Instant) -> Duration {
        self.refill(now);
        if self.tokens >= 1.0 {
            Duration::ZERO
        } else {
            // Never zero here: a sum a hair under 1.0 would round to 0 ns, and
            // callers read zero as "a token is there".
            Duration::from_secs_f64((1.0 - self.tokens) / self.rate).max(Duration::from_nanos(1))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Callers treat a zero wait as "take one now": it must never be zero
    /// while `try_take` would refuse. Found by Task 1.4's fling simulation —
    /// 0.9 + 20 × 0.005 lands a hair under 1.0, which rounded to 0 ns.
    #[test]
    fn a_zero_wait_always_means_a_token_is_there() {
        for step_ms in 1..=50 {
            let mut now = Instant::now();
            let mut bucket = TokenBucket::new(20.0, 10.0, now);
            while bucket.try_take(now) {}
            for _ in 0..200 {
                now += Duration::from_millis(step_ms);
                if bucket.wait(now).is_zero() {
                    assert!(
                        bucket.try_take(now),
                        "zero wait, no token ({step_ms} ms steps)"
                    );
                }
            }
        }
    }

    #[test]
    fn a_burst_runs_at_once_then_one_token_per_period() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(2.0, 3.0, start);
        assert!(bucket.try_take(start) && bucket.try_take(start) && bucket.try_take(start));
        assert!(!bucket.try_take(start));
        assert_eq!(bucket.wait(start), Duration::from_millis(500));
        assert!(!bucket.try_take(start + Duration::from_millis(499)));
        assert!(bucket.try_take(start + Duration::from_millis(500)));
    }

    #[test]
    fn never_holds_more_than_the_burst_and_ignores_time_going_backwards() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(10.0, 2.0, start);
        let later = start + Duration::from_secs(60);
        assert!(bucket.try_take(later) && bucket.try_take(later));
        assert!(!bucket.try_take(later));
        assert!(!bucket.try_take(start));
        assert_eq!(bucket.wait(later), Duration::from_millis(100));
    }
}
