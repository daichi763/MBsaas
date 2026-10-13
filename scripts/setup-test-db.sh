#!/usr/bin/env bash
# 統合テスト用のローカル D1 を作り直す（本番には接続しない: --local のみ）
#   既存データに 0027 以降を適用する本番の状況を再現するため、
#   0001〜0026 → seed.sql → 旧来の提出設定を一部に設定 → 0027 以降 の順で適用する。
# 使い方:
#   bash scripts/setup-test-db.sh [保存先]        （既定: .wrangler/test-db。Windows でパスが長いと失敗するため短い場所を指定する）
#   npm run build && npx wrangler dev --local --port 8799 --persist-to <保存先>
#   node scripts/test-report-settings.mjs
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-.wrangler/test-db}"
rm -rf "$DIR"
run() { npx wrangler d1 execute mbsaas-production --local --persist-to "$DIR" "$@" > /dev/null; }
for f in migrations/*.sql; do
  n=$(basename "$f" | cut -c1-4)
  if [ "$n" -le 26 ]; then run --file="$f"; fi
done
run --file=seed.sql
# 旧来の提出設定（0017）を一部に設定しておき、0027 の移行を確認できるようにする
run --command "UPDATE projects SET attendance_mode = 'in_out' WHERE project_id = 2; UPDATE staff_profiles SET attendance_mode = 'none' WHERE staff_id = 2;"
for f in migrations/*.sql; do
  n=$(basename "$f" | cut -c1-4)
  if [ "$n" -gt 26 ]; then run --file="$f"; fi
done
echo "test DB ready: $DIR"
