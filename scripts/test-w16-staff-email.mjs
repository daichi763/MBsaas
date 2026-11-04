// スタッフのメールアドレス（通知・パスワード再設定）の変更（w16-staff-email: #9802）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   ログインできるスタッフの種類（自社雇用の社員・仮登録から本登録した日雇い・協力会社所属・他社連携の企業に切り替えた人・
//   他社連携から自社管理に切り替えた行・承認待ちの申請がある人）ごとに、変更申請の画面のメールの欄が出るか（出ないときは理由）を API で確かめ、
//   承認したときの切り替わり方を確かめる。切り替わり方はサーバーの環境で変わる:
//   - メールを送れない環境（既定の wrangler dev。MAIL_ENABLED=false）: 承認した時点で切り替わる（direct）
//   - メールを送れる環境（MAIL_ENABLED を true にし、RESEND_API_KEY を付けて起動。npm test では test-w16-staff-email-verify.mjs）:
//     承認すると確認待ちになる（verify）。実際の送信を避けるため、宛先を email_suppressions に入れておく（PERSIST を渡すとこのスクリプトが入れる）
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w16-staff-email.mjs
//       BASE=http://127.0.0.1:8812 PERSIST=<保存先> node scripts/test-w16-staff-email.mjs   （メールを送れる環境で起動したサーバー）
import { execSync } from 'node:child_process'
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
    let data = null
    const text = await r.text()
    try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

const PFX = 'SE' + Date.now().toString(36).slice(-5).toUpperCase()
const pfx = PFX.toLowerCase()
// メールを送れる環境のときの宛先。実際に送らないよう、最初に（サーバーへの接続を始める前に）送らないアドレスにしておく（ローカルの D1 のみ）
const VERIFY_EMAIL = process.env.VERIFY_EMAIL || `${pfx}-verify@example.com`
if (process.env.PERSIST) {
  execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${process.env.PERSIST}" --command "INSERT OR IGNORE INTO email_suppressions (email, reason) VALUES ('${VERIFY_EMAIL}', 'bounced')"`, { stdio: 'ignore' })
}
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const OWN_NAME = '株式会社サンプルモバイル人材'
const reqOf = async (c) => must(await c.get('/api/staff/self/profile-requests'), 'profile-requests')
const detail = async (sid) => must(await admin.get(`/api/admin/staff/${sid}`), 'staff detail').profile
const staffByCode = async (code) => must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === code)
const notifs = async (c) => must(await c.get('/api/staff/notifications'), 'notifs').notifications
const phoneOf = (n) => '090' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)

// ---------- 準備: スタッフの種類ごとに1人ずつ ----------
// 社員（自社雇用。管理画面の「スタッフ追加」）
must(await admin.post('/api/admin/staff', { user_code: `${PFX}E`, name: `${PFX} 社員`, password: 'pass1234', email: `${pfx}-e-old@example.com`, force: true }), 'employee')
const E = await staffByCode(`${PFX}E`)
// 仮登録から本登録（ログインを発行）した日雇い・協力会社所属
const finalized = async (key, type, n, extra = {}) => {
  const q = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} ${key}`, phone: phoneOf(n), affiliation_type: type, force: true, ...extra }), 'quick ' + key)
  must(await admin.post(`/api/admin/staff/${q.staff_id}/finalize`, { gender: 'female', user_code: `${PFX}${key}`, password: 'pass1234', email: `${pfx}-${key.toLowerCase()}@example.com` }), 'finalize ' + key)
  return q.staff_id
}
const D = await finalized('D', 'daily_worker', 1)
const P = await finalized('P', 'partner_manual', 2, { new_partner_name: `${PFX}協力会社` })
const se = client(await login('sample', `${PFX}E`)), sd = client(await login('sample', `${PFX}D`)), sp = client(await login('sample', `${PFX}P`))

const first = await reqOf(se)
const MODE = first.email_mode
console.log(`---- サーバーの動き: ${MODE === 'direct' ? 'メールを送れない環境（承認で切り替え）' : 'メールを送れる環境（確認用のメール）'} ----`)
ok('#9802 申請の画面に、メールアドレスの反映のしかた（direct / verify）が返る', MODE === 'direct' || MODE === 'verify', first)

// ---------- (1) ログインできるスタッフの種類ごとに、メールの欄が出る ----------
for (const [label, c] of [['社員（自社雇用）', se], ['仮登録から本登録した日雇い', sd], ['協力会社所属', sp]]) {
  const g = await reqOf(c)
  ok(`#9802 ${label}: メールの欄が出る（email_allowed）`, g.available && g.email_allowed === true && !g.email_reason && g.fields.includes('login_email'), g)
}
ok('#9802 今のメールは伏せて返す', first.current.login_email && first.current.login_email.includes('***') && !first.current.login_email.includes(`${pfx}-e-old`), first.current)

if (MODE === 'direct') {
  // ---------- (2) メールを送れない環境: 承認した時点で切り替わる ----------
  const NEW_E = `${pfx}-e-new@example.com`
  const r = must(await se.post('/api/staff/self/profile-requests', { changes: { login_email: NEW_E } }), 'email request E')
  const pend = await reqOf(se)
  ok('#9802 承認待ちの申請がある人: フォームは出ないが、メールの欄を出せる状態のまま（画面は「承認待ちの申請があります」を出す）', pend.pending === true && pend.email_allowed === true, pend)
  const al = must(await admin.get('/api/admin/staff-requests/profile'), 'admin list')
  ok('#9802 管理者の承認の画面に、承認した時点で切り替わること（direct）が返る', al.email_mode === 'direct' && al.requests.some(x => x.request_id === r.request_id && x.changes.login_email === NEW_E), al.email_mode)
  ok('#9802 承認するまではメールアドレスは変わらない', (await detail(E.staff_id)).email === `${pfx}-e-old@example.com`)
  const ap = await admin.post(`/api/admin/staff-requests/profile/${r.request_id}/approve`, {})
  ok('#9802 承認すると、その時点でメールアドレスが切り替わる（確認待ちにしない）', ap.status === 200 && ap.data.login_email && ap.data.login_email.switched === true && !ap.data.login_email.pending, ap)
  const dE = await detail(E.staff_id)
  ok('#9802 users.email が新しいアドレスになり、確認待ちは残らない', dE.email === NEW_E && !dE.login_email_pending, [dE.email, dE.login_email_pending])
  const n = (await notifs(se)).find(x => x.kind === 'profile_change_approved' && x.related_id === r.request_id)
  ok('#9802 承認の結果の通知は「切り替えました」（確認用のメールの案内を出さない）', n && /切り替えました/.test(n.body) && !/リンクを開くと/.test(n.body), n)
  const hist = must(await admin.get(`/api/admin/employees/${E.staff_id}/history`), 'history').logs
  const h = hist.find(x => x.field === 'login_email')
  ok('#9802 変更履歴に、前のアドレス・新しいアドレス・承認した人が残る', h && h.old_value === `${pfx}-e-old@example.com` && h.new_value === NEW_E && h.changed_by_name && h.label === 'メールアドレス（通知・パスワード再設定）', h)
  const done = await reqOf(se)
  ok('#9802 本人の申請の一覧は承認済みになり、次の申請を出せる', done.pending === false && done.requests.some(x => x.request_id === r.request_id && x.status === 'approved'), done.requests.slice(0, 2))

  // 重複（今の確認用のメールの流れと同じ規則: 同じ会社の別の人のログインで使っているアドレスは反映しない）
  const dup = must(await sd.post('/api/staff/self/profile-requests', { changes: { login_email: NEW_E.toUpperCase() } }), 'dup request')
  const apd = await admin.post(`/api/admin/staff-requests/profile/${dup.request_id}/approve`, {})
  ok('#9802 別のスタッフのログインで使っているアドレスは、承認しても切り替えない（409）', apd.status === 409, apd)
  ok('#9802 反映できなかった申請は承認待ちに戻り、メールは変わらない', (await reqOf(sd)).requests.some(x => x.request_id === dup.request_id && x.status === 'pending')
    && (await detail(D)).email === `${pfx}-d@example.com`)
  must(await sd.post(`/api/staff/self/profile-requests/${dup.request_id}/cancel`), 'cancel dup')

  // 協力会社所属の人も、承認で切り替わる
  const rp = must(await sp.post('/api/staff/self/profile-requests', { changes: { login_email: `${pfx}-p-new@example.com` } }), 'request P')
  ok('#9802 協力会社所属の人も、承認で切り替わる', (await admin.post(`/api/admin/staff-requests/profile/${rp.request_id}/approve`, {})).status === 200
    && (await detail(P)).email === `${pfx}-p-new@example.com`)

  // ---------- 他社連携の企業に切り替えてログインしている人 ----------
  const code = `${pfx}a`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `${PFX}連携先A株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company A')
  const coA = client(await login(code, 'admin'))
  const terms = must(await coA.get('/api/admin/roster/consent-terms'), 'terms')
  const lk = must(await coA.post('/api/admin/roster/link', { code: E.global_staff_code, agreed: true, consent_version: terms.version }), 'link E to A')
  const companies = must(await se.get('/api/staff/me/companies'), 'companies').companies
  const coAId = companies.find(x => x.company_name === `${PFX}連携先A株式会社`)?.company_id
  ok('（前提）社員を連携先 A に連携し、本人が A に切り替えられる', coAId && (await se.post('/api/staff/me/switch-company', { company_id: coAId })).status === 200, companies)
  const gl = await reqOf(se)
  ok('#9802 他社連携の企業に切り替えた人: 所属元（自社）の登録を対象に、メールの欄が出る', gl.available && gl.email_allowed === true && gl.target_company_name === OWN_NAME, gl)
  const NEW_L = `${pfx}-e-linked@example.com`
  const rl = must(await se.post('/api/staff/self/profile-requests', { changes: { login_email: NEW_L } }), 'linked request')
  ok('#9802 申請は所属元（自社）に届く', rl.target_company_name === OWN_NAME && must(await admin.get('/api/admin/staff-requests/profile'), 'al2').requests.some(x => x.request_id === rl.request_id))
  ok('#9802 所属元が承認すると、本人のログイン（所属元の users の行）のメールが切り替わる',
    (await admin.post(`/api/admin/staff-requests/profile/${rl.request_id}/approve`, {})).status === 200 && (await detail(E.staff_id)).email === NEW_L)
  ok('#9802 切り替えた先の企業（A）の画面からも、結果の通知が見える', (await notifs(se)).some(x => x.kind === 'profile_change_approved' && x.related_id === rl.request_id && /切り替えました/.test(x.body)))

  // ---------- 他社連携から自社管理に切り替えた行（A にはログインが無い） ----------
  const chBody = { to_type: 'own_employee', hire_date: today, effective_date: today }
  const pv = must(await coA.post(`/api/admin/staff/${lk.staff_id}/affiliation-change`, { ...chBody, dry_run: true }), 'dry run')
  must(await coA.post(`/api/admin/staff/${lk.staff_id}/affiliation-change`, { ...chBody, preview_token: pv.preview_token }), 'affiliation change')
  const gx = await reqOf(se)
  ok('#9802 ログインの無い行（他社連携から自社管理）: 欄の所に理由と、ログインを発行した会社に切り替える案内を出す',
    gx.available && gx.email_allowed === false && gx.email_reason && gx.email_reason.includes(OWN_NAME) && /担当者/.test(gx.email_reason), gx)
  const rx = await se.post('/api/staff/self/profile-requests', { changes: { login_email: `${pfx}-x@example.com` } })
  ok('#9802 その行ではメールの申請は 400（理由を返す）', rx.status === 400 && rx.data.error === gx.email_reason, rx)
  ok('#9802 その行でも、ほかの項目は申請できる', (await se.post('/api/staff/self/profile-requests', { changes: { work_area: '大阪府' } })).status === 200)
  must(await se.post('/api/staff/me/switch-company', { company_id: 1 }), 'switch back')
  ok('#9802 ログインを発行した会社に戻ると、メールの欄が出る', (await reqOf(se)).email_allowed === true)
} else {
  // ---------- (2) メールを送れる環境: 今までどおり確認用のメールの流れ ----------
  if (!process.env.PERSIST) console.log('（注意）PERSIST が無いため、確認用のメールを実際に送ろうとします')
  const r = must(await se.post('/api/staff/self/profile-requests', { changes: { login_email: VERIFY_EMAIL } }), 'email request verify')
  ok('#9802 管理者の承認の画面に、確認用のメールで切り替わること（verify）が返る', must(await admin.get('/api/admin/staff-requests/profile'), 'al').email_mode === 'verify')
  const ap = await admin.post(`/api/admin/staff-requests/profile/${r.request_id}/approve`, {})
  ok('#9802 承認すると確認待ちになる（すぐには切り替えない）', ap.status === 200 && ap.data.login_email && ap.data.login_email.pending === VERIFY_EMAIL && !ap.data.login_email.switched, ap)
  const dE = await detail(E.staff_id)
  ok('#9802 users.email は前のまま、確認待ちのアドレスが残る', dE.email === `${pfx}-e-old@example.com` && dE.login_email_pending && dE.login_email_pending.email === VERIFY_EMAIL, [dE.email, dE.login_email_pending])
  const n = (await notifs(se)).find(x => x.kind === 'profile_change_approved' && x.related_id === r.request_id)
  ok('#9802 承認の結果の通知は確認用のメールの結果（送れた / 送れなかった）を書き、「切り替えました」とは書かない', n && /確認用のメール/.test(n.body) && !/切り替えました/.test(n.body), n)
  const hist = must(await admin.get(`/api/admin/employees/${E.staff_id}/history`), 'history').logs
  ok('#9802 確認待ちの間は、変更履歴にメールの変更を残さない', !hist.some(x => x.field === 'login_email'), hist.slice(0, 3))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
