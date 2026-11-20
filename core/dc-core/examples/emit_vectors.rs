//! Prints parts that Rust encrypted, for `compat/verify-rust-output.mjs` to
//! decrypt with the production JavaScript (the Rust → JS direction of SPEC §4.2).
use base64::Engine as _;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key =
        dc_core::crypto::derive_key("correct horse battery staple", "c2FsdC1zYWx0LXNhbHQhIQ==")?;
    let mut parts = Vec::new();
    for n in [0usize, 1, 16, 1000, 19 * 1024 * 1024] {
        let plain: Vec<u8> = (0..n)
            .map(|i| u8::try_from((i * 31 + 7) % 251).unwrap_or(0))
            .collect();
        let part = dc_core::crypto::encrypt_part(&key, &plain)?;
        parts.push(serde_json::json!({ "plaintext_len": n, "part_b64": base64::engine::general_purpose::STANDARD.encode(part) }));
    }
    println!(
        "{}",
        serde_json::json!({ "password": "correct horse battery staple", "salt_b64": "c2FsdC1zYWx0LXNhbHQhIQ==", "parts": parts })
    );
    Ok(())
}
