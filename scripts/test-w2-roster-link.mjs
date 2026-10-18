// 企業間連携（QR/ID連携）の検証（w2-roster-link: #41 #63 #127 #238 #255 #262）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   本部（hq）で連携先の会社 A・B・C を作り、自社（sample）のスタッフを API で連携・退職・区分変更して確かめる。
//   #263（企業間チャットの二度押し）は画面側の送信ロックのみの修正のため、ここでは確かめない
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-roster-link.mjs
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1)
const minutesFromNow = (ts) => Math.abs(Date.parse(String(ts).replace(' ', 'T') + 'Z') - Date.parse(jstNow().replace(' ', 'T') + 'Z')) / 60000

const PFX = 'RL' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const ownName = '株式会社サンプルモバイル人材'
const co = {}
for (const k of ['A', 'B', 'C']) {
  const code = `${PFX.toLowerCase()}${k.toLowerCase()}`
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX}連携先${k}株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company ' + k)
  co[k] = { name: `${PFX}連携先${k}株式会社`, api: client(await login(code, 'admin')) }
}
// 自社雇用のスタッフを作る
const staff = {}
for (const k of ['X', 'Y', 'Z', 'W']) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} 連携${k}`, password: 'pass1234' }), 'staff ' + k)
}
for (const s of must(await admin.get('/api/admin/staff'), 'staff list').staff) {
  const k = String(s.user_code).startsWith(PFX) ? String(s.user_code).slice(PFX.length) : null
  if (k) staff[k] = s
}
ok('（前提）自社雇用のスタッフに恒久ID（FS…）がある', ['X', 'Y', 'Z', 'W'].every(k => staff[k] && /^FS/.test(staff[k].global_staff_code)), staff)
const terms = must(await admin.get('/api/admin/roster/consent-terms'), 'terms')
const link = (api, code) => api.post('/api/admin/roster/link', { code, agreed: true, consent_version: terms.version })
const putEmp = (sid, body) => admin.put(`/api/admin/employees/${sid}`, body)
const detail = async (api, sid) => (await api.get(`/api/admin/staff/${sid}`)).data?.profile

// ---------- #238 二度押し・同時送信 ----------
{
  const rs = await Promise.all([link(co.A.api, staff.X.global_staff_code), link(co.A.api, staff.X.global_staff_code), link(co.A.api, staff.X.global_staff_code)])
  const okCount = rs.filter(r => r.status === 200).length
  ok('#238 同じ人を同時に3回連携しても、成功は1回だけ（ほかは 409）', okCount === 1 && rs.filter(r => r.status === 409).length === 2, rs.map(r => [r.status, r.data]))
  const rows = must(await co.A.api.get('/api/admin/staff'), 'A staff').staff.filter(s => s.name === `${PFX} 連携X`)
  ok('#238 連携先のスタッフマスタに1行だけできる', rows.length === 1, rows)
  staff.X.inA = rs.find(r => r.status === 200).data.staff_id
  const again = await link(co.A.api, staff.X.global_staff_code)
  ok('#238 後からもう一度連携しても 409（既に連携済み）', again.status === 409 && again.data.staff_id === staff.X.inA, again)
}

// ---------- #255 同意履歴・連携日を日本時間で保存する ----------
{
  const host = must(await co.A.api.get(`/api/admin/roster/${staff.X.inA}/links`), 'host links')
  const ts = host.consents[0]?.created_at
  ok('#255 同意履歴の日時が日本時間（いまの日本時間との差が5分以内）', ts && minutesFromNow(ts) < 5, [ts, jstNow()])
  const owner = must(await admin.get(`/api/admin/roster/${staff.X.staff_id}/links`), 'owner links')
  const l = owner.links.find(x => x.host_company_name === co.A.name)
  ok('#255 所属元から見た連携日時も日本時間', l && minutesFromNow(l.consented_at) < 5 && minutesFromNow(l.linked_at) < 5, [l, jstNow()])
}

// ---------- #41 退職・停止中の人は連携できない ----------
{
  let r = await putEmp(staff.Z.staff_id, { profile: { retired_at: yesterday, employment_status: 'retired' } })
  ok('（前提）Z を昨日付けで退職にする', r.status === 200, r)
  const lk = await co.B.api.get(`/api/admin/roster/lookup?code=${staff.Z.global_staff_code}`)
  ok('#41 退職者の恒久IDでは連携候補を出さない（409・退職済みの文言）', lk.status === 409 && /退職/.test(lk.data.error) && !lk.data.candidate, lk)
  const ln = await link(co.B.api, staff.Z.global_staff_code)
  ok('#41 退職者の恒久IDでは連携できない（409）', ln.status === 409, ln)
  ok('#41 連携先に行が作られていない', !must(await co.B.api.get('/api/admin/staff'), 'B staff').staff.some(s => s.name === `${PFX} 連携Z`))
  const sc = await admin.get(`/api/admin/roster/${staff.Z.staff_id}/share-code`)
  ok('#41 退職者の連携用QRは出さない（400）', sc.status === 400, sc)
  { const pz = await detail(admin, staff.Z.staff_id); ok('#41 退職者は link_shareable=false（区分の linkable は true のままで、企業間チャットの連携先スレッドは出る）', pz?.link_shareable === false && pz?.linkable === true, pz && [pz.link_shareable, pz.linkable]) }
  // 退職予定（今日以降の退職日）の人は連携できる
  r = await putEmp(staff.Z.staff_id, { profile: { retired_at: null, employment_status: 'working' } })
  ok('（前提）Z の退職を取り消す', r.status === 200, r)
  const lk2 = await co.B.api.get(`/api/admin/roster/lookup?code=${staff.Z.global_staff_code}`)
  ok('#41 在籍に戻せば連携候補が出る', lk2.status === 200 && lk2.data.candidate && lk2.data.candidate.owner_company_name === ownName, lk2)
}

// ---------- #41 #127 多段連携: 雇用元で退職したら、途中の会社のコードでも連携できず、連携行にも退職日が伝わる ----------
{
  const yA = must(await link(co.A.api, staff.Y.global_staff_code), 'link Y to A').staff_id
  const rl = must(await co.A.api.get(`/api/admin/roster/${yA}/share-code`), 'share-code Y in A')
  ok('（前提）A で受け入れた Y の再連携コード（RL…）', /^RL/.test(rl.global_staff_code) && rl.relink === true, rl)
  const yB = must(await link(co.B.api, rl.global_staff_code), 'link Y to B (RL)').staff_id
  const yC0 = await co.C.api.get(`/api/admin/roster/lookup?code=${rl.global_staff_code}`)
  ok('（前提）退職前は RL コードで連携候補が出る', yC0.status === 200, yC0)

  const r = await putEmp(staff.Y.staff_id, { profile: { retired_at: yesterday, employment_status: 'retired' } })
  ok('（前提）雇用元で Y を昨日付けで退職にする', r.status === 200, r)
  const yC = await co.C.api.get(`/api/admin/roster/lookup?code=${rl.global_staff_code}`)
  ok('#41 多段連携: 雇用元で退職した人は、途中の会社の RL コードでも連携できない（409）', yC.status === 409, yC)
  const pa = await detail(co.A.api, yA), pb = await detail(co.B.api, yB)
  ok('#127 連携行（A）に雇用元の退職日が伝わり、退職扱いになる', pa && pa.retired_at === yesterday && pa.status === 'suspended' && pa.employment_status === 'retired' && pa.link_shareable === false, pa && [pa.retired_at, pa.status, pa.employment_status, pa.link_shareable])
  ok('#127 多段連携の先（B）にも退職日が伝わる', pb && pb.retired_at === yesterday && pb.status === 'suspended', pb && [pb.retired_at, pb.status])
  const scA = await co.A.api.get(`/api/admin/roster/${yA}/share-code`)
  ok('#41 雇用元で退職した人の連携用QRは連携先でも出さない（400）', scA.status === 400, scA)

  const r2 = await putEmp(staff.Y.staff_id, { profile: { retired_at: null, employment_status: 'working' } })
  const pa2 = await detail(co.A.api, yA)
  ok('#127 雇用元で退職を取り消すと、連携行も在籍に戻る', r2.status === 200 && pa2 && pa2.retired_at === null && pa2.status === 'active' && pa2.employment_status === 'working', pa2 && [pa2.retired_at, pa2.status, pa2.employment_status])
  const fut = addDays(today, 30)
  const r3 = await putEmp(staff.Y.staff_id, { profile: { retired_at: fut, employment_status: 'working' } })
  const pa3 = await detail(co.A.api, yA)
  ok('#127 退職予定（今日以降）も連携行に伝わり、在籍のまま', r3.status === 200 && pa3 && pa3.retired_at === fut && pa3.status === 'active', pa3 && [pa3.retired_at, pa3.status])
  await putEmp(staff.Y.staff_id, { profile: { retired_at: null, employment_status: 'working' } })
  // 退職日と同じ方式の、氏名の伝播（ID を数値で渡すように直した）
  const rn = await putEmp(staff.Y.staff_id, { profile: { name: `${PFX} 連携Y改` } })
  const pa4 = await detail(co.A.api, yA), pb4 = await detail(co.B.api, yB)
  ok('（参考）雇用元で氏名を変えると、連携行の表示名も変わる', rn.status === 200 && pa4?.name === `${PFX} 連携Y改` && pb4?.name === `${PFX} 連携Y改`, [rn.status, pa4?.name, pb4?.name])
}

// ---------- #127 定期削除の対象: 連携行も所属元の退職日で選ばれる ----------
{
  const wB = must(await link(co.B.api, staff.W.global_staff_code), 'link W to B').staff_id
  must(await co.B.api.post('/api/admin/projects', { project_name: `${PFX}-B案件W` }), 'project')
  const pid = must(await co.B.api.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-B案件W`).project_id
  must(await co.B.api.post('/api/admin/shifts', { staff_id: wB, project_id: pid, work_date: addDays(today, 3), start_time: '10:00', end_time: '18:00' }), 'shift W in B')
  const r = await putEmp(staff.W.staff_id, { profile: { retired_at: '2016-01-15', employment_status: 'retired', retired_at_confirmed: true } })
  ok('（前提）W を8年以上前の退職日で退職にする（確認済み）', r.status === 200, r)
  const pw = await detail(co.B.api, wB)
  ok('#127 連携行に退職日が伝わる', pw && pw.retired_at === '2016-01-15', pw && pw.retired_at)
  const sch = must(await hq.get('/api/hq/retention/schedule'), 'schedule')
  const inList = [...sch.scheduled, ...sch.excluded].find(s => s.staff_id === wB)
  ok('#127 連携行が本部の定期削除の一覧に出る（退職日より後のシフトがあるので「対象外」）', inList && sch.excluded.some(s => s.staff_id === wB) && inList.retired_at === '2016-01-15', inList)
  await putEmp(staff.W.staff_id, { profile: { retired_at: null, employment_status: 'working' } })
  const sch2 = must(await hq.get('/api/hq/retention/schedule'), 'schedule')
  ok('#127 退職を取り消すと一覧から外れる', ![...sch2.scheduled, ...sch2.excluded].some(s => s.staff_id === wB))
}

// ---------- #63 他社連携から自社管理に切り替えた人のQRは、今の管理元に解決する ----------
{
  const xA = staff.X.inA
  // 所属区分の変更は、影響の確認（dry_run）で受け取った preview_token を付けて実行する（w2-status-change）
  const chBody = { to_type: 'own_employee', hire_date: today, effective_date: today }
  const pv = await co.A.api.post(`/api/admin/staff/${xA}/affiliation-change`, { ...chBody, dry_run: true })
  const ch = pv.status === 200 ? await co.A.api.post(`/api/admin/staff/${xA}/affiliation-change`, { ...chBody, preview_token: pv.data.preview_token }) : pv
  ok('（前提）A で X を自社雇用に切り替える', ch.status === 200, ch)
  const p = await detail(co.A.api, xA)
  ok('#63 切り替えた行には雇用元の恒久IDを出さない', p && p.global_staff_code !== staff.X.global_staff_code && p.link_shareable === true, p && [p.global_staff_code, p.link_shareable])
  const listRow = must(await co.A.api.get('/api/admin/staff'), 'A staff').staff.find(s => s.staff_id === xA)
  ok('#63 スタッフ一覧にも雇用元の恒久IDを出さない', listRow && listRow.global_staff_code !== staff.X.global_staff_code, listRow && listRow.global_staff_code)
  const sc = must(await co.A.api.get(`/api/admin/roster/${xA}/share-code`), 'share-code')
  ok('#63 連携用QRは A 専用の再連携コード（RL…）', /^RL/.test(sc.global_staff_code) && sc.relink === true && sc.company_name === co.A.name, sc)
  const lk = await co.C.api.get(`/api/admin/roster/lookup?code=${sc.global_staff_code}`)
  ok('#63 C から見える所属元は A（雇用元の会社名を出さない）', lk.status === 200 && lk.data.candidate.owner_company_name === co.A.name && !JSON.stringify(lk.data).includes(ownName), lk)
  const xC = must(await link(co.C.api, sc.global_staff_code), 'link X to C').staff_id
  const pc = await detail(co.C.api, xC)
  ok('#63 C の連携行の所属元は A', pc && pc.owner_company_name === co.A.name && pc.affiliation === co.A.name, pc && [pc.owner_company_name, pc.affiliation])
  const chain = must(await co.A.api.get(`/api/admin/roster/${xA}/links`), 'A links')
  ok('#63 A の連携先一覧に C が出る（雇用元ではなく A につながっている）', chain.role === 'owner' && chain.links.some(l => l.host_company_name === co.C.name), chain)
  const own = must(await admin.get(`/api/admin/roster/${staff.X.staff_id}/links`), 'owner links')
  ok('#63 雇用元の連携先一覧に C は出ない', !own.links.some(l => l.host_company_name === co.C.name), own.links)
  // 雇用元の恒久IDは、引き続き雇用元の行に解決する
  const lkB = await co.B.api.get(`/api/admin/roster/lookup?code=${staff.X.global_staff_code}`)
  ok('#63 雇用元の恒久IDは雇用元に解決する', lkB.status === 200 && lkB.data.candidate.owner_company_name === ownName, lkB)
}

// ---------- #262 屋号・自社名・スキルシートの所属を取引先にしない ----------
{
  const r = await admin.post('/api/admin/staff-affiliations', { affiliation_name: ownName })
  ok('#262 自社名は取引先として登録できない（400）', r.status === 400, r)
  const yago = `${PFX}屋号`
  must(await admin.post('/api/admin/staff-affiliations', { affiliation_name: yago }), 'affiliation (old behaviour)')
  must(await admin.post('/api/admin/roster', { route: 'skillsheet', name: `${PFX} シートのみ`, gender: 'female', affiliation: yago }), 'skillsheet staff')
  const partners = must(await admin.get('/api/admin/roster/partners'), 'partners').partners
  ok('#262 スキルシートのみの人の所属会社名だけの行は取引先一覧に出ない', !partners.some(p => p.affiliation_name === yago), partners.map(p => p.affiliation_name))
  const pname = `${PFX}本物の取引先`
  must(await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 取引先所属`, gender: 'male', new_partner_name: pname }), 'partner staff')
  const partners2 = must(await admin.get('/api/admin/roster/partners'), 'partners').partners
  ok('#262 本物の取引先は一覧に出る', partners2.some(p => p.affiliation_name === pname && p.staff_count === 1), partners2.map(p => [p.affiliation_name, p.staff_count]))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
