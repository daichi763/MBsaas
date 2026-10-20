// ダッシュボードの表示の改善の統合テスト（w5-dashboard-b: #282 #299 #343 #344 #348 #355 #405 #414 #488、持ち越し #497 の遅刻・早退の表示）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w5-dashboard-b.mjs
//   PERSIST を指定すると、ログインのない人（#355）と請求の交通費・調整額（#414）の確認で D1 を直接書き換える。
// テストのたびに DB を作り直すこと（シフト・枠を追加するため）。画面（admin.js の表示・絞り込み）はブラウザで確かめる
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)

async function login(company_code, user_code) {
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w5db-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const jstNowMs = () => Date.now() + 9 * 3600 * 1000
const today = new Date(jstNowMs()).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const at = (offset) => { const iso = new Date(jstNowMs() + offset * 60000).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) } }
const tag = Date.now().toString(36).slice(-5)

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const dash = async (c = admin) => { const r = await c.get('/api/admin/dashboard'); if (r.status !== 200) throw new Error('dashboard ' + r.status + JSON.stringify(r.data)); return r.data }
async function createShift(staff_id, work_date, start_time, end_time, extra = {}) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id: 1, work_date, start_time, end_time, memo: 'W5DB-' + tag, force: true, ...extra })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  return r.data.shift_id
}
const relShift = (staff_id, startOff, endOff, extra) => { const s = at(startOff), e = at(endOff); return createShift(staff_id, s.date, s.time, e.time, extra) }
const findShift = (d, id) => (d.shifts || []).find(s => s.shift_id === id)
const todoBy = (d, key) => (d.todos || []).find(t => t.key === key)

// ---------- #405 写真必須の全社切替: 変更の記録と影響範囲 ----------
{
  const g0 = await admin.get('/api/admin/settings/photo-required')
  ok('#405 GET で現在の設定・変更の記録・影響する案件の数を返す', g0.status === 200 && typeof g0.data.enabled === "boolean" && Array.isArray(g0.data.history)
    && typeof g0.data.projects.follow === 'number', g0.data)
  const bad = await admin.post('/api/admin/settings/photo-required', { enabled: 'no' })
  ok('#405 enabled が真偽値でなければ 400', bad.status === 400, bad)
  if (g0.data.enabled === false) await admin.post('/api/admin/settings/photo-required', { enabled: true })
  const n0 = (await admin.get('/api/admin/settings/photo-required')).data.history.length
  const off = await admin.post('/api/admin/settings/photo-required', { enabled: false })
  ok('#405 変更すると変更者と日時を返す', off.status === 200 && off.data.changed && off.data.changed.name && off.data.changed.enabled === false, off.data)
  const same = await admin.post('/api/admin/settings/photo-required', { enabled: false })
  ok('#405 同じ値を送っても記録は増えない', same.status === 200 && same.data.unchanged === true, same.data)
  const g1 = await admin.get('/api/admin/settings/photo-required')
  ok('#405 変更の記録が1件増える（新しい順）', g1.data.enabled === false && g1.data.history.length === Math.min(10, n0 + 1) && g1.data.history[0].enabled === false && g1.data.history[0].name, g1.data)
  const d = await dash()
  ok('#405 ダッシュボードは現在の状態と最後の変更を返す', d.photo_required_attendance === false && d.photo_required_changed && d.photo_required_changed.enabled === false, d.photo_required_changed)
}

// ---------- #488 並び順 / #343 電話番号 / #348 報告時刻・遅刻・位置不明・休憩中 ----------
let lateShift, noLocShift, unrepShift
{
  // 開始から60分過ぎた人（st005）: 入店（遅刻）→ 勤務開始 → 休憩入
  lateShift = await relShift(5, -60, 120)
  // 30分後に始まる人（st006）: 位置情報なしで入店。30分後が明日になる時間帯は、今日の 23:59 開始にする（本日の一覧に出すため）
  noLocShift = at(30).date === today ? await relShift(6, 30, 180) : await createShift(6, today, '23:59', at(180).time)
  // 開始から30分過ぎて入店のない人（st004）
  unrepShift = await relShift(4, -30, 120)
  const st5 = client(await login('sample', 'st005'))
  const st6 = client(await login('sample', 'st006'))
  for (const t of ['wake_up', 'departure', 'check_in', 'work_start', 'break_start']) {
    const r = await st5.post('/api/staff/attendance', { shift_id: lateShift, report_type: t, latitude: 35.6, longitude: 139.7 })
    if (r.status !== 200) console.log('  report', t, r.status, JSON.stringify(r.data))
  }
  for (const t of ['wake_up', 'departure', 'check_in']) {
    const r = await st6.post('/api/staff/attendance', { shift_id: noLocShift, report_type: t })
    if (r.status !== 200) console.log('  report', t, r.status, JSON.stringify(r.data))
  }
  const d = await dash()
  const byDate = d.shifts.filter(s => s.work_date === today)
  const sorted = byDate.every((s, i) => i === 0 || String(byDate[i - 1].start_time) <= String(s.start_time))
  ok('#488 本日のシフトは開始時刻順', sorted, byDate.map(s => s.start_time))
  const L = findShift(d, lateShift)
  ok('#348 報告ごとの時刻と状態を返す（入店は遅刻）', L && L.reports && L.reports.check_in && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(L.reports.check_in.at) && L.reports.check_in.status === 'late', L && L.reports)
  ok('#348 #497 遅刻の分数を返す', L && L.late_minutes >= 50, L && L.late_minutes)
  ok('#348 休憩入があり休憩出がない人は休憩中', L && L.on_break === true, L)
  ok('#348 報告済みの種類は done_types にも入る（既存の表示との互換）', L && L.done_types.includes('break_start'), L && L.done_types)
  const N = findShift(d, noLocShift)
  ok('#348 位置情報のない入店は no_location', N && N.no_location === true && N.reports.check_in.status === 'no_location' && N.on_break === false, N && N.reports)
  const U = findShift(d, unrepShift)
  ok('#488 予定の時刻を過ぎた未報告の種類を返す（未報告ありの絞り込み用）', U && U.overdue_types.includes('check_in') && !(N && N.overdue_types.includes('check_in')), [U && U.overdue_types, N && N.overdue_types])
  const item = d.unreported.check_in.find(x => x.staff_id === 4) // 一覧は人ごとに1行
  ok('#343 未入店の一覧に電話番号・案件ID・開始時刻を返す', item && item.phone && item.project_id === 1 && item.start_time, item)
  ok('#355 未入店の一覧にログインと報告用URLの有無を返す', item && item.has_login === true && item.has_report_link === false, item)
}

// ---------- #355 ログインのない人・報告用URL ----------
if (PERSIST) {
  // st020（staff_id 20）をログインのない人にする
  sql("UPDATE users SET role = 'roster_only' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = 20);")
  const id = await relShift(20, -20, 120)
  let d = await dash()
  let s = findShift(d, id)
  ok('#355 ログインのない人は has_login=false・報告用URLなし', s && s.has_login === false && s.has_report_link === false, s)
  const it = d.unreported.check_in.find(x => x.staff_id === 20)
  ok('#355 未入店の一覧でもログインなしが分かる', it && it.has_login === false, it)
  const link = await admin.post(`/api/admin/shifts/${id}/report-link`, {})
  ok('報告用URLを発行する', link.status === 200 && link.data.token, link)
  d = await dash()
  s = findShift(d, id)
  ok('#355 発行した後は has_report_link=true', s && s.has_report_link === true, s)
  await admin.del(`/api/admin/shifts/${id}/report-link`)
  d = await dash()
  ok('#355 無効にした URL は数えない', findShift(d, id)?.has_report_link === false, findShift(d, id))
} else skip('#355 ログインのない人', 'PERSIST 未指定')

// ---------- #414 売上予定・案件詳細の今月売上を shiftTotals で ----------
{
  const before = await dash()
  const pBefore = await admin.get(`/api/admin/projects/1?month=${today.slice(0, 7)}`)
  ok('#414 案件詳細の今月の集計に請求・支払・粗利を返す', pBefore.status === 200 && ['n', 'revenue', 'bill_total', 'pay_total', 'profit', 'pay_missing'].every(k => k in pBefore.data.month_summary), pBefore.data && pBefore.data.month_summary)
  if (PERSIST) {
    const id = await createShift(7, today, '23:00', '23:50', { unit_price: 10000 })
    const mid = await dash()
    ok('#414 基本額が売上予定に入る', mid.revenue_forecast - before.revenue_forecast === 10000, [before.revenue_forecast, mid.revenue_forecast])
    sql(`UPDATE shifts SET bill_adjust = 500, transportation_fee = 300, bill_transport_type = 'actual' WHERE shift_id = ${Number(id)};`)
    const after = await dash()
    ok('#414 請求の交通費（実費）と調整額も売上予定に入る（精算と同じ式）', after.revenue_forecast - mid.revenue_forecast === 800, [mid.revenue_forecast, after.revenue_forecast])
    const pAfter = await admin.get(`/api/admin/projects/1?month=${today.slice(0, 7)}`)
    ok('#414 案件詳細の今月売上も交通費・調整額を含む', pAfter.data.month_summary.revenue - pBefore.data.month_summary.revenue === 10800 && pAfter.data.month_summary.revenue === pAfter.data.month_summary.bill_total,
      [pBefore.data.month_summary, pAfter.data.month_summary])
  } else skip('#414 交通費・調整額', 'PERSIST 未指定')
}

// ---------- #344 日報未提出の一覧 ----------
{
  const y = addDays(today, -1)
  const id = await createShift(8, y, '10:00', '12:00')
  const d = await dash()
  const r = d.missing_daily_reports.find(x => x.shift_id === id)
  ok('#344 日報未提出に日付・時刻・案件ID・電話番号・ログインの有無を返す', r && r.work_date === y && r.start_time === '10:00' && r.project_id === 1 && r.staff_phone && r.has_login === true, r)
}

// ---------- #299 今後の人員不足・希望（仮）のシフト ----------
{
  const tm = addDays(today, 1)
  const sl = await admin.post('/api/admin/shift-slots', { project_id: 1, dates: [tm], start_time: '09:00', end_time: '10:00', roles: [{ role_name: '販売' + tag, headcount: 3 }] })
  ok('枠を作る（必要3名）', sl.status === 200 && sl.data.slot_ids.length === 1, sl)
  const det = await admin.get(`/api/admin/shift-slots/${sl.data.slot_ids[0]}`)
  const roleId = det.data.roles[0].slot_role_id
  const a1 = await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [9], status: 'confirmed', force: true })
  const a2 = await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [10], status: 'requested', force: true })
  ok('確定1名・希望（仮）1名を割り当てる', a1.status === 200 && a2.status === 200, [a1, a2])
  const d = await dash()
  const r = d.staffing_ahead.short_roles.find(x => x.slot_role_id === roleId)
  ok('#299 人員不足の枠を返す（確定1/3・不足2・希望1）', r && r.filled === 1 && r.headcount === 3 && r.shortage === 2 && r.requested === 1 && r.work_date === tm, r)
  ok('#299 範囲は今日から3日先まで', d.staffing_ahead.from === today && d.staffing_ahead.to === addDays(today, 3), [d.staffing_ahead.from, d.staffing_ahead.to])
  const q = d.staffing_ahead.requested_shifts.find(x => x.slot_role_id === roleId)
  ok('#299 希望（仮）のままのシフトを返す', q && q.staff_id === 10 && q.project_name, q)
  const t1 = todoBy(d, `staffing_short:${today}`)
  ok('#299 人員不足の ToDo（明日の枠は high、一覧へのリンク）', t1 && t1.level === 'high' && t1.href === '#dash-ahead' && t1.mark >= 2, t1)
  ok('#299 希望（仮）の ToDo', !!todoBy(d, `requested:${today}`), d.todos.map(t => t.key))
  // 遠い日の枠は対象外
  const far = await admin.post('/api/admin/shift-slots', { project_id: 1, dates: [addDays(today, 10)], start_time: '09:00', end_time: '10:00', roles: [{ role_name: '遠い' + tag, headcount: 1 }] })
  const d2 = await dash()
  ok('#299 4日以上先の枠は出さない', far.status === 200 && !d2.staffing_ahead.short_roles.some(x => String(x.role_name).startsWith('遠い')), d2.staffing_ahead.short_roles.map(x => x.role_name))
}

// ---------- #282 契約終了・有給付与日 ----------
{
  const end = addDays(today, 10)
  const granted = addDays(addDays(today, 7), -365)
  const put = await admin.put('/api/admin/employees/11', { contract_end: end, paid_leave_granted_at: granted })
  ok('従業員管理で契約終了日・有給付与日を保存する', put.status === 200, put)
  const past = await admin.put('/api/admin/employees/12', { contract_end: addDays(today, -3) })
  ok('契約終了日を過ぎた社員を保存する', past.status === 200, past)
  const list = await admin.get('/api/admin/employees')
  const e = list.data.employees.find(x => x.staff_id === 11)
  ok('#282 従業員の一覧に契約終了日と有給付与日を返す', e && e.contract_end === end && e.paid_leave_granted_at === granted, e)
  const d = await dash()
  const t = todoBy(d, `contract_end:11:${end}`)
  ok('#282 契約終了14日以内は high の ToDo（従業員詳細へのリンク）', t && t.level === 'high' && t.mark === 2 && t.href === '#employees/11', t)
  const tp = todoBy(d, `contract_end:12:${addDays(today, -3)}`)
  ok('#282 契約終了日を過ぎても在職中なら ToDo に出す', tp && /過ぎています/.test(tp.text) && tp.mark === 3, tp)
  const lv = (d.todos || []).find(x => x.key.startsWith('paid_leave:11:'))
  // 次回の付与日は前回の1年後（うるう年をまたぐと1日ずれるので、日付は前後1日まで許す）
  const nextDay = lv && lv.key.split(':')[2]
  ok('#282 有給の次回付与日が近い ToDo', lv && [6, 7, 8].map(n => addDays(today, n)).includes(nextDay) && lv.href === '#employees/11', lv)
  const dm = await dash(mgr)
  ok('#282 従業員管理を使えないロールには契約・有給の ToDo を出さない', !(dm.todos || []).some(x => x.key.startsWith('contract_end:') || x.key.startsWith('paid_leave:')), dm.todos.map(x => x.key))
  // 30日より先は出さない
  await admin.put('/api/admin/employees/11', { contract_end: addDays(today, 60), paid_leave_granted_at: null })
  const d2 = await dash()
  ok('#282 契約終了まで30日より先なら出さない', !(d2.todos || []).some(x => x.key.startsWith('contract_end:11:') || x.key.startsWith('paid_leave:11:')), d2.todos.map(x => x.key))
}

// 後片付け: 写真必須を元に戻す
await admin.post('/api/admin/settings/photo-required', { enabled: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
