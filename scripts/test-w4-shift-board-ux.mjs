// シフトボードの使い勝手（w4-shift-board-ux: #258 #388 #390 #406 #407 #468 #551、持ち越し #65 #142 #456）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8825 node scripts/test-w4-shift-board-ux.mjs
import { readFileSync } from 'node:fs'
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

const PFX = 'SU' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newSlot(pid, date, opt = {}) {
  const body = { project_id: pid, dates: [date], start_time: opt.start || '10:00', end_time: opt.end || '19:00', break_minutes: 60, site_id: opt.site_id || null, roles: [{ role_name: '販売', headcount: opt.headcount || 1 }] }
  const r = must(await admin.post('/api/admin/shift-slots', body), 'slot')
  return must(await admin.get('/api/admin/shift-slots/' + r.slot_ids[0]), 'slot get')
}
const assign = (roleId, staffIds, extra = {}) => admin.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: staffIds, ...extra })
const shiftsOf = async (from, to = from) => must(await admin.get(`/api/admin/shifts?from=${from}&to=${to}`), 'shifts').shifts
const hasCap = (r) => r.status === 409 && r.data?.need_force && (r.data.warnings || []).some(w => w.includes('定員（1名）を超えます'))

const pid = await newProject(`${PFX}-案件`)
const D = addDays(today, 12)

// ---------- #407 割り当て・移動で必要人数を超えたら警告する ----------
{
  const sl = await newSlot(pid, D, { start: '08:00', end: '12:00' })
  const rid = sl.roles[0].slot_role_id
  const a = await newStaff('CA'), b = await newStaff('CB'), c = await newStaff('CC')
  must(await assign(rid, [a.staff_id]), 'assign A')
  const r1 = await assign(rid, [b.staff_id])
  ok('#407 満員の役割に確定で割り当てると need_force と「定員（1名）を超えます」', hasCap(r1), r1)
  const r2 = await assign(rid, [b.staff_id], { status: 'requested' })
  ok('#407 希望（仮）で入れるときは定員の警告を出さない', r2.status === 200, r2)
  const r3 = await assign(rid, [c.staff_id], { force: true })
  ok('#407 force なら超過のまま割り当てられる', r3.status === 200 && r3.data.shift_ids.length === 1, r3)
  // 移動: 別の枠（必要1名・割り当て済み1名）へ確定のシフトを移す
  const sl2 = await newSlot(pid, D, { start: '13:00', end: '17:00' })
  const d = await newStaff('CD')
  must(await assign(sl2.roles[0].slot_role_id, [d.staff_id]), 'assign D')
  const [sc] = r3.data.shift_ids
  const m1 = await admin.post(`/api/admin/shifts/${sc}/move`, { slot_role_id: sl2.roles[0].slot_role_id })
  ok('#407 満員の役割へ確定のシフトを移動すると need_force と定員の警告', hasCap(m1), m1)
  const m2 = await admin.post(`/api/admin/shifts/${sc}/move`, { slot_role_id: sl2.roles[0].slot_role_id, force: true })
  ok('#407 force なら移動できる', m2.status === 200, m2)

  // #456 の残り: 必要人数を割り当て済みの人数より少なくするときは確かめる
  const sl3 = await newSlot(pid, D, { start: '18:00', end: '21:00', headcount: 2 })
  const e = await newStaff('CE'), f = await newStaff('CF')
  must(await assign(sl3.roles[0].slot_role_id, [e.staff_id, f.staff_id]), 'assign EF')
  const body = (hc, extra = {}) => ({ site_id: sl3.slot.site_id, location: sl3.slot.location, work_date: sl3.slot.work_date, start_time: sl3.slot.start_time, end_time: sl3.slot.end_time,
    break_minutes: sl3.slot.break_minutes, memo: sl3.slot.memo, roles: [{ slot_role_id: sl3.roles[0].slot_role_id, role_name: '販売', headcount: hc }], ...extra })
  const h1 = await admin.put('/api/admin/shift-slots/' + sl3.slot.slot_id, body(1))
  ok('#456 必要人数を割り当て済み（2名）より少なくすると need_force で確かめる', h1.status === 409 && h1.data.need_force && h1.data.warnings.some(w => w.includes('必要人数（1名）')), h1)
  const h2 = await admin.put('/api/admin/shift-slots/' + sl3.slot.slot_id, body(1, { force: true }))
  const after = must(await admin.get('/api/admin/shift-slots/' + sl3.slot.slot_id), 'slot get')
  ok('#456 force なら保存できる', h2.status === 200 && after.roles[0].headcount === 1, { h2, after })
  const h3 = await admin.put('/api/admin/shift-slots/' + sl3.slot.slot_id, body(3, { force: false }))
  ok('#456 人数を増やすときは確認しない', h3.status === 200, h3)
}

// ---------- #390 希望（仮）をまとめて確定 ----------
{
  const D2 = addDays(today, 13)
  const sl = await newSlot(pid, D2, { start: '09:00', end: '15:00', headcount: 3 })
  const rid = sl.roles[0].slot_role_id
  const g = await newStaff('RG'), h = await newStaff('RH')
  const req = must(await assign(rid, [g.staff_id, h.staff_id], { status: 'requested' }), 'assign requested').shift_ids
  const staffH = client(await login('sample', `${PFX}RH`))
  must(await staffH.post(`/api/staff/shifts/${req[1]}/reply`, { answer: 'ng', note: '用事' }), 'reply ng')
  const k = await newStaff('RK')
  const [conf] = must(await assign(rid, [k.staff_id]), 'assign confirmed').shift_ids
  const r1 = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: [...req, conf] })
  ok('#390 本人が「入れません」と返事したシフトを含むと need_force で警告する', r1.status === 409 && r1.data.warnings.some(w => w.includes('入れません')), r1)
  ok('#390 希望（仮）でないシフトは skipped に理由を付けて返す', r1.data?.skipped?.some(x => x.shift_id === conf && x.reason.includes('希望（仮）ではありません')), r1.data)
  const r2 = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: [...req, conf], force: true })
  const list = await shiftsOf(D2)
  ok('#390 force で2件を確定にする', r2.status === 200 && r2.data.confirmed === 2 && req.every(id => list.find(s => s.shift_id === id)?.status === 'confirmed'), { r2, list: list.filter(s => req.includes(s.shift_id)).map(s => s.status) })
  const r3 = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: req })
  ok('#390 確定済みを送り直しても変えない（confirmed 0・skipped 2）', r3.status === 200 && r3.data.confirmed === 0 && r3.data.skipped.length === 2, r3)
  // 必要人数を超える分の確定は警告する
  const sl2 = await newSlot(pid, D2, { start: '16:00', end: '20:00', headcount: 1 })
  const m = await newStaff('RM'), n = await newStaff('RN')
  const req2 = must(await assign(sl2.roles[0].slot_role_id, [m.staff_id, n.staff_id], { status: 'requested' }), 'assign requested 2').shift_ids
  const r4 = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: req2 })
  ok('#390 #407 必要人数（1名）を超える確定は定員の警告を出す', hasCap(r4), r4)
  const r5 = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: [] })
  ok('#390 空のときは 400', r5.status === 400, r5)
  // 他社・存在しないシフトは対象にしない
  const r6 = await admin.post('/api/admin/shifts/confirm-requested', { shift_ids: [99999999] })
  ok('#390 見つからないシフトは何もしない', r6.status === 200 && r6.data.confirmed === 0, r6)
}

// ---------- #406 開催場所の住所・メモ・位置の編集、#142 繰り返し登録の場所名 ----------
{
  const cid = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-クライアント` }), 'client').client_id
  const siteId = must(await admin.post('/api/admin/sites', { client_id: cid, site_name: `${PFX}会場`, address: '東京都' }), 'site').site_id
  const get = async () => must(await admin.get('/api/admin/sites?client_id=' + cid), 'sites').sites.find(s => s.site_id === siteId)
  must(await admin.put('/api/admin/sites/' + siteId, { address: '東京都千代田区', memo: '搬入口は裏側', lat: 35.681236, lng: '139.767125' }), 'edit')
  const s1 = await get()
  ok('#406 住所・メモ・緯度経度を保存できる', s1.address === '東京都千代田区' && s1.memo === '搬入口は裏側' && Math.abs(s1.lat - 35.681236) < 1e-6 && Math.abs(s1.lng - 139.767125) < 1e-6, s1)
  const bad1 = await admin.put('/api/admin/sites/' + siteId, { lat: 35.6, lng: '' })
  const bad2 = await admin.put('/api/admin/sites/' + siteId, { lat: 95, lng: 139 })
  const bad3 = await admin.put('/api/admin/sites/' + siteId, { lat: 'abc', lng: 139 })
  ok('#406 片方だけ・範囲外・数値でない位置は 400', bad1.status === 400 && bad2.status === 400 && bad3.status === 400, [bad1.status, bad2.status, bad3.status])
  must(await admin.put('/api/admin/sites/' + siteId, { site_name: `${PFX}会場` }), 'name only')
  const s2 = await get()
  ok('#406 送らなかった項目（住所・メモ・位置）は変えない', s2.memo === '搬入口は裏側' && s2.lat != null, s2)
  must(await admin.put('/api/admin/sites/' + siteId, { memo: '', lat: '', lng: '' }), 'clear')
  const s3 = await get()
  ok('#406 空欄で保存すると、メモと位置を消す', s3.memo == null && s3.lat == null && s3.lng == null, s3)
  const badPost = await admin.post('/api/admin/sites', { client_id: cid, site_name: `${PFX}会場X`, lat: 100, lng: 0 })
  ok('#406 追加でも範囲外の位置は 400', badPost.status === 400, badPost)

  // #142: 名前を変えたら、繰り返し登録の場所名も変わる
  const pid2 = await newProject(`${PFX}-繰り返し`)
  const from = addDays(today, 20)
  must(await admin.post('/api/admin/slot-patterns', { project_id: pid2, site_id: siteId, weekdays: [0, 1, 2, 3, 4, 5, 6], date_from: from, date_to: addDays(from, 1),
    start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 1 }] }), 'pattern')
  must(await admin.put('/api/admin/sites/' + siteId, { site_name: `${PFX}新会場` }), 'rename')
  const pats = must(await admin.get('/api/admin/slot-patterns?project_id=' + pid2), 'patterns').patterns
  ok('#142 開催場所の名前を変えると、繰り返し登録の場所名も新しい名前になる', pats.length === 1 && pats[0].location === `${PFX}新会場`, pats.map(p => p.location))
}

// ---------- #388 単価ルールの編集（PUT） ----------
{
  const r = must(await admin.post('/api/admin/rate-rules', { project_id: pid, role_name: '販売', bill_rate: 1200, bill_unit_type: 'hourly', memo: '経験者加算' }), 'rule')
  const e = await admin.put('/api/admin/rate-rules/' + r.rule_id, { project_id: pid, site_id: null, role_name: '販売', staff_id: null, bill_unit_type: 'hourly', bill_rate: 1300, memo: '経験者加算（改定）' })
  const rule = must(await admin.get('/api/admin/rate-rules?project_id=' + pid), 'rules').rules.find(x => x.rule_id === r.rule_id)
  ok('#388 単価ルールを編集できる（単価とメモ）', e.status === 200 && rule.bill_rate === 1300 && rule.memo === '経験者加算（改定）' && rule.role_name === '販売', { e, rule })
}

// ---------- #65 の残り: 未対応の応募がある役割を枠の編集で消すときは確かめる ----------
{
  const D3 = addDays(today, 14)
  const pid3 = await newProject(`${PFX}-応募`)
  const r = must(await admin.post('/api/admin/shift-slots', { project_id: pid3, dates: [D3], start_time: '10:00', end_time: '18:00', break_minutes: 60,
    roles: [{ role_name: '販売', headcount: 1 }, { role_name: '設営', headcount: 1 }] }), 'slot 2 roles')
  const sl = must(await admin.get('/api/admin/shift-slots/' + r.slot_ids[0]), 'slot get')
  const keep = sl.roles.find(x => x.role_name === '販売'), drop = sl.roles.find(x => x.role_name === '設営')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid3], date_from: D3, date_to: D3, allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'page')
  await newStaff('AP')
  const sp = client(await login('sample', `${PFX}AP`))
  must(await sp.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [drop.slot_role_id] }), 'staff apply')
  const body = (extra = {}) => ({ work_date: D3, start_time: '10:00', end_time: '18:00', roles: [{ slot_role_id: keep.slot_role_id, role_name: '販売', headcount: 1 }, { slot_role_id: drop.slot_role_id, role_name: '設営', headcount: 1, _delete: true }], ...extra })
  const p1 = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, body())
  ok('#65 未対応の応募がある役割を消すと need_force で件数を出す', p1.status === 409 && p1.data.need_force && p1.data.warnings.some(w => w.includes('設営') && w.includes('未対応の応募が1件')), p1)
  const p2 = await admin.put('/api/admin/shift-slots/' + sl.slot.slot_id, body({ force: true }))
  const after = must(await admin.get('/api/admin/shift-slots/' + sl.slot.slot_id), 'slot get')
  ok('#65 force なら役割を消せる', p2.status === 200 && after.roles.length === 1 && after.roles[0].role_name === '販売', { p2, roles: after.roles })
}

// ---------- 画面（静的な確認） ----------
{
  const sb = readFileSync(new URL('../public/static/shift-board.js', import.meta.url), 'utf8')
  const adm = readFileSync(new URL('../public/static/admin.js', import.meta.url), 'utf8')
  ok('#258 人ごと表示の稼働は、確定・代打のある日数で数える', /r\.workDays = cs\.filter\(list => list\.some\(isActive\)\)\.length/.test(sb))
  ok('#468 人ごと表示に、割り当てられるスタッフ全員を行として出す', /for \(const s of \(MASTER && MASTER\.staff\) \|\| \[\]\) byStaff\.set/.test(sb) && /personIdleOnly/.test(sb) && /personSort === 'fewest'/.test(sb))
  ok('#390 希望（仮）のまとめて確定は data-action で開く', /data-action="boardConfirmRequested"/.test(sb) && /\/api\/admin\/shifts\/confirm-requested/.test(sb))
  ok('#388 単価ルールの編集ボタンと PUT、案件詳細のメモ', /data-action="editRule"/.test(sb) && /axios\.put\('\/api\/admin\/rate-rules\/' \+ Number\(ctx\.rule_id\)/.test(sb) && (sb.match(/\$\{ruleMemo\(r\)\}/g) || []).length === 2)
  ok('#406 開催場所の編集は data-action で開き、位置・メモを送る', /data-action="editSite"/.test(sb) && /memo: document\.getElementById\('se-memo'\)\.value, lat, lng/.test(sb))
  ok('#65 枠の削除の確認に、未対応の応募の件数を出す', /未対応の応募が\$\{applicants\}件あります/.test(sb))
  ok('#551 シフト管理の操作の後は、表示中の週を出し直す', /refreshShiftWeek\(\)/.test(adm) && /refreshShiftWeek\(date\)/.test(adm) && !/toast\('シフトを(更新|削除)しました'\); renderShifts\(\)/.test(adm))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
