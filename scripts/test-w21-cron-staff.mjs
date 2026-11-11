// w21-cron-staff（#9946 #9947）の統合テスト
// #9946 定期処理の警告の目安を処理ごとにする。15分おきの処理（*/15）は1時間、毎日の処理は今までどおり25時間で、本部画面（GET /api/hq/cron/status）に警告を出す
//   - 最後の実行が古いと警告が出る・新しいと出ない（15分おき: 70分前は出る・40分前は出ない。毎日: 26時間前は出る・24時間前は出ない）
//   - 全体が止まったときは今までどおり1つの警告にまとめる。一覧から外した処理は25時間を目安にする（今までと同じ）
//   - 本当に */15 の起動をすると、その処理の警告は消える（/__scheduled）
// #9947 スタッフアプリを開いたときに /api/auth/me を1回だけ呼ぶ（staff.js の起動で読んだものを staff-profile.js の仮パスワードの確かめにも使う）
//   - 画面（ヘッドレスの Chrome）: /api/auth/me が1回・ほかの API も2回ずつ呼ばない・JS のエラーなしで描ける・仮パスワードの人には変更の画面が出る
//   Chrome が無いときは画面の確認を省く（CHROME=<chrome.exe のパス> で指定できる）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --test-scheduled --port 8713 --persist-to <保存先> で起動していること（本番には接続しない）
// 実行: BASE=http://127.0.0.1:8713 PERSIST=<保存先> node scripts/test-w21-cron-staff.mjs
//   PERSIST はローカルの D1 に cron_runs の行を直接書くのに使う（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8713'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts) } catch (e) { return fetch(url, opts) }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetchRetry(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { cookie, get: (p) => call('GET', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w21cs-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  // 手元の空きメモリが少ないと wrangler が落ちることがあるので、3回まで試す
  for (let i = 1; ; i++) {
    try {
      return execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (e) { if (i >= 3) throw e }
  }
}

const hq = client(await login('sample', 'hq'))

// ---------- #9946 定期処理の警告の目安 ----------
const status = async () => must(await hq.get('/api/hq/cron/status'), 'cron status')
const staleOf = (s) => s.warnings.filter(w => w.kind === 'stale')
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString()
{
  const s = await status()
  const by = s.stale_hours_by_job || {}
  ok('#9946 15分おきの処理（reminders・push_queue・notification_digest・notice_scheduled_publish・doc_expiry_notice）の目安は1時間',
    ['reminders', 'push_queue', 'notification_digest', 'notice_scheduled_publish', 'doc_expiry_notice'].every(j => by[j] === 1), by)
  ok('#9946 毎日の処理（auth_purge・retention・notice_read_reports・billing_close など）の目安は今までどおり25時間',
    ['auth_purge', 'token_purge', 'retention', 'retirements', 'notice_read_reports', 'retention_in_service', 'billing_close'].every(j => by[j] === 25) && s.stale_hours === 25, { by, stale_hours: s.stale_hours })
}
if (!PERSIST) console.log('SKIP  #9946 警告の出る・出ないの確認（PERSIST が無いため cron_runs に書けません）')
else {
  const jobs = Object.keys((await status()).stale_hours_by_job || {})
  // affiliation_schedules_rest は Sprint 24（#9968）で足した15分おきの処理
  const FREQ = ['reminders', 'push_queue', 'notification_digest', 'notice_scheduled_publish', 'doc_expiry_notice', 'affiliation_schedules_rest']
  // 処理ごとに最後の実行の日時（何時間前か）を決めて、cron_runs をその1行ずつにする
  const setRuns = (hoursAgo, extra = []) => sql(`DELETE FROM cron_runs;
${[...jobs.map(j => [j, typeof hoursAgo === 'function' ? hoursAgo(j) : hoursAgo]), ...extra].map(([j, h]) =>
    `INSERT INTO cron_runs (cron, job, label, status, result_json, started_at, finished_at) VALUES ('${FREQ.includes(j) ? '*/15 * * * *' : '0 18 * * *'}', '${j}', 'テスト ${j}', 'ok', '{"w21":1}', '${ago(h)}', '${ago(h)}');`).join('\n')}`)
  const fresh = (j) => FREQ.includes(j) ? 0.1 : 2

  setRuns(fresh)
  let s = await status()
  ok('#9946 すべての処理が目安の内に動いていれば、止まった・未実行の警告は出ない', s.warnings.length === 0, s.warnings)

  setRuns(j => j === 'reminders' ? 70 / 60 : fresh(j))
  s = await status()
  const rem = staleOf(s).find(w => w.job === 'reminders')
  ok('#9946 15分おきの処理が70分前から動いていないと警告する', !!rem && /1時間実行されていません/.test(rem.message) && /\*\/15 \* \* \* \*/.test(rem.message), s.warnings)
  ok('#9946 そのときほかの処理には警告を出さない', staleOf(s).length === 1, s.warnings)

  setRuns(j => j === 'reminders' ? 40 / 60 : fresh(j))
  s = await status()
  ok('#9946 15分おきの処理が40分前に動いていれば警告しない', staleOf(s).length === 0, s.warnings)

  setRuns(j => j === 'auth_purge' ? 24 : fresh(j))
  s = await status()
  ok('#9946 毎日の処理は24時間前に動いていれば警告しない（25時間のまま）', staleOf(s).length === 0, s.warnings)

  setRuns(j => j === 'auth_purge' ? 26 : fresh(j))
  s = await status()
  ok('#9946 毎日の処理が26時間前から動いていないと警告する', staleOf(s).length === 1 && staleOf(s)[0].job === 'auth_purge' && /26時間実行されていません$/.test(staleOf(s)[0].message), s.warnings)

  // 毎日の処理だけが動いていて、15分おきの処理が止まった（triggers.crons から */15 が抜けたなど）
  setRuns(j => FREQ.includes(j) ? 5 : 2)
  s = await status()
  ok('#9946 毎日の処理は動いていても、15分おきの処理が5時間止まっていれば、その処理ごとに警告する',
    FREQ.every(j => staleOf(s).some(w => w.job === j)) && staleOf(s).length === FREQ.length && !staleOf(s).some(w => w.job === null), s.warnings)

  // 全体が止まった: 今までどおり1つの警告にまとめる
  setRuns(30)
  s = await status()
  ok('#9946 全体が30時間止まったときは「定期処理が30時間実行されていません」の1つにまとめる', staleOf(s).length === 1 && staleOf(s)[0].job === null && /定期処理が30時間/.test(staleOf(s)[0].message), s.warnings)
  setRuns(j => j === 'reminders' ? 40 : 30)
  s = await status()
  ok('#9946 全体が止まる前から止まっていた処理は、それも出す', staleOf(s).length === 2 && staleOf(s).some(w => w.job === 'reminders' && /40時間/.test(w.message)), s.warnings)

  // 一覧から外した処理（今までと同じ: 25時間を目安・7日以内だけ）
  setRuns(fresh, [['w21_removed_job', 50]])
  s = await status()
  ok('#9946 一覧から外した処理は今までどおり25時間を目安に警告する（50時間前）', staleOf(s).some(w => w.job === 'w21_removed_job'), s.warnings)
  setRuns(fresh, [['w21_removed_job', 2], ['w21_removed_old', 24 * 8]])
  s = await status()
  ok('#9946 一覧から外した処理は、2時間前なら警告しない・8日前なら警告しない（7日以内だけ）', staleOf(s).length === 0, s.warnings)

  // 本当に15分おきの起動をすると、その処理の警告は消える
  setRuns(j => FREQ.includes(j) ? 2 : fresh(j))
  s = await status()
  ok('（前提）15分おきの処理が2時間前のままだと警告が出ている', FREQ.every(j => staleOf(s).some(w => w.job === j)), s.warnings)
  const r = await fetchRetry(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *').replace(/%20/g, '+')}`)
  ok('（前提）*/15 の定期処理を起動できる（wrangler dev --test-scheduled）', r.status === 200, r.status)
  s = await status()
  ok('#9946 */15 の起動の後は、15分おきの処理の警告は消える（毎日の処理は起動しない）', staleOf(s).length === 0 && s.latest.filter(x => FREQ.includes(x.job)).every(x => Date.now() - Date.parse(x.started_at) < 10 * 60000)
    && s.latest.find(x => x.job === 'auth_purge')?.result_json === '{"w21":1}', { warnings: s.warnings, latest: s.latest.map(x => [x.job, x.started_at]) })
}

// ---------- #9947 スタッフアプリの /api/auth/me（静的な確認） ----------
const js = async (name) => (await fetchRetry(`${BASE}/static/${name}`)).text()
{
  const staff = await js('staff.js'), profile = await js('staff-profile.js'), att = await js('staff-attendance.js')
  const calls = (src) => (src.match(/axios\.get\('\/api\/auth\/me'/g) || []).length
  ok('#9947 staff.js の起動だけが /api/auth/me を呼び、読んだものを ME_READY で渡す', calls(staff) === 1 && /const ME_READY = new Promise/.test(staff) && /resolveMeReady\(ME\)/.test(staff), calls(staff))
  ok('#9947 staff-profile.js・staff-attendance.js は /api/auth/me を呼ばない（仮パスワードの確かめは ME_READY を使う）', calls(profile) === 0 && calls(att) === 0 && /await ME_READY/.test(profile))
}

// ---------- #9947 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  #9947 画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w21cs-chrome-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=420,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []; const reqs = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
      if (m.method === 'Network.requestWillBeSent') {
        const u = new URL(m.params.request.url)
        if (u.origin === BASE && u.pathname.startsWith('/api/')) reqs.push({ method: m.params.request.method, path: u.pathname })
      }
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const cnt = (rs) => rs.reduce((a, r) => { const k = `${r.method} ${r.path}`; a[k] = (a[k] || 0) + 1; return a }, {})
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

    const open = async (cookie) => {
      await send('Network.clearBrowserCookies')
      const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
      reqs.splice(0); errors.splice(0)
      await send('Page.navigate', { url: `${BASE}/staff` })
      const shown = await until(`typeof ME !== 'undefined' && !!ME && !!document.getElementById('user-name').textContent && !document.querySelector('#app .spin')`, 30000)
      // 開いたときの読み込み（ホーム・案内・通知の数など）が済むまで待つ
      await wait(6000)
      return { shown, oc: cnt(reqs.splice(0)) }
    }

    // 1. ふつうのスタッフ
    const st1 = await login('sample', 'st001')
    const a = await open(st1)
    if (process.env.VERBOSE) console.log('開いたときの API:', JSON.stringify(a.oc))
    ok('#9947 画面: スタッフアプリを開いたときの GET /api/auth/me は1回（前は2回）', a.oc['GET /api/auth/me'] === 1, a.oc)
    const dup = Object.entries(a.oc).filter(([, c]) => c > 1)
    ok('#9947 画面: 開いたときに同じ API を2回ずつ呼ばない', dup.length === 0, { dup, all: a.oc })
    ok('#9947 画面: ホームが描ける（名前・ホームの中身）', a.shown && await ev(`document.getElementById('app').innerText.trim().length > 0 && document.getElementById('user-name').textContent === ME.name`) === true, a)
    ok('#9947 画面: 仮パスワードでない人には変更の画面を出さない', await ev(`!/パスワードを変更してください/.test(document.getElementById('modal-root').innerText)`) === true)
    ok('#9947 画面: スクリプトのエラーがない', errors.length === 0, errors)

    // 2. 仮パスワードのままのスタッフ（staff-profile.js の確かめが ME_READY で動く）
    if (!PERSIST) console.log('SKIP  #9947 画面: 仮パスワードの人の確認（PERSIST が無いため）')
    else {
      const st5 = await login('sample', 'st005')
      sql(`UPDATE users SET must_change_password = 1 WHERE user_code = 'st005' AND company_id = (SELECT company_id FROM companies WHERE company_code = 'sample')`)
      const b = await open(st5)
      ok('#9947 画面: 仮パスワードの人にも GET /api/auth/me は1回', b.oc['GET /api/auth/me'] === 1, b.oc)
      ok('#9947 画面: 仮パスワードの人には、閉じられない変更の画面が出る（今までどおり）', await until(`/パスワードを変更してください/.test(document.getElementById('modal-root').innerText) && !!document.getElementById('fpw-new')`, 5000), await ev(`document.getElementById('modal-root').innerText.slice(0, 200)`))
      ok('#9947 画面: スクリプトのエラーがない（仮パスワードの人）', errors.length === 0, errors)
      sql(`UPDATE users SET must_change_password = 0 WHERE user_code = 'st005' AND company_id = (SELECT company_id FROM companies WHERE company_code = 'sample')`)
    }
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

try { rmSync(SQL_DIR, { recursive: true, force: true }) } catch { }
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
