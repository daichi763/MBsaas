// 本部の契約管理（作業単位 w5-hq-contracts: #286 #295 #296 #491 #542 #558）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8827 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8827 PERSIST=<保存先> node scripts/test-w5-hq-contracts.mjs
//   PERSIST を指定すると、ローカルの D1 を直接読み書きする確認（最後に使った日時の更新・取引先マスタの自社名）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8827'
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
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w5hqc-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const jstDate = (addDays = 0) => new Date(Date.now() + 9 * 3600 * 1000 + addDays * 86400000).toISOString().slice(0, 10)
const thisMonth = jstDate().slice(0, 7)
const prevMonth = (() => { const [y, m] = thisMonth.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` })()

const hqLogin = await rawLogin('', 'hq')
if (hqLogin.status !== 200) { console.log('本部ユーザーでログインできません', hqLogin); process.exit(1) }
const hq = client(hqLogin.cookie)
const admin = client((await rawLogin('sample', 'admin')).cookie)
const findCo = async (id) => ((await hq.get('/api/hq/companies')).data?.companies || []).find(c => c.company_id === id)

// ---------- 権限 ----------
ok('企業の管理者は本部の請求・料金・履歴の API を使えない（403）',
  (await admin.get('/api/hq/plan-prices')).status === 403 && (await admin.post('/api/hq/billing/close', { month: prevMonth })).status === 403
  && (await admin.get('/api/hq/audit-logs')).status === 403)

// ---------- #295 プランの料金と月ごとの請求記録 ----------
{
  const pp = await hq.get('/api/hq/plan-prices')
  const std = (pp.data?.prices || []).find(p => p.plan === 'standard')
  ok('#295 プランごとの料金を返す（初期値はこれまでの 990円・3人・300円）', pp.status === 200 && std && std.base_fee === 990 && std.included_users === 3 && std.per_user_fee === 300, pp.data)
  const bad = await hq.put('/api/hq/plan-prices', { prices: [{ plan: 'standard', base_fee: -1, included_users: 3, per_user_fee: 300 }] })
  ok('#295 負の料金は保存できない（400）', bad.status === 400, bad)
  const put = await hq.put('/api/hq/plan-prices', { prices: [{ plan: 'standard', base_fee: 5000, included_users: 10, per_user_fee: 500 }] })
  ok('#295 プランの料金を変更できる', put.status === 200 && put.data?.changed === 1, put)
  const co1 = await findCo(1)
  const expect = 5000 + Math.max(0, co1.user_count - 10) * 500
  ok('#295 企業一覧の月額はプランの料金で計算する（standard の企業1）', co1.plan === 'standard' && co1.monthly_fee === expect, { fee: co1?.monthly_fee, expect, n: co1?.user_count })

  ok('#295 これから先の月は締められない（400）', (await hq.post('/api/hq/billing/close', { month: '2999-01' })).status === 400)
  ok('#295 月の形式が違うと 400', (await hq.post('/api/hq/billing/close', { month: '2026-13' })).status === 400)
  const before = await hq.get('/api/hq/companies')
  ok('#295 前の月の記録の状況を返す', before.data?.billing?.prev_month === prevMonth && typeof before.data?.billing?.prev_month_recorded === 'number', before.data?.billing)
  const close = await hq.post('/api/hq/billing/close', { month: prevMonth })
  const activeCount = (before.data?.companies || []).filter(c => c.active_status === 'active').length
  ok('#295 月を締めると、利用中の企業ごとに請求を記録する', close.status === 200 && close.data?.created === activeCount, { close: close.data, activeCount })
  const again = await hq.post('/api/hq/billing/close', { month: prevMonth })
  ok('#295 同じ月を2回締めても、記録済みの企業は変えない', again.status === 200 && again.data?.created === 0, again.data)
  const d1 = await hq.get('/api/hq/companies/1')
  const rec = (d1.data?.billing || []).find(r => r.month === prevMonth)
  ok('#295 企業詳細に請求の記録（人数・プラン・金額）が出る', rec && rec.plan === 'standard' && rec.amount === 5000 + Math.max(0, rec.user_count - 10) * 500 && rec.status === 'issued', rec)
  ok('#295 企業詳細に今月の見込み額を返す', d1.data?.usage?.monthly_fee === expect, d1.data?.usage)
  // 料金を変えても記録済みの金額は変わらない
  await hq.put('/api/hq/plan-prices', { prices: [{ plan: 'standard', base_fee: 990, included_users: 3, per_user_fee: 300 }] })
  const rec2 = ((await hq.get('/api/hq/companies/1')).data?.billing || []).find(r => r.month === prevMonth)
  ok('#295 料金を変えても、記録済みの請求の金額は変わらない', rec2 && rec2.amount === rec.amount, { rec, rec2 })
  const paid = await hq.put(`/api/hq/companies/1/billing/${prevMonth}`, { status: 'paid' })
  const rec3 = ((await hq.get('/api/hq/companies/1')).data?.billing || []).find(r => r.month === prevMonth)
  ok('#295 入金済みにすると入金日が入る', paid.status === 200 && rec3?.status === 'paid' && rec3?.paid_at === jstDate(), rec3)
  ok('#295 入金状態の値が違うと 400', (await hq.put(`/api/hq/companies/1/billing/${prevMonth}`, { status: 'xxx' })).status === 400)
  ok('#295 記録のない月は 404', (await hq.put('/api/hq/companies/1/billing/2001-01', { status: 'paid' })).status === 404)
  const ov = await hq.put(`/api/hq/companies/1/billing/${prevMonth}`, { status: 'overdue', amount: 1234, note: '督促済み' })
  const co1b = await findCo(1)
  ok('#295 滞納にすると一覧で未入金・滞納の企業として印が付く', ov.status === 200 && co1b?.payment_alert === true && co1b?.overdue_months === 1, co1b)
  const rec4 = ((await hq.get('/api/hq/companies/1')).data?.billing || []).find(r => r.month === prevMonth)
  ok('#295 入金済み以外に戻すと入金日は消え、金額・メモを直せる', rec4?.paid_at === null && rec4?.amount === 1234 && rec4?.note === '督促済み', rec4)
}

// ---------- #296 契約の期日と伴走支援の履歴 / #558 会社名と連絡先 ----------
const SUF = String(Date.now()).slice(-6)
const code = `w5hq${SUF}`
let newId = null
{
  const bad = await hq.post('/api/hq/companies', { company_code: code, company_name: 'テスト契約', admin_code: 'admin', trial_ends_at: '2026-02-30' })
  ok('#296 登録で日付の形式が違うと 400（項目名を返す）', bad.status === 400 && bad.data?.field === 'trial_ends_at', bad)
  const badMail = await hq.post('/api/hq/companies', { company_code: code, company_name: 'テスト契約', admin_code: 'admin', contact_email: 'abc' })
  ok('#558 登録で連絡先のメールの形式が違うと 400', badMail.status === 400 && badMail.data?.field === 'contact_email', badMail)
  const r = await hq.post('/api/hq/companies', { company_code: code, company_name: 'テスト契約', admin_code: 'admin', admin_password: 'Passw0rd!x',
    contact_name: '契約 太郎', contact_phone: '03-1234-5678' })
  ok('#296 #558 登録で連絡先を入れられる（トライアル期限は任意）', r.status === 200, r)
  const co = ((await hq.get('/api/hq/companies')).data?.companies || []).find(c => c.company_code === code)
  newId = co?.company_id
  ok('#296 トライアル期限の未設定に印が付く', co && co.active_status === 'trial' && co.trial_no_end === true && co.contact_name === '契約 太郎', co)

  const past = jstDate(-3), soon = jstDate(3)
  let u = await hq.put(`/api/hq/companies/${newId}`, { trial_ends_at: soon, contract_start_at: jstDate(), next_review_at: past })
  let c2 = await findCo(newId)
  ok('#296 期日を保存でき、次の期日は早いほう（過ぎた次回レビュー日）になり「過ぎた」の印が付く', u.status === 200 && c2.next_due === past && c2.due_state === 'past' && c2.trial_no_end === false, c2)
  u = await hq.put(`/api/hq/companies/${newId}`, { next_review_at: '' })
  c2 = await findCo(newId)
  ok('#296 空欄で保存すると期日を消せる。トライアルの終了日が近いと「近い」の印が付く', u.status === 200 && c2.next_review_at === null && c2.next_due === soon && c2.due_state === 'soon', c2)
  ok('#296 日付の形式が違うと 400（項目名を返す）', (await hq.put(`/api/hq/companies/${newId}`, { next_review_at: '2026/1/1' })).data?.field === 'next_review_at')

  const sl = await hq.post(`/api/hq/companies/${newId}/support-logs`, { body: '初回の設定代行を実施', next_action_date: jstDate(14) })
  const det = await hq.get(`/api/hq/companies/${newId}`)
  ok('#296 伴走支援の履歴を追記でき、担当者と次回の予定日が残る', sl.status === 200 && det.data?.support_logs?.[0]?.body === '初回の設定代行を実施' && det.data.support_logs[0].actor_name && det.data.support_logs[0].next_action_date === jstDate(14), det.data?.support_logs)
  ok('#296 次回の予定日を入れると企業の次回レビュー日も更新する', det.data?.company?.next_review_at === jstDate(14), det.data?.company)
  ok('#296 内容が空の記録は 400', (await hq.post(`/api/hq/companies/${newId}/support-logs`, { body: ' ' })).status === 400)
  await hq.post(`/api/hq/companies/${newId}/support-logs`, { body: '2回目の打ち合わせ' })
  const det2 = await hq.get(`/api/hq/companies/${newId}`)
  ok('#296 履歴は上書きされず新しい順に並ぶ', det2.data?.support_logs?.length === 2 && det2.data.support_logs[0].body === '2回目の打ち合わせ', det2.data?.support_logs)
}
{
  // 会社名の変更（企業1）。管理者の画面の会社名・取引先マスタの自社名の行も変わる
  const old = (await findCo(1)).company_name
  ok('#558 会社名を空にはできない（400）', (await hq.put('/api/hq/companies/1', { company_name: '  ' })).data?.field === 'company_name')
  ok('#558 連絡先の電話番号に文字が入っていると 400', (await hq.put('/api/hq/companies/1', { contact_phone: 'abc' })).data?.field === 'contact_phone')
  const newName = old + '（新）'
  const r = await hq.put('/api/hq/companies/1', { company_name: newName, contact_email: 'billing@example.com', billing_address: '東京都千代田区1-1' })
  ok('#558 会社名と連絡先を変更できる', r.status === 200 && r.data?.changed?.includes('company_name'), r)
  const me = await admin.get('/api/auth/me')
  ok('#558 企業の画面にも新しい会社名が出る', me.data?.company_name === newName, me.data)
  if (PERSIST) {
    const aff = sql(`SELECT affiliation_name FROM staff_affiliations WHERE company_id = 1 AND affiliation_name IN ('${old.replace(/'/g, "''")}', '${newName.replace(/'/g, "''")}')`)
    ok('#558 取引先マスタの自社名の行も新しい名前になる（古い名前の行は残らない）', aff.length === 1 && aff[0].affiliation_name === newName, aff)
    const partners = (await admin.get('/api/admin/roster/partners')).data?.partners || []
    ok('#558 古い会社名が取引先の一覧に出ない', !partners.some(p => p.affiliation_name === old), partners.map(p => p.affiliation_name))
  } else skip('#558 取引先マスタの自社名の行')
  const same = await hq.put('/api/hq/companies/1', { company_name: newName })
  ok('#558 変わっていない項目だけを送ると「変更なし」', same.status === 200 && same.data?.changed?.length === 0, same.data)
  await hq.put('/api/hq/companies/1', { company_name: old })
}

// ---------- #542 本部の操作の履歴 ----------
{
  const stop = await hq.put(`/api/hq/companies/${newId}`, { active_status: 'inactive', reason: '契約の解除の申し出' })
  const det = await hq.get(`/api/hq/companies/${newId}`)
  const log = (det.data?.audit_logs || []).find(l => l.action === 'company.update' && l.reason === '契約の解除の申し出')
  ok('#542 停止の操作は、変更前・変更後・理由・操作した人を残す', stop.status === 200 && log && JSON.parse(log.before_json).active_status === 'trial' && JSON.parse(log.after_json).active_status === 'inactive' && log.actor_name, log)
  ok('#542 企業の登録も履歴に残る', (det.data?.audit_logs || []).some(l => l.action === 'company.create'), det.data?.audit_logs?.map(l => l.action))
  const all = (await hq.get('/api/hq/audit-logs')).data?.logs || []
  ok('#542 全体の履歴に、料金の変更・請求の記録・請求の修正が残る', ['plan_price.update', 'billing.close', 'billing.update'].every(a => all.some(l => l.action === a)), all.map(l => l.action))
  const cnt = all.length
  const noChange = await hq.put(`/api/hq/companies/${newId}`, { plan: (await hq.get(`/api/hq/companies/${newId}`)).data.company.plan })
  ok('#542 何も変わらない保存は履歴に残さない', noChange.status === 200 && ((await hq.get('/api/hq/audit-logs')).data?.logs || []).length === cnt)
  // 詳しく記録しない本部の書き込み（管理者アカウントの追加）も、だれが・いつ・どのパスかを残す
  const add = await hq.post(`/api/hq/companies/1/users`, { user_code: `w5mgr${SUF}`, name: '追加 管理者', role: 'office_staff', password: 'Passw0rd!x' })
  const d1 = await hq.get('/api/hq/companies/1')
  ok('#542 ほかの本部の書き込みも、メソッドとパスで履歴に残る（送った内容は残さない）', add.status === 200 && (d1.data?.audit_logs || []).some(l => l.action === 'POST /hq/companies/1/users' && !l.after_json), d1.data?.audit_logs?.slice(0, 3))
  const ip = await hq.post('/api/hq/security/clear-ip', { company_code: 'demo3' })
  const all2 = (await hq.get('/api/hq/audit-logs')).data?.logs || []
  ok('#542 接続元の制限の解除は企業名つきで残る', ip.status === 200 && all2.some(l => l.action === 'security.clear_ip' && l.company_id === 3), all2.slice(0, 3))
  ok('#542 失敗した操作は残さない', (await hq.put('/api/hq/companies/999999', { plan: 'basic' })).status === 404
    && !((await hq.get('/api/hq/audit-logs')).data?.logs || []).some(l => String(l.action).includes('999999')))
}

// ---------- #491 週次アクティブ / #286 最終ログイン ----------
{
  const st = await rawLogin('sample', 'st001')
  ok('スタッフでログインできる', st.status === 200, st)
  const co1 = await findCo(1)
  ok('#491 ログインしたスタッフは週次アクティブに数える', co1.active_users >= 1 && co1.active_users <= co1.user_count, co1)
  const staff = (await admin.get('/api/admin/staff')).data?.staff || []
  const s1 = staff.find(s => s.user_code === 'st001')
  ok('#286 スタッフ一覧に最終ログイン（アプリを使った日時）を返す', s1 && s1.last_login_at && s1.app_last_used_at && s1.app_last_used_at.slice(0, 10) === jstDate(), s1)
  const never = staff.find(s => s.user_role === 'staff' && !s.app_last_used_at)
  ok('#286 一度もログインしていないスタッフは最終ログインが空（未ログイン）', !!never, staff.slice(0, 3))
  const hqUsers = (await hq.get('/api/hq/companies/1')).data?.users || []
  ok('#286 本部の企業のユーザー一覧に、最後にアプリを使った日時を返す', hqUsers.some(u => u.user_code === 'st001' && u.last_seen_at), hqUsers.find(u => u.user_code === 'st001'))
  if (PERSIST) {
    // ログインから日がたっても、セッションで操作すれば last_seen_at が更新され、週次アクティブに数える
    sql(`UPDATE users SET last_login_at = '2000-01-01 00:00:00', last_seen_at = '2000-01-01 00:00:00' WHERE company_id = 1 AND user_code = 'st001'`)
    const before = (await findCo(1)).active_users
    await client(st.cookie).get('/api/auth/me')
    const row = sql(`SELECT last_login_at, last_seen_at FROM users WHERE company_id = 1 AND user_code = 'st001'`)[0]
    ok('#491 セッションで操作すると最後に使った日時が更新される（ログイン日時は変えない）', row.last_login_at === '2000-01-01 00:00:00' && row.last_seen_at.slice(0, 10) === jstDate(), row)
    const after = (await findCo(1)).active_users
    ok('#491 ログインせずに使い続けている人も週次アクティブに数える', after === before + 1, { before, after })
    await client(st.cookie).get('/api/auth/me')
    const row2 = sql(`SELECT last_seen_at FROM users WHERE company_id = 1 AND user_code = 'st001'`)[0]
    ok('#491 1時間以内の操作では書き込まない', row2.last_seen_at === row.last_seen_at, { row, row2 })
    // 退職・停止の人は、最近使っていても数えない
    sql(`UPDATE users SET status = 'suspended' WHERE company_id = 1 AND user_code = 'st001'`)
    const after2 = (await findCo(1)).active_users
    ok('#491 停止の人は週次アクティブに数えない', after2 === after - 1, { after, after2 })
    sql(`UPDATE users SET status = 'active' WHERE company_id = 1 AND user_code = 'st001'`)
    // 8日前の利用は週次に入れず、30日には入れる
    sql(`UPDATE users SET last_login_at = NULL, last_seen_at = '${jstDate(-7)} 12:00:00' WHERE company_id = 1 AND user_code = 'st001'`)
    const c3 = await findCo(1)
    ok('#491 週次は今日を含む直近7日（8日前の利用は数えない）', c3.active_users === before && c3.active_users_30d >= 1, c3)
    // アプリからの勤怠の報告も利用として数える（他社から連携したスタッフは、報告先の企業のスタッフ行で数える）。代理入力は数えない
    sql(`UPDATE users SET last_login_at = NULL, last_seen_at = NULL WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = 2)`)
    const b4 = (await findCo(1)).active_users
    sql(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, entry_method)
      SELECT 1, 2, shift_id, 'w5_rv_test', '${jstNow()}', 'proxy' FROM shifts WHERE staff_id = 2 AND company_id = 1 ORDER BY shift_id LIMIT 1`)
    const c4 = await findCo(1)
    ok('#491 代理入力の報告だけの人は週次アクティブに数えない', c4.active_users === b4, { b4, c4: c4.active_users })
    sql(`UPDATE attendance_reports SET entry_method = 'app' WHERE report_type = 'w5_rv_test'`)
    const c5 = await findCo(1)
    ok('#491 アプリから勤怠を報告した人は、ログインの記録がなくても週次アクティブに数える', c5.active_users === b4 + 1, { b4, c5: c5.active_users })
    sql(`DELETE FROM attendance_reports WHERE report_type = 'w5_rv_test'`)
  } else skip('#491 最後に使った日時の更新と、停止の人・期間の確認')
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
process.exit(failed.length ? 1 : 0)
