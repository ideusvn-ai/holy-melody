#!/usr/bin/env bash
# Chạy Audiveris thật trên ảnh mẫu; lưu MusicXML + book .omr + log để phát triển lớp phủ và nhận dạng lại vùng
set -uo pipefail
AUD_DIR=/tmp/aud
node scripts/fetch-audiveris.mjs linux "$AUD_DIR"
EXE="$AUD_DIR/$(node -p "require('$AUD_DIR/manifest.json').exe")"
echo "EXE=$EXE"; ls -la "$(dirname "$EXE")"
export JAVA_TOOL_OPTIONS="-Djava.awt.headless=true"
mkdir -p ci-logs/omr/in ci-logs/omr/out
cp scripts/ci/omr-samples/*.png ci-logs/omr/in/
# vài ảnh mẫu thật từ kho Audiveris (bản quét)
node -e "
const h={'User-Agent':'hm','Authorization':'Bearer '+(process.env.GITHUB_TOKEN||'')};
(async()=>{const r=await (await fetch('https://api.github.com/repos/Audiveris/audiveris/git/trees/master?recursive=1',{headers:h})).json();
const imgs=(r.tree||[]).filter(t=>/^data\/examples\/[^/]+\.(png|jpg|jpeg|tif)$/i.test(t.path)).slice(0,3);
for(const i of imgs){const b=Buffer.from(await (await fetch('https://raw.githubusercontent.com/Audiveris/audiveris/master/'+i.path)).arrayBuffer());
require('fs').writeFileSync('ci-logs/omr/in/'+i.path.split('/').pop(),b);console.log('sample',i.path,b.length);}})()"
# một vùng cắt (hệ thống đầu tiên, phóng to 2x) để thử nhận dạng lại theo vùng
convert ci-logs/omr/in/hymn-satb-vi.png -crop 100%x30%+0+0 +repage -resize 200% ci-logs/omr/in/crop-hymn-system1.png || true
identify ci-logs/omr/in/* > ci-logs/omr/images.txt 2>&1 || true
for f in ci-logs/omr/in/*; do
  b=$(basename "${f%.*}")
  start=$(date +%s)
  timeout 600 "$EXE" -batch -export -save -output "ci-logs/omr/out/$b" -- "$f" > "ci-logs/omr/out/$b.log" 2>&1
  echo "$b exit=$? $(( $(date +%s) - start ))s" | tee -a ci-logs/omr/summary.txt
done
# ---- lời ca tiếng Việt: Audiveris có sẵn dữ liệu OCR nào? thử thêm vie.traineddata
echo "== tessdata đi kèm Audiveris:"; find "$AUD_DIR" -name '*.traineddata' | head; find / -name 'eng.traineddata' 2>/dev/null | head -3
mkdir -p /tmp/tess "$HOME/.config/AudiverisLtd/audiveris/tessdata"
for l in vie eng; do curl -sSL -o /tmp/tess/$l.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/$l.traineddata; done
ls -la /tmp/tess; cp /tmp/tess/*.traineddata "$HOME/.config/AudiverisLtd/audiveris/tessdata/"
for variant in default vie; do
  opts=""; [ $variant = vie ] && opts="-constant org.audiveris.omr.text.Language.defaultSpecification=vie+eng"
  t0=$(date +%s%N)
  TESSDATA_PREFIX=/tmp/tess timeout 600 "$EXE" $opts -batch -export -output ci-logs/omr/lyr/$variant -- ci-logs/omr/in/hymn-satb-vi.png > ci-logs/omr/lyr-$variant.log 2>&1
  m=$(find ci-logs/omr/lyr/$variant -name '*.mxl' | head -1)
  echo "LYRICS $variant $(( ($(date +%s%N) - t0) / 1000000 ))ms: $(unzip -p "$m" '*.xml' 2>/dev/null | grep -o '<text>[^<]*</text>' | sed 's/<[^>]*>//g' | head -24 | tr '\n' ' ')" | tee -a ci-logs/omr/summary.txt
  grep -iE "tess|ocr|language" ci-logs/omr/lyr-$variant.log | head -5
done

# ---- một hệ khuông đầu tiên (crop) so với cả trang
python3 - <<'PY'
from PIL import Image
im = Image.open('ci-logs/omr/in/hymn-satb-vi.png')
w, h = im.size
im.crop((0, 380, w, 1180)).save('/tmp/sys1.png')
PY
for f in /tmp/sys1.png ci-logs/omr/in/hymn-satb-vi.png; do
  t0=$(date +%s%N); TESSDATA_PREFIX=/tmp/tess timeout 600 "$EXE" -constant org.audiveris.omr.text.Language.defaultSpecification=vie+eng -batch -export -save -output ci-logs/omr/sys/$(basename $f .png) -- "$f" > ci-logs/omr/sys-$(basename $f .png).log 2>&1
  m=$(find ci-logs/omr/sys/$(basename $f .png) -name '*.mxl' | head -1)
  echo "SYSTEM $(basename $f) $(( ($(date +%s%N) - t0) / 1000000 ))ms measures=$(unzip -p "$m" '*.xml' 2>/dev/null | grep -c '<measure ') lyrics=$(unzip -p "$m" '*.xml' 2>/dev/null | grep -c '<lyric')" | tee -a ci-logs/omr/summary.txt
done
# khởi động JVM rỗng (chi phí cố định mỗi lần chạy)
t0=$(date +%s%N); timeout 120 "$EXE" -help > /dev/null 2>&1; echo "JVM-START $(( ($(date +%s%N) - t0) / 1000000 ))ms" | tee -a ci-logs/omr/summary.txt
rm -rf ci-logs/omr/lyr ci-logs/omr/sys

# ---- đo cấu hình NHANH cho Player: tắt lời ca/hợp âm chữ/ký hiệu phụ, thu nhỏ ảnh
FAST="-constant org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false -constant org.audiveris.omr.sheet.ProcessingSwitches.lyricsAboveStaff=false -constant org.audiveris.omr.sheet.ProcessingSwitches.chordNames=false -constant org.audiveris.omr.sheet.ProcessingSwitches.articulations=false -constant org.audiveris.omr.sheet.ProcessingSwitches.fingerings=false -constant org.audiveris.omr.sheet.ProcessingSwitches.frets=false -constant org.audiveris.omr.sheet.ProcessingSwitches.pluckings=false"
for f in ci-logs/omr/in/hymn-satb-vi.png ci-logs/omr/in/BachInvention5.jpg ci-logs/omr/in/allegretto.png; do
  [ -f "$f" ] || continue
  b=$(basename "${f%.*}")
  for variant in full fast fast75 fast60 notext; do
    in="$f"; opts=""
    case $variant in
      fast) opts="$FAST";;
      fast75) opts="$FAST"; in="/tmp/$b-75.png"; convert "$f" -resize 75% "$in";;
      fast60) opts="$FAST"; in="/tmp/$b-60.png"; convert "$f" -resize 60% "$in";;
      notext) opts="$FAST -constant org.audiveris.omr.text.Language.defaultSpecification=";;
    esac
    t0=$(date +%s%N)
    timeout 600 "$EXE" $opts -batch -export -save -output "ci-logs/omr/var/$b-$variant" -- "$in" > "ci-logs/omr/var-$b-$variant.log" 2>&1
    code=$?
    ms=$(( ($(date +%s%N) - t0) / 1000000 ))
    m=$(find "ci-logs/omr/var/$b-$variant" -name '*.mxl' | head -1)
    notes=0; meas=0
    if [ -n "$m" ]; then x=$(unzip -p "$m" '*.xml' 2>/dev/null | grep -v container); notes=$(echo "$x" | grep -c '<pitch>'); meas=$(echo "$x" | grep -c '<measure '); fi
    il=$(grep -o 'interline[^,]*' "ci-logs/omr/var-$b-$variant.log" | head -1)
    echo "VARIANT $b $variant exit=$code ${ms}ms pitches=$notes measures=$meas $il" | tee -a ci-logs/omr/summary.txt
  done
done
rm -rf ci-logs/omr/var

# PDF 2 trang: cả file một lần so với từng trang song song (-sheets)
cp scripts/ci/omr-samples/two-pages.pdf ci-logs/omr/in/
t0=$(date +%s); timeout 600 "$EXE" -batch -export -save -output ci-logs/omr/out/pdf-all -- ci-logs/omr/in/two-pages.pdf > ci-logs/omr/out/pdf-all.log 2>&1; echo "pdf-all exit=$? $(( $(date +%s) - t0 ))s" | tee -a ci-logs/omr/summary.txt
t0=$(date +%s)
( timeout 600 "$EXE" -sheets 1 -batch -export -save -output ci-logs/omr/out/pdf-p1 -- ci-logs/omr/in/two-pages.pdf > ci-logs/omr/out/pdf-p1.log 2>&1; echo "pdf-p1 exit=$?" >> ci-logs/omr/summary.txt ) &
( timeout 600 "$EXE" -sheets 2 -batch -export -save -output ci-logs/omr/out/pdf-p2 -- ci-logs/omr/in/two-pages.pdf > ci-logs/omr/out/pdf-p2.log 2>&1; echo "pdf-p2 exit=$?" >> ci-logs/omr/summary.txt ) &
wait; echo "pdf-parallel-2 $(( $(date +%s) - t0 ))s (nproc=$(nproc), RAM=$(free -g | awk '/Mem/{print $2}')G)" | tee -a ci-logs/omr/summary.txt
# giải nén .mxl để đọc được bằng git
find ci-logs/omr/out -name '*.mxl' | while read m; do d="${m%.mxl}.xml.d"; mkdir -p "$d"; unzip -o -q "$m" -d "$d"; done
find ci-logs/omr/out -name '*.omr' | while read m; do unzip -l "$m" > "$m.list.txt"; d="${m%.omr}.omr.d"; mkdir -p "$d"; unzip -o -q "$m" -d "$d" '*.xml' || true; done
# kiểm tra kết quả nhận dạng từng trang
for d in pdf-all pdf-p1 pdf-p2; do
  echo "== $d"; ls -R ci-logs/omr/out/$d | head -20
  for x in $(find ci-logs/omr/out/$d -name '*.xml' -path '*xml.d*' ! -name container.xml); do
    echo "$x measures=$(grep -c '<measure ' $x) parts=$(grep -c '<score-part ' $x) time=$(grep -c '<time' $x) key=$(grep -c '<key' $x) pages=$(grep -c 'new-page' $x)"
  done
  for o in $(find ci-logs/omr/out/$d -name '*.omr.list.txt'); do grep -o 'sheet#[0-9]*/sheet#[0-9]*.xml' $o; done
done
rm -f ci-logs/omr/in/*.png ci-logs/omr/in/*.jpg ci-logs/omr/in/*.pdf
find ci-logs/omr -type f | head -100
exit 0
