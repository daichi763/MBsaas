// デプロイの前に、D1 に未適用のマイグレーションがないかを確かめる（#340）。
// 未適用があれば一覧を出して終了コード 1 で止める（npm run deploy の predeploy から呼ぶ）。適用はこれまでどおり手動で行う。
//
// 使い方:
//   node scripts/check-migrations.mjs                       … 本番（--remote --env production）を確かめる
//   node scripts/check-migrations.mjs --local [--persist-to <保存先>] … ローカルの D1 を確かめる
// 未適用のまま止めずにデプロイする必要があるとき（適用の順番を意図して変える場合など）は、SKIP_MIGRATION_CHECK=1 を付ける。
import { spawnSync } from 'node:child_process'

const DB_NAME = 'mbsaas-production'
if (process.env.SKIP_MIGRATION_CHECK === '1') {
  console.warn('[check-migrations] SKIP_MIGRATION_CHECK=1 のため、未適用のマイグレーションの確認を省略しました')
  process.exit(0)
}
const extra = process.argv.slice(2)
const args = ['wrangler', 'd1', 'migrations', 'list', DB_NAME, ...(extra.includes('--local') ? extra : ['--remote', '--env', 'production', ...extra])]
const where = extra.includes('--local') ? 'ローカル' : '本番'
// Windows では npx.cmd をシェル経由で起動するため、1行のコマンドにする（空白を含む引数（保存先のパスなど）は引用符で囲む）
const r = process.platform === 'win32'
  ? spawnSync(['npx', ...args.map(a => /\s/.test(a) ? `"${a}"` : a)].join(' '), { encoding: 'utf8', shell: true, env: { ...process.env, CI: '1' } })
  : spawnSync('npx', args, { encoding: 'utf8', env: { ...process.env, CI: '1' } })
const out = `${r.stdout || ''}\n${r.stderr || ''}`
if (r.status !== 0) {
  console.error(out)
  console.error(`[check-migrations] ${where}のマイグレーションの状態を確かめられませんでした（wrangler の終了コード ${r.status}）。ログインと接続を確かめてください`)
  process.exit(1)
}
// wrangler は未適用のマイグレーションを表で出し、なければ「No migrations to apply」と出す（どちらも終了コードは 0）
const pending = [...new Set(out.match(/\b\d{4}_[\w.-]+\.sql\b/g) || [])]
if (pending.length) {
  console.error(`[check-migrations] ${where}の D1（${DB_NAME}）に未適用のマイグレーションが ${pending.length} 件あります:`)
  for (const f of pending) console.error('  - ' + f)
  console.error('先に適用してからデプロイしてください（README の「デプロイ」の手順）。新しいテーブル・列を使うコードを先に出すと、その API が 500 になります')
  process.exit(1)
}
if (!/No migrations to apply/i.test(out)) {
  console.error(out)
  console.error('[check-migrations] wrangler の出力を読めませんでした。手で `npx wrangler d1 migrations list` の結果を確かめてください')
  process.exit(1)
}
console.log(`[check-migrations] ${where}の D1（${DB_NAME}）に未適用のマイグレーションはありません`)
