// 退職日の検証・定期削除の安全策・空欄で保存したら NULL にする更新（w1-staff-save-retention: #5 #18 #34 #50 #51 #92 #139 #436）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --test-scheduled --persist-to <保存先>` で起動していること
//   定期削除・退職予定の切り替えの確認には、環境変数 PERSIST に --persist-to の保存先を指定する
//   （ローカルの D1 に直接書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用。RETENTION_ENABLED=true で起動すること: --var RETENTION_ENABLED:true）
// 実行: BASE=http://127.0.0.1:8799 PERSIST=<保存先> node scripts/test-w1-staff-save-retention.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function tryLogin(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code) {
  const r = await tryLogin(company_code, user_code)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
// 別プロセスから D1 に書き込むと、ローカルの開発サーバーの接続がいったん切れるため、応答が戻るまで待つ
// D1 に書き込んだ・読んだ後は、開発サーバーが応答に戻るまで待つ
async function d1w(sql) { const r = d1(sql); await waitServer(); return r }
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))
const emp = async (sid) => (await admin.get(`/api/admin/employees/${sid}`)).data
const putEmp = (sid, body) => admin.put(`/api/admin/employees/${sid}`, body)

// ---------- #18 従業員管理: 空欄で保存したら消える・送らなかった項目は残る ----------
{
  const sid = 19
  let r = await putEmp(sid, { contract_end: '2027-03-31', bank_name: 'テスト銀行', emergency_phone: '090-0000-9999', dependents_count: 2, profile: { date_of_birth: '1990-04-01', kana: 'テスト' } })
  ok('#18 従業員管理: 値を保存できる', r.status === 200, r)
  let d = await emp(sid)
  ok('#18 （前提）保存した値が入っている', d.record.contract_end === '2027-03-31' && d.record.bank_name === 'テスト銀行' && d.record.dependents_count === 2 && d.staff.date_of_birth === '1990-04-01', [d.record.contract_end, d.record.bank_name, d.staff.date_of_birth])
  r = await putEmp(sid, { contract_end: null, bank_name: '', dependents_count: null, profile: { date_of_birth: null, kana: '' } })
  d = await emp(sid)
  ok('#18 契約終了・口座・扶養人数・生年月日・フリガナを空欄で保存すると NULL になる', r.status === 200 && d.record.contract_end === null && d.record.bank_name === null && d.record.dependents_count === null && d.staff.date_of_birth === null && d.staff.kana === null, [r.status, d.record.contract_end, d.record.bank_name, d.record.dependents_count, d.staff.date_of_birth, d.staff.kana])
  ok('#18 送らなかった項目（緊急連絡先の電話）は変わらない', d.record.emergency_phone === '090-0000-9999', d.record.emergency_phone)
}

// ---------- #92 顧客担当者・代表者 ----------
{
  const cid = 1
  let r = await admin.post(`/api/admin/clients/${cid}/contacts`, { contact_name: 'テスト担当', phone: '03-1111-2222', email: 'tanto@example.com', branch_name: '本店', title: '課長' })
  const contacts = (await admin.get(`/api/admin/clients/${cid}/contacts`)).data.contacts
  const ct = contacts.find(x => x.contact_name === 'テスト担当')
  ok('#92 （前提）担当者を登録できる', r.status === 200 && ct && ct.phone === '03-1111-2222', r)
  r = await admin.put(`/api/admin/clients/contacts/${ct.contact_id}`, { contact_name: 'テスト担当', phone: null, email: '', branch_name: null, title: null, department: null })
  const ct2 = (await admin.get(`/api/admin/clients/${cid}/contacts`)).data.contacts.find(x => x.contact_id === ct.contact_id)
  ok('#92 担当者の電話・メール・支店・役職を空欄で保存すると消える', r.status === 200 && ct2.phone === null && ct2.email === null && ct2.branch_name === null && ct2.title === null, ct2)
  r = await admin.put(`/api/admin/clients/contacts/${ct.contact_id}`, { contact_name: '  ' })
  ok('#92 担当者氏名は空にできない（400）', r.status === 400, r)
  r = await admin.put(`/api/admin/clients/${cid}`, { representative_title: '代表取締役', representative_name: '代表 太郎', representative_kana: 'ダイヒョウ タロウ' })
  r = await admin.put(`/api/admin/clients/${cid}`, { representative_title: null, representative_name: '', representative_kana: null, invoice_number: null })
  const cl = (await admin.get(`/api/admin/clients/${cid}`)).data
  const c1 = cl.client || cl
  ok('#92 代表者の役職・氏名・フリガナを空欄で保存すると消える', r.status === 200 && c1.representative_title === null && c1.representative_name === null && c1.representative_kana === null, [r.status, c1.representative_title, c1.representative_name])
  ok('#92 送らなかった会社名は残る', !!c1.client_name, c1.client_name)
  r = await admin.put(`/api/admin/clients/${cid}`, { client_name: '' })
  ok('#92 会社名は空にできない（400）', r.status === 400, r)
  await admin.del(`/api/admin/clients/contacts/${ct.contact_id}`)
}

// ---------- #34 退職予定（今日以降の退職日） ----------
{
  const sid = 20 // st020
  let r = await putEmp(sid, { profile: { retired_at: addDays(today, 10), employment_status: 'retired' } })
  let d = await emp(sid)
  ok('#34 今日以降の退職日は退職予定として保存し、在籍状況は退職にしない', r.status === 200 && d.staff.retired_at === addDays(today, 10) && d.staff.employment_status !== 'retired', [r, d.staff.retired_at, d.staff.employment_status])
  ok('#34 退職予定のスタッフはログインできる', (await tryLogin('sample', 'st020')).status === 200)
  r = await putEmp(sid, { profile: { retired_at: today, employment_status: 'retired' } })
  ok('#34 退職日が今日でも当日まではログインできる', r.status === 200 && (await tryLogin('sample', 'st020')).status === 200, r)
  r = await putEmp(sid, { profile: { retired_at: null, employment_status: 'working' } })
  d = await emp(sid)
  ok('#34 退職予定を取り消せる', r.status === 200 && d.staff.retired_at === null && d.staff.employment_status === 'working', [r, d.staff.retired_at])
}

// ---------- #139 在籍状況と退職日の食い違い ----------
{
  const sid = 18 // st018
  const yesterday = addDays(today, -1)
  let r = await putEmp(sid, { profile: { retired_at: yesterday, employment_status: 'retired' } })
  let d = await emp(sid)
  ok('#139 （前提）過去の退職日で退職にするとログインできなくなる', r.status === 200 && d.staff.employment_status === 'retired' && (await tryLogin('sample', 'st018')).status !== 200, [r, d.staff.employment_status])
  r = await putEmp(sid, { profile: { retired_at: yesterday, employment_status: 'working' } })
  ok('#139 在職中なのに過去の退職日が残っている送信は 400', r.status === 400, r)
  r = await putEmp(sid, { profile: { employment_status: 'retired', retired_at: null } })
  ok('#139 退職なのに退職日が空の送信は 400', r.status === 400, r)
  r = await putEmp(sid, { profile: { retired_at: null, employment_status: 'working' } })
  d = await emp(sid)
  ok('#139 退職日を消して在職中に戻すとログインできる', r.status === 200 && d.staff.employment_status === 'working' && d.staff.retired_at === null && (await tryLogin('sample', 'st018')).status === 200, [r, d.staff])
}

// ---------- #5 退職日の検証 ----------
{
  const sid = 17 // st017
  let r = await putEmp(sid, { profile: { retired_at: '2026-13-01', employment_status: 'retired' } })
  ok('#5 存在しない日付は 400', r.status === 400, r)
  r = await putEmp(sid, { profile: { retired_at: '2016-01-15', employment_status: 'retired' } })
  ok('#5 7年以上前の退職日は確認が必要（409・confirm_required）で、保存されない', r.status === 409 && r.data.confirm_required === true && /定期削除/.test(r.data.error) && (await emp(sid)).staff.retired_at === null, r)
  r = await putEmp(sid, { profile: { retired_at: addDays(today, -400), employment_status: 'retired' } })
  ok('#5 1年以上前の退職日も確認が必要（409）', r.status === 409 && r.data.confirm_required === true, r)
  r = await admin.put(`/api/admin/staff/${sid}`, { retired_at: '2016-01-15' })
  ok('#5 スタッフ詳細からの保存でも検証する（自社雇用は 403、それ以外は 409）', r.status === 403 || r.status === 409, r)
  r = await putEmp(sid, { profile: { retired_at: '2016-01-15', employment_status: 'retired', retired_at_confirmed: true } })
  ok('#5 確認済みなら保存できる', r.status === 200 && (await emp(sid)).staff.retired_at === '2016-01-15', r)
  r = await putEmp(sid, { profile: { retired_at: '2016-01-15', employment_status: 'retired' } })
  ok('#5 保存済みと同じ退職日なら、再保存で確認を求めない', r.status === 200, r)
  const hq = client(await login('sample', 'hq'))
  const sch = await hq.get('/api/hq/retention/schedule')
  const inScheduled = (sch.data.scheduled || []).some(s => s.staff_id === sid)
  const inExcluded = (sch.data.excluded || []).some(s => s.staff_id === sid)
  ok('#5 本部の一覧: 退職日より後にシフトがある人は「対象外」、無ければ「次回削除予定」に出る', sch.status === 200 && (inScheduled || inExcluded) && !(inScheduled && inExcluded), [sch.status, inScheduled, inExcluded])
  r = await putEmp(sid, { profile: { retired_at: null, employment_status: 'working' } })
  ok('#5 （後片付け）退職日を消す', r.status === 200, r)
}

// ---------- 定期削除（#5 #50 #51 #436）と退職予定の切り替え（#34）----------
if (!PERSIST) {
  console.log('SKIP  定期削除・退職予定の切り替えの確認（PERSIST が未指定）')
} else {
  // スタッフ 1 を 8 年前に退職したことにし、シフトを退職日より前へ移す。報告用URLのトークンも 1 件作る（テスト用の DB のみ）
  // さらに、データの無い退職者を 110 人入れる（dry-run がバインド上限を超えないことの確認 #436）
  await d1w(`UPDATE users SET retired_at = '2018-01-01' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = 1);
      UPDATE shifts SET work_date = date(work_date, '-9 years') WHERE staff_id = 1;
      INSERT INTO shift_report_tokens (token, shift_id, company_id, staff_id, expires_at) SELECT 'w1test-token', shift_id, company_id, staff_id, '2017-12-31 23:59:00' FROM shifts WHERE staff_id = 1 LIMIT 1;
      INSERT INTO users (company_id, user_code, name, role, password_hash, status, retired_at)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 110) SELECT 1, 'w1ret' || i, '退職者' || i, 'staff', 'x', 'suspended', '2015-01-01' FROM n;
      INSERT INTO staff_profiles (user_id, company_id, employment_status) SELECT user_id, 1, 'retired' FROM users WHERE user_code LIKE 'w1ret%';`)

  const hq = client(await login('sample', 'hq'))
  const dry = await hq.post('/api/hq/retention/dry-run')
  const t = Object.fromEntries((dry.data && dry.data.results || []).map(r => [r.target, r.targetCount]))
  ok('#436 退職者が 100 人を超えても dry-run が成功し、報告用URLも対象に数える', dry.status === 200 && t.shifts > 0 && t.shift_report_tokens >= 1 && !(dry.data.results || []).some(r => r.failedCount > 0), [dry.status, t])

  const before = (await d1w(`SELECT COUNT(*) AS n FROM shifts WHERE staff_id = 1`))[0][0].n

  let sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  ok('（前提）毎日の cron を実行（1回目）', sc.status === 200, sc.status)
  let s1 = await d1w(`SELECT COUNT(*) AS n FROM shifts WHERE staff_id = 1; SELECT retention_flagged_at AS f FROM staff_profiles WHERE staff_id = 1`)
  ok('#5 初めて対象になった回は削除せず、猶予の開始日を付ける', before > 0 && s1[0][0].n === before && s1[1][0].f === today, [before, s1[0][0].n, s1[1][0].f])
  const sch = await hq.get('/api/hq/retention/schedule')
  const row = (sch.data.scheduled || []).find(s => s.staff_id === 1)
  ok('#5 本部の「次回削除予定」に削除予定日つきで出る', row && row.delete_on === addDays(today, 7), row)

  // 猶予が明けたことにして、もう一度 cron を実行する
  await d1w(`UPDATE staff_profiles SET retention_flagged_at = '${addDays(today, -8)}' WHERE staff_id = 1`)

  sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  ok('（前提）毎日の cron を実行（2回目）', sc.status === 200, sc.status)
  const after = await d1w(`SELECT COUNT(*) AS n FROM shifts WHERE staff_id = 1; SELECT COUNT(*) AS n FROM shift_report_tokens WHERE token = 'w1test-token';
    SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id = 1; SELECT COUNT(*) AS n FROM retention_logs WHERE dry_run = 0 AND target = 'shifts' AND failed_count > 0`)
  ok('#51 報告用URLのトークンがあっても、猶予明けの退職者のシフト・勤怠・トークンを削除できる', after[0][0].n === 0 && after[1][0].n === 0 && after[2][0].n === 0 && after[3][0].n === 0, after.map(x => x[0].n))
  const sch2 = await hq.get('/api/hq/retention/schedule')
  ok('#50 削除が済んだ人（データなし）は次の対象・一覧に出ない', !(sch2.data.scheduled || []).some(s => s.staff_id === 1), (sch2.data.scheduled || []).length)

  // 退職予定日を過ぎたスタッフを退職へ切り替える（#34）
  const sid = 16 // st016
  let r = await putEmp(sid, { profile: { retired_at: addDays(today, 3), employment_status: 'retired' } })
  ok('#34 （前提）退職予定を登録', r.status === 200, r)
  await d1w(`UPDATE users SET retired_at = '${addDays(today, -1)}' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = ${sid})`)

  sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  const st = (await d1w(`SELECT u.status, sp.employment_status FROM users u JOIN staff_profiles sp ON sp.user_id = u.user_id WHERE sp.staff_id = ${sid}`))[0][0]
  ok('#34 退職日の翌日の cron で退職（ログイン停止）に切り替わる', sc.status === 200 && st.status === 'suspended' && st.employment_status === 'retired', st)
  ok('#34 切り替わった後はログインできない', (await tryLogin('sample', 'st016')).status !== 200)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
