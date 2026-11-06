// クライアント・協力会社・再ログインの文言・管理画面からのメールアドレス変更（Sprint 17。w17-masters。#9908 #9909 #9910 #9911 #9803）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   #9908 クライアントの上流・下流: 画面から外す。API が受け取らなくても今の値（stream_type）を変えない
//   #9909 協力会社の項目をクライアントにそろえる（種別・支店・部門・会社のメール・支払条件・評価）。統合で空欄が埋まる
//   #9910 社内担当者（主担当1人＋副担当）をアカウントから選ぶ。選べるのは自社の利用中の管理者だけ。一覧・詳細・アカウントごとの担当。
//         止めたアカウントは「担当から外れた」（active=false）。協力会社の統合で移る・削除で消える。解約企業の削除の対象に入る
//   #9911 有効期限切れの画面の文言（再ログイン）
//   #9803 管理画面のスタッフ詳細でのメールアドレスの変更。サーバーの環境で動きが変わる:
//     - メールを送れない環境（既定の wrangler dev。MAIL_ENABLED=false）: 保存した時点で切り替わる。確認待ちの行は管理者が切り替える・取り消す
//     - メールを送れる環境（npm test では test-w17-masters-verify.mjs）: 確認待ちになる。切り替えはできず、取り消しはできる
//   PERSIST（--persist-to の保存先）があれば、これまでに作られて切り替わっていない確認待ちの行を D1 に作って確かめる
// 実行: BASE=http://127.0.0.1:8814 PERSIST=<保存先> node scripts/test-w17-masters.mjs
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
// D1 を直接触った後は、サーバーが応答するまで待つ
const d1w = async (sql) => { const r = d1(sql); await waitServer(); return r }
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}

const PFX = 'MA' + Date.now().toString(36).slice(-5).toUpperCase()
const pfx = PFX.toLowerCase()
// メールを送れる環境のときに、実際に送らないアドレスにしておく（ローカルの D1 のみ。サーバーへの接続の前に入れる）
const CODE = 'w17m' + Date.now().toString(36).slice(-5) // 他社として作る企業の会社コード
const SUPPRESSED = [`${pfx}-v1@example.com`, `${pfx}-v2@example.com`, `boss-${CODE}@example.com`]
if (PERSIST) d1(`INSERT OR IGNORE INTO email_suppressions (email, reason) VALUES ${SUPPRESSED.map(e => `('${e}', 'bounced')`).join(', ')}`)
await waitServer()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))

// ---------- #9911 有効期限切れの画面の文言 ----------
{
  const a = await (await fetch(`${BASE}/static/admin.js`)).text()
  const s = await (await fetch(`${BASE}/static/staff.js`)).text()
  ok('#9911 管理画面の有効期限切れのボタンは「再ログイン」', a.includes('id="relogin-btn">再ログイン</button>') && !a.includes('>ログインし直す</button>'))
  ok('#9911 管理画面の説明文・トーストも「再ログイン」にそろえる', a.includes('パスワードを入力して再ログインすると') && a.includes("toast('再ログインしました')") && !a.includes('ログインし直すと') && !a.includes('ログインし直しました'))
  ok('#9911 スタッフアプリの期限切れの案内も「再ログイン」', s.includes('再ログインすると、この画面に戻ります') && !s.includes('ログインし直すと'))
}

// ---------- #9908 クライアントの上流・下流 ----------
let C1
{
  const a = await (await fetch(`${BASE}/static/admin.js`)).text()
  ok('#9908 クライアントの画面に上流・下流の入力欄・絞り込み・バッジがない', !a.includes('cl-stream') && !a.includes('nc-stream') && !a.includes('client-stream') && !a.includes("'上流'") && !a.includes('上流/下流'))
  C1 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}商事`, allow_duplicate: true }), 'client').client_id
  let d = must(await admin.get(`/api/admin/clients/${C1}`), 'client').client
  ok('#9908 上流・下流を送らずに登録しても、列の既定の値は残る（upstream）', d.stream_type === 'upstream', d.stream_type)
  must(await admin.put(`/api/admin/clients/${C1}`, { client_name: `${PFX}商事`, stream_type: 'downstream' }), 'put stream')
  must(await admin.put(`/api/admin/clients/${C1}`, { client_name: `${PFX}商事`, phone: '03-1234-5678', memo: 'メモ' }), 'put without stream')
  d = must(await admin.get(`/api/admin/clients/${C1}`), 'client 2').client
  ok('#9908 上流・下流を送らない保存では、今の値を変えない（downstream のまま）', d.stream_type === 'downstream' && d.memo === 'メモ', d)
  must(await admin.put(`/api/admin/clients/${C1}`, { client_name: `${PFX}商事`, stream_type: 'upstream' }), 'put stream back')
}

// ---------- #9910 社内担当者 ----------
// 準備: 自社の管理者を2人足し（同じ姓）、1人はあとで止める
const mkAdmin = async (code, name, role) => must(await admin.post('/api/admin/users', { user_code: code, name, role, password: 'pass1234abcd' }), 'admin ' + code)
await mkAdmin(`${pfx}a`, `${PFX}山田 太郎`, 'sales_manager')
await mkAdmin(`${pfx}b`, `${PFX}山田 花子`, 'field_manager')
const users = must(await admin.get('/api/admin/users'), 'users').users
const UA = users.find(u => u.user_code === `${pfx}a`).user_id
const UB = users.find(u => u.user_code === `${pfx}b`).user_id
const ME = users.find(u => u.user_code === 'admin').user_id
const opts = must(await admin.get('/api/admin/assignees/options'), 'options')
ok('#9910 担当に選べるアカウント: 自社の利用中の管理者（ID・権限つき。同姓を見分けられる）。スタッフは出ない',
  opts.accounts.some(a => a.user_id === UA && a.user_code === `${pfx}a` && a.role === 'sales_manager') && opts.accounts.some(a => a.user_id === UB)
  && opts.accounts.every(a => ['company_admin', 'sales_manager', 'field_manager', 'office_staff'].includes(a.role)) && opts.me === ME, opts.accounts.slice(0, 3))
{
  const mgr = client(await login('sample', 'mgr01'))
  ok('#9910 現場の管理者も担当の選択肢を読める（会社管理者だけに限らない）', (await mgr.get('/api/admin/assignees/options')).status === 200)
  ok('#9910 スタッフは担当の選択肢を読めない', (await client(await login('sample', 'st001')).get('/api/admin/assignees/options')).status === 403)
}
let C2
{
  // 登録で選ぶ（主担当は副担当から外す）
  C2 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}物産`, allow_duplicate: true, assignees: { main_user_id: UA, sub_user_ids: [UB, UA, ME] } }), 'client asg').client_id
  let d = must(await admin.get(`/api/admin/clients/${C2}`), 'client asg detail').client
  const main = d.assignees.filter(a => a.is_primary), subs = d.assignees.filter(a => !a.is_primary)
  ok('#9910 クライアントの登録で主担当1人＋副担当を選べる（主担当は副担当に重ねない）',
    main.length === 1 && main[0].user_id === UA && main[0].active && subs.map(a => a.user_id).sort().join() === [UB, ME].sort().join() && d.assignees[0].is_primary, d.assignees)
  // 編集で変える・送らなければ変えない
  must(await admin.put(`/api/admin/clients/${C2}`, { client_name: `${PFX}物産`, assignees: { main_user_id: UB, sub_user_ids: [UA] } }), 'put asg')
  must(await admin.put(`/api/admin/clients/${C2}`, { client_name: `${PFX}物産`, memo: 'x' }), 'put no asg')
  d = must(await admin.get(`/api/admin/clients/${C2}`), 'client asg detail 2').client
  ok('#9910 編集で担当を入れ替えられる。担当を送らない保存では変えない',
    d.assignees.length === 2 && d.assignees.find(a => a.is_primary).user_id === UB && d.assignees.find(a => !a.is_primary).user_id === UA, d.assignees)
  // 選べないアカウント（スタッフ・他社の管理者・ありえない値）
  const staffUid = (await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: await login('sample', 'st001') } })).json()).user_id
  const bad1 = await admin.put(`/api/admin/clients/${C2}`, { client_name: `${PFX}物産`, assignees: { main_user_id: staffUid, sub_user_ids: [] } })
  const bad2 = await admin.put(`/api/admin/clients/${C2}`, { client_name: `${PFX}物産`, assignees: { main_user_id: 'x', sub_user_ids: [] } })
  const bad3 = await admin.put(`/api/admin/clients/${C2}`, { client_name: `${PFX}物産`, assignees: { main_user_id: null, sub_user_ids: 'abc' } })
  ok('#9910 スタッフ・正しくない値は担当に選べない（400）', bad1.status === 400 && bad2.status === 400 && bad3.status === 400, [bad1, bad2, bad3].map(r => r.status))
  d = must(await admin.get(`/api/admin/clients/${C2}`), 'client asg detail 3').client
  ok('#9910 受け付けなかった保存では、担当も他の項目も変わらない', d.assignees.length === 2 && d.assignees.find(a => a.is_primary).user_id === UB, d.assignees)
  // 一覧に担当が出る
  const list = must(await admin.get('/api/admin/clients'), 'clients').clients
  const row = list.find(c => c.client_id === C2)
  ok('#9910 クライアントの一覧に社内担当者（主担当が先頭）が出る', row && row.assignees.length === 2 && row.assignees[0].is_primary && row.assignees[0].user_id === UB, row && row.assignees)
  // 主担当を外す（副担当だけ）
  must(await admin.put(`/api/admin/clients/${C2}`, { assignees: { main_user_id: null, sub_user_ids: [UA, UB] } }), 'put subs only')
  d = must(await admin.get(`/api/admin/clients/${C2}`), 'client asg detail 4').client
  ok('#9910 主担当なし・副担当だけにもできる（担当だけの保存）', d.assignees.length === 2 && d.assignees.every(a => !a.is_primary) && d.client_name === `${PFX}物産`, d.assignees)
  must(await admin.put(`/api/admin/clients/${C2}`, { assignees: { main_user_id: UA, sub_user_ids: [UB] } }), 'put back')
}

// ---------- #9909 協力会社の項目 ----------
let P1, P2
{
  const r = await admin.post('/api/admin/roster/partners', {
    affiliation_name: `${PFX}協力`, partner_kind: 'corporation', branch_name: '東京支店', department_name: '業務部', company_phone: '03-1111-2222',
    company_email: `info-${pfx}@example.com`, payment_rule: '月末締め・翌月末払い', partner_rating: 4, representative_name: '代表 太郎',
    assignees: { main_user_id: UA, sub_user_ids: [UB] },
  })
  P1 = must(r, 'partner').affiliation_id
  let p = must(await admin.get(`/api/admin/roster/partners/${P1}`), 'partner detail').partner
  ok('#9909 協力会社に種別・支店・部門・会社のメール・支払条件・評価を保存できる（クライアントと同じ項目）',
    p.partner_kind === 'corporation' && p.branch_name === '東京支店' && p.department_name === '業務部' && p.company_email === `info-${pfx}@example.com`
    && p.payment_rule === '月末締め・翌月末払い' && p.partner_rating === 4 && p.company_phone === '03-1111-2222', p)
  ok('#9910 協力会社の登録で社内担当者を選べる', p.assignees.length === 2 && p.assignees[0].is_primary && p.assignees[0].user_id === UA, p.assignees)
  const bads = await Promise.all([
    admin.put(`/api/admin/roster/partners/${P1}`, { partner_rating: 6 }),
    admin.put(`/api/admin/roster/partners/${P1}`, { partner_kind: 'company' }),
    admin.put(`/api/admin/roster/partners/${P1}`, { company_email: 'bad' }),
  ])
  ok('#9909 評価は1〜5、種別は決まった値、会社のメールは形を確かめる（400）', bads.every(b => b.status === 400), bads.map(b => b.status))
  must(await admin.put(`/api/admin/roster/partners/${P1}`, { contact_name: '先方 一郎', phone: '090-1111-2222' }), 'partner contact only')
  p = must(await admin.get(`/api/admin/roster/partners/${P1}`), 'partner detail 2').partner
  ok('#9909 先方の担当者だけの保存では、ほかの項目・社内担当者を変えない', p.contact_name === '先方 一郎' && p.partner_rating === 4 && p.payment_rule && p.assignees.length === 2, p)
  must(await admin.put(`/api/admin/roster/partners/${P1}`, { partner_rating: '' }), 'clear rating')
  p = must(await admin.get(`/api/admin/roster/partners/${P1}`), 'partner detail 3').partner
  ok('#9909 評価は空欄で未評価に戻せる', p.partner_rating === null, p.partner_rating)
  must(await admin.put(`/api/admin/roster/partners/${P1}`, { partner_rating: 4 }), 'rating back')
  // 一覧
  const list = must(await admin.get('/api/admin/roster/partners'), 'partners').partners
  const row = list.find(x => x.affiliation_id === P1)
  ok('#9909 #9910 協力会社の一覧に新しい項目と社内担当者が出る', row && row.payment_rule && row.partner_kind === 'corporation' && row.assignees.length === 2, row)
  // 旧の文字の社内担当者は残る
  P2 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}協力2`, internal_contact_name: '旧担当 さん', assignees: { main_user_id: UB, sub_user_ids: [ME, UA] } }), 'partner 2').affiliation_id
  const p2 = must(await admin.get(`/api/admin/roster/partners/${P2}`), 'partner2').partner
  ok('#9910 これまでの文字の社内担当者は残る（画面では「旧」として出す）', p2.internal_contact_name === '旧担当 さん' && p2.assignees.length === 3, p2)
}

// ---------- #9910 アカウントごとの担当 ----------
{
  const all = must(await admin.get('/api/admin/assignees'), 'assignees').assignments
  const ofA = all.filter(a => a.user_id === UA)
  ok('#9910 アカウントごとに担当している会社（主・副の区別、クライアント・協力会社の別、会社名）が見られる',
    ofA.some(a => a.target_type === 'client' && a.target_id === C2 && a.is_primary && a.target_name === `${PFX}物産`)
    && ofA.some(a => a.target_type === 'partner' && a.target_id === P1 && a.is_primary)
    && ofA.some(a => a.target_type === 'partner' && a.target_id === P2 && !a.is_primary), ofA)
  const one = must(await admin.get(`/api/admin/assignees?user_id=${UB}`), 'assignees one').assignments
  ok('#9910 user_id で1人に絞れる', one.length >= 3 && one.every(a => a.user_id === UB), one)
}

// ---------- #9910 止めたアカウントは担当から外れたと分かる ----------
{
  must(await admin.put(`/api/admin/users/${UB}`, { status: 'suspended' }), 'suspend B')
  const d = must(await admin.get(`/api/admin/clients/${C2}`), 'client after suspend').client
  const b = d.assignees.find(a => a.user_id === UB)
  ok('#9910 アカウントを止めると、担当の行は残り active=false（担当から外れた表示）になる', b && b.active === false && d.assignees.find(a => a.user_id === UA).active === true, d.assignees)
  const opts2 = must(await admin.get('/api/admin/assignees/options'), 'options 2').accounts
  ok('#9910 止めたアカウントは選択肢に出ない', !opts2.some(a => a.user_id === UB))
  const re = await admin.put(`/api/admin/clients/${C2}`, { assignees: { main_user_id: UA, sub_user_ids: [UB] } })
  ok('#9910 止めたアカウントを担当に選び直すことはできない（400）', re.status === 400, re.status)
  must(await admin.put(`/api/admin/clients/${C2}`, { assignees: { main_user_id: UA, sub_user_ids: [] } }), 'drop B')
  const d2 = must(await admin.get(`/api/admin/clients/${C2}`), 'client after drop').client
  ok('#9910 編集して保存すると、止めたアカウントは担当から外れる', d2.assignees.length === 1 && d2.assignees[0].user_id === UA, d2.assignees)
  const p2 = must(await admin.get(`/api/admin/roster/partners/${P2}`), 'partner2 after suspend').partner
  ok('#9910 協力会社でも、止めた主担当は active=false で出る', p2.assignees.find(a => a.is_primary && a.user_id === UB && a.active === false), p2.assignees)
  must(await admin.put(`/api/admin/users/${UB}`, { status: 'active' }), 'resume B')
}

// ---------- #9909 #9910 協力会社の統合・削除 ----------
{
  // P2（主: B、副: admin・A、評価なし・支払条件なし）を P1（主: A、副: B、支払条件あり）に統合する
  must(await admin.put(`/api/admin/roster/partners/${P2}`, { payment_rule: '20日締め', branch_name: '大阪支店' }), 'p2 fields')
  must(await admin.put(`/api/admin/roster/partners/${P1}`, { branch_name: '' }), 'p1 clear branch')
  const m = must(await admin.post(`/api/admin/roster/partners/${P2}/merge`, { into_id: P1 }), 'merge')
  const p = must(await admin.get(`/api/admin/roster/partners/${P1}`), 'merged').partner
  ok('#9909 統合: 統合先の空欄（支店）は統合元の値で埋め、入っている値（支払条件）は変えない', p.branch_name === '大阪支店' && p.payment_rule === '月末締め・翌月末払い', p)
  const main = p.assignees.filter(a => a.is_primary)
  ok('#9910 統合: 統合元の担当者を統合先に移す（主担当は統合先のまま1人。重なる人は1行）',
    main.length === 1 && main[0].user_id === UA && p.assignees.length === 3 && new Set(p.assignees.map(a => a.user_id)).size === 3 && p.assignees.some(a => a.user_id === ME), { m, a: p.assignees })
  const all = must(await admin.get('/api/admin/assignees'), 'assignees after merge').assignments
  ok('#9910 統合した協力会社は、アカウントごとの担当に出ない', !all.some(a => a.target_type === 'partner' && a.target_id === P2))
  const P3 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}協力3`, assignees: { main_user_id: UA, sub_user_ids: [] } }), 'p3').affiliation_id
  must(await admin.del(`/api/admin/roster/partners/${P3}`), 'delete p3')
  const C3 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}消す`, allow_duplicate: true, assignees: { main_user_id: UA, sub_user_ids: [] } }), 'c3').client_id
  must(await admin.del(`/api/admin/clients/${C3}`), 'delete c3')
  if (PERSIST) {
    const left = (await d1w(`SELECT COUNT(*) AS n FROM counterparty_assignees WHERE (target_type = 'partner' AND target_id IN (${P2}, ${P3})) OR (target_type = 'client' AND target_id = ${C3})`))[0][0].n
    ok('#9910 消した・統合したクライアント・協力会社の担当の行は残らない', left === 0, left)
    await waitServer()
  } else {
    const all2 = must(await admin.get('/api/admin/assignees'), 'assignees after delete').assignments
    ok('#9910 消したクライアント・協力会社は、アカウントごとの担当に出ない', !all2.some(a => (a.target_type === 'partner' && a.target_id === P3) || (a.target_type === 'client' && a.target_id === C3)))
  }
}

// ---------- #9910 他社のアカウント・解約企業の削除の対象 ----------
let OTHER
{
  const created = must(await hq.post('/api/hq/companies', { company_code: CODE, company_name: `${PFX} 他社`, admin_code: 'boss', admin_password: 'pass1234', admin_email: `boss-${CODE}@example.com`, admin_name: '他社 管理者', user_limit: '' }), 'create company')
  const other = OTHER = client(await login(CODE, 'boss'))
  const otherMe = must(await other.get('/api/auth/me'), 'other me')
  const bad = await admin.put(`/api/admin/clients/${C2}`, { assignees: { main_user_id: otherMe.user_id, sub_user_ids: [] } })
  ok('#9910 他社の管理者は担当に選べない（400）', bad.status === 400, bad.status)
  const otherAll = must(await other.get('/api/admin/assignees'), 'other assignees').assignments
  const otherOpts = must(await other.get('/api/admin/assignees/options'), 'other opts').accounts
  ok('#9910 他社からは、自社の担当・アカウントが見えない', otherAll.length === 0 && !otherOpts.some(a => a.user_id === UA), { otherAll, otherOpts })
  // 他社の協力会社に担当をつけて、解約企業の削除の対象に入っているか確かめる
  const cid = created.company_id || otherMe.company_id
  must(await other.post('/api/admin/roster/partners', { affiliation_name: `${PFX}他社の協力`, assignees: { main_user_id: otherMe.user_id, sub_user_ids: [] } }), 'other partner')
  const ob = must(await hq.get(`/api/hq/offboarding/${cid}`), 'offboarding')
  const t = (ob.tables || []).find(x => x.target === 'counterparty_assignees')
  ok('#9910 解約企業の削除の対象に counterparty_assignees がある（未対応の表に出ない）', t && t.count === 1 && t.delete !== false && !(ob.unknown_tables || []).includes('counterparty_assignees'), { t, unknown: ob.unknown_tables })
}

// ---------- #9803 管理画面からのメールアドレスの変更 ----------
{
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}E`, name: `${PFX} 社員`, password: 'pass1234', email: `${pfx}-old@example.com`, force: true }), 'staff')
  const S = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}E`)
  const detail = async () => must(await admin.get(`/api/admin/staff/${S.staff_id}`), 'staff detail').profile
  let p = await detail()
  const MODE = p.login_email_mode
  console.log(`---- サーバーの動き: ${MODE === 'direct' ? 'メールを送れない環境（保存した時点で切り替え）' : 'メールを送れる環境（確認用のメール）'} ----`)
  ok('#9803 スタッフ詳細に、メールアドレスの変え方（direct / verify）が返る', MODE === 'direct' || MODE === 'verify', p.login_email_mode)
  if (MODE === 'direct') {
    const r = must(await admin.put(`/api/admin/staff/${S.staff_id}`, { login_email: `${pfx}-new@example.com` }), 'put email')
    p = await detail()
    ok('#9803 メールを送れない環境: 管理者が保存した時点で切り替わる（確認待ちにしない）', r.login_email && r.login_email.switched === true && p.email === `${pfx}-new@example.com` && !p.login_email_pending, { r, email: p.email, pend: p.login_email_pending })
    if (PERSIST) {
      const log = (await d1w(`SELECT old_value, new_value, changed_by FROM employee_change_logs WHERE staff_id = ${S.staff_id} AND field = 'login_email' ORDER BY log_id DESC LIMIT 1`))[0][0]
      ok('#9803 切り替えは変更履歴に残る（変えた管理者・前後のアドレス）', log && log.old_value === `${pfx}-old@example.com` && log.new_value === `${pfx}-new@example.com` && log.changed_by === ME, log)
      // これまでに作られて切り替わっていない確認待ち（期限切れを含む）
      const uid = (await d1w(`SELECT user_id FROM staff_profiles WHERE staff_id = ${S.staff_id}`))[0][0].user_id
      d1(`INSERT INTO login_email_verifications (user_id, company_id, email, token_hash, expires_at, requested_by, created_at)
        VALUES (${uid}, 1, '${pfx}-pending@example.com', 'x-${pfx}-1', '2020-01-01T00:00:00.000Z', ${ME}, '2019-12-29 10:00:00')`)
      d1(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (${uid}, 'prt-${pfx}', '2099-01-01T00:00:00.000Z', '2026-01-01 00:00:00')`)
      await waitServer()
      p = await detail()
      ok('#9803 期限の切れた確認待ちも、スタッフ詳細に出る（切り替え・取り消しに使う ID つき）', p.login_email_pending && p.login_email_pending.email === `${pfx}-pending@example.com` && p.login_email_pending.expired === 1 && p.login_email_pending.verification_id, p.login_email_pending)
      const wrong = await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/apply`, { verification_id: 999999 })
      ok('#9803 違う確認待ちの ID では切り替えない（409）', wrong.status === 409, wrong)
      const ap = must(await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/apply`, { verification_id: p.login_email_pending.verification_id }), 'apply')
      const after = await detail()
      const used = (await d1w(`SELECT used_at FROM password_reset_tokens WHERE token_hash = 'prt-${pfx}'`))[0][0].used_at
      ok('#9803 「このアドレスに切り替える」: 切り替わり、確認待ちは消え、以前のアドレスへの再設定リンクは使えなくなる',
        ap.login_email && ap.login_email.switched && after.email === `${pfx}-pending@example.com` && !after.login_email_pending && !!used, { ap, email: after.email, used })
      // 取り消し
      d1(`INSERT INTO login_email_verifications (user_id, company_id, email, token_hash, expires_at, requested_by, created_at)
        VALUES (${uid}, 1, '${pfx}-cancel@example.com', 'x-${pfx}-2', '2099-01-01T00:00:00.000Z', ${ME}, '2026-11-01 10:00:00')`)
      await waitServer()
      p = await detail()
      must(await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/cancel`, { verification_id: p.login_email_pending.verification_id }), 'cancel')
      const after2 = await detail()
      ok('#9803 「取り消す」: 確認待ちが消え、今のアドレスはそのまま', !after2.login_email_pending && after2.email === `${pfx}-pending@example.com`, after2.login_email_pending)
      // ほかの人が使っているアドレスの確認待ちは切り替えない
      d1(`INSERT INTO login_email_verifications (user_id, company_id, email, token_hash, expires_at, requested_by, created_at)
        VALUES (${uid}, 1, 'staff2@example.com', 'x-${pfx}-3', '2099-01-01T00:00:00.000Z', ${ME}, '2026-11-01 10:00:00')`)
      await waitServer()
      p = await detail()
      const dup = await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/apply`, { verification_id: p.login_email_pending.verification_id })
      ok('#9803 ほかのスタッフが使っているアドレスには切り替えない（409）', dup.status === 409 && (await detail()).email === `${pfx}-pending@example.com`, dup)
      const cross = await OTHER.post(`/api/admin/staff/${S.staff_id}/login-email-pending/cancel`, { verification_id: p.login_email_pending.verification_id })
      ok('#9803 他社からは確認待ちを触れない', cross.status === 404 || cross.status === 401 || cross.status === 403, cross.status)
      must(await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/cancel`, { verification_id: p.login_email_pending.verification_id }), 'cancel dup')
    } else console.log('SKIP  これまでの確認待ちの切り替え・取り消し（PERSIST が無いため）')
  } else {
    const r = must(await admin.put(`/api/admin/staff/${S.staff_id}`, { login_email: SUPPRESSED[0] }), 'put email verify')
    p = await detail()
    ok('#9803 メールを送れる環境: 今までどおり確認待ちになる（すぐには切り替えない）', r.login_email && r.login_email.pending === SUPPRESSED[0] && !r.login_email.switched && p.email === `${pfx}-old@example.com`
      && p.login_email_pending && p.login_email_pending.email === SUPPRESSED[0] && p.login_email_pending.expired === 0, { r, p: p.login_email_pending })
    const ap = await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/apply`, { verification_id: p.login_email_pending.verification_id })
    ok('#9803 メールを送れる環境では、管理者の「切り替える」はできない（409。本人が確認用のメールを開く）', ap.status === 409 && (await detail()).email === `${pfx}-old@example.com`, ap)
    must(await admin.post(`/api/admin/staff/${S.staff_id}/login-email-pending/cancel`, { verification_id: p.login_email_pending.verification_id }), 'cancel verify')
    ok('#9803 メールを送れる環境でも、確認待ちは取り消せる', !(await detail()).login_email_pending)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
