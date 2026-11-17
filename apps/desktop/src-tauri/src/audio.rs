//! Engine âm thanh native: rustysynth (SoundFont, MIT) + cpal (CoreAudio / WASAPI / ALSA).
//!
//! - Chạy trên audio thread riêng; vị trí phát là số sample đã render (audio clock thật).
//! - Sự kiện được điều phối theo khối 64 sample (~1,5 ms ở 44,1 kHz).
//! - Tốc độ phát thay đổi nhịp độ, không đổi cao độ (MIDI).
//! - Xuất WAV bằng render offline với cùng SoundFont.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufReader, Write};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};

const BLOCK: usize = 64;
const DRUM_CH: i32 = 9;
const PREVIEW_CH: i32 = 15;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteEv {
    pub tick: u32,
    pub duration_ticks: u32,
    pub channel: u8,
    pub program: u8,
    pub pitch: u8,
    pub velocity: u8,
}

#[derive(Deserialize, Clone, Debug)]
pub struct TempoPt {
    pub tick: u32,
    pub bpm: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BeatPt {
    pub tick: u32,
    pub downbeat: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LoadArgs {
    pub ticks_per_quarter: u32,
    pub total_ticks: u32,
    pub notes: Vec<NoteEv>,
    pub tempo: Vec<TempoPt>,
    pub beats: Vec<BeatPt>,
}

#[derive(Clone, Copy, Debug)]
enum Ev {
    Program { ch: i32, prog: i32 },
    On { ch: i32, key: i32, vel: i32 },
    Off { ch: i32, key: i32 },
}

#[derive(Clone, Copy)]
struct Chan {
    volume: f32,
    pan: f32,
    reverb: f32,
    chorus: f32,
    mute: bool,
    solo: bool,
}

impl Default for Chan {
    fn default() -> Self {
        Chan { volume: 0.8, pan: 0.0, reverb: 0.2, chorus: 0.0, mute: false, solo: false }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub tick: f64,
    pub playing: bool,
    pub ended: bool,
    pub counting_in: bool,
    pub output_latency_ms: f64,
    pub sample_rate: u32,
}

struct Inner {
    synth: Synthesizer,
    sample_rate: f64,
    events: Vec<(f64, Ev)>,
    next: usize,
    tempo: Vec<TempoPt>,
    tpq: f64,
    total: f64,
    beats: Vec<BeatPt>,
    next_beat: usize,
    pos: f64,
    playing: bool,
    ended: bool,
    speed: f64,
    loop_range: Option<(f64, f64)>,
    metronome: bool,
    count_in_bars: u32,
    /// sample còn phải chờ (count-in) trước khi bắt đầu chạy vị trí
    count_in_left: u64,
    count_in_clicks: Vec<(u64, bool)>,
    sample_clock: u64,
    pending_offs: Vec<(u64, i32, i32)>,
    chans: [Chan; 16],
    master: f32,
    /// Hệ số của bộ giới hạn đỉnh (1.0 = không giảm)
    limiter_gain: f32,
    left: Vec<f32>,
    right: Vec<f32>,
}

/// Ngưỡng đỉnh của bộ giới hạn: chừa khoảng trống để không bao giờ vỡ tiếng
const LIMIT_CEILING: f32 = 0.89;

/// Bộ giới hạn đỉnh mềm: giảm NGAY khi đỉnh vượt ngưỡng (không vỡ tiếng), hồi CHẬM (~0,8 giây) để không
/// tạo cảm giác âm lượng "nhấp nhô". Hệ số chuyển mượt trong mỗi khối để không gây tiếng lách tách.
fn limit_block(left: &mut [f32], right: &mut [f32], gain: &mut f32, sample_rate: f64) {
    let n = left.len();
    if n == 0 {
        return;
    }
    let peak = left.iter().chain(right.iter()).fold(0f32, |m, s| m.max(s.abs()));
    let target = if peak * *gain > LIMIT_CEILING { LIMIT_CEILING / peak.max(1e-6) } else { *gain };
    let release = (-(n as f64) / (0.8 * sample_rate)).exp() as f32;
    let next = if target < *gain { target } else { 1.0 - (1.0 - *gain) * release };
    let next = next.clamp(0.05, 1.0);
    let start = *gain;
    for i in 0..n {
        let g = start + (next - start) * (i as f32 + 1.0) / n as f32;
        // không để mẫu nào vượt ngưỡng kể cả trong đoạn chuyển
        left[i] = (left[i] * g).clamp(-LIMIT_CEILING, LIMIT_CEILING);
        right[i] = (right[i] * g).clamp(-LIMIT_CEILING, LIMIT_CEILING);
    }
    *gain = next;
}

impl Inner {
    fn new(sf: &Arc<SoundFont>, sample_rate: u32) -> Result<Self, String> {
        let settings = SynthesizerSettings::new(sample_rate as i32);
        let synth = Synthesizer::new(sf, &settings).map_err(|e| format!("{e:?}"))?;
        Ok(Inner {
            synth,
            sample_rate: sample_rate as f64,
            events: Vec::new(),
            next: 0,
            tempo: vec![TempoPt { tick: 0, bpm: 100.0 }],
            tpq: 480.0,
            total: 0.0,
            beats: Vec::new(),
            next_beat: 0,
            pos: 0.0,
            playing: false,
            ended: false,
            speed: 1.0,
            loop_range: None,
            metronome: false,
            count_in_bars: 0,
            count_in_left: 0,
            count_in_clicks: Vec::new(),
            sample_clock: 0,
            pending_offs: Vec::new(),
            chans: [Chan::default(); 16],
            master: 0.8,
            limiter_gain: 1.0,
            left: vec![0.0; BLOCK],
            right: vec![0.0; BLOCK],
        })
    }

    fn load(&mut self, a: LoadArgs) {
        self.stop_sound();
        self.tpq = a.ticks_per_quarter.max(1) as f64;
        self.total = a.total_ticks as f64;
        self.tempo = if a.tempo.is_empty() { vec![TempoPt { tick: 0, bpm: 100.0 }] } else { a.tempo };
        self.beats = a.beats;
        self.events = build_events(&a.notes);
        self.apply_all_channels();
        let pos = self.pos.min(self.total);
        self.seek(pos);
    }

    fn bpm_at(&self, tick: f64) -> f64 {
        let mut bpm = self.tempo[0].bpm;
        for t in &self.tempo {
            if (t.tick as f64) <= tick {
                bpm = t.bpm;
            } else {
                break;
            }
        }
        bpm.clamp(10.0, 1000.0)
    }

    fn ticks_per_sample(&self) -> f64 {
        self.bpm_at(self.pos) / 60.0 * self.tpq / self.sample_rate * self.speed
    }

    fn seek(&mut self, tick: f64) {
        self.stop_sound();
        self.pos = tick.max(0.0);
        self.next = self.events.partition_point(|(t, _)| *t < self.pos);
        self.next_beat = self.beats.partition_point(|b| (b.tick as f64) < self.pos);
        // gửi lại program change đã qua để kênh có đúng nhạc cụ
        let progs: Vec<Ev> = self.events.iter().filter(|(_, e)| matches!(e, Ev::Program { .. })).map(|(_, e)| *e).collect();
        for e in progs {
            self.dispatch(e);
        }
        self.ended = false;
    }

    fn stop_sound(&mut self) {
        self.synth.note_off_all(false);
        self.pending_offs.clear();
    }

    fn dispatch(&mut self, e: Ev) {
        match e {
            Ev::Program { ch, prog } => self.synth.process_midi_message(ch, 0xC0, prog, 0),
            Ev::On { ch, key, vel } => {
                if self.audible(ch) {
                    self.synth.note_on(ch, key, vel)
                }
            }
            Ev::Off { ch, key } => self.synth.note_off(ch, key),
        }
    }

    fn audible(&self, ch: i32) -> bool {
        if ch == DRUM_CH || ch == PREVIEW_CH {
            return true;
        }
        let any_solo = self.chans.iter().any(|c| c.solo);
        let c = self.chans[(ch as usize).min(15)];
        !c.mute && (!any_solo || c.solo)
    }

    fn apply_channel(&mut self, ch: usize) {
        let c = self.chans[ch];
        let cc = |v: f32| ((v.clamp(0.0, 1.0)) * 127.0).round() as i32;
        self.synth.process_midi_message(ch as i32, 0xB0, 7, cc(c.volume));
        self.synth.process_midi_message(ch as i32, 0xB0, 10, cc((c.pan + 1.0) / 2.0));
        self.synth.process_midi_message(ch as i32, 0xB0, 91, cc(c.reverb));
        self.synth.process_midi_message(ch as i32, 0xB0, 93, cc(c.chorus));
    }

    fn apply_all_channels(&mut self) {
        for ch in 0..16 {
            if ch != DRUM_CH as usize {
                self.apply_channel(ch);
            }
        }
    }

    fn click(&mut self, downbeat: bool) {
        let key = if downbeat { 76 } else { 77 };
        self.synth.note_on(DRUM_CH, key, if downbeat { 120 } else { 95 });
        let off_at = self.sample_clock + (self.sample_rate * 0.08) as u64;
        self.pending_offs.push((off_at, DRUM_CH, key));
    }

    /// Render một khối; trả về true nếu vừa phát hết bài
    fn render_block(&mut self, frames: usize) -> bool {
        let mut finished = false;
        let block_end_clock = self.sample_clock + frames as u64;
        // tắt các nốt hẹn giờ (click, nốt nghe thử)
        let mut i = 0;
        while i < self.pending_offs.len() {
            let (due, ch, key) = self.pending_offs[i];
            if due < block_end_clock {
                self.synth.note_off(ch, key);
                self.pending_offs.swap_remove(i);
            } else {
                i += 1;
            }
        }
        if self.playing {
            if self.count_in_left > 0 {
                let clicks: Vec<(u64, bool)> = self.count_in_clicks.iter().copied().filter(|(at, _)| *at < block_end_clock).collect();
                self.count_in_clicks.retain(|(at, _)| *at >= block_end_clock);
                for (_, down) in clicks {
                    self.click(down);
                }
                self.count_in_left = self.count_in_left.saturating_sub(frames as u64);
            } else {
                let tps = self.ticks_per_sample();
                let end = self.pos + tps * frames as f64;
                while self.next < self.events.len() && self.events[self.next].0 < end {
                    let e = self.events[self.next].1;
                    self.dispatch(e);
                    self.next += 1;
                }
                if self.metronome {
                    while self.next_beat < self.beats.len() && (self.beats[self.next_beat].tick as f64) < end {
                        let down = self.beats[self.next_beat].downbeat;
                        self.click(down);
                        self.next_beat += 1;
                    }
                }
                self.pos = end;
                let stop_at = self.loop_range.map(|(_, b)| b).unwrap_or(self.total);
                if self.pos >= stop_at {
                    if let Some((a, _)) = self.loop_range {
                        self.seek(a);
                    } else {
                        self.playing = false;
                        self.ended = true;
                        self.synth.note_off_all(false);
                        self.pos = self.total;
                        finished = true;
                    }
                }
            }
        }
        let (l, r) = (&mut self.left[..frames], &mut self.right[..frames]);
        self.synth.render(l, r);
        if self.master != 1.0 {
            for s in self.left[..frames].iter_mut().chain(self.right[..frames].iter_mut()) {
                *s *= self.master;
            }
        }
        let sr = self.sample_rate;
        limit_block(&mut self.left[..frames], &mut self.right[..frames], &mut self.limiter_gain, sr);
        self.sample_clock = block_end_clock;
        finished
    }

    fn start(&mut self, from: Option<f64>) {
        if let Some(t) = from {
            self.seek(t);
        } else if self.ended || self.pos >= self.total {
            let start = self.loop_range.map(|(a, _)| a).unwrap_or(0.0);
            self.seek(start);
        }
        self.count_in_clicks.clear();
        self.count_in_left = 0;
        if self.count_in_bars > 0 {
            // phách theo số chỉ nhịp tại vị trí bắt đầu
            let beats_per_bar = self.beats_per_bar_at(self.pos);
            let beat_sec = 60.0 / self.bpm_at(self.pos) / self.speed;
            let n = beats_per_bar * self.count_in_bars;
            for k in 0..n {
                let at = self.sample_clock + (k as f64 * beat_sec * self.sample_rate) as u64;
                self.count_in_clicks.push((at, k % beats_per_bar == 0));
            }
            self.count_in_left = (n as f64 * beat_sec * self.sample_rate) as u64;
        }
        self.playing = true;
        self.ended = false;
    }

    fn beats_per_bar_at(&self, tick: f64) -> u32 {
        // đếm số phách từ phách mạnh gần nhất tới phách mạnh tiếp theo
        let idx = self.beats.partition_point(|b| (b.tick as f64) <= tick).saturating_sub(1);
        let mut start = idx;
        while start > 0 && !self.beats[start].downbeat {
            start -= 1;
        }
        let mut n = 1;
        while start + n < self.beats.len() && !self.beats[start + n].downbeat {
            n += 1;
        }
        (n as u32).clamp(1, 16)
    }
}

fn build_events(notes: &[NoteEv]) -> Vec<(f64, Ev)> {
    let mut ev: Vec<(f64, u8, Ev)> = Vec::with_capacity(notes.len() * 2 + 16);
    let mut seen = [false; 16];
    for n in notes {
        let ch = (n.channel & 15) as usize;
        if !seen[ch] && ch != DRUM_CH as usize {
            seen[ch] = true;
            ev.push((0.0, 0, Ev::Program { ch: ch as i32, prog: n.program as i32 }));
        }
    }
    for n in notes {
        let ch = (n.channel & 15) as i32;
        ev.push((n.tick as f64, 2, Ev::On { ch, key: n.pitch as i32, vel: n.velocity.max(1) as i32 }));
        // tắt sớm 1 tick để nốt lặp lại cùng cao độ không bị nuốt
        let off = (n.tick + n.duration_ticks.max(2) - 1) as f64;
        ev.push((off, 1, Ev::Off { ch, key: n.pitch as i32 }));
    }
    // cùng thời điểm: program → note off → note on
    ev.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
    ev.into_iter().map(|(t, _, e)| (t, e)).collect()
}

// ====================================================================== engine + luồng âm thanh

pub struct Engine {
    inner: Arc<Mutex<Inner>>,
    sf: Arc<SoundFont>,
    pub sample_rate: u32,
    latency_ms: f64,
}

pub fn load_soundfont(path: &Path) -> Result<Arc<SoundFont>, String> {
    let f = File::open(path).map_err(|e| format!("Không mở được SoundFont {}: {e}", path.display()))?;
    let mut r = BufReader::new(f);
    let sf = SoundFont::new(&mut r).map_err(|e| format!("SoundFont lỗi: {e:?}"))?;
    Ok(Arc::new(sf))
}

impl Engine {
    /// Mở thiết bị âm thanh mặc định và chạy luồng phát (stream được giữ sống trong luồng riêng).
    pub fn start(sf: Arc<SoundFont>) -> Result<Engine, String> {
        let (tx, rx) = mpsc::channel::<Result<(Arc<Mutex<Inner>>, u32, f64), String>>();
        let sf2 = sf.clone();
        std::thread::Builder::new()
            .name("hm-audio".into())
            .spawn(move || {
                let res = (|| -> Result<(cpal::Stream, Arc<Mutex<Inner>>, u32, f64), String> {
                    let host = cpal::default_host();
                    let device = host.default_output_device().ok_or("Không tìm thấy thiết bị phát âm thanh")?;
                    let supported = device.default_output_config().map_err(|e| e.to_string())?;
                    let fmt = supported.sample_format();
                    let config: cpal::StreamConfig = supported.into();
                    let sr = config.sample_rate.0;
                    let inner = Arc::new(Mutex::new(Inner::new(&sf2, sr)?));
                    let stream = match fmt {
                        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, inner.clone()),
                        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, inner.clone()),
                        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, inner.clone()),
                        cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, inner.clone()),
                        other => Err(format!("Định dạng âm thanh chưa hỗ trợ: {other:?}")),
                    }?;
                    stream.play().map_err(|e| e.to_string())?;
                    // ước lượng độ trễ đầu ra ~ 2 bộ đệm mặc định
                    let latency = 2.0 * 512.0 / sr as f64 * 1000.0;
                    Ok((stream, inner, sr, latency))
                })();
                match res {
                    Ok((stream, inner, sr, latency)) => {
                        let _ = tx.send(Ok((inner, sr, latency)));
                        let _keep = stream;
                        loop {
                            std::thread::park();
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let (inner, sample_rate, latency_ms) = rx.recv().map_err(|e| e.to_string())??;
        Ok(Engine { inner, sf, sample_rate, latency_ms })
    }

    fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g)
    }

    pub fn load(&self, a: LoadArgs) {
        self.with(|i| i.load(a));
    }
    pub fn play(&self, from: Option<f64>) {
        self.with(|i| i.start(from));
    }
    pub fn pause(&self) {
        self.with(|i| {
            i.playing = false;
            i.count_in_left = 0;
            i.stop_sound();
        });
    }
    pub fn stop(&self) {
        self.with(|i| {
            i.playing = false;
            let a = i.loop_range.map(|(a, _)| a).unwrap_or(0.0);
            i.seek(a);
        });
    }
    pub fn seek(&self, tick: f64) {
        self.with(|i| i.seek(tick));
    }
    pub fn set_speed(&self, s: f64) {
        self.with(|i| i.speed = s.clamp(0.25, 4.0));
    }
    pub fn set_loop(&self, r: Option<(f64, f64)>) {
        self.with(|i| i.loop_range = r.filter(|(a, b)| b > a));
    }
    pub fn set_metronome(&self, on: bool) {
        self.with(|i| i.metronome = on);
    }
    pub fn set_count_in(&self, bars: u32) {
        self.with(|i| i.count_in_bars = bars.min(4));
    }
    pub fn set_master(&self, v: f32) {
        self.with(|i| i.master = v.clamp(0.0, 1.5));
    }
    pub fn set_channel(&self, ch: u8, volume: Option<f32>, pan: Option<f32>, reverb: Option<f32>, chorus: Option<f32>, mute: Option<bool>, solo: Option<bool>) {
        self.with(|i| {
            let c = &mut i.chans[(ch & 15) as usize];
            if let Some(v) = volume { c.volume = v; }
            if let Some(v) = pan { c.pan = v; }
            if let Some(v) = reverb { c.reverb = v; }
            if let Some(v) = chorus { c.chorus = v; }
            if let Some(v) = mute { c.mute = v; }
            if let Some(v) = solo { c.solo = v; }
            i.apply_channel((ch & 15) as usize);
            // tắt ngay nốt đang kêu của kênh bị tắt tiếng
            if !i.audible(ch as i32) {
                i.synth.process_midi_message(ch as i32, 0xB0, 123, 0);
            }
        });
    }
    pub fn preview(&self, pitch: u8, velocity: u8, ms: u32, program: u8) {
        self.with(|i| {
            i.synth.process_midi_message(PREVIEW_CH, 0xC0, program as i32, 0);
            i.synth.note_on(PREVIEW_CH, pitch as i32, velocity as i32);
            let due = i.sample_clock + (i.sample_rate * ms as f64 / 1000.0) as u64;
            i.pending_offs.push((due, PREVIEW_CH, pitch as i32));
        });
    }
    pub fn status(&self) -> Status {
        let lat = self.latency_ms;
        let sr = self.sample_rate;
        self.with(|i| Status { tick: i.pos, playing: i.playing, ended: i.ended, counting_in: i.count_in_left > 0, output_latency_ms: lat, sample_rate: sr })
    }

    /// Render offline ra WAV PCM 16-bit stereo
    pub fn export_wav(&self, a: LoadArgs, path: &Path, mixer: &[(u8, f32, f32, bool)]) -> Result<f64, String> {
        let sr = 44_100u32;
        let mut inner = Inner::new(&self.sf, sr)?;
        for &(ch, vol, pan, mute) in mixer {
            let c = &mut inner.chans[(ch & 15) as usize];
            c.volume = vol;
            c.pan = pan;
            c.mute = mute;
        }
        inner.load(a);
        inner.master = 1.0;
        inner.start(Some(0.0));
        inner.count_in_left = 0;
        inner.count_in_clicks.clear();
        let mut pcm: Vec<i16> = Vec::new();
        let tail = (sr as f64 * 2.5) as usize; // ngân đuôi reverb
        let mut tail_left = tail;
        loop {
            let done = !inner.playing;
            inner.render_block(BLOCK);
            for k in 0..BLOCK {
                pcm.push((inner.left[k].clamp(-1.0, 1.0) * 32767.0) as i16);
                pcm.push((inner.right[k].clamp(-1.0, 1.0) * 32767.0) as i16);
            }
            if done {
                if tail_left <= BLOCK {
                    break;
                }
                tail_left -= BLOCK;
            }
            if pcm.len() > sr as usize * 2 * 60 * 30 {
                return Err("Bài quá dài (> 30 phút)".into());
            }
        }
        write_wav(path, sr, &pcm).map_err(|e| e.to_string())?;
        Ok(pcm.len() as f64 / 2.0 / sr as f64)
    }
}

fn build_stream<T>(device: &cpal::Device, config: &cpal::StreamConfig, inner: Arc<Mutex<Inner>>) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                let frames_total = data.len() / channels;
                let mut g = match inner.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                let mut written = 0;
                while written < frames_total {
                    let n = BLOCK.min(frames_total - written);
                    g.render_block(n);
                    for k in 0..n {
                        let (l, r) = (g.left[k], g.right[k]);
                        let base = (written + k) * channels;
                        for c in 0..channels {
                            let v = if c % 2 == 0 { l } else { r };
                            data[base + c] = T::from_sample(v);
                        }
                    }
                    written += n;
                }
            },
            |err| eprintln!("[holy-melody] lỗi luồng âm thanh: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}

fn write_wav(path: &Path, sr: u32, pcm: &[i16]) -> std::io::Result<()> {
    let mut f = std::io::BufWriter::new(File::create(path)?);
    let data_len = (pcm.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?; // PCM
    f.write_all(&2u16.to_le_bytes())?; // stereo
    f.write_all(&sr.to_le_bytes())?;
    f.write_all(&(sr * 4).to_le_bytes())?;
    f.write_all(&4u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for s in pcm {
        f.write_all(&s.to_le_bytes())?;
    }
    f.flush()
}

#[cfg(test)]
mod limiter_tests {
    use super::*;
    #[test]
    fn never_exceeds_ceiling_and_recovers() {
        let mut g = 1.0;
        let mut l = vec![2.0f32; 256];
        let mut r = vec![-2.0f32; 256];
        limit_block(&mut l, &mut r, &mut g, 48000.0);
        assert!(l.iter().chain(r.iter()).all(|s| s.abs() <= LIMIT_CEILING + 1e-6));
        // tín hiệu nhỏ: hệ số hồi dần về 1, không nhảy đột ngột
        let before = g;
        let mut l2 = vec![0.1f32; 256];
        let mut r2 = vec![0.1f32; 256];
        limit_block(&mut l2, &mut r2, &mut g, 48000.0);
        assert!(g > before && g < before + 0.05);
        for _ in 0..2000 {
            let mut a = vec![0.1f32; 256];
            let mut b = vec![0.1f32; 256];
            limit_block(&mut a, &mut b, &mut g, 48000.0);
        }
        assert!(g > 0.99);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_sorted_off_before_on() {
        let notes = vec![
            NoteEv { tick: 0, duration_ticks: 480, channel: 0, program: 0, pitch: 60, velocity: 80 },
            NoteEv { tick: 480, duration_ticks: 480, channel: 0, program: 0, pitch: 60, velocity: 80 },
        ];
        let ev = build_events(&notes);
        assert!(matches!(ev[0].1, Ev::Program { .. }));
        let ticks: Vec<f64> = ev.iter().map(|e| e.0).collect();
        assert!(ticks.windows(2).all(|w| w[0] <= w[1]));
        // nốt lặp lại: Off của nốt 1 ở tick 479, On của nốt 2 ở tick 480
        assert!(matches!(ev[2].1, Ev::Off { .. }) && ev[2].0 == 479.0);
    }

    #[test]
    fn wav_header_is_valid() {
        let dir = std::env::temp_dir().join("hm-wav-test.wav");
        write_wav(&dir, 44_100, &[0, 1000, -1000, 0]).unwrap();
        let b = std::fs::read(&dir).unwrap();
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(&b[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes([b[40], b[41], b[42], b[43]]), 8);
    }
}
