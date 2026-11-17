/**
 * Panel "Trợ lý soạn nhạc": chỉ gợi ý — người dùng có thể bỏ qua từng gợi ý hoặc tắt cả quy tắc.
 * Không có nút nào tự sửa bản nhạc.
 */
import { useMemo, useState } from 'react';
import { RULE_INFO, type AdvisorCategory, type AdvisorSuggestion } from '@holy-melody/music-core';
import { useStore } from '../state/store';
import { IconLightbulb, IconX } from './icons';

const CATS: { id: AdvisorCategory; label: string }[] = [
  { id: 'melody', label: 'Giai điệu' },
  { id: 'harmony', label: 'Phối bè' },
  { id: 'range', label: 'Âm vực' },
  { id: 'structure', label: 'Cấu trúc thánh ca' },
  { id: 'lyrics', label: 'Ca từ & dấu thanh' },
  { id: 'notation', label: 'Ký âm' },
];

const SEV_STYLE: Record<AdvisorSuggestion['severity'], string> = {
  warning: 'border-l-warn',
  suggestion: 'border-l-accent',
  info: 'border-l-info',
};

export function AdvisorPanel() {
  const { enabled, suggestions, hymnMode } = useStore((s) => s.advisor);
  const st = useStore();
  const [hidden, setHidden] = useState<Set<AdvisorCategory>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  const visible = useMemo(() => suggestions.filter((s) => !hidden.has(s.category)), [suggestions, hidden]);
  const counts = useMemo(() => {
    const c = new Map<AdvisorCategory, number>();
    for (const s of suggestions) c.set(s.category, (c.get(s.category) ?? 0) + 1);
    return c;
  }, [suggestions]);

  return (
    <section className="flex flex-col min-h-0" aria-label="Trợ lý soạn nhạc">
      <header className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
        <IconLightbulb className="text-accent" />
        <h2 className="font-semibold text-[13px]">Trợ lý soạn nhạc</h2>
        <span className="ml-auto text-[11px] text-muted">{enabled ? `${visible.length} gợi ý` : 'Đã tắt'}</span>
        <label className="relative inline-flex items-center cursor-pointer" title="Bật/tắt trợ lý">
          <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => st.setAdvisorEnabled(e.target.checked)} />
          <span className="w-7 h-4 rounded-full bg-line peer-checked:bg-accent transition" />
          <span className="absolute left-0.5 top-0.5 w-3 h-3 rounded-full bg-white transition peer-checked:translate-x-3" />
        </label>
      </header>

      {enabled && (
        <>
          <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-line">
            {CATS.map((c) => {
              const on = !hidden.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    const n = new Set(hidden);
                    if (on) n.add(c.id);
                    else n.delete(c.id);
                    setHidden(n);
                  }}
                  className={`px-2 py-0.5 rounded-full text-[11px] border transition ${on ? 'border-accent/40 bg-accent-soft text-fg' : 'border-line text-muted line-through'}`}
                  aria-pressed={on}
                >
                  {c.label} {counts.get(c.id) ? <span className="opacity-60">{counts.get(c.id)}</span> : null}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted border-b border-line">
            <input type="checkbox" checked={hymnMode} onChange={(e) => st.setHymnMode(e.target.checked)} />
            Áp dụng tiêu chí thánh ca cộng đoàn
          </label>

          <ul className="flex-1 overflow-auto p-2 space-y-1.5">
            {visible.length === 0 && (
              <li className="text-center text-muted text-xs py-8 hm-enter">Không có gợi ý nào. Bản nhạc đang ổn theo các quy tắc đã bật.</li>
            )}
            {visible.map((s) => (
              <li
                key={s.id}
                className={`hm-enter group rounded-md border border-line border-l-[3px] ${SEV_STYLE[s.severity]} bg-surface p-2 cursor-pointer hover:shadow-sm transition`}
                onClick={() => {
                  setOpen(open === s.id ? null : s.id);
                  if (s.noteIds.length) st.select({ noteIds: s.noteIds, eventIds: [], measureRange: undefined });
                  else if (s.measureIndex !== undefined) st.select({ noteIds: [], eventIds: [], measureRange: [s.measureIndex, s.measureIndex] });
                }}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-muted">
                      {RULE_INFO[s.rule].title}
                      {s.measureIndex !== undefined && <span> · ô {st.projects.find((p) => p.id === st.activeId)?.score.measures[s.measureIndex]?.number}</span>}
                    </div>
                    <p className="text-[12px] leading-snug mt-0.5">{s.message}</p>
                    {open === s.id && <p className="text-[11px] leading-snug text-muted mt-1.5">{s.rationale}</p>}
                  </div>
                  <button
                    className="shrink-0 opacity-60 group-hover:opacity-100 h-6 w-6 grid place-items-center rounded hover:bg-surface-2"
                    title="Bỏ qua gợi ý này"
                    aria-label="Bỏ qua gợi ý"
                    onClick={(e) => {
                      e.stopPropagation();
                      st.dismissSuggestion(s.id);
                    }}
                  >
                    <IconX size={13} />
                  </button>
                </div>
                {open === s.id && (
                  <div className="flex gap-2 mt-2">
                    <button className="text-[11px] px-2 py-0.5 rounded border border-line hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); st.dismissSuggestion(s.id); }}>Bỏ qua</button>
                    <button className="text-[11px] px-2 py-0.5 rounded border border-line hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); st.setRule(s.rule, false); }}>Tắt quy tắc này</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <footer className="px-3 py-2 border-t border-line text-[11px] text-muted flex items-center">
            <span>Chỉ là gợi ý — bạn có toàn quyền quyết định.</span>
            <button className="ml-auto underline hover:text-fg" onClick={() => st.restoreSuggestions()}>Khôi phục</button>
          </footer>
        </>
      )}
    </section>
  );
}
