// ログインの履歴・ログインの強制終了・二段階認証・接続元の制限（作業単位 w4-auth-features: #552 #453 #544、持ち越し #346 #387）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8828 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8828 node scripts/test-w4-auth-features.mjs
//   本番には接続しない。テストのたびに DB を作り直すこと（二段階認証の登録・設定を書き換えるため）。
import { createHmac } from 'node:crypto'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8828'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

async function req(method, path, { cookie, body, headers = {} } = {}) {
  const r = await fetch(`${BASE}${path}`, { method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers }
}
const rawLogin = (company_code, user_code, password = 'pass1234', extra = {}) => req('POST', '/api/auth/login', { body: { company_code, user_code, password }, ...extra })
async function login(company_code, user_code, password = 'pass1234', extra = {}) {
  const r = await rawLogin(company_code, user_code, password, extra)
  if (r.status !== 200 || !r.cookie || r.data?.mfa_required) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}

// RFC 6238 の TOTP（SHA-1・30秒・6桁）
function b32dec(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = []
  for (const ch of s.replace(/[^A-Z2-7]/gi, '').toUpperCase()) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8 } }
  return Buffer.from(out)
}
function totp(secret, step) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', b32dec(secret)).update(buf).digest()
  const o = h[h.length - 1] & 15
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0')
}
const stepNow = () => Math.floor(Date.now() / 30000)
ok('テスト側の TOTP が RFC 6238 の値と一致する（T=59 → 287082）', totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1) === '287082')

// ---------- #552 ログインの履歴 ----------
const admin = await login('sample', 'admin', 'pass1234', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36' } })
await rawLogin('sample', 'st002', 'wrong-password')
await rawLogin('sample', 'nosuchid', 'wrong-password')
await rawLogin('nosuchco', 'admin', 'wrong-password')
{
  const h = await req('GET', '/api/admin/login-history', { cookie: admin })
  ok('#552 会社管理者は自社のログインの履歴を見られる', h.status === 200 && Array.isArray(h.data?.events), h)
  const ev = h.data?.events || []
  ok('#552 成功したログインを、方法・端末とともに残す', ev.some(e => e.user_code === 'admin' && e.result === 'success' && e.method === 'password' && e.device === 'Windows / Chrome'), ev.slice(0, 3))
  ok('#552 パスワードの誤りを、分かった利用者とともに残す', ev.some(e => e.user_code === 'st002' && e.result === 'bad_password' && e.user_name), ev.slice(0, 4))
  ok('#552 存在しない ID への試行も、自社の会社コードなら自社の履歴に出す', ev.some(e => e.user_code === 'nosuchid' && e.result === 'bad_password' && !e.user_id), ev.slice(0, 4))
  ok('#552 会社コードの誤りは会社の履歴に出さない', !ev.some(e => e.company_code === 'nosuchco'))
  const f = await req('GET', '/api/admin/login-history?result=failed', { cookie: admin })
  ok('#552 失敗だけに絞り込める', f.status === 200 && f.data.events.length > 0 && f.data.events.every(e => e.result !== 'success'), f.data?.events?.map(e => e.result))
  const q = await req('GET', '/api/admin/login-history?q=st002', { cookie: admin })
  ok('#552 ID で絞り込める', q.status === 200 && q.data.events.length > 0 && q.data.events.every(e => e.user_code === 'st002'), q.data?.events?.map(e => e.user_code))
  const mgr = await login('sample', 'mgr01')
  ok('#552 会社管理者以外は履歴を見られない', (await req('GET', '/api/admin/login-history', { cookie: mgr })).status === 403)
  // 失敗が続く ID の警告（5回以上）
  for (let i = 0; i < 5; i++) await rawLogin('sample', 'st003', 'wrong-password')
  const a = await req('GET', '/api/admin/login-history', { cookie: admin })
  ok('#552 直近24時間に失敗が続いている ID を出す', (a.data?.alerts || []).some(x => x.user_code === 'st003' && x.failures >= 5), a.data?.alerts)
}

// ---------- #453 ログイン中の端末と強制終了 ----------
{
  const st1 = await login('sample', 'st001', 'pass1234', { headers: { 'User-Agent': IPHONE_UA } })
  const st1b = await login('sample', 'st001')
  const list = await req('GET', '/api/admin/security/staff?q=st001', { cookie: admin })
  const row = (list.data?.staff || []).find(s => s.user_code === 'st001')
  ok('#453 スタッフを番号で探せて、ログイン中の端末の数が出る', list.status === 200 && row && row.session_count >= 2, list.data)
  const active = await req('GET', '/api/admin/security/staff', { cookie: admin })
  ok('#453 空欄なら、ログイン中のスタッフを出す', active.status === 200 && active.data.staff.some(s => s.user_code === 'st001') && active.data.staff.every(s => s.session_count > 0), active.data)
  const mgr = await login('sample', 'mgr01')
  const sess = await req('GET', `/api/admin/staff/${row.staff_id}/sessions`, { cookie: mgr })
  ok('#453 管理系のロールは、スタッフのログイン中の端末（端末・接続元）を見られる', sess.status === 200 && sess.data.sessions.length >= 2 && sess.data.sessions.some(s => s.device === 'iPhone / Safari') && !sess.data.sessions.some(s => 'token' in s), sess.data)
  ok('#453 他社のスタッフ（存在しない ID）は 404', (await req('GET', '/api/admin/staff/999999/sessions', { cookie: mgr })).status === 404)
  ok('#453 スタッフは使えない', (await req('GET', `/api/admin/staff/${row.staff_id}/sessions`, { cookie: st1 })).status === 403)
  const del = await req('DELETE', `/api/admin/staff/${row.staff_id}/sessions`, { cookie: mgr })
  ok('#453 管理者がスタッフのログインをすべての端末で終了できる', del.status === 200 && del.data.revoked >= 2, del)
  ok('#453 終了した端末は 401 になる', (await req('GET', '/api/auth/me', { cookie: st1 })).status === 401 && (await req('GET', '/api/auth/me', { cookie: st1b })).status === 401)
  const h = await req('GET', `/api/admin/login-history?event_type=forced_logout`, { cookie: admin })
  ok('#453 #552 強制終了を、操作した管理者とともに履歴に残す', h.data?.events?.some(e => e.user_code === 'st001' && e.actor_name), h.data?.events)

  // 本人の「すべての端末からログアウト」
  const p1 = await login('sample', 'st001'), p2 = await login('sample', 'st001')
  const mine = await req('GET', '/api/auth/sessions', { cookie: p1 })
  ok('#453 本人は自分のログイン中の端末を見られる（この端末の印つき）', mine.status === 200 && mine.data.sessions.length >= 2 && mine.data.sessions.filter(s => s.current).length === 1, mine.data)
  const out = await req('POST', '/api/auth/logout-all', { cookie: p1 })
  ok('#453 本人がすべての端末からログアウトできる', out.status === 200 && out.data.revoked >= 2, out)
  ok('#453 ほかの端末も 401 になる', (await req('GET', '/api/auth/me', { cookie: p2 })).status === 401)
}

// ---------- #346 別の人がログイン中のブラウザでのログイン ----------
{
  const st = await login('sample', 'st004')
  const r = await rawLogin('sample', 'mgr01', 'pass1234', { cookie: st })
  ok('#346 別の人がログイン中なら、切り替えてよいかを確かめる（409）', r.status === 409 && r.data?.code === 'already_logged_in' && !r.cookie, r)
  const r2 = await req('POST', '/api/auth/login', { cookie: st, body: { company_code: 'sample', user_code: 'mgr01', password: 'pass1234', confirm_switch: true } })
  ok('#346 確かめた後はログインし、前の人のセッションは消す', r2.status === 200 && r2.cookie && (await req('GET', '/api/auth/me', { cookie: st })).status === 401, r2.status)
  const same = await rawLogin('sample', 'mgr01', 'pass1234', { cookie: r2.cookie })
  ok('#346 同じ人のログインし直しは、そのまま通す', same.status === 200, same.status)
}

// ---------- #544 二段階認証 ----------
let secret = null, recovery = []
{
  ok('#544 スタッフは登録できない', (await req('POST', '/api/auth/mfa/setup', { cookie: await login('sample', 'st005') })).status === 403)
  const s = await req('POST', '/api/auth/mfa/setup', { cookie: admin })
  secret = s.data?.secret
  ok('#544 登録を始めると秘密鍵と otpauth の URI を返す', s.status === 200 && /^[A-Z2-7]{32}$/.test(secret || '') && s.data.uri.startsWith('otpauth://totp/'), s.data)
  const bad = await req('POST', '/api/auth/mfa/enable', { cookie: admin, body: { code: '000000', password: 'pass1234' } })
  ok('#544 確認コードが違えば登録しない', bad.status === 400, bad)
  const badPw = await req('POST', '/api/auth/mfa/enable', { cookie: admin, body: { code: totp(secret, stepNow()), password: 'wrong-pass' } })
  ok('#544 現在のパスワードが違えば登録しない', badPw.status === 400, badPw)
  const en = await req('POST', '/api/auth/mfa/enable', { cookie: admin, body: { code: totp(secret, stepNow()), password: 'pass1234' } })
  recovery = en.data?.recovery_codes || []
  ok('#544 正しいコードで登録し、予備コードを8個返す', en.status === 200 && recovery.length === 8 && recovery.every(c => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(c)), en.data)
  const st = await req('GET', '/api/auth/mfa', { cookie: admin })
  ok('#544 状態を返す（登録済み・予備コードの残り）', st.data?.enabled === true && st.data.recovery_codes_left === 8, st.data)
  ok('#544 /auth/me に登録済みを返す', (await req('GET', '/api/auth/me', { cookie: admin })).data?.mfa_enabled === true)

  // ログイン: パスワードの後で確認コード
  const l1 = await rawLogin('sample', 'admin')
  ok('#544 登録した人はパスワードだけではセッションを発行しない', l1.status === 200 && l1.data?.mfa_required === true && l1.data.mfa_token && !l1.cookie, l1)
  const w = await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l1.data.mfa_token, code: '123456' } })
  ok('#544 確認コードの誤りは 401（残りの回数つき）で、セッションを発行しない', w.status === 401 && w.data?.attempts_left === 4 && !w.cookie, w)
  // 登録で使った区切りのコードは使えない（使い回しの防止）。次の区切り（30秒先まで受け付ける）のコードで通る
  const used = stepNow()
  const replay = await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l1.data.mfa_token, code: totp(secret, used - 1) } })
  ok('#544 すでに使った時刻のコードは受け付けない', replay.status === 401, replay)
  const good = await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l1.data.mfa_token, code: totp(secret, used + 1) } })
  ok('#544 正しいコードでセッションを発行する', good.status === 200 && good.cookie && good.data?.user?.role === 'company_admin', good)
  ok('#544 同じ一時トークンは2回使えない', (await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l1.data.mfa_token, code: totp(secret, used + 1) } })).status === 401)
  const l2 = await rawLogin('sample', 'admin')
  const sameCode = await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l2.data.mfa_token, code: totp(secret, used + 1) } })
  ok('#544 一度使ったコードは、別のログインでも使えない', sameCode.status === 401, sameCode)
  const rc = await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l2.data.mfa_token, code: recovery[0].toUpperCase() } })
  ok('#544 予備コードでもログインできる（大文字・小文字は問わない）', rc.status === 200 && rc.cookie, rc)
  const l3 = await rawLogin('sample', 'admin')
  ok('#544 使った予備コードは2回使えない', (await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l3.data.mfa_token, code: recovery[0] } })).status === 401)
  const h = await req('GET', '/api/admin/login-history?q=admin', { cookie: admin })
  ok('#544 #552 確認コードの誤りと、予備コードでのログインを履歴に残す', h.data?.events?.some(e => e.result === 'mfa_failed') && h.data.events.some(e => e.method === 'recovery') && h.data.events.some(e => e.method === 'totp'), h.data?.events?.slice(0, 6))
  // 失敗を5回続けると一時トークンは使えなくなる
  const l4 = await rawLogin('sample', 'admin')
  let last
  for (let i = 0; i < 5; i++) last = await req('POST', '/api/auth/login/mfa', { body: { mfa_token: l4.data.mfa_token, code: '000000' } })
  ok('#544 1回のログインで失敗が5回続くと、最初からやり直しにする', last.status === 401 && last.data?.code === 'mfa_expired', last)
}

// ---------- #544 必須の設定 ----------
{
  const mgr = await login('sample', 'mgr01')
  ok('#544 必須の設定は会社管理者だけ', (await req('PUT', '/api/admin/security/settings', { cookie: mgr, body: { mfa_required: true } })).status === 403)
  const set = await req('PUT', '/api/admin/security/settings', { cookie: admin, body: { mfa_required: true } })
  ok('#544 会社管理者は管理画面の全員に必須にできる', set.status === 200 && set.data.mfa_required === true, set)
  const me = await req('GET', '/api/auth/me', { cookie: mgr })
  ok('#544 未登録の人は登録待ちになる', me.status === 200 && me.data.mfa_setup_required === true, me.data)
  const blocked = await req('GET', '/api/admin/dashboard', { cookie: mgr })
  ok('#544 登録待ちの間は、ほかの API を 403 mfa_setup_required で止める', blocked.status === 403 && blocked.data?.code === 'mfa_setup_required', blocked)
  ok('#544 登録待ちでも登録の API は使える', (await req('POST', '/api/auth/mfa/setup', { cookie: mgr })).status === 200)
  const st = await login('sample', 'st006')
  ok('#544 スタッフは必須の対象外', (await req('GET', '/api/staff/home', { cookie: st })).status === 200)
  const dis = await req('POST', '/api/auth/mfa/disable', { cookie: admin, body: { password: 'pass1234', code: recovery[1] } })
  ok('#544 必須のときは自分で解除できない', dis.status === 409, dis)
  // 会社管理者は、スマホを失くした管理者の二段階認証を解除できる（ここでは自分以外の行がないため、本部から admin を解除して確かめる）
  const off = await req('PUT', '/api/admin/security/settings', { cookie: admin, body: { mfa_required: false } })
  ok('#544 必須を外せる', off.status === 200 && off.data.mfa_required === false, off)
  const wrongDis = await req('POST', '/api/auth/mfa/disable', { cookie: admin, body: { password: 'pass1234', code: '000000' } })
  ok('#544 解除は確認コードが違えば行わない（失敗回数に数える）', wrongDis.status === 400 && (await req('GET', '/api/auth/mfa', { cookie: admin })).data?.enabled === true, wrongDis)
  ok('#544 必須を外すと登録待ちも解ける', (await req('GET', '/api/admin/dashboard', { cookie: mgr })).status === 200)
}

// ---------- #544 接続元の制限 ----------
{
  // 接続元は CF-Connecting-IP で決まる（Cloudflare が付ける。ローカルの開発サーバーでは付かないため、テストでは明示して送る）
  const OFFICE = { 'CF-Connecting-IP': '192.0.2.10' }, OUTSIDE = { 'CF-Connecting-IP': '198.51.100.7' }
  const s = await req('GET', '/api/admin/security/settings', { cookie: admin, headers: OFFICE })
  ok('#544 今の接続元を表示する', s.data?.current_ip === '192.0.2.10', s.data)
  const bad = await req('PUT', '/api/admin/security/settings', { cookie: admin, headers: OFFICE, body: { ip_allowlist: '203.0.113.0/24' } })
  ok('#544 今の接続元を含まない一覧は保存しない（自分が締め出されないように）', bad.status === 400, bad)
  const fmt = await req('PUT', '/api/admin/security/settings', { cookie: admin, headers: OFFICE, body: { ip_allowlist: '999.1.1.1' } })
  ok('#544 IP アドレスの形でなければ 400', fmt.status === 400, fmt)
  const save = await req('PUT', '/api/admin/security/settings', { cookie: admin, headers: OFFICE, body: { ip_allowlist: '192.0.2.0/28\n2001:db8::/32' } })
  ok('#544 今の接続元を含む一覧（CIDR・IPv6）は保存できる', save.status === 200 && save.data.ip_allowlist.length === 2, save)
  const mgr = await login('sample', 'mgr01', 'pass1234', { headers: OFFICE })
  ok('#544 一覧の接続元からはログインして使える', (await req('GET', '/api/auth/me', { cookie: mgr, headers: OFFICE })).status === 200)
  const v6 = await rawLogin('sample', 'mgr01', 'pass1234', { headers: { 'CF-Connecting-IP': '2001:db8:1::5' } })
  ok('#544 IPv6 の範囲も照合する', v6.status === 200, v6)
  const denied = await rawLogin('sample', 'mgr01', 'pass1234', { headers: OUTSIDE })
  ok('#544 一覧にない接続元からはログインできない（403 ip_denied）', denied.status === 403 && denied.data?.code === 'ip_denied' && !denied.cookie, denied)
  const other = await req('GET', '/api/auth/me', { cookie: mgr, headers: OUTSIDE })
  ok('#544 一覧にない接続元からの操作は止め、セッションを消す（401 ip_denied）', other.status === 401 && other.data?.code === 'ip_denied', other)
  ok('#544 止めたセッションは一覧の接続元からも使えない', (await req('GET', '/api/auth/me', { cookie: mgr, headers: OFFICE })).status === 401)
  const st = await login('sample', 'st007', 'pass1234', { headers: OUTSIDE })
  ok('#544 スタッフは接続元の制限の対象外', (await req('GET', '/api/auth/me', { cookie: st, headers: OUTSIDE })).status === 200)
  const h = await req('GET', '/api/admin/login-history?q=mgr01', { cookie: admin, headers: OFFICE })
  ok('#544 #552 接続元の制限で止めたログインを履歴に残す', h.data?.events?.some(e => e.result === 'ip_denied' && e.ip === '198.51.100.7'), h.data?.events?.slice(0, 3))
  const clear = await req('PUT', '/api/admin/security/settings', { cookie: admin, headers: OFFICE, body: { ip_allowlist: '' } })
  ok('#544 制限を外せる', clear.status === 200 && clear.data.ip_allowlist.length === 0, clear)
}

// ---------- 本部 ----------
{
  const hq = await login('', 'hq')
  const h = await req('GET', '/api/hq/login-history', { cookie: hq })
  ok('#552 本部は全社のログインの履歴を見られる（会社コードの誤りも含む）', h.status === 200 && h.data.events.some(e => e.company_code === 'nosuchco') && h.data.events.some(e => e.company_name), h.data?.events?.slice(0, 3))
  const unk = await req('GET', '/api/hq/login-history?company_id=unknown', { cookie: hq })
  ok('#552 本部は会社不明の試行だけに絞り込める', unk.status === 200 && unk.data.events.length > 0 && unk.data.events.every(e => !e.company_id), unk.data?.events?.slice(0, 2))
  ok('#552 会社の管理者は本部の履歴を見られない', (await req('GET', '/api/hq/login-history', { cookie: admin })).status === 403)
  const sec = await req('GET', '/api/hq/security', { cookie: hq })
  ok('#544 本部の設定と本部ユーザーの一覧', sec.status === 200 && Array.isArray(sec.data.users) && sec.data.users.some(u => u.user_code === 'hq'), sec.data)
  const req1 = await req('PUT', '/api/hq/security/settings', { cookie: hq, body: { mfa_required: true } })
  ok('#544 自分が未登録のまま本部の必須にはできない', req1.status === 400, req1)
  const reset = await req('POST', '/api/hq/security/reset-mfa', { cookie: hq, body: { company_code: 'sample', user_code: 'ADMIN' } })
  ok('#544 本部は会社管理者の二段階認証を解除できる（スマホの紛失の窓口）', reset.status === 200 && reset.data.was_enabled === true, reset)
  const after = await rawLogin('sample', 'admin')
  ok('#544 解除した人はパスワードだけでログインできる', after.status === 200 && !after.data?.mfa_required && after.cookie, after)
  const ci = await req('POST', '/api/hq/security/clear-ip', { cookie: hq, body: { company_code: 'sample' } })
  ok('#544 本部は企業の接続元の制限を外せる', ci.status === 200, ci)
  ok('#544 スタッフの行は二段階認証の解除の対象外', (await req('POST', '/api/hq/security/reset-mfa', { cookie: hq, body: { company_code: 'sample', user_code: 'st001' } })).status === 404)
}

// ---------- 持ち越し #387 管理者アカウントの ID を半角にそろえる ----------
{
  const r = await req('POST', '/api/admin/users', { cookie: await login('sample', 'admin'), body: { user_code: 'ｓａｌｅｓ９９', name: '全角 太郎', role: 'sales_manager' } })
  ok('#387 全角で入力した ID を半角で保存する', r.status === 200 && r.data.temp_password, r)
  if (r.status === 200) {
    const l = await rawLogin('sample', 'sales99', r.data.temp_password)
    ok('#387 半角の ID でログインできる', l.status === 200 && l.data?.user_code === 'sales99', l)
    const dup = await req('POST', '/api/admin/users', { cookie: await login('sample', 'admin'), body: { user_code: 'SALES99', name: '重複', role: 'sales_manager' } })
    ok('#387 大文字・小文字だけが違う ID は重複にする', dup.status === 409, dup)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:\n' + failed.map(f => '  - ' + f.name).join('\n')); process.exit(1) }
