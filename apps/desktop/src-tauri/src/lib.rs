//! Lõi Rust của Holy Melody: lưu dự án (SQLite), ghi file, PKCE cho đăng nhập Google,
//! và (Phase 2) engine âm thanh rustysynth + cpal.

mod auth;
mod files;
mod project_store;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub store: Mutex<project_store::ProjectStore>,
}

/// Engine âm thanh native chưa có ở Phase 1 → UI dùng Web Audio.
#[tauri::command]
fn playback_engine_available() -> bool {
    false
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = project_store::ProjectStore::open(&dir.join("projects.sqlite3"))?;
            app.manage(AppState { store: Mutex::new(store) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            playback_engine_available,
            files::write_file,
            files::read_file,
            project_store::project_autosave,
            project_store::project_recover_list,
            project_store::project_versions,
            project_store::project_load_version,
            auth::auth_pkce_begin,
        ])
        .run(tauri::generate_context!())
        .expect("không khởi động được Holy Melody");
}
