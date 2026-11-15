//! Decrypted thumbnails and previews on disk (P1 decision C5): each file
//! named by the SHA-256 of its key (the caller's: account, encryption and
//! Telegram `file_id`), at most `capacity` bytes,
//! the least recently used dropped first; written to a temporary file and
//! renamed, so a crash never leaves half a file. Originals are never kept.
//! Best effort: a failure here is a cache miss, never a failed read.
//! Blocking file I/O — call it from `spawn_blocking`.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use bytes::Bytes;
use sha2::{Digest, Sha256};

use crate::CoreError;

pub(crate) struct DiskCache {
    dir: PathBuf,
    capacity: u64,
    state: Mutex<State>,
    next_tmp: AtomicU64,
}

struct State {
    used: u64,
    /// Bumped by `clear`: a write whose read began before it is dropped.
    generation: u64,
}

impl DiskCache {
    pub(crate) fn open(dir: PathBuf, capacity: u64) -> Result<Self, CoreError> {
        std::fs::create_dir_all(&dir)
            .map_err(|e| CoreError::Internal(format!("cannot create the media cache: {e}")))?;
        let cache = Self {
            dir,
            capacity,
            state: Mutex::new(State {
                used: 0,
                generation: 0,
            }),
            next_tmp: AtomicU64::new(0),
        };
        // Leftovers of a crash mid-write, then the size of what is there.
        for (path, ..) in cache.entries(true) {
            let _ = std::fs::remove_file(path);
        }
        let used = cache.entries(false).iter().map(|(_, _, len)| len).sum();
        cache.lock().used = used;
        Ok(cache)
    }

    /// Taken before a read; handed back to `put` with what the read gave.
    pub(crate) fn generation(&self) -> u64 {
        self.lock().generation
    }

    pub(crate) fn get(&self, key: &str) -> Option<Bytes> {
        let path = self.path(key);
        let bytes = std::fs::read(&path).ok()?;
        // Mark it recently used.
        if let Ok(file) = std::fs::File::options().write(true).open(&path) {
            let _ = file.set_modified(SystemTime::now());
        }
        Some(Bytes::from(bytes))
    }

    /// Keeps `bytes` unless the cache was cleared since `generation` was taken.
    pub(crate) fn put(&self, key: &str, bytes: &[u8], generation: u64) {
        let path = self.path(key);
        let n = self.next_tmp.fetch_add(1, Ordering::Relaxed);
        let tmp = path.with_extension(format!("{n}.tmp"));
        if let Err(e) = std::fs::write(&tmp, bytes) {
            let _ = std::fs::remove_file(&tmp);
            log::warn!("media cache: cannot store a file: {e}");
            return;
        }
        // Renamed under the lock, so a `clear` cannot slip in between.
        let mut state = self.lock();
        if state.generation != generation || std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        state.used += bytes.len() as u64;
        if state.used > self.capacity {
            state.used = self.evict();
        }
    }

    /// Empties the cache, writes in progress included (another account or a
    /// sign-out: no account's pictures outlive it).
    pub(crate) fn clear(&self) {
        let mut state = self.lock();
        state.generation += 1;
        for (path, ..) in self.entries(true).into_iter().chain(self.entries(false)) {
            let _ = std::fs::remove_file(path);
        }
        state.used = 0;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Drops the least recently used down to 90 % (so not every write
    /// evicts); returns what is left. Counted from the disk, so a file
    /// written twice or removed by the OS cannot skew the total. "Recently"
    /// is to the file system's clock: files used within one tick tie.
    fn evict(&self) -> u64 {
        let mut entries = self.entries(false);
        entries.sort_by_key(|(_, modified, _)| *modified);
        let mut used: u64 = entries.iter().map(|(_, _, len)| len).sum();
        let target = self.capacity / 10 * 9;
        for (path, _, len) in entries {
            if used <= target {
                break;
            }
            if std::fs::remove_file(path).is_ok() {
                used -= len;
            }
        }
        used
    }

    /// Cached files (or, with `tmp`, leftover temporary ones): path, last use, size.
    fn entries(&self, tmp: bool) -> Vec<(PathBuf, SystemTime, u64)> {
        let Ok(dir) = std::fs::read_dir(&self.dir) else {
            return vec![];
        };
        dir.flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp") == tmp)
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((e.path(), meta.modified().ok()?, meta.len()))
            })
            .collect()
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(hex(&Sha256::digest(key.as_bytes())))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn keeps_what_it_was_given_across_a_restart_under_safe_names() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskCache::open(dir.path().join("media"), 1_000).unwrap();
        cache.put("AgAD/../../etc", b"thumb", cache.generation());
        assert_eq!(cache.get("AgAD/../../etc").as_deref(), Some(&b"thumb"[..]));
        assert_eq!(cache.get("other"), None);
        let files = names(&dir.path().join("media"));
        assert!(
            files.len() == 1
                && files[0].len() == 64
                && files[0].bytes().all(|b| b.is_ascii_hexdigit())
        );
        let cache = DiskCache::open(dir.path().join("media"), 1_000).unwrap();
        assert_eq!(cache.get("AgAD/../../etc").as_deref(), Some(&b"thumb"[..]));
    }

    #[test]
    fn a_crash_mid_write_leaves_no_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("media");
        let cache = DiskCache::open(media.clone(), 1_000).unwrap();
        cache.put("a", b"bytes", cache.generation());
        assert!(names(&media).iter().all(|n| !n.ends_with(".tmp")));
        std::fs::write(media.join("0123.7.tmp"), b"half").unwrap(); // as a crash leaves it
        DiskCache::open(media.clone(), 1_000).unwrap();
        assert!(names(&media).iter().all(|n| !n.ends_with(".tmp")));
    }

    #[test]
    fn a_write_started_before_a_clear_is_dropped_and_clear_leaves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let media = dir.path().join("media");
        let cache = DiskCache::open(media.clone(), 1_000).unwrap();
        let before = cache.generation();
        std::fs::write(media.join("0123.7.tmp"), b"half").unwrap(); // a write in progress
        cache.clear();
        assert!(names(&media).is_empty());
        cache.put("k", b"bytes", before); // finished after the sign-out
        assert!(names(&media).is_empty());
        cache.put("k", b"bytes", cache.generation());
        assert_eq!(cache.get("k").as_deref(), Some(&b"bytes"[..]));
    }

    #[test]
    fn drops_the_least_recently_used_first() {
        let dir = tempfile::tempdir().unwrap();
        let cache = DiskCache::open(dir.path().join("media"), 1_000).unwrap();
        for i in 0..10u64 {
            let key = format!("f{i}");
            cache.put(&key, &[0u8; 100], cache.generation());
            // Distinct times: ext4 stamps writes a few ms apart identically.
            let at = SystemTime::now() - std::time::Duration::from_secs(100 - i);
            let file = std::fs::File::options()
                .write(true)
                .open(cache.path(&key))
                .unwrap();
            file.set_modified(at).unwrap();
        }
        assert!(cache.get("f0").is_some()); // now the most recent
        cache.put("f10", &[0u8; 100], cache.generation()); // 1,100 > 1,000: down to 900
        let kept: Vec<bool> = (0..11)
            .map(|i| cache.get(&format!("f{i}")).is_some())
            .collect();
        assert_eq!(
            kept,
            [
                true, false, false, true, true, true, true, true, true, true, true
            ]
        );
    }
}
