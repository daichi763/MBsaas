// w2-registration（#27 #37 #40 #269 #359 #377 #434 #457）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8821 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8821 node scripts/test-w2-registration.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8821'
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
const uid = () => Math.random().toString(36).slice(2, 8)
const admin = client(await login('sample', 'admin'))
const setRequired = (required) => admin.put('/api/admin/roster/field-settings', { required })
const emp = (extra = {}) => ({ route: 'employee', name: 'W2 登録 ' + uid(), gender: 'male', user_code: 'w2r' + uid(), password: 'pass1234', ...extra })

// ---------- #434 電話番号・メールを必須項目に選べる ----------
{
  const fs = (await admin.get('/api/admin/roster/field-settings')).data.fields
  ok('#434 必須項目の設定に電話番号・メールがある', fs.some(f => f.code === 'phone') && fs.some(f => f.code === 'email'), fs.map(f => f.code))
  const ac = fs.find(f => f.code === 'affiliation_contact')
  ok('#27 所属先担当者名は③取引先のみが対象と返す', ac && Array.isArray(ac.only) && ac.only.join() === 'partner_manual' && ac.note, ac)
}

// ---------- #27 所属先担当者名を必須にしても②自社雇用は登録できる ----------
{
  await setRequired({ affiliation_contact: true })
  const r1 = await admin.post('/api/admin/roster', emp())
  ok('#27 所属先担当者名が必須でも②従業員管理から登録できる', r1.status === 200 && r1.data.staff_id, r1)
  const r2 = await admin.post('/api/admin/roster', { route: 'partner', name: 'W2 取引先 ' + uid(), gender: 'female', new_partner_name: 'W2取引先' + uid() })
  ok('#27 ③取引先からは所属先担当者名がないと登録できない', r2.status === 400 && /所属先担当者名/.test(r2.data.error), r2)
  const r3 = await admin.post('/api/admin/roster', { route: 'partner', name: 'W2 取引先 ' + uid(), gender: 'female', new_partner_name: 'W2取引先' + uid(), affiliation_contact: '担当 太郎' })
  ok('#27 ③取引先は所属先担当者名があれば登録できる', r3.status === 200, r3)
  const r4 = await admin.post('/api/admin/roster', { route: 'skillsheet', name: 'W2 シート ' + uid(), gender: 'male' })
  ok('#27 ④スキルシートのみも登録できる', r4.status === 200, r4)
  await setRequired({ affiliation_contact: false })
}

// ---------- #434 電話・メールの必須と形式 ----------
{
  await setRequired({ phone: true, email: true })
  const a = await admin.post('/api/admin/roster', emp({ email: 'a@example.com' }))
  ok('#434 電話番号が必須のとき、電話なしの②は登録できない', a.status === 400 && /電話番号/.test(a.data.error), a)
  const b = await admin.post('/api/admin/roster', emp({ phone: '090-1234-5678' }))
  ok('#434 メールが必須のとき、メールなしの②は登録できない', b.status === 400 && /メール/.test(b.data.error), b)
  const c = await admin.post('/api/admin/roster', emp({ phone: '12-34', email: 'a@example.com' }))
  ok('#434 電話番号は10〜11桁の数字でないと登録できない', c.status === 400 && /電話番号/.test(c.data.error), c)
  const d = await admin.post('/api/admin/roster', emp({ phone: '090-1234-5678', email: 'not-mail' }))
  ok('#434 メールの形式が正しくないと登録できない', d.status === 400 && /メール/.test(d.data.error), d)
  const e = await admin.post('/api/admin/roster', emp({ phone: '+81 90-1234-5678', email: 'w2r@example.com' }))
  ok('#434 電話・メールがあれば登録できる', e.status === 200, e)
  const f = await admin.post('/api/admin/roster', { route: 'partner', name: 'W2 取引先 ' + uid(), gender: 'male', new_partner_name: 'W2取引先' + uid(), phone: '0312345678' })
  ok('#434 ③でログインを発行しないときはメールを求めない', f.status === 200, f)
  const g = await admin.post('/api/admin/roster', { route: 'partner', name: 'W2 取引先 ' + uid(), gender: 'male', new_partner_name: 'W2取引先' + uid(), phone: '0312345678', user_code: 'w2p' + uid(), password: 'pass1234' })
  ok('#434 ③でログインを発行するときはメールを求める', g.status === 400 && /メール/.test(g.data.error), g)
  const h = await admin.post('/api/admin/roster', { route: 'skillsheet', name: 'W2 シート ' + uid(), gender: 'male' })
  ok('#434 ④スキルシートのみには電話・メールを求めない', h.status === 200, h)
  await setRequired({ phone: false, email: false })
}

// ---------- #40 通勤可能時間・生年月日・稼働開始可能日の検証 ----------
let partnerStaffId = null
{
  const bad = [
    [{ commute_minutes: '<img src=x onerror=alert(1)>' }, /通勤可能時間/],
    [{ commute_minutes: 2000 }, /通勤可能時間/],
    [{ commute_minutes: -1 }, /通勤可能時間/],
    [{ date_of_birth: '2000/01/01' }, /生年月日/],
    [{ date_of_birth: '2000-02-30' }, /生年月日/],
    [{ date_of_birth: '2999-01-01' }, /生年月日/],
    [{ available_from: '<b>x</b>' }, /稼働開始可能日/],
  ]
  for (const [extra, re] of bad) {
    const r = await admin.post('/api/admin/roster', emp(extra))
    ok(`#40 作成で不正な値を拒否する ${JSON.stringify(extra)}`, r.status === 400 && re.test(r.data.error), r)
  }
  const good = await admin.post('/api/admin/roster', { route: 'partner', name: 'W2 検証 ' + uid(), gender: 'male', new_partner_name: 'W2取引先' + uid(),
    commute_minutes: '45', date_of_birth: '1995-04-01', available_from: '2026-11-01' })
  ok('#40 正しい値なら登録できる', good.status === 200, good)
  partnerStaffId = good.data.staff_id
  const d = (await admin.get('/api/admin/staff/' + partnerStaffId)).data
  const p = d.profile || d.staff || d
  ok('#40 通勤可能時間は数値で保存される', p.commute_minutes === 45 && p.date_of_birth === '1995-04-01' && p.available_from === '2026-11-01', p)
  const u1 = await admin.put('/api/admin/staff/' + partnerStaffId, { date_of_birth: '1995/04/01' })
  ok('#40 更新でも生年月日の形式を確かめる', u1.status === 400 && /生年月日/.test(u1.data.error), u1)
  const u2 = await admin.put('/api/admin/staff/' + partnerStaffId, { date_of_birth: '1996-05-02' })
  ok('#40 更新で正しい生年月日は保存できる', u2.status === 200, u2)
}

// ---------- #377 必須を後から ON にしたときの未入力スタッフの一覧 ----------
{
  await setRequired({})
  const none = await admin.get('/api/admin/roster/field-settings/missing')
  ok('#377 必須項目がなければ一覧は空', none.status === 200 && none.data.count === 0, none)
  await setRequired({ kana: true, affiliation_contact: true })
  const r = await admin.get('/api/admin/roster/field-settings/missing')
  const row = r.data.staff.find(s => s.staff_id === partnerStaffId)
  ok('#377 フリガナを必須にすると、フリガナのない既存スタッフが出る', r.status === 200 && r.data.count > 0 && row && row.missing.includes('フリガナ'), r.data && r.data.count)
  ok('#377 ③取引先の行には所属先担当者名の不足も出る', row && row.missing.includes('所属先担当者名'), row)
  const ownRow = r.data.staff.find(s => s.affiliation_type === 'own_employee')
  ok('#377 ②自社雇用の行には所属先担当者名を出さない', !r.data.staff.some(s => s.affiliation_type === 'own_employee' && s.missing.includes('所属先担当者名')) && (!ownRow || ownRow.missing.includes('フリガナ')), ownRow)
  ok('#377 他社連携のスタッフは対象外', r.data.staff.every(s => s.affiliation_type !== 'linked_external'))
  await admin.put('/api/admin/staff/' + partnerStaffId, { kana: 'ケンショウ', affiliation_contact: '担当' })
  const r2 = await admin.get('/api/admin/roster/field-settings/missing')
  ok('#377 入力すると一覧から外れる', !r2.data.staff.some(s => s.staff_id === partnerStaffId) && r2.data.count === r.data.count - 1, [r.data.count, r2.data.count])
  await setRequired({ kana: false, affiliation_contact: false })
}

// ---------- #37 #457 案件登録（クライアントなし・テンプレートの既定） ----------
{
  const name = 'W2 社内研修 ' + uid()
  const r = await admin.post('/api/admin/projects', { project_name: name, client_id: '', report_template_id: '', project_type: 'other' })
  ok('#37 クライアントが空でも案件を登録できる', r.status === 200 && r.data.project_id, r)
  const pj = (await admin.get('/api/admin/projects/' + r.data.project_id)).data.project
  ok('#37 クライアントは NULL で保存される', pj && pj.client_id === null, pj)
  const tp = (await admin.get('/api/admin/templates')).data.templates
  const first = tp.find(t => JSON.parse(t.fields_json || '[]').length > 0)
  ok('#457 テンプレート未指定なら項目のある最初のテンプレートになる', pj && first && pj.report_template_id === first.template_id, [pj && pj.report_template_id, first && first.template_id])
  const r2 = await admin.post('/api/admin/projects', { project_name: 'W2 不正 ' + uid(), client_id: 999999 })
  ok('#37 存在しないクライアントは 400', r2.status === 400, r2)
  const r3 = await admin.post('/api/admin/projects', { project_name: 'W2 不正 ' + uid(), report_template_id: 999999 })
  ok('#457 存在しないテンプレートは 400', r3.status === 400, r3)
  const r4 = await admin.post('/api/admin/projects', { project_name: 'W2 既存 ' + uid(), client_id: 1, report_template_id: 2 })
  ok('既存クライアント・テンプレートを指定して登録できる', r4.status === 200, r4)

  // #359 同名の確認（二度押し）
  const dup = await admin.post('/api/admin/projects', { project_name: name })
  ok('#359 稼働中の同名案件があれば 409 で確認を求める', dup.status === 409 && dup.data.confirm_duplicate === true, dup)
  const p1 = await admin.post('/api/admin/projects', { project_name: 'W2 二度押し ' + name })
  const p2 = await admin.post('/api/admin/projects', { project_name: 'W2 二度押し ' + name })
  ok('#359 続けて2回送ると2回目は 409（同時の二度押しは画面の送信ロックで防ぐ）', p1.status === 200 && p2.status === 409, [p1.status, p2.status])
  const again = await admin.post('/api/admin/projects', { project_name: name, allow_duplicate: true })
  ok('#359 確認済みなら同名でも登録できる', again.status === 200, again)
}

// ---------- #269 #359 クライアントの評価の範囲と同名の確認 ----------
{
  const name = 'W2 クライアント ' + uid()
  const bad = await admin.post('/api/admin/clients', { client_name: name, client_rating: 6 })
  ok('#269 登録で評価 6 は 400', bad.status === 400 && /評価/.test(bad.data.error), bad)
  const r = await admin.post('/api/admin/clients', { client_name: name })
  ok('クライアントを登録できる（client_id を返す）', r.status === 200 && r.data.client_id, r)
  const cid = r.data.client_id
  const dup = await admin.post('/api/admin/clients', { client_name: '  ' + name + ' ' })
  ok('#359 同名のクライアントは 409 で確認を求める', dup.status === 409 && dup.data.confirm_duplicate === true, dup)
  const dupOk = await admin.post('/api/admin/clients', { client_name: name, allow_duplicate: true })
  ok('#359 確認済みなら同名でも登録できる', dupOk.status === 200, dupOk)
  for (const v of [0, 6, -1, 'abc', 2.5]) {
    const u = await admin.put('/api/admin/clients/' + cid, { client_rating: v })
    ok(`#269 更新で評価 ${JSON.stringify(v)} は 400`, u.status === 400 && /評価/.test(u.data.error), u)
  }
  const u = await admin.put('/api/admin/clients/' + cid, { client_rating: '4' })
  const got = (await admin.get('/api/admin/clients/' + cid)).data.client
  ok('#269 評価 4 は保存できる', u.status === 200 && got.client_rating === 4, [u, got && got.client_rating])
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
