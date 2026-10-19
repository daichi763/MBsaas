// 統合テスト（scripts/test-*.mjs）をまとめて実行する（npm test。#340）。本番には接続しない（wrangler は --local のみ）。
//
// 流れ: ビルド → テスト用のローカル D1 を1回だけ作る（scripts/setup-test-db.sh）→ テストのファイルごとに、
//   その D1 を複製して wrangler dev --local を起動し、テストを実行して、サーバーを止める（テストのたびに DB を作り直す決まりのため）。
//   各テストの先頭のコメントにある `--var 名前:値` と `--test-scheduled` を読み取って、起動に付ける（--var の値はテストの環境変数にも渡す）。
//
// 使い方:
//   npm test                         … すべてのテスト
//   npm test -- w3-board w2-          … ファイル名に含まれる文字で絞る
//   npm test -- --reuse-db            … 前回作ったテスト用 D1 を使い回す（マイグレーションを足したときは使わない）
//   npm test -- --no-build            … ビルドを省く
// 環境変数: TEST_DB_DIR（テスト用 D1 の置き場所。既定は OS の一時フォルダ）、TEST_PORT（既定 8899）
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flags = new Set(argv.filter(a => a.startsWith('--')))
const filters = argv.filter(a => !a.startsWith('--'))
const DB_ROOT = process.env.TEST_DB_DIR || join(tmpdir(), 'mbsaas-test')
const TEMPLATE = join(DB_ROOT, 'template')
const WORK = join(DB_ROOT, 'work')
const PORT = Number(process.env.TEST_PORT || 8899)
const BASE = `http://127.0.0.1:${PORT}`
const isWin = process.platform === 'win32'

function sh(cmd, args) {
  // Windows では npm・npx・bash をシェル経由で起動する（引数はこのファイルで決めた値だけで、空白を含むパスは引用符で囲む）
  const line = [cmd, ...args.map(a => /\s/.test(a) ? `"${a}"` : a)].join(' ')
  const r = spawnSync(line, { cwd: ROOT, stdio: 'inherit', shell: true })
  if (r.status !== 0) { console.error(`失敗しました: ${line}`); process.exit(1) }
}

const tests = readdirSync(join(ROOT, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f))
  .filter(f => !filters.length || filters.some(q => f.includes(q))).sort()
if (!tests.length) { console.error('対象のテストがありません'); process.exit(1) }

if (!flags.has('--no-build')) sh('npm', ['run', 'build'])
if (!flags.has('--reuse-db') || !existsSync(TEMPLATE)) {
  mkdirSync(DB_ROOT, { recursive: true })
  sh('bash', ['scripts/setup-test-db.sh', TEMPLATE.replace(/\\/g, '/')])
}

// テストの先頭のコメントから、wrangler dev に付けるオプションを読む
function devOptions(file) {
  const head = readFileSync(join(ROOT, 'scripts', file), 'utf8').split('\n').slice(0, 25).filter(l => l.trim().startsWith('//')).join('\n')
  const vars = [...head.matchAll(/--var\s+([A-Z_]+):(\S+?)(?=[\s`'"）)]|$)/g)].map(m => [m[1], m[2]])
  return { vars, scheduled: /--test-scheduled/.test(head) }
}

async function waitReady(proc) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) return false
    try { const r = await fetch(`${BASE}/login`); if (r.status < 500) return true } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}
function stop(proc) {
  if (proc.exitCode !== null) return
  // npx の子の workerd まで止める
  if (isWin) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill('SIGTERM') } }
}

const results = []
for (const file of tests) {
  const { vars, scheduled } = devOptions(file)
  rmSync(WORK, { recursive: true, force: true })
  cpSync(TEMPLATE, WORK, { recursive: true })
  const devArgs = ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', WORK.replace(/\\/g, '/'),
    ...vars.flatMap(([k, v]) => ['--var', `${k}:${v}`]), ...(scheduled ? ['--test-scheduled'] : [])]
  console.log(`\n===== ${file}  (${devArgs.slice(2).join(' ')})`)
  const proc = isWin
    ? spawn(['npx', ...devArgs.map(a => /\s/.test(a) ? `"${a}"` : a)].join(' '), { cwd: ROOT, shell: true, stdio: ['ignore', 'ignore', 'pipe'] })
    : spawn('npx', devArgs, { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let errLog = ''
  proc.stderr.on('data', d => { errLog = (errLog + d).slice(-4000) })
  let status = 1
  try {
    if (!(await waitReady(proc))) { console.error('サーバーが起動しませんでした\n' + errLog); results.push({ file, ok: false }); continue }
    const env = { ...process.env, BASE, PERSIST: WORK.replace(/\\/g, '/'), ...Object.fromEntries(vars) }
    status = spawnSync(process.execPath, [join('scripts', file)], { cwd: ROOT, stdio: 'inherit', env }).status ?? 1
    results.push({ file, ok: status === 0 })
  } finally {
    stop(proc)
    await new Promise(r => setTimeout(r, 1500))
  }
}

console.log('\n===== 結果')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}`)
const failed = results.filter(r => !r.ok).length
console.log(`${results.length - failed}/${results.length} 件のテストファイルが成功しました`)
process.exit(failed ? 1 : 0)
