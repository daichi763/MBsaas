// 勤怠報告APIの整合の統合テスト（w2-attendance-report: #19 #47 #95 #116 #122 #133 #458 #519 #559、持ち越し #84）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-attendance-report.mjs
// テストのたびに DB を作り直すこと（シフト・報告・設定を追加するため、2 回目は結果が変わる）
import { isWorkingShift, isTentativeShift } from '../src/lib/shift-status.ts'

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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  const form = async (path, fd) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p), form }
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1), tomorrow = addDays(today, 1)
const ALL = ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']

async function createShift(admin, staff_id, project_id, work_date, memo, extra = {}) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: extra.start_time || '00:01', end_time: extra.end_time || '23:30', memo, status: extra.status })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const list = await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)
  const s = list.data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const reportStatus = async (admin, id) => (await admin.get(`/api/admin/shifts/${id}/report-status`)).data
// 1x1 の PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))
const photoForm = (shiftId, type) => { const fd = new FormData(); fd.append('shift_id', String(shiftId)); fd.append('report_type', type); fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png'); return fd }

// ---------- 0. 共通関数（ネットワーク不要） ----------
ok('isWorkingShift: 確定・代打は勤務', isWorkingShift('confirmed') && isWorkingShift('substitute') && !isWorkingShift('requested') && !isWorkingShift('absent'))
ok('isTentativeShift: 希望（仮）だけが未確定', isTentativeShift('requested') && !isTentativeShift('confirmed'))

const admin = client(await login('sample', 'admin'))
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）
const st9 = client(await login('sample', 'st009'))   // staff_id 9
const st10 = client(await login('sample', 'st010')) // staff_id 10

// ---------- 1. #47 前の報告を飛ばして後の報告を押せる / #133 秒は 00 ----------
const S1 = await createShift(admin, 9, 1, today, 'W2AR-S1')
{
  const r = await st9.post('/api/staff/attendance', { shift_id: S1, report_type: 'check_in' })
  ok('#47 起床・出発を飛ばして入店を報告できる', r.status === 200, r)
  const back = await st9.post('/api/staff/attendance', { shift_id: S1, report_type: 'wake_up' })
  ok('#47 入店の後に起床は報告できない（打刻修正の申請へ案内）', back.status === 400 && /修正申請/.test(back.data.error), back)
  const again = await st9.post('/api/staff/attendance', { shift_id: S1, report_type: 'check_in' })
  ok('二度目の入店は 409', again.status === 409, again)
  const rs = await reportStatus(admin, S1)
  const ci = rs.reports.find(x => x.report_type === 'check_in')
  ok('#133 アプリの報告の時刻は秒を 00 で保存する', ci && /:00$/.test(ci.reported_at), ci)
  const h = await st9.get(`/api/staff/home?shift_id=${S1}`)
  const item = h.data.today_shifts.find(x => x.shift_id === S1)
  ok('#47 ホーム: 飛ばした報告が残っていても、後の報告があれば未完了', item && item.attendance_done === false, item)
}

// ---------- 2. #95 同時に届いた同じ報告は 1 件だけ登録 ----------
{
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => st9.post('/api/staff/attendance', { shift_id: S1, report_type: 'work_start' })))
  const codes = rs.map(r => r.status)
  ok('#95 同時に 5 回送っても成功は 1 件、残りは 409', codes.filter(c => c === 200).length === 1 && codes.filter(c => c === 409).length === 4, codes)
  const st = await reportStatus(admin, S1)
  ok('#95 勤務開始の行は 1 件', st.reports.filter(x => x.report_type === 'work_start').length === 1, st.reports)
}

// ---------- 3. #122 承認待ちの打刻修正申請がある報告は押せない ----------
{
  const hm = jstNow().slice(11, 16)
  const c = await st9.post('/api/staff/corrections', { shift_id: S1, report_type: 'break_start', kind: 'add', requested_at: `${today} ${hm}`, reason: '休憩入を押し忘れた' })
  ok('打刻漏れ（休憩入）を申請できる', c.status === 200, c)
  const h = await st9.get(`/api/staff/home?shift_id=${S1}`)
  ok('#122 ホームに申請中の報告が返る', h.data.pending_corrections && h.data.pending_corrections.break_start, h.data.pending_corrections)
  const r = await st9.post('/api/staff/attendance', { shift_id: S1, report_type: 'break_start' })
  ok('#122 申請中の休憩入は報告できない（409）', r.status === 409 && /申請中/.test(r.data.error), r)
  const be = await st9.post('/api/staff/attendance', { shift_id: S1, report_type: 'break_end' })
  ok('#47 申請中の休憩入を待たずに休憩出を報告できる', be.status === 200, be)
}

// ---------- 4. #116 #84 欠勤・稼働日でない・確定済みのシフトには報告できない ----------
{
  const absent = await createShift(admin, 9, 2, today, 'W2AR-ABSENT', { status: 'absent' })
  const r1 = await st9.post('/api/staff/attendance', { shift_id: absent, report_type: 'check_in' })
  ok('#116 欠勤のシフトには報告できない', r1.status === 400 && /欠勤/.test(r1.data.error), r1)
  const p1 = await st9.form('/api/staff/attendance-photo', photoForm(absent, 'check_in'))
  ok('#116 写真付きの報告も欠勤のシフトには報告できない', p1.status === 400 && /欠勤/.test(p1.data.error), p1)

  const past = await createShift(admin, 9, 2, yesterday, 'W2AR-PAST', { start_time: '09:00', end_time: '10:00' })
  const r2 = await st9.post('/api/staff/attendance', { shift_id: past, report_type: 'check_in' })
  ok('#84 前日のシフトに入店は報告できない（打刻修正へ案内）', r2.status === 400 && /受付期間/.test(r2.data.error), r2)
  const p2 = await st9.form('/api/staff/attendance-photo', photoForm(past, 'check_in'))
  ok('#84 写真付きの入店も前日のシフトには報告できない', p2.status === 400 && /受付期間/.test(p2.data.error), p2)
  const fut = await createShift(admin, 9, 2, addDays(today, 2), 'W2AR-FUTURE')
  const r3 = await st9.post('/api/staff/attendance', { shift_id: fut, report_type: 'check_in' })
  ok('#116 未来のシフトには報告できない', r3.status === 400 && /まだ報告できません/.test(r3.data.error), r3)

  const settled = await createShift(admin, 9, 3, yesterday, 'W2AR-SETTLED', { start_time: '09:00', end_time: '10:00' })
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [settled], force: true })
  ok('（準備）前日のシフトを確定できる', cf.status === 200, cf)
  const r4 = await st9.post('/api/staff/attendance', { shift_id: settled, report_type: 'check_out' })
  ok('#116 確定済みのシフトには報告できない（翌日も受け付ける退店でも）', r4.status === 409 && /確定/.test(r4.data.error), r4)
}

// ---------- 5. #19 希望（仮）のシフト: ホームで未確定と分かる ----------
let T1
{
  T1 = await createShift(admin, 10, 1, today, 'W2AR-TENT', { status: 'requested' })
  const h = await st10.get(`/api/staff/home?shift_id=${T1}`)
  ok('#19 ホーム: 希望（仮）のシフトに未確定の印', h.data.shift && h.data.shift.shift_id === T1 && h.data.tentative === true, { id: h.data.shift && h.data.shift.shift_id, tentative: h.data.tentative })
  ok('#19 ホーム: 本日のシフト一覧にも未確定の印', h.data.today_shifts.some(x => x.shift_id === T1 && x.tentative === true), h.data.today_shifts)
  const conf = await createShift(admin, 10, 2, today, 'W2AR-CONF', { start_time: '23:00', end_time: '23:30' })
  const h2 = await st10.get(`/api/staff/home?shift_id=${conf}`)
  ok('#19 確定のシフトには未確定の印を付けない', h2.data.tentative === false, h2.data.tentative)
  // 報告はできる（画面で確認を出す。精算での扱いは w3-settlement-checks）
  const r = await st10.post('/api/staff/attendance', { shift_id: T1, report_type: 'check_in' })
  ok('#19 希望（仮）のシフトでも報告はできる（画面で確認を出す）', r.status === 200, r)
}

// ---------- 6. #559 打刻履歴・打刻修正申請の対象から希望（仮）を除く ----------
{
  const T2 = await createShift(admin, 10, 1, yesterday, 'W2AR-TENT-OLD', { status: 'requested', start_time: '09:00', end_time: '18:00' })
  const tl = await st10.get(`/api/staff/attendance/timeline?from=${yesterday}&to=${today}`)
  ok('#559 報告のない希望（仮）のシフトは打刻履歴に出ない', !tl.data.shifts.some(s => s.shift_id === T2), tl.data.shifts.map(s => [s.shift_id, s.status]))
  const t1 = tl.data.shifts.find(s => s.shift_id === T1)
  ok('#559 報告してしまった希望（仮）のシフトは『未確定』として出る', t1 && t1.tentative === true, t1)
  const c = await st10.post('/api/staff/corrections', { shift_id: T2, report_type: 'check_in', kind: 'add', requested_at: `${yesterday} 09:00`, reason: 'x' })
  ok('#559 希望（仮）のシフトには打刻漏れを申請できない', c.status === 400 && /未確定/.test(c.data.error), c)
  const a = await admin.post('/api/admin/corrections', { shift_id: T2, report_type: 'check_in', kind: 'add', requested_at: `${yesterday} 09:00`, reason: 'x' })
  ok('#559 管理者の申請も同じ（400）', a.status === 400, a)
}

// ---------- 7. #458 勤務中に ON にした報告は、そのシフトでは求めない（OFF はすぐ外れる） ----------
{
  // staff 9 の案件2: 出発報告 OFF の状態で報告を始めたシフトと、まだ始めていない明日のシフト
  const off = await admin.put('/api/admin/report-settings/projects/2/staff/9', { settings: { departure: false } })
  ok('（準備）出発報告を OFF にできる', off.status === 200, off)
  const S4 = await createShift(admin, 9, 2, today, 'W2AR-STARTED')
  const S5 = await createShift(admin, 9, 2, tomorrow, 'W2AR-NEXT')
  const ci = await st9.post('/api/staff/attendance', { shift_id: S4, report_type: 'check_in' })
  ok('（準備）入店を報告', ci.status === 200, ci)
  const on = await admin.put('/api/admin/report-settings/projects/2/staff/9', { settings: { departure: true } })
  ok('（準備）出発報告を ON にできる', on.status === 200, on)
  let s4 = await reportStatus(admin, S4)
  const s5 = await reportStatus(admin, S5)
  ok('#458 勤務中に ON にした報告は、そのシフトでは求めない', !s4.modes.required_attendance.includes('departure') && s4.modes.required_attendance.includes('check_out'), s4.modes.required_attendance)
  ok('#458 ON にした報告は次のシフトから効く', s5.modes.required_attendance.includes('departure'), s5.modes.required_attendance)
  await admin.put('/api/admin/report-settings/projects/2/staff/9', { settings: { wake_up: false } })
  s4 = await reportStatus(admin, S4)
  ok('#458 OFF にした報告は勤務中のシフトからもすぐ外れる（docs 2.7）', !s4.modes.required_attendance.includes('wake_up') && !s4.modes.required_attendance.includes('departure'), s4.modes.required_attendance)
  // 勤務の途中で休憩を ON にしても退店まで進める（再現例: 勤務終了の後に休憩入・休憩出が ON）
  const S3 = await createShift(admin, 9, 3, today, 'W2AR-BREAK')
  await admin.put('/api/admin/report-settings/projects/3/staff/9', { settings: { break_start: false, break_end: false } })
  for (const t of ['check_in', 'work_start', 'work_end']) await st9.post('/api/staff/attendance', { shift_id: S3, report_type: t })
  await admin.put('/api/admin/report-settings/projects/3/staff/9', { settings: { break_start: true, break_end: true } })
  const h = await st9.get(`/api/staff/home?shift_id=${S3}`)
  ok('#458 勤務終了の後に休憩を ON にしても、休憩は求めない', !h.data.required_attendance.includes('break_start'), h.data.required_attendance)
  const co = await st9.post('/api/staff/attendance', { shift_id: S3, report_type: 'check_out' })
  ok('#458 そのまま退店を報告できる', co.status === 200, co)
}

// ---------- 8. #519 0027 より前のスタッフ単位の設定（staff 2 = 報告なし）を新しい案件にも使う ----------
{
  const projects = (await admin.get('/api/admin/report-settings/projects?include_closed=1')).data.projects
  const free = []
  for (const p of projects) {
    const d = (await admin.get(`/api/admin/report-settings/projects/${p.project_id}`)).data
    if (!d.staff.some(s => s.staff_id === 2)) free.push(p.project_id)
  }
  if (free.length < 2) {
    ok('#519 （staff 2 が所属していない案件が 2 つ以上必要。seed を確認）', false, free)
  } else {
    const [pa, pb] = free
    const sh = await createShift(admin, 2, pa, tomorrow, 'W2AR-LEGACY')
    const rs = await reportStatus(admin, sh)
    ok('#519 旧設定「報告なし」のスタッフは、新しい案件でも勤怠報告なし', rs.modes.required_attendance.length === 0, rs.modes)
    const d = (await admin.get(`/api/admin/report-settings/projects/${pa}`)).data.staff.find(s => s.staff_id === 2)
    ok('#519 案件報告管理の画面データにも反映（すべて OFF・legacy_mode）', d && ALL.every(t => d.settings[t] === 0) && d.legacy_mode === 'none', d)
    await admin.put(`/api/admin/report-settings/projects/${pa}/default`, { settings: { wake_up: false } })
    const d2 = (await admin.get(`/api/admin/report-settings/projects/${pa}`)).data.staff.find(s => s.staff_id === 2)
    ok('#519 案件の標準設定を変えても、旧設定の値で固定される', d2 && ALL.every(t => d2.settings[t] === 0) && d2.individual, d2)
    const reset = await admin.put('/api/admin/staff/2/report-settings', { attendance_mode: '', daily_report_mode: '' })
    ok('（準備）スタッフの提出設定を「案件の標準設定」に戻せる', reset.status === 200, reset)
    const sh2 = await createShift(admin, 2, pb, tomorrow, 'W2AR-LEGACY2')
    const rs2 = await reportStatus(admin, sh2)
    ok('#519 標準設定に戻した後に入った案件は、案件の標準設定を使う', rs2.modes.required_attendance.length > 0, rs2.modes)
  }
}

await admin.post('/api/admin/settings/photo-required', { enabled: true })
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
