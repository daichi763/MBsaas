// 本部画面の企業管理（作業単位 w4-hq-devops: #254 #321 #366 #378 #398 #517）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8824 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8824 PERSIST=<保存先> node scripts/test-w4-hq-devops.mjs
//   PERSIST を指定すると、ローカルの D1 を直接書き換える確認（利用が減った企業の印）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8824'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w4hq-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const SUF = String(Date.now()).slice(-6)

const hqLogin = await rawLogin('', 'hq')
if (hqLogin.status !== 200) { console.log('本部ユーザーでログインできません', hqLogin); process.exit(1) }
const hq = client(hqLogin.cookie)
const admin = client((await rawLogin('sample', 'admin')).cookie)

// ---------- 権限 ----------
ok('企業の管理者は本部の企業一覧を使えない（403）', (await admin.get('/api/hq/companies')).status === 403)

// ---------- #517 企業一覧の推移・印 ----------
{
  const r = await hq.get('/api/hq/companies')
  const co = (r.data?.companies || [])[0] || {}
  ok('#517 一覧は直近30日と前の30日の日報数・シフト数を返す', r.status === 200 && ['reports_30d', 'reports_prev_30d', 'shifts_30d', 'shifts_prev_30d'].every(k => typeof co[k] === 'number'), co)
  ok('#517 増減率・最終シフト登録・管理者の最終ログイン・印を返す', ['reports_change', 'shifts_change', 'last_shift_created_at', 'last_admin_login_at', 'usage_drop', 'no_recent_shift', 'over_limit'].every(k => k in co), Object.keys(co))
  ok('#517 判定の基準（減少率・最低件数・日数）を返す', r.data?.rules?.drop_rate === 0.3 && r.data?.rules?.no_shift_days === 14, r.data?.rules)
  const drop = (cur, prev) => prev >= 10 && cur <= prev * 0.7
  ok('#517 「利用減」の印は日報かシフトの3割以上の減少と一致する', (r.data?.companies || []).every(c => c.usage_drop === (drop(c.reports_30d, c.reports_prev_30d) || drop(c.shifts_30d, c.shifts_prev_30d))))
  ok('#517 本部専用の企業行は一覧に出ない', !(r.data?.companies || []).some(c => c.active_status === 'internal'))
}

// ---------- #398 企業登録の検証 ----------
const code = `w4hq${SUF}`
{
  let r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: 'テスト企業A' })
  ok('#398 初期管理者のIDがないと登録できない（400）', r.status === 400 && r.data?.field === 'admin_code', r)
  r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: 'ab c!', company_name: 'テスト', admin_code: 'admin' })
  ok('#398 空白・記号を含む会社コードは登録できない（400）', r.status === 400 && r.data?.field === 'company_code', r)
  r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: 'x', company_name: 'テスト', admin_code: 'admin' })
  ok('#398 1文字の会社コードは登録できない（400）', r.status === 400, r)
  r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code + 'z', company_name: 'テスト', admin_code: 'admin', user_limit: 0 })
  ok('#254 ユーザー上限 0 は登録できない（400）', r.status === 400 && r.data?.field === 'user_limit', r)
  r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code + 'z', company_name: 'テスト', admin_code: 'admin', plan: 'gold' })
  ok('#254 決められていないプランは登録できない（400）', r.status === 400, r)
  // 全角・大文字で入力しても、半角の小文字にそろえて保存する
  const wide = code.toUpperCase().replace(/[A-Z0-9]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0))
  r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: wide, company_name: 'テスト企業A', admin_code: 'ａｄｍｉｎ', user_limit: '' })
  ok('#398 全角・大文字の会社コードは半角の小文字にそろえて登録する', r.status === 200 && r.data?.company_code === code && !!r.data?.admin_temp_password, r)
  const pw = r.data?.admin_temp_password
  const login = await rawLogin(code, 'admin', pw)
  ok('#398 登録した会社コード・管理者ID（全角で入力→半角で保存）と仮パスワードでログインできる', login.status === 200, login)
  r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code.toUpperCase(), company_name: '重複', admin_code: 'admin' })
  ok('#398 大文字・小文字だけが違う会社コードは重複として 409', r.status === 409 && r.data?.error === '会社コードが重複しています', r)
}
const list1 = (await hq.get('/api/hq/companies')).data?.companies || []
const created = list1.find(c => c.company_code === code)
ok('#254 ユーザー上限を空欄で登録すると上限なし（NULL）になる', created && created.user_limit === null && created.over_limit === false, created)
ok('#517 シフトを登録していない企業には「シフト登録なし」の印が付く', created && created.no_recent_shift === true && created.last_shift_created_at === null, created)

// ---------- #254 企業設定の保存の検証 ----------
if (created) {
  const id = created.company_id
  const bad = [
    [{ user_limit: 0 }, 'ユーザー上限 0'], [{ user_limit: -3 }, 'ユーザー上限が負の数'], [{ user_limit: 1.5 }, 'ユーザー上限が整数でない'],
    [{ plan: 'gold' }, 'プランが不正'], [{ billing_status: 'x' }, '請求状態が不正'], [{ maturity_level: 9 }, '成熟度が範囲外'], [{ active_status: 'deleted' }, '利用状態が不正'],
  ]
  for (const [body, label] of bad) {
    const r = await hq.put(`/api/hq/companies/${id}`, body)
    ok(`#254 ${label}は 400`, r.status === 400, r)
  }
  let r = await hq.put(`/api/hq/companies/${id}`, { user_limit: 5, plan: 'standard', maturity_level: 3 })
  let d = (await hq.get(`/api/hq/companies/${id}`)).data
  ok('#254 正しい値は保存できる', r.status === 200 && d?.company?.user_limit === 5 && d?.company?.plan === 'standard' && d?.company?.maturity_level === 3, { r, c: d?.company })
  r = await hq.put(`/api/hq/companies/${id}`, { user_limit: null })
  d = (await hq.get(`/api/hq/companies/${id}`)).data
  ok('#254 ユーザー上限を空欄（null）で保存すると上限なしになる（前の値が残らない）', r.status === 200 && d?.company?.user_limit === null && d?.company?.plan === 'standard', d?.company)
  r = await hq.put(`/api/hq/companies/${id}`, { user_limit: '' })
  ok('#254 ユーザー上限の空文字も上限なしとして受け付ける', r.status === 200, r)
  ok('#254 送る項目がなければ 400', (await hq.put(`/api/hq/companies/${id}`, {})).status === 400)
  ok('#254 存在しない企業は 404', (await hq.put('/api/hq/companies/999999', { plan: 'basic' })).status === 404)
}

// ---------- #321 #366 契約ユーザー数の超過・ユーザー一覧の状態 ----------
{
  const sample = list1.find(c => c.company_code === 'sample')
  const sid = sample?.company_id
  const before = sample?.user_limit
  await hq.put(`/api/hq/companies/${sid}`, { user_limit: 1 })
  const list = (await hq.get('/api/hq/companies')).data?.companies || []
  const s = list.find(c => c.company_id === sid)
  ok('#321 利用数が上限を超えた企業に over_limit が付く', s && s.user_count > 1 && s.over_limit === true, s)
  const d = (await hq.get(`/api/hq/companies/${sid}`)).data
  ok('#321 企業詳細も上限超過を返す', d?.usage?.over_limit === true && d?.usage?.user_limit === 1 && d?.usage?.user_count === s?.user_count, d?.usage)
  const cu = await admin.get('/api/admin/contract-usage')
  ok('#321 企業の管理者は自社の契約ユーザー数と超過を確かめられる', cu.status === 200 && cu.data?.over_limit === true && cu.data?.user_limit === 1 && cu.data?.user_count === s?.user_count && cu.data?.remaining < 0, cu)
  const users = d?.users || []
  ok('#366 ユーザー一覧は課金対象かどうか（billable）と在籍状況を返す', users.length > 0 && users.every(u => 'billable' in u && 'employment_status' in u && 'linked' in u), users[0])
  ok('#366 課金対象の人数は一覧の利用数（user_count）と一致する', users.filter(u => u.billable).length === s?.user_count, { billable: users.filter(u => u.billable).length, user_count: s?.user_count })
  ok('#366 ログインなし（roster_only）と退職・停止の行は課金対象にしない', users.filter(u => u.role === 'roster_only' || u.status !== 'active').every(u => !u.billable))
  ok('#517 企業詳細は直近6か月の月別の推移を返す', Array.isArray(d?.monthly) && d.monthly.length === 6 && d.monthly.every(m => /^\d{4}-\d{2}$/.test(m.month) && typeof m.reports === 'number' && typeof m.shifts === 'number' && typeof m.working_staff === 'number'), d?.monthly)
  await hq.put(`/api/hq/companies/${sid}`, { user_limit: before ?? null })
  const cu2 = await admin.get('/api/admin/contract-usage')
  ok('#321 上限を戻すと超過ではなくなる', cu2.data?.over_limit === (before != null && cu2.data.user_count > before), cu2.data)

  // 日報をすべて前の30日の期間へ動かして（直近30日は0件）、利用が減った企業の印が付くことを確かめる（テスト用の D1 のみ）
  if (PERSIST) {
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
    const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - 29)
    const d30 = x.toISOString().slice(0, 10)
    sql(`UPDATE daily_reports SET work_date = date('${d30}', '-5 days') WHERE company_id = ${Number(sid)}`)
    const after = ((await hq.get('/api/hq/companies')).data?.companies || []).find(c => c.company_id === sid)
    ok('#517 日報が前の30日（10件以上）から3割以上減ると「利用減」の印が付く', after && after.reports_30d === 0 && after.reports_prev_30d >= 10 && after.usage_drop === true && after.reports_change === -1, after)
  } else skip('#517 利用が減った企業の印')
}

// ---------- #378 テンプレートの項目の検証 ----------
{
  const name = `テストテンプレート${SUF}`
  const bad = [
    [[], '項目がない'],
    [[{ key: 'calls', label: '架電数', type: 'number' }, { key: 'calls', label: '架電数2', type: 'number' }], 'キーが重複'],
    [[{ key: 'Calls', label: 'A', type: 'number' }, { key: 'calls', label: 'B', type: 'number' }], '大文字・小文字だけ違うキー'],
    [[{ key: '', label: '空', type: 'text' }], 'キーが空欄'],
    [[{ key: '架電', label: '架電', type: 'number' }], 'キーに全角'],
    [[{ key: 'calls', label: '架電数', type: 'Number' }], 'タイプの書き間違い（Number）'],
    [[{ key: 'incident_note', label: 'インシデント', type: 'textarea' }], '予約されたキー'],
    [[{ key: 'memo', label: 'メモ', type: 'text', maxLength: 99999 }], '文字数の上限が範囲外'],
    [Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, label: `項目${i}`, type: 'number' })), '項目が51個'],
    ['calls,架電数,number', '配列でない'],
  ]
  for (const [fields, label] of bad) {
    const r = await hq.post('/api/hq/templates', { template_name: name, fields })
    ok(`#378 ${label}のテンプレートは配信できない（400）`, r.status === 400 && typeof r.data?.error === 'string', r)
  }
  ok('#378 テンプレート名がないと 400', (await hq.post('/api/hq/templates', { template_name: ' ', fields: [{ key: 'a', label: 'A', type: 'number' }] })).status === 400)
  const good = [{ key: 'calls', label: ' 架電数 ', type: 'number', required: true }, { key: 'free', label: '', type: 'textarea', maxLength: 500, extra: 'x' }, { key: 'memo', label: 'メモ' }]
  let r = await hq.post('/api/hq/templates', { template_name: name, fields: good })
  ok('#378 正しい項目のテンプレートは配信できる', r.status === 200, r)
  const t = ((await hq.get('/api/hq/templates')).data?.templates || []).find(x => x.template_name === name)
  ok('#378 保存した項目はキー・表示名・タイプ・必須・文字数の上限にそろえる（不要な値は捨てる）', t && JSON.stringify(t.fields) === JSON.stringify([
    { key: 'calls', label: '架電数', type: 'number', required: true }, { key: 'free', label: 'free', type: 'textarea', maxLength: 500 }, { key: 'memo', label: 'メモ', type: 'text' }]), t?.fields)
  r = await hq.post('/api/hq/templates', { template_name: name, fields: good })
  ok('#378 同じ名前の本部テンプレートは 409', r.status === 409, r)
  const at = await admin.get('/api/admin/templates')
  ok('#378 配信したテンプレートは企業の案件設定で選べる', (at.data?.templates || []).some(x => x.template_name === name))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  - ' + f.name) }
process.exit(failed.length ? 1 : 0)
