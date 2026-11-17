//! Lõi Rust của Holy Melody: lưu dự án (SQLite), ghi file, PKCE cho đăng nhập Google,
//! và (Phase 2) engine âm thanh rustysynth + cpal.

mod audio;
mod audio_cmds;
mod auth;
mod files;
mod project_store;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub store: Mutex<project_store::ProjectStore>,
}

/// In nội dung cửa sổ (hộp thoại in của hệ điều hành → có thể lưu PDF)
#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = project_store::ProjectStore::open(&dir.join("projects.sqlite3"))?;
            app.manage(AppState { store: Mutex::new(store) });
            // Engine âm thanh: SoundFont đóng gói trong resources/
            let audio = std::sync::Arc::new(audio_cmds::AudioState::default());
            app.manage(audio.clone());
            match app.path().resolve("resources/GeneralUser-GS.sf2", tauri::path::BaseDirectory::Resource) {
                Ok(p) if p.exists() => audio_cmds::init(audio, p),
                _ => *audio.error.lock().unwrap() = Some("Chưa có SoundFont (resources/GeneralUser-GS.sf2)".into()),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_cmds::playback_engine_available,
            audio_cmds::playback_engine_info,
            audio_cmds::playback_load,
            audio_cmds::playback_play,
            audio_cmds::playback_pause,
            audio_cmds::playback_stop,
            audio_cmds::playback_seek,
            audio_cmds::playback_set_speed,
            audio_cmds::playback_set_loop,
            audio_cmds::playback_set_metronome,
            audio_cmds::playback_set_count_in,
            audio_cmds::playback_set_master,
            audio_cmds::playback_set_channel,
            audio_cmds::playback_preview,
            audio_cmds::playback_status,
            audio_cmds::export_wav,
            print_page,
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
