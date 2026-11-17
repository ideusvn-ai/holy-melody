//! Đăng nhập Google cho desktop: OAuth 2.0 Authorization Code + PKCE qua trình duyệt hệ thống,
//! redirect về loopback 127.0.0.1:<cổng ngẫu nhiên>. Phase 1 chỉ sinh tham số PKCE;
//! listener loopback + đổi code + gửi id_token lên backend thuộc Phase 6.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
    pub method: &'static str,
}

fn random_b64(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// RFC 7636: verifier 43–128 ký tự, challenge = BASE64URL(SHA256(verifier))
pub fn make_pkce() -> PkcePair {
    let verifier = random_b64(48); // 64 ký tự
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    PkcePair { verifier, challenge, state: random_b64(24), method: "S256" }
}

#[tauri::command]
pub fn auth_pkce_begin() -> PkcePair {
    make_pkce()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc7636_appendix_b() {
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let c = URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()));
        assert_eq!(c, "E9Melhoa2OwvFrEMTJguCQaoWBDoy6TU3B1XYYLFSFg");
    }

    #[test]
    fn pkce_lengths() {
        let p = make_pkce();
        assert!(p.verifier.len() >= 43 && p.verifier.len() <= 128);
        assert_ne!(p.verifier, make_pkce().verifier);
    }
}
