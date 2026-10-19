// セッションの延長・CSP・機微情報の権限・エラーの記録・アカウントの切り替え（作業単位 w3-security: #180 #202 #205 #213 #230 #346 #526）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   npx wrangler dev --local --port 8818 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8818 PERSIST=<保存先> node scripts/test-w3-security.mjs
//   PERSIST を指定すると、ローカルの D1 を直接書き換えて期限・最長期間の確認も行う（wrangler d1 execute は --local のみ）。
//   CHECK_SRI=1 を付けると、CDN のファイルを取得して integrity の値と照合する（cdn.jsdelivr.net への接続が必要）。
//   本番には接続しない。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8818'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name, why = 'PERSIST 未指定') => console.log(`SKIP  ${name}（${why}）`)

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
// headers: 追加のヘッダー。応答のヘッダーも返す
async function call(cookie, method, path, body, headers = {}, rawBody) {
  const r = await fetch(`${BASE}${path}`, {
    method, redirect: 'manual',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let data = null; try { data = JSON.parse(text) } catch { }
  return { status: r.status, data, text, headers: r.headers }
}
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w3sec-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const hours = (iso) => (Date.parse(iso) - Date.now()) / 3600000
const near = (v, target, tol = 0.2) => Math.abs(v - target) <= tol

// ---------- #180 セッションの延長 ----------
const staffCookie = await login('sample', 'st001')
const adminCookie = await login('sample', 'admin')
{
  const r = await call(staffCookie, 'GET', '/api/auth/me')
  const exp = r.headers.get('x-session-expires')
  ok('#180 スタッフは操作すると、期限が「今から72時間」に延びる', r.status === 200 && near(hours(exp), 72), { exp })
  const sc = r.headers.get('set-cookie') || ''
  const maxAge = Number((/Max-Age=(\d+)/i.exec(sc) || [])[1])
  ok('#180 延ばしたときは Cookie の期限も延ばす', maxAge > 71 * 3600 && maxAge <= 72 * 3600, sc)
  const r2 = await call(staffCookie, 'GET', '/api/auth/me')
  ok('#180 直後の呼び出しでは書き直さない（Set-Cookie なし・期限は同じ）', !r2.headers.get('set-cookie') && r2.headers.get('x-session-expires') === exp, r2.headers.get('x-session-expires'))
}
{
  const r = await call(adminCookie, 'GET', '/api/auth/me')
  ok('#180 管理者はログイン直後は延ばさない（12時間のまま）', r.status === 200 && near(hours(r.headers.get('x-session-expires')), 12), r.headers.get('x-session-expires'))
}
if (PERSIST) {
  const tokenOf = async (cookie) => createHash('sha256').update(cookie.split('=')[1]).digest('hex')
  const at = await tokenOf(adminCookie)
  sql(`UPDATE sessions SET expires_at = '${new Date(Date.now() + 3600000).toISOString()}' WHERE token = '${at}'`)
  const bg = await call(adminCookie, 'GET', '/api/admin/notifications/unread-count', undefined, { 'X-Background': '1' })
  ok('#526 バッジ更新など定期の取得（X-Background）では延ばさない', bg.status === 200 && near(hours(bg.headers.get('x-session-expires')), 1) && !bg.headers.get('set-cookie'), bg.headers.get('x-session-expires'))
  const fg = await call(adminCookie, 'GET', '/api/admin/dashboard')
  ok('#180 管理者は操作すると「今から12時間」に延びる', fg.status === 200 && near(hours(fg.headers.get('x-session-expires')), 12), fg.headers.get('x-session-expires'))
  // ログインから7日の最長期間を超えては延ばさない（ログインを 7日-2時間前 にする）
  const created = new Date(Date.now() - (7 * 24 - 2) * 3600000).toISOString().slice(0, 19).replace('T', ' ')
  sql(`UPDATE sessions SET created_at = '${created}', expires_at = '${new Date(Date.now() + 1800000).toISOString()}' WHERE token = '${at}'`)
  const capped = await call(adminCookie, 'GET', '/api/admin/dashboard')
  ok('#180 ログインから最長期間（管理者7日）を超えては延ばさない', capped.status === 200 && near(hours(capped.headers.get('x-session-expires')), 2), capped.headers.get('x-session-expires'))
  const again = await call(adminCookie, 'GET', '/api/auth/me')
  ok('#180 最長期間に達したら、それ以上は書き直さない', !again.headers.get('set-cookie') && again.headers.get('x-session-expires') === capped.headers.get('x-session-expires'))
  sql(`UPDATE sessions SET expires_at = '${new Date(Date.now() - 60000).toISOString()}' WHERE token = '${at}'`)
  ok('#180 期限を過ぎたセッションは 401', (await call(adminCookie, 'GET', '/api/auth/me')).status === 401)
} else {
  skip('#180 #526 期限の書き換えによる延長・最長期間の確認')
}

// ---------- #346 別のアカウントでログインされた画面からの操作を止める ----------
{
  const admin = await login('sample', 'admin')
  const me = await call(admin, 'GET', '/api/auth/me')
  ok('#346 応答に X-User-Id を付ける', me.headers.get('x-user-id') === String(me.data.user_id), me.headers.get('x-user-id'))
  ok('#346 /auth/me に会社コードを返す（再ログインのダイアログ用）', me.data.company_code === 'sample', me.data)
  const same = await call(admin, 'GET', '/api/admin/dashboard', undefined, { 'X-Expected-User-Id': String(me.data.user_id) })
  ok('#346 起動時と同じ人なら通す', same.status === 200, same.status)
  // 同じブラウザで mgr01 にログインし直した（Cookie が mgr01 のものに変わった）状態で、admin の画面から承認などを送る
  const mgr = await login('sample', 'mgr01')
  const sw = await call(mgr, 'PUT', '/api/admin/corrections/1/approve', {}, { 'X-Expected-User-Id': String(me.data.user_id) })
  ok('#346 起動時と違う人のセッションなら 409 account_switched で止める（別の人として記録しない）', sw.status === 409 && sw.data?.code === 'account_switched', sw)
  const st = await call(staffCookie, 'GET', '/api/staff/home', undefined, { 'X-Expected-User-Id': String(me.data.user_id) })
  ok('#346 スタッフ画面でも同じ（管理者の画面のつもりでスタッフのセッション）', st.status === 409 && st.data?.code === 'account_switched', st.status)
}

// ---------- #205 従業員管理は会社管理者・事務担当のみ ----------
{
  const admin = await login('sample', 'admin')
  const mgr = await login('sample', 'mgr01')     // field_manager
  const sales = await login('sample', 'sales01') // sales_manager
  const created = await call(admin, 'POST', '/api/admin/users', { user_code: 'w3sec-office', name: '事務 テスト', role: 'office_staff', password: 'pass12345' })
  const office = await login('sample', 'w3sec-office', 'pass12345')
  const list = await call(admin, 'GET', '/api/admin/employees')
  const sid = list.data?.employees?.[0]?.staff_id
  ok('#205 会社管理者は従業員管理を見られる', list.status === 200 && !!sid, list.status)
  ok('#205 事務担当は従業員管理を見られる', created.status === 200 && (await call(office, 'GET', `/api/admin/employees/${sid}`)).status === 200, created)
  for (const [label, ck] of [['現場管理者', mgr], ['営業管理者', sales]]) {
    const l = await call(ck, 'GET', '/api/admin/employees')
    const d = await call(ck, 'GET', `/api/admin/employees/${sid}`)
    const p = await call(ck, 'PUT', `/api/admin/employees/${sid}`, { bank_name: '書き換え銀行' })
    const docs = await call(ck, 'GET', `/api/admin/employees/${sid}/documents`)
    const dl = await call(ck, 'GET', '/api/admin/employees/documents/1/download')
    ok(`#205 ${label}は一覧・詳細・更新・入社時書類のどれも 403`, [l, d, p, docs, dl].every(x => x.status === 403 && x.data?.code === 'hr_forbidden'), [l.status, d.status, p.status, docs.status, dl.status])
    const me = await call(ck, 'GET', '/api/auth/me')
    ok(`#205 ${label}の /auth/me は can_manage_hr=false（メニューを出さない）`, me.data?.can_manage_hr === false, me.data)
  }
  const emp = await call(admin, 'GET', `/api/admin/employees/${sid}`)
  ok('#205 現場管理者の更新は保存されていない', emp.data?.record?.bank_name !== '書き換え銀行', emp.data?.record?.bank_name)
  ok('#205 会社管理者の /auth/me は can_manage_hr=true', (await call(admin, 'GET', '/api/auth/me')).data?.can_manage_hr === true)
  ok('#205 現場管理者もスタッフマスタ（業務側）は使える', (await call(mgr, 'GET', `/api/admin/staff/${sid}`)).status === 200)
}

// ---------- #230 予期しないエラーを記録し、参照番号を返す ----------
{
  const r = await call(await login('sample', 'admin'), 'PUT', '/api/admin/employees/1', undefined, {}, '{not json')
  ok('#230 予期しないエラーは JSON の 500 と参照番号を返す（Internal Server Error だけにしない）', r.status === 500 && /参照番号/.test(r.data?.error || '') && /^[0-9a-f]{8}$/.test(r.data?.ref || ''), r.text.slice(0, 200))
}

// ---------- #202 CSP・SRI ----------
{
  const lp = await fetch(`${BASE}/login`, { redirect: 'manual' })
  const csp = lp.headers.get('content-security-policy') || ''
  ok('#202 画面の応答に Content-Security-Policy を付ける', /script-src 'self'[^;]*https:\/\/cdn\.jsdelivr\.net/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp), csp)
  ok('#202 X-Content-Type-Options: nosniff', lp.headers.get('x-content-type-options') === 'nosniff')
  const api = await call(staffCookie, 'GET', '/api/auth/me')
  ok('#202 API（JSON）には CSP を付けない', !api.headers.get('content-security-policy'))
  const admin = await login('sample', 'admin')
  const page = await (await fetch(`${BASE}/admin`, { headers: { Cookie: admin }, redirect: 'manual' })).text()
  const hqPage = await (await fetch(`${BASE}/hq`, { headers: { Cookie: await login('', 'hq') }, redirect: 'manual' })).text()
  const staffPage = await (await fetch(`${BASE}/staff`, { headers: { Cookie: staffCookie }, redirect: 'manual' })).text()
  const tags = (html) => [...html.matchAll(/<(script|link)\b[^>]*(?:src|href)="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"[^>]*>/g)].map(m => ({ url: m[2], tag: m[0] }))
  const all = [...tags(page), ...tags(hqPage), ...tags(staffPage)]
  ok('#202 chart.js をバージョン固定で読み込む', /chart\.js@4\.5\.1\/dist\/chart\.umd\.min\.js/.test(page) && /chart\.js@4\.5\.1/.test(hqPage) && !/npm\/chart\.js"/.test(page + hqPage))
  ok('#202 CDN の script・link すべてに integrity と crossorigin を付ける', all.length >= 10 && all.every(t => /integrity="sha384-[A-Za-z0-9+/=]+"/.test(t.tag) && /crossorigin="anonymous"/.test(t.tag)), all.filter(t => !/integrity=/.test(t.tag)))
  ok('#202 qrcode-generator の読み込みは管理画面で1回だけ', (page.match(/qrcode-generator@/g) || []).length === 1)
  if (process.env.CHECK_SRI === '1') {
    const uniq = [...new Map(all.map(t => [t.url, t])).values()]
    let bad = []
    for (const t of uniq) {
      const want = /integrity="(sha384-[^"]+)"/.exec(t.tag)[1]
      const buf = Buffer.from(await (await rawFetch(t.url)).arrayBuffer())
      const got = 'sha384-' + createHash('sha384').update(buf).digest('base64')
      if (got !== want) bad.push(t.url)
    }
    ok('#202 integrity の値が CDN のファイルと一致する', bad.length === 0, bad)
  } else skip('#202 integrity と CDN のファイルの照合', 'CHECK_SRI=1 で実行')
}

// ---------- #213 バックアップのダンプをコミットしない ----------
{
  let ignored = []
  for (const f of ['backup.sql', 'backup-20261019.sql', 'prod.dump.sql', 'backups/x.sql']) {
    try { execFileSync('git', ['check-ignore', '-q', f], { stdio: 'ignore' }); ignored.push(f) } catch { }
  }
  let seedTracked = false
  try { execFileSync('git', ['check-ignore', '-q', 'seed.sql'], { stdio: 'ignore' }) } catch { seedTracked = true }
  ok('#213 .gitignore でバックアップのダンプを除外し、seed.sql は除外しない', ignored.length === 4 && seedTracked, ignored)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
