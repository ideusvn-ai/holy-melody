/**
 * Smart Harmony: gợi ý hợp âm cục bộ (miễn phí, offline). Preview → Compare → Apply → Regenerate → Undo.
 * Không thay đổi giai điệu. Bản AI tính credit (Phase 5) sẽ dùng cùng panel.
 */
import { useEffect, useState } from 'react';
import { applyHarmony, chordName, HARMONY_STYLES, suggestHarmony, type HarmonyRhythm, type HarmonyStyle, type HarmonyVariant } from '@holy-melody/music-core';
import { useActiveProject, useStore } from '../state/store';

export function HarmonyPanel() {
  const project = useActiveProject();
  const st = useStore();
  const [style, setStyle] = useState<HarmonyStyle>('sacred-hymn');
  const [rhythm, setRhythm] = useState<HarmonyRhythm>('auto');
  const [partId, setPartId] = useState<string>('');
  const [variants, setVariants] = useState<HarmonyVariant[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [seed, setSeed] = useState(0);

  useEffect(() => () => st.setHarmonyPreview(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!project) return null;
  const score = project.score;
  const pid = partId || score.parts[0]?.id || '';
  const range = st.selection.measureRange;

  const run = (nextSeed = seed) => {
    try {
      const v = suggestHarmony(score, { partId: pid, style, rhythm, measureRange: range, seed: nextSeed });
      setVariants(v);
      setActive(null);
      st.setHarmonyPreview(null);
      if (!v.length) st.notify('Đoạn đã chọn chưa có nốt giai điệu để gợi ý hợp âm.');
    } catch (e) {
      st.notify((e as Error).message, 'error');
    }
  };
  const preview = (v: HarmonyVariant) => {
    setActive(v.id);
    const ids = new Set((range ? score.measures.slice(range[0], range[1] + 1) : score.measures).map((m) => m.id));
    st.setHarmonyPreview(score.chordSymbols.filter((c) => !(c.partId === pid && ids.has(c.measureId))).concat(v.chords));
  };

  const sel = 'w-full h-8 rounded-md border border-line bg-surface px-2';
  return (
    <section className="p-3 space-y-3" aria-label="Gợi ý hợp âm">
      <p className="text-[11px] text-muted leading-snug">
        Phân tích giai điệu theo giọng {range ? `(ô ${range[0] + 1}–${range[1] + 1})` : '(toàn bài — kéo chọn ô nhịp để giới hạn)'} và đề xuất hợp âm theo hòa âm chức năng. Giai điệu không bị thay đổi.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted">Phong cách</span>
          <select className={sel} value={style} onChange={(e) => setStyle(e.target.value as HarmonyStyle)}>
            {HARMONY_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted">Mật độ</span>
          <select className={sel} value={rhythm} onChange={(e) => setRhythm(e.target.value as HarmonyRhythm)}>
            <option value="auto">Tự động</option>
            <option value="measure">Mỗi ô nhịp</option>
            <option value="half">Nửa ô nhịp</option>
            <option value="beat">Mỗi phách</option>
          </select>
        </label>
        <label className="space-y-1 col-span-2">
          <span className="text-[11px] text-muted">Bè giai điệu</span>
          <select className={sel} value={pid} onChange={(e) => setPartId(e.target.value)}>
            {score.parts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <button className="flex-1 h-9 rounded-md bg-accent text-accent-fg font-semibold hover:brightness-110 active:scale-[0.99]" onClick={() => run()}>Gợi ý hợp âm</button>
        <button className="h-9 px-3 rounded-md border border-line hover:bg-surface-2 disabled:opacity-40" disabled={!variants.length} onClick={() => { const n = seed + 1; setSeed(n); run(n); }} title="Tạo phương án khác">Regenerate</button>
      </div>

      <ul className="space-y-2">
        {variants.map((v) => (
          <li key={v.id} className={`hm-enter rounded-lg border p-2.5 cursor-pointer transition ${active === v.id ? 'border-info bg-info/5' : 'border-line hover:bg-surface-2'}`} onClick={() => preview(v)}>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{v.label}</span>
              <span className="ml-auto text-[10px] text-muted tabular-nums">độ khớp {v.score}</span>
            </div>
            <div className="mt-1 font-mono text-[12px] leading-relaxed break-words">{v.chords.map(chordName).join('  ')}</div>
            <div className="text-[10.5px] text-muted mt-0.5 break-words">{v.numerals.join(' – ')}</div>
            {active === v.id && (
              <div className="flex gap-2 mt-2">
                <button
                  className="h-7 px-3 rounded-md bg-accent text-accent-fg text-[12px] font-semibold"
                  onClick={(e) => { e.stopPropagation(); st.exec(applyHarmony(v, pid, range)); st.setHarmonyPreview(null); setActive(null); st.notify(`Đã áp dụng hợp âm "${v.label}". Nhấn ⌘/Ctrl+Z để hoàn tác.`); }}
                >Áp dụng</button>
                <button className="h-7 px-3 rounded-md border border-line text-[12px]" onClick={(e) => { e.stopPropagation(); st.setHarmonyPreview(null); setActive(null); }}>Bỏ xem trước</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {variants.length > 0 && <p className="text-[10.5px] text-muted">Nhấp một phương án để xem trước trên bản nhạc (màu xanh) và so sánh; Áp dụng là một bước, hoàn tác được.</p>}
    </section>
  );
}
