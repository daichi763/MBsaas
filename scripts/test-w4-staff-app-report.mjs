// スタッフアプリの報告の使い勝手の統合テスト（w4-staff-app-report: #323 #324 #327 #347、持ち越し #134 #371 #16）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w4-staff-app-report.mjs
// 画面だけの修正（#415 #547 夜勤の『翌』の表示、#426 失敗後の読み直し、#495 共通クラスの @layer）は、ここでは確かめない。
// 取消の時間切れ（送ってから5分）は、時刻を進められないので確かめない
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)

const PFX = 'SR' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
await admin.post('/api/admin/settings/photo-required', { enabled: false }) // 写真なしで報告できるようにする（テストのみ）

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function createShift(staff_id, project_id, start_time = '00:00', end_time = '23:59') {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date: today, start_time, end_time, memo }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
const adminShift = async (id) => must(await admin.get(`/api/admin/shifts?from=${today}&to=${today}`), 'shifts').shifts.find(x => x.shift_id === id)

const pid = await newProject(`${PFX}-報告案件`)
const S = await newStaff('A')
const st = client(await login('sample', `${PFX}A`))
const sid = await createShift(S.staff_id, pid)
const home = async () => must(await st.get(`/api/staff/home?shift_id=${sid}`), 'home')
const report = (type) => st.post('/api/staff/attendance', { shift_id: sid, report_type: type, latitude: null, longitude: null })
const withdraw = (type, extra = {}) => st.post('/api/staff/attendance/withdraw', { shift_id: sid, report_type: type, ...extra })

// ---------- #347 遅延・位置不明の記録を応答とホームで知らせる ----------
{
  const r = await report('check_in')
  ok('#347 開始時刻を過ぎた入店は status=late と遅れた分数を返す', r.status === 200 && r.data.status === 'late' && r.data.late_minutes > 0, r)
  const h = await home()
  const ci = h.reports.check_in
  ok('#347 ホームの報告に status・late_minutes・打刻の方法が付く', ci && ci.status === 'late' && ci.late_minutes > 0 && ci.entry_method === 'app' && ci.corrected === false, ci)
  // #134: 今受け付けている報告の種類
  ok('#134 ホームが report_window_open（種類ごとの受付中か）を返す', h.report_window_open && h.report_window_open.check_out === true && h.report_window_open.wake_up === true, h.report_window_open)
}

// ---------- #324 休憩なし ----------
{
  ok('#324 理由が無いと 400', (await st.post('/api/staff/attendance/no-break', { shift_id: sid })).status === 400)
  ok('#324 理由が長すぎると 400', (await st.post('/api/staff/attendance/no-break', { shift_id: sid, reason: 'あ'.repeat(201) })).status === 400)
  const r = await st.post('/api/staff/attendance/no-break', { shift_id: sid, reason: '忙しく休憩を取れなかった' })
  ok('#324 休憩なしで記録できる', r.status === 200, r)
  const h = await home()
  ok('#324 休憩入・休憩出が同じ時刻で記録される', h.reports.break_start && h.reports.break_end && h.reports.break_start.reported_at === h.reports.break_end.reported_at, h.reports)
  const s = await adminShift(sid)
  ok('#324 実績の休憩が0分になる', s && s.actual_break_minutes === 0, s && { b: s.actual_break_minutes, src: s.actual_source })
  const again = await st.post('/api/staff/attendance/no-break', { shift_id: sid, reason: 'もう一度' })
  ok('#324 休憩の報告があると 409', again.status === 409, again)
  const inbox = must(await admin.get('/api/admin/notifications'), 'admin notifications').notifications
  const n = inbox.find(x => x.kind === 'attendance_no_break' && x.related_id === sid)
  ok('#324 管理者に理由付きの通知が届く', n && /忙しく休憩を取れなかった/.test(n.body || ''), n)
}

// ---------- #323 押し間違いの取消 ----------
{
  const w = await withdraw('break_end', { no_break: true })
  ok('#323 休憩なしの2件をまとめて取り消せる', w.status === 200 && w.data.withdrawn.length === 2, w)
  let h = await home()
  ok('#323 取り消すと休憩の報告がなくなり、もう一度押せる', !h.reports.break_start && !h.reports.break_end, h.reports)
  const notes = must(await st.get('/api/staff/notifications'), 'staff notifications').notifications
  const rec = notes.find(x => x.kind === 'attendance_withdrawn' && x.related_id === sid)
  ok('#323 取消の記録が本人の通知に既読で残る', rec && rec.read_at && /本人が取り消しました/.test(rec.body || ''), rec)
  const wl = must(await admin.get(`/api/admin/shifts/${sid}/attendance-withdrawals`), 'withdrawals')
  ok('#323 管理者がシフトの取消の記録を見られる', wl.withdrawals.length === 1 && /休憩入・休憩出/.test(wl.withdrawals[0].body), wl)

  ok('#323 存在しない報告の取消は 404', (await withdraw('work_end')).status === 404)
  must(await report('work_start'), 'work_start')
  const later = await withdraw('check_in')
  ok('#323 後の報告があると取り消せない（409）', later.status === 409 && /勤務開始を報告済み/.test(later.data.error), later)
  const ws = await withdraw('work_start')
  ok('#323 最後の報告は取り消せる', ws.status === 200, ws)
  const re = await report('work_start')
  ok('#323 取り消した報告をもう一度送れる', re.status === 200, re)

  const we = await report('work_end')
  ok('#347 予定より早い勤務終了は early_leave_minutes を返す', we.status === 200 && we.data.early_leave_minutes > 0, we)
  const s1 = await adminShift(sid)
  ok('#323 勤務終了を送ると実績に反映される', s1 && s1.actual_end, s1 && s1.actual_end)
  ok('#323 勤務終了を取り消せる', (await withdraw('work_end')).status === 200)
  const s2 = await adminShift(sid)
  ok('#323 取り消すと実績から外れる', s2 && !s2.actual_end, s2 && s2.actual_end)

  // 代理入力した報告は取り消せない（起床を 0:00 で代理入力する）
  must(await admin.post(`/api/admin/shifts/${sid}/proxy-attendance`, { report_types: ['wake_up'], times: { wake_up: '00:00' } }), 'proxy')
  const px = await withdraw('wake_up')
  ok('#323 管理者の代理入力は取り消せない（409）', px.status === 409 && /代理入力/.test(px.data.error), px)

  // 他人のシフトは取り消せない
  const S2 = await newStaff('B')
  const st2 = client(await login('sample', `${PFX}B`))
  const other = await st2.post('/api/staff/attendance/withdraw', { shift_id: sid, report_type: 'work_start' })
  ok('#323 他人のシフトの報告は取り消せない（404）', other.status === 404, other)
  ok('#323 不正な種類は 400', (await withdraw('lunch')).status === 400)
  void S2
}

// ---------- #327 代理入力を本人に知らせ、区別する ----------
{
  const notes = must(await st.get('/api/staff/notifications'), 'staff notifications').notifications
  const n = notes.find(x => x.kind === 'attendance_proxy' && x.related_id === sid)
  ok('#327 代理入力の通知が本人に届く（未読）', n && !n.read_at && /起床報告/.test(n.title) && /記録した人/.test(n.body || ''), n)
  const h = await home()
  ok('#327 ホームの報告で代理入力が分かる', h.reports.wake_up && h.reports.wake_up.entry_method === 'proxy', h.reports.wake_up)
  const tl = must(await st.get(`/api/staff/attendance/timeline?from=${today}&to=${today}`), 'timeline')
  const row = tl.shifts.find(x => x.shift_id === sid)
  ok('#327 打刻履歴の報告に entry_method=proxy が付く', row && row.reports.some(r => r.report_type === 'wake_up' && r.entry_method === 'proxy'), row && row.reports)
}

// ---------- #371 #16 日報の確認日時 ----------
{
  must(await st.post('/api/staff/daily-report', { shift_id: sid, values: { free: '報告です' } }), 'daily report')
  let h = await home()
  ok('#371 確認前のホームは daily_report_checked_at=null', h.daily_report_done === true && h.daily_report_checked_at === null, { d: h.daily_report_done, c: h.daily_report_checked_at })
  const mine = must(await st.get('/api/staff/my-reports'), 'my-reports').reports.find(x => x.shift_id === sid)
  must(await admin.put(`/api/admin/daily-reports/${mine.daily_report_id}`, { manager_checked: 1 }), 'check')
  h = await home()
  ok('#371 確認後のホームに確認日時が付く', typeof h.daily_report_checked_at === 'string' && h.daily_report_checked_at.length > 0, h.daily_report_checked_at)
  const mine2 = must(await st.get('/api/staff/my-reports'), 'my-reports').reports.find(x => x.shift_id === sid)
  ok('#371 過去の日報に確認日時と shift_id が付く（#16 の開き直しに使う）', mine2.manager_checked === true && mine2.manager_checked_at && mine2.shift_id === sid, mine2)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
