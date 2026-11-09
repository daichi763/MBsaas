// 年齢だけの人を人材提案の年代と CSV 一括登録でも扱う（Sprint 16。w16-age。#9713）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   (1) 人材提案のスナップショットの年代: 生年月日 → 年齢だけの人は推定の年齢 → どちらもなければ年代なし
//   (2) CSV 一括登録の「年齢」の列: 全角・「歳」付きを受け付け、15〜100 の範囲を確かめる。年齢だけなら取り込んだ日の年齢として保存し、
//       生年月日と両方あれば生年月日を使う。生年月日が必須でも年齢で満たせる。テンプレートに「年齢」の列がある
//   PERSIST（--persist-to の保存先）があれば、入力した日を過去にずらして、提案の年代が推定の年齢（入れた年齢ではなく）から出ること、
//   他社連携の人材の年代が所属元の推定の年齢から出ることも確かめる
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> node scripts/test-w16-age.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
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
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}

const PFX = 'AG' + Date.now().toString(36).slice(-4).toUpperCase()
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
// 生年月日から満年齢の年代（テストの期待値）
const decadeOfDob = (dob) => {
  const [ty, tm, td] = today.split('-').map(Number); const [by, bm, bd] = dob.split('-').map(Number)
  let a = ty - by; if (tm < bm || (tm === bm && td < bd)) a--
  return `${Math.floor(a / 10) * 10}代`
}

// ---------- 準備: 掲載企業 A（sample）と、提案する企業 B（本部で作成） ----------
const A = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const coCode = 'ag' + Date.now().toString(36).slice(-6)
must(await hq.post('/api/hq/companies', { admin_email: `${coCode}@example.com`, company_code: coCode, company_name: `年代提案社${coCode}`, admin_code: 'admin', admin_password: 'pass1234', admin_name: '提案 管理者' }), 'company B')
const B = client(await login(coCode, 'admin'))

// ---------- (2) CSV 一括登録の「年齢」の列 ----------
const tpl = await B.get('/api/admin/roster/import/template')
ok('#9713 テンプレートの CSV に「年齢」の列がある（生年月日の次）', tpl.status === 200 && String(tpl.data).includes('生年月日,年齢,電話番号'), String(tpl.data).slice(0, 160))

const header = ['区分', '氏名', '性別', '生年月日', '年齢', '協力会社名']
const partner = `${PFX}人材`
const rows = [
  { line: 2, cells: ['協力会社', `${PFX} 年齢 一郎`, '男性', '', '３４歳', partner] },
  { line: 3, cells: ['スキルシートのみ', `${PFX} 両方 二郎`, '男性', '2000/1/15', '50', ''] },
  { line: 4, cells: ['協力会社', `${PFX} 範囲 三郎`, '男性', '', '5', partner] },
  { line: 5, cells: ['協力会社', `${PFX} 範囲 四郎`, '男性', '', '121', partner] },
  { line: 6, cells: ['協力会社', `${PFX} 文字 五郎`, '男性', '', '三十', partner] },
  { line: 7, cells: ['協力会社', `${PFX} なし 六子`, '女性', '', '', partner] },
]
const pv = await B.post('/api/admin/roster/import/preview', { header, rows })
const by = (line) => (pv.data.rows || []).find(r => r.line === line) || { errors: [], warnings: [], notes: [] }
ok('（前提）確かめるだけの結果を返す', pv.status === 200 && pv.data.rows.length === rows.length, pv)
ok('#9713 「年齢」の列は読まない列にならない', !(pv.data.unknown_columns || []).length, pv.data.unknown_columns)
ok('#9713 年齢だけの行は登録でき、取り込んだ日の年齢として登録すると知らせる（全角・「歳」付きも可）',
  !by(2).errors.length && !by(2).warnings.length && by(2).notes.some(n => n.includes('34歳')), by(2))
ok('#9713 生年月日と年齢の両方があれば、生年月日を使うと知らせる', !by(3).errors.length && by(3).notes.some(n => n.includes('生年月日があるため')), by(3))
ok('#9713 範囲より小さい年齢はエラー', by(4).errors.some(e => /年齢は15〜100/.test(e)), by(4))
ok('#9713 範囲より大きい年齢はエラー', by(5).errors.some(e => /年齢は15〜100/.test(e)), by(5))
ok('#9713 数でない年齢はエラー', by(6).errors.some(e => /年齢/.test(e)), by(6))
ok('#9713 年齢が空の行は今までどおり登録できる', !by(7).errors.length && !by(7).notes.some(n => /年齢/.test(n)), by(7))

// 見出しの別の書き方（1件ずつの登録の欄の名前）でも読む
const pvAlias = await B.post('/api/admin/roster/import/preview', { header: ['区分', '氏名', '性別', '年齢（生年月日が分からないとき）', '協力会社名'], rows: [{ line: 2, cells: ['協力会社', `${PFX} 別名 七郎`, '男性', '40', partner] }] })
ok('#9713 見出し「年齢（生年月日が分からないとき）」も年齢の列として読む', pvAlias.status === 200 && !(pvAlias.data.unknown_columns || []).length && pvAlias.data.rows[0].notes.some(n => n.includes('40歳')), pvAlias.data)

const cm = must(await B.post('/api/admin/roster/import/commit', { header, rows: [rows[0], rows[1], rows[5]] }), 'commit')
const st = cm.results.map(r => r.status)
ok('#9713 年齢だけ・両方・年齢なしの行を登録する', st.join(',') === 'created,created,created', cm.results)
const [ageOnlyId, bothId, noneId] = cm.results.map(r => r.staff_id)
const prof = async (sid) => must(await B.get(`/api/admin/staff/${sid}`), `staff ${sid}`).profile
{
  const p = await prof(ageOnlyId)
  ok('#9713 年齢だけの人: 年齢と取り込んだ日を保存し、推定の年齢として返す', p.age_entered === 34 && p.age_entered_on === today && p.age === 34 && p.age_estimated === true && p.date_of_birth == null,
    { a: p.age_entered, on: p.age_entered_on, age: p.age, est: p.age_estimated })
  const q = await prof(bothId)
  ok('#9713 両方ある人: 生年月日を保存し、年齢の列は使わない', q.date_of_birth === '2000-01-15' && q.age_entered == null && q.age_entered_on == null && q.age_estimated === false,
    { dob: q.date_of_birth, a: q.age_entered, on: q.age_entered_on })
  const n = await prof(noneId)
  ok('#9713 年齢が空の人: 年齢の列は空のまま', n.age_entered == null && n.age_entered_on == null && n.age == null, { a: n.age_entered, age: n.age })
}
// 生年月日が必須でも、CSV の年齢で満たせる（1件ずつの登録と同じ）
{
  must(await B.put('/api/admin/roster/field-settings', { required: { date_of_birth: true } }), 'require dob')
  try {
    const r = await B.post('/api/admin/roster/import/preview', { header, rows: [rows[0], rows[5]] })
    const g = (line) => (r.data.rows || []).find(x => x.line === line) || { errors: [] }
    ok('#9713 生年月日が必須のとき: 年齢だけの行は必須を満たす', r.status === 200 && !g(2).errors.length, g(2))
    ok('#9713 生年月日が必須のとき: 生年月日も年齢もない行はエラー', g(7).errors.some(e => e.includes('生年月日')), g(7))
  } finally {
    must(await B.put('/api/admin/roster/field-settings', { required: { date_of_birth: false } }), 'unrequire dob')
  }
}
// 自社雇用（ログインを作る行）でも年齢を保存する
{
  const empHeader = ['区分', '氏名', '性別', '年齢']
  const c = must(await B.post('/api/admin/roster/import/commit', { header: empHeader, rows: [{ line: 2, cells: ['自社雇用', `${PFX} 社員 八郎`, '男性', '２７'] }] }), 'commit employee')
  const r = c.results[0]
  const e = r.status === 'created' ? must(await B.get(`/api/admin/employees/${r.staff_id}`), 'employee') : null
  ok('#9713 自社雇用の行も年齢を保存し、従業員管理で推定の年齢として返す', e && e.staff.age_entered === 27 && e.staff.age === 27 && e.staff.age_estimated === true, { r, staff: e && e.staff })
}

// ---------- (1) 人材提案の年代 ----------
const dob = '1998-06-10'
const P = (must(await B.get('/api/admin/roster/partners'), 'partners').partners.find(x => x.affiliation_name === partner) || {}).affiliation_id
const dobId = must(await B.post('/api/admin/roster', { route: 'partner', name: `${PFX} 生年 九郎`, gender: 'male', partner_affiliation_id: P, date_of_birth: dob, force: true }), 'dob staff').staff_id
const post = must(await A.post('/api/admin/board/posts', { status: 'open', engagement_type: 'spot', title: `${PFX} 年代の掲載`, prefecture: '東京都', date_from: addDays(today, 20), time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 3 }), 'post').post_id
const th = must(await B.post(`/api/admin/board/posts/${post}/threads`, { body: '人材を提案します' }), 'thread').thread_id
const preview = async (sid) => must(await B.get(`/api/admin/board/threads/${th}/proposal-preview?staff_id=${sid}`), `preview ${sid}`).snapshot
{
  const s1 = await preview(ageOnlyId)
  ok('#9713 年齢だけの人の提案の年代は、推定の年齢から出す（34歳 → 30代）', s1.age_group === '30代', s1)
  const s2 = await preview(dobId)
  ok('#9713 生年月日がある人の提案の年代は、今までどおり生年月日から出す', s2.age_group === decadeOfDob(dob), { g: s2.age_group, want: decadeOfDob(dob) })
  const s3 = await preview(noneId)
  ok('#9713 生年月日も年齢もない人の提案の年代は空（今までどおり）', s3.age_group === '', s3)
  ok('#9713 提案のスナップショットに年齢・生年月日そのものは入れない', !('age_entered' in s1) && !('age' in s1) && !('date_of_birth' in s1), Object.keys(s1))
  const sent = must(await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: ageOnlyId, consent_method: 'written', consent_obtained_on: today, upstream_consent_on: today }), 'propose')
  const list = must(await A.get(`/api/admin/board/threads/${th}/proposals`), 'proposals').proposals
  const mine = list.find(p => p.proposal_id === sent.proposal_id)
  ok('#9713 提案を受けた企業にも年代（30代）が見える', mine && mine.snapshot.age_group === '30代', mine)
  const msgs = must(await A.get(`/api/admin/board/threads/${th}`), 'thread').messages
  ok('#9713 「人材を提案しました」の知らせに年代が出る（「年代不明」にならない）', msgs.some(m => m.kind === 'proposal' && m.body.includes('30代')), msgs.filter(m => m.kind === 'proposal').map(m => m.body))
}

// ---------- 年が経ったとき・他社連携（PERSIST があるとき） ----------
if (PERSIST) {
  const past = new Date(Date.now() + 9 * 3600 * 1000); past.setUTCFullYear(past.getUTCFullYear() - 2); past.setUTCDate(past.getUTCDate() - 3)
  const on = past.toISOString().slice(0, 10)
  // 入れた年齢は 29（20代）でも、2年たった今の推定の年齢は 31（30代）
  d1(`UPDATE staff_profiles SET age_entered = 29, age_entered_on = '${on}' WHERE staff_id = ${Number(noneId)}`)
  await waitServer()
  const s = await preview(noneId)
  ok('#9713 提案の年代は、入れた年齢ではなく今日の推定の年齢から出す（29歳で入れて2年 → 30代）', s.age_group === '30代', s)
  // 手入力の年代（掲示板から取り込んだ人など）があっても、年齢を入れていれば推定の年齢を使う（スタッフマスタの年代と同じ規則）
  d1(`UPDATE staff_profiles SET age_group = '50代' WHERE staff_id = ${Number(noneId)}`)
  await waitServer()
  ok('#9713 手入力の年代より推定の年齢を使う（ageGroupOf と同じ規則）', (await preview(noneId)).age_group === '30代')
  d1(`UPDATE staff_profiles SET age_entered = NULL, age_entered_on = NULL WHERE staff_id = ${Number(noneId)}`)
  await waitServer()
  ok('#9713 生年月日も年齢もなければ、手入力の年代を使う（今までどおり）', (await preview(noneId)).age_group === '50代')

  // 他社連携の人材: 所属元（sample）で年齢だけの人を B に連携し、B から提案する
  const ecode = 'w16a' + Date.now().toString(36).slice(-5)
  const E = must(await A.post('/api/admin/roster', { route: 'employee', name: `${PFX} 連携 十郎`, gender: 'male', user_code: ecode, password: 'pass1234abcd', force: true }), 'employee A').staff_id
  d1(`UPDATE staff_profiles SET age_entered = 38, age_entered_on = '${on}', date_of_birth = NULL WHERE staff_id = ${Number(E)}`)
  await waitServer()
  const share = must(await A.get(`/api/admin/roster/${E}/share-code`), 'share-code')
  const terms = must(await B.get('/api/admin/roster/lookup?code=' + encodeURIComponent(share.global_staff_code)), 'lookup').consent
  const link = must(await B.post('/api/admin/roster/link', { code: share.global_staff_code, agreed: true, consent_version: terms.version }), 'link')
  const sl = await preview(link.staff_id)
  ok('#9713 他社連携の人材の提案の年代は、所属元の推定の年齢から出す（38歳で入れて2年 → 40代）', sl.age_group === '40代', sl)
} else {
  console.log('SKIP  PERSIST がないので、年が経ったときの年代・他社連携の人材の年代は確かめない')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
