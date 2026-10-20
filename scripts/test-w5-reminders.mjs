// 本人あての自動リマインド（w5-reminders: #160）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、
//   `wrangler dev --local --test-scheduled --persist-to <保存先>` で起動していること
//   （ローカルの D1 に直接シフトを書き込み、/__scheduled で15分おきの cron を実行する。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8826 PERSIST=<保存先> node scripts/test-w5-reminders.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8826'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code) {
  await waitServer()
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const req = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // ローカルの D1 を直接書き換えた直後は、接続が切られることがあるので1回だけやり直す
    const r = await req().catch(() => new Promise(res => setTimeout(res, 1000)).then(req))
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), put: (p, b) => call('PUT', p, b ?? {}) }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w5rem-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const CRON = '*/15 * * * *'
async function cron() {
  await waitServer()
  const url = `${BASE}/__scheduled?cron=${encodeURIComponent(CRON).replace(/%20/g, '+')}`
  // ローカルの D1 を直接書き換えた直後は、接続が切られることがあるので1回だけやり直す
  const r = await fetch(url).catch(() => new Promise(res => setTimeout(res, 1000)).then(() => fetch(url)))
  await waitServer()
  return r.status
}
const jstNowMs = () => Date.now() + 9 * 3600 * 1000
// 今から offset 分後の稼働日と時刻
const at = (offset) => { const iso = new Date(jstNowMs() + offset * 60000).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) } }
let nextId = 0
// シフトを直接作る（案件1。開始・終了は今からの分）
function shiftSql(staffId, startOff, endOff, status = 'confirmed') {
  const s = at(startOff), e = at(endOff), id = nextId++
  return { id, sql: `INSERT INTO shifts (shift_id, company_id, staff_id, project_id, work_date, start_time, end_time, status, memo) VALUES (${id}, 1, ${staffId}, 1, '${s.date}', '${s.time}', '${e.time}', '${status}', 'w5-reminders');` }
}
const sentOf = (ids) => sql(`SELECT shift_id, reminder_type, emailed FROM reminder_sends WHERE shift_id IN (${ids.join(',')}) ORDER BY shift_id, reminder_type`)

nextId = Number(sql('SELECT COALESCE(MAX(shift_id), 0) AS n FROM shifts')[0].n) + 1000
// 前回の実行の設定が残っていれば消す（テスト用の DB を作り直さずに再実行するとき）
sql(`UPDATE companies SET settings_json = json_remove(settings_json, '$.reminders') WHERE company_id = 1 AND json_valid(settings_json)`)
const firstRun = Number(sql(`SELECT COALESCE(MAX(run_id), 0) AS n FROM cron_runs`)[0].n)
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))

// ---------- 会社の設定（既定は送らない・会社管理者だけが変更できる） ----------
let r = await admin.get('/api/admin/settings/reminders')
ok('設定: 既定は送らない（enabled=false）・送る時点の既定値', r.status === 200 && r.data.enabled === false && r.data.wake_up === 120 && r.data.departure === 60 && r.data.check_in === 0 && r.data.daily_report === 60 && r.data.can_edit === true, r)
r = await mgr.put('/api/admin/settings/reminders', { enabled: true })
ok('設定: 会社管理者以外は変更できない（403）', r.status === 403, r)
r = await admin.put('/api/admin/settings/reminders', { enabled: true, wake_up: 999 })
ok('設定: 上限を超える分は 400', r.status === 400, r)
r = await admin.put('/api/admin/settings/reminders', { enabled: 'yes' })
ok('設定: enabled が真偽値でなければ 400', r.status === 400, r)

// ON にする前の分は送らない
const pre = shiftSql(4, 100, 400)
sql(pre.sql); await waitServer()
await cron()
ok('OFF の間は送らない', sentOf([pre.id]).length === 0, sentOf([pre.id]))

r = await admin.put('/api/admin/settings/reminders', { enabled: true })
ok('設定: ON にする（ほかの値は既定のまま）', r.status === 200 && r.data.enabled === true && r.data.wake_up === 120, r)
const company = sql(`SELECT settings_json FROM companies WHERE company_id = 1`)[0]
ok('設定: settings_json の reminders だけを書き換える', JSON.parse(company.settings_json).reminders.enabled === true, company)

// ---------- シフトを用意する ----------
const A = shiftSql(5, 100, 400)          // 起床の時点（開始の120分前）を20分過ぎた → 起床
const B = shiftSql(6, -10, 300)          // 開始を10分過ぎて入店がない → 入店（起床・出発は開始を過ぎたので送らない）
const C = shiftSql(7, -300, -90)         // 終了の90分後で日報がない → 日報（入店は遅れの上限を過ぎたので送らない）
const D = shiftSql(8, 100, 400)          // 起床を報告済み → 送らない
const E = shiftSql(9, 100, 400)          // 欠勤の連絡あり → 送らない
const H = shiftSql(12, 100, 400, 'requested') // 希望（仮）のシフト → 送らない
const Bdone = shiftSql(13, -10, 300)     // 入店を報告済み → 送らない
const today = at(0).date
sql([A, B, C, D, E, H, Bdone].map(x => x.sql).join('\n') + `
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at) VALUES (1, 8, ${D.id}, 'wake_up', '${today} 00:00:00');
  INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at) VALUES (1, 13, ${Bdone.id}, 'check_in', '${today} 00:00:00');
  INSERT INTO consultations (company_id, staff_id, category, urgency, body, status, target_date) VALUES (1, 9, 'absence', 'high', '体調不良のため休みます', 'open', '${at(100).date}');
  UPDATE users SET email = NULL WHERE user_id = 9;`)
await waitServer()

const status = await cron()
ok('cron の実行', status === 200, status)
const ids = [A, B, C, D, E, H, Bdone].map(x => x.id)
const sent = sentOf(ids)
const has = (id, t) => sent.some(x => x.shift_id === id && x.reminder_type === t)
ok('起床の未報告を送る（A）', has(A.id, 'wake_up') && !has(A.id, 'departure'), sent)
ok('入店の未報告を送る（B）。開始を過ぎた起床・出発は送らない', has(B.id, 'check_in') && !has(B.id, 'wake_up') && !has(B.id, 'departure'), sent)
ok('日報の未提出を送る（C）。遅れの上限を過ぎた入店は送らない', has(C.id, 'daily_report') && !has(C.id, 'check_in'), sent)
ok('起床を報告済みのシフトには送らない（D）', !sent.some(x => x.shift_id === D.id), sent)
ok('欠勤の連絡があるシフトには送らない（E）', !sent.some(x => x.shift_id === E.id), sent)
ok('希望（仮）のシフトには送らない（H）', !sent.some(x => x.shift_id === H.id), sent)
ok('入店を報告済みのシフトには送らない', !sent.some(x => x.shift_id === Bdone.id), sent)
ok('メールアドレスがある人はメールも送る（A）・ない人は送らない（B）', sent.find(x => x.shift_id === A.id)?.emailed === 1 && sent.find(x => x.shift_id === B.id)?.emailed === 0, sent)

// 本人のアプリ内通知
const stA = client(await login('sample', 'st005'))
r = await stA.get('/api/staff/notifications?kind=report_reminder')
const nA = (r.data?.notifications || []).find(n => n.related_id === A.id)
ok('本人のアプリ内通知（起床）: ホームへのリンク', nA && nA.link === '#home' && nA.title.includes('起床報告') && !nA.read_at, r.data)
const stC = client(await login('sample', 'st007'))
r = await stC.get('/api/staff/notifications?kind=daily_report_reminder')
const nC = (r.data?.notifications || []).find(n => n.related_id === C.id)
ok('本人のアプリ内通知（日報）: 日報の入力へのリンク', nC && nC.link === `#report/${C.id}` && nC.title.includes('日報'), r.data)
const others = sql(`SELECT COUNT(*) AS n FROM user_notifications WHERE kind IN ('report_reminder', 'daily_report_reminder') AND related_id IN (${D.id}, ${E.id}, ${H.id}, ${Bdone.id})`)[0].n
ok('送らないシフトの通知はない', others === 0, others)

// ---------- 二度送らない・何もしなかった実行の記録は1行にまとめる ----------
const before = sql(`SELECT COUNT(*) AS n FROM reminder_sends`)[0].n
const notifBefore = sql(`SELECT COUNT(*) AS n FROM user_notifications WHERE kind IN ('report_reminder', 'daily_report_reminder')`)[0].n
await cron(); await cron()
ok('同じシフト・同じ種類は二度送らない', sql(`SELECT COUNT(*) AS n FROM reminder_sends`)[0].n === before
  && sql(`SELECT COUNT(*) AS n FROM user_notifications WHERE kind IN ('report_reminder', 'daily_report_reminder')`)[0].n === notifBefore)
const runs = sql(`SELECT status, result_json FROM cron_runs WHERE job = 'reminders' AND run_id > ${firstRun} ORDER BY run_id`)
// 送った実行の後の、何もしなかった2回の実行は1行になる（送った実行の記録は消さない）
const lastSent = runs.map(x => JSON.parse(x.result_json || '{}').idle === true).lastIndexOf(false)
const idleRuns = runs.slice(lastSent + 1)
ok('何もしなかった実行の記録は1行にまとめる', idleRuns.length === 1 && JSON.parse(runs[runs.length - 1].result_json).idle === true && runs.every(x => x.status === 'ok'), runs)
ok('送った実行の記録には件数が残る', runs.some(x => JSON.parse(x.result_json || '{}').sent >= 3), runs)

// ---------- 種類ごとに送らない設定 ----------
r = await admin.put('/api/admin/settings/reminders', { enabled: true, wake_up: null, check_in: 15 })
ok('設定: 起床を送らない（null）・入店は開始の15分後', r.status === 200 && r.data.wake_up === null && r.data.check_in === 15, r)
const I = shiftSql(14, 100, 400)   // 起床の時点を過ぎているが、起床は送らない設定
const J = shiftSql(15, -10, 300)   // 開始の10分後。入店の時点（15分後）はまだ
sql(I.sql + J.sql); await waitServer()
await cron()
ok('送らない設定の種類と、時点の前のものは送らない', sentOf([I.id, J.id]).length === 0, sentOf([I.id, J.id]))
r = await admin.get('/api/admin/settings/reminders')
ok('設定: 読み直しても同じ値', r.data.wake_up === null && r.data.check_in === 15 && r.data.enabled === true, r.data)

// ---------- OFF に戻すと送らない ----------
r = await admin.put('/api/admin/settings/reminders', { enabled: false, wake_up: 120, check_in: 0 })
const G = shiftSql(16, 100, 400)
sql(G.sql); await waitServer()
await cron()
ok('OFF に戻すと送らない', r.status === 200 && sentOf([G.id]).length === 0, sentOf([G.id]))

const failed = results.filter(x => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
