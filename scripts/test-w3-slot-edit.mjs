// シフトボードの枠・開催場所の編集（w3-slot-edit: #57 #117 #118 #130 #137 #142 #146 #492）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w3-slot-edit.mjs
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
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const PFX = 'SE' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
// 枠を作り、その枠（slot_id と役割）を返す
async function newSlot(pid, date, opt = {}) {
  const body = { project_id: pid, dates: [date], start_time: opt.start || '10:00', end_time: opt.end || '19:00', break_minutes: opt.break ?? 60, site_id: opt.site_id || null, roles: [{ role_name: '販売', headcount: 3 }] }
  const r = must(await admin.post('/api/admin/shift-slots', body), 'slot')
  return must(await admin.get('/api/admin/shift-slots/' + r.slot_ids[0]), 'slot get')
}
const assign = async (roleId, staffIds) => must(await admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: staffIds, force: true }), 'assign').shift_ids
const shiftsOf = async (from, to = from) => must(await admin.get(`/api/admin/shifts?from=${from}&to=${to}`), 'shifts').shifts
const shiftById = async (id, from, to) => (await shiftsOf(from, to)).find(s => s.shift_id === id)
// 現在の枠を送り直す形の本文（画面の保存と同じ）
const slotBody = (sl, roles, extra = {}) => ({
  site_id: sl.slot.site_id, location: sl.slot.location, work_date: sl.slot.work_date, start_time: sl.slot.start_time, end_time: sl.slot.end_time,
  break_minutes: sl.slot.break_minutes, memo: sl.slot.memo, roles: roles || sl.roles.map(r => ({ slot_role_id: r.slot_role_id, role_name: r.role_name, headcount: r.headcount, bill_rate: r.bill_rate, pay_rate: r.pay_rate })), ...extra,
})
const pid = await newProject(`${PFX}-案件`)
const D = addDays(today, 10)

// ---------- #146 役割の確認で失敗したら何も保存しない・役割0件の拒否 ----------
{
  const sl = await newSlot(pid, D)
  const st = await newStaff('R1')
  await assign(sl.roles[0].slot_role_id, [st.staff_id])
  const r = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl, [{ slot_role_id: sl.roles[0].slot_role_id, role_name: '販売', _delete: true }, { role_name: '追加', headcount: 1 }], { start_time: '11:00' }))
  const after = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  ok('#146 割当済みの役割の削除は 409', r.status === 409, r)
  ok('#146 409 のとき枠の時刻も役割の追加も保存されない', after.slot.start_time === '10:00' && after.roles.length === 1, after)
  const sl2 = await newSlot(pid, D, { start: '06:00', end: '08:00' })
  const r2 = await admin.put('/api/admin/shift-slots/' + sl2.slot.slot_id, slotBody(sl2, [{ slot_role_id: sl2.roles[0].slot_role_id, role_name: '販売', _delete: true }]))
  ok('#146 役割をすべて削除する保存は 400', r2.status === 400, r2)
  const r3 = await admin.put('/api/admin/shift-slots/' + sl2.slot.slot_id, slotBody(sl2, [{ slot_role_id: sl2.roles[0].slot_role_id, role_name: '' }]))
  ok('#146 役割名が空なら 400', r3.status === 400, r3)
}

// ---------- #118 シフトごとに直した休憩を上書きしない・手動の金額の数量 ----------
{
  const sl = await newSlot(pid, D, { start: '10:00', end: '19:00', break: 60 })
  const a = await newStaff('BRA'), b = await newStaff('BRB')
  const [sa] = await assign(sl.roles[0].slot_role_id, [a.staff_id])
  const [sb] = await assign(sl.roles[0].slot_role_id, [b.staff_id])
  must(await admin.put(`/api/admin/shifts/${sa}/price`, { bill_unit_type: 'hourly', bill_rate: 1000, break_minutes: 30 }), 'price A')
  const a0 = await shiftById(sa, D)
  ok('#118 準備: A の休憩30分・数量8.5', a0.break_minutes === 30 && Number(a0.bill_qty) === 8.5, a0)
  // 人数だけ変える
  const roles = sl.roles.map(r => ({ slot_role_id: r.slot_role_id, role_name: r.role_name, headcount: 4 }))
  must(await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl, roles)), 'headcount')
  const a1 = await shiftById(sa, D)
  ok('#118 人数だけ変えても、A の休憩（30分）と数量は変わらない', a1.break_minutes === 30 && Number(a1.bill_qty) === 8.5, a1)
  // 終了時刻と休憩を変える
  const sl1 = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  const r = must(await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl1, null, { end_time: '20:00', break_minutes: 45 })), 'time change')
  const a2 = await shiftById(sa, D), b2 = await shiftById(sb, D)
  ok('#118 枠の休憩を変えても、A の休憩は30分のまま。B（枠の値のまま）は45分になる', a2.break_minutes === 30 && b2.break_minutes === 45, { a2: a2.break_minutes, b2: b2.break_minutes })
  ok('#118 手動の金額の A は、終了時刻の変更に合わせて数量が 9.5h・金額 9500 になる', a2.end_time === '20:00' && Number(a2.bill_qty) === 9.5 && Number(a2.unit_price) === 9500 && a2.price_locked === 1, { a2, r })
  // 数量を手で直したシフトは変えない
  must(await admin.put(`/api/admin/shifts/${sa}/price`, { bill_unit_type: 'hourly', bill_rate: 1000, bill_qty: 3 }), 'price qty')
  const sl2 = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  const r2 = must(await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl2, null, { end_time: '21:00' })), 'time change 2')
  const a3 = await shiftById(sa, D)
  ok('#118 数量を手で直したシフトは数量を変えず、locked_kept で知らせる', Number(a3.bill_qty) === 3 && r2.locked_kept === 1, { a3, r2 })
}

// ---------- #118 確定済みのシフトの役割名は変えない ----------
{
  const P = addDays(today, -3)
  const sl = await newSlot(pid, P)
  const st = await newStaff('ROLE')
  const [sid] = await assign(sl.roles[0].slot_role_id, [st.staff_id])
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [sid], force: true })
  const roles = sl.roles.map(r => ({ slot_role_id: r.slot_role_id, role_name: '名前を変えた役割', headcount: r.headcount }))
  must(await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl, roles)), 'rename role')
  const s1 = await shiftById(sid, P)
  ok('#118 役割名を変えても、確定済みのシフトの役割名は変わらない', cf.status === 200 && s1.role === '販売', { cf: cf.status, role: s1.role })
}

// ---------- #57 報告済み・確定済みのシフトは動かさない ----------
{
  const P = addDays(today, -2), P2 = addDays(today, -1)
  const sl = await newSlot(pid, P)
  const rep = await newStaff('REP'), mov = await newStaff('MOV'), fix = await newStaff('FIX')
  const [sRep] = await assign(sl.roles[0].slot_role_id, [rep.staff_id])
  const [sMov] = await assign(sl.roles[0].slot_role_id, [mov.staff_id])
  const [sFix] = await assign(sl.roles[0].slot_role_id, [fix.staff_id])
  let px = null
  for (const t of ['check_in', 'work_start', 'check_out', 'work_end']) {
    px = await admin.post(`/api/admin/shifts/${sRep}/proxy-attendance`, { report_types: [t], time: '10:00' })
    if (px.status === 200) break
  }
  const cf = await admin.post('/api/admin/settlement/confirm', { shift_ids: [sFix], force: true })
  ok('#57 準備: 報告の代理入力と確定', px.status === 200 && cf.status === 200, { px, cf })
  const r = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl, null, { work_date: P2 }))
  ok('#57 報告済み・確定済みのシフトがある枠の日付の変更は確認（409 need_force・detach 2件）', r.status === 409 && r.data.need_force && r.data.detach.length === 2, r)
  const still = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  ok('#57 確認の前は枠の日付を変えない', still.slot.work_date === P, still.slot)
  const r2 = must(await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(sl, null, { work_date: P2, force: true })), 'force')
  const all = await shiftsOf(P, P2)
  const gRep = all.find(s => s.shift_id === sRep), gMov = all.find(s => s.shift_id === sMov), gFix = all.find(s => s.shift_id === sFix)
  ok('#57 報告のないシフトは新しい日付へ動く', gMov.work_date === P2 && gMov.slot_id === sl.slot.slot_id, gMov)
  ok('#57 報告済みのシフトは元の日付のまま枠なしになる', gRep.work_date === P && gRep.slot_id == null && gRep.slot_role_id == null, gRep)
  ok('#57 確定済みのシフトは元の日付のまま枠なしになる', gFix.work_date === P && gFix.slot_id == null, gFix)
  ok('#57 応答の detached は 2', r2.detached === 2, r2)
}

// ---------- #117 日時を変えるときの重複の確認 ----------
{
  const st = await newStaff('DBL')
  const x = await newSlot(pid, D, { start: '07:00', end: '09:00' })
  const y = await newSlot(pid, D, { start: '09:30', end: '11:00' })
  const [sx] = await assign(x.roles[0].slot_role_id, [st.staff_id])
  await assign(y.roles[0].slot_role_id, [st.staff_id])
  const r = await admin.put('/api/admin/shift-slots/' + x.slot.slot_id, slotBody(x, null, { end_time: '10:00' }))
  ok('#117 時間を変えて重なると警告（409 need_force）', r.status === 409 && r.data.need_force && r.data.warnings.some(w => w.includes('同じ時間帯')), r)
  ok('#117 確認の前は時刻を変えない', (await shiftById(sx, D)).end_time === '09:00')
  must(await admin.put('/api/admin/shift-slots/' + x.slot.slot_id, slotBody(x, null, { end_time: '10:00', force: true })), 'force')
  ok('#117 force で保存できる', (await shiftById(sx, D)).end_time === '10:00')
  // 日時を変えない保存（メモだけ）は確認しない
  const x2 = must(await admin.get('/api/admin/shift-slots/' + x.slot.slot_id), 'slot get')
  const r3 = await admin.put('/api/admin/shift-slots/' + x.slot.slot_id, slotBody(x2, null, { memo: 'メモだけ' }))
  ok('#117 日時を変えない保存は確認なしで通る', r3.status === 200, r3)
}

// ---------- #137 調整額を空欄で消す ----------
{
  const sl = await newSlot(pid, D, { start: '20:00', end: '22:00' })
  const st = await newStaff('ADJ')
  const [sid] = await assign(sl.roles[0].slot_role_id, [st.staff_id])
  must(await admin.put(`/api/admin/shifts/${sid}/price`, { bill_adjust: 5000, pay_adjust: 3000, adjust_note: '手当' }), 'adj set')
  const s1 = await shiftById(sid, D)
  must(await admin.put(`/api/admin/shifts/${sid}/price`, { bill_adjust: '', pay_adjust: '', adjust_note: '' }), 'adj clear')
  const s2 = await shiftById(sid, D)
  ok('#137 調整額を入れて保存できる', s1.bill_adjust === 5000 && s1.pay_adjust === 3000, s1)
  ok('#137 空欄で保存すると調整額・内容が消える', !s2.bill_adjust && !s2.pay_adjust && s2.adjust_note == null, s2)
  must(await admin.put(`/api/admin/shifts/${sid}/price`, { bill_adjust: 100 }), 'adj partial')
  must(await admin.put(`/api/admin/shifts/${sid}/price`, { bill_rate: 20000 }), 'no adj')
  const s3 = await shiftById(sid, D)
  ok('#137 調整額を送らない保存では調整額を変えない', s3.bill_adjust === 100, s3)
}

// ---------- #130 #142 #492 開催場所 ----------
{
  const siteId = must(await admin.post('/api/admin/sites', { site_name: `${PFX}会場`, address: '東京都', memo: 'm' }), 'site').site_id
  const site2 = must(await admin.post('/api/admin/sites', { site_name: `${PFX}別会場` }), 'site2').site_id
  const getSite = async (id) => must(await admin.get('/api/admin/sites'), 'sites').sites.find(s => s.site_id === id)
  const sl = await newSlot(pid, D, { start: '12:00', end: '13:00', site_id: siteId })
  const st = await newStaff('SITE')
  const [sid] = await assign(sl.roles[0].slot_role_id, [st.staff_id])
  ok('準備: シフトに開催場所名が写っている', (await shiftById(sid, D)).location === `${PFX}会場`)
  // #142 名前の変更をシフトに反映
  must(await admin.put('/api/admin/sites/' + siteId, { site_name: `${PFX}新会場` }), 'rename')
  const sh = await shiftById(sid, D)
  const slotNow = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  ok('#142 名前を変えると、今後のシフトと枠の場所名も新しい名前になる', sh.location === `${PFX}新会場` && slotNow.slot.location === `${PFX}新会場`, { sh: sh.location, slot: slotNow.slot.location })
  // #130 無効の場所の名前を変えても有効に戻らない。送らない項目は変えない
  must(await admin.put('/api/admin/sites/' + siteId, { status: 'inactive' }), 'inactive')
  must(await admin.put('/api/admin/sites/' + siteId, { site_name: `${PFX}新会場2` }), 'rename inactive')
  const s1 = await getSite(siteId)
  ok('#130 無効の場所の名前を変えても無効のまま。住所・メモも残る', s1.status === 'inactive' && s1.site_name === `${PFX}新会場2` && s1.address === '東京都' && s1.memo === 'm', s1)
  must(await admin.put('/api/admin/sites/' + siteId, { address: '' }), 'clear address')
  ok('#130 住所を空欄で保存すると消える', (await getSite(siteId)).address == null)
  const bad = await admin.put('/api/admin/sites/' + siteId, { site_name: '  ' })
  ok('#130 空の名前は 400', bad.status === 400, bad)
  // #492 無効の場所の枠を、場所を送らずに保存しても外れない／同じ場所を送り直しても通る
  const r1 = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, { memo: 'メモだけ変更' })
  const after1 = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  ok('#492 site_id を送らない保存では開催場所を外さない', r1.status === 200 && after1.slot.site_id === siteId && (await shiftById(sid, D)).site_id === siteId, { r1, slot: after1.slot })
  const r2 = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(after1, null, { memo: '再保存' }))
  ok('#492 無効の場所のまま保存し直せる', r2.status === 200 && must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'g').slot.site_id === siteId, r2)
  // 別の無効の場所へは変えられない
  must(await admin.put('/api/admin/sites/' + site2, { status: 'inactive' }), 'inactive2')
  const r3 = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, slotBody(after1, null, { site_id: site2 }))
  ok('#492 別の無効の場所への変更は 400', r3.status === 400, r3)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
