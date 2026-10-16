// 管理者アカウントの管理・パスワードの変更と再発行・停止企業の公開ページ（作業単位 w2-account-admin: #25 #43 #44 #45 #66 #372）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8810 --persist-to <保存先> --var DEMO_MODE:false で起動していること。
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w2-account-admin.mjs
//   PERSIST を指定すると、ローカルの D1 を直接読む確認（本部ユーザーの所属・再設定リンクの発行）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// wrangler d1 execute を待つ間に keep-alive の接続が切られることがあるため、接続エラーは1回だけやり直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w2acc-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = String(Date.now()).slice(-6)

// ---------- #372 本部ユーザーを企業1から切り離す ----------
const hqLogin = await rawLogin('', 'hq')
ok('#372 本部は会社コードを空欄にしてログインできる', hqLogin.status === 200 && hqLogin.data?.redirect === '/hq', hqLogin)
ok('#372 以前の会社コード（sample）を入れても本部としてログインできる', (await rawLogin('sample', 'hq')).data?.redirect === '/hq')
ok('#372 会社の利用者は会社コードなしではログインできない', (await rawLogin('', 'admin')).status === 401)
const hq = client(hqLogin.cookie)
{
  const list = await hq.get('/api/hq/companies')
  const co1 = (list.data?.companies || []).find(c => c.company_id === 1)
  ok('#372 本部専用の企業行は企業一覧に出ない', list.status === 200 && !list.data.companies.some(c => c.active_status === 'internal'), list.data?.companies?.map(c => [c.company_code, c.active_status]))
  const d = await hq.get('/api/hq/companies/1')
  ok('#372 企業1のユーザー一覧に本部ユーザーが出ない', d.status === 200 && !d.data.users.some(u => u.role === 'system_admin'), d.data?.users?.filter(u => u.role === 'system_admin'))
  ok('#372 企業1のユーザー数（課金人数）に本部ユーザーを数えない', co1 && co1.user_count === d.data.users.filter(u => u.status === 'active' && u.role !== 'roster_only').length, { co1, n: d.data?.users?.length })
  if (PERSIST) {
    const r = sql(`SELECT u.company_id, c.company_code, c.active_status FROM users u JOIN companies c ON c.company_id = u.company_id WHERE u.user_id = 100`)
    ok('#372 本部ユーザーは本部専用の企業行（internal）に所属する', r[0]?.active_status === 'internal' && r[0]?.company_id !== 1, r)
  } else skip('#372 本部ユーザーの所属')
}

// ---------- #25 #44 本部の企業登録（管理者のメール・仮パスワード） ----------
const coCode = `w2aa${SUF}`
{
  const bad = await hq.post('/api/hq/companies', { company_code: coCode, company_name: 'W2AA 不正メール', admin_code: 'boss', admin_email: 'not-an-email' })
  ok('#25 初期管理者のメールアドレスの形式を確かめる', bad.status === 400, bad)
}
const created = await hq.post('/api/hq/companies', { company_code: coCode, company_name: `W2AA テスト${SUF}`, admin_code: 'boss', admin_name: '社長 太郎', admin_email: `boss${SUF}@example.com` })
ok('#25 #44 企業と初期管理者（メールあり・パスワード空欄）を登録でき、仮パスワードが返る', created.status === 200 && typeof created.data.admin_temp_password === 'string' && created.data.admin_temp_password.length >= 8, created)
ok('#25 同じ会社コードは 409', (await hq.post('/api/hq/companies', { company_code: coCode, company_name: 'dup' })).status === 409)
const coId = (await hq.get('/api/hq/companies')).data.companies.find(c => c.company_code === coCode)?.company_id
let boss = client(await login(coCode, 'boss', created.data.admin_temp_password))
let boss2Pw = ''
{
  const me = await boss.get('/api/auth/me')
  ok('#25 初期管理者のメールアドレスが保存されている', me.data?.email === `boss${SUF}@example.com`, me.data)
  ok('#43 仮パスワードでログインすると変更を求める（must_change_password）', me.data?.must_change_password === true, me.data)
  const short = await boss.post('/api/auth/change-password', { current_password: created.data.admin_temp_password, new_password: 'short' })
  ok('#43 8文字未満の新しいパスワードは 400', short.status === 400, short)
  const ch = await boss.post('/api/auth/change-password', { current_password: created.data.admin_temp_password, new_password: 'boss-pass-1' })
  ok('#43 管理者が自分のパスワードを変更できる', ch.status === 200, ch)
  ok('#43 変更すると変更の要求が消える', (await boss.get('/api/auth/me')).data?.must_change_password === false)
  ok('#43 新しいパスワードでログインできる', (await rawLogin(coCode, 'boss', 'boss-pass-1')).status === 200)
}

// ---------- #44 管理者アカウント（会社管理者のみ） ----------
const admin = client(await login('sample', 'admin'))
{
  const list = await admin.get('/api/admin/users')
  ok('#44 管理者アカウントの一覧は管理系ロールだけ（スタッフ・本部を含まない）', list.status === 200 && list.data.users.length >= 3 && list.data.users.every(u => ['company_admin', 'sales_manager', 'field_manager', 'office_staff'].includes(u.role)), list.data?.users?.map(u => u.role))
  const mgr = client(await login('sample', 'mgr01'))
  ok('#44 現場管理者は管理者アカウントを管理できない（403）', (await mgr.get('/api/admin/users')).status === 403)
  ok('#44 現場管理者は管理者を追加できない（403）', (await mgr.post('/api/admin/users', { user_code: 'x', name: 'x', role: 'office_staff' })).status === 403)
  const dup = await admin.post('/api/admin/users', { user_code: 'st001', name: '重複', role: 'office_staff' })
  ok('#44 スタッフ番号と同じ ID は 409', dup.status === 409, dup)
  const badRole = await admin.post('/api/admin/users', { user_code: `jim${SUF}`, name: '事務', role: 'system_admin' })
  ok('#44 本部のロールは付けられない（400）', badRole.status === 400, badRole)
  const add = await admin.post('/api/admin/users', { user_code: `jim${SUF}`, name: '事務 花子', role: 'office_staff', email: `jim${SUF}@example.com` })
  ok('#44 事務担当を追加でき、仮パスワードが返る', add.status === 200 && !!add.data.temp_password, add)
  const jimLogin = await rawLogin('sample', `jim${SUF}`, add.data.temp_password)
  ok('#44 追加した事務担当は管理画面にログインでき、変更を求められる', jimLogin.status === 200 && jimLogin.data?.redirect === '/admin' && jimLogin.data?.user?.must_change_password === true, jimLogin)
  const jim = client(jimLogin.cookie)
  const jimId = add.data.user_id
  const role = await admin.put(`/api/admin/users/${jimId}`, { role: 'sales_manager' })
  ok('#44 権限を変更できる', role.status === 200 && (await admin.get('/api/admin/users')).data.users.find(u => u.user_id === jimId)?.role === 'sales_manager', role)
  ok('#44 権限を変えると、その人のセッションは切れる', (await jim.get('/api/auth/me')).status === 401)
  const meId = (await admin.get('/api/auth/me')).data.user_id
  ok('#44 自分自身は停止できない', (await admin.put(`/api/admin/users/${meId}`, { status: 'suspended' })).status === 400)
  ok('#44 自分自身の権限は変更できない', (await admin.put(`/api/admin/users/${meId}`, { role: 'office_staff' })).status === 400)
  ok('#25 自分のメールアドレスは管理者アカウントの画面からは変えられない（パスワードの確認がある画面で変える）', (await admin.put(`/api/admin/users/${meId}`, { email: 'x@example.com' })).status === 400)
  ok('#44 自分のパスワードは管理者アカウントの画面から再発行できない', (await admin.post(`/api/admin/users/${meId}/reset-password`, {})).status === 400)
  const staffId4 = (await admin.put('/api/admin/users/4', { status: 'suspended' }))
  ok('#44 スタッフのアカウントは管理者アカウントの API の対象外（404）', staffId4.status === 404, staffId4)
  // パスワード再発行（仮パスワード）
  const jim2 = client(await login('sample', `jim${SUF}`, add.data.temp_password))
  const rs = await admin.post(`/api/admin/users/${jimId}/reset-password`, { mode: 'temp' })
  ok('#44 ほかの管理者のパスワードを再発行できる', rs.status === 200 && !!rs.data.temp_password && rs.data.temp_password !== add.data.temp_password, rs)
  ok('#44 再発行すると、その人のセッションは切れる', (await jim2.get('/api/auth/me')).status === 401)
  ok('#44 再発行の前のパスワードではログインできない', (await rawLogin('sample', `jim${SUF}`, add.data.temp_password)).status === 401)
  // 停止
  const jim3 = client(await login('sample', `jim${SUF}`, rs.data.temp_password))
  const sus = await admin.put(`/api/admin/users/${jimId}`, { status: 'suspended' })
  ok('#44 管理者アカウントを停止できる', sus.status === 200, sus)
  ok('#44 停止するとログイン中の画面も使えなくなる', (await jim3.get('/api/auth/me')).status === 401)
  ok('#44 停止したアカウントではログインできない', (await rawLogin('sample', `jim${SUF}`, rs.data.temp_password)).status === 403)
  ok('#44 停止中のアカウントにはパスワードを再発行しない', (await admin.post(`/api/admin/users/${jimId}/reset-password`, { mode: 'temp' })).status === 409)
  ok('#44 利用を再開できる', (await admin.put(`/api/admin/users/${jimId}`, { status: 'active' })).status === 200 && (await rawLogin('sample', `jim${SUF}`, rs.data.temp_password)).status === 200)
}

// ---------- #44 最後の1人の会社管理者 / 本部からの管理者の管理 ----------
{
  const bossId = (await boss.get('/api/auth/me')).data.user_id
  const last = await hq.put(`/api/hq/companies/${coId}/users/${bossId}`, { status: 'suspended' })
  ok('#44 最後の1人の会社管理者は停止できない（本部からでも 409）', last.status === 409, last)
  const lastRole = await hq.put(`/api/hq/companies/${coId}/users/${bossId}`, { role: 'office_staff' })
  ok('#44 最後の1人の会社管理者の権限は変えられない（409）', lastRole.status === 409, lastRole)
  const add2 = await boss.post('/api/admin/users', { user_code: 'boss2', name: '副社長', role: 'company_admin' })
  ok('#44 2人目の会社管理者を追加できる', add2.status === 200, add2)
  const hqAdd = await hq.post(`/api/hq/companies/${coId}/users`, { user_code: 'hqmade', name: '本部が追加' })
  ok('#44 本部から管理者を追加できる（既定は会社管理者・仮パスワード）', hqAdd.status === 200 && !!hqAdd.data.temp_password, hqAdd)
  const hqUsers = await hq.get(`/api/hq/companies/${coId}/users`)
  ok('#44 本部の管理者一覧に追加した管理者が出る', hqUsers.status === 200 && hqUsers.data.users.some(u => u.user_code === 'hqmade' && u.role === 'company_admin'), hqUsers)
  const noMail = await hq.post(`/api/hq/companies/${coId}/users/${hqAdd.data.user_id}/reset-password`, { mode: 'email' })
  ok('#44 メールのない管理者に再設定メールは送れない（400）', noMail.status === 400, noMail)
  const setMail = await hq.put(`/api/hq/companies/${coId}/users/${hqAdd.data.user_id}`, { email: `hqmade${SUF}@example.com` })
  ok('#25 本部が管理者のメールアドレスを設定できる', setMail.status === 200 && (await hq.get(`/api/hq/companies/${coId}`)).data.users.find(u => u.user_code === 'hqmade')?.email === `hqmade${SUF}@example.com`, setMail)
  const mail = await hq.post(`/api/hq/companies/${coId}/users/${hqAdd.data.user_id}/reset-password`, { mode: 'email' })
  ok('#44 本部から再設定メールを送れる', mail.status === 200 && mail.data.mode === 'email', mail)
  if (PERSIST) {
    const t = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ${Number(hqAdd.data.user_id)} AND used_at IS NULL`)
    ok('#44 再設定メールのリンク（トークン）が発行されている', t[0]?.n === 1, t)
  } else skip('#44 再設定リンクの発行')
  const tmp = await hq.post(`/api/hq/companies/${coId}/users/${bossId}/reset-password`, { mode: 'temp' })
  ok('#44 本部から仮パスワードを発行できる', tmp.status === 200 && (await rawLogin(coCode, 'boss', tmp.data.temp_password)).status === 200, tmp)
  ok('#44 本部はスタッフ・本部のアカウントを操作できない（404）', (await hq.put(`/api/hq/companies/1/users/4`, { status: 'suspended' })).status === 404)
  boss2Pw = add2.data.temp_password
  boss = client(await login(coCode, 'boss2', boss2Pw))
  const sus = await hq.put(`/api/hq/companies/${coId}/users/${bossId}`, { status: 'suspended' })
  ok('#44 ほかに会社管理者がいれば停止できる', sus.status === 200, sus)
}

// ---------- #25 自分のメールアドレスの登録・変更 ----------
{
  const sales = client(await login('sample', 'sales01'))
  const noPw = await sales.put('/api/auth/account', { email: `okamoto${SUF}@example.com` })
  ok('#25 メールアドレスの変更には現在のパスワードが要る', noPw.status === 400, noPw)
  const badFmt = await sales.put('/api/auth/account', { email: 'abc', current_password: 'pass1234' })
  ok('#25 メールアドレスの形式を確かめる', badFmt.status === 400, badFmt)
  const chg = await sales.put('/api/auth/account', { email: `okamoto${SUF}@example.com`, current_password: 'pass1234', name: '岡本 営業部長' })
  ok('#25 管理者が自分のメールアドレスと氏名を変更できる', chg.status === 200 && chg.data.email_notice_sent === true, chg)
  const acc = await sales.get('/api/auth/account')
  ok('#25 変更したメールアドレスと氏名が保存される', acc.data?.email === `okamoto${SUF}@example.com` && acc.data?.name === '岡本 営業部長', acc.data)
  const nameOnly = await sales.put('/api/auth/account', { name: '岡本 営業' })
  ok('#25 氏名だけの変更にはパスワードは要らない', nameOnly.status === 200, nameOnly)
  const st = client(await login('sample', 'st003'))
  ok('#25 スタッフは自分の登録情報（メール）を変更できない（403）', (await st.put('/api/auth/account', { email: 'a@example.com', current_password: 'pass1234' })).status === 403)
  const fp = await fetch(`${BASE}/api/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `okamoto${SUF}@example.com` }) })
  ok('#25 登録したメールアドレスでパスワード再設定を申し込める', fp.status === 200)
  if (PERSIST) {
    const t = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = 3`)
    ok('#25 登録したメールアドレスあてに再設定リンクが発行される', t[0]?.n >= 1, t)
  } else skip('#25 再設定リンクの発行')
}

// ---------- #43 スタッフ本人のパスワード変更 ----------
{
  const a = client(await login('sample', 'st001'))
  const b = client(await login('sample', 'st001'))
  const wrong = await a.post('/api/auth/change-password', { current_password: 'wrong-pass', new_password: 'st001-new-pass' })
  ok('#43 現在のパスワードが違えば 400', wrong.status === 400, wrong)
  const same = await a.post('/api/auth/change-password', { current_password: 'pass1234', new_password: 'pass1234' })
  ok('#43 現在と同じパスワードには変更できない', same.status === 400, same)
  const ch = await a.post('/api/auth/change-password', { current_password: 'pass1234', new_password: 'st001-new-pass' })
  ok('#43 スタッフが自分のパスワードを変更できる', ch.status === 200, ch)
  ok('#43 変更した端末はログインしたまま', (await a.get('/api/auth/me')).status === 200)
  ok('#43 ほかの端末のセッションは切れる', (await b.get('/api/auth/me')).status === 401)
  ok('#43 前のパスワードではログインできない', (await rawLogin('sample', 'st001', 'pass1234')).status === 401)
  ok('#43 新しいパスワードでログインできる', (await rawLogin('sample', 'st001', 'st001-new-pass')).status === 200)
  ok('#43 元に戻せる', (await a.post('/api/auth/change-password', { current_password: 'st001-new-pass', new_password: 'pass1234' })).status === 200)
}

// ---------- #45 管理者によるスタッフのパスワード再発行 ----------
{
  const st2 = client(await login('sample', 'st002'))
  const rs = await admin.post('/api/admin/staff/2/reset-password')
  ok('#45 管理者がスタッフのパスワードを再発行でき、ログインの案内が返る', rs.status === 200 && !!rs.data.temp_password && rs.data.user_code === 'st002' && rs.data.company_code === 'sample' && /\/login$/.test(rs.data.login_url), rs)
  ok('#45 再発行すると、スタッフのセッションは切れる', (await st2.get('/api/auth/me')).status === 401)
  ok('#45 前のパスワードではログインできない', (await rawLogin('sample', 'st002', 'pass1234')).status === 401)
  const nl = await rawLogin('sample', 'st002', rs.data.temp_password)
  ok('#45 仮パスワードでログインでき、変更を求められる', nl.status === 200 && nl.data?.user?.must_change_password === true, nl)
  const s = client(nl.cookie)
  ok('#45 #43 スタッフが仮パスワードから変更すると、変更の要求が消える', (await s.post('/api/auth/change-password', { current_password: rs.data.temp_password, new_password: 'pass1234' })).status === 200
    && (await s.get('/api/auth/me')).data?.must_change_password === false)
  const other = await boss.post('/api/admin/staff/2/reset-password')
  ok('#45 他社のスタッフのパスワードは再発行できない（404）', other.status === 404, other)
  const sheet = await admin.post('/api/admin/roster', { route: 'skillsheet', name: `W2AA シートのみ${SUF}`, gender: 'female' })
  const noLogin = await admin.post(`/api/admin/staff/${sheet.data?.staff_id}/reset-password`)
  ok('#45 ログインのないスタッフは再発行できない（400）', sheet.status === 200 && noLogin.status === 400, { sheet, noLogin })
  const mgr = client(await login('sample', 'mgr01'))
  const r3 = await mgr.post('/api/admin/staff/3/reset-password')
  ok('#45 現場管理者もスタッフのパスワードを再発行できる', r3.status === 200, r3)
  // ほかのテストのため、st003 のパスワードを元に戻す
  const l3 = await rawLogin('sample', 'st003', r3.data?.temp_password)
  if (l3.status === 200) await client(l3.cookie).post('/api/auth/change-password', { current_password: r3.data.temp_password, new_password: 'pass1234' })
}

// ---------- #66 停止した企業の掲示板の掲載 ----------
{
  const post = await boss.post('/api/admin/board/posts', {
    status: 'open', engagement_type: 'spot', title: `W2AA 掲載${SUF}`, prefecture: '東京都', date_from: addDays(today, 30), time_from: '10:00', time_to: '18:00',
    price_amount: 12000, price_unit: 'daily', headcount: 1,
  })
  ok('#66 準備: 掲示板に掲載できる', post.status === 200, post)
  const postId = post.data?.post_id
  const seen = await admin.get('/api/admin/board/posts')
  ok('#66 利用中の企業の掲載は他社の一覧に出る', seen.data?.posts?.some(p => p.post_id === postId), seen.status)
  await hq.put(`/api/hq/companies/${coId}`, { active_status: 'inactive' })
  const hidden = await admin.get('/api/admin/board/posts')
  ok('#66 停止した企業の掲載は他社の一覧に出ない', hidden.status === 200 && !hidden.data.posts.some(p => p.post_id === postId), hidden.status)
  ok('#66 停止した企業の掲載の詳細は他社に 404', (await admin.get(`/api/admin/board/posts/${postId}`)).status === 404)
  const th = await admin.post(`/api/admin/board/posts/${postId}/threads`, { body: '問い合わせです' })
  ok('#66 停止した企業の掲載には問い合わせを始められない（409）', th.status === 409, th)
  await hq.put(`/api/hq/companies/${coId}`, { active_status: 'active' })
  ok('#66 再開すると一覧に戻る', (await admin.get('/api/admin/board/posts')).data?.posts?.some(p => p.post_id === postId))
}

// ---------- #66 停止した企業の公開募集ページ ----------
{
  const pids = ((await admin.get('/api/admin/projects')).data?.projects || []).map(p => p.project_id).slice(0, 3)
  const page = await admin.post('/api/admin/recruit-pages', { title: `W2AA 募集${SUF}`, project_ids: pids, date_from: today, date_to: addDays(today, 14), allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' })
  ok('#66 準備: 募集ページを作れる', page.status === 200 && !!page.data.token, page)
  const token = page.data?.token
  ok('#66 利用中の企業の募集ページは開ける', (await fetch(`${BASE}/api/public/recruit/${token}`)).status === 200)
  await hq.put('/api/hq/companies/1', { active_status: 'inactive' })
  const g = await fetch(`${BASE}/api/public/recruit/${token}`)
  const gd = await g.json().catch(() => null)
  ok('#66 停止した企業の募集ページは「終了しました」（410）', g.status === 410 && gd?.closed === true, { status: g.status, gd })
  const ap = await fetch(`${BASE}/api/public/recruit/${token}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '応募 太郎', phone: '09012345678', agree: true, slot_role_ids: [1], issued_at: Date.now() - 10000 }) })
  ok('#66 停止した企業の募集ページには応募できない（410）', ap.status === 410, ap.status)
  ok('#66 本部ユーザーは企業1を停止しても使える', (await hq.get('/api/hq/companies')).status === 200)
  await hq.put('/api/hq/companies/1', { active_status: 'active' })
  ok('#66 再開すると募集ページが開ける', (await fetch(`${BASE}/api/public/recruit/${token}`)).status === 200)
}

// ---------- #25 メールアドレスの変更でのパスワード確認にも、ログインと同じ失敗回数の制限をかける ----------
{
  // #66 で企業を停止したときにセッションが切れているので、ログインし直す
  const b2 = client(await login(coCode, 'boss2', boss2Pw))
  let last
  for (let i = 0; i < 10; i++) last = await b2.put('/api/auth/account', { email: `lock${SUF}@example.com`, current_password: `wrong-${i}` })
  const locked = await b2.put('/api/auth/account', { email: `lock${SUF}@example.com`, current_password: 'wrong-x' })
  ok('#25 メールアドレスの変更で現在のパスワードを10回まちがえると一時的に 429', last?.status === 400 && locked.status === 429, { last, locked })
  ok('#25 同じ失敗の記録で、その ID のログインも止まる', (await rawLogin(coCode, 'boss2', 'wrong-pass')).status === 429)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
