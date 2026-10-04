//! How a file maps onto Telegram parts (docs/mobile/RESEARCH.md §2), and how
//! an HTTP `Range` request maps onto those parts (RFC 9110 §14).

/// Plaintext bytes per Telegram part. Frozen: bots cannot download files over
/// 20 MB, and every file already stored was split at this size.
pub const PART_SIZE: u64 = 19 * 1024 * 1024;

/// Bytes AES-GCM adds to each encrypted part: a 12-byte IV and a 16-byte tag.
pub const ENCRYPTION_OVERHEAD: u64 = 12 + 16;

/// Number of parts a file of `file_size` bytes is split into.
///
/// A reader must still trust the manifest's own part list over this: the
/// worker stores one part for a 0-byte upload, where this returns 0.
pub fn part_count(file_size: u64) -> u64 {
    file_size.div_ceil(PART_SIZE)
}

/// The bytes of one part needed to serve a range, as offsets inside that part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartSlice {
    pub index: u64,
    pub start: u64,
    pub end_inclusive: u64,
}

/// How to answer a byte-range request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangePlan {
    /// Answer `206` and send these parts, in order.
    Partial(PartSlices),
    /// None of the requested bytes exist (an empty file, or a start at or
    /// past the end): answer `416` with `Content-Range: bytes */<file_size>`.
    Unsatisfiable,
    /// The range is invalid — its start is after its end (RFC 9110 §14.1.1).
    /// §14.2 lets a server ignore such a header; we do, and answer `200` with
    /// the whole file. Also used for a suffix request on an empty file, where
    /// there are no bytes for a `206` to carry. (For an invalid range the web
    /// and the worker send one byte when the start is inside the file, and
    /// `416` when it is past the end; players never send an invalid range, so
    /// the difference does not matter in practice.)
    Ignore,
}

/// The parts a range touches, produced one at a time.
///
/// Native players (AVPlayer, ExoPlayer) treat a short `206` as end-of-file,
/// so the whole requested range must be served — and `bytes=N-` means every
/// remaining part. Producing parts lazily keeps memory flat for any file size:
/// the media server fetches, decrypts and sends each part before asking for
/// the next, and stops when the player hangs up.
///
/// Never `collect()` a plan built from an untrusted size — that would
/// allocate every part at once. Validate the manifest first: its part list
/// must match `part_count(file_size)` (allowing the one stored part of a
/// 0-byte upload).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartSlices {
    start: u64,
    end: u64,
    next: u64,
    last: u64,
    done: bool,
}

impl PartSlices {
    /// Parts still to come.
    pub fn remaining(&self) -> u64 {
        if self.done {
            0
        } else {
            self.last - self.next + 1
        }
    }

    /// First and last plaintext byte of the whole range, for `Content-Range`.
    pub fn byte_range(&self) -> (u64, u64) {
        (self.start, self.end)
    }
}

impl Iterator for PartSlices {
    type Item = PartSlice;

    fn next(&mut self) -> Option<PartSlice> {
        if self.done {
            return None;
        }
        let index = self.next;
        // index <= last = end / PART_SIZE, so index * PART_SIZE <= end: no overflow.
        let part_start = index * PART_SIZE;
        let part_end = part_start.saturating_add(PART_SIZE - 1);
        if index == self.last {
            self.done = true;
        } else {
            self.next = index + 1;
        }
        Some(PartSlice {
            index,
            start: self.start.max(part_start) - part_start,
            end_inclusive: self.end.min(part_end) - part_start,
        })
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = usize::try_from(self.remaining());
        (remaining.unwrap_or(usize::MAX), remaining.ok())
    }
}

impl std::iter::FusedIterator for PartSlices {}

/// Plan `bytes=start-end_inclusive`. For `bytes=start-`, pass `u64::MAX` as
/// the end; an end past the file is clamped, as RFC 9110 §14.1.2 requires.
pub fn plan_range(file_size: u64, start: u64, end_inclusive: u64) -> RangePlan {
    if start > end_inclusive {
        return RangePlan::Ignore;
    }
    if start >= file_size {
        return RangePlan::Unsatisfiable;
    }
    let end = end_inclusive.min(file_size - 1);
    RangePlan::Partial(PartSlices {
        start,
        end,
        next: start / PART_SIZE,
        last: end / PART_SIZE,
        done: false,
    })
}

/// Plan `bytes=-suffix_len`: the last `suffix_len` bytes. iPhone videos open
/// with this request to find their index (the "moov" atom), so playback
/// depends on it. A suffix longer than the file means the whole file; a zero
/// suffix is unsatisfiable (RFC 9110 §14.1.2). On an empty file a non-zero
/// suffix is satisfiable but has no bytes to send, so it is ignored and the
/// empty file served (§14.1.1, §14.2).
pub fn plan_suffix(file_size: u64, suffix_len: u64) -> RangePlan {
    if suffix_len == 0 {
        return RangePlan::Unsatisfiable;
    }
    if file_size == 0 {
        return RangePlan::Ignore;
    }
    plan_range(file_size, file_size.saturating_sub(suffix_len), u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = PART_SIZE;
    const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;

    fn parts(plan: RangePlan) -> Vec<PartSlice> {
        match plan {
            RangePlan::Partial(slices) => slices.collect(),
            other => panic!("expected a 206 plan, got {other:?}"),
        }
    }

    fn slice(index: u64, start: u64, end_inclusive: u64) -> PartSlice {
        PartSlice {
            index,
            start,
            end_inclusive,
        }
    }

    #[test]
    fn the_part_size_is_the_one_the_web_and_the_worker_use() {
        assert_eq!(PART_SIZE, 19_922_944);
    }

    #[test]
    fn an_empty_file_has_no_parts() {
        assert_eq!(part_count(0), 0);
    }

    #[test]
    fn a_file_of_exactly_one_part_is_not_split() {
        assert_eq!(part_count(1), 1);
        assert_eq!(part_count(P), 1);
    }

    #[test]
    fn one_byte_over_a_part_needs_a_second_part() {
        assert_eq!(part_count(P + 1), 2);
    }

    #[test]
    fn a_2_gib_video_has_108_parts() {
        assert_eq!(part_count(TWO_GIB), 108);
    }

    #[test]
    fn a_range_inside_one_part_touches_only_that_part() {
        assert_eq!(parts(plan_range(3 * P, 10, 20)), vec![slice(0, 10, 20)]);
    }

    #[test]
    fn a_range_across_a_boundary_takes_the_tail_of_one_part_and_the_head_of_the_next() {
        assert_eq!(
            parts(plan_range(3 * P, P - 1, P)),
            vec![slice(0, P - 1, P - 1), slice(1, 0, 0)]
        );
    }

    #[test]
    fn seeking_near_the_end_of_a_2_gib_video_fetches_one_part_not_all() {
        let slices = parts(plan_range(TWO_GIB, TWO_GIB - 1000, TWO_GIB - 1));
        assert_eq!(slices.len(), 1);
        assert_eq!(slices[0].index, part_count(TWO_GIB) - 1);
    }

    #[test]
    fn an_open_ended_range_is_clamped_to_the_last_byte() {
        let plan = plan_range(P + 10, 5, u64::MAX);
        let RangePlan::Partial(slices) = plan.clone() else {
            panic!("expected a 206 plan, got {plan:?}");
        };
        assert_eq!(slices.byte_range(), (5, P + 9));
        assert_eq!(parts(plan), vec![slice(0, 5, P - 1), slice(1, 0, 9)]);
    }

    #[test]
    fn requests_for_bytes_that_do_not_exist_get_416() {
        assert_eq!(plan_range(0, 0, 0), RangePlan::Unsatisfiable);
        assert_eq!(plan_range(100, 100, 200), RangePlan::Unsatisfiable);
        assert_eq!(plan_suffix(100, 0), RangePlan::Unsatisfiable);
    }

    #[test]
    fn a_suffix_on_an_empty_file_is_ignored_so_the_empty_file_is_served() {
        // RFC 9110 §14.1.1: for a zero-length file, a non-zero suffix is the
        // one satisfiable range; there are no bytes for a 206 to carry.
        assert_eq!(plan_suffix(0, 10), RangePlan::Ignore);
        assert_eq!(plan_suffix(0, 0), RangePlan::Unsatisfiable);
    }

    #[test]
    fn a_range_whose_start_is_after_its_end_is_ignored_so_the_whole_file_is_served() {
        assert_eq!(plan_range(100, 50, 40), RangePlan::Ignore);
    }

    #[test]
    fn an_invalid_range_is_ignored_even_when_it_also_starts_past_the_end() {
        // Satisfiability is only defined for valid ranges (RFC 9110 §14.1.1).
        assert_eq!(plan_range(100, 200, 150), RangePlan::Ignore);
    }

    #[test]
    fn the_iphone_moov_probe_gets_the_last_bytes_of_the_file() {
        assert_eq!(parts(plan_suffix(3 * P, 8)), vec![slice(2, P - 8, P - 1)]);
    }

    #[test]
    fn a_suffix_longer_than_the_file_serves_the_whole_file() {
        let plan = plan_suffix(100, 1000);
        let RangePlan::Partial(slices) = plan else {
            panic!("expected a 206 plan, got {plan:?}");
        };
        assert_eq!(slices.byte_range(), (0, 99));
    }

    #[test]
    fn the_slices_cover_exactly_the_requested_bytes_in_order() {
        let size = 5 * P + 123;
        for (start, end) in [
            (0, size - 1),
            (P - 5, 3 * P + 7),
            (4 * P, u64::MAX),
            (17, 17),
        ] {
            let slices = parts(plan_range(size, start, end));
            let covered: u64 = slices.iter().map(|s| s.end_inclusive - s.start + 1).sum();
            assert_eq!(covered, end.min(size - 1) - start + 1);
            for pair in slices.windows(2) {
                assert_eq!(pair[1].index, pair[0].index + 1);
                assert_eq!(pair[0].end_inclusive, P - 1);
                assert_eq!(pair[1].start, 0);
            }
        }
    }

    #[test]
    fn a_hostile_file_size_is_streamed_part_by_part_never_allocated_at_once() {
        // A corrupt manifest claiming u64::MAX bytes, and a player's normal
        // `bytes=0-`: a list of every part would be ~22 TB.
        let plan = plan_range(u64::MAX, 0, u64::MAX);
        let RangePlan::Partial(mut slices) = plan else {
            panic!("expected a 206 plan, got {plan:?}");
        };
        assert_eq!(slices.remaining(), part_count(u64::MAX));
        assert_eq!(slices.next(), Some(slice(0, 0, P - 1)));
        assert_eq!(slices.remaining(), part_count(u64::MAX) - 1);
        assert_eq!(part_count(u64::MAX), u64::MAX / P + 1);
    }

    #[test]
    fn the_last_part_of_a_hostile_file_size_does_not_overflow() {
        let slices = parts(plan_range(u64::MAX, u64::MAX - 10, u64::MAX));
        assert!(!slices.is_empty());
        assert!(
            slices
                .iter()
                .all(|s| s.start <= s.end_inclusive && s.end_inclusive < P)
        );
    }

    #[test]
    fn an_exhausted_plan_stays_exhausted() {
        let RangePlan::Partial(mut slices) = plan_range(10, 0, 9) else {
            panic!("expected a 206 plan");
        };
        assert_eq!(slices.size_hint(), (1, Some(1)));
        assert!(slices.next().is_some());
        assert_eq!(slices.remaining(), 0);
        assert_eq!(slices.next(), None);
        assert_eq!(slices.next(), None);
    }
}
