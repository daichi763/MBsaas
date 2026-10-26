// 協力会社（以前の画面の名前は「取引先」。#9301）とクライアントのつながり（#9302。w10-partners）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   協力会社とクライアントをつなぐ・外す（1対1）、お互いの詳細に出る月の支払・請求の要約、統合でのつながりの移し替え、
//   他社からは触れないこと、画面に出る文言が「協力会社」になったことを API で確かめる。画面の描画は API では確かめない
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w10-partners.mjs
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

const PFX = 'PC' + Date.now().toString(36).slice(-4).toUpperCase()
const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
// 先月（今日より前の日だけを集計するため、過去の月で確かめる）
const lastMonth = (() => { const d = new Date(jstToday.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7) })()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))

// ---------- 前提: クライアント2社・案件・協力会社2社・協力会社所属のスタッフとシフト ----------
const C1 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}商事`, allow_duplicate: true }), 'client 1').client_id
const C2 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}物産`, allow_duplicate: true }), 'client 2').client_id
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-店頭`, client_id: C1, allow_duplicate: true }), 'project').project_id
must(await admin.put(`/api/admin/projects/${P}/pricing`, { unit_price_type: 'daily', unit_price: 18000, pay_unit_type: 'daily', pay_rate: 12000 }), 'pricing')
const X = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}商事`, contact_name: '担当 一郎' }), 'partner X').affiliation_id
const Y = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}(株)商事` }), 'partner Y').affiliation_id
const S = must(await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 協力 花子`, gender: 'female', partner_affiliation_id: X, affiliation_contact: '担当 一郎', force: true }), 'partner staff').staff_id
const shiftIds = []
for (const d of ['10', '11']) {
  const r = must(await admin.post('/api/admin/shifts', { staff_id: S, project_id: P, work_date: `${lastMonth}-${d}`, start_time: '10:00', end_time: '19:00', force: true, confirm_warnings: true }), 'shift ' + d)
  shiftIds.push(r.shift_id)
}

// ---------- #9301 文言 ----------
{
  const r = await admin.post('/api/admin/roster/partners', { affiliation_name: '' })
  ok('#9301 協力会社の登録の誤りの文言が「協力会社」', r.status === 400 && /協力会社名/.test(r.data.error) && !/取引先/.test(r.data.error), r)
  const nf = await admin.put('/api/admin/roster/partners/99999999', { memo: 'x' })
  ok('#9301 見つからないときの文言も「協力会社」', nf.status === 404 && /協力会社/.test(nf.data.error), nf)
  const tpl = await fetch(`${BASE}/api/admin/roster/import/template`, { headers: { Cookie: (await login('sample', 'admin')) } })
  const text = tpl.ok ? await tpl.text() : ''
  ok('#9301 CSV のひな形の見出しが「協力会社名」（取引先名は使わない）', tpl.ok && text.includes('協力会社名') && !text.includes('取引先名'), { status: tpl.status, head: text.slice(0, 200) })
}

// ---------- #9302 つなぐ ----------
const list = async () => must(await admin.get('/api/admin/roster/partners'), 'partners').partners
{
  let L = await list()
  const x = L.find(p => p.affiliation_id === X)
  ok('#9302 一覧に協力会社が出て、まだクライアントとつながっていない', x && x.client_id == null && x.client_name == null, x)
  const bad = await admin.put(`/api/admin/roster/partners/${X}/client`, { client_id: 'abc' })
  ok('#9302 クライアントの指定が正しくないと 400', bad.status === 400, bad)
  const empty = await admin.put(`/api/admin/roster/partners/${X}/client`, {})
  ok('#9302 client_id を送らないと 400（外したことにしない）', empty.status === 400, empty)
  const nf = await admin.put(`/api/admin/roster/partners/${X}/client`, { client_id: 99999999 })
  ok('#9302 ないクライアントは 404', nf.status === 404, nf)
  const r = await admin.put(`/api/admin/roster/partners/${X}/client`, { client_id: C1 })
  ok('#9302 協力会社をクライアントにつなげる', r.status === 200 && r.data.client_id === C1, r)
  L = await list()
  const x2 = L.find(p => p.affiliation_id === X)
  ok('#9302 一覧につながったクライアントの名前が出る', x2 && x2.client_id === C1 && x2.client_name === `${PFX}商事`, x2)
  const dup = await admin.put(`/api/admin/roster/partners/${Y}/client`, { client_id: C1 })
  ok('#9302 同じクライアントを2つ目の協力会社にはつなげない（409・相手の名前を出す）', dup.status === 409 && dup.data.error.includes(`${PFX}商事`), dup)
  const again = await admin.put(`/api/admin/roster/partners/${X}/client`, { client_id: C1 })
  ok('#9302 同じつながりをもう一度送っても 200', again.status === 200, again)
}

// ---------- #9302 協力会社の詳細（支払・請求の要約） ----------
{
  const d = must(await admin.get(`/api/admin/roster/partners/${X}?month=${lastMonth}`), 'detail')
  ok('#9302 詳細につながったクライアントが出る', d.partner.client_id === C1 && d.partner.client_name === `${PFX}商事` && d.partner.contact_name === '担当 一郎', d.partner)
  ok('#9302 詳細に在籍中の所属スタッフが出る', (d.staff || []).some(s => s.staff_id === S), d.staff)
  ok('#9302 月の支払（支払先がこの協力会社のシフト）: 12,000 × 2件・1名', d.summary.month === lastMonth && d.summary.pay.total === 24000 && d.summary.pay.shifts === 2 && d.summary.pay.staff === 1 && d.summary.pay.unset === 0, d.summary)
  ok('#9302 月の請求（つながったクライアントの案件のシフト）: 18,000 × 2件・案件1件', d.summary.bill && d.summary.bill.total === 36000 && d.summary.bill.projects === 1 && d.summary.bill.shifts === 2, d.summary)
  const opt = (d.clients || []).find(c => c.client_id === C2), self = (d.clients || []).find(c => c.client_id === C1)
  ok('#9302 クライアントの選択肢: 自分につながったものは他社名なし、ほかは選べる', opt && opt.linked_partner_name == null && self && self.linked_partner_name == null, { opt, self })
  const dy = must(await admin.get(`/api/admin/roster/partners/${Y}?month=${lastMonth}`), 'detail Y')
  const c1forY = (dy.clients || []).find(c => c.client_id === C1)
  ok('#9302 別の協力会社の選択肢では、つながり済みのクライアントに相手の名前が出る', c1forY && c1forY.linked_partner_name === `${PFX}商事`, c1forY)
  ok('#9302 つながっていない協力会社の詳細には請求が出ない', dy.summary.bill === null && dy.summary.pay.total === 0, dy.summary)
  const thisMonth = must(await admin.get(`/api/admin/roster/partners/${X}`), 'detail this month')
  ok('#9302 月を指定しなければ今月（先月のシフトは入らない）', thisMonth.summary.month === jstToday.slice(0, 7) && thisMonth.summary.pay.shifts === 0, thisMonth.summary)
  const badMonth = must(await admin.get(`/api/admin/roster/partners/${X}?month=2026-13`), 'bad month')
  ok('#9302 月の形が正しくなければ今月', badMonth.summary.month === jstToday.slice(0, 7), badMonth.summary)
}

// ---------- #9302 クライアントの詳細の欄 ----------
{
  const b = must(await admin.get(`/api/admin/roster/partners/by-client/${C1}?month=${lastMonth}`), 'by-client')
  ok('#9302 クライアントからつながった協力会社と、協力会社としての月の支払が見える', b.partner && b.partner.affiliation_id === X && b.summary.pay.total === 24000 && b.summary.pay.shifts === 2 && b.summary.bill === null, b)
  const b2 = must(await admin.get(`/api/admin/roster/partners/by-client/${C2}`), 'by-client 2')
  ok('#9302 つながっていないクライアントには、つなげる協力会社の選択肢（つながり済みは出さない）', b2.partner === null && b2.candidates.some(p => p.affiliation_id === Y) && !b2.candidates.some(p => p.affiliation_id === X), b2)
  const nf = await admin.get('/api/admin/roster/partners/by-client/99999999')
  ok('#9302 ないクライアントは 404', nf.status === 404, nf)
  const detail = must(await admin.get(`/api/admin/clients/${C1}`), 'client detail')
  ok('（変えていない）クライアント詳細の API はそのまま', detail.client && detail.client.client_id === C1, detail.client)
}

// ---------- 他社からは触れない ----------
{
  const code = `${PFX.toLowerCase()}o`
  const created = await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX}他社株式会社`, admin_code: 'admin', admin_password: 'pass1234' })
  if (created.status === 200) {
    const other = client(await login(code, 'admin'))
    const r1 = await other.get(`/api/admin/roster/partners/${X}`)
    ok('他社の協力会社の詳細は見えない（404）', r1.status === 404, r1)
    const r2 = await other.get(`/api/admin/roster/partners/by-client/${C1}`)
    ok('他社のクライアントの欄は見えない（404）', r2.status === 404, r2)
    const r3 = await other.put(`/api/admin/roster/partners/${X}/client`, { client_id: null })
    ok('他社の協力会社のつながりは外せない（404）', r3.status === 404, r3)
    const otherClient = must(await other.post('/api/admin/clients', { client_name: `${PFX}他社の客`, allow_duplicate: true }), 'other client').client_id
    const r4 = await admin.put(`/api/admin/roster/partners/${Y}/client`, { client_id: otherClient })
    ok('他社のクライアントにはつなげない（404）', r4.status === 404, r4)
  } else ok('（前提）他社を作れる', false, created)
}

// ---------- 統合でつながりを移す・外す ----------
{
  const m = must(await admin.post(`/api/admin/roster/partners/${X}/merge`, { into_id: Y }), 'merge')
  ok('（前提）統合できる', m.ok, m)
  let L = await list()
  const y = L.find(p => p.affiliation_id === Y)
  ok('#9302 統合すると、統合先がつながっていなければ統合元のつながりを移す', y && y.client_id === C1 && !L.some(p => p.affiliation_id === X), y)
  const b = must(await admin.get(`/api/admin/roster/partners/by-client/${C1}?month=${lastMonth}`), 'by-client after merge')
  ok('#9302 統合のあとは、クライアントから統合先が見える（未確定のシフトの支払先も統合先）', b.partner && b.partner.affiliation_id === Y && b.summary.pay.total === 24000, b)
  const un = await admin.put(`/api/admin/roster/partners/${Y}/client`, { client_id: null })
  ok('#9302 つながりを外せる', un.status === 200 && un.data.client_id === null, un)
  L = await list()
  ok('#9302 外すと一覧のクライアントが空になる', L.find(p => p.affiliation_id === Y).client_id == null, L.find(p => p.affiliation_id === Y))
  const b2 = must(await admin.get(`/api/admin/roster/partners/by-client/${C1}`), 'by-client after unlink')
  ok('#9302 外すとクライアントの欄もつながりなしになり、選び直せる', b2.partner === null && b2.candidates.some(p => p.affiliation_id === Y), b2)
  const re = await admin.put(`/api/admin/roster/partners/${Y}/client`, { client_id: C2 })
  ok('#9302 外したあと、別のクライアントにつなぎ直せる', re.status === 200 && re.data.client_id === C2, re)
  const sh = must(await admin.get(`/api/admin/shifts?from=${lastMonth}-10&to=${lastMonth}-11`), 'shifts')
  const mine = (sh.shifts || sh).filter(s => shiftIds.includes(s.shift_id))
  ok('（変えていない）つなぐ・外すでシフトの単価・支払先は変わらない', mine.length === 2 && mine.every(s => Number(s.unit_price) === 18000 && Number(s.pay_amount) === 12000 && s.payee_affiliation_id === Y), mine.map(s => [s.unit_price, s.pay_amount, s.payee_affiliation_id]))
}

// ---------- クライアントを消しても協力会社は残る ----------
{
  const C3 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}消す客`, allow_duplicate: true }), 'client 3').client_id
  const Z = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}消す客`, memo: 'つないでから客を消す' }), 'partner Z').affiliation_id
  must(await admin.put(`/api/admin/roster/partners/${Z}/client`, { client_id: C3 }), 'link Z')
  const del = await admin.del(`/api/admin/clients/${C3}`)
  ok('つながったクライアントも、案件などがなければ消せる', del.status === 200, del)
  const z = (await list()).find(p => p.affiliation_id === Z)
  ok('クライアントを消しても協力会社は残り、つながりなしとして出る', z && z.client_id == null, z)
  const dz = must(await admin.get(`/api/admin/roster/partners/${Z}`), 'detail Z')
  ok('消したクライアントは詳細でもつながりなし（請求は出ない）', dz.partner.client_id === null && dz.summary.bill === null, dz.partner)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
