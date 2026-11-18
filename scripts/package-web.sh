#!/usr/bin/env bash
# Đóng gói website + API thành holymelody-web.zip để tải lên shared hosting (xem docs/HUONG-DAN-CAI-DAT-WEB.md)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-dist-web}
rm -rf "$OUT/holymelody" && mkdir -p "$OUT/holymelody/apps" "$OUT/holymelody/backend" "$OUT/holymelody/storage"
cp -r apps/website "$OUT/holymelody/apps/"
rm -rf "$OUT/holymelody/apps/website/"{assets,templates,README.md}
cp -r backend/src backend/migrations "$OUT/holymelody/backend/"
cp .env.example "$OUT/holymelody/backend/.env.example"
cat backend/migrations/0*.sql > "$OUT/holymelody/install.sql"
printf 'Require all denied\n' > "$OUT/holymelody/storage/.htaccess"
printf 'Require all denied\n' > "$OUT/holymelody/backend/.htaccess"
cp docs/HUONG-DAN-CAI-DAT-WEB.md "$OUT/holymelody/HUONG-DAN-CAI-DAT.md"
(cd "$OUT" && rm -f holymelody-web.zip && zip -qr holymelody-web.zip holymelody)
echo "→ $OUT/holymelody-web.zip"
