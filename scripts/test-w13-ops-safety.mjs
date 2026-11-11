// 障害の記録と通知（利用者の決定 Sprint 13。#9622。作業単位 w13-ops-safety）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --test-scheduled --port 8812 --persist-to <保存先> --var ERROR_ALERT_THRESHOLD:3 で起動していること
//   （通知の目安を 3 件にして確かめる。APP_BASE_URL が http://localhost のときだけ、手元の受け口 http://127.0.0.1 へプッシュを送れる）。
//   プッシュの事業者の代わりに、このテストが 127.0.0.1 に受け口を立てる。
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> ERROR_ALERT_THRESHOLD=3 node scripts/test-w13-ops-safety.mjs
//   PERSIST は必須（予期しないエラーを D1 のトリガーで起こす。#9967）。ローカルの D1 の表の名前を一時的に変えて、定期処理の失敗の記録も確かめる（wrangler d1 execute は --local のみ）。
//   本番には接続しない。テストのたびに DB を作り直すこと（npm test -- w13-ops-safety なら自動で行う）。
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8812'
const PERSIST = process.env.PERSIST || ''
const THRESHOLD = Number(process.env.ERROR_ALERT_THRESHOLD || 10)
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body, rawBody) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), raw: (m, p, raw) => call(m, p, undefined, raw) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w13ops-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  // 手元の空きメモリが少ないと wrangler が落ちることがあるので、3回まで試す
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out)[0].results
    } catch (e) { if (i >= 3) throw e }
  }
}

// ---------- プッシュの事業者の代わりの受け口 ----------
const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => { received.push({ path: req.url, headers: req.headers }); res.statusCode = 201; res.end() })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const EP = (p) => `http://127.0.0.1:${server.address().port}${p}`
const waitPush = async (path, since, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = received.slice(since).find(x => x.path === path)
    if (hit) return hit
    await sleep(200)
  }
  return null
}
const KEYS = { p256dh: 'BOr4bW1kZXZpY2VLZXlGb3JUZXN0aW5nT25seQ', auth: 'dGVzdEF1dGhLZXk' }

const hq = client(await login('', 'hq'))
const admin = client(await login('sample', 'admin'))
const staff = client(await login('sample', 'st001'))
const anon = client('')
const me = must(await admin.get('/api/auth/me'), 'me')

// 予期しないエラーを起こす。壊れた JSON は 400 になった（#9967）ので、テスト用の D1 にトリガーを置いて、社員名簿の保存を
// 入力の抜粋（メールアドレス・電話番号）を含む D1 のエラーで失敗させる（下の「同じエラーの連続」の後で消す。PERSIST が要る）
if (!PERSIST) throw new Error('PERSIST（テスト用の D1 の保存先）を指定してください（予期しないエラーを D1 のトリガーで起こすため。#9967）')
const BOOM_MSG = 'w13 boom "secret-input" staff@example.com 09012345678'
sql(`CREATE TRIGGER w13_boom_u BEFORE UPDATE ON employee_records WHEN NEW.staff_id = 1 BEGIN SELECT RAISE(ABORT, '${BOOM_MSG}'); END;
CREATE TRIGGER w13_boom_i BEFORE INSERT ON employee_records WHEN NEW.staff_id = 1 BEGIN SELECT RAISE(ABORT, '${BOOM_MSG}'); END;`)
const boom = () => admin.raw('PUT', '/api/admin/employees/1', '{}')
// 応答の後（waitUntil）に記録されるので、出てくるまで待つ
async function waitLog(ref, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = await hq.get(`/api/hq/errors?q=${ref}`)
    const hit = (r.data?.logs || []).find(l => l.ref === ref)
    if (hit) return hit
    await sleep(250)
  }
  return null
}

// =========================================================
// 権限と初期の状態
// =========================================================
{
  const d = must(await hq.get('/api/hq/errors'), 'errors')
  ok('#9622 本部は障害の一覧を開ける（件数・推移・設定）', Array.isArray(d.logs) && d.trend.length === 14 && d.settings.threshold === THRESHOLD && d.keep_days === 90, d.settings)
  ok('#9622 会社の管理者は障害の一覧を使えない（403）', (await admin.get('/api/hq/errors')).status === 403)
  ok('#9622 スタッフは障害の一覧を使えない（403）', (await staff.get('/api/hq/errors')).status === 403)
  ok('#9622 ログインしていなければ使えない（401）', (await anon.get('/api/hq/errors')).status === 401)
  ok('#9622 会社の管理者は本部のプッシュの購読を使えない（403）', (await admin.get('/api/hq/push/config')).status === 403)
  const bad = await hq.get('/api/hq/errors?q=' + encodeURIComponent("1' OR 1=1"))
  ok('#9622 参照番号の形でない検索は 400', bad.status === 400 && /参照番号/.test(bad.data?.error || ''), bad.data)
}

// =========================================================
// 本部の管理者の端末をプッシュの受け口に登録しておく
// =========================================================
{
  const cfg = must(await hq.get('/api/hq/push/config'), 'hq push config')
  ok('#9622 本部の管理者もプッシュの公開鍵を取れる', cfg.available === true && typeof cfg.public_key === 'string' && cfg.public_key.length > 40, cfg)
  const sub = await hq.post('/api/hq/push/subscribe', { endpoint: EP('/push/hq'), keys: KEYS })
  ok('#9622 本部の管理者の端末を登録できる', sub.status === 200, sub.data)
  const cfg2 = must(await hq.get(`/api/hq/push/config?endpoint=${encodeURIComponent(EP('/push/hq'))}`), 'hq push config2')
  ok('#9622 登録した端末は subscribed=true', cfg2.subscribed === true, cfg2)
  const since = received.length
  const t = await hq.post('/api/hq/push/test', { endpoint: EP('/push/hq') })
  ok('#9622 本部の端末へテスト通知を送れる', t.status === 200 && !!(await waitPush('/push/hq', since)), t.data)
  const lat = must(await hq.get(`/api/hq/push/latest?endpoint=${encodeURIComponent(EP('/push/hq'))}`), 'latest test')
  ok('#9622 テスト通知の中身は本部画面を開く', lat.test === true && lat.link === '/hq#errors', lat)
}

// =========================================================
// 予期しないエラーの記録
// =========================================================
let firstRef
const pushSince = received.length
{
  const r = await boom()
  firstRef = r.data?.ref
  ok('#230 予期しないエラーは今までどおり 500 と参照番号を返す', r.status === 500 && /^[0-9a-f]{8}$/.test(firstRef || '') && /参照番号/.test(r.data?.error || ''), r.text.slice(0, 200))
  const log = await waitLog(firstRef)
  ok('#9622 参照番号で記録を探せる', !!log, firstRef)
  ok('#9622 記録: 種類・メソッド・パス・会社・ロール・エラーの種類', log && log.source === 'request' && log.method === 'PUT' && log.path === '/api/admin/employees/1'
    && Number(log.company_id) === Number(me.company_id) && log.role === 'company_admin' && log.error_name === 'Error' && !!log.company_name, log)
  const flat = JSON.stringify(log || {})
  ok('#9622 記録に入力値・メールアドレス・電話番号・利用者の ID を残さない', !/secret-input|example\.com|09012345678|not json/.test(flat) && !('user_id' in (log || {})), log)
  const pre = must(await hq.get(`/api/hq/errors?q=${firstRef.slice(0, 4)}`), 'prefix')
  ok('#9622 参照番号の途中まででも探せる', pre.logs.some(l => l.ref === firstRef), pre.logs.map(l => l.ref))
  const none = must(await hq.get('/api/hq/errors?q=ffffffff'), 'none')
  ok('#9622 ない参照番号は0件', none.logs.every(l => l.ref !== firstRef), none.logs.length)
  const bySource = must(await hq.get('/api/hq/errors?source=cron'), 'cron only')
  ok('#9622 種類（定期処理）で絞り込める', bySource.logs.every(l => l.source === 'cron'), bySource.logs.slice(0, 2))
  const byCompany = must(await hq.get(`/api/hq/errors?company_id=${me.company_id}`), 'company')
  ok('#9622 企業で絞り込める', byCompany.logs.length > 0 && byCompany.logs.every(l => Number(l.company_id) === Number(me.company_id)), byCompany.logs.length)
}

// =========================================================
// 目安を超えたら本部の管理者に通知（アプリ内 + プッシュ）。同じ通知は繰り返さない
// =========================================================
{
  const before = must(await hq.get('/api/hq/errors/alerts'), 'alerts before').alerts_unread.length
  ok('#9622 目安の手前では通知しない', before === 0, before)
  for (let i = 1; i < THRESHOLD; i++) await boom()
  let alerts = []
  for (let i = 0; i < 40 && !alerts.length; i++) { await sleep(250); alerts = must(await hq.get('/api/hq/errors/alerts'), 'alerts').alerts_unread }
  ok(`#9622 直近の件数が目安（${THRESHOLD}件）に達したら、本部の管理者にアプリ内の通知が届く`, alerts.length === 1 && /エラーが増えています/.test(alerts[0].title), alerts)
  const hit = await waitPush('/push/hq', pushSince)
  ok('#9622 本部の管理者の端末にプッシュ通知が届く', !!hit && /^vapid /.test(hit.headers.authorization || ''), hit && hit.headers)
  const lat = must(await hq.get(`/api/hq/push/latest?endpoint=${encodeURIComponent(EP('/push/hq'))}`), 'latest')
  ok('#9622 プッシュを受けた端末には、障害の通知の文面と本部画面の「障害」を返す', /エラーが増えています/.test(lat.title || '') && lat.link === '/hq#errors', lat)
  const adminNotifs = must(await admin.get('/api/admin/notifications?kind=error_alert'), 'admin notifs').notifications || []
  ok('#9622 会社の管理者には障害の通知を送らない', adminNotifs.length === 0, adminNotifs.slice(0, 2))
  // さらに起こしても、cooldown の間は通知を増やさない
  for (let i = 0; i < 3; i++) await boom()
  await sleep(1500)
  const d = must(await hq.get('/api/hq/errors'), 'errors after')
  ok('#9622 同じ通知を繰り返さない（最後の通知から一定時間は送らない）', d.alerts_unread.length === 1 && !!d.last_alert && d.last_alert.notified >= 1, [d.alerts_unread.length, d.last_alert])
  ok('#9622 直近の件数と24時間の件数が数えられている', d.totals.last_window >= THRESHOLD + 3 && d.totals.last_24h >= THRESHOLD + 3, d.totals)
  const g = d.groups.find(x => x.path === '/api/admin/employees/1')
  ok('#9622 よく起きているエラーに、同じエラーがまとまって出る', !!g && Number(g.n) >= THRESHOLD + 3, d.groups.slice(0, 2))
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const t = d.trend.find(x => x.day === today)
  ok('#9622 件数の推移（今日）に数えられている', !!t && t.count >= THRESHOLD + 3, d.trend.slice(-2))
  const rd = must(await hq.post('/api/hq/errors/alerts/read', {}), 'read')
  const after = must(await hq.get('/api/hq/errors/alerts'), 'alerts after').alerts_unread
  ok('#9622 「確認しました」で既読にできる', rd.read >= 1 && after.length === 0, [rd, after])
}

// =========================================================
// 同じエラーの連続は、行を増やさずに数える
// =========================================================
{
  const N = 24
  for (let i = 0; i < N; i++) await boom()
  let rows = [], total = 0
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const d = must(await hq.get(`/api/hq/errors?company_id=${me.company_id}&source=request`), 'list')
    rows = d.logs.filter(l => l.path === '/api/admin/employees/1')
    total = rows.reduce((a, l) => a + 1 + Number(l.repeat_count || 0), 0)
    if (total >= N + THRESHOLD + 3) break
  }
  ok('#9622 同じエラーは10分あたり20行までにして、それ以上は最後の行に数える', rows.length === 20 && rows.some(l => Number(l.repeat_count) > 0), [rows.length, rows.map(l => l.repeat_count)])
  ok('#9622 まとめた分も件数に入る', total === N + THRESHOLD + 3, total)
}
sql('DROP TRIGGER IF EXISTS w13_boom_u; DROP TRIGGER IF EXISTS w13_boom_i;')

// =========================================================
// 定期処理の失敗も記録する（PERSIST 指定と --test-scheduled のときだけ）
// =========================================================
if (PERSIST) {
  const probe = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`).catch(() => null)
  if (probe && probe.status === 200) {
    sql('ALTER TABLE notices RENAME TO notices_w13_bak')
    let r
    try { r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`) } finally { sql('ALTER TABLE notices_w13_bak RENAME TO notices') }
    let log = null
    for (let i = 0; i < 20 && !log; i++) {
      const d = must(await hq.get('/api/hq/errors?source=cron'), 'cron logs')
      log = d.logs.find(l => l.path === 'notice_scheduled_publish')
      if (!log) await sleep(250)
    }
    ok('#9622 定期処理の失敗を記録する（処理名・CRON・参照番号）', r && log && log.method === 'CRON' && /^[0-9a-f]{8}$/.test(log.ref) && log.company_id == null && /notices/.test(log.message || ''), log)
    const runs = must(await hq.get('/api/hq/cron/status'), 'cron status')
    const job = (runs.latest || []).find(x => x.job === 'notice_scheduled_publish')
    ok('#9622 定期処理の記録（cron_runs）は今までどおり「失敗」', job && job.status === 'failed', job)
    const n = sql('SELECT COUNT(*) AS n FROM notices')[0].n
    ok('（後片付け）表の名前を戻した', Number(n) >= 0)
  } else skip('#9622 定期処理の失敗の記録', '--test-scheduled なしで起動')
} else skip('#9622 定期処理の失敗の記録', 'PERSIST 未指定')

// =========================================================
// 保存期間（90日）と解約企業の削除の対象
// =========================================================
{
  const dr = must(await hq.post('/api/hq/retention/dry-run', {}), 'dry-run')
  const targets = (dr.results || []).map(r => r.target)
  ok('#9622 データ保持の定期削除の対象に障害の記録（error_logs・error_alerts）が入る', targets.includes('error_logs') && targets.includes('error_alerts'), targets)
  const ob = must(await hq.get(`/api/hq/offboarding/${me.company_id}`), 'offboarding')
  const t = (ob.tables || []).find(x => x.target === 'error_logs')
  ok('#9622 解約企業の削除の対象に error_logs が入る（未対応の表として出ない）', !!t && t.count > 0 && t.export === false && t.delete === true && !(ob.unknown_tables || []).includes('error_logs'), [t, ob.unknown_tables])
  if (PERSIST) {
    sql(`INSERT INTO error_logs (ref, source, fingerprint, created_at) VALUES ('0ld00001', 'request', 'x', '2020-01-01 00:00:00')`)
    const dr2 = must(await hq.post('/api/hq/retention/dry-run', {}), 'dry-run2')
    const e = (dr2.results || []).find(r => r.target === 'error_logs')
    ok('#9622 90日を過ぎた記録が削除の対象に数えられる（dry-run）', e && e.targetCount >= 1, e)
  } else skip('#9622 90日を過ぎた記録の削除', 'PERSIST 未指定')
}

// =========================================================
// 伏せ字の処理（src/lib/error-log.ts を直接読み込んで確かめる。Node の型の除去で .ts を読めるとき）
// =========================================================
try {
  const m = await import('../src/lib/error-log.ts')
  ok('#9622 パスのトークンは伏せ、ルート名は残す', m.maskPath('/api/public/report/Ab3dEfGhIjKlMnOpQrStUv12/x') === '/api/public/report/***/x'
    && m.maskPath('/api/admin/attendance-corrections/12') === '/api/admin/attendance-corrections/12', [m.maskPath('/api/public/report/Ab3dEfGhIjKlMnOpQrStUv12/x'), m.maskPath('/api/admin/attendance-corrections/12')])
  const s = m.sanitizeErrorText('Unexpected token \'n\', "{name: 山田太郎}" is not valid JSON; to a.b@example.co.jp tel 09012345678 key Zx9kLmNoPqRsTuVwXy12ab')
  ok('#9622 要約の引用・メール・電話番号・鍵を伏せる', !/山田|example|09012345678|Zx9k/.test(s) && /Unexpected token 'n'/.test(s), s)
  const e = m.summarizeError(new TypeError('Cannot read properties of undefined (reading \'staff_id\')'))
  ok('#9622 エラーの種類と要約を取り出す', e.name === 'TypeError' && /reading 'staff_id'/.test(e.message), e)
  const st = m.errorAlertSettings({ DB: null, ERROR_ALERT_THRESHOLD: 'abc', ERROR_ALERT_WINDOW_MINUTES: '0', ERROR_ALERT_COOLDOWN_MINUTES: '30' })
  ok('#9622 目安の設定は、範囲の外・数字でない値なら既定を使う', st.threshold === 10 && st.window_minutes === 10 && st.cooldown_minutes === 30, st)
} catch (e) {
  skip('#9622 伏せ字の処理（単体）', `.ts を読み込めない: ${String(e).slice(0, 120)}`)
}

// =========================================================
// 画面
// =========================================================
{
  const page = await fetch(`${BASE}/hq`, { headers: { Cookie: (await login('', 'hq')) } })
  const html = await page.text()
  ok('#9622 本部画面に「障害」のタブがある', page.status === 200 && /data-tab="errors"/.test(html) && /hq-errors-badge/.test(html))
  const js = await (await fetch(`${BASE}/static/hq.js`)).text()
  ok('#9622 本部画面の「障害」を描く処理がある', /function renderErrors/.test(js) && /errors: renderErrors/.test(js))
  const sw = await (await fetch(`${BASE}/sw.js`)).text()
  ok('#9622 Service Worker は本部画面（scope /hq）でも使える', /'\/hq'/.test(sw) && /push\/latest/.test(sw))
}

server.close()
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
