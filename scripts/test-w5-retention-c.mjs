// 保存期間の残りと削除の保留（w5-retention-c: #350 #417 #420 #425 #511 #543、#533 の残り）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、
//   `wrangler dev --local --test-scheduled --var RETENTION_ENABLED:true --persist-to <保存先>` で起動していること
//   （ローカルの D1 に直接書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8811 PERSIST=<保存先> node scripts/test-w5-retention-c.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.clone().json() } catch { }
    return { status: r.status, data, res: r }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）。ローカルの D1 のみ
function d1(sql) {
  const out = execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
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
const yearsAgo = (n) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return d.toISOString().slice(0, 10) }
const DAILY = '0 18 * * *'
const REPORTS = '30 18 * * *'

const hq = client(await login('sample', 'hq'))
const admin = client(await login('sample', 'admin'))
const A = 3   // 在職中（位置情報・写真・相談・フォロー・提案）
const E = 4   // 区分変更で雇用終了（2018年）
const E2 = 6  // 区分変更で雇用終了（2024年。まだ消さない）
const H = 5   // 削除の保留中（在職中）
const R = 12  // 退職後7年（応募・提案を消す）
const RH = 13 // 退職後7年だが削除の保留中

// ---------- 前提 ----------
// 企業2のスタッフ（企業単位の保留の確かめ用。シードにないので作る）
d1(`INSERT INTO users (company_id, user_code, name, role, password_hash, status) SELECT 2, 'w5rc-c2', '企業2 スタッフ', 'staff', 'x', 'active' WHERE NOT EXISTS (SELECT 1 FROM users WHERE company_id = 2 AND user_code = 'w5rc-c2');
  INSERT INTO staff_profiles (user_id, company_id) SELECT user_id, 2 FROM users WHERE company_id = 2 AND user_code = 'w5rc-c2' AND NOT EXISTS (SELECT 1 FROM staff_profiles WHERE company_id = 2);`)
const pre = d1(`SELECT staff_id, user_id, company_id FROM staff_profiles WHERE staff_id IN (${A}, ${E}, ${E2}, ${H}, ${R}, ${RH}) ORDER BY staff_id;
  SELECT staff_id FROM staff_profiles WHERE company_id = 2 ORDER BY staff_id LIMIT 1;
  SELECT attendance_id, staff_id FROM attendance_reports WHERE staff_id IN (${A}, ${H}) ORDER BY staff_id, attendance_id;
  SELECT project_id FROM projects WHERE company_id = 1 ORDER BY project_id LIMIT 1`)
await waitServer()
const users = Object.fromEntries(pre[0].map(r => [r.staff_id, r.user_id]))
const C2 = pre[1][0] && pre[1][0].staff_id
const attA = pre[2].filter(r => r.staff_id === A).map(r => r.attendance_id)
const attH = pre[2].filter(r => r.staff_id === H).map(r => r.attendance_id)
const P = pre[3][0].project_id
ok('（前提）テスト用のスタッフ・勤怠・案件がある', pre[0].length === 6 && C2 && attA.length >= 2 && attH.length >= 1 && P, { s: pre[0].length, C2, attA, attH })
const drCutoff = yearsAgo(3)
await d1w(`
  UPDATE attendance_reports SET reported_at = '2024-01-01 09:00:00', latitude = 35.1, longitude = 139.1, address = '東京都', device_info = 'ua', device_id = 'dev', photo_key = 'w5rc/photo/old' WHERE attendance_id = ${attA[0]};
  UPDATE attendance_reports SET reported_at = '${today} 09:00:00', latitude = 35.2, longitude = 139.2, photo_key = 'w5rc/photo/new' WHERE attendance_id = ${attA[1]};
  UPDATE attendance_reports SET reported_at = '2024-01-01 09:00:00', latitude = 35.3, longitude = 139.3, photo_key = 'w5rc/photo/held' WHERE attendance_id = ${attH[0]};
  INSERT INTO consultations (company_id, staff_id, category, body, status, created_at) VALUES
    (1, ${A}, 'health', 'w5rc-old-done', 'done', '2020-01-01 00:00:00'),
    (1, ${A}, 'health', 'w5rc-new-done', 'done', CURRENT_TIMESTAMP),
    (1, ${A}, 'health', 'w5rc-old-open', 'open', '2020-01-01 00:00:00'),
    (1, ${H}, 'health', 'w5rc-held-done', 'done', '2020-01-01 00:00:00'),
    (2, ${C2}, 'health', 'w5rc-company-held', 'done', '2020-01-01 00:00:00');
  INSERT INTO follow_logs (company_id, staff_id, follow_type, content, status, done_at, created_at) VALUES
    (1, ${A}, 'health', 'w5rc-f-old-done', 'done', '2020-02-01 00:00:00', '2020-01-01 00:00:00'),
    (1, ${A}, 'warning', 'w5rc-f-old-open', 'open', NULL, '2020-01-01 00:00:00'),
    (1, ${A}, 'health', 'w5rc-f-recent-done', 'done', CURRENT_TIMESTAMP, '2020-01-01 00:00:00');
  INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values) VALUES
    (1, ${A}, ${P}, '2022-01-01', '{"w5rc":"old"}'),
    (1, ${H}, ${P}, '2022-01-02', '{"w5rc":"held"}'),
    (1, ${A}, ${P}, '${addDays(drCutoff, 10)}', '{"w5rc":"due"}');
  UPDATE staff_profiles SET affiliation_type = 'daily_worker' WHERE staff_id IN (${E}, ${E2});
  INSERT INTO employee_records (staff_id, company_id, employment_ended_at, bank_name, account_number) VALUES (${E}, 1, '2018-03-31', 'w5rc銀行', '1234567'), (${E2}, 1, '2024-03-31', 'w5rc銀行2', '7654321')
    ON CONFLICT(staff_id) DO UPDATE SET employment_ended_at = excluded.employment_ended_at, bank_name = excluded.bank_name;
  INSERT INTO employee_documents (company_id, staff_id, original_file_name, storage_key, mime_type, file_size) VALUES (1, ${E}, 'keiyaku.pdf', 'w5rc/doc/e', 'application/pdf', 10), (1, ${E2}, 'keiyaku2.pdf', 'w5rc/doc/e2', 'application/pdf', 10);
  INSERT INTO employment_periods (company_id, staff_id, hire_date, employment_ended_at) VALUES (1, ${E}, '2010-01-01', '2015-01-01'), (1, ${E2}, '2020-01-01', '2023-01-01');
  INSERT INTO board_posts (company_id, engagement_type, title, price_amount, price_unit) VALUES (3, 'spot', 'w5rc-post', 10000, 'daily');
  INSERT INTO board_threads (post_id, poster_company_id, inquirer_company_id) VALUES ((SELECT MAX(post_id) FROM board_posts), 3, 1);
  INSERT INTO board_proposals (thread_id, post_id, proposer_company_id, receiver_company_id, staff_id, snapshot, disclosed, comment, status, upstream_chain, decided_at) VALUES
    ((SELECT MAX(thread_id) FROM board_threads), (SELECT MAX(post_id) FROM board_posts), 1, 3, ${R}, '{"career":"w5rc-retired"}', '{"name":"退職 太郎"}', 'c', 'adopted', '[1]', '2019-01-01 00:00:00'),
    ((SELECT MAX(thread_id) FROM board_threads), (SELECT MAX(post_id) FROM board_posts), 1, 3, ${A}, '{"career":"w5rc-declined-old"}', '{"name":"在職 花子"}', 'c', 'declined', '[1]', '2025-01-01 00:00:00'),
    ((SELECT MAX(thread_id) FROM board_threads), (SELECT MAX(post_id) FROM board_posts), 1, 3, ${A}, '{"career":"w5rc-declined-new"}', '{"name":"在職 花子"}', 'c', 'declined', '[1]', '${today} 00:00:00'),
    ((SELECT MAX(thread_id) FROM board_threads), (SELECT MAX(post_id) FROM board_posts), 1, 3, ${H}, '{"career":"w5rc-held"}', '{"name":"保留 次郎"}', 'c', 'withdrawn', '[1]', '2025-01-01 00:00:00');
  INSERT INTO recruit_applications (company_id, source, staff_id, name, phone, email, note, status) VALUES (1, 'staff', ${R}, '退職 太郎', '090-0000-9999', 'w5rc@example.com', 'メモ', 'done');
  INSERT INTO recruit_application_items (application_id, slot_role_id, status) VALUES ((SELECT MAX(application_id) FROM recruit_applications), 999999, 'approved');
  UPDATE users SET retired_at = '2018-01-01', status = 'suspended' WHERE user_id IN (${users[R]}, ${users[RH]});
  UPDATE staff_profiles SET employment_status = 'retired', retention_flagged_at = '${addDays(today, -8)}' WHERE staff_id IN (${R}, ${RH});
  UPDATE shifts SET work_date = date(work_date, '-9 years') WHERE staff_id IN (${R}, ${RH});`)

// ---------- #543 削除の保留 ----------
{
  const bad = await hq.put('/api/hq/retention/holds/staff/' + H, { reason: '' })
  ok('#543 理由のない保留は 400', bad.status === 400 && bad.data.field === 'reason', bad)
  const kind = await hq.put('/api/hq/retention/holds/user/' + H, { reason: 'x' })
  ok('#543 対象の種類が違えば 400', kind.status === 400, kind.status)
  const nf = await hq.put('/api/hq/retention/holds/staff/999999', { reason: 'x' })
  ok('#543 存在しないスタッフは 404', nf.status === 404, nf.status)
  const nh = await admin.put('/api/hq/retention/holds/staff/' + H, { reason: 'x' })
  ok('#543 本部以外は保留を設定できない', nh.status === 403, nh.status)
  const s1 = await hq.put('/api/hq/retention/holds/staff/' + H, { reason: '未払い賃金の請求で係争中' })
  const s2 = await hq.put('/api/hq/retention/holds/staff/' + RH, { reason: '労基署の調査中' })
  const s3 = await hq.put('/api/hq/retention/holds/company/2', { reason: '解約手続き中' })
  ok('#543 スタッフ・企業の削除を保留にできる', s1.status === 200 && s2.status === 200 && s3.status === 200 && s1.data.name, [s1.data, s2.data, s3.data])
  const sch = (await hq.get('/api/hq/retention/schedule')).data
  const hs = sch.holds && sch.holds.staff.map(x => x.staff_id)
  ok('#543 保留中の一覧（理由・設定者）を返す', hs && hs.includes(H) && hs.includes(RH) && sch.holds.companies.some(c => c.company_id === 2 && c.hold_reason === '解約手続き中' && c.hold_by_name), sch.holds)
  const sched = sch.scheduled.map(x => x.staff_id)
  ok('#543 保留中の退職者は次回削除予定に出ない（保留していない退職者は出る）', sched.includes(R) && !sched.includes(RH), sched)
}

// ---------- dry-run（在職中の保存期間・応募・提案を含む） ----------
{
  const dry = await hq.post('/api/hq/retention/dry-run')
  const t = Object.fromEntries((dry.data && dry.data.results || []).map(x => [x.target, x.targetCount]))
  ok('dry-run: どの対象も集計に失敗しない', dry.status === 200 && !(dry.data.results || []).some(x => x.failedCount > 0), (dry.data.results || []).filter(x => x.failedCount > 0))
  ok('#420 dry-run: 1年を過ぎた位置情報・写真を数える（保留中は数えない）', t.attendance_location >= 1 && t.attendance_photos >= 1, t)
  ok('#511 dry-run: 対応済みの相談・完了したフォロー記録を数える', t.consultations_done >= 1 && t.follow_logs_done >= 1, t)
  ok('#350 dry-run: 見送りの提案・退職者の応募と提案を数える', t.board_proposals_settled >= 1 && t.recruit_applications >= 1 && t.recruit_application_items >= 1 && t.board_proposals >= 1, t)
  ok('#425 dry-run: 雇用終了から7年の従業員データ・書類・雇用期間を数える', t.ended_employee_records === 1 && t.ended_employee_documents === 1 && t.ended_employment_periods >= 1, t)
  const sr = (dry.data.detail && dry.data.detail.staff || []).find(s => s.staff_id === R)
  ok('#350 dry-run の退職者別の内訳に応募・提案の件数', sr && sr.counts.recruit_applications === 1 && sr.counts.board_proposals === 1, sr && sr.counts)
  ok('#543 dry-run の退職者別の内訳に保留中の人は出ない', !(dry.data.detail.staff || []).some(s => s.staff_id === RH))
}

// ---------- 保存期間の設定 ----------
{
  const g = (await hq.get('/api/hq/retention/settings')).data
  ok('#420 #511 保存期間の設定（既定値と範囲）を返す', g.settings.location_photo_days === 365 && g.settings.consultation_years === 3 && g.defs.location_photo_days.min === 90, g.settings)
  const bad = await hq.put('/api/hq/retention/settings', { location_photo_days: 10 })
  ok('#420 範囲外の期間は 400', bad.status === 400 && bad.data.field === 'location_photo_days', bad.data)
  const p1 = await hq.put('/api/hq/retention/settings', { proposal_days: 200 })
  ok('#350 期間を変えられる', p1.status === 200 && p1.data.settings.proposal_days === 200, p1.data)
  const p2 = await hq.put('/api/hq/retention/settings', { proposal_days: 180 })
  ok('（前提）期間を元に戻す', p2.status === 200 && p2.data.settings.proposal_days === 180)
  const na = await admin.get('/api/hq/retention/settings')
  ok('保存期間の設定は本部のみ', na.status === 403, na.status)
}

// ---------- #417 日報の保存期間の案内と CSV ----------
{
  const r = await admin.get('/api/admin/daily-reports-retention')
  ok('#417 今後30日で削除される日報の件数と範囲を返す', r.status === 200 && r.data.years === 3 && r.data.due_count >= 2 && r.data.due_from <= '2022-01-01', r.data)
  const csv = await admin.get(`/api/admin/daily-reports-csv?from=${addDays(drCutoff, 10)}&to=${addDays(drCutoff, 10)}`)
  const text = await csv.res.text()
  ok('#417 日報を期間で CSV に書き出す（項目の列を含む）', csv.status === 200 && /text\/csv/.test(csv.res.headers.get('content-type') || '') && text.includes('稼働日') && text.includes('w5rc') && text.includes('due'), text.slice(0, 300))
  const all = await admin.get(`/api/admin/daily-reports-csv?from=${addDays(today, -61)}&to=${today}&project_id=${P}`)
  ok('#417 62日まで・案件で絞って書き出せる', all.status === 200 && all.res.headers.get('x-csv-truncated') === '0', all.status)
  const long = await admin.get(`/api/admin/daily-reports-csv?from=${addDays(today, -62)}&to=${today}`)
  ok('#417 62日を超える期間は 400', long.status === 400, long.data)
  const none = await admin.get('/api/admin/daily-reports-csv')
  ok('#417 期間がなければ 400', none.status === 400, none.data)
  const staff = client(await login('sample', 'st001'))
  const sf = await staff.get(`/api/admin/daily-reports-csv?from=${today}&to=${today}`)
  ok('#417 スタッフは書き出せない', sf.status === 403, sf.status)
}

// ---------- 毎日の cron（3:00）: 日報の3年・退職後7年（応募・提案） ----------
ok('（前提）毎日の cron（3:00）を実行', await cron(DAILY) === 200)
{
  const a = d1(`SELECT report_values FROM daily_reports WHERE report_values LIKE '%w5rc%' ORDER BY report_values;
    SELECT COUNT(*) AS n FROM recruit_applications WHERE staff_id = ${R};
    SELECT COUNT(*) AS n FROM recruit_application_items WHERE slot_role_id = 999999;
    SELECT staff_id, status, snapshot, disclosed, comment, upstream_chain, anonymized_at FROM board_proposals WHERE staff_id = ${R};
    SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${RH};
    SELECT retention_flagged_at FROM staff_profiles WHERE staff_id = ${RH};
    SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${R}`)
  await waitServer()
  const drs = a[0].map(r => r.report_values)
  ok('#417 3年を過ぎた日報を消す', !drs.includes('{"w5rc":"old"}') && drs.includes('{"w5rc":"due"}'), drs)
  ok('#543 保留中のスタッフの日報は3年を過ぎても消さない', drs.includes('{"w5rc":"held"}'), drs)
  ok('#350 退職後7年でスタッフに紐づく応募と応募した枠を消す', a[1][0].n === 0 && a[2][0].n === 0, a.slice(1, 3))
  const p = a[3][0]
  ok('#350 退職後7年で人材提案の経歴・氏名・経路を消す（行は残す）', p && p.snapshot === '{}' && p.disclosed === null && p.comment === null && p.upstream_chain === null && p.anonymized_at && p.status === 'adopted', p)
  ok('#350 退職者のその他のデータも削除済み', a[6][0].n === 0, a[6])
  ok('#543 保留中の退職者は削除せず、猶予の印も外す', a[4][0].n > 0 && a[5][0].retention_flagged_at === null, a.slice(4, 6))
}

// ---------- 毎日の cron（3:30）: 在職中の保存期間 ----------
ok('（前提）毎日の cron（3:30）を実行', await cron(REPORTS) === 200)
{
  const a = d1(`SELECT attendance_id, latitude, longitude, address, device_info, device_id, photo_key, reported_at, report_type FROM attendance_reports WHERE attendance_id IN (${attA[0]}, ${attA[1]}, ${attH[0]}) ORDER BY attendance_id;
    SELECT photo_key, bucket FROM retention_pending_r2 WHERE photo_key LIKE 'w5rc/%' ORDER BY photo_key;
    SELECT body FROM consultations WHERE body LIKE 'w5rc%' ORDER BY body;
    SELECT content FROM follow_logs WHERE content LIKE 'w5rc%' ORDER BY content;
    SELECT json_extract(snapshot, '$.career') AS career, anonymized_at FROM board_proposals WHERE staff_id IN (${A}, ${H}) ORDER BY proposal_id;
    SELECT staff_id, bank_name FROM employee_records WHERE staff_id IN (${E}, ${E2}) ORDER BY staff_id;
    SELECT staff_id FROM employee_documents WHERE staff_id IN (${E}, ${E2}) ORDER BY staff_id;
    SELECT staff_id FROM employment_periods WHERE staff_id IN (${E}, ${E2}) ORDER BY staff_id;
    SELECT job, status, result_json FROM cron_runs WHERE job = 'retention_in_service' ORDER BY run_id DESC LIMIT 1`)
  await waitServer()
  const at = Object.fromEntries(a[0].map(r => [r.attendance_id, r]))
  const o = at[attA[0]], n = at[attA[1]], h = at[attH[0]]
  ok('#420 1年を過ぎた位置情報・端末情報・写真のキーを消し、勤怠の時刻・種別は残す', o && o.latitude === null && o.longitude === null && o.address === null && o.device_info === null && o.device_id === null && o.photo_key === null && o.reported_at === '2024-01-01 09:00:00' && o.report_type, o)
  ok('#420 新しい位置情報・写真は残す', n && n.latitude === 35.2 && n.photo_key === 'w5rc/photo/new', n)
  ok('#543 保留中のスタッフの位置情報・写真は残す', h && h.latitude === 35.3 && h.photo_key === 'w5rc/photo/held', h)
  const pend = a[1].map(r => `${r.photo_key}:${r.bucket}`)
  ok('#420 #425 写真・書類は R2 の削除の控えに入れる（翌日の 3:00 に消す）', pend.includes('w5rc/photo/old:photos') && pend.includes('w5rc/doc/e:documents') && !pend.some(k => k.startsWith('w5rc/photo/new') || k.startsWith('w5rc/doc/e2')), pend)
  const cs = a[2].map(r => r.body)
  ok('#511 対応済みで3年を過ぎた相談を消し、未対応・新しいもの・保留中は残す', JSON.stringify(cs) === JSON.stringify(['w5rc-company-held', 'w5rc-held-done', 'w5rc-new-done', 'w5rc-old-open']), cs)
  const fs = a[3].map(r => r.content)
  ok('#511 完了して3年を過ぎたフォロー記録を消し、未完了・最近完了したものは残す', JSON.stringify(fs) === JSON.stringify(['w5rc-f-old-open', 'w5rc-f-recent-done']), fs)
  const pr = a[4]
  ok('#350 見送りから180日を過ぎた提案を匿名化し、新しいもの・保留中は残す', pr.length === 3 && pr[0].career === null && pr[0].anonymized_at && pr[1].career === 'w5rc-declined-new' && pr[2].career === 'w5rc-held', pr)
  ok('#425 雇用終了から7年の従業員データを消し、7年たっていない人は残す', JSON.stringify(a[5].map(r => r.staff_id)) === JSON.stringify([E2]), a[5])
  ok('#425 雇用終了から7年の入社時書類を消す', JSON.stringify(a[6].map(r => r.staff_id)) === JSON.stringify([E2]), a[6])
  ok('#425 終了から7年の過去の雇用期間を消す', JSON.stringify(a[7].map(r => r.staff_id)) === JSON.stringify([E2]), a[7])
  const run = a[8][0]
  ok('在職中の保存期間の削除は定期処理の実行記録に残る', run && run.status === 'ok' && JSON.parse(run.result_json).deleted >= 6 && JSON.parse(run.result_json).dry_run === false, run)
  const logs = (await hq.get('/api/hq/retention/logs?trigger=cron')).data
  const ins = logs.runs.find(r => r.items.some(i => i.target === 'attendance_location'))
  ok('在職中の削除は本部の実行ログに対象ごとに出る', ins && ins.dry_run === 0 && ins.items.find(i => i.target === 'consultations_done').deleted_count >= 1, ins && ins.items)
}

// ---------- #543 保留の解除 ----------
{
  const r = await hq.del('/api/hq/retention/holds/staff/' + RH)
  const c2 = await hq.del('/api/hq/retention/holds/company/2')
  const sch = (await hq.get('/api/hq/retention/schedule')).data
  const s = sch.scheduled.find(x => x.staff_id === RH)
  ok('#543 解除すると削除予定に戻り、猶予からやり直す', r.status === 200 && c2.status === 200 && s && s.flagged_at === null && s.delete_on === null, s)
  ok('#543 解除した保留は一覧から消える', !sch.holds.staff.some(x => x.staff_id === RH) && !sch.holds.companies.some(x => x.company_id === 2), sch.holds)
}

// ---------- #533 R2 に残った、勤怠に紐づかない写真 ----------
{
  // ローカルの R2 に写真を1つ置く（アップロードから1日以内なので、紐づかなくても数えない）
  let put = false
  try {
    const dir = mkdtempSync(join(tmpdir(), 'w5rc-'))
    const file = join(dir, 'p.jpg'); writeFileSync(file, 'x')
    execFileSync(process.execPath, [WRANGLER, 'r2', 'object', 'put', 'mbsaas-attendance-photos/attendance/1/3/999999/check_in_1.jpg', '--file', file, '--local', '--persist-to', PERSIST], { encoding: 'utf8', stdio: 'pipe' })
    put = true
  } catch (e) { console.log('（R2 に写真を置けませんでした: ' + String(e).slice(0, 200) + '）') }
  await waitServer()
  const r = await hq.post('/api/hq/retention/orphan-photos', { dry_run: true })
  ok('#533 紐づかない写真を確認できる（アップロードから1日以内のものは数えない）', r.status === 200 && r.data.orphans === 0 && r.data.deleted === 0 && (!put || r.data.scanned >= 1), r.data)
  const na = await admin.post('/api/hq/retention/orphan-photos', { dry_run: true })
  ok('#533 本部以外は使えない', na.status === 403, na.status)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
