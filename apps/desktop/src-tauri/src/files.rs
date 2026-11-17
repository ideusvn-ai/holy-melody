use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("Đường dẫn không hợp lệ")]
    InvalidPath,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for FileError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn checked(path: &str) -> Result<PathBuf, FileError> {
    let p = PathBuf::from(path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(FileError::InvalidPath);
    }
    Ok(p)
}

/// Ghi file nguyên tử: ghi ra file tạm rồi đổi tên, tránh hỏng file khi mất điện/crash.
/// Đường dẫn đến từ hộp thoại Save của hệ điều hành.
#[tauri::command]
pub fn write_file(path: String, contents: Vec<u8>) -> Result<(), FileError> {
    let p = checked(&path)?;
    let tmp = p.with_extension("hm-tmp");
    std::fs::write(&tmp, &contents)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

/// Trả về dữ liệu nhị phân thô (JS nhận ArrayBuffer) — nhanh hơn nhiều so với mảng số JSON với file lớn
#[tauri::command]
pub fn read_file(path: String) -> Result<tauri::ipc::Response, FileError> {
    Ok(tauri::ipc::Response::new(std::fs::read(checked(&path)?)?))
}

/// Ghi file từ dữ liệu nhị phân thô: `invoke('write_file_raw', bytes, { headers: { 'x-path': encodeURIComponent(path) } })`
#[tauri::command]
pub fn write_file_raw(request: tauri::ipc::Request<'_>) -> Result<(), FileError> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(FileError::InvalidPath);
    };
    let enc = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or(FileError::InvalidPath)?;
    let path = percent_decode(enc).ok_or(FileError::InvalidPath)?;
    let p = checked(&path)?;
    let tmp = p.with_extension("hm-tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn decode() {
        assert_eq!(super::percent_decode("C%3A%5CUsers%5Ct%C3%AAn%20b%C3%A0i.pdf").as_deref(), Some("C:\\Users\\tên bài.pdf"));
        assert_eq!(super::percent_decode("%zz"), None);
    }
}
