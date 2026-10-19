// ローカル開発用の D1 を作り直す（npm run db:reset:local）。本番には接続しない（--local のみ）。
// 既定の保存先（.wrangler/state/v3/d1）を消してから、マイグレーションをすべて適用し、seed.sql を入れる。
// 日付を今日に合わせたいときは、先に node scripts/gen_seed.cjs で seed.sql を作り直す。
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(ROOT, '.wrangler', 'state', 'v3', 'd1'), { recursive: true, force: true })
for (const script of ['db:migrate:local', 'db:seed:local']) {
  // CI=1: マイグレーションの適用の確認を聞かずに進める
  const r = spawnSync(`npm run ${script}`, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, CI: '1' } })
  if (r.status !== 0) { console.error(`失敗しました: npm run ${script}`); process.exit(1) }
}
console.log('ローカルの D1 を作り直しました（マイグレーションと seed.sql を適用済み）')
