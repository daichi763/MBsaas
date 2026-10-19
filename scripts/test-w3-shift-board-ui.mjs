// シフトボードの表示と候補（w3-shift-board-ui: #204 #224 #408 #456 #528 #557 #566 と持ち越しの #500 #565）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8825 node scripts/test-w3-shift-board-ui.mjs
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
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay()

const PFX = 'SB' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(k, extra = {}) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', ...extra }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-取引先` }), 'client')
const clientId = cl.client_id
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: clientId }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const site = must(await admin.post('/api/admin/sites', { client_id: clientId, site_name: `${PFX}-会場` }), 'site')

async function newRole(date, start = '10:00', end = '18:00', headcount = 2, siteId = null) {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, site_id: siteId, dates: [date], start_time: start, end_time: end, roles: [{ role_name: '販売', headcount }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}&project_ids=${pid}`), 'board')
  const slots = b.slots.filter(s => s.start_time === start)
  return slots[slots.length - 1].roles[0].slot_role_id
}
const assign = async (role, staffId) => must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [staffId], force: true }), 'assign')

// 30日以上先の日曜日
let SUN = addDays(today, 30); while (weekday(SUN) !== 0) SUN = addDays(SUN, 1)
const MON = addDays(SUN, -6), SAT = addDays(SUN, -1), NEXT_MON = addDays(SUN, 1)

// ---------- #528 候補の『今週 n日』は月曜〜日曜の稼働日数 ----------
const w = await newStaff('WEEK')
{
  await assign(await newRole(MON, '09:00', '12:00'), w.staff_id)
  await assign(await newRole(MON, '13:00', '17:00'), w.staff_id) // 同じ日の2件目は1日と数える
  await assign(await newRole(SAT), w.staff_id)
  await assign(await newRole(NEXT_MON), w.staff_id)            // 翌週の月曜は数えない
  const sunRole = await newRole(SUN)
  const d = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${sunRole}`), 'candidates')
  const c = d.candidates.find(x => x.staff_id === w.staff_id)
  ok('#528 日曜の枠の候補: 今週（月〜日）の稼働日数は月・土の2日（同じ日の2件は1日、翌週の月曜は数えない）', c && c.week_days === 2, c)
  ok('#528 候補の週の始まりは月曜', d.slot_role.week_from === MON, d.slot_role)
}

// ---------- #557 候補に稼働エリア・稼働開始可能日・入社予定 ----------
{
  const area = await newStaff('AREA', { work_area: '東京23区' })
  const late = await newStaff('LATE')
  must(await admin.put(`/api/admin/staff/${late.staff_id}`, { available_from: addDays(SUN, 10) }), 'available_from')
  const pre = await newStaff('PRE')
  const r = await admin.put(`/api/admin/employees/${pre.staff_id}`, { profile: { employment_status: 'preboarding' } })
  const role = await newRole(SUN, '11:00', '15:00')
  const d = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${role}`), 'candidates')
  const a = d.candidates.find(x => x.staff_id === area.staff_id)
  const l = d.candidates.find(x => x.staff_id === late.staff_id)
  const p = d.candidates.find(x => x.staff_id === pre.staff_id)
  ok('#557 候補に稼働エリアを返す', a && a.work_area === '東京23区', a)
  ok('#557 稼働開始可能日が枠の日付より後の人は not_yet_available', l && l.available_from === addDays(SUN, 10) && l.not_yet_available === true, l)
  ok('#557 入社予定の人は preboarding', r.status === 200 && p && p.preboarding === true, { r, p })
  const idx = (s) => d.candidates.findIndex(x => x.staff_id === s.staff_id)
  ok('#557 稼働開始前・入社予定の人は、空きのある人の後ろに並ぶ', idx(area) < idx(late) && idx(area) < idx(pre), { area: idx(area), late: idx(late), pre: idx(pre) })
}

// ---------- #566 日ごとの必要人数・充足 / #565 粗利率の分母 ----------
{
  const D = addDays(SUN, 14)
  const s1 = await newStaff('FILL')
  const role = await newRole(D, '10:00', '18:00', 3)
  await assign(role, s1.staff_id)
  const b = must(await admin.get(`/api/admin/shift-board?from=${D}&to=${addDays(D, 1)}&project_ids=${pid}`), 'board')
  ok('#566 totals.by_date に日ごとの必要人数・充足を返す', b.totals.by_date[D] && b.totals.by_date[D].required === 3 && b.totals.by_date[D].filled === 1 && !b.totals.by_date[addDays(D, 1)], b.totals.by_date)
  ok('#565 粗利の分母（profit_bill）と支払未設定の請求額（pay_missing_bill）を返す', 'profit_bill' in b.totals && 'pay_missing_bill' in b.totals, b.totals)
}

// ---------- #500（持ち越し）退職者のシフトに印を付け、充足に数えない ----------
{
  const D = addDays(SUN, 15)
  const s = await newStaff('RETIRE')
  const role = await newRole(D, '10:00', '18:00', 1)
  await assign(role, s.staff_id)
  const r = await admin.put(`/api/admin/employees/${s.staff_id}`, { profile: { retired_at: addDays(D, -1), employment_status: 'retired', retired_at_confirmed: true } })
  const b = must(await admin.get(`/api/admin/shift-board?from=${D}&to=${D}&project_ids=${pid}`), 'board')
  const ro = b.slots.flatMap(x => x.roles).find(x => x.slot_role_id === role)
  const a = ro && ro.assigned.find(x => x.staff_id === s.staff_id)
  ok('#500 退職日より後のシフトに unavailable=退職 が付く', r.status === 200 && a && a.unavailable === '退職', { r: r.status, a: a && a.unavailable })
  ok('#500 退職者のシフトは充足に数えない（0/1）', ro && ro.filled === 0 && b.totals.by_date[D].filled === 0, { filled: ro && ro.filled, by: b.totals.by_date[D] })
  // 退職日の当日は稼働可
  const D2 = addDays(SUN, 16)
  const s2 = await newStaff('RETDAY')
  const role2 = await newRole(D2, '10:00', '18:00', 1)
  await assign(role2, s2.staff_id)
  must(await admin.put(`/api/admin/employees/${s2.staff_id}`, { profile: { retired_at: D2, employment_status: 'retired', retired_at_confirmed: true } }), 'retire same day')
  const b2 = must(await admin.get(`/api/admin/shift-board?from=${D2}&to=${D2}&project_ids=${pid}`), 'board2')
  const ro2 = b2.slots.flatMap(x => x.roles).find(x => x.slot_role_id === role2)
  ok('#500 退職日の当日のシフトは印を付けず、充足に数える', ro2 && ro2.filled === 1 && !ro2.assigned[0].unavailable, ro2 && ro2.assigned[0])
}

// ---------- #408 開催場所の件数 ----------
{
  const D = addDays(SUN, 17)
  const s = await newStaff('SITE')
  await assign(await newRole(D, '10:00', '18:00', 1, site.site_id), s.staff_id)
  const all = must(await admin.get(`/api/admin/sites?client_id=${clientId}`), 'sites').sites
  const light = must(await admin.get('/api/admin/sites?counts=0'), 'sites light').sites
  const x = all.find(v => v.site_id === site.site_id)
  ok('#408 開催場所ごとのシフト件数（GROUP BY）', x && x.shift_count === 1, x)
  ok('#408 counts=0 は件数を数えない', light.some(v => v.site_id === site.site_id) && light.every(v => !('shift_count' in v)), light[0])
}

// ---------- #204 クライアントのNGスタッフ ----------
{
  const ng = await newStaff('NG')
  const bad = await admin.put(`/api/admin/clients/${clientId}/ng-staff`, { staff: [{ staff_id: 99999999 }] })
  ok('#204 自社にいないスタッフは NG に登録できない（400）', bad.status === 400, bad)
  must(await admin.put(`/api/admin/clients/${clientId}/ng-staff`, { staff: [{ staff_id: ng.staff_id, reason: '遅刻が続いたため' }] }), 'ng put')
  const g = must(await admin.get(`/api/admin/clients/${clientId}/ng-staff`), 'ng get')
  ok('#204 NGスタッフを氏名・理由・登録日つきで返す', g.staff.length === 1 && g.staff[0].staff_id === ng.staff_id && g.staff[0].reason === '遅刻が続いたため' && g.staff[0].created_at, g)
  const cd = must(await admin.get(`/api/admin/clients/${clientId}`), 'client detail').client
  ok('#204 clients.ng_staff_ids に反映（既存の NG 判定が使う列）', String(cd.ng_staff_ids) === String(ng.staff_id), cd.ng_staff_ids)
  const role = await newRole(addDays(SUN, 18), '10:00', '12:00', 1)
  const c = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${role}`), 'candidates').candidates.find(x => x.staff_id === ng.staff_id)
  ok('#204 候補一覧で NG になる', c && c.ng === true, c)
  const as = await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [ng.staff_id] })
  ok('#204 割り当てると NG の警告（409）', as.status === 409 && as.data.warnings.some(x => x.includes('NG')), as)
  const sd = must(await admin.get(`/api/admin/staff/${ng.staff_id}`), 'staff detail')
  ok('#204 スタッフ詳細に NG 指定のクライアントを返す', sd.ng_clients.some(x => x.client_id === clientId && x.reason === '遅刻が続いたため'), sd.ng_clients)
  must(await admin.put(`/api/admin/clients/${clientId}/ng-staff`, { staff: [] }), 'ng clear')
  const g2 = must(await admin.get(`/api/admin/clients/${clientId}/ng-staff`), 'ng get2')
  ok('#204 NG を外せる', g2.staff.length === 0, g2)
}

// ---------- #224 スタッフ詳細の今後のシフトと過去の稼働 ----------
{
  const s = await newStaff('DETAIL')
  await assign(await newRole(addDays(today, -3), '10:00', '18:00', 1), s.staff_id)
  await assign(await newRole(addDays(SUN, 19), '10:00', '18:00', 1), s.staff_id)
  const d = must(await admin.get(`/api/admin/staff/${s.staff_id}`), 'staff detail')
  ok('#224 今後のシフト（今日以降）を返す', d.upcoming_shifts.length === 1 && d.upcoming_shifts[0].work_date === addDays(SUN, 19) && d.upcoming_shifts[0].project_name, d.upcoming_shifts)
  ok('#224 過去の稼働（今日より前）を返す', d.past_shifts.length === 1 && d.past_shifts[0].work_date === addDays(today, -3), d.past_shifts)
}

// ---------- #456 繰り返し登録の編集と延長 ----------
{
  const from = addDays(SUN, 21), to = addDays(from, 6)
  const p = must(await admin.post('/api/admin/slot-patterns', { project_id: pid, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: to, start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 2 }, { role_name: 'リーダー', headcount: 1 }] }), 'pattern')
  const list = must(await admin.get(`/api/admin/slot-patterns?project_id=${pid}`), 'patterns').patterns
  const pt = list.find(x => x.pattern_id === p.pattern_id)
  ok('#456 一覧に今日以降の枠数と終了までの日数を返す', pt && pt.future_slot_count === 7 && typeof pt.days_left === 'number', pt)
  // 1日目の『リーダー』に割り当てる
  const b0 = must(await admin.get(`/api/admin/shift-board?from=${from}&to=${to}&project_ids=${pid}`), 'board')
  const day1 = b0.slots.find(s => s.pattern_id === p.pattern_id && s.work_date === from)
  const leader = day1.roles.find(r => r.role_name === 'リーダー')
  const st = await newStaff('PAT')
  await assign(leader.slot_role_id, st.staff_id)
  const body = { start_time: '09:30', end_time: '18:00', roles: [{ orig_name: '販売', headcount: 3 }, { orig_name: 'リーダー', headcount: 1, _delete: true }, { role_name: 'MC', headcount: 1 }], date_to: addDays(to, 7) }
  const dry = must(await admin.put(`/api/admin/slot-patterns/${p.pattern_id}`, { ...body, dry_run: true }), 'dry')
  ok('#456 確認: 対象の枠・時刻を合わせるシフト・外す役割・残す役割・延長の件数', dry.slots === 7 && dry.shifts === 1 && dry.roles_removed === 6 && dry.roles_kept === 1 && dry.roles_added === 7 && dry.extend_slots === 7, dry)
  const run = must(await admin.put(`/api/admin/slot-patterns/${p.pattern_id}`, body), 'run')
  ok('#456 反映と延長（7件追加）', run.extend_slots === 7, run)
  const b1 = must(await admin.get(`/api/admin/shift-board?from=${from}&to=${addDays(to, 7)}&project_ids=${pid}`), 'board after')
  const mine = b1.slots.filter(s => s.pattern_id === p.pattern_id)
  ok('#456 すべての枠が 09:30 開始・販売3名・MC あり', mine.length === 14 && mine.every(s => s.start_time === '09:30' && s.roles.some(r => r.role_name === '販売' && r.headcount === 3) && s.roles.some(r => r.role_name === 'MC')), mine.map(s => [s.work_date, s.start_time, s.roles.map(r => r.role_name + r.headcount).join('/')]))
  ok('#456 割り当てのある役割（1日目のリーダー）だけ残る', mine.filter(s => s.roles.some(r => r.role_name === 'リーダー')).length === 1, mine.map(s => s.roles.map(r => r.role_name)))
  const sh = mine.flatMap(s => s.roles.flatMap(r => r.assigned)).find(a => a.staff_id === st.staff_id)
  ok('#456 割り当て済みシフトの時刻も 09:30 に変わる', sh && sh.start_time === '09:30', sh)
  // 時刻を早めると、割り当て済みの人の別のシフト（08:00〜09:00）と重なる → force が必要
  await assign(await newRole(from, '08:00', '09:00', 1), st.staff_id)
  const cf = await admin.put(`/api/admin/slot-patterns/${p.pattern_id}`, { start_time: '08:30' })
  ok('#456 割り当て済みの人の別のシフトと重なるときは確認が必要（409 need_force）', cf.status === 409 && cf.data.need_force && cf.data.warnings.length === 1, cf)
  const b2 = must(await admin.get(`/api/admin/shift-board?from=${from}&to=${from}&project_ids=${pid}`), 'board after 409')
  ok('#456 409 のときは何も変えない', b2.slots.filter(s => s.pattern_id === p.pattern_id).every(s => s.start_time === '09:30'), b2.slots.map(s => s.start_time))
  const back = await admin.put(`/api/admin/slot-patterns/${p.pattern_id}`, { date_to: from })
  ok('#456 終了日を早めることはできない（400）', back.status === 400, back)
  const past = await admin.put(`/api/admin/slot-patterns/${p.pattern_id}`, { apply_from: addDays(today, -1) })
  ok('#456 過去の日からは反映できない（400）', past.status === 400, past)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
