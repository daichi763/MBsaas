// ログイン画面・再設定・電話番号とメールの変更・本登録のログイン案内（作業単位 w3-account-profile:
//   #123 #201 #206 #207 #208 #308 #328 #382 #387 #396 #561 #569、持ち越し #43 #89）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8819 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8819 PERSIST=<保存先> node scripts/test-w3-account-profile.mjs
//   PERSIST を指定すると、ローカルの D1 を直接読み書きする確認（確認メールのトークン・回数制限・インデックス）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8819'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)
const must = (r, label) => { if (r.status !== 200) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.data)}`); return r.data }

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
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b, h) => call('POST', p, b ?? {}, h), put: (p, b) => call('PUT', p, b ?? {}) }
}
const pub = client('')
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w3acc-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const SUF = String(Date.now()).slice(-6)

const admin = client(await login('sample', 'admin'))

// ---------- #201 #387 会社コード・ID の大文字・小文字と全角 ----------
{
  const a = await rawLogin('Sample', 'ST001')
  ok('#201 #387 大文字で入力した会社コード・ID でもログインできる', a.status === 200 && a.data.redirect === '/staff', a)
  ok('#308 ログインの応答に登録どおりの会社コードと ID を返す（次回の入力欄に入れる）', a.data?.company_code === 'sample' && a.data?.user_code === 'st001', a.data)
  const b = await rawLogin('ｓａｍｐｌｅ', 'ｓｔ００１')
  ok('#387 全角で入力した会社コード・ID でもログインできる', b.status === 200, b)
  const c = await rawLogin('sample', 'st001', 'wrong-password')
  ok('#561 パスワードの誤りは 401（通信の失敗とは画面で区別する）', c.status === 401, c)
  const hq = await rawLogin('', 'HQ')
  ok('#201 本部ユーザーも大文字の ID でログインでき、会社コードは空で返る', hq.status === 200 && hq.data.redirect === '/hq' && hq.data.company_code === '', hq)
}
// 以前に全角のまま保存されたスタッフ番号も、入力どおりでログインできる（既存データの互換。RV）
if (PERSIST) {
  sql(`UPDATE users SET user_code = 'ｓｔ００２' WHERE company_id = (SELECT company_id FROM companies WHERE company_code = 'sample') AND user_code = 'st002'`)
  const fw = await rawLogin('sample', 'ｓｔ００２')
  ok('#387 全角のまま保存されていた ID は、全角の入力でもログインできる', fw.status === 200 && fw.data.user_code === 'ｓｔ００２', fw)
  sql(`UPDATE users SET user_code = 'st002' WHERE company_id = (SELECT company_id FROM companies WHERE company_code = 'sample') AND user_code = 'ｓｔ００２'`)
} else skip('#387 全角のまま保存されていた ID')

// ---------- #206 未ログインで開いたら next を付けてログイン画面へ ----------
for (const p of ['/staff', '/admin', '/hq']) {
  const r = await fetch(`${BASE}${p}`, { redirect: 'manual' })
  ok(`#206 未ログインで ${p} を開くと /login?next= に移る`, r.status === 302 && r.headers.get('location') === `/login?next=${encodeURIComponent(p)}`, { status: r.status, loc: r.headers.get('location') })
}

// ---------- #201 #308 #387 #561 ログイン画面 ----------
{
  const html = await (await fetch(`${BASE}/login?next=%2Fstaff`)).text()
  const cc = /<input id="company_code"[^>]*>/.exec(html)?.[0] || ''
  const uc = /<input id="user_code"[^>]*>/.exec(html)?.[0] || ''
  ok('#201 会社コード欄は会社名の自動入力・大文字化・自動修正をしない', cc.includes('autocomplete="off"') && cc.includes('autocapitalize="none"') && cc.includes('autocorrect="off"') && !cc.includes('organization'), cc)
  ok('#387 スタッフ番号欄も大文字化・自動修正をしない', uc.includes('autocapitalize="none"') && uc.includes('autocorrect="off"') && uc.includes('spellcheck="false"'), uc)
  ok('#387 パスワードの表示切替がある', html.includes('id="pw-toggle"'))
  ok('#308 会社コード・ID の記憶と ?c= の事前入力がある', html.includes("params.get('c')") && html.includes('localStorage'))
  ok('#561 ログインの要求にタイムアウトを付け、通信の失敗を別の文言にする', html.includes('timeout: TIMEOUT_MS') && html.includes('通信できませんでした'))
  ok('#308 ログイン画面にマニフェストとホーム画面用アイコンがある', html.includes('rel="manifest"') && html.includes('apple-touch-icon'))
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  let syntaxOk = scripts.length > 0
  for (const s of scripts) { try { new vm.Script(s) } catch (e) { syntaxOk = false; console.log(e.message) } }
  ok('ログイン画面の script に構文エラーがない', syntaxOk)
  const m = await fetch(`${BASE}/manifest.webmanifest`)
  let mj = null; try { mj = await m.json() } catch { }
  ok('#308 マニフェストを配信する', m.status === 200 && mj?.name === 'Field OS' && mj.icons?.length >= 2, mj)
  ok('#308 アイコンを配信する', (await fetch(`${BASE}/static/icon-180.png`)).status === 200 && (await fetch(`${BASE}/static/icon-512.png`)).status === 200)
  for (const p of ['/reset-password?token=x', '/verify-email?token=x']) {
    const h = await (await fetch(`${BASE}${p}`)).text()
    let okSyntax = true
    for (const s of [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1])) { try { new vm.Script(s) } catch (e) { okSyntax = false; console.log(e.message) } }
    ok(`${p.split('?')[0]} の script に構文エラーがない`, okSyntax)
  }
  const rp = await (await fetch(`${BASE}/reset-password?token=x`)).text()
  ok('#208 再設定の完了画面に会社コード・ID と、入力済みのログイン画面へのリンクがある', rp.includes('reset-company') && rp.includes('reset-user') && rp.includes("'/login?' + q.toString()"))
}

// ---------- 仮登録 → 本登録でログインを発行（#328 #43 #387） ----------
const quick = async (name, phone, type = 'daily_worker') => must(await admin.post('/api/admin/staff-quick', { name, phone, affiliation_type: type, force: true }), 'staff-quick')
const phoneA = '080' + SUF + '01', phoneB = '080' + SUF + '02'
const S1 = await quick(`W3AP 一郎${SUF}`, phoneA)
const S2 = await quick(`W3AP 二郎${SUF}`, phoneB)
const code1 = `ＡＰ${SUF}`
{
  const r = await admin.post(`/api/admin/staff/${S1.staff_id}/finalize`, { gender: 'male', user_code: code1, password: 'Init-pass-1234' })
  ok('#328 本登録でログインを発行すると、ログイン案内（URL・会社コード・番号・初期パスワード）が返る', r.status === 200 && r.data.login?.login_url?.endsWith('/login?c=sample')
    && r.data.login.company_code === 'sample' && r.data.login.user_code === `AP${SUF}` && r.data.login.password === 'Init-pass-1234', r)
  const lg = await rawLogin('sample', `ap${SUF}`, 'Init-pass-1234')
  ok('#387 全角で入れたスタッフ番号は半角で保存され、小文字でもログインできる', lg.status === 200, lg)
  const me = await client(lg.cookie).get('/api/auth/me')
  ok('#43 本登録で発行したログインは、初回ログインでパスワードの変更を求める', me.data?.must_change_password === true, me.data)
}
{
  // ログインなしで本登録したスタッフに、後からログインを発行
  must(await admin.post(`/api/admin/staff/${S2.staff_id}/finalize`, { gender: 'female' }), 'finalize S2')
  const r = await admin.post(`/api/admin/staff/${S2.staff_id}/issue-login`, { user_code: `bp${SUF}`, password: 'Init-pass-5678' })
  ok('#328 後からログインを発行したときもログイン案内が返る', r.status === 200 && r.data.login?.user_code === `bp${SUF}` && r.data.login.password === 'Init-pass-5678', r)
  const lg = await rawLogin('sample', `bp${SUF}`, 'Init-pass-5678')
  ok('#43 後から発行したログインも、初回ログインでパスワードの変更を求める', lg.status === 200 && lg.data.user.must_change_password === true, lg)
}

// ---------- #123 電話番号の変更 ----------
const S3 = await quick(`W3AP 三郎${SUF}`, '080' + SUF + '03')
{
  const dup = await admin.put(`/api/admin/staff/${S3.staff_id}`, { phone: '080-' + SUF.slice(0, 4) + '-' + SUF.slice(4) + '01' })
  ok('#123 ほかのスタッフと同じ電話番号は、確認を求める（409）', dup.status === 409 && dup.data.need_confirm === true && dup.data.phone_matches?.some(m => m.staff_id === S1.staff_id), dup)
  const bad = await admin.put(`/api/admin/staff/${S3.staff_id}`, { phone: '12345' })
  ok('#123 桁数の合わない電話番号は 400', bad.status === 400, bad)
  const newPhone = '070-' + SUF.slice(0, 4) + '-' + SUF.slice(4) + '99'
  const r = await admin.put(`/api/admin/staff/${S3.staff_id}`, { phone: newPhone })
  const d = await admin.get(`/api/admin/staff/${S3.staff_id}`)
  ok('#123 電話番号を変えられ、照合用に数字だけで保存する', r.status === 200 && d.data.profile.phone === newPhone.replace(/\D/g, ''), { r, phone: d.data?.profile?.phone })
  const look = await admin.get(`/api/admin/staff-lookup?phone=${encodeURIComponent(newPhone)}`)
  ok('#123 新しい番号で重複確認（仮登録・応募の照合）に見つかる', look.data?.matches?.some(m => m.staff_id === S3.staff_id), look.data)
  const conf = await admin.put(`/api/admin/staff/${S3.staff_id}`, { phone: phoneB, phone_confirmed: true })
  ok('#123 確認のうえなら同じ番号でも保存できる', conf.status === 200, conf)
}
let EMP_SID = null
{
  // ②自社雇用: 登録時の電話番号を従業員管理にも入れ、従業員管理で変えたら users.phone にそろえる
  const reg = await admin.post('/api/admin/roster', { route: 'employee', name: `W3AP 社員${SUF}`, gender: 'male', user_code: `ep${SUF}`, password: 'Init-pass-9999', phone: '090' + SUF + '11' })
  ok('自社雇用スタッフを登録できる', reg.status === 200, reg)
  const sid = reg.data?.staff_id
  EMP_SID = sid
  const lg = await rawLogin('sample', `ep${SUF}`, 'Init-pass-9999')
  ok('#43 スタッフマスタの②で登録したログインも、初回ログインでパスワードの変更を求める', lg.status === 200 && lg.data.user.must_change_password === true, lg)
  const emp = await admin.get(`/api/admin/employees/${sid}`)
  ok('#123 ②で登録した電話番号は従業員管理の電話番号にも入る', emp.data?.record?.phone_main === '090' + SUF + '11', emp.data?.record)
  const own = await admin.put(`/api/admin/staff/${sid}`, { phone: '09000000000' })
  ok('#123 自社雇用の電話番号はスタッフマスタからは変えられない（従業員管理から）', own.status === 403, own)
  const put = await admin.put(`/api/admin/employees/${sid}`, { phone_main: '090-' + SUF.slice(0, 4) + '-' + SUF.slice(4) + '22' })
  const d = await admin.get(`/api/admin/staff/${sid}`)
  ok('#123 従業員管理で電話番号を変えると、照合に使う電話番号もそろう', put.status === 200 && d.data.profile.phone === '090' + SUF + '22', { put, phone: d.data?.profile?.phone })
  const put2 = await admin.put(`/api/admin/employees/${sid}`, { department: '営業部' })
  const d2 = await admin.get(`/api/admin/staff/${sid}`)
  ok('#123 電話番号を送らない保存では、照合用の電話番号を変えない', put2.status === 200 && d2.data.profile.phone === '090' + SUF + '22', d2.data?.profile?.phone)
}

// ---------- #207 ログイン用メールの追加・変更（確認メールで有効にする） ----------
{
  const mail = `w3ap${SUF}@example.com`
  const noLogin = await admin.put(`/api/admin/staff/${S3.staff_id}`, { login_email: mail })
  ok('#207 ログインのないスタッフにはログイン用メールを設定できない', noLogin.status === 400, noLogin)
  const badFmt = await admin.put(`/api/admin/staff/${S1.staff_id}`, { login_email: 'not-an-email' })
  ok('#207 形式の誤ったメールは 400', badFmt.status === 400, badFmt)
  const dupMail = await admin.put(`/api/admin/staff/${S1.staff_id}`, { login_email: 'ADMIN@sample-mobile.jp' })
  ok('#207 自社の別の人が使っているメールは 409', dupMail.status === 409, dupMail)
  const r = await admin.put(`/api/admin/staff/${S1.staff_id}`, { login_email: mail })
  const d = await admin.get(`/api/admin/staff/${S1.staff_id}`)
  ok('#207 新しいメールは確認待ちになり、すぐには宛先にならない', r.status === 200 && r.data.login_email?.pending === mail && !d.data.profile.email && d.data.profile.login_email_pending?.email === mail, { r, p: d.data?.profile?.login_email_pending, email: d.data?.profile?.email })
  ok('#207 #569 詳細に自社のログインの有無を返す', d.data.profile.has_own_login === true)
  if (PERSIST) {
    const tok = `w3ap-verify-${SUF}`
    sql(`UPDATE login_email_verifications SET token_hash = '${sha256(tok)}' WHERE email = '${mail}' AND verified_at IS NULL AND canceled_at IS NULL`)
    const bad = await pub.post('/api/auth/verify-email', { token: 'wrong-token' })
    ok('#207 誤ったトークンでは確認できない', bad.status === 400, bad)
    const v = await pub.post('/api/auth/verify-email', { token: tok })
    const d2 = await admin.get(`/api/admin/staff/${S1.staff_id}`)
    ok('#207 本人が確認するとログイン用メールが切り替わる', v.status === 200 && v.data.company_code === 'sample' && d2.data.profile.email === mail && !d2.data.profile.login_email_pending, { v, email: d2.data?.profile?.email })
    ok('#207 確認のリンクは1回だけ使える', (await pub.post('/api/auth/verify-email', { token: tok })).status === 400)
    // 再設定メールの対象になる（#208 完了画面の会社コード・ID も確かめる）
    const fp = await pub.post('/api/auth/forgot-password', { email: mail }, { 'CF-Connecting-IP': `198.51.100.${Number(SUF) % 200}` })
    const n = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens t JOIN users u ON u.user_id = t.user_id WHERE LOWER(u.email) = '${mail}'`)[0].n
    ok('#207 確認したメールでパスワード再設定を受け付ける', fp.status === 200 && n === 1, { fp, n })
    const rt = `w3ap-reset-${SUF}`
    sql(`UPDATE password_reset_tokens SET token_hash = '${sha256(rt)}' WHERE user_id = (SELECT user_id FROM users WHERE LOWER(email) = '${mail}') AND used_at IS NULL`)
    const rs = await pub.post('/api/auth/reset-password', { token: rt, password: 'New-pass-4321' })
    ok('#208 再設定の完了で会社コードと ID を返す（ログイン画面へ入力済みで移る）', rs.status === 200 && rs.data.company_code === 'sample' && rs.data.user_code === `AP${SUF}`, rs)
  } else skip('#207 確認リンクでの切り替え')
  const clr = await admin.put(`/api/admin/staff/${S1.staff_id}`, { login_email: '' })
  const d3 = await admin.get(`/api/admin/staff/${S1.staff_id}`)
  ok('#207 空欄で保存するとログイン用メールを消す', clr.status === 200 && clr.data.login_email?.cleared === true && !d3.data.profile.email, { clr, email: d3.data?.profile?.email })
}

// ---------- #382 再設定の受付の、接続元ごとの回数制限 ----------
if (PERSIST) {
  const ip = `203.0.113.${Number(SUF) % 250}`
  for (let i = 0; i < 22; i++) await pub.post('/api/auth/forgot-password', { email: `nobody${i}-${SUF}@example.com` }, { 'CF-Connecting-IP': ip })
  const key = sha256(`reset_ip|${ip}`)
  const n = sql(`SELECT COUNT(*) AS n FROM login_attempts WHERE scope = 'reset_ip' AND key_hash = '${key}'`)[0].n
  ok('#382 同じ接続元からの受付は1時間に20件まで記録し、それを超えたら受け付けない', n === 20, n)
  const r = await pub.post('/api/auth/forgot-password', { email: 'staff2@example.com' }, { 'CF-Connecting-IP': ip })
  const t = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = (SELECT user_id FROM users WHERE email = 'staff2@example.com')`)[0].n
  ok('#382 上限に達した接続元からは、登録済みのメールでも再設定リンクを発行しない（応答は同じ）', r.status === 200 && r.data.ok === true && t === 0, { r, t })
  const r2 = await pub.post('/api/auth/forgot-password', { email: 'staff2@example.com' }, { 'CF-Connecting-IP': ip + '1' })
  const t2 = sql(`SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = (SELECT user_id FROM users WHERE email = 'staff2@example.com')`)[0].n
  ok('#382 別の接続元からは受け付ける', r2.status === 200 && t2 === 1, t2)
} else skip('#382 回数制限')

// ---------- #396 インデックス ----------
if (PERSIST) {
  const idx = sql(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_consultations_company_status','idx_follow_logs_company','idx_roster_consents_staff','idx_users_email_norm')`).map(r => r.name)
  ok('#396 相談・フォロー履歴・同意・メールのインデックスがある', idx.length === 4, idx)
  const plan = sql(`EXPLAIN QUERY PLAN SELECT * FROM consultations WHERE company_id = 1 AND status = 'open' ORDER BY created_at DESC`)
  ok('#396 相談の会社・状態の絞り込みでインデックスを使う', plan.some(p => String(p.detail).includes('idx_consultations_company_status')), plan)
} else skip('#396 インデックス')

// ---------- #569 他社連携スタッフの LK- コード ----------
{
  const hq = client(await login('', 'hq'))
  const code = `w3ap${SUF}`
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `W3AP 連携先${SUF}`, admin_code: 'admin', admin_password: 'pass1234', admin_name: '連携先管理者' }), 'company')
  const A = client(await login(code, 'admin'))
  const share = must(await admin.get(`/api/admin/roster/${EMP_SID}/share-code`), 'share-code')
  const terms = must(await A.get('/api/admin/roster/consent-terms'), 'terms')
  const linked = must(await A.post('/api/admin/roster/link', { code: share.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
  const lc = await A.get(`/api/admin/staff/${linked}/lifecycle`)
  ok('#569 他社連携の行は LK- コードをスタッフ番号として返さない', lc.status === 200 && lc.data.has_login === true && lc.data.has_own_login === false && lc.data.user_code === null, lc.data)
  const d = await A.get(`/api/admin/staff/${linked}`)
  ok('#569 他社連携の行は自社のログインなしとして返す', d.data?.profile?.has_own_login === false, d.data?.profile?.has_own_login)
  const em = await A.put(`/api/admin/staff/${linked}`, { login_email: 'x@example.com' })
  ok('#207 他社連携のスタッフのログイン用メールは稼働先では変えられない', em.status === 403, em)
  const ph = await A.put(`/api/admin/staff/${linked}`, { phone: '09012345678' })
  ok('#123 他社連携のスタッフの電話番号は稼働先では変えられない', ph.status === 403, ph)
  const plan = await A.post(`/api/admin/staff/${linked}/affiliation-change`, { to_type: 'daily_worker', dry_run: true })
  ok('持ち越し #89 区分変更の案内が「ログインを発行」を指す', plan.status === 200 && (plan.data.effects || []).some(x => x.includes('「ログインを発行」')), plan.data)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
