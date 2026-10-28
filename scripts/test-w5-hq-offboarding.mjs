// 解約・停止した企業のデータの書き出しと削除（作業単位 w5-hq-offboarding: #177）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8829 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8829 PERSIST=<保存先> node scripts/test-w5-hq-offboarding.mjs
//   PERSIST は必須（テスト用のデータをローカルの D1・R2 に直接入れ、削除の結果を確かめる）。
//   本番には接続しない（wrangler d1 execute・r2 object は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8829'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（ローカルの D1 の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const TMP = mkdtempSync(join(tmpdir(), 'w5ob-'))
let seq = 0
function sql(command) {
  const file = join(TMP, `q${++seq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out).at(-1).results
}
function r2(args) {
  try { return execFileSync('npx', ['wrangler', 'r2', 'object', ...args, '--local', '--persist-to', `"${PERSIST}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e) { return null }
}
const SUF = String(Date.now()).slice(-6)
const jstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const hqLogin = await rawLogin('', 'hq')
if (hqLogin.status !== 200) { console.log('本部ユーザーでログインできません', hqLogin); process.exit(1) }
const hq = client(hqLogin.cookie)
const admin = client((await rawLogin('sample', 'admin')).cookie)

ok('企業の管理者は解約の API を使えない（403）', (await admin.get('/api/hq/offboarding')).status === 403)

// ---------- テスト用の企業とデータ ----------
const code = `w5ob${SUF}`
let r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: '解約テスト企業', admin_code: 'admin', admin_password: 'Passw0rd!Long' })
ok('テスト用の企業を作る', r.status === 200, r.data)
const cid = Number(sql(`SELECT company_id FROM companies WHERE company_code = '${code}'`)[0].company_id)
const photoKey = `w5ob/${SUF}/photo.jpg`, docKey = `w5ob/${SUF}/doc.pdf`, contractKey = `w5ob/${SUF}/contract.pdf`
sql(`
INSERT INTO users (company_id, user_code, name, role, password_hash, email, phone) VALUES (${cid}, 's1', '解約 太郎', 'staff', 'x', 'taro-${SUF}@example.com', '090-0000-0000');
INSERT INTO staff_profiles (user_id, company_id, kana, memo) SELECT user_id, ${cid}, 'カイヤク タロウ', '個人メモ' FROM users WHERE company_id = ${cid} AND user_code = 's1';
INSERT INTO clients (company_id, client_name) VALUES (${cid}, '解約テスト取引先');
INSERT INTO projects (company_id, project_name, client_id) SELECT ${cid}, '解約テスト案件', client_id FROM clients WHERE company_id = ${cid};
INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status)
  SELECT ${cid}, sp.staff_id, p.project_id, '2025-01-0' || n.v, '10:00', '19:00', 'confirmed'
  FROM staff_profiles sp, projects p, (SELECT 1 AS v UNION SELECT 2 UNION SELECT 3) n WHERE sp.company_id = ${cid} AND p.company_id = ${cid};
INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, photo_key) SELECT company_id, staff_id, shift_id, 'check_in', CASE WHEN work_date = '2025-01-01' THEN '${photoKey}' END FROM shifts WHERE company_id = ${cid};
INSERT INTO daily_reports (company_id, staff_id, project_id, work_date) SELECT company_id, staff_id, project_id, work_date FROM shifts WHERE company_id = ${cid};
INSERT INTO employee_records (staff_id, company_id, bank_name, account_number) SELECT staff_id, ${cid}, 'テスト銀行', '1234567' FROM staff_profiles WHERE company_id = ${cid};
INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size) SELECT ${cid}, staff_id, '履歴書.pdf', '${docKey}', 'application/pdf', 4 FROM staff_profiles WHERE company_id = ${cid};
INSERT INTO client_documents (company_id, client_id, original_file_name, storage_key, mime_type, file_size) SELECT ${cid}, client_id, '契約書.pdf', '${contractKey}', 'application/pdf', 4 FROM clients WHERE company_id = ${cid};
INSERT INTO notices (company_id, title) VALUES (${cid}, '解約テストのお知らせ');
WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 1200)
  INSERT INTO user_notifications (company_id, user_id, kind, title) SELECT ${cid}, u.user_id, 'test', '通知' || n.v FROM n, users u WHERE u.company_id = ${cid} AND u.user_code = 's1';
`)
const photoFile = join(TMP, 'photo.jpg'); writeFileSync(photoFile, 'JPEGDATA')
const docFile = join(TMP, 'doc.pdf'); writeFileSync(docFile, '%PDF')
r2(['put', `mbsaas-attendance-photos/${photoKey}`, `--file="${photoFile}"`])
r2(['put', `mbsaas-staff-documents/${docKey}`, `--file="${docFile}"`])
r2(['put', `mbsaas-client-contracts/${contractKey}`, `--file="${docFile}"`])
const otherBefore = sql(`SELECT (SELECT COUNT(*) FROM shifts WHERE company_id != ${cid}) AS s, (SELECT COUNT(*) FROM attendance_reports WHERE company_id != ${cid}) AS a,
  (SELECT COUNT(*) FROM users WHERE company_id != ${cid} AND password_hash = '!anonymized') AS anon`)[0]

// ---------- 契約終了の登録 ----------
r = await hq.get('/api/hq/offboarding')
ok('利用中の企業は一覧に出ない', r.status === 200 && !r.data.companies.some(c => c.company_id === cid), r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: jstToday, confirm_company_code: code })
ok('停止していない企業には契約終了を登録できない（409）', r.status === 409, r.data)
r = await hq.put(`/api/hq/companies/${cid}`, { active_status: 'inactive' })
ok('企業を停止にする', r.status === 200, r.data)
r = await hq.get('/api/hq/offboarding')
ok('停止した企業は一覧に出る（未登録）', r.data.companies.some(c => c.company_id === cid && !c.status), r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: jstToday, confirm_company_code: 'wrong' })
ok('会社コードが違うと登録できない（400）', r.status === 400 && r.data?.field === 'confirm_company_code', r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: jstToday, grace_days: 10, confirm_company_code: code })
ok('猶予日数が範囲外だと登録できない（400）', r.status === 400 && r.data?.field === 'grace_days', r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: '2025-02-30', confirm_company_code: code })
ok('存在しない日付は登録できない（400）', r.status === 400 && r.data?.field === 'contract_end_date', r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: jstToday, confirm_company_code: code.toUpperCase(), reason: '解約の申し出' })
ok('契約終了を登録すると、契約終了日＋90日から削除できる', r.status === 200 && r.data?.delete_after === addDays(jstToday, 90), r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: jstToday, confirm_company_code: code })
ok('進行中の処理があると二重に登録できない（409）', r.status === 409, r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: code, confirm_text: '削除する', export_skip_reason: 'テスト' })
ok('猶予期間中は削除できない（409）', r.status === 409 && /猶予/.test(r.data?.error || ''), r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/cancel`, { reason: 'テストの取消' })
ok('猶予中は取り消せる', r.status === 200, r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: addDays(jstToday, -40), grace_days: 30, confirm_company_code: code })
ok('取り消した後は登録し直せる（猶予を過ぎた日付）', r.status === 200 && r.data?.delete_after === addDays(jstToday, -10), r.data)

// ---------- 件数（dry-run） ----------
r = await hq.get(`/api/hq/offboarding/${cid}`)
const cnt = Object.fromEntries((r.data?.tables || []).map(t => [t.target, t.count]))
ok('詳細は表ごとの件数を返す', r.status === 200 && cnt.shifts === 3 && cnt.attendance_reports === 3 && cnt.daily_reports === 3 && cnt.employee_records === 1 && cnt.users === 2, cnt)
ok('R2 のファイルの件数を返す', r.data?.files?.attendance_reports === 1 && r.data?.files?.staff_documents === 1 && r.data?.files?.client_documents === 1, r.data?.files)
ok('削除できる状態（can_delete）と、まだ書き出していないこと（exported=false）を返す', r.data?.can_delete === true && r.data?.exported === false, { can: r.data?.can_delete, ex: r.data?.exported })
ok('企業の行を持つ表はすべて削除の一覧に入っている（未対応の表なし）', Array.isArray(r.data?.unknown_tables) && r.data.unknown_tables.length === 0, r.data?.unknown_tables)
ok('操作の記録に登録と取消が残る', ['start', 'cancel'].every(a => r.data?.events?.some(e => e.action === a)), r.data?.events)

// ---------- 削除の確認（書き出し前） ----------
r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: code })
ok('「削除する」の入力がないと削除できない（400）', r.status === 400 && r.data?.field === 'confirm_text', r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: 'sample', confirm_text: '削除する' })
ok('会社コードが違うと削除できない（400）', r.status === 400 && r.data?.field === 'confirm_company_code', r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: code, confirm_text: '削除する' })
ok('書き出しをしていないと、理由なしでは削除できない（409）', r.status === 409 && r.data?.code === 'not_exported', r.data)

// ---------- 書き出し ----------
r = await hq.get(`/api/hq/offboarding/${cid}/export/users?offset=0`)
ok('利用者の CSV を書き出せる（パスワード・二段階認証の列は出さない）', r.status === 200 && /解約 太郎/.test(r.text) && !/password_hash|totp_secret|mfa_recovery_codes/.test(r.text), r.text.slice(0, 300))
ok('最後のページでは X-Export-Next が空', r.headers.get('x-export-next') === '' && r.headers.get('x-export-rows') === '2', [r.headers.get('x-export-next'), r.headers.get('x-export-rows')])
r = await hq.get(`/api/hq/offboarding/${cid}/export/employee_records?offset=0`)
ok('従業員データの CSV を書き出せる', r.status === 200 && /1234567/.test(r.text), r.text.slice(0, 300))
{
  const p1 = await hq.get(`/api/hq/offboarding/${cid}/export/user_notifications?offset=0`)
  const p3 = await hq.get(`/api/hq/offboarding/${cid}/export/user_notifications?offset=1000`)
  ok('500行を超える表は区切って書き出す（X-Export-Next に次の offset）', p1.headers.get('x-export-next') === '500' && p1.headers.get('x-export-rows') === '500'
    && p3.headers.get('x-export-next') === '' && p3.headers.get('x-export-rows') === '200', [p1.headers.get('x-export-next'), p3.headers.get('x-export-rows')])
}
r = await hq.get(`/api/hq/offboarding/${cid}/export/sessions?offset=0`)
ok('セッションは書き出せない（404）', r.status === 404, r.data)
r = await hq.get(`/api/hq/offboarding/1/export/users?offset=0`)
ok('停止していない企業は書き出せない（409）', r.status === 409, r.data)
r = await hq.get(`/api/hq/offboarding/${cid}/files?offset=0`)
const photo = (r.data?.files || []).find(f => f.source === 'attendance_reports')
ok('写真・書類の一覧を返す', r.status === 200 && r.data.files.length === 3 && !!photo, r.data)
if (photo) {
  r = await hq.get(`/api/hq/offboarding/${cid}/files/attendance_reports/${photo.id}`)
  ok('写真を取得できる', r.status === 200 && r.text === 'JPEGDATA', { status: r.status, text: r.text.slice(0, 50) })
}
const sampleReport = sql(`SELECT attendance_id FROM attendance_reports WHERE company_id != ${cid} LIMIT 1`)[0]
if (sampleReport) {
  r = await hq.get(`/api/hq/offboarding/${cid}/files/attendance_reports/${sampleReport.attendance_id}`)
  ok('他の企業の行のファイルは取得できない（404）', r.status === 404, r.data)
}
r = await hq.get(`/api/hq/offboarding/${cid}`)
ok('書き出すと exported=true になり、記録が残る', r.data?.exported === true && r.data.events.some(e => e.action === 'export') && r.data.events.some(e => e.action === 'file'), r.data?.events)

// ---------- 削除 ----------
sql(`CREATE TABLE zz_w5ob_probe (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL)`)
r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: code, confirm_text: '削除する' })
ok('削除の一覧にない、企業の行を持つ表があると削除を始めない（409）', r.status === 409 && r.data?.code === 'unknown_tables' && /zz_w5ob_probe/.test(r.data?.error || ''), r.data)
sql(`DROP TABLE zz_w5ob_probe`)
let p = null
for (let i = 0; i < 50; i++) {
  r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: code, confirm_text: '削除する' })
  if (r.status !== 200) break
  p = r.data
  if (p.done || p.error) break
}
ok('削除を最後まで進められる', r.status === 200 && p?.done === true && !p?.error, { status: r.status, data: r.data })
const after = sql(`SELECT (SELECT COUNT(*) FROM shifts WHERE company_id = ${cid}) AS shifts, (SELECT COUNT(*) FROM attendance_reports WHERE company_id = ${cid}) AS ar,
  (SELECT COUNT(*) FROM daily_reports WHERE company_id = ${cid}) AS dr, (SELECT COUNT(*) FROM employee_records WHERE company_id = ${cid}) AS er,
  (SELECT COUNT(*) FROM staff_documents WHERE company_id = ${cid}) AS sd, (SELECT COUNT(*) FROM projects WHERE company_id = ${cid}) AS pj,
  (SELECT COUNT(*) FROM clients WHERE company_id = ${cid}) AS cl, (SELECT COUNT(*) FROM notices WHERE company_id = ${cid}) AS nt, (SELECT COUNT(*) FROM user_notifications WHERE company_id = ${cid}) AS un,
  (SELECT COUNT(*) FROM offboarding_pending_r2) AS pending,
  (SELECT COUNT(*) FROM users WHERE company_id = ${cid} AND (email IS NOT NULL OR phone IS NOT NULL OR password_hash != '!anonymized' OR name LIKE '解約 太郎%')) AS users_left,
  (SELECT COUNT(*) FROM staff_profiles WHERE company_id = ${cid} AND (kana IS NOT NULL OR memo IS NOT NULL OR anonymized_at IS NULL)) AS staff_left,
  (SELECT COUNT(*) FROM companies WHERE company_id = ${cid}) AS company`)[0]
ok('企業のシフト・勤怠・日報・従業員データ・書類・案件・取引先・お知らせが消える', ['shifts', 'ar', 'dr', 'er', 'sd', 'pj', 'cl', 'nt', 'un', 'pending'].every(k => after[k] === 0), after)
ok('利用者とスタッフは匿名化され、企業の行は残る', after.users_left === 0 && after.staff_left === 0 && after.company === 1, after)
const otherAfter = sql(`SELECT (SELECT COUNT(*) FROM shifts WHERE company_id != ${cid}) AS s, (SELECT COUNT(*) FROM attendance_reports WHERE company_id != ${cid}) AS a,
  (SELECT COUNT(*) FROM users WHERE company_id != ${cid} AND password_hash = '!anonymized') AS anon`)[0]
ok('他の企業のデータは変わらない', JSON.stringify(otherBefore) === JSON.stringify(otherAfter), { otherBefore, otherAfter })
ok('R2 の写真・書類・契約書類が消える', r2(['get', `mbsaas-attendance-photos/${photoKey}`, '--pipe']) === null && r2(['get', `mbsaas-staff-documents/${docKey}`, '--pipe']) === null
  && r2(['get', `mbsaas-client-contracts/${contractKey}`, '--pipe']) === null)
ok('削除の件数が記録される', p?.deleted?.shifts === 3 && p?.deleted?.attendance_reports === 3 && p?.deleted?.anonymized_users === 2 && p?.deleted?.r2_photos === 1 && p?.deleted?.r2_contracts === 1 && p?.deleted?.user_notifications === 1200, p?.deleted)
r = await hq.get(`/api/hq/offboarding/${cid}`)
ok('状態は削除済みになり、完了の記録が残る', r.data?.offboarding?.status === 'completed' && !!r.data.offboarding.completed_at && r.data.events.some(e => e.action === 'complete'), r.data?.offboarding)
r = await hq.get(`/api/hq/offboarding/${cid}/record.csv`)
ok('削除の記録を CSV で出せる', r.status === 200 && /シフト/.test(r.text) && /削除の完了/.test(r.text), r.text.slice(0, 300))
r = await hq.get(`/api/hq/offboarding/${cid}/export/users?offset=0`)
ok('削除した企業は書き出せない（409）', r.status === 409, r.data)
r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: code, confirm_text: '削除する' })
ok('削除済みの企業はもう一度削除できない（409）', r.status === 409, r.data)
r = await rawLogin(code, 'admin', 'Passw0rd!Long')
ok('削除した企業の管理者はログインできない', r.status !== 200, r)

const failed = results.filter(x => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
