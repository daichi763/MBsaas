// 統合テスト（scripts/test-*.mjs）をまとめて実行する（npm test。#340）。本番には接続しない（wrangler は --local のみ）。
//
// 流れ: ビルド → テスト用のローカル D1 を1回だけ作る（scripts/setup-test-db.sh）→ テストのファイルごとに、その D1 を複製して wrangler dev --local を起動し、テストを実行して、サーバーを止める（テストのたびに DB を作り直す決まりのため）。日本時間の 0 時の直前は、日付が変わるまで待ってから次のテストを始める（#9641）。
//   起動のオプションは、各テストの先頭のコメント（25行まで）から読む。`// run-tests:` の行があれば、その行だけを使う（1行が1回の起動。同じ DB で上から順に流す。#9980）。
//   無ければ、コメントの中の `--var 名前:値` と `--test-scheduled` を読む（--var の値はテストの環境変数にも渡す）。
//
// 使い方:
//   npm test                         … すべてのテスト
//   npm test -- w3-board w2-          … ファイル名に含まれる文字で絞る
//   npm test -- --reuse-db            … 前回作ったテスト用 D1 を使い回す（マイグレーションを足したときは使わない）
//   npm test -- --no-build            … ビルドを省く
//   npm test -- --no-retry            … 落ちたテストを流し直さない（下の「機械が混んでいるとき」）
// 環境変数: TEST_DB_DIR（テスト用 D1 の置き場所。既定は OS の一時フォルダの mbsaas-test-<作業フォルダごとの記号>）、TEST_PORT（既定 8899。使われていれば次の空いている番号）、
//   TEST_MAX_SERVERS（この機械で同時に動かすテスト用サーバーの数。既定 2。0 で制限なし）、TEST_TIMEOUT_MIN（1本の上限の分。既定 90。混んでいると w23-menus は 45 分ほどかかる）
//
// 機械が混んでいるとき（Sprint 26 #9980。ほかの作業フォルダでも同時に npm test を流すと、ECONNRESET・D1 の internal error・EPERM で落ちていた）:
//   - テストの置き場所は作業フォルダごとに分け、同じ置き場所を2つの npm test で使わない（ロック）。ポートが使われていれば別の番号にする。
//   - この機械の全部の npm test を合わせて、テスト用サーバーを TEST_MAX_SERVERS 本までにする（空くまで待つ）。
//   - 各テストは scripts/lib/test-preload.mjs を読み込んで起動する（切れた接続・DB の取り合いを少し待ってやり直す）。
//   - 落ちたテストは、新しい DB でもう1回だけ流す。2回目で通ったものは「再試行で合格」として結果に分けて出す（隠さない）。
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flags = new Set(argv.filter(a => a.startsWith('--')))
const filters = argv.filter(a => !a.startsWith('--'))
const DB_ROOT = process.env.TEST_DB_DIR || join(tmpdir(), `mbsaas-test-${createHash('sha1').update(ROOT.toLowerCase()).digest('hex').slice(0, 8)}`)
const TEMPLATE = join(DB_ROOT, 'template')
const MAX_SERVERS = Number(process.env.TEST_MAX_SERVERS ?? 2)
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MIN || 90) * 60000
const RETRY = !flags.has('--no-retry')
const isWin = process.platform === 'win32'
const wait = ms => new Promise(r => setTimeout(r, ms))

function sh(cmd, args) {
  // Windows では npm・npx・bash をシェル経由で起動する（引数はこのファイルで決めた値だけで、空白を含むパスは引用符で囲む）
  const line = [cmd, ...args.map(a => /\s/.test(a) ? `"${a}"` : a)].join(' ')
  const r = spawnSync(line, { cwd: ROOT, stdio: 'inherit', shell: true })
  if (r.status !== 0) { console.error(`失敗しました: ${line}`); process.exit(1) }
}

// ---- 起動のオプション ----
// 値に使える文字（シェルに渡すので、< > や日本語の文が混ざったものは使わない。#9980）
const SAFE_VALUE = /^[A-Za-z0-9_.:/+=@-]+$/
// `// run-tests: [ファイル] [--var 名前:値]... [--test-scheduled] [--arg 値]...` の1行を読む
export function parseStep(line, self) {
  const t = line.trim().split(/\s+/).filter(Boolean)
  const step = { file: self, vars: [], scheduled: false, args: [] }
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '--var') {
      const m = /^([A-Z_][A-Z0-9_]*):(.+)$/.exec(t[++i] || '')
      if (!m || !SAFE_VALUE.test(m[2])) throw new Error(`run-tests: の --var が読めません: ${t[i]}`)
      step.vars.push([m[1], m[2]])
    } else if (t[i] === '--test-scheduled') step.scheduled = true
    else if (t[i] === '--arg') {
      if (!SAFE_VALUE.test(t[i + 1] || '')) throw new Error(`run-tests: の --arg が読めません: ${t[i + 1]}`)
      step.args.push(t[++i])
    } else if (/^test-[\w.-]+\.mjs$/.test(t[i])) step.file = t[i]
    else throw new Error(`run-tests: の読めない指定: ${t[i]}`)
  }
  return step
}
// テストの先頭のコメントから、起動（1回以上）を読む
export function devSteps(file, text) {
  const head = text.replace(/\r\n/g, '\n').split('\n').slice(0, 25).filter(l => l.trim().startsWith('//'))
  const directives = head.map(l => /^\s*\/\/\s*run-tests:(.*)$/.exec(l)).filter(Boolean)
  if (directives.length) return directives.map(m => parseStep(m[1], file))
  // 書き方が自由なコメントから読む（前からのテスト）。同じ名前は最初の値を使い、シェルに渡せない値は使わない
  const joined = head.join('\n')
  const vars = []
  for (const m of joined.matchAll(/--var\s+([A-Z_]+):(\S+?)(?=[\s`'"）)]|$)/g)) {
    if (!SAFE_VALUE.test(m[2])) { console.log(`（注意）${file}: --var ${m[1]}:${m[2]} は値に使えない文字を含むので使いません`); continue }
    if (vars.some(([k]) => k === m[1])) { if (!vars.some(([k, v]) => k === m[1] && v === m[2])) console.log(`（注意）${file}: --var ${m[1]} が2回あります。最初の値を使います`); continue }
    vars.push([m[1], m[2]])
  }
  return [{ file, vars, scheduled: /--test-scheduled/.test(joined), args: [] }]
}

// ---- ポート・同時に動かすサーバーの数 ----
const portFree = (port) => new Promise(res => { const s = createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))) })
async function pickPort(from) {
  for (let p = from; p < from + 50; p++) if (await portFree(p)) return p
  throw new Error(`${from}〜${from + 49} に空いているポートがありません`)
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// 印のフォルダ（中に pid）を作れたら取れた。持ち主のプロセスが終わっていれば取り直す
export function tryLock(dir) {
  try { mkdirSync(dir) } catch {
    let pid = 0, at = 0
    try { pid = Number(readFileSync(join(dir, 'pid'), 'utf8')) } catch { }
    try { at = Number(readFileSync(join(dir, 'at'), 'utf8')) } catch { }
    if (pid ? alive(pid) : Date.now() - at < 10000) return false   // pid を書く前の一瞬は、作った時刻で待つ
    rmSync(dir, { recursive: true, force: true })
    try { mkdirSync(dir) } catch { return false }
  }
  writeFileSync(join(dir, 'at'), String(Date.now()))
  writeFileSync(join(dir, 'pid'), String(process.pid))
  return true
}
const SLOTS = join(tmpdir(), 'mbsaas-test-slots')
let slotHeld = null
async function acquireSlot() {
  if (!(MAX_SERVERS > 0)) return
  mkdirSync(SLOTS, { recursive: true })
  for (let n = 0; ; n++) {
    for (let i = 0; i < MAX_SERVERS; i++) if (tryLock(join(SLOTS, `slot-${i}`))) { slotHeld = join(SLOTS, `slot-${i}`); return }
    if (n === 0) console.log(`ほかの npm test がテスト用サーバーを ${MAX_SERVERS} 本動かしているので、空くまで待ちます（TEST_MAX_SERVERS で変えられます）`)
    await wait(3000)
  }
}
function releaseSlot() { if (slotHeld) { rmSync(slotHeld, { recursive: true, force: true }); slotHeld = null } }

// ---- サーバー ----
async function waitReady(proc, base) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) return false
    try { const r = await fetch(`${base}/login`); if (r.status < 500) return true } catch { }
    await wait(1000)
  }
  return false
}
async function stop(proc, port) {
  if (proc.exitCode === null) {
    // npx の子の workerd まで止める
    if (isWin) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else { try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill('SIGTERM') } }
  }
  // ポートが空くまで待つ（workerd が残っていると、次のテストが古いサーバーにつながる）
  for (let i = 0; i < 40 && !(await portFree(port)); i++) await wait(500)
  await wait(500)
}
// DB の写しを消す。Windows では止めた直後の workerd がファイルを持っていて EPERM・EBUSY になるので、待ってやり直す
function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); return true } catch (e) { console.log(`（注意）${dir} を消せませんでした（${e.code}）。次の npm test で消します`); return false }
}

// ---- 本体 ----
async function main() {
  const tests = readdirSync(join(ROOT, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f))
    .filter(f => !filters.length || filters.some(q => f.includes(q))).sort()
  if (!tests.length) { console.error('対象のテストがありません'); process.exit(1) }

  mkdirSync(DB_ROOT, { recursive: true })
  const LOCK = join(DB_ROOT, 'lock')
  if (!tryLock(LOCK)) { console.error(`${DB_ROOT} はほかの npm test が使っています。終わるのを待つか、TEST_DB_DIR で別の場所を指定してください`); process.exit(1) }
  process.on('exit', () => { releaseSlot(); rmSync(LOCK, { recursive: true, force: true }) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

  if (!flags.has('--no-build')) sh('npm', ['run', 'build'])
  if (!flags.has('--reuse-db') || !existsSync(TEMPLATE)) sh('bash', ['scripts/setup-test-db.sh', TEMPLATE.replace(/\\/g, '/')])
  // 前の回に消せなかった DB の写しを消す
  for (const d of readdirSync(DB_ROOT)) if (/^work(-\d+)?$/.test(d)) removeDir(join(DB_ROOT, d))

  const results = []
  for (const file of tests) {
    let steps
    try { steps = devSteps(file, readFileSync(join(ROOT, 'scripts', file), 'utf8')) } catch (e) { console.error(`\n===== ${file}\n${e.message}`); results.push({ file, ok: false }); continue }
    const started = Date.now()
    const one = steps.length === 1 ? steps[0] : null
    console.log(`\n===== ${file}  (${one ? ['--local', ...one.vars.flatMap(([k, v]) => ['--var', `${k}:${v}`]), ...(one.scheduled ? ['--test-scheduled'] : [])].join(' ') : `${steps.length} 回の起動を同じ DB で順に`})`)
    let ok = await runOnce(steps), retried = false
    if (!ok && RETRY) {
      console.log(`\n===== ${file}  落ちたので、新しい DB でもう1回流します（機械が混んでいたときのため。2回とも落ちれば FAIL）`)
      await wait(5000)
      retried = true
      ok = await runOnce(steps)
    }
    results.push({ file, ok, retried, sec: Math.round((Date.now() - started) / 1000) })
  }

  console.log('\n===== 結果')
  for (const r of results) console.log(`${r.ok ? (r.retried ? 'PASS（再試行で合格）' : 'PASS') : 'FAIL'}  ${r.file}${r.sec != null ? `  (${r.sec}秒)` : ''}`)
  const failed = results.filter(r => !r.ok).length
  const flaky = results.filter(r => r.ok && r.retried).map(r => r.file)
  console.log(`${results.length - failed}/${results.length} 件のテストファイルが成功しました`)
  if (flaky.length) console.log(`うち ${flaky.length} 件は1回目に落ち、流し直して合格しました（混んでいたか、不安定なテスト）: ${flaky.join(', ')}`)
  process.exit(failed ? 1 : 0)
}

// 1回分: そのテストのすべての起動を、同じ DB の写しで順に流す
let workSeq = 0
async function runOnce(steps) {
  const work = join(DB_ROOT, `work-${++workSeq}`)
  removeDir(work)
  cpSync(TEMPLATE, work, { recursive: true })
  const persist = work.replace(/\\/g, '/')
  let okAll = true
  for (const step of steps) {
    await waitPastJstMidnight()
    await acquireSlot()
    const port = await pickPort(Number(process.env.TEST_PORT || 8899))
    const base = `http://127.0.0.1:${port}`
    const devArgs = ['wrangler', 'dev', '--local', '--port', String(port), '--persist-to', persist,
      ...step.vars.flatMap(([k, v]) => ['--var', `${k}:${v}`]), ...(step.scheduled ? ['--test-scheduled'] : [])]
    if (steps.length > 1) console.log(`--- ${step.file}${step.args.length ? ' ' + step.args.join(' ') : ''}  (${devArgs.slice(2).join(' ')})`)
    const proc = isWin
      ? spawn(['npx', ...devArgs.map(a => /\s/.test(a) ? `"${a}"` : a)].join(' '), { cwd: ROOT, shell: true, stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn('npx', devArgs, { cwd: ROOT, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let errLog = ''
    proc.stderr.on('data', d => { errLog = (errLog + d).slice(-4000) })
    try {
      if (!(await waitReady(proc, base))) { console.error('サーバーが起動しませんでした\n' + errLog); okAll = false; break }
      const env = { ...process.env, BASE: base, PERSIST: persist, ...Object.fromEntries(step.vars) }
      // 書き込みに Origin を付ける（#9943）。切れた接続・DB の取り合いをやり直す（#9980）
      const r = spawnSync(process.execPath, ['--import', './scripts/fetch-origin.mjs', '--import', './scripts/lib/test-preload.mjs', join('scripts', step.file), ...step.args],
        { cwd: ROOT, stdio: 'inherit', env, timeout: TIMEOUT_MS })
      if (r.error && r.error.code === 'ETIMEDOUT') console.error(`${TIMEOUT_MS / 60000} 分で終わらなかったので止めました`)
      if (r.status !== 0) { okAll = false; break }
    } finally {
      await stop(proc, port)
      releaseSlot()
    }
  }
  removeDir(work)
  return okAll
}

// 日本時間の 0 時の直前（MIDNIGHT_WAIT_MIN 分前より後）なら、日付が変わるまで待つ（#9641）。サーバーは日本時間で「今日」を決めるので、
// テストの途中で日付が変わると、テストの始めに作った「今日」とずれて落ちる。1本はふつう数分以内に終わる。
async function waitPastJstMidnight() {
  const MIDNIGHT_WAIT_MIN = 15
  const DAY_MS = 24 * 3600 * 1000
  const left = DAY_MS - (Date.now() + 9 * 3600 * 1000) % DAY_MS // 日本時間の次の 0 時までのミリ秒
  if (left > MIDNIGHT_WAIT_MIN * 60000) return
  console.log(`日本時間の 0 時の直前のため、日付が変わるまで ${Math.ceil(left / 60000)} 分待ちます（テストの途中で日付が変わらないように）`)
  await new Promise(r => setTimeout(r, left + 5000))
}

// 直接実行したときだけ動かす（ほかのスクリプトから parseStep・devSteps・tryLock を読み込んだときは動かさない）
const norm = (p) => isWin ? resolve(p).toLowerCase() : resolve(p)
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) await main()
