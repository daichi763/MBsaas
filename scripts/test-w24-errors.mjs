// エラー処理の仕上げ（Sprint 24 #9967。作業単位 w24-errors）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --test-scheduled --port 9021 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w24-errors.mjs
//   PERSIST を指定すると、ローカルの D1 に一時的なトリガー・行を入れて、実績の同期の失敗の記録・知らない cron の式・停止中の企業の確認も行う
//   （wrangler d1 execute は --local のみ）。本番には接続しない。テストのたびに DB を作り直すこと（npm test -- w24-errors なら自動で行う）。
// 確かめること:
//   (1) 壊れた JSON・オブジェクトでない本文を主な POST/PUT に送ると 400（{ error, code: 'bad_json' }）で、障害の記録に入らない
//   (2) /api の存在しないパスは JSON の 404（{ error: '見つかりません' }）。英語の 'not found'・'forbidden' が残っていない
//   (3) 実績の同期の失敗を障害の記録（error_logs）に残し、利用者への応答は成功のまま
//   (5) 停止中の企業のお知らせの確認リンクは使えない（403）
//   (6) 知らない cron の式で起動しても何もしない（期限切れのセッションが消えない・cron_runs が増えない）で、障害の記録に残す
//   (4)(7) Workers Logs の伏せ字・MAIL_ENABLED の判定・APP_BASE_URL の扱い（ソースで確かめる）
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, type: r.headers.get('content-type') || '' }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), raw: (m, p, raw) => call(m, p, undefined, raw) }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w24err-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out)[0].results
    } catch (e) { if (i >= 3) throw e }
  }
}
// wrangler d1 execute の直後は開発サーバーの接続が切れることがあるので、起動を待つ
async function waitServer() {
  for (let i = 0; i < 30; i++) { try { const r = await rawFetch(`${BASE}/login`); if (r.status < 500) return } catch { } await sleep(500) }
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const hq = client(await login('', 'hq'))
const admin = client(await login('sample', 'admin'))
const staff = client(await login('sample', 'st001'))
const anon = client('')
const errLogs = async () => (await hq.get('/api/hq/errors')).data
const errTotal = async () => Number((await errLogs())?.totals?.last_24h) || 0

// =========================================================
// (1) 壊れた JSON は 400 で、障害の記録に入らない
// =========================================================
{
  const before = await errTotal()
  const targets = [
    ['POST', '/api/admin/shifts'], ['PUT', '/api/admin/shifts/1'], ['POST', '/api/admin/staff'], ['PUT', '/api/admin/staff/1'],
    ['PUT', '/api/admin/clients/1'], ['POST', '/api/admin/clients/1/contacts'], ['PUT', '/api/admin/clients/contacts/1'], ['PUT', '/api/admin/employees/1'],
    ['POST', '/api/admin/shift-slots'], ['PUT', '/api/admin/shift-slots/1'], ['POST', '/api/admin/shift-slots/roles/1/assign'], ['POST', '/api/admin/shifts/1/move'],
    ['PUT', '/api/admin/shifts/1/price'], ['POST', '/api/admin/shifts/reprice'], ['POST', '/api/admin/shifts/bulk'], ['POST', '/api/admin/shifts/copy-week'],
    ['POST', '/api/admin/slot-patterns'], ['POST', '/api/admin/sites'], ['PUT', '/api/admin/sites/1'], ['POST', '/api/admin/rate-rules'],
    ['PUT', '/api/admin/rate-rules/1'], ['PUT', '/api/admin/projects/1/pricing'],
  ]
  const bad = []
  for (const [m, p] of targets) {
    const r = await admin.raw(m, p, '{"staff_id": 1,')
    if (!(r.status === 400 && r.data?.code === 'bad_json' && /読み取れませんでした/.test(r.data?.error || ''))) bad.push([m, p, r.status, r.text.slice(0, 120)])
  }
  ok(`#9967 壊れた JSON を ${targets.length} 個の POST/PUT に送ると、どれも 400「送られた内容を読み取れませんでした」`, !bad.length, bad)
  const arr = await admin.raw('POST', '/api/admin/shifts', '[1,2]')
  const nul = await admin.raw('POST', '/api/admin/sites', 'null')
  const empty = await admin.raw('POST', '/api/admin/rate-rules', '')
  ok('#9967 配列・null・空の本文も 400（bad_json）', [arr, nul, empty].every(r => r.status === 400 && r.data?.code === 'bad_json'), [arr.status, nul.status, empty.status])
  const okBody = await admin.post('/api/admin/sites', {})
  ok('#9967 読める JSON は今までどおり入力の確認に進む（開催場所名がなければ 400 の別の文）', okBody.status === 400 && okBody.data?.code !== 'bad_json' && /開催場所名/.test(okBody.data?.error || ''), okBody)
  const att = await staff.raw('POST', '/api/staff/attendance', '{broken')
  ok('#9967 POST /staff/attendance の壊れた本文も 400（500 にしない）', att.status === 400, att)
  await sleep(1500)
  const after = await errTotal()
  ok('#9967 壊れた JSON は障害の記録（error_logs）と通知の件数に入らない', after === before, { before, after })
}

// =========================================================
// (2) /api の 404 は JSON。英語のエラー文を日本語に
// =========================================================
{
  const a = await admin.get('/api/admin/w24-no-such-path')
  ok('#9967 /api の存在しないパスは JSON の 404（{ error: 見つかりません }）', a.status === 404 && /application\/json/.test(a.type) && a.data?.error === '見つかりません', a)
  const s = await staff.get('/api/staff/w24-no-such-path')
  ok('#9967 スタッフの /api の存在しないパスも JSON の 404', s.status === 404 && s.data?.error === '見つかりません', s)
  const n = await anon.get('/api/w24-no-such-path')
  ok('#9967 ログインしていなければ 401 の日本語の JSON（unauthorized ではない）', n.status === 401 && n.data?.error === 'ログインしてください', n)
  const page = await anon.get('/w24-no-such-page')
  ok('#9967 画面の存在しないパスは今までどおりの 404', page.status === 404 && !/application\/json/.test(page.type), { status: page.status, type: page.type })
  const nf = await admin.put('/api/admin/staff/99999999', { name: 'x' })
  ok('#9967 見つからないときの文は日本語（not found ではない）', nf.status === 404 && nf.data?.error === '見つかりません', nf)
  const fb = await staff.get('/api/admin/shifts')
  ok('#9967 権限がないときの文は日本語（forbidden ではない）', fb.status === 403 && fb.data?.error === '権限がありません', fb)
  const files = readdirSync(join(ROOT, 'src')).filter(f => /\.tsx?$/.test(f)).map(f => join('src', f))
  const eng = files.filter(f => /error: '(not found|forbidden|unauthorized)'/.test(readFileSync(join(ROOT, f), 'utf8')))
  ok('#9967 src に英語のエラー文（not found・forbidden・unauthorized）が残っていない', !eng.length, eng)
  const js = readdirSync(join(ROOT, 'public/static')).filter(f => f.endsWith('.js'))
  const jsHits = js.filter(f => /['"](not found|forbidden|unauthorized)['"]/.test(readFileSync(join(ROOT, 'public/static', f), 'utf8')))
  ok('#9967 画面がエラー文を英語で判定している所がない', !jsHits.length, jsHits)
  const uncaught = files.concat(readdirSync(join(ROOT, 'src/lib')).map(f => join('src/lib', f)))
    .flatMap(f => readFileSync(join(ROOT, f), 'utf8').split('\n').map((l, i) => [f, i + 1, l]))
    .filter(([f, , l]) => !f.endsWith('http.ts') && /await c\.req\.json\(\)(?!\s*\.catch)/.test(l) && !/^\s*\/\//.test(l))
  ok('#9967 .catch のない await c.req.json() が残っていない（readJson を使う）', !uncaught.length, uncaught.map(([f, n]) => `${f}:${n}`))
}

// =========================================================
// (4)(7) ソースで確かめる
// =========================================================
{
  const idx = readFileSync(join(ROOT, 'src/index.tsx'), 'utf8')
  const onErr = idx.slice(idx.indexOf('app.onError('), idx.indexOf('app.onError(') + 1500)
  ok('#9967 app.onError の Workers Logs の message・stack は sanitizeErrorText で伏せる', /message: sanitizeErrorText\(/.test(onErr) && /map\(l => sanitizeErrorText\(l/.test(onErr), onErr.slice(0, 300))
  const mail = readFileSync(join(ROOT, 'src/services/email.ts'), 'utf8')
  ok('#9967 mailMode は MAIL_ENABLED が true のときだけ送る（canSendMail と同じ判定）', /if \(env\.MAIL_ENABLED !== 'true'\) return 'disabled'/.test(mail) && /return mailMode\(env\) === 'enabled'/.test(mail))
  const all = readdirSync(join(ROOT, 'src')).filter(f => /\.tsx?$/.test(f)).map(f => join('src', f)).concat(readdirSync(join(ROOT, 'src/lib')).map(f => join('src/lib', f)))
  const raw = all.filter(f => !f.endsWith('http.ts')).filter(f => /\$\{(c\.)?env\.APP_BASE_URL\}|String\((c\.)?env\??\.APP_BASE_URL[^)]*\)(\.trim\(\))?\.replace/.test(readFileSync(join(ROOT, f), 'utf8')))
  ok('#9967 APP_BASE_URL からリンクを作る所は appBaseUrl（末尾の / を除く）にそろえた', !raw.length, raw)
  const http = readFileSync(join(ROOT, 'src/lib/http.ts'), 'utf8')
  ok('#9967 appBaseUrl は前後の空白と末尾の / を除く', /trim\(\)\.replace\(\/\\\/\+\$\/, ''\)/.test(http))
}

// =========================================================
// (3) 実績の同期の失敗を障害の記録に残す（応答は成功のまま）
// =========================================================
if (PERSIST) {
  const work_date = addDays(today, -1)
  const memo = `W24-SYNCFAIL-${Date.now()}`
  const cr = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 1, work_date, start_time: '09:00', end_time: '18:00', memo })
  const sh = cr.status === 200 ? ((await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts || []).find(x => x.memo === memo) : null
  if (!sh) ok('同期の確認用のシフトを作れる', false, cr)
  else {
    const before = (await errLogs())?.logs?.[0]?.error_id || 0
    // このシフトの更新だけを失敗させるトリガー（テスト用の DB だけ。終わったら消す）
    sql(`CREATE TRIGGER w24_sync_fail BEFORE UPDATE ON shifts WHEN OLD.shift_id = ${Number(sh.shift_id)} BEGIN SELECT RAISE(ABORT, 'w24 sync test'); END;`)
    await waitServer()
    let r
    try {
      r = await admin.post(`/api/admin/shifts/${sh.shift_id}/proxy-attendance`, { report_types: ['check_in', 'check_out'], times: { check_in: '09:00', check_out: '18:00' } })
    } finally {
      sql('DROP TRIGGER IF EXISTS w24_sync_fail;')
      await waitServer()
    }
    ok('#9967 実績の同期に失敗しても、代理入力の応答は成功のまま', r.status === 200 && r.data?.created === 2, r)
    let hit = null
    for (let i = 0; i < 10 && !hit; i++) {
      await sleep(500)
      hit = ((await errLogs())?.logs || []).find(l => l.error_id > before && /実績の同期に失敗しました/.test(l.message || ''))
    }
    ok('#9967 実績の同期の失敗が障害の記録（error_logs）に、パス・会社つきで残る', hit && hit.source === 'request' && /proxy-attendance/.test(hit.path || '') && hit.company_id === 1, hit || (await errLogs())?.logs?.slice(0, 3))
    const st = ((await admin.get(`/api/admin/settlement?from=${work_date}&to=${work_date}`)).data?.rows || []).find(x => x.shift_id === sh.shift_id)
    ok('#9967 （確認）トリガーで止めたので実績は入っていない（同期が本当に失敗した）', st && !st.actual_start, st && [st.actual_start, st.actual_end])
  }
} else skip('#9967 実績の同期の失敗の記録', 'PERSIST 未指定')

// =========================================================
// (6) 知らない cron の式で起動しても何もしない
// =========================================================
if (PERSIST) {
  const probe = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('7 7 7 7 *')}`).catch(() => null)
  if (!probe || probe.status === 404) skip('#9967 知らない cron の式', '--test-scheduled で起動していない')
  else {
    // 上の確認でも起動したので、記録を消してから確かめ直す
    const tok = `w24-expired-${Date.now()}`
    sql(`DELETE FROM error_logs WHERE path = 'unknown_cron'; INSERT INTO sessions (token, user_id, company_id, expires_at) VALUES ('${tok}', 1, 1, '2000-01-01T00:00:00.000Z');`)
    const runsBefore = Number(sql('SELECT COUNT(*) AS n FROM cron_runs')[0].n)
    await waitServer()
    const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('1 2 3 4 5').replace(/%20/g, '+')}`)
    ok('#9967 知らない式の起動は終わる', r.status === 200, r.status)
    await sleep(500)
    const left = sql(`SELECT COUNT(*) AS n FROM sessions WHERE token = '${tok}'`)[0].n
    const runsAfter = Number(sql('SELECT COUNT(*) AS n FROM cron_runs')[0].n)
    ok('#9967 知らない式では毎日の処理を実行しない（期限切れのセッションが消えない・cron_runs が増えない）', Number(left) === 1 && runsAfter === runsBefore, { left, runsBefore, runsAfter })
    const rec = sql(`SELECT source, path, message FROM error_logs WHERE path = 'unknown_cron' ORDER BY error_id DESC LIMIT 1`)[0]
    ok('#9967 知らない式で起動したことを障害の記録に残す（定期処理として）', rec && rec.source === 'cron' && /1 2 3 4 5/.test(rec.message) && /何もしませんでした/.test(rec.message), rec)
    await waitServer()
    const d = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('0 18 * * *').replace(/%20/g, '+')}`)
    await sleep(500)
    const left2 = sql(`SELECT COUNT(*) AS n FROM sessions WHERE token = '${tok}'`)[0].n
    ok('#9967 （確認）一覧にある毎日の式なら、期限切れのセッションを消す', d.status === 200 && Number(left2) === 0, { status: d.status, left2 })
    await waitServer()
  }
} else skip('#9967 知らない cron の式', 'PERSIST 未指定')

// =========================================================
// (5) 停止中の企業のお知らせの確認リンク
// =========================================================
if (PERSIST) {
  const token = randomBytes(24).toString('hex')
  const hash = createHash('sha256').update(token).digest('hex')
  const uid = sql("SELECT user_id FROM users WHERE company_id = 1 AND user_code = 'st001'")[0]?.user_id
  sql(`INSERT INTO notice_ack_tokens (token_hash, notice_id, company_id, user_id, expires_at) VALUES ('${hash}', 1, 1, ${Number(uid)}, '2099-01-01 00:00:00');`)
  await waitServer()
  const g1 = await anon.get(`/api/public/notice-ack?token=${token}`)
  ok('#9967 （確認）有効な企業のお知らせの確認リンクは開ける', g1.status === 200 && !!g1.data?.title, g1)
  const prev = sql('SELECT active_status FROM companies WHERE company_id = 1')[0].active_status
  sql("UPDATE companies SET active_status = 'inactive' WHERE company_id = 1;")
  await waitServer()
  let g2, p2
  try {
    g2 = await anon.get(`/api/public/notice-ack?token=${token}`)
    p2 = await anon.post('/api/public/notice-ack', { token })
  } finally {
    sql(`UPDATE companies SET active_status = '${String(prev).replace(/'/g, "''")}' WHERE company_id = 1;`)
    await waitServer()
  }
  ok('#9967 停止中の企業のお知らせの確認リンクは開けない（403 company_inactive）', g2.status === 403 && g2.data?.code === 'company_inactive', g2)
  ok('#9967 停止中の企業のお知らせは確認リンクで既読にできない（403）', p2.status === 403 && p2.data?.code === 'company_inactive', p2)
  const used = sql(`SELECT used_at FROM notice_ack_tokens WHERE token_hash = '${hash}'`)[0]?.used_at
  ok('#9967 停止中に押してもトークンは使用済みにならない', used == null, used)
} else skip('#9967 停止中の企業のお知らせの確認リンク', 'PERSIST 未指定')

const failed = results.filter(r => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} 件が成功しました`)
process.exit(failed ? 1 : 0)
