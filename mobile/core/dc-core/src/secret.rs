//! Values that must never be printed, logged or left behind in memory: the
//! session token, the bot token, passwords (SPEC §4.1, §4.8). `Debug` and
//! `Display` print `[redacted]`; the value is zeroed when dropped.

use serde::Deserialize;
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

pub struct Secret<T: Zeroize>(Zeroizing<T>);

impl<T: Zeroize> Secret<T> {
    pub fn new(value: T) -> Self {
        Self(Zeroizing::new(value))
    }

    /// The value itself. Use it where it is needed (a header, the URL of a
    /// request being sent) and never keep or format the result.
    pub fn expose(&self) -> &T {
        &self.0
    }
}

/// `#[serde(deserialize_with = ...)]` for a secret string field.
pub(crate) fn deserialize<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Secret<String>, D::Error> {
    serde::Deserialize::deserialize(d).map(Secret::new)
}

/// The same for an optional field.
pub(crate) fn deserialize_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Secret<String>>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.map(Secret::new))
}

impl<T: Zeroize + Clone> Clone for Secret<T> {
    fn clone(&self) -> Self {
        Self::new((*self.0).clone())
    }
}

impl<T: Zeroize> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

impl<T: Zeroize> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_prints_the_value() {
        let token = Secret::new(String::from("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
        assert_eq!(format!("{token:?}"), "Secret([redacted])");
        assert_eq!(format!("{token}"), "[redacted]");
    }

    #[test]
    fn exposes_the_value_on_purpose_and_clones() {
        let token = Secret::new(String::from("abc"));
        let copy = token.clone();
        assert_eq!(token.expose(), "abc");
        assert_eq!(copy.expose(), "abc");
    }
}
