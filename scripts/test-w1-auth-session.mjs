// 認証の強化（作業単位 w1-auth-session: #8 #9 #13 #46 #55 #62 #131 #330 #331 #373 #386 #451 #452 #534）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8812 --persist-to <保存先> --var DEMO_MODE:false で起動していること。
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> node scripts/test-w1-auth-session.mjs
//   PERSIST を指定すると、ローカルの D1 を直接読み書きする確認（ハッシュでの保存・再設定リンクの期限・退職者）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// wrangler d1 execute を待つ間に keep-alive の接続が切られることがあるため、接続エラーは1回だけやり直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

async function rawLogin(company_code, user_code, password = 'pass1234', cookie) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, setCookie: r.headers.get('set-cookie') || '', cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${user_code} ${r.status} ${JSON.stringify(r.data)}`)
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
// SQL は一時ファイル経由で渡す（Windows の shell で引数の引用符が崩れないように）
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w1auth-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const FAILED = '会社コード・ID・パスワードのいずれかが正しくありません'

// ---------- #452 エラー文言の統一 ----------
{
  const a = await rawLogin('no-such-company', 'admin', 'pass1234')
  const b = await rawLogin('sample', 'admin', 'wrong-password')
  const c = await rawLogin('sample', 'no-such-user', 'pass1234')
  ok('#452 会社コード違いは 401 で共通の文言', a.status === 401 && a.data?.error === FAILED, a)
  ok('#452 パスワード違いも同じ文言・同じステータス', b.status === 401 && b.data?.error === FAILED, b)
  ok('#452 ID違いも同じ文言・同じステータス', c.status === 401 && c.data?.error === FAILED, c)
}

// ---------- #330 Cookie とセッションの保存 ----------
const adminLogin = await rawLogin('sample', 'admin')
ok('ログイン成功', adminLogin.status === 200 && adminLogin.data?.redirect === '/admin', adminLogin)
ok('#330 Cookie は HttpOnly（http のローカルでは Secure なし）', /HttpOnly/i.test(adminLogin.setCookie) && !/Secure/i.test(adminLogin.setCookie), adminLogin.setCookie)
const admin = client(adminLogin.cookie)
ok('ログインしたセッションで管理 API が使える', (await admin.get('/api/auth/me')).data?.role === 'company_admin')
if (PERSIST) {
  const raw = adminLogin.cookie.split('=')[1]
  const rows = sql(`SELECT token, expires_at FROM sessions WHERE user_id = 1`)
  ok('#330 sessions には生のトークンではなく SHA-256 を保存する', rows.some(r => r.token === sha256(raw)) && !rows.some(r => r.token === raw), rows)
  ok('#8 sessions.expires_at は ISO 8601', rows.every(r => /T.*Z$/.test(r.expires_at)), rows)
} else skip('#330 sessions のハッシュ保存')

// ---------- #373 ログイン済みで /login を開いたらホームへ ----------
{
  const r = await fetch(`${BASE}/login`, { headers: { Cookie: admin.cookie }, redirect: 'manual' })
  ok('#373 ログイン済みの /login は /admin へ移す', r.status === 302 && (r.headers.get('location') || '').endsWith('/admin'), r.status)
  const r2 = await fetch(`${BASE}/login`, { redirect: 'manual' })
  const html = await r2.text()
  ok('#373 未ログインの /login はフォームを出す', r2.status === 200 && html.includes('login-form'))
  // #62 DEMO_MODE が 'true' でないときはデモアカウントの案内を出さない（wrangler dev を --var DEMO_MODE:false で起動）
  const expectDemo = process.env.DEMO_MODE === 'true'
  ok(`#62 デモアカウントの案内は DEMO_MODE=${expectDemo} に従う`, html.includes('デモアカウント') === expectDemo)
  ok('#62 会社コードの入力例に sample を出さない', !html.includes('例: sample'))
  ok('#386 ログインできない場合の案内を出す', html.includes('所属の会社の担当者にお問い合わせください'))
  // 同じ端末で再ログインしたら、古いセッションは消す
  const again = await rawLogin('sample', 'admin', 'pass1234', admin.cookie)
  ok('#373 同じ Cookie で再ログインすると古いセッションは使えない', again.status === 200 && (await admin.get('/api/auth/me')).status === 401)
  admin.cookie = again.cookie
}
const adm = client(admin.cookie)

// ---------- #451 認証除外は完全一致 ----------
{
  const r1 = await fetch(`${BASE}/api/staff/attendance-photo/auth/login`)
  const r2 = await fetch(`${BASE}/api/admin/projects/auth/login`)
  const r3 = await fetch(`${BASE}/api/hq/companies/auth/logout`)
  ok('#451 末尾が /auth/login の任意のURLは 401（500 にならない）', r1.status === 401 && r2.status === 401 && r3.status === 401, [r1.status, r2.status, r3.status])
}

// ---------- /api/staff/* のロール確認 ----------
{
  const st = client(await login('sample', 'st001'))
  ok('/api/staff/home はスタッフなら使える', (await st.get('/api/staff/home')).status === 200)
  ok('/api/staff/home は管理者のセッションでは 403', (await adm.get('/api/staff/home')).status === 403)
  ok('/api/admin/* はスタッフのセッションでは 403', (await st.get('/api/admin/staff')).status === 403)
}

// ---------- #331 パスワードの最低条件 ----------
{
  const r1 = await adm.post('/api/admin/staff', { user_code: 'w1auth01', name: '短い パス', password: 'abc' })
  ok('#331 POST /admin/staff は8文字未満を拒否', r1.status === 400, r1)
  const r2 = await adm.post('/api/admin/staff', { user_code: ' w1auth02 ', name: 'テスト 認証', password: 'longenough1', email: '  W1Auth02@Example.COM ' })
  ok('#331 8文字以上なら登録できる', r2.status === 200, r2)
  const l = await rawLogin('sample', 'w1auth02', 'longenough1')
  ok('#331 スタッフ番号は前後の空白を除いて保存する（そのままログインできる）', l.status === 200, l)
  const r3 = await adm.post('/api/admin/roster', { route: 'employee', name: '短い パス2', gender: 'male', user_code: 'w1auth03', password: 'pass' })
  ok('#331 スタッフマスタからの登録も8文字未満を拒否', r3.status === 400 && /8文字以上/.test(r3.data?.error || ''), r3)
}

// ---------- #46 ログイン試行の制限 ----------
{
  let last
  for (let i = 0; i < 10; i++) last = await rawLogin('sample', 'st019', 'wrong-' + i)
  ok('#46 失敗10回までは 401', last.status === 401, last)
  const locked = await rawLogin('sample', 'st019', 'pass1234')
  ok('#46 失敗が10回続いたら正しいパスワードでも一時的に 429', locked.status === 429, locked)
  const other = await rawLogin('sample', 'st018', 'pass1234')
  ok('#46 他の ID はロックされない', other.status === 200, other)
}

// ---------- #46 旧形式のハッシュはログイン時に作り直す ----------
if (PERSIST) {
  sql(`UPDATE users SET password_hash = ${q(sha256('pass1234'))} WHERE user_id = 20`) // st017
  const r = await rawLogin('sample', 'st017', 'pass1234')
  const h = sql('SELECT password_hash FROM users WHERE user_id = 20')[0].password_hash
  ok('#46 旧形式（SHA-256）でもログインでき、PBKDF2 に作り直す', r.status === 200 && h.startsWith('pbkdf2$10000$'), { status: r.status, h })
  const r2 = await rawLogin('sample', 'st017', 'pass1234')
  ok('#46 作り直した後もログインできる', r2.status === 200, r2)
} else skip('#46 旧形式のハッシュの作り直し')

// ---------- #9 #386 退職者 ----------
if (PERSIST) {
  const st = client(await login('sample', 'st016'))
  ok('#9 退職前はスタッフ API が使える', (await st.get('/api/staff/home')).status === 200)
  sql(`UPDATE users SET status = 'suspended', retired_at = ${q(jstToday)} WHERE user_code = 'st016' AND company_id = 1`)
  ok('#9 退職（suspended）にすると既存のセッションは 401', (await st.get('/api/staff/home')).status === 401)
  const r = await rawLogin('sample', 'st016', 'pass1234')
  ok('#386 パスワードが合っていれば、利用できない旨と会社への連絡を案内する', r.status === 403 && /現在利用できません/.test(r.data?.error || '') && /所属の会社/.test(r.data?.error || ''), r)
  const r2 = await rawLogin('sample', 'st016', 'wrong-password')
  ok('#386 パスワードが違えば共通の文言（アカウントの状態は漏らさない）', r2.status === 401 && r2.data?.error === FAILED, r2)
} else skip('#9 #386 退職者')

// ---------- #8 #55 #131 パスワード再設定 ----------
{
  const r = await fetch(`${BASE}/api/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '  Staff1@EXAMPLE.com ' }) })
  const d = await r.json()
  ok('forgot-password は常に同じ応答', r.status === 200 && d.ok === true, d)
  if (PERSIST) {
    const n = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = 4`)[0].n
    ok('#131 大文字・前後の空白が違っても登録済みのメールアドレスに発行する', n >= 1, n)
    // #55 仮登録（roster_only）の行には発行しない
    await adm.post('/api/admin/roster', { route: 'skillsheet', name: 'W1 仮登録', gender: 'male' })
    sql(`UPDATE users SET email = 'w1-roster@example.com' WHERE user_id = (SELECT MIN(user_id) FROM users WHERE role = 'roster_only')`)
    const rosterUser = sql(`SELECT user_id FROM users WHERE email = 'w1-roster@example.com'`)[0]
    if (rosterUser) {
      await fetch(`${BASE}/api/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'w1-roster@example.com' }) })
      const m = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ${rosterUser.user_id}`)[0].n
      ok('#55 roster_only の行には再設定リンクを発行しない', m === 0, m)
    } else console.log('SKIP  #55 roster_only の行がない')

    // #8 期限の比較: UTC で同じ日付の、すでに過ぎた期限は無効（以前は日付が変わるまで有効だった）
    const expiredTok = 'w1expired' + Date.now()
    const past = new Date(Date.now() - 60 * 1000).toISOString()
    sql(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (5, ${q(sha256(expiredTok))}, ${q(past)})`)
    const e = await fetch(`${BASE}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: expiredTok, password: 'newpassword1' }) })
    ok('#8 期限を1分過ぎたリンクは無効', e.status === 400)

    // #9 再設定で既存のセッションを切る
    const st2 = client(await login('sample', 'st002'))
    const tok = 'w1valid' + Date.now()
    sql(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (5, ${q(sha256(tok))}, ${q(new Date(Date.now() + 30 * 60 * 1000).toISOString())})`)
    const short = await fetch(`${BASE}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, password: 'short' }) })
    ok('#331 再設定も8文字未満を拒否', short.status === 400)
    const okr = await fetch(`${BASE}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, password: 'newpassword1' }) })
    ok('期限内のリンクで再設定できる', okr.status === 200)
    ok('#9 再設定すると既存のセッションは切れる', (await st2.get('/api/staff/home')).status === 401)
    ok('新しいパスワードでログインできる', (await rawLogin('sample', 'st002', 'newpassword1')).status === 200)
    const h = sql('SELECT password_hash FROM users WHERE user_id = 5')[0].password_hash
    ok('#46 再設定したパスワードは PBKDF2 で保存する', h.startsWith('pbkdf2$'), h)
  } else skip('#8 #55 #131 再設定の DB 確認')
}

// ---------- #13 #534 企業の停止 ----------
{
  const hq = client(await login('sample', 'hq'))
  const code = 'w1co' + Date.now().toString(36)
  const weak = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: 'W1 停止テスト', admin_code: 'admin', admin_password: 'abc' })
  ok('#331 初期管理者のパスワードも8文字未満を拒否', weak.status === 400, weak)
  const created = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: ' ' + code + ' ', company_name: 'W1 停止テスト', admin_code: 'admin', admin_password: 'adminpass1' })
  ok('企業を作成できる（会社コードは前後の空白を除く）', created.status === 200, created)
  const list = (await hq.get('/api/hq/companies')).data.companies
  const co = list.find(x => x.company_code === code)
  const coAdmin = client(await login(code, 'admin', 'adminpass1'))
  ok('停止前はその企業の管理者が使える', (await coAdmin.get('/api/auth/me')).status === 200)
  const bad = await hq.put('/api/hq/companies/' + co.company_id, { active_status: 'paused' })
  ok('利用状態は決まった値だけ', bad.status === 400, bad)
  const stop = await hq.put('/api/hq/companies/' + co.company_id, { active_status: 'inactive' })
  ok('#13 停止するとその企業のセッションを削除する', stop.status === 200 && stop.data.revoked_sessions >= 1, stop)
  ok('#13 停止後は既存のセッションが使えない', (await coAdmin.get('/api/auth/me')).status === 401)
  const r = await rawLogin(code, 'admin', 'adminpass1')
  ok('#13 停止中の企業はログインが 403 で契約停止を案内する', r.status === 403 && /停止中/.test(r.data?.error || ''), r)
  const r2 = await rawLogin(code, 'admin', 'wrongpass1')
  ok('#13 パスワード違いなら共通の文言（停止中かどうかは漏らさない）', r2.status === 401 && r2.data?.error === FAILED, r2)
  ok('#13 本部ユーザーは使い続けられる', (await hq.get('/api/hq/companies')).status === 200)
  await hq.put('/api/hq/companies/' + co.company_id, { active_status: 'active' })
  ok('#13 再開すればログインできる', (await rawLogin(code, 'admin', 'adminpass1')).status === 200)

  // #534 報告用URL: 停止中の企業では使えない（sample 社を一時的に停止して確かめ、最後に戻す）
  const a = client(await login('sample', 'admin'))
  const staff = (await a.get('/api/admin/staff')).data.staff.find(s => s.employment_status !== 'retired' && !s.merged_into_staff_id && s.affiliation_type === 'own_employee')
  const proj = (await a.get('/api/admin/projects')).data.projects.find(p => p.status === 'active')
  const sh = await a.post('/api/admin/shifts', { staff_id: staff.staff_id, project_id: proj.project_id, work_date: jstToday, start_time: '00:01', end_time: '23:30', memo: 'w1-auth-session' })
  const shiftId = (await a.get(`/api/admin/shifts?from=${jstToday}&to=${jstToday}`)).data.shifts.find(x => x.memo === 'w1-auth-session')?.shift_id
  const link = await a.post(`/api/admin/shifts/${shiftId}/report-link`, {})
  const token = link.data?.token
  ok('報告用URLを発行できる', link.status === 200 && !!token, { sh, link })
  ok('#534 利用中の企業では報告用URLが使える', (await fetch(`${BASE}/api/public/report/${token}`)).status === 200)
  await hq.put('/api/hq/companies/1', { active_status: 'inactive' })
  ok('#534 停止中の企業では報告用URLが使えない', (await fetch(`${BASE}/api/public/report/${token}`)).status === 404)
  ok('#13 本部ユーザーは自社（company_id=1）を停止しても使える', (await hq.get('/api/hq/companies')).status === 200)
  await hq.put('/api/hq/companies/1', { active_status: 'active' })
  ok('#534 再開すれば報告用URLが使える', (await fetch(`${BASE}/api/public/report/${token}`)).status === 200)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
