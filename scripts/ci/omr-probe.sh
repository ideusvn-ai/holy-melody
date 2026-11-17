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
# giải nén .mxl để đọc được bằng git
find ci-logs/omr/out -name '*.mxl' | while read m; do d="${m%.mxl}.xml.d"; mkdir -p "$d"; unzip -o -q "$m" -d "$d"; done
find ci-logs/omr/out -name '*.omr' | while read m; do unzip -l "$m" > "$m.list.txt"; d="${m%.omr}.omr.d"; mkdir -p "$d"; unzip -o -q "$m" -d "$d" '*.xml' || true; done
rm -f ci-logs/omr/in/*.png ci-logs/omr/in/*.jpg
find ci-logs/omr -type f | head -100
exit 0
