// w26-ops（Sprint 26 #9979 #9980）の確認。アプリのコードは変えていないので、運用の道具・テストの道具・手順書を確かめる。
//   1) 戻す訓練（scripts/restore-drill.mjs）: テスト用 DB の写しで、書き出す → 壊す → 全体を戻す・一部を戻す → 元と同じ（RESTORE_DRILL=0 で省く）
//   2) 手順書（docs/operations.md の 4章）に、戻す時点・戻す前・戻した後・R2・告知・訓練の記録があり、書いた wrangler のオプションが今の版の --help にある
//   3) npm test の起動のオプションの読み取り（// run-tests: の行・使えない値・同じ名前の --var）
//   4) テストの道具: fetch の ECONNRESET の送り直し・wrangler d1 execute の internal error のやり直し・npm test のロック
//   5) CDN: src/index.tsx の SRI のすべてのファイルを手元（node_modules・scripts/lib/cdn-min）で返せて、ハッシュが合う。ヘッドレス Chrome のテストはすべて lib/chrome.mjs で起動する
//   6) 画面: CDN に接続できない Chrome でも、ログイン・管理画面・スタッフアプリ・本部画面で axios・dayjs などが読め、エラーが出ない（Chrome が無ければ省く）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build && npx wrangler dev --local --port 9081 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（訓練はその写しで行い、保存先の中身は変えない）。
// 実行: BASE=http://127.0.0.1:9081 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs --import ./scripts/lib/test-preload.mjs scripts/test-w26-ops.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

await import('./lib/test-preload.mjs')   // npm test は先に読み込んでいる。手で流したときも同じにする（2回読んでも1回分だけ効く）
const { devSteps, tryLock } = await import('./run-tests.mjs')
const chromeLib = await import('./lib/chrome.mjs')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9081'
const PERSIST = process.env.PERSIST || ''
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const TMP = mkdtempSync(join(tmpdir(), 'w26ops-'))

// ============ 1) 戻す訓練 ============
if (process.env.RESTORE_DRILL === '0') skip('戻す訓練', 'RESTORE_DRILL=0')
else if (!PERSIST || !existsSync(join(PERSIST, 'v3', 'd1'))) skip('戻す訓練', 'PERSIST にテスト用 DB の保存先を指定してください')
else {
  const out = join(TMP, 'drill.json')
  let log = '', status = 0
  try { log = execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'scripts', 'restore-drill.mjs'), PERSIST, '--json', out], { cwd: ROOT, encoding: 'utf8', timeout: 20 * 60000 }) } catch (e) { status = e.status ?? 1; log = String(e.stdout || '') + String(e.stderr || e.message) }
  const r = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  const s = (n) => r?.steps.find(x => x.name.startsWith(n))
  ok('#9979 訓練を最後まで流せた（終了コード 0）', status === 0 && r?.ok, log.slice(-800))
  ok('#9979 1: 元の DB の表と行を控えた', s('1.')?.表の数 > 100 && s('1.')?.行の合計 > 0, s('1.'))
  ok('#9979 2: wrangler d1 export（--local）で書き出し、トリガーはデータの後に作られる', s('2.')?.INSERT > 0 && s('2.')?.トリガーを作るのはデータの後 === true, s('2.'))
  ok('#9979 3: 壊した DB は元と違う（日報・打刻・評価）', ['daily_reports', 'attendance_reports', 'evaluations'].every(t => (s('3.')?.変わった表 || []).some(x => x.startsWith(t))), s('3.'))
  ok('#9979 4: 全体を戻すと、すべての表の行数・中身・スキーマが元と同じ', s('4.') && s('4.').違う表.length === 0 && s('4.').違うスキーマ.length === 0 && s('4.').行の合計 === s('1.').行の合計, s('4.'))
  ok('#9979 5: 一部の行だけを戻すと、元と同じ（消えた行を足し・書き換わった行を直す）', s('5.') && s('5.').違う表.length === 0 && s('5.').内訳.some(x => /daily_reports: 足す [1-9]/.test(x)) && s('5.').内訳.some(x => /attendance_reports: .*直す [1-9]/.test(x)), s('5.'))
  ok('#9979 訓練は本番に触らない（wrangler はすべて --local。--remote・--env を拒む）', /--local 以外は実行しない/.test(read('scripts/restore-drill.mjs')) && !/['"]--remote['"]\s*[,\]]/.test(read('scripts/restore-drill.mjs').replace(/a === '--remote'/, '')))
}

// ============ 2) 手順書 ============
{
  const ops = read('docs/operations.md')
  const ch4 = ops.slice(ops.indexOf('## 4. 戻し方・復元'), ops.indexOf('## 5. '))
  ok('#9979 手順書: Time Travel（info でブックマーク・restore を --bookmark / --timestamp で）', /time-travel info mbsaas-production --env production/.test(ch4) && /time-travel restore mbsaas-production --env production --bookmark=/.test(ch4) && /--timestamp=/.test(ch4))
  ok('#9979 手順書: d1 export の SQL から全体・一部を戻す', /一部の行だけを戻す/.test(ch4) && /DB 全体を戻す/.test(ch4) && /d1 execute <新しい名前> --remote --file=/.test(ch4))
  ok('#9979 手順書: どの時点に戻すか・戻す前に今の状態を残す・戻した後の確認', /どの時点に戻すかを決める/.test(ch4) && /戻す前に今の状態を残す/.test(ch4) && /戻した後に確かめる/.test(ch4))
  ok('#9979 手順書: R2 の写真は戻らないことへの対処（紐づかない写真を消さない）', /R2 の写真・書類の扱い/.test(ch4) && /紐づかない写真」を削除しない/.test(ch4))
  ok('#9979 手順書: 利用者への告知（戻す前・終わったとき）', /### 4\.6 利用者への告知/.test(ch4) && /【メンテナンスのお知らせ】/.test(ch4) && /【復旧のお知らせ】/.test(ch4))
  ok('#9979 手順書: 訓練の記録（かかった時間・注意点）', /### 4\.7 戻す訓練/.test(ch4) && /scripts\/restore-drill\.mjs/.test(ch4) && /\| 2026-11-13 \|/.test(ch4) && /気づいたこと/.test(ch4))
  const help = (args) => { try { return execFileSync(process.execPath, [WRANGLER, ...args, '--help'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { return String(e.stdout || '') } }
  const restore = help(['d1', 'time-travel', 'restore']), info = help(['d1', 'time-travel', 'info']), exp = help(['d1', 'export'])
  ok('#9979 今の wrangler の time-travel restore に --bookmark・--timestamp がある', /--bookmark/.test(restore) && /--timestamp/.test(restore), restore.slice(-400))
  ok('#9979 今の wrangler の time-travel info に --timestamp がある', /--timestamp/.test(info))
  ok('#9979 今の wrangler の d1 export に --remote・--output があり、--persist-to は無い（手順書のとおり）', /--remote/.test(exp) && /--output/.test(exp) && !/--persist-to/.test(exp))
  const ver = execFileSync(process.execPath, [WRANGLER, '--version'], { encoding: 'utf8' }).trim().split('\n').pop()
  ok('#9979 手順書に書いた wrangler の版が今の版と同じ', ch4.includes(`wrangler ${ver.replace(/^.*?(\d+\.\d+\.\d+).*$/, '$1')}`), ver)
}

// ============ 3) 起動のオプションの読み取り ============
{
  const steps = (f) => devSteps(f, read(`scripts/${f}`))
  const h = steps('test-history.mjs')
  ok('#9980 test-history: 前提のテストから同じ DB で順に流す（4回の起動）', JSON.stringify(h.map(s => s.file)) === JSON.stringify(['test-report-settings.mjs', 'test-corrections.mjs', 'test-notifications.mjs', 'test-history.mjs'])
    && h[3].scheduled && h[3].vars.some(([k, v]) => k === 'RETENTION_ENABLED' && v === 'true') && h[2].vars.some(([k, v]) => k === 'MAIL_ENABLED' && v === 'true'), h)
  const n = steps('test-notifications.mjs')
  ok('#9980 test-notifications: メールを有効にした回と --mail-disabled の回', n.length === 2 && n[0].vars.some(([k, v]) => k === 'MAIL_ENABLED' && v === 'true') && n[1].args.includes('--mail-disabled') && !n[1].vars.some(([k]) => k === 'MAIL_ENABLED'), n)
  const m = steps('test-w4-notifications-mail.mjs')
  const secret = (read('scripts/test-w4-notifications-mail.mjs').match(/WEBHOOK_SECRET \|\| '([^']+)'/) || [])[1]
  ok('#9980 test-w4-notifications-mail: Webhook の秘密の値をテストの既定値と同じにして起動する', m.length === 1 && m[0].vars.some(([k, v]) => k === 'RESEND_WEBHOOK_SECRET' && v === secret) && m[0].vars.some(([k, v]) => k === 'MAIL_ENABLED' && v === 'true'), m)
  // 前からの書き方: < > や日本語の混ざった値は使わない・同じ名前は最初の値
  const legacy = devSteps('x.mjs', "// --var A_B:<秘密の値> と --var MAIL_ENABLED:true を付ける。2) --var MAIL_ENABLED:false（既定）\n// --var OK_B:abc --test-scheduled\n")
  ok('#9980 前からの書き方: 使えない値は外し、同じ名前は最初の値を使う', JSON.stringify(legacy[0].vars) === JSON.stringify([['MAIL_ENABLED', 'true'], ['OK_B', 'abc']]) && legacy[0].scheduled, legacy)
  let bad = null
  try { devSteps('x.mjs', '// run-tests: --var X:<a>\n') } catch (e) { bad = e.message }
  ok('#9980 // run-tests: の値に使えない文字があれば、起動せずにエラーにする', /読めません/.test(bad || ''), bad)
  const all = readdirSync(join(ROOT, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f))
  const problems = []
  for (const f of all) {
    let st
    try { st = steps(f) } catch (e) { problems.push(`${f}: ${e.message}`); continue }
    for (const s of st) {
      if (!existsSync(join(ROOT, 'scripts', s.file))) problems.push(`${f}: ${s.file} が無い`)
      const keys = s.vars.map(([k]) => k)
      if (new Set(keys).size !== keys.length) problems.push(`${f}: 同じ名前の --var`)
      if (s.vars.some(([, v]) => !/^[A-Za-z0-9_.:/+=@-]+$/.test(v))) problems.push(`${f}: 使えない値`)
    }
  }
  ok(`#9980 すべてのテスト（${all.length} 本）の起動のオプションが読める`, problems.length === 0, problems)
}

// ============ 4) テストの道具 ============
{
  // ECONNRESET: 1回目の接続は RST で切り、2回目に答えるサーバー
  let hits = 0
  const srv = createServer(sock => {
    hits++
    if (hits === 1) { sock.once('data', () => sock.resetAndDestroy()); return }
    sock.once('data', () => sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'))
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  let text = null, err = null
  try { text = await (await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'a' })).text() } catch (e) { err = e?.cause?.code || e.message }
  srv.close()
  ok('#9980 fetch: ECONNRESET のときは送り直して成功する', text === 'ok' && hits === 2, { text, err, hits })
  let refused = null
  const t0 = Date.now()
  try { await fetch(`http://127.0.0.1:${port}/x`) } catch (e) { refused = e?.cause?.code }
  ok('#9980 fetch: ECONNREFUSED（サーバーが無い）はやり直さずにすぐ失敗する', refused === 'ECONNREFUSED' && Date.now() - t0 < 1500, { refused, ms: Date.now() - t0 })

  // wrangler d1 execute の internal error: 2回失敗してから成功するコマンドで、やり直されること
  const counter = join(TMP, 'n.txt')
  writeFileSync(counter, '0')
  const script = `const f=${JSON.stringify(counter)};const fs=require('fs');const n=+fs.readFileSync(f,'utf8')+1;fs.writeFileSync(f,String(n));if(n<3){console.log(JSON.stringify({error:{text:'internal error; reference = test'}}));process.exit(1)}console.log('[{"results":[{"ok":1}]}]')`
  let out = null
  try { out = execFileSync(process.execPath, ['-e', script, 'd1', 'execute', 'mbsaas-production', '--local'], { encoding: 'utf8' }) } catch (e) { out = 'ERR ' + e.message }
  ok('#9980 wrangler d1 execute --local の internal error はやり直して成功する', /"ok":1/.test(out || '') && readFileSync(counter, 'utf8') === '3', { out, n: readFileSync(counter, 'utf8') })
  writeFileSync(counter, '0')
  let thrown = false
  try { execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }) } catch { thrown = true }
  ok('#9980 d1 execute でないコマンドはやり直さない', thrown && readFileSync(counter, 'utf8') === '1')
  writeFileSync(counter, '0')
  thrown = false
  try { execFileSync(process.execPath, ['-e', script.replace('internal error; reference = test', 'no such table: x'), 'd1', 'execute', '--local'], { encoding: 'utf8' }) } catch { thrown = true }
  ok('#9980 d1 execute でも、SQL の誤りなどはやり直さない', thrown && readFileSync(counter, 'utf8') === '1')

  // ロック: 持ち主が終わった印は取り直し、動いている npm test の印は取らない
  const lock = join(TMP, 'lock')
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), '999999'); writeFileSync(join(lock, 'at'), '0')
  const got = tryLock(lock)
  const again = tryLock(lock)
  ok('#9980 npm test のロック: 終わったプロセスの印は取り直し、動いているプロセスの印は取らない', got === true && again === false && readFileSync(join(lock, 'pid'), 'utf8') === String(process.pid), { got, again })
  const rt = read('scripts/run-tests.mjs')
  ok('#9980 npm test: 落ちたテストは新しい DB でもう1回流し、「再試行で合格」を分けて出す', /ok = await runOnce\(steps\)/.test(rt) && /再試行で合格/.test(rt))
  ok('#9980 npm test: 置き場所は作業フォルダごと・同時に動かすサーバーの数・ポートが空くまで待つ', /mbsaas-test-\$\{createHash/.test(rt) && /TEST_MAX_SERVERS/.test(rt) && /portFree\(port\)/.test(rt))
  ok('#9980 npm test: 各テストを test-preload.mjs 付きで起動する', /'--import', '\.\/scripts\/lib\/test-preload\.mjs'/.test(rt))
}

// ============ 5) CDN を手元で返す ============
{
  const src = read('src/index.tsx')
  const block = src.slice(src.indexOf('const SRI'), src.indexOf('}', src.indexOf('const SRI')))
  const entries = [...block.matchAll(/'([^']+)': '(sha384-[^']+)'/g)].map(m => [m[1], m[2]])
  const bad = []
  for (const [p, sri] of entries) {
    const { file, why } = chromeLib.localCdnFile('https://cdn.jsdelivr.net/npm/' + p)
    if (!file) { bad.push(`${p}: ${why}`); continue }
    const h = 'sha384-' + createHash('sha384').update(chromeLib.cdnBody(file)).digest('base64')
    if (h !== sri) bad.push(`${p}: ハッシュが違う`)
  }
  ok(`#9980 CDN のファイル（${entries.length} 個）をすべて手元で返せて、SRI のハッシュが合う`, entries.length >= 10 && bad.length === 0, bad)
  const pkg = JSON.parse(read('package.json'))
  const vers = [...new Set(entries.map(([p]) => /^((?:@[^/]+\/)?[^@/]+)@([^/]+)/.exec(p)).map(m => `${m[1]}@${m[2]}`))]
  const missing = vers.filter(v => { const i = v.lastIndexOf('@'); return pkg.devDependencies?.[v.slice(0, i)] !== v.slice(i + 1) })
  ok('#9980 CDN の包みは devDependencies に同じ版で入っている（npm ci で入る）', missing.length === 0, missing)
  const tests = readdirSync(join(ROOT, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f)).map(f => [f, read(`scripts/${f}`)])
  const raw = tests.filter(([, t]) => /spawn\(CHROME/.test(t) || /Math\.random\(\) \* \d+\)\s*$/m.test(t) && /remote-debugging-port/.test(t)).map(([f]) => f)
  const using = tests.filter(([, t]) => /launchChrome\(CHROME/.test(t)).map(([f]) => f)
  ok(`#9980 ヘッドレス Chrome のテスト（${using.length} 本）は、すべて lib/chrome.mjs で起動し、空いているポートを使う`, using.length >= 14 && raw.length === 0 && using.every(f => /freePort\(\)/.test(tests.find(t => t[0] === f)[1])), raw)
}

// ============ 6) 画面: CDN に接続できない Chrome で開く ============
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') skip('画面の確認', 'ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます')
else await browserChecks()

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await chromeLib.freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w26o-'))
  // CDN の名前を引けないようにして、外のネットワークに頼っていないことを確かめる
  const chrome = await chromeLib.launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', '--host-resolver-rules=MAP cdn.jsdelivr.net ~NOTFOUND', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = [], failed = []
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon.ico/.test(m.params.entry.url || '')) errors.push(m.params.entry.text + ' ' + (m.params.entry.url || ''))
      if (m.method === 'Network.loadingFailed') failed.push(m.params.errorText + (m.params.blockedReason ? ' ' + m.params.blockedReason : ''))
    }
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value
    await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable')
    const libs = `JSON.stringify({ axios: typeof axios, dayjs: typeof dayjs, missing: !!window.__LIB_MISSING, fa: [...document.styleSheets].some(s => (s.href || '').includes('fontawesome')) })`
    async function open(path, cookie, extra) {
      await send('Network.clearBrowserCookies')
      if (cookie) { const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
      errors = []; failed = []
      await send('Page.navigate', { url: BASE + path })
      // 読み込みが終わるまで待つ（混んでいると遅い）。終わってから少し待って、後から読む部品とエラーを拾う
      await wait(1000)
      for (let i = 0; i < 60 && await evalJs('document.readyState') !== 'complete'; i++) await wait(500)
      await wait(2000)
      const r = JSON.parse(await evalJs(libs) || '{}')
      const more = extra ? await evalJs(extra) : true
      return { ...r, more, errors: [...errors], failed: [...failed] }
    }
    const good = (r) => r.axios === 'function' && r.dayjs === 'function' && !r.missing && r.errors.length === 0 && r.failed.length === 0
    const lg = await open('/login')
    ok('#9980 画面: CDN に接続できなくても、ログイン画面で axios・dayjs が読め、エラーが出ない', good(lg), lg)
    const ad = await open('/admin', await login('sample', 'admin'), `typeof Chart === 'function' && typeof flatpickr === 'function' && typeof Sortable === 'function' && typeof qrcode === 'function' && typeof jsQR === 'function'`)
    ok('#9980 画面: 管理画面で axios・dayjs・Chart.js・flatpickr・SortableJS・qrcode・jsQR と Font Awesome が読め、エラーが出ない', good(ad) && ad.fa && ad.more === true, ad)
    const st = await open('/staff', await login('sample', 'st001'), `typeof qrcode === 'function'`)
    ok('#9980 画面: スタッフアプリで axios・dayjs・qrcode が読め、エラーが出ない', good(st) && st.more === true, st)
    const hq = await open('/hq', await login('', 'hq'), `typeof qrcode === 'function'`)
    ok('#9980 画面: 本部画面で axios・dayjs・qrcode が読め、エラーが出ない', good(hq) && hq.more === true, hq)
  } catch (e) {
    ok('画面の確認を最後まで流せた', false, String(e.stack || e).slice(0, 600))
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await wait(500)
    try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { }
  }
}

rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
const passed = results.filter(r => r.pass).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
