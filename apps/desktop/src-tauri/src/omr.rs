//! Nhận dạng bản nhạc (OMR) bằng Audiveris. Audiveris (AGPL-3.0) được ĐÓNG GÓI KÈM bộ cài Holy Melody
//! (resources/audiveris, xem AUDIVERIS-NOTICE.txt) và chạy như một chương trình độc lập; nếu máy đã cài
//! Audiveris riêng thì cũng dùng được. Tiến trình được báo về UI qua sự kiện `omr://progress`.
use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OmrEngineInfo {
    found: bool,
    /// true khi dùng bản Audiveris đóng gói kèm Holy Melody
    bundled: bool,
    path: Option<String>,
    download_url: &'static str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OmrProgress {
    /// 1..10 theo các bước hiển thị trong UI
    stage: u8,
    line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmrOutput {
    mxl_path: String,
    /// Dự án Audiveris (.omr): chứa tọa độ pixel chính xác của ô nhịp/nốt trên ảnh gốc
    omr_path: Option<String>,
    log_tail: Vec<String>,
}

const DOWNLOAD: &str = "https://github.com/Audiveris/audiveris/releases";

#[derive(Deserialize)]
struct Manifest {
    exe: String,
}

/// Audiveris đóng gói kèm trong thư mục tài nguyên của ứng dụng
fn bundled(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().resource_dir().ok()?.join("resources").join("audiveris");
    let m: Manifest = serde_json::from_slice(&std::fs::read(base.join("manifest.json")).ok()?).ok()?;
    let exe = base.join(m.exe);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(md) = std::fs::metadata(&exe) {
            if md.permissions().mode() & 0o111 == 0 {
                let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    Some(exe)
}

fn candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("HM_AUDIVERIS") {
        v.push(PathBuf::from(p));
    }
    if let Some(p) = bundled(app) {
        v.push(p);
    }
    #[cfg(target_os = "macos")]
    {
        v.push("/Applications/Audiveris.app/Contents/MacOS/Audiveris".into());
        if let Ok(h) = std::env::var("HOME") {
            v.push(PathBuf::from(h).join("Applications/Audiveris.app/Contents/MacOS/Audiveris"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for base in [std::env::var("ProgramFiles").ok(), std::env::var("LOCALAPPDATA").ok().map(|l| format!("{l}\\Programs"))].into_iter().flatten() {
            v.push(PathBuf::from(&base).join("Audiveris").join("Audiveris.exe"));
            v.push(PathBuf::from(&base).join("Audiveris").join("bin").join("Audiveris.bat"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        v.push("/opt/audiveris/bin/Audiveris".into());
        v.push("/usr/bin/audiveris".into());
    }
    // PATH
    if let Some(paths) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&paths) {
            for n in ["Audiveris", "audiveris", "Audiveris.exe", "audiveris.exe"] {
                v.push(d.join(n));
            }
        }
    }
    v
}

fn find(app: &AppHandle) -> Option<PathBuf> {
    candidates(app).into_iter().find(|p| p.is_file())
}

#[tauri::command]
pub fn omr_detect(app: AppHandle) -> OmrEngineInfo {
    let p = find(&app);
    let bundled = p.is_some() && p == bundled(&app);
    OmrEngineInfo { found: p.is_some(), bundled, path: p.map(|p| p.display().to_string()), download_url: DOWNLOAD }
}

/// Ánh xạ các bước của Audiveris sang 10 bước của Holy Melody
fn stage_of(line: &str) -> Option<u8> {
    let u = line.to_ascii_uppercase();
    let table: [(&[&str], u8); 10] = [
        (&["LOAD", "LOADING"], 1),
        (&["BINARY", "SCALE"], 2),
        (&["GRID", "STAFF"], 3),
        (&["HEADERS", "CLEF"], 4),
        (&["HEADS", "STEM", "LEDGERS", "BEAMS", "ALTERATION", "KEY"], 5),
        (&["RHYTHMS", "REST", "FLAG", "DOT"], 6),
        (&["MEASURES", "TIME", "BARLINE"], 7),
        (&["TEXTS", "LYRIC"], 8),
        (&["EXPORT", "MUSICXML", ".MXL"], 9),
        (&["PAGE", "SCORE", "COMPLETED"], 10),
    ];
    table.iter().rev().find(|(keys, _)| keys.iter().any(|k| u.contains(k))).map(|(_, s)| *s)
}

fn find_mxl(dir: &Path) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().map(|x| x.eq_ignore_ascii_case("mxl")).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

fn find_ext(dir: &Path, ext: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_ext(&p, ext) {
                return Some(f);
            }
        } else if p.extension().and_then(|x| x.to_str()) == Some(ext) {
            return Some(p);
        }
    }
    None
}

/// Chạy Audiveris ở chế độ batch và trả về đường dẫn file .mxl kết quả.
/// `options`: các cặp `khoá=giá trị` truyền qua `-option` (dùng khi nhận dạng lại một vùng với cấu hình khác).
/// `job`: tên thư mục kết quả riêng, để nhiều lần chạy (theo vùng) không ghi đè nhau.
#[tauri::command]
pub async fn omr_run(app: AppHandle, input: String, options: Option<Vec<String>>, job: Option<String>, sheets: Option<String>) -> Result<OmrOutput, String> {
    let exe = find(&app).ok_or("Không tìm thấy Audiveris đóng gói kèm. Hãy cài lại Holy Melody.")?;
    let input = PathBuf::from(input);
    if !input.is_file() {
        return Err("Không tìm thấy file cần nhận dạng".into());
    }
    let job: String = job.unwrap_or_else(|| "main".into()).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let out_dir = std::env::temp_dir().join(format!("holy-melody-omr-{}-{job}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let tessdata = app.path().resource_dir().ok().map(|d| d.join("resources").join("tessdata")).filter(|d| d.join("vie.traineddata").is_file());
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&exe);
        cmd.env("JAVA_TOOL_OPTIONS", "-Djava.awt.headless=true");
        // dữ liệu OCR tiếng Việt + tiếng Anh đóng gói kèm (đọc lời ca)
        if let Some(t) = tessdata.as_ref() {
            cmd.env("TESSDATA_PREFIX", t);
        }
        for o in options.unwrap_or_default() {
            if o.contains('=') && !o.contains(char::is_whitespace) {
                // "const:khoá=giá trị" → -constant (vd ngôn ngữ OCR); còn lại → -option
                match o.strip_prefix("const:") {
                    Some(c) => cmd.arg("-constant").arg(c),
                    None => cmd.arg("-option").arg(o),
                };
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: không bật cửa sổ console
        }
        // chỉ nhận dạng một số trang (chạy song song nhiều tiến trình cho PDF nhiều trang)
        if let Some(sh) = sheets.as_deref().filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '-' || c == ' ')) {
            cmd.arg("-sheets");
            for part in sh.split_whitespace() {
                cmd.arg(part);
            }
        }
        let mut child = cmd
            .arg("-batch")
            .arg("-export")
            .arg("-save")
            .arg("-output")
            .arg(&out_dir)
            .arg("--")
            .arg(&input)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Không chạy được Audiveris: {e}"))?;
        let stderr = child.stderr.take();
        let app2 = app.clone();
        // stderr chạy luồng riêng để không bị nghẽn
        let err_thread = std::thread::spawn(move || {
            let mut tail = Vec::new();
            if let Some(s) = stderr {
                for line in BufReader::new(s).lines().map_while(Result::ok) {
                    if let Some(stage) = stage_of(&line) {
                        let _ = app2.emit("omr://progress", OmrProgress { stage, line: line.clone() });
                    }
                    tail.push(line);
                    if tail.len() > 40 {
                        tail.remove(0);
                    }
                }
            }
            tail
        });
        let mut tail: Vec<String> = Vec::new();
        if let Some(s) = child.stdout.take() {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                let stage = stage_of(&line).unwrap_or(0);
                let _ = app.emit("omr://progress", OmrProgress { stage, line: line.clone() });
                tail.push(line);
                if tail.len() > 40 {
                    tail.remove(0);
                }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        tail.extend(err_thread.join().unwrap_or_default());
        let mxl = find_mxl(&out_dir);
        match (status.success(), mxl) {
            (_, Some(p)) => {
                let _ = app.emit("omr://progress", OmrProgress { stage: 10, line: "Hoàn tất".into() });
                let omr = find_ext(&out_dir, "omr").map(|p| p.display().to_string());
                Ok(OmrOutput { mxl_path: p.display().to_string(), omr_path: omr, log_tail: tail })
            }
            (ok, None) => Err(format!(
                "Audiveris {} nhưng không tạo được MusicXML. Ảnh có thể quá mờ, nghiêng hoặc không phải bản nhạc.\n{}",
                if ok { "chạy xong" } else { "báo lỗi" },
                tail.iter().rev().take(6).cloned().collect::<Vec<_>>().join("\n")
            )),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn cache_keys() {
        let h = "a".repeat(64);
        assert!(super::valid_cache_key(&h));
        assert!(super::valid_cache_key(&format!("{h}-p12")));
        assert!(!super::valid_cache_key(&format!("{h}-p")));
        assert!(!super::valid_cache_key(&format!("{h}/../x")));
        assert!(!super::valid_cache_key("abc"));
    }

    use super::*;
    #[test]
    fn stages() {
        assert_eq!(stage_of("INFO  [GRID] staves detected"), Some(3));
        assert_eq!(stage_of("Exporting to song.mxl"), Some(9));
        assert_eq!(stage_of("nothing"), None);
    }
}

/// Đường dẫn tạm để ghi file người dùng kéo thả (WebView không cho biết đường dẫn gốc)
#[tauri::command]
pub fn omr_temp_input(name: String) -> String {
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
    let dir = std::env::temp_dir().join("holy-melody-input");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(safe).display().to_string()
}

// ---------------------------------------------------------------- bộ nhớ đệm kết quả nhận dạng
// Khoá = SHA-256 của file gốc: mở lại cùng một file là có ngay, không chạy lại Audiveris.

/// Khoá bộ đệm: SHA-256 của file gốc (64 hex), có thể kèm hậu tố trang "-p<số>" (kết quả từng trang, để mở lại tiếp tục được)
fn valid_cache_key(key: &str) -> bool {
    if !key.is_ascii() {
        return false;
    }
    let (hash, rest) = key.split_at(key.len().min(64));
    hash.len() == 64
        && hash.chars().all(|c| c.is_ascii_hexdigit())
        && (rest.is_empty() || (rest.len() <= 6 && rest.starts_with("-p") && rest.len() > 2 && rest[2..].chars().all(|c| c.is_ascii_digit())))
}

fn cache_file(app: &AppHandle, hash: &str) -> Result<PathBuf, String> {
    if !valid_cache_key(hash) {
        return Err("Mã băm không hợp lệ".into());
    }
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("omr");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{hash}-v2.json")))
}

#[tauri::command]
pub fn omr_cache_get(app: AppHandle, hash: String) -> Result<Option<String>, String> {
    let f = cache_file(&app, &hash)?;
    Ok(std::fs::read_to_string(f).ok())
}

#[tauri::command]
pub fn omr_cache_put(app: AppHandle, hash: String, json: String) -> Result<(), String> {
    let f = cache_file(&app, &hash)?;
    let tmp = f.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}
