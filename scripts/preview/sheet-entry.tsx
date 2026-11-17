// Chỉ dùng cho bản xem thử: nạp kết quả Audiveris THẬT (chạy trên CI) để kiểm tra lớp phủ ảnh/PDF và luồng Edit.
import { createRoot } from 'react-dom/client';
import { App } from '../../apps/desktop/src/App';
import { useStore } from '../../apps/desktop/src/state/store';
import { detectHardRegions, fixOmrInstruments, pdfOf, setSheetAsset, type SheetAsset } from '../../apps/desktop/src/lib/sheet';
import { enterEditMode, extractOmrGeometry, importMusicXml, markAllUnverified, validateMusic } from '@holy-melody/music-core';

const q = new URLSearchParams(location.search);
const demo = q.get('demo');
if (demo) {
  const [xml, sx, bin] = await Promise.all([
    fetch('demo/hymn.musicxml').then((r) => r.text()),
    fetch('demo/hymn.sheet.xml').then((r) => r.text()),
    fetch(demo === 'pdf' ? 'demo/hymn.pdf' : 'demo/hymn.png').then((r) => r.arrayBuffer()),
  ]);
  const score = importMusicXml(xml);
  score.meta.title = 'Thánh ca (Audiveris)';
  markAllUnverified(score);
  fixOmrInstruments(score);
  const asset: SheetAsset = demo === 'pdf' ? { kind: 'pdf', bytes: new Uint8Array(bin), mime: 'application/pdf' } : { kind: 'image', bytes: new Uint8Array(bin), mime: 'image/png' };
  let pages = [{ file: 'source.png', width: 2479, height: 3508 }];
  if (demo === 'pdf') {
    const vp = (await (await pdfOf(asset)).getPage(1)).getViewport({ scale: 1 });
    pages = [{ file: 'source.pdf', width: vp.width, height: vp.height }];
  }
  score.sheet = { kind: asset.kind, fileName: demo === 'pdf' ? 'thanh-ca.pdf' : 'thanh-ca.png', hash: 'ab'.repeat(32), pages, measures: extractOmrGeometry([sx])!, mode: 'overlay', reviews: {} };
  setSheetAsset(score.id, asset);
  const binary = new Uint8Array(await fetch('demo/BINARY.png').then((r) => r.arrayBuffer()));
  score.sheet.signals = await detectHardRegions([sx], [binary], score.sheet.measures);
  console.log('signals', JSON.stringify(score.sheet.signals));
  if (q.get('edit')) {
    // giả lập một ô nhận dạng sai để thấy bảng Đối chiếu
    const m = score.measures[4]!;
    score.parts[0]!.content[m.id]![0]!.events.pop();
  }
  const st = useStore.getState();
  st.newProject(score, score.sheet.fileName);
  if (q.get('edit')) {
    st.exec(enterEditMode({ at: new Date().toISOString(), credits: 10 }, validateMusic(score)));
    st.setTab('editor');
    st.select({ measureRange: [Number(q.get('m') ?? 4), Number(q.get('m') ?? 4)], noteIds: [], eventIds: [] });
  }
}
createRoot(document.getElementById('root')!).render(<App />);
