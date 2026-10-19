// 稼働日＋時刻の絶対日時（src/lib/shift-time.ts）と、スタッフのホームの対象シフトの選び方の統合テスト（w1-datetime-home: #11 #17 #32 #84）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w1-datetime-home.mjs
// テストのたびに DB を作り直すこと（シフト・報告を追加するため、2 回目は結果が変わる）
import { shiftWindow, reportableWindow, overlaps, crossesMidnight, addMinutes } from '../src/lib/shift-time.ts'

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`) }

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
const PRE = ['wake_up', 'departure', 'check_in', 'work_start']
const ALL = [...PRE, 'break_start', 'break_end', 'work_end', 'check_out']

async function createShift(admin, staff_id, project_id, work_date, memo, start_time, end_time) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const list = await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)
  const s = list.data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const proxy = (admin, id, types) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: types })

// ---------- 0. 共通関数（ネットワーク不要） ----------
{
  const w = shiftWindow('2026-10-01', '22:00', '06:00')
  ok('shiftWindow: 終了が開始以前なら翌日', w.start === '2026-10-01 22:00:00' && w.end === '2026-10-02 06:00:00', w)
  const d = shiftWindow('2026-10-01', '09:30', '19:00')
  ok('shiftWindow: 日中のシフトは同じ日', d.start === '2026-10-01 09:30:00' && d.end === '2026-10-01 19:00:00', d)
  ok('shiftWindow: 月末・年末をまたぐ', shiftWindow('2026-12-31', '23:00', '01:00').end === '2027-01-01 01:00:00')
  ok('crossesMidnight', crossesMidnight({ work_date: '2026-10-01', start_time: '22:00', end_time: '06:00' }) && !crossesMidnight({ work_date: '2026-10-01', start_time: '09:00', end_time: '18:00' }))
  const sh = { work_date: '2026-10-01', start_time: '22:00', end_time: '06:00' }
  const rc = reportableWindow(sh, 'check_out'), ri = reportableWindow(sh, 'check_in')
  ok('reportableWindow: 退店は稼働日の翌日 23:59:59 まで', rc.start === '2026-10-01 00:00:00' && rc.end === '2026-10-02 23:59:59', rc)
  ok('reportableWindow: 入店は稼働日のうち', ri.start === '2026-10-01 00:00:00' && ri.end === '2026-10-01 23:59:59', ri)
  ok('overlaps: 夜勤明けと翌朝のシフトが重なる', overlaps(w, shiftWindow('2026-10-02', '05:00', '13:00')))
  ok('overlaps: 端が接するだけなら重ならない', !overlaps(w, shiftWindow('2026-10-02', '06:00', '13:00')))
  ok('addMinutes', addMinutes('2026-10-01 22:00:00', 6 * 60) === '2026-10-02 04:00:00')
}

const admin = client(await login('sample', 'admin'))
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）

// ---------- 1. #11 #84 前日からの日をまたぐシフト ----------
{
  const st = client(await login('sample', 'st003')) // staff_id 3
  // 前日 23:00〜当日 22:00（日をまたぐ）。入店・勤務開始までは前日に済んでいる
  const night = await createShift(admin, 3, 1, yesterday, 'DT-NIGHT', '23:00', '22:00')
  await proxy(admin, night, PRE)
  // 前日の日中のシフト（日をまたがない）で報告が残っているもの
  const dayOld = await createShift(admin, 3, 1, yesterday, 'DT-DAY-OLD', '09:00', '10:00')
  const todayShift = await createShift(admin, 3, 2, today, 'DT-TODAY', '23:30', '23:45')

  let h = await st.get('/api/staff/home')
  ok('#11 前日からの夜勤で報告が残っていれば、ホームはそのシフトを優先する', h.data.shift && h.data.shift.shift_id === night && h.data.carryover === true, { shift: h.data.shift && h.data.shift.shift_id, carryover: h.data.carryover })
  ok('#11 報告の対象は休憩入から（入店などは前日に済んでいる）', PRE.every(t => h.data.reports[t]) && !h.data.reports.break_start, h.data.reports)
  ok('#84 日をまたがない前日のシフトはホームに出さない', !h.data.today_shifts.some(s => s.shift_id === dayOld), h.data.today_shifts)
  ok('today_shifts に本日のシフトと前日からのシフトの両方がある（稼働日つき）', h.data.today_shifts.some(s => s.shift_id === todayShift && s.work_date === today && !s.carryover) && h.data.today_shifts.some(s => s.shift_id === night && s.work_date === yesterday && s.carryover), h.data.today_shifts)

  for (const t of ['break_start', 'break_end', 'work_end', 'check_out']) {
    const r = await st.post('/api/staff/attendance', { shift_id: night, report_type: t })
    if (r.status !== 200) ok(`夜勤の ${t} を報告できる`, false, r)
  }
  h = await st.get('/api/staff/home')
  ok('#11 退店まで済むと、日報が残っていても本日のシフトの報告に移る', h.data.shift && h.data.shift.shift_id === todayShift && h.data.carryover === false, h.data.shift && h.data.shift.shift_id)
  const n = h.data.today_shifts.find(s => s.shift_id === night)
  ok('#17 前日からのシフトは日報が未提出として一覧に残る', n && n.attendance_done && n.daily_report_required && !n.daily_report_done, n)
  const dr = await st.post('/api/staff/daily-report', { project_id: 1, shift_id: night, work_date: yesterday, values: { mnp: 1 } })
  ok('夜勤の日報をシフトの稼働日で提出できる', dr.status === 200, dr)
  h = await st.get('/api/staff/home')
  ok('報告・日報がすべて済んだ前日のシフトはホームから消える', !h.data.today_shifts.some(s => s.shift_id === night), h.data.today_shifts)
}

// ---------- 2. #32 報告なしのシフトがあっても、後のシフトを報告できる ----------
{
  const st = client(await login('sample', 'st004')) // staff_id 4
  const a = await createShift(admin, 4, 1, today, 'DT-NONE-A', '00:01', '00:02')
  const b = await createShift(admin, 4, 2, today, 'DT-NONE-B', '23:50', '23:55')
  const set = await admin.put(`/api/admin/shifts/${a}/report-settings`, { attendance_mode: 'none', daily_report_mode: 'none' })
  ok('シフトの例外で「報告なし」にできる', set.status === 200, set)
  let h = await st.get('/api/staff/home')
  ok('#32 1つ目が報告なしなら、ホームは2つ目のシフトを対象にする', h.data.shift && h.data.shift.shift_id === b && h.data.required_attendance.length > 0, { shift: h.data.shift && h.data.shift.shift_id, req: h.data.required_attendance })
  // 1つ目の退店報告だけを OFF にした場合も、残りが済めば2つ目へ移る
  await admin.put(`/api/admin/shifts/${a}/report-settings`, { attendance_mode: 'in_out', daily_report_mode: 'none' })
  h = await st.get('/api/staff/home')
  ok('入店・退店のみのシフトは、退店まで対象のまま', h.data.shift && h.data.shift.shift_id === a && JSON.stringify(h.data.required_attendance) === JSON.stringify(['check_in', 'check_out']), h.data.required_attendance)
  await proxy(admin, a, ['check_in', 'check_out'])
  h = await st.get('/api/staff/home')
  ok('退店が済むと2つ目のシフトへ移る', h.data.shift && h.data.shift.shift_id === b, h.data.shift && h.data.shift.shift_id)
  h = await st.get(`/api/staff/home?shift_id=${a}`)
  ok('#32 shift_id を指定すると、そのシフトを対象にできる', h.data.shift && h.data.shift.shift_id === a, h.data.shift && h.data.shift.shift_id)
  h = await st.get(`/api/staff/home?shift_id=1`)
  ok('他人のシフトを指定しても対象にならない', h.data.shift && h.data.shift.shift_id === b, h.data.shift && h.data.shift.shift_id)
}

// ---------- 3. #17 退店後も前のシフトの日報を出せる（shift_id で照合） ----------
{
  const st = client(await login('sample', 'st005')) // staff_id 5
  const c1 = await createShift(admin, 5, 1, today, 'DT-DR-1', '00:01', '00:02')
  const c2 = await createShift(admin, 5, 2, today, 'DT-DR-2', '23:50', '23:55')
  await proxy(admin, c1, ALL)
  let h = await st.get('/api/staff/home')
  ok('#17 1つ目の報告が済むと、ホームは2つ目の報告に移る', h.data.shift && h.data.shift.shift_id === c2, h.data.shift && h.data.shift.shift_id)
  let t1 = h.data.today_shifts.find(s => s.shift_id === c1)
  ok('#17 1つ目の日報が未提出であることが一覧で分かる（日報画面の既定の対象）', t1 && t1.attendance_done && !t1.daily_report_done && t1.project_id === 1, t1)
  const dr = await st.post('/api/staff/daily-report', { project_id: 1, shift_id: c1, work_date: today, values: { mnp: 2 } })
  ok('1つ目の日報を提出', dr.status === 200, dr)
  h = await st.get('/api/staff/home')
  t1 = h.data.today_shifts.find(s => s.shift_id === c1)
  const t2 = h.data.today_shifts.find(s => s.shift_id === c2)
  ok('#17 日報の提出状況はシフトごと（1つ目だけ提出済み）', t1 && t1.daily_report_done && t2 && !t2.daily_report_done && h.data.daily_report_done === false, { t1, t2 })
  const reps = await admin.get(`/api/admin/daily-reports?date=${today}`)
  const mine = (reps.data.reports || []).filter(r => r.staff_id === 5)
  ok('日報は1つ目の案件・シフトに登録される', mine.length === 1 && mine[0].project_id === 1 && mine[0].shift_id === c1, mine)
}

// ---------- 4. 報告用URLの受付時間帯（reportableWindow） ----------
{
  const pub = client(null)
  const old = await createShift(admin, 6, 1, yesterday, 'DT-LINK-OLD', '09:00', '18:00')
  const fut = await createShift(admin, 6, 1, addDays(today, 1), 'DT-LINK-FUT', '09:00', '18:00')
  const lo = await admin.post(`/api/admin/shifts/${old}/report-link`, {})
  const lf = await admin.post(`/api/admin/shifts/${fut}/report-link`, {})
  const tokOld = lo.data && (lo.data.token || (lo.data.url || '').split('/').pop())
  const tokFut = lf.data && (lf.data.token || (lf.data.url || '').split('/').pop())
  ok('報告用URLを発行できる', tokOld && tokFut, { lo: lo.data, lf: lf.data })
  if (tokOld && tokFut) {
    const r1 = await pub.post(`/api/public/report/${tokOld}/attendance`, { report_type: 'wake_up' })
    ok('前日のシフトの起床報告は受け付けない（受付期間外）', r1.status === 400 && /受付期間/.test(r1.data.error), r1)
    await proxy(admin, old, PRE)
    const r2 = await pub.post(`/api/public/report/${tokOld}/attendance`, { report_type: 'break_start' })
    ok('前日のシフトの休憩入は翌日も受け付ける（従来どおり）', r2.status === 200, r2)
    const r3 = await pub.post(`/api/public/report/${tokFut}/attendance`, { report_type: 'wake_up' })
    ok('翌日のシフトはまだ報告できない', r3.status === 400 && /まだ報告できません/.test(r3.data.error), r3)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
