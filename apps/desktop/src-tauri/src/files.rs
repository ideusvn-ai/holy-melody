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

#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, FileError> {
    Ok(std::fs::read(checked(&path)?)?)
}
