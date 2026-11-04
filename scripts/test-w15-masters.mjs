// マスタの入力の見直し（Sprint 15。w15-masters。#9701 #9703 #9704 #9709 #9710）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   #9701 クライアントの郵便番号（全角・ハイフンなしを「123-4567」にそろえる。形の違う値は受け付けない）とホームページ
//   #9709 協力会社の項目（郵便番号・住所・代表電話・ホームページ・代表者・インボイス・先方の担当者の部署・社内担当者）。URL は http/https だけ。
//         一覧・詳細に出ること、統合で統合先の空欄が統合元の値で埋まり、新しい項目が失われないこと
//   #9710 生年月日が分からないときの年齢（年齢＋入力した日）。推定の年齢・年代、生年月日を入れたら年齢は空になること、必須の生年月日を年齢で満たせること
//   #9704 全角の数字を半角にそろえて保存する（従業員管理の数値の項目・通勤可能時間・年齢）
//   #9703 変更履歴は画面の表示だけの変更なので、API では履歴に年齢の変更が残ることだけを確かめる
//   PERSIST（--persist-to の保存先）があれば、入力した日を過去にずらして、年が経つと推定の年齢が増えることも確かめる
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> node scripts/test-w15-masters.mjs
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
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
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

const PFX = 'MS' + Date.now().toString(36).slice(-4).toUpperCase()
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const admin = client(await login('sample', 'admin'))

// ---------- #9701 クライアントの郵便番号・ホームページ ----------
{
  const r = must(await admin.post('/api/admin/clients', { client_name: `${PFX}商事`, postal_code: '１２３４５６７', address: '東京都千代田区1-1', website_url: 'https://example.co.jp', allow_duplicate: true }), 'client')
  const C = r.client_id
  let d = must(await admin.get(`/api/admin/clients/${C}`), 'client detail').client
  ok('#9701 登録: 全角・ハイフンなしの郵便番号を「123-4567」にそろえて保存する', d.postal_code === '123-4567' && d.address === '東京都千代田区1-1', d)
  ok('#9709 クライアントのホームページを保存する', d.website_url === 'https://example.co.jp/', d.website_url)
  must(await admin.put(`/api/admin/clients/${C}`, { client_name: `${PFX}商事`, postal_code: '〒１０００００５' }), 'put postal')
  d = must(await admin.get(`/api/admin/clients/${C}`), 'client detail 2').client
  ok('#9701 編集: 〒付き・全角でも「100-0005」にそろえる。送らない項目（住所・URL）は変えない', d.postal_code === '100-0005' && d.address === '東京都千代田区1-1' && !!d.website_url, d)
  const bad = await admin.put(`/api/admin/clients/${C}`, { client_name: `${PFX}商事`, postal_code: '12-34' })
  ok('#9701 7桁でない郵便番号は受け付けない', bad.status === 400 && /郵便番号/.test(bad.data.error), bad)
  const badUrl = await admin.put(`/api/admin/clients/${C}`, { client_name: `${PFX}商事`, website_url: 'javascript:alert(1)' })
  ok('#9709 http/https 以外の URL は受け付けない', badUrl.status === 400 && /URL/.test(badUrl.data.error), badUrl)
  const badNew = await admin.post('/api/admin/clients', { client_name: `${PFX}誤り`, postal_code: 'abc', allow_duplicate: true })
  ok('#9701 登録でも形の違う郵便番号は受け付けない（登録しない）', badNew.status === 400, badNew)
  must(await admin.put(`/api/admin/clients/${C}`, { client_name: `${PFX}商事`, postal_code: '', website_url: '' }), 'clear')
  d = must(await admin.get(`/api/admin/clients/${C}`), 'client detail 3').client
  ok('#9701 空欄で送ると消せる', d.postal_code === null && d.website_url === null, d)
  const list = must(await admin.get('/api/admin/clients'), 'clients').clients
  ok('#9701 一覧にも郵便番号・住所の列が出る', list.some(c => c.client_id === C && 'postal_code' in c && c.address === '東京都千代田区1-1'), list.find(c => c.client_id === C))
}

// ---------- #9709 協力会社の項目 ----------
const partnerList = async () => must(await admin.get('/api/admin/roster/partners'), 'partners').partners
{
  const body = {
    affiliation_name: `${PFX}工業`, postal_code: '５３００００１', address: '大阪府大阪市北区梅田1-1', company_phone: '０６－１２３４－５６７８',
    website_url: 'https://kougyou.example.jp/about', representative_name: '代表 太郎', invoice_number: 'ｔ１２３４５６７８９０１２３',
    contact_name: '先方 花子', contact_department: '営業部 課長', phone: '090-1111-2222', email: 'hanako@example.jp', internal_contact_name: '自社 次郎', memo: 'メモ',
  }
  const X = must(await admin.post('/api/admin/roster/partners', body), 'partner').affiliation_id
  const p = must(await admin.get(`/api/admin/roster/partners/${X}`), 'partner detail').partner
  ok('#9709 協力会社の登録: 郵便番号・住所・代表電話・URL・代表者・インボイス・先方の部署・社内担当者を保存して詳細に返す',
    p.postal_code === '530-0001' && p.address === body.address && p.company_phone === '06-1234-5678' && p.website_url === 'https://kougyou.example.jp/about'
      && p.representative_name === '代表 太郎' && p.invoice_number === 'T1234567890123' && p.contact_department === '営業部 課長' && p.internal_contact_name === '自社 次郎', p)
  const row = (await partnerList()).find(x => x.affiliation_id === X)
  ok('#9709 一覧にも住所・URL・社内担当者を返す（区別に使う）', row && row.address === body.address && row.website_url && row.internal_contact_name === '自社 次郎', row)
  // 住所だけを入れた協力会社も、一覧に出る（所属会社名だけの行を隠す判定に新しい項目も入れた）
  const A = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}住所だけ`, address: '福岡県福岡市' }), 'partner A').affiliation_id
  ok('#9709 住所だけを入れた協力会社も一覧に出る', (await partnerList()).some(x => x.affiliation_id === A))
  for (const [k, v, re] of [['website_url', 'ftp://example.jp', /URL/], ['website_url', 'example.jp', /URL/], ['postal_code', '123456', /郵便番号/], ['invoice_number', 'T123', /インボイス/], ['company_phone', '123', /電話/]]) {
    const r = await admin.put(`/api/admin/roster/partners/${X}`, { [k]: v })
    ok(`#9709 受け付けない値: ${k}=${v}`, r.status === 400 && re.test(r.data.error), r)
  }
  // 編集: 送った項目だけを変える
  must(await admin.put(`/api/admin/roster/partners/${X}`, { website_url: 'http://kougyou.example.jp', internal_contact_name: '' }), 'edit')
  const p2 = must(await admin.get(`/api/admin/roster/partners/${X}`), 'partner detail 2').partner
  ok('#9709 編集: 送った項目だけを変え、空欄は消す', p2.website_url === 'http://kougyou.example.jp/' && p2.internal_contact_name === null && p2.address === body.address, p2)
  // 統合: 統合先の空欄は統合元の値で埋め、統合先に値があればそのまま
  const Y = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}(株)工業`, address: '統合先の住所', contact_department: '' }), 'partner Y').affiliation_id
  must(await admin.post(`/api/admin/roster/partners/${X}/merge`, { into_id: Y }), 'merge')
  const py = must(await admin.get(`/api/admin/roster/partners/${Y}`), 'partner Y detail').partner
  ok('#9709 統合: 統合先の空欄（URL・郵便番号・インボイス・先方の部署など）は統合元の値で埋まり、統合先の住所は変えない',
    py.address === '統合先の住所' && py.website_url === 'http://kougyou.example.jp/' && py.postal_code === '530-0001' && py.invoice_number === 'T1234567890123'
      && py.contact_department === '営業部 課長' && py.company_phone === '06-1234-5678' && py.representative_name === '代表 太郎' && py.memo === 'メモ', py)
}

// ---------- #9710 年齢（生年月日が分からないとき） ----------
let S = null
{
  const P = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}人材` }), 'partner P').affiliation_id
  const bad = await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 年齢 誤り`, gender: 'male', partner_affiliation_id: P, age_entered: '5', force: true })
  ok('#9710 範囲外の年齢は受け付けない', bad.status === 400 && /年齢/.test(bad.data.error), bad)
  S = must(await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 年齢 太郎`, gender: 'male', partner_affiliation_id: P, age_entered: '３０', commute_minutes: '６０', force: true }), 'create').staff_id
  let d = must(await admin.get(`/api/admin/staff/${S}`), 'staff').profile
  ok('#9710 協力会社から作成: 全角の年齢を半角にして、年齢と入力した日（今日）を保存する', d.age_entered === 30 && d.age_entered_on === today, { a: d.age_entered, on: d.age_entered_on })
  ok('#9710 推定の年齢（age_estimated）として返す', d.age === 30 && d.age_estimated === true && d.date_of_birth === null, { age: d.age, est: d.age_estimated })
  ok('#9704 通勤可能時間の全角の数字も半角にして保存する', d.commute_minutes === 60, d.commute_minutes)
  // 編集: 同じ年齢を送っても入力した日は変えない。違う年齢なら入力した日を今日にする
  must(await admin.put(`/api/admin/staff/${S}`, { age_entered: 30 }), 'same age')
  d = must(await admin.get(`/api/admin/staff/${S}`), 'staff 2').profile
  ok('#9710 同じ年齢で保存しても、年齢・入力した日は変わらない', d.age_entered === 30 && d.age_entered_on === today, d)
  must(await admin.put(`/api/admin/staff/${S}`, { age_entered: '３２歳' }), 'age 32')
  d = must(await admin.get(`/api/admin/staff/${S}`), 'staff 3').profile
  ok('#9710 スタッフ詳細の編集で年齢を変えられる（「歳」付き・全角も受け付ける）', d.age_entered === 32 && d.age === 32, d)
  // 生年月日を入れたら、そちらを使い、年齢の欄は空にする
  must(await admin.put(`/api/admin/staff/${S}`, { date_of_birth: '1990-04-01', age_entered: 40 }), 'dob')
  d = must(await admin.get(`/api/admin/staff/${S}`), 'staff 5').profile
  ok('#9710 生年月日を入れたら年齢の欄は使わない（空にして、生年月日からの満年齢を返す）', d.age_entered === null && d.age_entered_on === null && d.age_estimated === false && d.age >= 30, d)
  // 生年月日を消して年齢を入れ直す
  must(await admin.put(`/api/admin/staff/${S}`, { date_of_birth: null, age_entered: 45 }), 'back to age')
  d = must(await admin.get(`/api/admin/staff/${S}`), 'staff 6').profile
  ok('#9710 生年月日を消すと、年齢の欄を使える', d.date_of_birth === null && d.age_entered === 45 && d.age === 45 && d.age_estimated === true, d)
}
// 必須の生年月日は、年齢で満たせる
{
  must(await admin.put('/api/admin/roster/field-settings', { required: { date_of_birth: true } }), 'require dob')
  try {
    const P = (await partnerList())[0].affiliation_id
    const none = await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 必須 一郎`, gender: 'male', partner_affiliation_id: P, force: true })
    ok('#9710 生年月日が必須で、生年月日も年齢もなければ登録しない', none.status === 400 && /生年月日/.test(none.data.error), none)
    const withAge = await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 必須 二郎`, gender: 'male', partner_affiliation_id: P, age_entered: 28, force: true })
    ok('#9710 生年月日が必須でも、年齢を入れれば登録できる', withAge.status === 200, withAge)
    if (withAge.status === 200) {
      const miss = must(await admin.get('/api/admin/roster/field-settings/missing'), 'missing')
      ok('#9710 必須の未入力の一覧に、年齢を入れた人は出ない', !miss.staff.some(s => s.staff_id === withAge.data.staff_id), miss.staff.filter(s => s.staff_id === withAge.data.staff_id))
      const clear = await admin.put(`/api/admin/staff/${withAge.data.staff_id}`, { date_of_birth: null, age_entered: null })
      ok('#9710 生年月日が必須なら、年齢も消す保存は受け付けない', clear.status === 400 && /生年月日/.test(clear.data.error), clear)
    }
  } finally {
    must(await admin.put('/api/admin/roster/field-settings', { required: { date_of_birth: false } }), 'unrequire dob')
  }
}

// ---------- 従業員管理: 年齢と全角の数字（#9710 #9704） ----------
{
  const code = 'w15' + Date.now().toString(36).slice(-5)
  const E = must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 社員 三郎`, gender: 'male', user_code: code, password: 'pass1234abcd', force: true }), 'employee').staff_id
  const put = await admin.put(`/api/admin/employees/${E}`, {
    profile: { name: `${PFX} 社員 三郎`, gender: 'male', date_of_birth: null, age_entered: '２５' },
    scheduled_days_week: '５', scheduled_days_month: '２２', scheduled_hours: '７．５', base_salary: '２５０，０００', dependents_count: '',
  })
  ok('（前提）従業員管理の保存', put.status === 200, put)
  const e = must(await admin.get(`/api/admin/employees/${E}`), 'employee detail')
  ok('#9704 従業員管理: 全角の労働日数・労働時間・基本給（カンマ付き）を半角の数にして保存する',
    e.record.scheduled_days_week === 5 && e.record.scheduled_days_month === 22 && e.record.scheduled_hours === 7.5 && e.record.base_salary === 250000 && e.record.dependents_count === null, e.record)
  ok('#9710 従業員管理: 年齢を保存し、推定の年齢として返す', e.staff.age_entered === 25 && e.staff.age === 25 && e.staff.age_estimated === true, e.staff)
  const bad = await admin.put(`/api/admin/employees/${E}`, { scheduled_days_week: '五日' })
  ok('#9704 数として読めない値は保存しない（黙って空にしない）', bad.status === 400 && /所定労働日数/.test(bad.data.error), bad)
  const hist = must(await admin.get(`/api/admin/employees/${E}/history`), 'history').logs
  ok('#9703 変更履歴に年齢の変更が「年齢（生年月日が分からないとき）」として残る', hist.some(l => l.field === 'age_entered' && l.new_value === '25' && /年齢/.test(l.label)), hist.slice(0, 5))
}

// ---------- 年が経つと推定の年齢が増える・年代（PERSIST があるとき） ----------
if (PERSIST) {
  const past = new Date(Date.now() + 9 * 3600 * 1000); past.setUTCFullYear(past.getUTCFullYear() - 2); past.setUTCDate(past.getUTCDate() - 3)
  const on = past.toISOString().slice(0, 10)
  d1(`UPDATE staff_profiles SET age_entered = 29, age_entered_on = '${on}', date_of_birth = NULL WHERE staff_id = ${Number(S)}`)
  await waitServer()
  const d = must(await admin.get(`/api/admin/staff/${S}`), 'staff aged').profile
  ok('#9710 入力した日から2年たつと、推定の年齢は2つ増える', d.age === 31 && d.age_estimated === true && d.age_entered === 29, { age: d.age, on: d.age_entered_on })
  // 他社連携の行の年代は、所属元の推定の年齢から出す（生年月日・年齢そのものは渡さない）
  const hq = client(await login('sample', 'hq'))
  const code = 'ms' + Date.now().toString(36).slice(-6)
  const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `年代テスト${code}`, admin_code: 'admin', admin_password: 'pass1234', admin_name: '連携先管理者' })
  ok('（前提）連携先の会社を作成', cr.status === 200, cr)
  if (cr.status === 200) {
    const admin2 = client(await login(code, 'admin'))
    const ecode = 'w15l' + Date.now().toString(36).slice(-5)
    const E = must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 連携 四郎`, gender: 'male', user_code: ecode, password: 'pass1234abcd', force: true }), 'employee 2').staff_id
    d1(`UPDATE staff_profiles SET age_entered = 38, age_entered_on = '${on}', date_of_birth = NULL WHERE staff_id = ${Number(E)}`)
    await waitServer()
    const share = must(await admin.get(`/api/admin/roster/${E}/share-code`), 'share-code')
    const terms = must(await admin2.get('/api/admin/roster/consent-terms'), 'terms')
    const link = must(await admin2.post('/api/admin/roster/link', { code: share.global_staff_code, agreed: true, consent_version: terms.version }), 'link')
    const lp = must(await admin2.get(`/api/admin/staff/${link.staff_id}`), 'linked staff').profile
    ok('#9710 他社連携の行: 年代は所属元の推定の年齢（38→40歳）から出し、年齢・入力した日は渡さない',
      lp.age_group === '40代' && lp.age_entered == null && lp.age_entered_on == null && lp.age == null, { g: lp.age_group, a: lp.age_entered, age: lp.age })
  }
} else {
  console.log('SKIP  PERSIST がないので、年が経ったときの推定の年齢・年代は確かめない')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
