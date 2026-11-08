// クライアント画面の「開催場所」の欄を外し、案件の詳細へ移す（Sprint 18。w18-sites。#9914）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   画面の置き場所を移すだけで、開催場所の API・データ・単価ルール・位置ずれの判定は変えない。
//   ここでは、案件の詳細の欄が使う API（追加・編集・無効・有効に戻す・削除・使用中なら無効・シフトの件数・名前の変更が今日以降の枠に写る）と、
//   画面のコード（クライアント詳細に欄が無い・単価ルール（クライアント共通）の欄は残る・案件の詳細に欄がある・クライアントのない案件の案内・文言）を確かめる
// 実行: BASE=http://127.0.0.1:8810 node scripts/test-w18-sites.mjs
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
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// 関数の本体（次の行頭の関数・window.〜 の定義の手前まで）
const body = (s, start) => { const i = s.indexOf(start); if (i < 0) return ''; const rest = s.slice(i + start.length); const m = rest.search(/\n(async function |function |  window\.[A-Za-z]+ = |delegate\()/); return start + (m < 0 ? rest : rest.slice(0, m)) }

// ---------- 画面のコード ----------
{
  const adm = src('public/static/admin.js'), sb = src('public/static/shift-board.js')
  const cd = body(adm, 'async function renderClientDetail(')
  ok('#9914 クライアント詳細に「開催場所」の欄が無い（#client-sites-panel・renderClientSitesPanel を呼ばない）', cd && !/client-sites-panel|renderClientSitesPanel/.test(cd), cd.slice(-600))
  ok('#9914 クライアント詳細に「単価ルール（クライアント共通）」の欄が残る（#client-rate-panel に描く）', /id="client-rate-panel"/.test(cd) && /renderClientRatePanel\(cid\)/.test(cd))
  ok('#9914 クライアント詳細の NG スタッフ・協力会社としての支払の欄は今までどおり', /id="client-ng-panel"/.test(cd) && /renderClientNgPanel\(cid\)/.test(cd) && /renderClientPartnerPanel\(cid\)/.test(cd))
  const rate = body(sb, '  window.renderClientRatePanel = async function (cid) {')
  ok('#9914 単価ルール（クライアント共通）は #client-rate-panel に描き、開催場所の欄に頼らない', /getElementById\('client-rate-panel'\)/.test(rate) && !/client-sites-panel/.test(rate), rate.slice(0, 400))
  ok('#9914 shift-board.js に、クライアント詳細の開催場所の欄が残っていない', !/client-sites-panel|renderClientSitesPanel/.test(sb))
  const pd = body(adm, 'async function renderProjectDetail(')
  ok('#9914 案件の詳細に「開催場所」の欄を置き、案件を渡して描く', /id="project-sites-panel"/.test(pd) && /renderProjectSitesPanel\(p\)/.test(pd))
  const ps = body(sb, '  window.renderProjectSitesPanel = async function (p) {')
  ok('#9914 案件の詳細の欄は、案件のクライアントの開催場所を読む', /\/api\/admin\/sites\?client_id=' \+ cid/.test(ps) && /Number\(p\.client_id\)/.test(ps))
  ok('#9914 欄の説明: クライアントの開催場所で、同じクライアントの案件で共通に使う', /このクライアント.*の開催場所です。同じクライアントの案件で共通に使います/.test(ps))
  ok('#9914 クライアントのない案件: 登録できない理由と「案件にクライアントを設定してください」を出す', /if \(!cid\)/.test(ps) && /クライアントのない案件では登録できません。案件にクライアントを設定してください/.test(ps) && /data-action="editProject"/.test(ps))
  ok('#9914 追加・編集・無効にする・有効に戻す・削除のボタンがある（data-action で開く）',
    ['addSite', 'editSite', 'toggleSite', 'removeSite'].every(a => ps.includes(`'${a}'`) || ps.includes(`"${a}"`)) && />無効にする</.test(ps) && />有効に戻す</.test(ps) && />削除</.test(ps))
  ok('#9914 シフトの件数（このクライアントの全案件）を出す', /シフト（全案件）/.test(ps) && /s\.shift_count/.test(ps))
  ok('#9914 開催場所の行のボタンに、イベント属性（onclick など）で値を埋め込まない', !/\son[a-z]+="/.test(ps))
  ok('#9914 追加するクライアントは、開いている案件のクライアント（画面の data-* を使わない）', /SITE_CTX && SITE_CTX\.cid/.test(body(sb, '  window.addSite = async function () {')))
  ok('（変えていない）#406 開催場所の編集は、名前・住所・メモ・位置を送る', /data-action="editSite"|'editSite'/.test(sb) && /memo: document\.getElementById\('se-memo'\)\.value, lat, lng/.test(sb))
  const all = ['public/static/admin.js', 'public/static/shift-board.js', 'public/static/tour.js', 'src/shift-board.ts', 'README.md', 'docs/decisions.md'].map(f => [f, src(f)])
  const stale = all.filter(([, s]) => /クライアント詳細の「開催場所」|クライアント詳細で有効にして/.test(s)).map(([f]) => f)
  ok('#9914 「クライアント詳細の『開催場所』」と案内する文言が残っていない', !stale.length, stale)
  ok('#9914 位置ずれの説明は「案件の詳細の『開催場所』」で登録すると案内する', (adm.match(/案件の詳細の「開催場所」/g) || []).length >= 2)
}

// ---------- 配信される画面の JS ----------
{
  const r = await fetch(`${BASE}/static/shift-board.js`)
  const t = r.ok ? await r.text() : ''
  ok('#9914 配信される shift-board.js に案件の詳細の開催場所の欄がある', /renderProjectSitesPanel/.test(t) && !/renderClientSitesPanel/.test(t), r.status)
}

// ---------- 欄が使う API（変えていないこと） ----------
const admin = client(await login('sample', 'admin'))
const PFX = 'W18' + Date.now().toString(36).slice(-5).toUpperCase()
const C = must(await admin.post('/api/admin/clients', { client_name: `${PFX}商事`, allow_duplicate: true }), 'client').client_id
const PA = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-店頭A`, client_id: C, allow_duplicate: true }), 'project A').project_id
const PB = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-店頭B`, client_id: C, allow_duplicate: true }), 'project B').project_id
const PN = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-社内研修`, allow_duplicate: true }), 'project N').project_id
{
  const a = must(await admin.get('/api/admin/projects/' + PA), 'project A get').project
  ok('#9914 案件の詳細の API が、欄に要るクライアント（client_id・client_name）を返す', a.client_id === C && a.client_name === `${PFX}商事`, { client_id: a.client_id, client_name: a.client_name })
  const n = must(await admin.get('/api/admin/projects/' + PN), 'project N get').project
  ok('#9914 クライアントのない案件は client_id が空（画面は登録の案内を出す）', n.client_id == null, n.client_id)
}
const sitesOf = async (cid) => must(await admin.get('/api/admin/sites?client_id=' + cid), 'sites').sites
const siteOf = async (id) => (await sitesOf(C)).find(s => s.site_id === id)

// 追加（名前・住所）
const S1 = must(await admin.post('/api/admin/sites', { client_id: C, site_name: `${PFX}モール 1F`, address: '東京都千代田区' }), 'add site').site_id
const S2 = must(await admin.post('/api/admin/sites', { client_id: C, site_name: `${PFX}駅前店`, address: '' }), 'add site 2').site_id
{
  const s = await siteOf(S1)
  ok('#9914 追加: 案件のクライアントの開催場所になる（有効・シフト0件）', s && s.client_id === C && s.address === '東京都千代田区' && s.status === 'active' && Number(s.shift_count) === 0, s)
  ok('#9914 開催場所はクライアントに属する（同じクライアントのほかの案件でも同じ一覧）', (await sitesOf(C)).map(x => x.site_id).sort().join(',') === [S1, S2].sort().join(','))
  const r = await admin.post('/api/admin/sites', { client_id: C, site_name: '  ' })
  ok('（変えていない）名前の無い開催場所は追加できない', r.status === 400, r)
}

// 枠に開催場所を付ける（使用中の判定と、名前の変更が今日以降の枠に写ることを確かめる）
const jst = new Date(Date.now() + 9 * 3600 * 1000)
const future = new Date(jst.getTime() + 10 * 86400 * 1000).toISOString().slice(0, 10)
const slotIds = must(await admin.post('/api/admin/shift-slots', { project_id: PB, dates: [future], start_time: '10:00', end_time: '19:00', break_minutes: 60, site_id: S1, roles: [{ role_name: '販売', headcount: 1 }] }), 'slot').slot_ids
const slotGet = async () => must(await admin.get('/api/admin/shift-slots/' + slotIds[0]), 'slot get').slot

// 編集（名前・住所・メモ・位置。#406 #142）
{
  const before = await slotGet()
  must(await admin.put('/api/admin/sites/' + S1, { site_name: `${PFX}モール 2F`, address: '東京都中央区', memo: '搬入口は裏', lat: 35.681236, lng: 139.767125 }), 'edit site')
  const s = await siteOf(S1)
  ok('#9914 編集: 名前・住所・メモ・位置が変わる', s.site_name === `${PFX}モール 2F` && s.address === '東京都中央区' && s.memo === '搬入口は裏' && Number(s.lat) === 35.681236 && Number(s.lng) === 139.767125, s)
  const after = await slotGet()
  ok('（変えていない）#142 名前を変えると、今日以降の枠の場所名も変わる（ほかの案件の枠も）', before.location === `${PFX}モール 1F` && after.location === `${PFX}モール 2F`, { before: before.location, after: after.location })
  must(await admin.put('/api/admin/sites/' + S1, { lat: '', lng: '' }), 'clear latlng')
  const c2 = await siteOf(S1)
  ok('（変えていない）#406 位置を空欄にすると消える', c2.lat == null && c2.lng == null, c2)
  const bad = await admin.put('/api/admin/sites/' + S1, { lat: 35.6, lng: '' })
  ok('（変えていない）#406 位置は片方だけでは保存しない', bad.status === 400, bad)
}

// 無効にする・有効に戻す
{
  must(await admin.put('/api/admin/sites/' + S2, { status: 'inactive' }), 'deactivate')
  ok('#9914 無効にする', (await siteOf(S2)).status === 'inactive')
  must(await admin.put('/api/admin/sites/' + S2, { site_name: `${PFX}駅前店（改）` }), 'rename inactive')
  ok('（変えていない）#130 名前だけ変えても無効のまま', (await siteOf(S2)).status === 'inactive')
  must(await admin.put('/api/admin/sites/' + S2, { status: 'active' }), 'reactivate')
  ok('#9914 有効に戻す', (await siteOf(S2)).status === 'active')
}

// 削除（使用中なら無効）
{
  const used = must(await admin.del('/api/admin/sites/' + S1), 'delete used')
  const s = await siteOf(S1)
  ok('#9914 削除: 枠で使用中の開催場所は無効にする（消さない）', used.deactivated === true && s && s.status === 'inactive', { used, s })
  const again = must(await admin.del('/api/admin/sites/' + S1), 'delete used again')
  ok('#9914 無効の開催場所を削除しても、使用中なら無効のまま残る', again.deactivated === true && (await siteOf(S1)).status === 'inactive', again)
  const free = must(await admin.del('/api/admin/sites/' + S2), 'delete free')
  ok('#9914 削除: 使っていない開催場所は消える', !free.deactivated && !(await siteOf(S2)), free)
}

// クライアント共通の単価ルールは今までどおり
{
  const r = await admin.get('/api/admin/rate-rules?client_id=' + C)
  ok('#9914（変えていない）クライアント共通の単価ルールの一覧を読める', r.status === 200 && Array.isArray(r.data.rules), r)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
