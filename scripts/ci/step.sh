#!/usr/bin/env bash
# Chạy một bước CI, ghi log vào ci-logs/<tên>.log và kết quả vào ci-logs/steps.tsv
# Dùng: scripts/ci/step.sh <tên> <lệnh...>
set -uo pipefail
name="$1"; shift
mkdir -p ci-logs
start=$(date +%s)
echo "::group::$name"
"$@" > >(tee "ci-logs/$name.log") 2>&1
code=$?
echo "::endgroup::"
printf '%s\t%s\t%ss\n' "$name" "$code" "$(( $(date +%s) - start ))" >> ci-logs/steps.tsv
exit $code
