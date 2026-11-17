//! Tài khoản: đăng nhập Google (OAuth 2.0 Authorization Code + PKCE, loopback 127.0.0.1),
//! gửi id_token lên backend để nhận phiên Holy Melody, lưu token phiên trong Keychain / Credential Manager.
//! Token không bao giờ được trả về JavaScript; mọi lời gọi API có xác thực đi qua `api_request`.
//!
//! Cấu hình lúc build (GitHub Secrets → biến môi trường):
//!   HM_API_URL, HM_GOOGLE_DESKTOP_CLIENT_ID, HM_GOOGLE_DESKTOP_CLIENT_SECRET
//! Hoặc lúc chạy: file `config.json` trong thư mục cấu hình của ứng dụng (cùng tên khóa, viết thường).

use crate::auth::make_pkce;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "app.holymelody.desktop";
const KEYRING_USER: &str = "session";

#[derive(Deserialize, Default, Clone)]
struct FileConfig {
    api_url: Option<String>,
    google_client_id: Option<String>,
    google_client_secret: Option<String>,
}

#[derive(Clone)]
struct Cfg {
    api_url: String,
    client_id: String,
    client_secret: String,
}

fn config(app: &AppHandle) -> Result<Cfg, String> {
    let file: FileConfig = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("config.json")).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let pick = |f: Option<String>, build: Option<&'static str>| f.filter(|s| !s.is_empty()).or(build.filter(|s| !s.is_empty()).map(String::from));
    let api_url = pick(file.api_url, option_env!("HM_API_URL"));
    let client_id = pick(file.google_client_id, option_env!("HM_GOOGLE_DESKTOP_CLIENT_ID"));
    let client_secret = pick(file.google_client_secret, option_env!("HM_GOOGLE_DESKTOP_CLIENT_SECRET"));
    match (api_url, client_id) {
        (Some(a), Some(c)) => Ok(Cfg { api_url: a.trim_end_matches('/').to_string(), client_id: c, client_secret: client_secret.unwrap_or_default() }),
        _ => Err("NOT_CONFIGURED: Bản build này chưa được cấu hình máy chủ tài khoản (HM_API_URL) và Google Client ID. Các chức năng soạn và phát nhạc vẫn dùng bình thường.".into()),
    }
}

fn keyring() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn token() -> Option<String> {
    keyring().ok()?.get_password().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    configured: bool,
    api_url: Option<String>,
    reason: Option<String>,
}

#[tauri::command]
pub fn account_config(app: AppHandle) -> AccountConfig {
    match config(&app) {
        Ok(c) => AccountConfig { configured: true, api_url: Some(c.api_url), reason: None },
        Err(e) => AccountConfig { configured: false, api_url: None, reason: Some(e) },
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build()
}

/// Gọi API backend; trả về JSON. Lỗi HTTP được chuyển thành chuỗi "CODE: thông điệp".
fn call(cfg: &Cfg, method: &str, path: &str, body: Option<&Value>, idem: Option<&str>, bearer: Option<&str>) -> Result<Value, String> {
    if !path.starts_with("/api/") {
        return Err("Đường dẫn API không hợp lệ".into());
    }
    let mut req = agent().request(method, &format!("{}{}", cfg.api_url, path)).set("Accept", "application/json");
    if let Some(t) = bearer {
        req = req.set("Authorization", &format!("Bearer {t}"));
    }
    if let Some(k) = idem {
        req = req.set("Idempotency-Key", k);
    }
    let res = match body {
        Some(b) => req.send_json(b.clone()),
        None => req.call(),
    };
    match res {
        Ok(r) => {
            if r.status() == 204 {
                return Ok(Value::Null);
            }
            r.into_json::<Value>().map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(code, r)) => {
            let v: Value = r.into_json().unwrap_or(Value::Null);
            let c = v["error"]["code"].as_str().unwrap_or("HTTP_ERROR");
            let m = v["error"]["message"].as_str().unwrap_or("Lỗi máy chủ");
            Err(format!("{c} ({code}): {m}"))
        }
        Err(e) => Err(format!("NETWORK: Không kết nối được máy chủ ({e})")),
    }
}

/// Đăng nhập Google qua trình duyệt hệ thống
#[tauri::command]
pub async fn account_login(app: AppHandle) -> Result<Value, String> {
    let cfg = config(&app)?;
    tauri::async_runtime::spawn_blocking(move || login_blocking(&cfg)).await.map_err(|e| e.to_string())?
}

fn login_blocking(cfg: &Cfg) -> Result<Value, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let pkce = make_pkce();
    let url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&prompt=select_account",
        enc(&cfg.client_id), enc(&redirect), enc("openid email profile"), pkce.challenge, pkce.state
    );
    open::that_detached(&url).map_err(|e| format!("Không mở được trình duyệt: {e}"))?;

    // chờ Google chuyển hướng về (tối đa 5 phút)
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (code, state) = loop {
        if Instant::now() > deadline {
            return Err("Hết thời gian chờ đăng nhập".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).ok();
                let mut first = String::new();
                BufReader::new(&stream).read_line(&mut first).map_err(|e| e.to_string())?;
                let target = first.split_whitespace().nth(1).unwrap_or("/");
                let q = target.split_once('?').map(|x| x.1).unwrap_or("");
                let get = |k: &str| q.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| dec(v)));
                let ok = get("code").is_some();
                let html = if ok {
                    "<h2 style='font-family:sans-serif'>Đăng nhập thành công. Bạn có thể đóng tab này và quay lại Holy Melody.</h2>"
                } else {
                    "<h2 style='font-family:sans-serif'>Đăng nhập không thành công. Hãy quay lại Holy Melody và thử lại.</h2>"
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", html.len(), html);
                if let Some(err) = get("error") {
                    return Err(format!("Google từ chối: {err}"));
                }
                if let (Some(c), Some(s)) = (get("code"), get("state")) {
                    break (c, s);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(e.to_string()),
        }
    };
    if state != pkce.state {
        return Err("Sai tham số state (có thể là yêu cầu giả mạo)".into());
    }
    // đổi mã lấy id_token
    let tok: Value = agent()
        .post("https://oauth2.googleapis.com/token")
        .send_form(&[
            ("code", code.as_str()),
            ("client_id", cfg.client_id.as_str()),
            ("client_secret", cfg.client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", pkce.verifier.as_str()),
        ])
        .map_err(|e| format!("Không đổi được mã đăng nhập: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    let id_token = tok["id_token"].as_str().ok_or("Google không trả về id_token")?;
    // backend xác minh id_token và cấp phiên
    let res = call(cfg, "POST", "/api/v1/auth/google", Some(&serde_json::json!({ "id_token": id_token, "client": "desktop" })), None, None)?;
    let session = res["token"].as_str().ok_or("Máy chủ không trả về phiên đăng nhập")?;
    keyring()?.set_password(session).map_err(|e| format!("Không lưu được phiên vào Keychain: {e}"))?;
    let mut out = res.clone();
    if let Some(o) = out.as_object_mut() {
        o.remove("token"); // không đưa token lên JavaScript
    }
    Ok(out)
}

/// Thông tin tài khoản hiện tại (null nếu chưa đăng nhập)
#[tauri::command]
pub async fn account_me(app: AppHandle) -> Result<Value, String> {
    let cfg = config(&app)?;
    let Some(t) = token() else { return Ok(Value::Null) };
    tauri::async_runtime::spawn_blocking(move || match call(&cfg, "GET", "/api/v1/me", None, None, Some(&t)) {
        Err(e) if e.starts_with("UNAUTHENTICATED") => {
            let _ = keyring().and_then(|k| k.delete_credential().map_err(|e| e.to_string()));
            Ok(Value::Null)
        }
        r => r,
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn account_logout(app: AppHandle) -> Result<(), String> {
    let cfg = config(&app)?;
    if let Some(t) = token() {
        let _ = tauri::async_runtime::spawn_blocking(move || call(&cfg, "POST", "/api/v1/auth/logout", Some(&Value::Null), None, Some(&t))).await;
    }
    if let Ok(k) = keyring() {
        let _ = k.delete_credential();
    }
    Ok(())
}

/// Gọi API có xác thực từ giao diện (token nằm ở Rust)
#[tauri::command]
pub async fn api_request(app: AppHandle, method: String, path: String, body: Option<Value>, idempotency_key: Option<String>) -> Result<Value, String> {
    let cfg = config(&app)?;
    let t = token();
    let m = method.to_uppercase();
    if !["GET", "POST", "PUT", "DELETE"].contains(&m.as_str()) {
        return Err("Phương thức không hợp lệ".into());
    }
    tauri::async_runtime::spawn_blocking(move || call(&cfg, &m, &path, body.as_ref(), idempotency_key.as_deref(), t.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Mở liên kết trong trình duyệt (trang mua credit, tải Audiveris…) – chỉ https
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Chỉ mở liên kết https".into());
    }
    open::that_detached(&url).map_err(|e| e.to_string())
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                let h = std::str::from_utf8(&b[i + 1..(i + 3).min(b.len())]).ok().and_then(|x| u8::from_str_radix(x, 16).ok());
                if let Some(v) = h {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_codec() {
        assert_eq!(enc("openid email"), "openid%20email");
        assert_eq!(dec("4%2F0Ab_cd+x"), "4/0Ab_cd x");
        assert_eq!(dec("abc%"), "abc%");
    }
}
