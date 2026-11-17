//! Lệnh IPC cho engine âm thanh. Engine khởi động nền khi mở app; nếu thiếu SoundFont hoặc
//! thiết bị âm thanh, `playback_engine_available` trả false và UI dùng Web Audio.
use crate::audio::{Engine, LoadArgs, Status};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Default)]
pub struct AudioState {
    pub engine: Mutex<Option<Arc<Engine>>>,
    pub error: Mutex<Option<String>>,
    pub soundfont: Mutex<Option<String>>,
}

impl AudioState {
    fn get(&self) -> Result<Arc<Engine>, String> {
        self.engine
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| self.error.lock().ok().and_then(|e| e.clone()).unwrap_or_else(|| "Engine âm thanh chưa sẵn sàng".into()))
    }
}

/// Khởi động engine ở luồng nền để không chặn mở cửa sổ
pub fn init(state: Arc<AudioState>, sf_path: PathBuf) {
    std::thread::spawn(move || {
        let res = crate::audio::load_soundfont(&sf_path).and_then(Engine::start);
        match res {
            Ok(e) => {
                *state.soundfont.lock().unwrap() = Some(sf_path.display().to_string());
                *state.engine.lock().unwrap() = Some(Arc::new(e));
            }
            Err(e) => {
                eprintln!("[holy-melody] engine âm thanh: {e}");
                *state.error.lock().unwrap() = Some(e);
            }
        }
    });
}

type S<'a> = State<'a, Arc<AudioState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    available: bool,
    error: Option<String>,
    sample_rate: Option<u32>,
    soundfont: Option<String>,
}

#[tauri::command]
pub fn playback_engine_available(state: S) -> bool {
    state.engine.lock().map(|e| e.is_some()).unwrap_or(false)
}

#[tauri::command]
pub fn playback_engine_info(state: S) -> EngineInfo {
    let e = state.engine.lock().ok().and_then(|e| e.clone());
    EngineInfo {
        available: e.is_some(),
        error: state.error.lock().ok().and_then(|x| x.clone()),
        sample_rate: e.map(|e| e.sample_rate),
        soundfont: state.soundfont.lock().ok().and_then(|x| x.clone()),
    }
}

#[tauri::command]
pub fn playback_load(state: S, args: LoadArgs) -> Result<(), String> {
    state.get()?.load(args);
    Ok(())
}
#[tauri::command]
pub fn playback_play(state: S, from: Option<f64>) -> Result<(), String> {
    state.get()?.play(from);
    Ok(())
}
#[tauri::command]
pub fn playback_pause(state: S) -> Result<(), String> {
    state.get()?.pause();
    Ok(())
}
#[tauri::command]
pub fn playback_stop(state: S) -> Result<(), String> {
    state.get()?.stop();
    Ok(())
}
#[tauri::command]
pub fn playback_seek(state: S, tick: f64) -> Result<(), String> {
    state.get()?.seek(tick);
    Ok(())
}
#[tauri::command]
pub fn playback_set_speed(state: S, speed: f64) -> Result<(), String> {
    state.get()?.set_speed(speed);
    Ok(())
}
#[tauri::command]
pub fn playback_set_loop(state: S, from: Option<f64>, to: Option<f64>) -> Result<(), String> {
    state.get()?.set_loop(from.zip(to));
    Ok(())
}
#[tauri::command]
pub fn playback_set_metronome(state: S, on: bool) -> Result<(), String> {
    state.get()?.set_metronome(on);
    Ok(())
}
#[tauri::command]
pub fn playback_set_count_in(state: S, bars: u32) -> Result<(), String> {
    state.get()?.set_count_in(bars);
    Ok(())
}
#[tauri::command]
pub fn playback_set_master(state: S, volume: f32) -> Result<(), String> {
    state.get()?.set_master(volume);
    Ok(())
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn playback_set_channel(
    state: S, channel: u8, volume: Option<f32>, pan: Option<f32>, reverb: Option<f32>, chorus: Option<f32>, mute: Option<bool>, solo: Option<bool>,
) -> Result<(), String> {
    state.get()?.set_channel(channel, volume, pan, reverb, chorus, mute, solo);
    Ok(())
}
#[tauri::command]
pub fn playback_preview(state: S, pitch: u8, velocity: u8, ms: u32, program: u8) -> Result<(), String> {
    state.get()?.preview(pitch, velocity, ms, program);
    Ok(())
}
#[tauri::command]
pub fn playback_status(state: S) -> Result<Status, String> {
    Ok(state.get()?.status())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerArg {
    channel: u8,
    volume: f32,
    pan: f32,
    mute: bool,
}

/// Xuất WAV (render offline, không chặn luồng phát). Trả về độ dài giây.
#[tauri::command]
pub async fn export_wav(state: S<'_>, path: String, args: LoadArgs, mixer: Vec<MixerArg>) -> Result<f64, String> {
    let engine = state.get()?;
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("Đường dẫn không hợp lệ".into());
    }
    let mix: Vec<(u8, f32, f32, bool)> = mixer.iter().map(|m| (m.channel, m.volume, m.pan, m.mute)).collect();
    tauri::async_runtime::spawn_blocking(move || engine.export_wav(args, &p, &mix))
        .await
        .map_err(|e| e.to_string())?
}
