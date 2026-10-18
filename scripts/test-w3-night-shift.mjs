// 日をまたぐ勤務と遅刻判定の統合テスト（w3-night-shift: #77 #134 #219 #497、持ち越し #116）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w3-night-shift.mjs
// テストのたびに DB を作り直すこと（シフト・報告・設定を追加するため、2 回目は結果が変わる）
// 今の時刻（JST）を使うテストは、時刻によって省略する（SKIP と表示する）
import { reportableWindow } from '../src/lib/shift-time.ts'

const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1)
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const nowMin = () => { const t = jstNow(); return Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) }

const admin = client(await login('sample', 'admin'))
const pub = client(null)
async function createShift(staff_id, project_id, work_date, memo, start_time, end_time, extra = {}) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, ...extra })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const s = (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const reportOf = async (id, t) => ((await admin.get(`/api/admin/shifts/${id}/report-status`)).data.reports || []).find(r => r.report_type === t)
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）

// ---------- 0. 受付の時間帯（ネットワーク不要） ----------
{
  const night = { work_date: '2026-10-01', start_time: '23:30', end_time: '06:00' }
  ok('#134 23時台開始の入店は、0時を過ぎても予定の終了まで受け付ける', reportableWindow(night, 'check_in').end === '2026-10-02 06:00:00', reportableWindow(night, 'check_in'))
  ok('#134 勤務開始も同じ', reportableWindow(night, 'work_start').end === '2026-10-02 06:00:00')
  ok('起床・出発は稼働日のうちだけ', reportableWindow(night, 'wake_up').end === '2026-10-01 23:59:59')
  ok('夜勤の退店は終了の12時間後まで', reportableWindow(night, 'check_out').end === '2026-10-02 18:00:00', reportableWindow(night, 'check_out'))
  const day = { work_date: '2026-10-01', start_time: '09:00', end_time: '18:00' }
  ok('#116 日をまたがない勤務の終了は翌朝（終了の12時間後）まで', reportableWindow(day, 'work_end').end === '2026-10-02 06:00:00', reportableWindow(day, 'work_end'))
  ok('日中の勤務の入店は稼働日のうちだけ', reportableWindow(day, 'check_in').end === '2026-10-01 23:59:59')
  const late = { work_date: '2026-10-01', start_time: '13:00', end_time: '20:00' }
  ok('夜に終わる勤務の退店は翌日の 23:59:59 を超えない', reportableWindow({ ...late, start_time: '23:00', end_time: '22:00' }, 'check_out').end === '2026-10-02 23:59:59')
  ok('夕方に終わる勤務の退店は稼働日の 23:59:59 より前にならない', reportableWindow({ ...late, end_time: '10:30', start_time: '09:00' }, 'check_out').end === '2026-10-01 23:59:59')
}

// ---------- 1. #77 日をまたぐ勤務の重複チェック ----------
{
  const D = addDays(today, 20), D1 = addDays(D, 1)
  await createShift(5, 1, D, 'NS-NIGHT', '22:00', '06:00')
  let r = await admin.post('/api/admin/shifts', { staff_id: 5, project_id: 1, work_date: D1, start_time: '05:00', end_time: '13:00', memo: 'NS-MORNING', confirm_warnings: true })
  ok('#77 夜勤明けの翌朝のシフトは、前日の夜勤と重なると警告する', r.status === 409 && r.data.warnings.some(w => /前日 22:00〜06:00/.test(w)), r)
  r = await admin.post('/api/admin/shifts', { staff_id: 5, project_id: 1, work_date: D1, start_time: '06:00', end_time: '13:00', memo: 'NS-MORNING-OK', confirm_warnings: true })
  ok('#77 夜勤の終了ちょうどに始まるシフトは重ならない', r.status === 200, r)
  r = await admin.post('/api/admin/shifts', { staff_id: 5, project_id: 1, work_date: D, start_time: '21:00', end_time: '23:00', memo: 'NS-SAME', confirm_warnings: true })
  ok('同じ稼働日の重なりは従来どおり警告する（前日・翌日を付けない）', r.status === 409 && r.data.warnings.some(w => / 22:00〜06:00/.test(w) && !/前日|翌日/.test(w)), r)

  // 逆の順: 翌朝のシフトが先にあり、前日に夜勤を入れる
  await createShift(6, 1, D1, 'NS-MORNING-6', '05:00', '13:00')
  r = await admin.post('/api/admin/shifts', { staff_id: 6, project_id: 1, work_date: D, start_time: '22:00', end_time: '06:00', memo: 'NS-NIGHT-6', confirm_warnings: true })
  ok('#77 夜勤を入れるとき、翌日の早朝のシフトと重なると警告する', r.status === 409 && r.data.warnings.some(w => /翌日 05:00〜13:00/.test(w)), r)
  r = await admin.post('/api/admin/shifts', { staff_id: 6, project_id: 1, work_date: D, start_time: '22:00', end_time: '06:00', memo: 'NS-NIGHT-6', confirm_warnings: true, force: true })
  ok('（準備）確認のうえ登録できる', r.status === 200, r)

  // シフトボード: 翌日のシフトだけを表示しても、前日の夜勤との重なりを出す
  const b = await admin.get(`/api/admin/shift-board?from=${D1}&to=${D1}`)
  const all = [...(b.data.unslotted || []), ...((b.data.slots || []).flatMap(s => s.shifts || s.assigned || []))]
  const m6 = all.find(s => s.memo === 'NS-MORNING-6')
  ok('#77 シフトボードで、前日の夜勤との重なりを表示する（day_offset = -1）', m6 && m6.conflicts.some(c => c.day_offset === -1 && c.start_time === '22:00'), m6 || Object.keys(b.data))
}

// ---------- 2. #134 23時台に始まる勤務で、0時を過ぎてから入店する ----------
{
  const n = nowMin()
  if (n > 21 * 60) {
    console.log('SKIP  #134 0時を過ぎた入店（JST 21 時以降は終了時刻を作れないため省略）')
  } else {
    const end = hm(Math.floor(n / 60) * 60 + 120)
    const st7 = client(await login('sample', 'st007'))
    const A = await createShift(7, 1, yesterday, 'NS-LATE-APP', '23:30', end)
    let r = await st7.post('/api/staff/attendance', { shift_id: A, report_type: 'check_in' })
    ok('#134 アプリ: 前日 23:30 開始のシフトに 0時を過ぎて入店できる', r.status === 200, r)
    ok('#134 アプリ: 0時を過ぎた入店は遅刻（日付を含めて比べる）', r.data.status === 'late' && r.data.late_minutes >= 30, r.data)
    const ciMinutes = r.data.late_minutes
    r = await st7.post('/api/staff/attendance', { shift_id: A, report_type: 'work_start' })
    ok('#219 アプリ: 勤務開始も遅刻と分数を記録する', r.status === 200 && r.data.status === 'late' && r.data.late_minutes >= 30, r)
    const ci = await reportOf(A, 'check_in')
    ok('#497 遅れた分数を保存する', ci && ci.status === 'late' && ci.late_minutes === ciMinutes, ci)

    // 報告用URL（ログインのないスタッフ）
    const B = await createShift(8, 1, yesterday, 'NS-LATE-LINK', '23:30', end)
    const link = await admin.post(`/api/admin/shifts/${B}/report-link`, {})
    ok('（準備）報告用URLを発行できる', link.status === 200 && link.data.token, link)
    r = await pub.post(`/api/public/report/${link.data.token}/attendance`, { report_type: 'check_in' })
    ok('#134 報告用URL: 0時を過ぎても入店を受け付ける', r.status === 200, r)
    ok('#134 報告用URL: 0時を過ぎた入店は遅刻', r.data && r.data.status === 'late' && r.data.late_minutes >= 30, r.data)
    r = await pub.post(`/api/public/report/${link.data.token}/attendance`, { report_type: 'work_start' })
    ok('#134 報告用URL: 続けて勤務開始も報告できる', r.status === 200 && r.data.status === 'late', r)
    r = await pub.post(`/api/public/report/${link.data.token}/attendance`, { report_type: 'wake_up' })
    ok('起床は稼働日を過ぎると受け付けない', r.status === 400, r)
    r = await pub.post(`/api/public/report/${link.data.token}/attendance`, { report_type: 'check_out' })
    ok('#497 報告用URL: 予定より前の退店は早退の分数を記録する（status は変えない）', r.status === 200 && r.data.status === 'normal' && r.data.early_leave_minutes > 0, r)
  }
}

// ---------- 3. #219 #497 勤務開始の遅刻・猶予・早退 ----------
{
  const n = nowMin()
  if (n < 60 || n > 22 * 60) {
    console.log('SKIP  #219 #497 本日の遅刻（JST 0 時台と 22 時以降は省略）')
  } else {
    const st9 = client(await login('sample', 'st009'))
    const start = hm(n - 20)
    const C = await createShift(9, 1, today, 'NS-WS', start, '23:59')
    // 入店を飛ばして勤務開始だけを押す（勤務開始で運用する案件と同じ）
    let r = await st9.post('/api/staff/attendance', { shift_id: C, report_type: 'work_start' })
    ok('#219 入店なしの勤務開始でも遅刻を判定する', r.status === 200 && r.data.status === 'late' && r.data.late_minutes >= 19 && r.data.late_minutes <= 22, r)
    r = await st9.post('/api/staff/attendance', { shift_id: C, report_type: 'work_end' })
    ok('#497 予定の終了より前の勤務終了は早退の分数を記録する', r.status === 200 && r.data.status === 'normal' && r.data.early_leave_minutes > 0, r)
    const we = await reportOf(C, 'work_end')
    ok('#497 早退の分数を保存する（報告状況で返す）', we && we.early_leave_minutes === r.data.early_leave_minutes && we.late_minutes === null, we)

    // 会社設定の猶予
    let g = await admin.put('/api/admin/settings/lateness', { grace_minutes: 500 })
    ok('#497 猶予は 0〜120 分', g.status === 400, g)
    g = await admin.put('/api/admin/settings/lateness', { grace_minutes: 30 })
    ok('#497 猶予を設定できる', g.status === 200 && g.data.grace_minutes === 30, g)
    g = await admin.get('/api/admin/settings/lateness')
    ok('#497 猶予を読み出せる', g.status === 200 && g.data.grace_minutes === 30, g)
    const ph = await admin.get('/api/admin/dashboard')
    ok('猶予の保存で写真必須の設定を消さない', ph.data && ph.data.photo_required_attendance === false, ph.data && ph.data.photo_required_attendance)
    const E = await createShift(10, 1, today, 'NS-GRACE', start, '23:59')
    const st10 = client(await login('sample', 'st010'))
    r = await st10.post('/api/staff/attendance', { shift_id: E, report_type: 'check_in', latitude: 35.6, longitude: 139.7 })
    ok('#497 猶予の内の遅れは遅刻にしない（分数は記録する）', r.status === 200 && r.data.status === 'normal' && r.data.late_minutes >= 19, r)
    await admin.put('/api/admin/settings/lateness', { grace_minutes: 0 })
  }
}

// ---------- 4. 代理入力: 夜勤の 0時過ぎの入店・早い勤務終了 ----------
{
  const P = await createShift(12, 1, addDays(today, -2), 'NS-PROXY', '22:00', '06:00')
  const r = await admin.post(`/api/admin/shifts/${P}/proxy-attendance`, { report_types: ['check_in', 'work_start', 'work_end'], times: { check_in: '00:10', work_start: '00:15', work_end: '05:00' } })
  const at = (t) => (r.data.reports || []).find(x => x.report_type === t)
  ok('#219 代理入力: 0時を過ぎた入店は遅刻（130分）', r.status === 200 && at('check_in').status === 'late' && at('check_in').late_minutes === 130, r)
  ok('#219 代理入力: 勤務開始も遅刻（135分）', at('work_start') && at('work_start').status === 'late' && at('work_start').late_minutes === 135, r.data)
  ok('#497 代理入力: 早い勤務終了は早退（60分）', at('work_end') && at('work_end').status === 'normal' && at('work_end').early_leave_minutes === 60, r.data)
  const ok2 = await createShift(12, 1, addDays(today, -3), 'NS-PROXY-OK', '22:00', '06:00')
  const r2 = await admin.post(`/api/admin/shifts/${ok2}/proxy-attendance`, { report_types: ['check_in', 'check_out'], times: { check_in: '21:50', check_out: '06:30' } })
  const ci = (r2.data.reports || []).find(x => x.report_type === 'check_in'), co = (r2.data.reports || []).find(x => x.report_type === 'check_out')
  ok('代理入力: 開始前の入店は遅刻でない（0分）・終了後の退店は早退でない（0分）', r2.status === 200 && ci.status === 'normal' && ci.late_minutes === 0 && co.early_leave_minutes === 0, r2)
}

// ---------- 5. 持ち越し #116 日をまたがない勤務の終了を翌日に押せない ----------
{
  const st11 = client(await login('sample', 'st011'))
  const Y = await createShift(11, 1, yesterday, 'NS-DAY-OLD', '09:00', '10:00')
  const r = await st11.post('/api/staff/attendance', { shift_id: Y, report_type: 'work_end' })
  ok('#116 前日の日中の勤務に、今日になってから勤務終了は押せない（打刻修正へ）', r.status === 400 && /受付期間/.test(r.data.error), r)
}

await admin.post('/api/admin/settings/photo-required', { enabled: true })
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
