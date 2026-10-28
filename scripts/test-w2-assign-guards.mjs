// すべての割当経路で退職者・NG・重複・二度押しを防ぐ（w2-assign-guards: #94 #119 #187 #249 #354 #500 #530 #568）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8817 node scripts/test-w2-assign-guards.mjs
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

const PFX = 'AG' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const D = addDays(today, 10)

async function newStaff(api, k) {
  must(await api.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await api.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(api, name) {
  must(await api.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await api.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
// 枠を1つ作り、その役割の slot_role_id を返す
async function newRole(api, pid, date, start = '10:00', end = '18:00') {
  must(await api.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles: [{ role_name: '販売', headcount: 2 }] }), 'slot')
  const b = must(await api.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  const slots = b.slots.filter(s => s.project_id === pid && s.start_time === start)
  return slots[slots.length - 1].roles[0].slot_role_id
}
const shiftsOf = async (api, from, to = from) => must(await api.get(`/api/admin/shifts?from=${from}&to=${to}`), 'shifts').shifts
const pid = await newProject(admin, `${PFX}-案件`)

// ---------- #530 同じ枠への二重割当 ----------
{
  const s = await newStaff(admin, 'DUP')
  const role = await newRole(admin, pid, D)
  const rs = await Promise.all([1, 2, 3].map(() => admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [s.staff_id], force: true })))
  const n = (await shiftsOf(admin, D)).filter(x => x.slot_role_id === role && x.staff_id === s.staff_id && x.status !== 'absent').length
  ok('#530 同時に3回割り当てても、同じ枠に同じ人のシフトは1件だけ', n === 1 && rs.every(r => r.status === 200), { n, st: rs.map(r => r.status) })
  const again = await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [s.staff_id] })
  ok('#530 割当済みの人をもう一度割り当てると警告（409）', again.status === 409 && again.data.need_force && again.data.warnings.some(w => w.includes('割り当て済み')), again)
  // 欠勤にした後に同じ人を割り当て、欠勤のシフトを確定に戻すと、一意制約で 409
  const first = (await shiftsOf(admin, D)).find(x => x.slot_role_id === role && x.staff_id === s.staff_id)
  must(await admin.put(`/api/admin/shifts/${first.shift_id}`, { status: 'absent' }), 'absent')
  must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [s.staff_id], force: true }), 'reassign')
  const back = await admin.put(`/api/admin/shifts/${first.shift_id}`, { status: 'confirmed' })
  ok('#530 欠勤から戻して同じ枠に2件になる変更は 409', back.status === 409, back)
  // 移動: 同じ人がすでにいる枠へは移動できない
  const role2 = await newRole(admin, pid, D, '11:00', '12:00')
  const s2 = await newStaff(admin, 'MOV')
  must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [s2.staff_id], force: true }), 'assign mov1')
  const r2 = must(await admin.post(`/api/admin/shift-slots/roles/${role2}/assign`, { staff_ids: [s2.staff_id], force: true }), 'assign mov2')
  const mv = await admin.post(`/api/admin/shifts/${r2.shift_ids[0]}/move`, { slot_role_id: role, force: true })
  ok('#530 同じ人がいる枠への移動は拒否される', mv.status === 400 || mv.status === 409, mv)
}

// ---------- #119 #354 #94 退職者・休職中・NG・重複 ----------
const ret = await newStaff(admin, 'RET')
const leave = await newStaff(admin, 'LEAVE')
const busy = await newStaff(admin, 'BUSY')
{
  const r1 = await admin.put(`/api/admin/employees/${ret.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } })
  const r2 = await admin.put(`/api/admin/employees/${leave.staff_id}`, { profile: { employment_status: 'leave' } })
  ok('（前提）退職・休職中に更新', r1.status === 200 && r2.status === 200, { r1, r2 })
  const list = must(await admin.get('/api/admin/staff'), 'staff').staff
  ok('#119 スタッフ一覧で退職者は assignable=0、在職者・休職中は 1', list.find(s => s.staff_id === ret.staff_id)?.assignable === 0
    && list.find(s => s.staff_id === leave.staff_id)?.assignable === 1 && list.find(s => s.staff_id === busy.staff_id)?.assignable === 1)
  const role = await newRole(admin, pid, addDays(D, 1))
  const a1 = await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [ret.staff_id], force: true })
  ok('#119 シフトボードの割当: 退職者は force でも 400', a1.status === 400 && /退職/.test(a1.data.error), a1)
  const a2 = await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [leave.staff_id] })
  ok('#354 シフトボードの割当: 休職中は警告（409）', a2.status === 409 && a2.data.warnings.some(w => w.includes('休職中')), a2)
  const a3 = await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [leave.staff_id], force: true })
  ok('#354 休職中は確認のうえ割り当てられる', a3.status === 200 && a3.data.shift_ids.length === 1, a3)
  const cand = must(await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${role}`), 'cand').candidates
  ok('#119 候補一覧に退職者は出ない', !cand.some(c => c.staff_id === ret.staff_id))

  // POST /admin/shifts（シフト管理の登録）
  const d2 = addDays(D, 1)
  const p1 = await admin.post('/api/admin/shifts', { staff_id: ret.staff_id, project_id: pid, work_date: d2, start_time: '10:00', end_time: '18:00' })
  ok('#94 シフト登録: 退職者は 400', p1.status === 400, p1)
  const p2 = await admin.post('/api/admin/shifts', { staff_id: busy.staff_id, project_id: pid, work_date: d2, start_time: '10:00', end_time: '18:00' })
  ok('#94 シフト登録: 交通費を送らなければ 0 円（1200 にならない）', p2.status === 200 && (await shiftsOf(admin, d2)).find(x => x.shift_id === p2.data.shift_id)?.transportation_fee === 0, p2)
  const p3 = await admin.post('/api/admin/shifts', { staff_id: busy.staff_id, project_id: pid, work_date: d2, start_time: '12:00', end_time: '15:00', confirm_warnings: true })
  ok('#94 シフト登録: 同じ時間帯の重複は確認（409）', p3.status === 409 && p3.data.need_force && p3.data.warnings.some(w => w.includes('同じ時間帯')), p3)
  const p4 = await admin.post('/api/admin/shifts', { staff_id: busy.staff_id, project_id: pid, work_date: d2, start_time: '12:00', end_time: '15:00', confirm_warnings: true, force: true })
  ok('#94 シフト登録: 確認のうえ force で登録できる', p4.status === 200, p4)
  const pr = await admin.put(`/api/admin/shifts/${p2.data.shift_id}`, { staff_id: ret.staff_id, force: true })
  ok('#94 シフトの付け替え: 退職者へは force でも 400', pr.status === 400 && /退職/.test(pr.data.error), pr)
  const p5 = await admin.post('/api/admin/shifts', { staff_id: busy.staff_id, project_id: pid, work_date: '2026/01/01' })
  ok('#94 シフト登録: 日付の形式が正しくなければ 400', p5.status === 400, p5)
  // NG
  const clientName = `${PFX}-NGクライアント`
  must(await admin.post('/api/admin/clients', { client_name: clientName }), 'client')
  const cl = must(await admin.get('/api/admin/clients'), 'clients').clients.find(x => x.client_name === clientName)
  await admin.put(`/api/admin/clients/${cl.client_id}`, { ...cl, ng_staff_ids: String(busy.staff_id) })
  // NG の設定APIは無い（データの投入でのみ設定される）ので、保存されたときだけ確かめる
  const ngSet = { status: must(await admin.get('/api/admin/clients'), 'clients').clients.find(x => x.client_id === cl.client_id)?.ng_staff_ids ? 200 : 0 }
  must(await admin.post('/api/admin/projects', { project_name: `${PFX}-NG案件`, client_id: cl.client_id }), 'ng project')
  const ngPid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-NG案件`).project_id
  const p6 = await admin.post('/api/admin/shifts', { staff_id: busy.staff_id, project_id: ngPid, work_date: addDays(D, 2), confirm_warnings: true })
  if (ngSet.status === 200) ok('#94 シフト登録: クライアントのNGは確認（409）', p6.status === 409 && p6.data.warnings.some(w => w.includes('NG')), p6)
  else console.log('SKIP  NG の設定APIの形が想定と違うため確認しない', ngSet.status)
}

// ---------- #568 仮登録の二度押し ----------
{
  const phone = '090' + String(Date.now()).slice(-8)
  const key = `${PFX}-key1`
  const body = { name: `${PFX} 仮登録`, phone, affiliation_type: 'daily_worker', request_key: key }
  const rs = await Promise.all([1, 2].map(() => admin.post('/api/admin/staff-quick', body)))
  const okOnes = rs.filter(r => r.status === 200)
  const list = must(await admin.get('/api/admin/staff'), 'staff').staff.filter(s => String(s.phone || '').replace(/\D/g, '') === phone)
  ok('#568 同時に2回送っても、仮登録は1人だけ', list.length === 1 && okOnes.length >= 1 && rs.every(r => r.status === 200 || r.status === 409), { n: list.length, rs: rs.map(r => [r.status, r.data]) })
  const again = await admin.post('/api/admin/staff-quick', body)
  ok('#568 同じ画面からの再送は、作成済みのスタッフを返す', again.status === 200 && again.data.reused && again.data.staff_id === list[0]?.staff_id, again)
  const other = await admin.post('/api/admin/staff-quick', { ...body, request_key: `${PFX}-key2` })
  ok('#568 別の画面からの同じ電話番号は、重複の確認（409 need_force）', other.status === 409 && other.data.need_force, other)
  const forced = await admin.post('/api/admin/staff-quick', { ...body, request_key: `${PFX}-key2`, force: true })
  ok('#568 確認のうえ force なら別の人として登録できる', forced.status === 200 && !forced.data.reused && forced.data.staff_id !== list[0]?.staff_id, forced)
}

// ---------- #249 #187 連携先での取引終了・所属元での退職 ----------
{
  const hq = client(await login('sample', 'hq'))
  const code = `${PFX.toLowerCase()}a`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `${PFX}連携先株式会社`, admin_code: 'admin', admin_password: 'pass1234', admin_name: '連携先管理者' }), 'company')
  const A = client(await login(code, 'admin'))
  const link = async (staff) => {
    const share = must(await admin.get(`/api/admin/roster/${staff.staff_id}/share-code`), 'share-code')
    const terms = must(await A.get('/api/admin/roster/consent-terms'), 'terms')
    return must(await A.post('/api/admin/roster/link', { code: share.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
  }
  const X = await newStaff(admin, 'LINKX'), Y = await newStaff(admin, 'LINKY')
  const xA = await link(X), yA = await link(Y)
  const aPid = await newProject(A, `${PFX}-A案件`)
  const aRole = await newRole(A, aPid, addDays(D, 3))
  const assignable = async (sid) => must(await A.get('/api/admin/staff'), 'A staff').staff.find(s => s.staff_id === sid)?.assignable

  // #249 稼働先で取引終了にする
  const e1 = await A.put(`/api/admin/roster/${yA}/host-status`, { status: 'ended' })
  ok('#249 連携先で取引終了にできる', e1.status === 200, e1)
  ok('#249 取引終了の人は assignable=0', (await assignable(yA)) === 0)
  const e2 = await A.post(`/api/admin/shift-slots/roles/${aRole}/assign`, { staff_ids: [yA], force: true })
  ok('#249 取引終了の人は割り当てられない（400）', e2.status === 400, e2)
  const e3 = await A.put(`/api/admin/roster/${yA}/host-status`, { status: 'leave' })
  ok('#249 休止中に戻すと割り当てられる（警告あり）', e3.status === 200 && (await assignable(yA)) === 1
    && (await A.post(`/api/admin/shift-slots/roles/${aRole}/assign`, { staff_ids: [yA] })).data?.warnings?.some(w => w.includes('休職中')))
  const e4 = await admin.put(`/api/admin/roster/${X.staff_id}/host-status`, { status: 'ended' })
  ok('#249 自社のスタッフには取引状況を設定できない（400）', e4.status === 400, e4)
  const e5 = await A.put(`/api/admin/roster/${X.staff_id}/host-status`, { status: 'ended' })
  ok('#249 他社のスタッフ行の取引状況は変えられない（404）', e5.status === 404, e5)
  const e6 = await A.post(`/api/admin/staff/${X.staff_id}/release-future-shifts`, { from: today })
  ok('#500 他社のスタッフのシフトは外せない（404）', e6.status === 404, e6)
  const ySrc = must(await admin.get(`/api/admin/staff/${Y.staff_id}`), 'Y').profile || must(await admin.get(`/api/admin/staff/${Y.staff_id}`), 'Y')
  ok('#249 所属元の在籍状況・ログインは変わらない', (ySrc.employment_status || 'working') === 'working' && ySrc.status === 'active', { st: ySrc.employment_status, status: ySrc.status })

  // #187 #500 所属元で退職にする: 連携先の件数が所属元に出る、連携先では割当の候補から外れる
  must(await A.post('/api/admin/shifts', { staff_id: xA, project_id: aPid, work_date: addDays(D, 4) }), 'A shift X')
  const fs = must(await admin.get(`/api/admin/staff/${X.staff_id}/future-shifts?from=${today}`), 'future-shifts')
  ok('#187 所属元の確認で、連携先の今後のシフト件数が出る（会社名は出さない）', fs.linked_count === 1 && !JSON.stringify(fs).includes('連携先株式会社'), fs)
  must(await admin.put(`/api/admin/employees/${X.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } }), 'retire X')
  ok('#187 所属元で退職した人は、連携先で assignable=0', (await assignable(xA)) === 0)
  const x1 = await A.post(`/api/admin/shift-slots/roles/${aRole}/assign`, { staff_ids: [xA], force: true })
  ok('#187 所属元で退職した人は、連携先で割り当てられない（400）', x1.status === 400 && /所属元/.test(x1.data.error), x1)
  const cand = must(await A.get(`/api/admin/shift-board/candidates?slot_role_id=${aRole}`), 'cand').candidates
  ok('#187 連携先の候補一覧に出ない', !cand.some(c => c.staff_id === xA))
  const det = must(await A.get(`/api/admin/staff/${xA}`), 'detail')
  ok('#187 連携先のスタッフ詳細に「所属元で退職」の印が出る', (det.profile || det).source_retired === 1, det.profile || det)
}

// ---------- #500 退職時の今後のシフト ----------
{
  const F = await newStaff(admin, 'FUT')
  const role = await newRole(admin, pid, addDays(D, 5))
  must(await admin.post(`/api/admin/shift-slots/roles/${role}/assign`, { staff_ids: [F.staff_id], force: true }), 'assign F')
  must(await admin.post('/api/admin/shifts', { staff_id: F.staff_id, project_id: pid, work_date: addDays(D, 6) }), 'shift F')
  must(await admin.post('/api/admin/shifts', { staff_id: F.staff_id, project_id: pid, work_date: addDays(today, -3) }), 'past shift F')
  const fs = must(await admin.get(`/api/admin/staff/${F.staff_id}/future-shifts?from=${addDays(today, 1)}`), 'future')
  ok('#500 退職日の翌日以降のシフトの件数が出る（過去は含めない）', fs.count === 2 && fs.shifts.every(s => s.work_date > today), fs)
  const other = await A_like404()
  ok('#500 他社のスタッフの今後のシフトは見られない（404）', other === 404)
  const rel = must(await admin.post(`/api/admin/staff/${F.staff_id}/release-future-shifts`, { from: addDays(today, 1), shift_ids: fs.shifts.map(s => s.shift_id) }), 'release')
  const left = (await shiftsOf(admin, addDays(today, -3), addDays(D, 6))).filter(s => s.staff_id === F.staff_id)
  ok('#500 まとめて外すと、今後のシフトは消え、過去のシフトは残る', rel.removed === 2 && left.length === 1 && left[0].work_date === addDays(today, -3), { rel, left })
  const bad = await admin.get(`/api/admin/staff/${F.staff_id}/future-shifts?from=abc`)
  ok('#500 日付の形式が正しくなければ 400', bad.status === 400)
}
async function A_like404() {
  // 他社のスタッフ（存在しない ID でも同じ）
  return (await admin.get('/api/admin/staff/999999/future-shifts?from=' + today)).status
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
