//! Autosave, khôi phục sau crash và lịch sử phiên bản cục bộ (SQLite).
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;
use tauri::State;

use crate::AppState;

pub struct ProjectStore {
    conn: Connection,
}

/// Giữ tối đa bấy nhiêu phiên bản cho mỗi dự án
const MAX_VERSIONS: i64 = 50;

impl ProjectStore {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS projects (
               id TEXT PRIMARY KEY,
               title TEXT NOT NULL,
               file_path TEXT,
               clean_shutdown INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS project_versions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               revision INTEGER NOT NULL,
               score_json TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_versions_project ON project_versions(project_id, id DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn autosave(&mut self, id: &str, title: &str, file_path: Option<&str>, revision: i64, score_json: &str) -> rusqlite::Result<()> {
        let now = now();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO projects(id, title, file_path, clean_shutdown, updated_at) VALUES (?1, ?2, ?3, 0, ?4)
             ON CONFLICT(id) DO UPDATE SET title=excluded.title, file_path=COALESCE(excluded.file_path, projects.file_path),
               clean_shutdown=0, updated_at=excluded.updated_at",
            params![id, title, file_path, now],
        )?;
        // Không lưu trùng revision liên tiếp
        let last: Option<i64> = tx
            .query_row("SELECT revision FROM project_versions WHERE project_id=?1 ORDER BY id DESC LIMIT 1", params![id], |r| r.get(0))
            .ok();
        if last != Some(revision) {
            tx.execute(
                "INSERT INTO project_versions(project_id, revision, score_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, revision, score_json, now],
            )?;
            tx.execute(
                "DELETE FROM project_versions WHERE project_id=?1 AND id NOT IN
                   (SELECT id FROM project_versions WHERE project_id=?1 ORDER BY id DESC LIMIT ?2)",
                params![id, MAX_VERSIONS],
            )?;
        }
        tx.commit()
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Serialize)]
pub struct RecoverItem {
    id: String,
    title: String,
    updated_at: i64,
}

#[derive(Serialize)]
pub struct VersionItem {
    id: i64,
    revision: i64,
    created_at: i64,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn project_autosave(state: State<AppState>, id: String, title: String, file_path: Option<String>, revision: i64, score_json: String) -> Result<(), String> {
    state.store.lock().map_err(err)?.autosave(&id, &title, file_path.as_deref(), revision, &score_json).map_err(err)
}

/// Dự án chưa đóng sạch (ứng dụng bị crash) → đề nghị khôi phục khi mở lại
#[tauri::command]
pub fn project_recover_list(state: State<AppState>) -> Result<Vec<RecoverItem>, String> {
    let s = state.store.lock().map_err(err)?;
    let mut stmt = s.conn.prepare("SELECT id, title, updated_at FROM projects WHERE clean_shutdown=0 ORDER BY updated_at DESC").map_err(err)?;
    let rows = stmt
        .query_map([], |r| Ok(RecoverItem { id: r.get(0)?, title: r.get(1)?, updated_at: r.get(2)? }))
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

#[tauri::command]
pub fn project_versions(state: State<AppState>, id: String) -> Result<Vec<VersionItem>, String> {
    let s = state.store.lock().map_err(err)?;
    let mut stmt = s.conn.prepare("SELECT id, revision, created_at FROM project_versions WHERE project_id=?1 ORDER BY id DESC").map_err(err)?;
    let rows = stmt
        .query_map(params![id], |r| Ok(VersionItem { id: r.get(0)?, revision: r.get(1)?, created_at: r.get(2)? }))
        .map_err(err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(err)
}

#[tauri::command]
pub fn project_load_version(state: State<AppState>, version_id: i64) -> Result<String, String> {
    let s = state.store.lock().map_err(err)?;
    s.conn.query_row("SELECT score_json FROM project_versions WHERE id=?1", params![version_id], |r| r.get(0)).map_err(err)
}
