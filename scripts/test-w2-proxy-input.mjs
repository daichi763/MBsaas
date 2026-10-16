// 代理入力と報告用URLの統合テスト（w2-proxy-input: #20 #42 #83 #98 #110 #246 #472 #567）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-proxy-input.mjs
// テストのたびに DB を作り直すこと（シフト・報告を追加するため、2 回目は結果が変わる）
import { isLateCheckIn } from '../src/lib/shift-time.ts'

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

const admin = client(await login('sample', 'admin'))
async function createShift(staff_id, project_id, work_date, memo, start_time, end_time, extra = {}) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, ...extra })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const s = (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const proxy = (id, body) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, body)
const status = async (id) => (await admin.get(`/api/admin/shifts/${id}/report-status`)).data
const reportOf = async (id, t) => (await status(id)).reports.find(r => r.report_type === t)
async function settleRow(id, date) { return ((await admin.get(`/api/admin/settlement?from=${date}&to=${date}`)).data.rows || []).find(x => x.shift_id === id) }

// ---------- 0. 遅延判定の共通関数（ネットワーク不要） ----------
{
  const day = { work_date: '2026-10-01', start_time: '10:00', end_time: '19:00' }
  ok('#110 isLateCheckIn: 開始と同じ分は遅延でない', !isLateCheckIn(day, '2026-10-01 10:00:59'))
  ok('#110 isLateCheckIn: 開始より後は遅延', isLateCheckIn(day, '2026-10-01 10:01:00'))
  ok('#110 isLateCheckIn: 前日の夜の入店は遅延でない', !isLateCheckIn(day, '2026-09-30 23:00:00'))
  ok('#110 isLateCheckIn: 夜勤の翌日の入店は遅延', isLateCheckIn({ work_date: '2026-10-01', start_time: '22:00', end_time: '06:00' }, '2026-10-02 00:10:00'))
}

// ---------- 1. #42 代理入力ボタンに値を埋め込まない ----------
{
  const js = await (await fetch(`${BASE}/static/staff-lifecycle.js`)).text()
  ok('#42 代理入力ボタンは data-action と委譲で開く（onclick に JSON を埋め込まない）', /data-action="openProxyAttendance"/.test(js) && !/onclick="openProxyAttendance\(/.test(js) && !/JSON\.stringify\(d\.modes/.test(js))
  ok('#42 記録ボタンは送信ロック付き', /data-action="submitProxyAttendance"/.test(js) && /withSubmitLock\(button/.test(js))
  ok('#567 既定のチェックは入店だけ', /t === 'check_in' \? 'checked'/.test(js) && !/\['check_in', 'check_out'\]\.includes\(t\) \? 'checked'/.test(js))
}

// ---------- 2. #20 #110 種類ごとの時刻・遅延の判定 ----------
{
  const a = await createShift(1, 1, yesterday, 'PX-A', '09:00', '18:00')
  const st = await status(a)
  ok('報告状況に代理入力の既定値と稼働日が出る', st.work_date === yesterday && st.proxy_defaults && st.proxy_defaults.check_in === `${yesterday} 09:00:00` && st.proxy_defaults.check_out === `${yesterday} 18:00:00` && st.proxy_blocked === null, st)
  let r = await proxy(a, { report_types: ['check_in', 'check_out'], time: '09:10' })
  ok('#20 1つの時刻を複数の種類に使う旧形式は 400', r.status === 400 && /種類ごと/.test(r.data.error), r)
  r = await proxy(a, { report_types: ['check_in', 'check_out'], times: { check_in: '09:10', check_out: '09:10' } })
  ok('#20 入店と退店が同じ時刻なら 400（実働24時間を防ぐ）', r.status === 400 && /同じ時刻/.test(r.data.error), r)
  r = await proxy(a, { report_types: ['check_in', 'check_out'], times: { check_in: '09:10', check_out: '08:00' } })
  ok('#20 退店が入店より前なら 400', r.status === 400 && /より前/.test(r.data.error), r)
  r = await proxy(a, { report_types: ['check_in', 'check_out'], times: { check_in: '09:10', check_out: '18:00' } })
  ok('#20 種類ごとの時刻で記録できる', r.status === 200 && r.data.created === 2, r)
  const ci = await reportOf(a, 'check_in'), co = await reportOf(a, 'check_out')
  ok('#20 入店・退店がそれぞれの時刻で記録される', ci && ci.reported_at === `${yesterday} 09:10:00` && co && co.reported_at === `${yesterday} 18:00:00`, [ci, co])
  ok('#110 開始より後の入店は遅延になる', ci && ci.status === 'late' && ci.entry_method === 'proxy', ci)
  const row = await settleRow(a, yesterday)
  ok('#20 実績は 09:10〜18:00（24時間にならない）', row && row.actual_start === '09:10' && row.actual_end === '18:00', row && [row.actual_start, row.actual_end, row.actual_hours])
  r = await proxy(a, { report_types: ['check_in'], times: { check_in: '09:00' } })
  ok('報告済みの種類は 409', r.status === 409 && /報告済み/.test(r.data.error), r)
  r = await proxy(a, { report_types: ['work_start'], times: { work_start: '18:30' } })
  ok('すでにある報告との前後関係も確認する（勤務開始が退店より後なら 400）', r.status === 400 && /より前/.test(r.data.error), r)
  const b = await createShift(7, 1, yesterday, 'PX-B', '09:00', '18:00')
  r = await proxy(b, { report_types: ['check_in'], times: { check_in: '08:55' } })
  const ci2 = await reportOf(b, 'check_in')
  ok('#110 開始前の入店は遅延にならない', r.status === 200 && ci2 && ci2.status === 'normal', ci2)
}

// ---------- 3. #472 空欄の既定値は予定から決め、押した日時を使わない ----------
{
  const c = await createShift(3, 1, yesterday, 'PX-C', '09:00', '18:00')
  const st = await status(c)
  const bs = st.proxy_defaults.break_start, be = st.proxy_defaults.break_end
  let r = await proxy(c, { report_types: ['wake_up'] })
  ok('#472 起床は時刻が空欄なら 400（現在時刻で記録しない）', r.status === 400 && /時刻を入力/.test(r.data.error), r)
  r = await proxy(c, { report_types: ['check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'] })
  ok('#472 入店〜退店を空欄で記録できる', r.status === 200 && r.data.created === 6, r)
  const reps = (await status(c)).reports
  const at = (t) => (reps.find(x => x.report_type === t) || {}).reported_at
  ok('#472 休憩は予定の休憩を勤務時間の中ほどに置いた稼働日の時刻', bs && be && at('break_start') === bs && at('break_end') === be && bs.startsWith(yesterday) && bs > `${yesterday} 09:00:00` && be < `${yesterday} 18:00:00`, [bs, be, at('break_start'), at('break_end')])
  const row = await settleRow(c, yesterday)
  const brk = Math.round((Date.parse(be.replace(' ', 'T') + 'Z') - Date.parse(bs.replace(' ', 'T') + 'Z')) / 60000)
  ok('#472 実績の休憩は予定の休憩と同じ（0分にならない）', row && row.actual_break_minutes === brk && brk > 0, row && [row.actual_break_minutes, brk])
}

// ---------- 4. #98 夜勤の翌日の時刻は翌日の日付で記録する ----------
{
  const d = addDays(today, -2), next = addDays(d, 1)
  const n = await createShift(4, 1, d, 'PX-NIGHT', '22:00', '06:00')
  const st = await status(n)
  ok('#98 既定の退店は翌日の終了時刻', st.proxy_defaults.check_out === `${next} 06:00:00`, st.proxy_defaults)
  let r = await proxy(n, { report_types: ['check_in', 'work_start', 'break_start', 'break_end'], times: { check_in: '21:55', break_start: '23:30', break_end: '00:30' } })
  ok('#98 日をまたぐ休憩を記録できる', r.status === 200, r)
  r = await proxy(n, { report_types: ['work_end', 'check_out'], times: { work_end: '06:00', check_out: '06:10' } })
  const reps = (await status(n)).reports
  const at = (t) => (reps.find(x => x.report_type === t) || {}).reported_at
  ok('#98 入店は稼働日、休憩出・退店は翌日の日付', r.status === 200 && at('check_in') === `${d} 21:55:00` && at('break_start') === `${d} 23:30:00` && at('break_end') === `${next} 00:30:00` && at('check_out') === `${next} 06:10:00`, reps)
  const row = await settleRow(n, d)
  ok('#98 実績の休憩は60分（予定の休憩に戻らない）', row && row.actual_break_minutes === 60 && row.actual_start === '22:00' && row.actual_end === '06:00', row && [row.actual_start, row.actual_end, row.actual_break_minutes])
}

// ---------- 5. #567 未来の日時・稼働日より前のシフト ----------
{
  const f = await createShift(5, 1, addDays(today, 1), 'PX-FUT', '09:00', '18:00')
  let r = await proxy(f, { report_types: ['check_in'] })
  ok('#567 稼働日より前のシフトは 400', r.status === 400 && /稼働日より前/.test(r.data.error), r)
  ok('#567 報告状況でも代理入力できない理由が分かる', (await status(f)).proxy_blocked === '稼働日より前')
  const g = await createShift(5, 1, today, 'PX-TODAY', '23:58', '23:59')
  r = await proxy(g, { report_types: ['check_out'] })
  ok('#567 予定の終了時刻がまだ先なら、空欄の退店は記録しない（400）', r.status === 400 && /まだ先/.test(r.data.error), r)
}

// ---------- 6. #83 確定済み・欠勤のシフト ----------
{
  const e = await createShift(6, 1, addDays(today, -3), 'PX-SETTLED', '09:00', '18:00')
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [e], force: true })
  let r = await proxy(e, { report_types: ['check_in'] })
  ok('#83 確定済みのシフトは 409', cf.status === 200 && r.status === 409 && /確定済み/.test(r.data.error), [cf.status, r])
  ok('#83 報告状況でも確定済みと分かる', (await status(e)).proxy_blocked === '確定済み')
  const ab = await createShift(6, 1, addDays(today, -4), 'PX-ABSENT', '09:00', '18:00', { status: 'absent' })
  r = await proxy(ab, { report_types: ['check_in'] })
  ok('#83 欠勤のシフトは 400', r.status === 400 && /欠勤/.test(r.data.error), r)
  const rows = (await status(ab)).reports
  ok('#83 欠勤のシフトに勤怠は残らない', rows.length === 0, rows)
}

// ---------- 7. #246 退職したスタッフの報告用URL ----------
{
  const SID = 9
  const before = await createShift(SID, 1, yesterday, 'PX-RET-Y', '09:00', '18:00')
  const after = await createShift(SID, 1, today, 'PX-RET-T', '23:00', '23:30')
  const tY = (await admin.post(`/api/admin/shifts/${before}/report-link`, {})).data?.token
  const tT = (await admin.post(`/api/admin/shifts/${after}/report-link`, {})).data?.token
  ok('退職前は報告用URLを発行できる', tY && tT, { tY, tT })
  const pub = client(null)
  ok('退職前は報告用URLを開ける', (await pub.get(`/api/public/report/${tT}`)).status === 200)
  const ret = await admin.put(`/api/admin/employees/${SID}`, { profile: { retired_at: yesterday, employment_status: 'retired', retired_at_confirmed: true } })
  if (ret.status !== 200) console.log('SKIP  退職の更新に失敗したため #246 を確認しない', ret)
  else {
    ok('#246 退職日より後のシフトの報告用URLは使えない', (await pub.get(`/api/public/report/${tT}`)).status === 404)
    const rp = await pub.post(`/api/public/report/${tT}/attendance`, { report_type: 'check_in' })
    ok('#246 退職日より後のシフトの勤怠は送れない', rp.status === 404, rp)
    ok('#246 退職日当日までのシフトの報告用URLは使える', (await pub.get(`/api/public/report/${tY}`)).status === 200)
    const re = await admin.post(`/api/admin/shifts/${after}/report-link`, { regenerate: true })
    ok('#246 退職日より後のシフトには報告用URLを発行できない', re.status === 400 && /退職日より後/.test(re.data.error), re)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
