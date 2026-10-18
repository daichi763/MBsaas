// ダッシュボードの本日の状況と欠勤の操作の統合テスト（w3-dashboard: #85 #107 #186 #216 #221 #226 #549）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w3-dashboard.mjs
// テストのたびに DB を作り直すこと（シフト・申請を追加するため）。
// 未報告の判定は今の時刻で変わるため、シフトは今の時刻からの相対で作る（日付をまたぐ場合も同じ判定になるようにしている）

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)

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
const jstNowMs = () => Date.now() + 9 * 3600 * 1000
const today = new Date(jstNowMs()).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1)
// 今から offset 分後の JST の日付と時刻（分単位）
const at = (offset) => { const iso = new Date(jstNowMs() + offset * 60000).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 16) } }

async function createShift(admin, staff_id, project_id, work_date, memo, start_time, end_time, status) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, status })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  return r.data.shift_id
}
// 今から startOff 分後に始まり endOff 分後に終わるシフト（稼働日は開始の日付）
const relShift = (admin, staff_id, memo, startOff, endOff) => { const s = at(startOff), e = at(endOff); return createShift(admin, staff_id, 1, s.date, memo, s.time, e.time) }

const admin = client(await login('sample', 'admin'))
const dash = async () => { const r = await admin.get('/api/admin/dashboard'); if (r.status !== 200) throw new Error('dashboard ' + r.status); return r.data }
const ids = (list) => (list || []).map(x => x.shift_id)

// ---------- #186 未報告は予定の時刻を過ぎたものだけ。勤務終了・退店の未報告（前日分を含む） ----------
const A = await relShift(admin, 3, 'W3D-A', -90, 60)    // 90分前に開始（入店の未報告）
const B = await relShift(admin, 4, 'W3D-B', 180, 240)   // 3時間後に開始（まだ未報告にしない）
const C = await relShift(admin, 5, 'W3D-C', -180, -40)  // 40分前に終了（勤務終了・退店の未報告）
const D = await createShift(admin, 6, 1, yesterday, 'W3D-D', '09:00', '10:00') // 前日の日中（退店漏れ）
{
  const d = await dash()
  const ci = d.unreported.check_in.find(x => x.shift_id === A)
  ok('#186 開始を過ぎた入店の未報告が出る（開始時刻と経過分つき）', ci && ci.start_time === at(-90).time && ci.overdue_minutes >= 88 && ci.overdue_minutes <= 95, ci)
  ok('#186 開始前のシフトは入店・出発・起床の未報告に出ない', ![...d.unreported.check_in, ...d.unreported.departure, ...d.unreported.wake_up].some(x => x.shift_id === B), d.unreported)
  const wu = d.unreported.wake_up.find(x => x.shift_id === A)
  ok('#186 起床は開始の2時間前（稼働日の 0:00 より前にはしない）を過ぎたら未報告', !!wu, d.unreported.wake_up)
  const we = d.unreported.work_end || []
  const c = we.find(x => x.shift_id === C), dd = we.find(x => x.shift_id === D)
  ok('#186 終了の30分後を過ぎた勤務終了・退店の未報告が出る', c && c.missing.includes('work_end') && c.missing.includes('check_out'), we)
  ok('#186 前日の退店漏れも出る', dd && dd.work_date === yesterday, we)
  ok('#186 終了前のシフトは勤務終了・退店の未報告に出ない', !we.some(x => x.shift_id === A || x.shift_id === B), we)

  // 前日分の退店に承認待ちの修正申請があれば、その種類は未報告にしない。承認待ちは ToDo にも出る（#226）
  const cr = await admin.post('/api/admin/corrections', { shift_id: D, report_type: 'check_out', kind: 'add', requested_at: `${yesterday} 10:05`, reason: '退店を押し忘れ' })
  ok('前日分の退店の追加を申請', cr.status === 200 && cr.data.correction_id, cr)
  const d2 = await dash()
  const dd2 = (d2.unreported.work_end || []).find(x => x.shift_id === D)
  ok('#186 承認待ちの申請がある種類は未報告から外す', dd2 && dd2.missing.join() === 'work_end', dd2)
  const todo = d2.todos.find(t => t.href === '#corrections')
  ok('#226 承認待ちの打刻修正が ToDo に出る', todo && /打刻修正の承認待ちが\d+件/.test(todo.text), d2.todos)

  // 代理入力で勤務終了を記録すると消える
  const px = await admin.post(`/api/admin/shifts/${D}/proxy-attendance`, { report_types: ['work_end'], times: {} })
  ok('前日分の勤務終了を代理入力', px.status === 200, px)
  const d3 = await dash()
  ok('#186 報告がそろうと勤務終了・退店の未報告から消える', !ids(d3.unreported.work_end).includes(D), d3.unreported.work_end)
}

// ---------- #221 入店以降の報告があるシフト ----------
{
  const px = await admin.post(`/api/admin/shifts/${A}/proxy-attendance`, { report_types: ['check_in'], times: {} })
  ok('入店を代理入力', px.status === 200, px)
  const d = await dash()
  const s = d.shifts.find(x => x.shift_id === A)
  ok('#221 入店済みのシフトは started（欠勤のボタンを出さない）', s && s.started === true, s)
  ok('#221 入店済みは入店の未報告から消える', !ids(d.unreported.check_in).includes(A), d.unreported.check_in)
  const b = d.shifts.find(x => x.shift_id === B)
  if (b) ok('#221 報告のないシフトは started でない', b.started === false, b)
  else skip('#221 報告のないシフトは started でない', '3時間後が翌日のため本日の一覧にない')
}

// ---------- #107 前日に始まった日をまたぐ勤務 ----------
{
  const e = at(60)
  if (e.date === today && e.time < '23:00') {
    const E = await createShift(admin, 7, 1, yesterday, 'W3D-E', '23:00', e.time)
    const d = await dash()
    const s = d.shifts.find(x => x.shift_id === E)
    ok('#107 前日23時に始まった勤務中の夜勤が、本日の一覧に「前日から継続」で出る', s && s.carried_over === true && s.work_date === yesterday, d.shifts.map(x => [x.shift_id, x.work_date]))
    ok('#107 継続分は本日の稼働人数に数えない', d.working_count === d.shifts.filter(x => !x.carried_over).length, [d.working_count, d.shifts.length])
    ok('#107 継続中で入店していなければ入店の未報告にも出る', ids(d.unreported.check_in).includes(E), d.unreported.check_in)
  } else skip('#107 前日から継続', '1時間後が23時以降のため')
  // 日をまたがない前日のシフトは本日の一覧に出さない
  const d = await dash()
  ok('#107 日をまたがない前日のシフトは本日の一覧に出ない', !ids(d.shifts).includes(D), ids(d.shifts))
}

// ---------- #216 欠勤のあと代わりを割り当てる ----------
{
  const slot = await admin.post('/api/admin/shift-slots', { project_id: 1, work_date: today, start_time: '23:00', end_time: '23:50', roles: [{ role_name: '販売W3D', headcount: 1 }] })
  ok('枠を作る', slot.status === 200, slot)
  const roles = (await admin.get(`/api/admin/shift-slots/${slot.data.slot_ids[0]}`)).data.roles
  const roleId = roles[0].slot_role_id
  const as = await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [8], force: true })
  ok('スタッフ8を割り当て', as.status === 200 && as.data.shift_ids.length === 1, as)
  const F = as.data.shift_ids[0]
  let d = await dash()
  const s = d.shifts.find(x => x.shift_id === F)
  ok('#216 ダッシュボードのシフトに枠の役割 ID が入る', s && s.slot_role_id === roleId, s)
  const ab = await admin.put(`/api/admin/shifts/${F}`, { status: 'absent' })
  ok('欠勤にする', ab.status === 200, ab)
  d = await dash()
  ok('#216 本日の欠勤として返る（代わりを探す入口）', ids(d.absent_shifts).includes(F) && !ids(d.shifts).includes(F), d.absent_shifts)
  const cand = await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${roleId}`)
  ok('#216 候補 API が使える', cand.status === 200 && cand.data.candidates.length > 0, cand.status)
  const pick = cand.data.candidates.find(c => c.staff_id !== 8)
  const sub = await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [pick.staff_id], status: 'substitute', force: true })
  ok('#216 代打（substitute）で割り当てられる', sub.status === 200 && sub.data.shift_ids.length === 1, sub)
  const list = (await admin.get(`/api/admin/shifts?from=${today}&to=${today}`)).data.shifts
  const created = list.find(x => x.shift_id === sub.data.shift_ids[0])
  ok('#216 作られたシフトの状態は代打', created && created.status === 'substitute', created)
}

// ---------- #549 欠勤の回数は今日以前だけ ----------
{
  const f1 = addDays(today, 1), f2 = addDays(today, 2)
  if (f2.slice(0, 7) === today.slice(0, 7)) {
    for (const [d, m] of [[f1, 'W3D-F1'], [f2, 'W3D-F2']]) {
      const id = await createShift(admin, 9, 1, d, m, '10:00', '18:00')
      await admin.put(`/api/admin/shifts/${id}`, { status: 'absent' })
    }
    const d = await dash()
    ok('#549 これからの日の欠勤（事前の休み）は「欠勤が今月n回」に数えない', !d.todos.some(t => t.staff_id === 9 && /欠勤/.test(t.text)), d.todos)
  } else skip('#549 これからの欠勤', '翌々日が来月のため')
  const p1 = addDays(today, -1)
  if (p1.slice(0, 7) === today.slice(0, 7)) {
    for (const [d, m] of [[p1, 'W3D-P1'], [today, 'W3D-P2']]) {
      const id = await createShift(admin, 10, 1, d, m, '06:00', '06:30')
      await admin.put(`/api/admin/shifts/${id}`, { status: 'absent' })
    }
    const d = await dash()
    ok('#549 今日以前の欠勤は数える', d.todos.some(t => t.staff_id === 10 && /欠勤が今月2回/.test(t.text)), d.todos)
  } else skip('#549 今日以前の欠勤', '前日が先月のため')
}

// ---------- #85 スタッフ一覧の本日未入店から欠勤を外す ----------
{
  const G = await createShift(admin, 11, 1, today, 'W3D-G', '07:00', '07:30')
  await admin.put(`/api/admin/shifts/${G}`, { status: 'absent' })
  const st = (await admin.get('/api/admin/staff')).data.staff
  const s11 = st.find(x => x.staff_id === 11)
  const todayWorking = (await admin.get(`/api/admin/shifts?from=${today}&to=${today}`)).data.shifts.filter(x => x.staff_id === 11 && ['confirmed', 'substitute'].includes(x.status)).length
  ok('#85 欠勤だけのスタッフは本日のシフトに数えない', s11 && s11.today_shift === todayWorking, s11 && [s11.today_shift, todayWorking])
  const s3 = st.find(x => x.staff_id === 3)
  ok('#85 入店済みのスタッフは本日未入店に出ない（today_checkin）', s3 && (s3.today_checkin > 0 || at(-90).date !== today), s3)
}

// ---------- #226 打刻修正の一覧（承認待ちは古い順、タブの件数は絞り込みを反映） ----------
{
  const all = await admin.get('/api/admin/corrections?status=pending')
  ok('#226 一覧に truncated と上限を返す', all.status === 200 && all.data.truncated === false && all.data.limit === 300, all.data && [all.data.truncated, all.data.limit])
  const created = all.data.corrections.map(c => c.created_at)
  ok('#226 承認待ちは申請の古い順', created.every((v, i) => i === 0 || created[i - 1] <= v), created)
  const name = all.data.corrections[0] && all.data.corrections[0].staff_name
  const f = await admin.get(`/api/admin/corrections?status=pending&staff_name=${encodeURIComponent('存在しない名前W3D')}`)
  ok('#226 タブの件数は絞り込みを反映する', f.status === 200 && Object.values(f.data.counts).every(n => n === 0) && f.data.corrections.length === 0, f.data.counts)
  const g = await admin.get(`/api/admin/corrections?status=approved&staff_name=${encodeURIComponent(name || '')}`)
  ok('#226 状態のタブを切り替えても、ほかの状態の件数を返す', g.status === 200 && (g.data.counts.pending || 0) >= 1, g.data.counts)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
