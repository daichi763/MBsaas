// w33-sec-authz（セキュリティの点検 M1 #9998）: スタッフの統合で、他社の連携行を別の人に付け替えない の統合テスト
//   (1) 統合元が他社（B・C）に連携中で、統合先が別人（人物IDが違う）なら、dry_run は統合できない理由（連携先の会社数）を返し、
//       統合は force を付けても 409（linked_other_company）。他社の行（連携元・人物ID・氏名）も統合元も変わらない
//   (2) 統合元と統合先が同じ人物（人物IDが同じ）なら、今までどおり他社の連携行を統合先に付け替える（PERSIST があるときだけ。人物IDをローカルの D1 で合わせる）
//   (3) 他社の連携行がない統合は今までどおりできる
//   (4) 連携が終了した他社の行だけがあるときは、別人にも統合できるが、終了した行は付け替えずに統合元のまま残す
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9022 --persist-to <保存先> で起動していること（本番には接続しない）。
// 実行: BASE=http://127.0.0.1:9022 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w33-merge-links.mjs
//   PERSIST はローカルの D1 を直接読み書きするのに使う（wrangler d1 execute は --local のみ）
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// wrangler d1 execute の後に、つなぎっぱなしの接続が切られることがあるので、1回だけやり直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:9022'
const PERSIST = process.env.PERSIST || ''
// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST がないため）`)

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
const PFX = 'ML' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '090' + String(Date.now() % 100000000 + (phoneSeq++)).padStart(8, '0').slice(-8)

const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
async function newCompany(tag) {
  const code = `${PFX.toLowerCase()}${tag}`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `${PFX}連携先${tag}株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company ' + tag)
  return { api: client(await login(code, 'admin')), name: `${PFX}連携先${tag}株式会社` }
}
const B = await newCompany('B')
const C = await newCompany('C')
const quick = async (name) => must(await admin.post('/api/admin/staff-quick', { name, phone: newPhone(), affiliation_type: 'own_employee', force: true }), 'staff-quick ' + name).staff_id
async function staffWithLogin(code, name) {
  must(await admin.post('/api/admin/staff', { user_code: code, name, password: 'pass1234' }), 'staff ' + code)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === code).staff_id
}
async function linkTo(co, sid) {
  const code = must(await admin.get(`/api/admin/roster/${sid}/share-code`), 'share-code').global_staff_code
  const terms = must(await co.api.get('/api/admin/roster/lookup?code=' + encodeURIComponent(code)), 'lookup').consent
  return must(await co.api.post('/api/admin/roster/link', { code, agreed: true, consent_version: terms?.version }), 'link').staff_id
}
const merge = (src, tgt, extra = {}) => admin.post(`/api/admin/staff/${src}/merge`, { target_staff_id: tgt, ...extra })
const lifecycle = async (sid) => must(await admin.get(`/api/admin/staff/${sid}/lifecycle`), 'lifecycle ' + sid)
const rowIn = async (co, sid) => must(await co.api.get('/api/admin/staff'), 'staff list').staff.find(s => s.staff_id === sid)
const linkState = (ids) => d1(`SELECT sp.staff_id, sp.source_staff_id, sp.root_staff_id, sp.person_id, us.person_id AS user_person_id, us.name, us.role
  FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id IN (${ids.map(Number).join(',')}) ORDER BY sp.staff_id`)[0]

// ---------- (1) 別人への統合は止める ----------
{
  const src = await quick(`${PFX} 連携 一郎`)
  const inB = await linkTo(B, src)
  const inC = await linkTo(C, src)
  const tgt = await staffWithLogin(`${PFX}T1`, `${PFX} 別人 一郎`)
  const before = PERSIST ? linkState([inB, inC]) : null
  const bBefore = await rowIn(B, inB)

  const dry = await merge(src, tgt, { dry_run: true })
  ok('M1 dry_run: 200 で、統合できない理由（linked_other_company・連携先 2社）を返す', dry.status === 200 && dry.data.blocked?.code === 'linked_other_company' && dry.data.blocked.link_companies === 2, dry)
  ok('M1 dry_run: 理由の文言', /^他社に連携されているため統合できません。先に連携先に連携の終了を依頼してください（連携先 2社）$/.test(dry.data?.blocked?.error || ''), dry.data?.blocked)
  ok('M1 dry_run: 連携を引き継ぐとは出さない（linked_rows 0）', dry.data.counts.linked_rows === 0 && !dry.data.effects.some(e => e.includes('の連携を統合先に引き継ぎます')), dry.data)
  const m1 = await merge(src, tgt)
  ok('M1 統合（force なし）は 409 linked_other_company', m1.status === 409 && m1.data?.code === 'linked_other_company' && m1.data.link_companies === 2, m1)
  const m2 = await merge(src, tgt, { force: true })
  ok('M1 統合（force あり）も 409 linked_other_company', m2.status === 409 && m2.data?.code === 'linked_other_company' && /他社に連携されているため統合できません/.test(m2.data.error), m2)
  const lc = await lifecycle(src)
  ok('M1 統合元は統合済みにならない', !lc.merged_into_staff_id, lc)
  const bAfter = await rowIn(B, inB)
  ok('M1 B の連携行の氏名は統合元のまま', bAfter && bBefore && bAfter.name === bBefore.name && bAfter.name === `${PFX} 連携 一郎`, { bBefore, bAfter })
  if (PERSIST) {
    const after = linkState([inB, inC])
    ok('M1 B・C の連携行（連携元・雇用元・人物ID・users の人物ID・氏名）は変わらない', JSON.stringify(after) === JSON.stringify(before) && after.every(r => r.source_staff_id === src), { before, after })
  } else skip('M1 B・C の連携行が DB で変わらない')
  const cos = must(await client(await login('sample', `${PFX}T1`)).get('/api/staff/me/companies'), 'companies T1')
  ok('M1 統合先の人の企業の切り替えに B・C は出ない', !cos.companies.some(x => x.company_name === B.name || x.company_name === C.name), cos)
}

// ---------- (2) 同じ人物どうしなら付け替える ----------
if (!PERSIST) skip('M1 同じ人物への統合は付け替える')
else {
  const src = await quick(`${PFX} 連携 二郎`)
  const inB = await linkTo(B, src)
  const tgt = await staffWithLogin(`${PFX}T2`, `${PFX} 同一 二郎`)
  // 同じ人物（人物IDが同じ）にする。統合元の行と users の人物IDを、統合先の人物IDにそろえる
  const t = d1(`SELECT person_id FROM staff_profiles WHERE staff_id = ${Number(tgt)}`)[0][0]
  d1(`UPDATE staff_profiles SET person_id = '${String(t.person_id).replace(/'/g, "''")}' WHERE staff_id = ${Number(src)}`)
  d1(`UPDATE users SET person_id = '${String(t.person_id).replace(/'/g, "''")}' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ${Number(src)})`)
  const dry = await merge(src, tgt, { dry_run: true })
  ok('M1 同じ人物: dry_run は blocked なしで、他社 1社 の連携を引き継ぐと出す', dry.status === 200 && dry.data.blocked === null && dry.data.counts.linked_rows === 1
    && dry.data.effects.some(e => e.includes('他社 1社 の連携を統合先に引き継ぎます')), dry)
  const m = await merge(src, tgt, { force: true })
  ok('M1 同じ人物: 統合できる', m.status === 200 && m.data.ok, m)
  const [row] = linkState([inB])
  ok('M1 同じ人物: B の連携行の連携元・雇用元が統合先になる', row.source_staff_id === tgt && row.root_staff_id === tgt, row)
  ok('M1 同じ人物: B の連携行の人物ID・氏名が統合先にそろう', row.person_id === t.person_id && row.user_person_id === t.person_id && row.name === `${PFX} 同一 二郎`, row)
  const links = must(await admin.get(`/api/admin/roster/${tgt}/links`), 'links')
  ok('M1 同じ人物: 統合先の「連携状況」に B が出る', (links.links || []).some(l => l.linked_staff_id === inB), links)
}

// ---------- (3) 他社の連携行がない統合は今までどおり ----------
{
  const src = await quick(`${PFX} 連携なし 三郎`)
  const tgt = await staffWithLogin(`${PFX}T3`, `${PFX} 統合先 三郎`)
  const dry = await merge(src, tgt, { dry_run: true })
  ok('連携なし: dry_run は blocked なし', dry.status === 200 && dry.data.blocked === null && dry.data.counts.linked_rows === 0, dry)
  const m = await merge(src, tgt, { force: true })
  ok('連携なし: 統合できる', m.status === 200 && m.data.ok && m.data.target_staff_id === tgt, m)
  ok('連携なし: 統合元は統合済みになる', (await lifecycle(src)).merged_into_staff_id === tgt)
}

// ---------- (4) 連携が終了した行だけなら統合できるが、終了した行は付け替えない ----------
{
  const src = await quick(`${PFX} 終了 四郎`)
  const inB = await linkTo(B, src)
  const end = await admin.post(`/api/admin/roster/${src}/links/${inB}/end`, {})
  ok('（前提）所属元が B との連携を終了できる', end.status === 200, end)
  const tgt = await staffWithLogin(`${PFX}T4`, `${PFX} 別人 四郎`)
  const before = PERSIST ? linkState([inB]) : null
  const dry = await merge(src, tgt, { dry_run: true })
  ok('連携の終了: dry_run は blocked なしで、終了した連携は統合元のまま残すと出す', dry.status === 200 && dry.data.blocked === null && dry.data.counts.linked_rows === 0
    && dry.data.effects.some(e => e.includes('連携が終了している他社 1社 の連携は統合先に引き継がず')), dry)
  const m = await merge(src, tgt, { force: true })
  ok('連携の終了: 別人にも統合できる', m.status === 200 && m.data.ok, m)
  if (PERSIST) {
    const after = linkState([inB])
    ok('連携の終了: B の終了した行（連携元・人物ID・氏名）は統合元のまま', JSON.stringify(after) === JSON.stringify(before) && after[0].source_staff_id === src && after[0].name === `${PFX} 終了 四郎`, { before, after })
  } else skip('連携の終了: B の終了した行が DB で変わらない')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
