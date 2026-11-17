//! Nhận dạng bản nhạc (OMR) bằng Audiveris chạy như một chương trình độc lập do người dùng cài
//! (AGPL-3.0 → không nhúng vào Holy Melody). Tiến trình được báo về UI qua sự kiện `omr://progress`.
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OmrEngineInfo {
    found: bool,
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
    log_tail: Vec<String>,
}

const DOWNLOAD: &str = "https://github.com/Audiveris/audiveris/releases";

fn candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("HM_AUDIVERIS") {
        v.push(PathBuf::from(p));
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

fn find() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}

#[tauri::command]
pub fn omr_detect() -> OmrEngineInfo {
    let p = find();
    OmrEngineInfo { found: p.is_some(), path: p.map(|p| p.display().to_string()), download_url: DOWNLOAD }
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

/// Chạy Audiveris ở chế độ batch và trả về đường dẫn file .mxl kết quả
#[tauri::command]
pub async fn omr_run(app: AppHandle, input: String) -> Result<OmrOutput, String> {
    let exe = find().ok_or("Chưa cài Audiveris. Tải miễn phí tại github.com/Audiveris/audiveris/releases rồi thử lại.")?;
    let input = PathBuf::from(input);
    if !input.is_file() {
        return Err("Không tìm thấy file cần nhận dạng".into());
    }
    let out_dir = std::env::temp_dir().join(format!("holy-melody-omr-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out_dir);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&exe)
            .arg("-batch")
            .arg("-export")
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
                Ok(OmrOutput { mxl_path: p.display().to_string(), log_tail: tail })
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
