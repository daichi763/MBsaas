// 定期削除の対象の追加と、定期処理（cron）の実行記録（w3-retention-a: #192 #193 #198 #228 #234 #480）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、
//   `wrangler dev --local --test-scheduled --var RETENTION_ENABLED:true --persist-to <保存先>` で起動していること
//   （ローカルの D1 に直接書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8820 PERSIST=<保存先> node scripts/test-w3-retention-a.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (r.status !== 200 || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body, raw) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: raw ? { Cookie: cookie } : { Cookie: cookie, 'Content-Type': 'application/json' }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.clone().json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), upload: (p, form) => call('POST', p, form, true) }
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）。ローカルの D1 のみ
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
async function d1w(sql) { const r = d1(sql); await waitServer(); return r }
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
async function cron(expr) {
  const r = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent(expr).replace(/%20/g, '+')}`)
  await waitServer()
  return r.status
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const DAILY = '0 18 * * *', REPORTS = '30 18 * * *'

const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const X = 12 // 退職後7年で削除・匿名化するスタッフ（st012）
const Y = 13 // 削除の途中で失敗させるスタッフ（st013）
const KEEP = 5 // 在籍中のスタッフ（連携とチャットが残ること）

// ---------- 前提: X に従業員データ・書類・本人情報・連携・企業間チャットを用意する ----------
const upload = async (path, name) => {
  const form = new FormData()
  form.append('files', new Blob(['w3-retention-a test'], { type: 'text/plain' }), name)
  return admin.upload(path, form)
}
let r = await admin.put(`/api/admin/employees/${X}`, { bank_name: 'テスト銀行', account_number: '1234567', emergency_phone: '090-1111-2222', base_salary: 250000, prefecture: '東京都', profile: { kana: 'テスト タロウ', date_of_birth: '1990-04-01' } })
ok('（前提）従業員データ（口座・緊急連絡先・給与・住所）を保存', r.status === 200, r)
r = await upload(`/api/admin/staff/${X}/documents`, 'resume.txt')
ok('（前提）履歴書をアップロード', r.status === 200 && r.data.results && r.data.results[0].ok, r)
r = await upload(`/api/admin/employees/${X}/documents`, 'onboarding.txt')
ok('（前提）入社時書類をアップロード', r.status === 200 && r.data.results && r.data.results[0].ok, r)
const docKeys = d1(`SELECT storage_key AS k, 'staff' AS t FROM staff_documents WHERE staff_id = ${X} UNION ALL SELECT storage_key, 'employee' FROM employee_documents WHERE staff_id = ${X}`)[0]
await waitServer()
await d1w(`UPDATE users SET retired_at = '2018-01-01', status = 'suspended', email = 'w3ra-x@example.com', phone = '090-9999-0000'
      WHERE user_id IN (SELECT user_id FROM staff_profiles WHERE staff_id IN (${X}, ${Y}));
    UPDATE staff_profiles SET employment_status = 'retired', memo = '管理者メモ', pr_points = 'PR', remarks = '備考' WHERE staff_id IN (${X}, ${Y});
    UPDATE shifts SET work_date = date(work_date, '-9 years') WHERE staff_id IN (${X}, ${Y});
    INSERT INTO users (company_id, user_code, name, role, password_hash, status) VALUES (2, 'w3ra_link_x', '連携X', 'roster_only', 'x', 'active'), (2, 'w3ra_link_k', '連携K', 'roster_only', 'x', 'active');
    INSERT INTO staff_profiles (user_id, company_id, affiliation_type, source_staff_id, root_staff_id, owner_company_id)
      SELECT user_id, 2, 'linked_external', ${X}, ${X}, 1 FROM users WHERE user_code = 'w3ra_link_x';
    INSERT INTO staff_profiles (user_id, company_id, affiliation_type, source_staff_id, root_staff_id, owner_company_id)
      SELECT user_id, 2, 'linked_external', ${KEEP}, ${KEEP}, 1 FROM users WHERE user_code = 'w3ra_link_k';
    INSERT INTO roster_comments (thread_staff_id, owner_company_id, host_company_id, author_company_id, author_user_id, body)
      SELECT sp.staff_id, 1, 2, 1, 1, 'w3ra 体調についての連絡' FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.user_code IN ('w3ra_link_x', 'w3ra_link_k');
    INSERT INTO roster_comment_reads (thread_staff_id, company_id, last_read_comment_id)
      SELECT sp.staff_id, 1, 1 FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.user_code IN ('w3ra_link_x', 'w3ra_link_k');
    INSERT INTO roster_consents (company_id, user_id, person_id, source_staff_id, source_company_id, staff_id, consent_version, shared_scope, ip_address, user_agent)
      SELECT 2, 1, 'w3ra', sp.source_staff_id, 1, sp.staff_id, 'v1', 'name', '203.0.113.1', 'test-agent' FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.user_code IN ('w3ra_link_x', 'w3ra_link_k');`)
const L = d1(`SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.user_code = 'w3ra_link_x'`)[0][0].staff_id
await waitServer()

// ---------- #193 #228 #480 #234 dry-run: 新しい対象を数え、実行元を残す ----------
{
  const dry = await hq.post('/api/hq/retention/dry-run')
  const t = Object.fromEntries((dry.data && dry.data.results || []).map(x => [x.target, x.targetCount]))
  ok('#193 dry-run: 従業員データ・履歴書・入社時書類・R2 の書類を数える', dry.status === 200 && t.employee_records >= 1 && t.staff_documents >= 1 && t.employee_documents >= 1 && t.r2_documents >= 2, t)
  ok('#228 dry-run: 企業間チャット・既読位置・同意履歴を数える（所属元の退職で連携先のスレッドも対象）', t.roster_comments >= 1 && t.roster_comment_reads >= 1 && t.roster_consents >= 1, t)
  ok('#480 dry-run: 匿名化する本人情報（人数）を数える', t.anonymized_staff >= 3 && t.retired_staff >= 3, t)
  ok('dry-run: どの対象も集計に失敗しない', !(dry.data.results || []).some(x => x.failedCount > 0), dry.data.results)
  const logs = (await hq.get('/api/hq/retention/logs')).data.runs || [] // 1回の実行を1行にまとめた形（w4-retention-b #305）
  const last = logs[0] || {}
  ok('#234 手動の dry-run は実行元「manual」と実行した本部ユーザーを記録する', last.trigger_source === 'manual' && last.dry_run === 1 && !!last.triggered_by_name, last)
}

// ---------- #192 #198 毎日の cron（3:00）: 処理ごとに記録し、既読率レポートは別の起動 ----------
const runsBefore = d1('SELECT COALESCE(MAX(run_id), 0) AS m FROM cron_runs')[0][0].m
await waitServer()
ok('（前提）毎日の cron（3:00）を実行（1回目: 猶予の開始）', await cron(DAILY) === 200)
{
  const runs = d1(`SELECT job, status, cron, result_json FROM cron_runs WHERE run_id > ${runsBefore} ORDER BY run_id`)[0]
  await waitServer()
  const jobs = runs.map(x => x.job)
  ok('#192 3:00 の cron の処理ごとに実行記録が残る', ['auth_purge', 'recruit_applications_purge', 'retention', 'retirements', 'affiliation_schedules', 'notice_reads_purge'].every(j => jobs.includes(j)) && runs.every(x => x.cron === DAILY), runs)
  ok('#198 個人情報の削除（応募・データ保持）を先に実行する', jobs.indexOf('recruit_applications_purge') < jobs.indexOf('retirements') && jobs.indexOf('retention') < jobs.indexOf('notice_reads_purge'), jobs)
  ok('#198 既読率レポートは 3:00 の起動では実行しない', !jobs.includes('notice_read_reports'), jobs)
  const ret = runs.find(x => x.job === 'retention')
  ok('#192 データ保持の結果（実削除・件数）を記録する', ret && ret.status === 'ok' && JSON.parse(ret.result_json).dry_run === false, ret)
  const logs = (await hq.get('/api/hq/retention/logs')).data.runs || []
  ok('#234 cron の実行は実行元「cron」で記録する', logs[0] && logs[0].trigger_source === 'cron' && logs[0].dry_run === 0, logs[0])
}
ok('（前提）既読率レポートの cron（3:30）を実行', await cron(REPORTS) === 200)
{
  const rep = d1(`SELECT status, cron, result_json FROM cron_runs WHERE job = 'notice_read_reports' ORDER BY run_id DESC LIMIT 1`)[0][0]
  await waitServer()
  const res = rep ? JSON.parse(rep.result_json) : {}
  ok('#198 既読率レポートは 3:30 の起動で集計し、会社数と残りを記録する', rep && rep.status === 'ok' && rep.cron === REPORTS && res.companies >= 1 && res.remaining === 0, rep)
  await cron(REPORTS)
  const rep2 = d1(`SELECT result_json FROM cron_runs WHERE job = 'notice_read_reports' ORDER BY run_id DESC LIMIT 1`)[0][0]
  await waitServer()
  ok('#198 同じ日に再び起動しても、集計済みの会社は問い合わせない', JSON.parse(rep2.result_json).companies === 0, rep2)
}

// ---------- 猶予明けの削除: X は削除・匿名化、Y は失敗させて理由を残す ----------
await d1w(`UPDATE staff_profiles SET retention_flagged_at = '${addDays(today, -8)}' WHERE staff_id IN (${X}, ${Y}, ${L});
  CREATE TRIGGER w3ra_fail BEFORE DELETE ON shifts WHEN OLD.staff_id = ${Y} BEGIN SELECT RAISE(ABORT, 'w3ra test failure'); END;`)
ok('（前提）毎日の cron を実行（2回目: 猶予明けの削除）', await cron(DAILY) === 200)
{
  const a = d1(`SELECT COUNT(*) AS n FROM employee_records WHERE staff_id = ${X};
    SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id = ${X};
    SELECT COUNT(*) AS n FROM employee_documents WHERE staff_id = ${X};
    SELECT COUNT(*) AS n FROM retention_pending_r2 WHERE staff_id = ${X};
    SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${X};
    SELECT u.name, u.email, u.phone, u.password_hash, sp.kana, sp.date_of_birth, sp.memo, sp.pr_points, sp.remarks, sp.anonymized_at
      FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE sp.staff_id = ${X};
    SELECT COUNT(*) AS n FROM roster_comments WHERE thread_staff_id = ${L};
    SELECT COUNT(*) AS n FROM roster_comment_reads WHERE thread_staff_id = ${L};
    SELECT COUNT(*) AS n FROM roster_consents WHERE source_staff_id = ${X} OR staff_id = ${L};
    SELECT COUNT(*) AS n FROM roster_comments WHERE thread_staff_id IN (SELECT staff_id FROM staff_profiles WHERE source_staff_id = ${KEEP});
    SELECT COUNT(*) AS n FROM roster_consents WHERE source_staff_id = ${KEEP};
    SELECT u.name, sp.anonymized_at FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE sp.staff_id = ${KEEP};`)
  await waitServer()
  const n = a.map(x => x[0] && x[0].n)
  ok('#193 従業員データ（口座・住所・給与・緊急連絡先）を削除', n[0] === 0, n[0])
  ok('#193 履歴書・入社時書類の行を削除し、R2 の削除待ちも残らない', n[1] === 0 && n[2] === 0 && n[3] === 0, [n[1], n[2], n[3]])
  ok('（前提）勤怠・シフトも削除済み', n[4] === 0, n[4])
  const p = a[5][0]
  ok('#480 users の氏名を「退職者#staff_id」にし、メール・電話を消し、パスワードを使えなくする', p.name === `退職者#${X}` && p.email === null && p.phone === null && p.password_hash === '!anonymized', p)
  ok('#480 staff_profiles のフリガナ・生年月日・メモ・PR・備考を消し、匿名化の日時を残す', p.kana === null && p.date_of_birth === null && p.memo === null && p.pr_points === null && p.remarks === null && !!p.anonymized_at, p)
  ok('#228 所属元が対象になった連携先のスレッドのチャット・既読位置・同意履歴を削除', n[6] === 0 && n[7] === 0 && n[8] === 0, [n[6], n[7], n[8]])
  ok('#228 在籍中のスタッフのチャット・同意履歴は残る', n[9] >= 1 && n[10] >= 1, [n[9], n[10]])
  ok('#480 在籍中のスタッフは匿名化しない', a[11][0].name !== `退職者#${KEEP}` && a[11][0].anonymized_at === null, a[11][0])

  // R2 のファイルが消えたこと: 同じキーの行を入れ直してダウンロードすると 404 になる
  await d1w(`INSERT INTO staff_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size) VALUES ${docKeys.map(k => `(1, ${KEEP}, 'w3ra-check.txt', '${k.k}', 'text/plain', 1)`).join(', ')}`)
  const ids = d1(`SELECT document_id FROM staff_documents WHERE original_file_name = 'w3ra-check.txt'`)[0].map(x => x.document_id)
  await waitServer()
  const st = []
  for (const id of ids) st.push((await fetch(`${BASE}/api/admin/staff/documents/${id}/download`, { headers: { Cookie: (await login('sample', 'admin')) } })).status)
  ok('#193 R2 の履歴書・入社時書類のファイルも削除される', ids.length === 2 && st.every(s => s === 404), [ids, st])
  await d1w(`DELETE FROM staff_documents WHERE original_file_name = 'w3ra-check.txt'`)

  // #234 Y の失敗の理由を残す。D1 の削除は1つのトランザクションなので Y のデータ・本人情報は残る
  const y = d1(`SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${Y}; SELECT u.name, sp.anonymized_at FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE sp.staff_id = ${Y};
    SELECT failed_count, error_message, trigger_source FROM retention_logs WHERE target = 'retired_staff' ORDER BY log_id DESC LIMIT 1;
    SELECT status, error_message FROM cron_runs WHERE job = 'retention' ORDER BY run_id DESC LIMIT 1`)
  await waitServer()
  ok('#234 失敗したスタッフのデータは消えず、匿名化もされない', y[0][0].n > 0 && y[1][0].name !== `退職者#${Y}` && y[1][0].anonymized_at === null, y.slice(0, 2))
  const lg = y[2][0]
  ok('#234 retention_logs に失敗したスタッフと理由を残す', lg.failed_count === 1 && /staff_id=13/.test(lg.error_message || '') && /w3ra test failure/.test(lg.error_message || '') && lg.trigger_source === 'cron', lg)
  ok('#192 データ保持の失敗を定期処理の実行記録に「失敗」として残す', y[3][0].status === 'failed' && /retired_staff/.test(y[3][0].error_message || ''), y[3][0])
  const s = (await hq.get('/api/hq/cron/status')).data
  ok('#192 本部の定期処理の状況: 処理ごとの最終実行と、失敗の警告を返す', s.latest.some(x => x.job === 'retention' && x.status === 'failed') && s.warnings.some(w => w.kind === 'failed' && w.job === 'retention'), s.warnings)
  const logs = ((await hq.get('/api/hq/retention/logs')).data.runs || []).flatMap(r => r.items)
  ok('#234 本部の実行ログで失敗の理由（error_message）を返す', logs.some(l => l.target === 'retired_staff' && /staff_id=13/.test(l.error_message || '')), logs.slice(0, 3))
}

// 失敗の原因を取り除くと、次の cron で処理でき、警告も消える
await d1w(`DROP TRIGGER w3ra_fail`)
ok('（前提）毎日の cron を実行（3回目: 失敗の原因を取り除いた後）', await cron(DAILY) === 200)
{
  const y = d1(`SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${Y}; SELECT u.name FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE sp.staff_id = ${Y}`)
  await waitServer()
  ok('#234 失敗したスタッフは次の cron で処理される', y[0][0].n === 0 && y[1][0].name === `退職者#${Y}`, y)
  const s = (await hq.get('/api/hq/cron/status')).data
  ok('#192 成功すると失敗の警告は消える', !s.warnings.some(w => w.job === 'retention'), s.warnings)
  const sch = (await hq.get('/api/hq/retention/schedule')).data
  ok('#480 匿名化が済んだ人は次回削除予定に出ない（毎日選び直さない）', !(sch.scheduled || []).some(x => [X, Y, L].includes(x.staff_id)), (sch.scheduled || []).map(x => x.staff_id))
}

// #192 他の処理は動いているのに、ある処理だけ 25 時間以上実行されていないと警告する
{
  const old = new Date(Date.now() - 50 * 3600 * 1000).toISOString()
  await d1w(`INSERT INTO cron_runs (cron, job, label, status, started_at, finished_at) VALUES ('${DAILY}', 'w3ra_old_job', 'テスト用の止まった処理', 'ok', '${old}', '${old}')`)
  const s = (await hq.get('/api/hq/cron/status')).data
  ok('#192 止まっている処理を警告する', s.warnings.some(w => w.kind === 'stale' && w.job === 'w3ra_old_job'), s.warnings)
  await d1w(`DELETE FROM cron_runs WHERE job = 'w3ra_old_job'`)
  ok('#192 一覧の処理がすべて実行済みなら「未実行」の警告は出ない', !s.warnings.some(w => w.kind === 'never'), s.warnings)
  // 一覧にある処理が一度も実行されていない（wrangler.jsonc の triggers.crons から式が抜けたなど）と警告する
  await d1w(`DELETE FROM cron_runs WHERE job = 'notice_read_reports'`)
  const s2 = (await hq.get('/api/hq/cron/status')).data
  ok('#192 一度も実行されていない処理を警告する', s2.warnings.some(w => w.kind === 'never' && w.job === 'notice_read_reports'), s2.warnings)
}
{
  const page = await fetch(`${BASE}/static/hq.js`).then(x => x.text())
  ok('本部画面: 定期処理の状況・警告・実行元の表示がある', /cronStatusHtml/.test(page) && /renderCronAlert/.test(page) && /RETENTION_TRIGGER_LABEL/.test(page) && !/onclick="runRetentionDryRun/.test(page))
}

const failed = results.filter(x => !x.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
