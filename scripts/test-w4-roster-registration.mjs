// スタッフの新規登録・本登録・統合の残り（w4-roster-registration: #223 #251 #356 #424 #461 #506）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8815 node scripts/test-w4-roster-registration.mjs
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'RR' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '080' + String(Date.now() % 100000000 + (phoneSeq++)).padStart(8, '0').slice(-8)

const admin = client(await login('sample', 'admin'))
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const lifecycle = async (sid) => must(await admin.get(`/api/admin/staff/${sid}/lifecycle`), 'lifecycle ' + sid)
const roster = (route, extra) => admin.post('/api/admin/roster', { route, gender: 'female', ...extra })

// ---------- #424 スタッフ番号の自動採番 ----------
{
  const n1 = must(await admin.get('/api/admin/roster/next-code'), 'next-code')
  ok('#424 next-code: 空いている番号を返す', typeof n1.code === 'string' && n1.code.length > 0, n1)
  const r = await roster('employee', { name: `${PFX} 採番 一郎`, user_code: n1.code, password: 'pass1234' })
  ok('#424 返された番号で②の登録ができる', r.status === 200, r)
  const n2 = must(await admin.get('/api/admin/roster/next-code'), 'next-code2')
  ok('#424 登録の後は次の番号を返す（使った番号は返さない）', n2.code !== n1.code, { n1, n2 })
  const dup = await roster('employee', { name: `${PFX} 採番 二郎`, user_code: n1.code, password: 'pass1234' })
  ok('#424 使われている番号で登録すると 409 と空いている番号を返す', dup.status === 409 && dup.data.suggested_code && dup.data.suggested_code !== n1.code, dup)
  const again = await roster('employee', { name: `${PFX} 採番 二郎`, user_code: dup.data.suggested_code, password: 'pass1234' })
  ok('#424 返された空き番号で登録し直せる', again.status === 200, again)
  const legacyDup = await admin.post('/api/admin/staff', { user_code: n1.code, name: `${PFX} 旧登録`, password: 'pass1234' })
  ok('#424 旧スタッフ登録でも、重複時に空いている番号を返す', legacyDup.status === 409 && !!legacyDup.data.suggested_code, legacyDup)
}

// ---------- #223 新規追加で同じ人を確認する ----------
let partnerA, partnerB
{
  const phone = newPhone()
  const a = await roster('partner', { name: `${PFX} 重複 花子`, phone, new_partner_name: `${PFX}取引先` })
  ok('#223 1人目は登録できる', a.status === 200, a)
  partnerA = a.data.staff_id
  const b = await roster('partner', { name: `${PFX} 別名 花子`, phone: phone.replace(/^(\d{3})(\d{4})/, '$1-$2-'), new_partner_name: `${PFX}取引先` })
  ok('#223 電話番号が同じ（ハイフンあり）なら 409 need_force と既存のスタッフを返す',
    b.status === 409 && b.data.need_force && b.data.matches.some(m => m.staff_id === partnerA && m.reasons.includes('電話番号が同じ')), b)
  const c = await roster('partner', { name: `${PFX} 別名 花子`, phone, new_partner_name: `${PFX}取引先`, force: true })
  ok('#223 force で別の人として登録できる', c.status === 200, c)
  partnerB = c.data.staff_id

  const dob = '1990-05-06'
  const s1 = await roster('skillsheet', { name: `${PFX} 生年 太郎`, date_of_birth: dob })
  const s2 = await roster('skillsheet', { name: `${PFX}　生年太郎`, date_of_birth: dob })
  ok('#223 氏名（空白の違いは無視）と生年月日が同じなら確認を求める', s1.status === 200 && s2.status === 409 && s2.data.matches.some(m => m.reasons.includes('氏名と生年月日が同じ')), { s1, s2 })
  const s3 = await roster('skillsheet', { name: `${PFX} 生年 太郎`, date_of_birth: '1990-05-07' })
  ok('#223 生年月日が違えば同名でも登録できる', s3.status === 200, s3)

  const lp = newPhone()
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}L1`, name: `${PFX} 旧 一郎`, password: 'pass1234', phone: lp }), 'legacy 1')
  const l2 = await admin.post('/api/admin/staff', { user_code: `${PFX}L2`, name: `${PFX} 旧 二郎`, password: 'pass1234', phone: lp })
  ok('#223 旧スタッフ登録でも電話番号の重複を確認する', l2.status === 409 && l2.data.need_force, l2)
}

// ---------- #223 シフトのない重複登録を統合できる ----------
{
  let lc = await lifecycle(partnerB)
  ok('#223 シフトのない本登録の行は統合元にできる（can_merge）', lc.can_merge === true && lc.is_provisional === false, lc)
  const cands = must(await admin.get(`/api/admin/staff/${partnerB}/merge-candidates`), 'cands')
  ok('#223 統合候補に同じ電話番号の同じ区分の人が出る', cands.candidates.some(r => r.staff_id === partnerA), cands)
  // 区分が違う人には統合できない
  const emp = must(await admin.get('/api/admin/staff'), 'staff').staff.find(s => s.affiliation_type === 'own_employee' && !s.merged_into_staff_id && s.status === 'active')
  const diff = await admin.post(`/api/admin/staff/${partnerB}/merge`, { target_staff_id: emp.staff_id, dry_run: true })
  ok('#223 本登録の行は、区分が違うスタッフには統合できない', diff.status === 400, diff)
  const dry = await admin.post(`/api/admin/staff/${partnerB}/merge`, { target_staff_id: partnerA, dry_run: true })
  ok('#223 同じ区分なら統合の確認ができる', dry.status === 200 && dry.data.source.is_provisional === false, dry)
  const m = await admin.post(`/api/admin/staff/${partnerB}/merge`, { target_staff_id: partnerA, force: true })
  ok('#223 同じ区分の重複登録を統合できる', m.status === 200 && m.data.target_staff_id === partnerA, m)
  // シフトのある本登録の行は統合元にできない
  const withShift = must(await roster('partner', { name: `${PFX} シフトあり`, phone: newPhone(), new_partner_name: `${PFX}取引先` }), 'with shift').staff_id
  must(await admin.post('/api/admin/shifts', { staff_id: withShift, project_id: pid, work_date: addDays(today, 3), start_time: '10:00', end_time: '18:00' }), 'shift')
  lc = await lifecycle(withShift)
  const ms = await admin.post(`/api/admin/staff/${withShift}/merge`, { target_staff_id: partnerA, dry_run: true })
  ok('#223 シフトのある本登録の行は統合元にできない', lc.can_merge === false && ms.status === 400, { can: lc.can_merge, ms })
}

// ---------- #461 統合を1回の batch で行い、記録・置き換えを残す。同時の2回目は統合しない ----------
{
  const src = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 仮 統合元`, phone: newPhone(), affiliation_type: 'daily_worker', force: true }), 'quick').staff_id
  const D = addDays(today, 5)
  must(await admin.post('/api/admin/shifts', { staff_id: src, project_id: pid, work_date: D, start_time: '10:00', end_time: '18:00' }), 'future shift')
  must(await admin.post('/api/admin/shifts', { staff_id: src, project_id: pid, work_date: addDays(today, 6), start_time: '10:00', end_time: '18:00' }), 'future shift2')
  // 同時に2回送る
  const [r1, r2] = await Promise.all([
    admin.post(`/api/admin/staff/${src}/merge`, { target_staff_id: partnerA, force: true }),
    admin.post(`/api/admin/staff/${src}/merge`, { target_staff_id: partnerA, force: true }),
  ])
  const oks = [r1, r2].filter(r => r.status === 200).length
  ok('#461 同じ統合元を同時に2回統合しても、成功は1回だけ', oks === 1 && [r1, r2].some(r => r.status === 409), { r1, r2 })
  const merges = must(await admin.get(`/api/admin/staff/${partnerA}/merges`), 'merges').merges.filter(x => x.source_staff_id === src)
  ok('#461 統合の記録が1件だけ残る', merges.length === 1 && merges[0].repriced_shifts === 2, merges)
  const shifts = must(await admin.get(`/api/admin/shifts?from=${D}&to=${addDays(today, 6)}`), 'shifts').shifts.filter(s => s.project_id === pid)
  ok('#461 予定シフトは統合先に移り、支払先が統合先の区分（取引先）になる',
    shifts.length >= 2 && shifts.every(s => s.staff_id === partnerA && s.payee_type === 'partner'), shifts.map(s => ({ id: s.shift_id, staff: s.staff_id, payee: s.payee_type })))
  const hist = (await lifecycle(partnerA)).history
  ok('#461 統合先の区分の履歴に統合が残る', hist.some(h => String(h.note || '').includes(`仮登録「${PFX} 仮 統合元」を統合`)), hist)
  const again = await admin.post(`/api/admin/staff/${src}/merge`, { target_staff_id: partnerA, force: true })
  ok('#461 統合済みの行をもう一度統合しようとすると 409', again.status === 409, again)
}

// ---------- #356 #506 仮登録の電話番号の重複で、在籍状況を区別する ----------
{
  const phone = newPhone()
  const sid = must(await roster('partner', { name: `${PFX} 退職 三郎`, phone, new_partner_name: `${PFX}取引先` }), 'retire target').staff_id
  const ret = await admin.put(`/api/admin/staff/${sid}`, { employment_status: 'retired', retired_at: addDays(today, -3), retired_at_confirmed: true })
  ok('準備: 退職にできる', ret.status === 200, ret)
  const lk = must(await admin.get(`/api/admin/staff-lookup?phone=${phone}`), 'lookup')
  const m = lk.matches.find(x => x.staff_id === sid)
  ok('#356 staff-lookup が退職の人に「退職」の印を付ける', m && m.inactive === '退職' && m.employment_status === 'retired', lk)
  const q = await admin.post('/api/admin/staff-quick', { name: `${PFX} 退職 三郎`, phone, affiliation_type: 'daily_worker' })
  ok('#356 仮登録の重複（409）でも在籍状況を返す', q.status === 409 && q.data.need_force && q.data.matches.some(x => x.staff_id === sid && x.inactive === '退職'), q)
  const phone2 = newPhone()
  const active = must(await roster('partner', { name: `${PFX} 在籍 四郎`, phone: phone2, new_partner_name: `${PFX}取引先` }), 'active').staff_id
  const lk2 = must(await admin.get(`/api/admin/staff-lookup?phone=${phone2}`), 'lookup2')
  ok('#506 在籍中の人は印なし（画面で「この人を割り当てる」を出せる）', lk2.matches.some(x => x.staff_id === active && !x.inactive), lk2)
}

// ---------- #251 本登録で企業の必須項目を確かめる ----------
{
  must(await admin.put('/api/admin/roster/field-settings', { required: { date_of_birth: true, work_area: true } }), 'require')
  try {
    const sid = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 本登録 五郎`, phone: newPhone(), affiliation_type: 'daily_worker', force: true }), 'quick5').staff_id
    const lc = await lifecycle(sid)
    ok('#251 lifecycle が本登録の必須項目を返す', lc.required_fields.some(f => f.code === 'date_of_birth') && lc.required_fields.some(f => f.code === 'work_area'), lc.required_fields)
    const r1 = await admin.post(`/api/admin/staff/${sid}/finalize`, { gender: 'male' })
    ok('#251 必須項目が空なら本登録しない', r1.status === 400 && (r1.data.missing || []).includes('生年月日'), r1)
    ok('#251 失敗したら仮登録のまま', (await lifecycle(sid)).is_provisional === true)
    const r2 = await admin.post(`/api/admin/staff/${sid}/finalize`, { gender: 'male', date_of_birth: '1995/01/32', work_area: '東京' })
    ok('#251 形式の合わない値は 400', r2.status === 400, r2)
    const r3 = await admin.post(`/api/admin/staff/${sid}/finalize`, { gender: 'male', date_of_birth: '1995-01-31', work_area: '東京23区' })
    ok('#251 必須項目を入れれば本登録できる', r3.status === 200, r3)
    const detail = must(await admin.get(`/api/admin/staff/${sid}`), 'detail')
    const p = detail.profile || detail.staff || detail
    ok('#251 本登録で入れた値が保存される', p.date_of_birth === '1995-01-31' && p.work_area === '東京23区', { dob: p.date_of_birth, area: p.work_area })
    // 他社の行で区分の条件: 所属先担当者名（③のみ）は日雇いには求めない
    must(await admin.put('/api/admin/roster/field-settings', { required: { affiliation_contact: true } }), 'require2')
    const sid2 = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 本登録 六郎`, phone: newPhone(), affiliation_type: 'daily_worker', force: true }), 'quick6').staff_id
    const r4 = await admin.post(`/api/admin/staff/${sid2}/finalize`, { gender: 'male', date_of_birth: '1995-02-01', work_area: '東京' })
    ok('#251 所属先担当者名は取引先所属以外の本登録では求めない', r4.status === 200, r4)
    // ログインを発行するときの番号の重複は空いている番号を返す
    const sid3 = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 本登録 七郎`, phone: newPhone(), affiliation_type: 'daily_worker', force: true }), 'quick7').staff_id
    const r5 = await admin.post(`/api/admin/staff/${sid3}/finalize`, { gender: 'male', date_of_birth: '1995-02-01', work_area: '東京', user_code: 'admin', password: 'pass1234x' })
    ok('#424 本登録のスタッフ番号が重複したら空いている番号を返す', r5.status === 409 && !!r5.data.suggested_code, r5)
  } finally {
    must(await admin.put('/api/admin/roster/field-settings', { required: { date_of_birth: false, work_area: false, affiliation_contact: false } }), 'restore')
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
