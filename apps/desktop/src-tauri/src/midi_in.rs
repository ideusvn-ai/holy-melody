//! Bàn phím MIDI ngoài (USB/Bluetooth) qua midir. Sự kiện được phát lên UI: `midi://in`.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct MidiState {
    conn: Mutex<Option<midir::MidiInputConnection<()>>>,
}

#[derive(Serialize, Clone)]
pub struct MidiMsg {
    status: u8,
    data1: u8,
    data2: u8,
}

#[tauri::command]
pub fn midi_list() -> Result<Vec<String>, String> {
    let input = midir::MidiInput::new("Holy Melody").map_err(|e| e.to_string())?;
    Ok(input.ports().iter().map(|p| input.port_name(p).unwrap_or_else(|_| "MIDI".into())).collect())
}

#[tauri::command]
pub fn midi_connect(app: AppHandle, state: State<MidiState>, index: usize) -> Result<String, String> {
    let mut input = midir::MidiInput::new("Holy Melody").map_err(|e| e.to_string())?;
    input.ignore(midir::Ignore::All);
    let ports = input.ports();
    let port = ports.get(index).ok_or("Không tìm thấy thiết bị MIDI")?;
    let name = input.port_name(port).unwrap_or_else(|_| "MIDI".into());
    let conn = input
        .connect(
            port,
            "holy-melody-in",
            move |_stamp, msg, _| {
                if msg.len() >= 2 {
                    let _ = app.emit("midi://in", MidiMsg { status: msg[0], data1: msg[1], data2: *msg.get(2).unwrap_or(&0) });
                }
            },
            (),
        )
        .map_err(|e| e.to_string())?;
    *state.conn.lock().map_err(|e| e.to_string())? = Some(conn);
    Ok(name)
}

#[tauri::command]
pub fn midi_disconnect(state: State<MidiState>) -> Result<(), String> {
    if let Some(c) = state.conn.lock().map_err(|e| e.to_string())?.take() {
        c.close();
    }
    Ok(())
}
