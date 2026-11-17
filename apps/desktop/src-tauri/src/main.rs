// Ẩn cửa sổ console trên Windows bản release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    holy_melody_lib::run()
}
