// 定期削除の残り（w4-retention-b: #240 #244 #305 #365 #397 #419 #437）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、
//   `wrangler dev --local --test-scheduled --var RETENTION_ENABLED:true --persist-to <保存先>` で起動していること
//   （ローカルの D1 に直接書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8827 PERSIST=<保存先> node scripts/test-w4-retention-b.mjs
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
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.clone().json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
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
const DAILY = '0 18 * * *'
const iso = (ms) => new Date(Date.now() + ms).toISOString()

const hq = client(await login('sample', 'hq'))
const X = 12 // 退職後7年で削除するスタッフ（st012）
const PENDING = 5001 // 1回の上限（5000）を超える、前回までに消せなかった R2 のファイル

// ---------- 前提 ----------
const keepShifts = d1(`SELECT shift_id, company_id, staff_id, work_date FROM shifts WHERE staff_id != ${X} AND work_date < '${addDays(today, -40)}' ORDER BY work_date LIMIT 1;
  UPDATE shifts SET work_date = '${addDays(today, 3)}' WHERE shift_id = (SELECT MAX(shift_id) FROM shifts WHERE staff_id != ${X});
  SELECT shift_id, company_id, staff_id, work_date FROM shifts WHERE shift_id = (SELECT MAX(shift_id) FROM shifts WHERE staff_id != ${X});
  SELECT company_id, user_id FROM staff_profiles WHERE staff_id = ${X}`)
await waitServer()
const oldShift = keepShifts[0][0], futureShift = keepShifts[2][0], xInfo = keepShifts[3][0]
// 先のシフトはテスト用の DB の1件の日付を3日後に動かして作る
ok('（前提）古いシフトと先のシフトがある', !!oldShift && !!futureShift, keepShifts)
await d1w(`UPDATE users SET retired_at = '2018-01-01', status = 'suspended' WHERE user_id = ${xInfo.user_id};
  UPDATE staff_profiles SET employment_status = 'retired' WHERE staff_id = ${X};
  UPDATE shifts SET work_date = date(work_date, '-9 years') WHERE staff_id = ${X};
  UPDATE attendance_reports SET photo_key = 'w4rb/photo/' || attendance_id, reported_at = '2017-06-01 09:00:00' WHERE staff_id = ${X};
  UPDATE attendance_reports SET reported_at = '2019-06-01 09:00:00' WHERE attendance_id = (SELECT MIN(attendance_id) FROM attendance_reports WHERE staff_id = ${X});
  INSERT OR REPLACE INTO notice_read_staff_reports (company_id, fiscal_year, staff_id, target_count, read_count, unread_count, read_rate) VALUES (${xInfo.company_id}, 2017, ${X}, 10, 8, 2, 80.0);
  INSERT INTO email_logs (company_id, to_email, type, status, created_at) VALUES (1, 'w4rb-old@example.com', 'notice', 'sent', '2020-01-01 00:00:00'), (1, 'w4rb-new@example.com', 'notice', 'sent', CURRENT_TIMESTAMP);
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at, created_at) VALUES
    (1, 'w4rb-expired', '${iso(-10 * 86400e3)}', NULL, datetime('now', '-10 days')),
    (1, 'w4rb-used', '${iso(-2 * 86400e3 + 3600e3)}', '2026-01-01 00:00:00', datetime('now', '-2 days')),
    (1, 'w4rb-used-recent', '${iso(3600e3)}', '2026-01-01 00:00:00', CURRENT_TIMESTAMP),
    (1, 'w4rb-fresh', '${iso(3600e3)}', NULL, CURRENT_TIMESTAMP);
  INSERT INTO shift_report_tokens (token, shift_id, company_id, staff_id, expires_at, revoked, created_at) VALUES
    ('w4rbOldToken0000000000000', ${oldShift.shift_id}, ${oldShift.company_id}, ${oldShift.staff_id}, '${addDays(oldShift.work_date, 1)} 23:59:59', 0, datetime('now', '-60 days')),
    ('w4rbRevokedToken000000000', ${futureShift.shift_id}, ${futureShift.company_id}, ${futureShift.staff_id}, '${addDays(futureShift.work_date, 1)} 23:59:59', 1, datetime('now', '-40 days')),
    ('w4rbActiveToken0000000000', ${futureShift.shift_id}, ${futureShift.company_id}, ${futureShift.staff_id}, '${addDays(futureShift.work_date, 1)} 23:59:59', 0, CURRENT_TIMESTAMP);`)

// ---------- #365 動作モードと次回の人数 ----------
{
  const sch = (await hq.get('/api/hq/retention/schedule')).data
  ok('#365 今の動作モード（RETENTION_ENABLED=true なら実削除）を返す', sch && sch.enabled === true, sch && { enabled: sch.enabled })
  ok('#365 次の定期削除の日付と人数を返す（猶予前の人は数えない）', sch && /^\d{4}-\d{2}-\d{2}$/.test(sch.next_run_date) && sch.next_run_count === 0 && sch.staff_batch === 20, sch && { d: sch.next_run_date, c: sch.next_run_count })
}

// ---------- #365 #437 #240 dry-run: 会社別・退職者別の内訳と、新しい対象 ----------
{
  const dry = await hq.post('/api/hq/retention/dry-run')
  const t = Object.fromEntries((dry.data && dry.data.results || []).map(x => [x.target, x.targetCount]))
  ok('#437 dry-run: スタッフ別の既読率（退職後7年）を数える', dry.status === 200 && t.notice_read_staff_reports >= 1, t)
  ok('#240 dry-run: 1年を過ぎたメール送信ログを数える', t.email_logs >= 1, t)
  ok('dry-run: どの対象も集計に失敗しない', !(dry.data.results || []).some(x => x.failedCount > 0), (dry.data.results || []).filter(x => x.failedCount > 0))
  const d = dry.data.detail || {}
  const sx = (d.staff || []).find(s => s.staff_id === X)
  ok('#365 dry-run: 退職者ごとに会社・退職日・最終稼働日・テーブルごとの件数を返す', sx && sx.company_name && sx.retired_at === '2018-01-01' && sx.last_work_date && sx.counts.shifts > 0 && sx.counts.notice_read_staff_reports === 1, sx)
  ok('#365 dry-run: 退職日より後に勤怠の報告がある人に印を付ける', sx && sx.report_after_retired === true && sx.last_report_date === '2019-06-01', sx && { f: sx.report_after_retired, d: sx.last_report_date })
  const cx = (d.companies || []).find(c => c.company_id === xInfo.company_id)
  ok('#365 dry-run: 会社別の退職者数と件数を返す', cx && cx.staff_count >= 1 && cx.counts.shifts >= sx.counts.shifts && d.staff_total >= 1, d.companies)
}

// ---------- #305 実行ログ: 1回の実行を1行にまとめ、実行元で絞り込む ----------
{
  await hq.post('/api/hq/retention/dry-run')
  const all = (await hq.get('/api/hq/retention/logs')).data
  const r0 = all.runs && all.runs[0]
  ok('#305 実行ログは1回の実行を1行にまとめ、対象ごとの内訳を持つ', r0 && r0.dry_run === 1 && r0.trigger_source === 'manual' && r0.items.length >= 20 && r0.triggered_by_name, r0 && { ...r0, items: r0.items.length })
  ok('#305 実行ログの合計件数（人数は含めない）', r0 && r0.target_count === r0.items.filter(i => !['retired_staff', 'retired_staff_deferred', 'r2_pending'].includes(i.target)).reduce((a, i) => a + i.target_count, 0) && r0.staff_count >= 1, r0 && { t: r0.target_count, s: r0.staff_count })
  ok('#305 ページ送りの情報（全体の回数・1ページの件数）を返す', all.total >= 2 && all.per_page === 20 && all.page === 1, { total: all.total, per_page: all.per_page })
  const p2 = (await hq.get('/api/hq/retention/logs?page=2')).data
  ok('#305 2ページ目を取得できる', p2.page === 2 && Array.isArray(p2.runs), p2 && { page: p2.page })
}

// ---------- #419 #397 #240 毎日の cron（1回目）: R2 の上限で翌日に回す・トークンとメール送信ログを消す ----------
await d1w(`UPDATE staff_profiles SET retention_flagged_at = '${addDays(today, -8)}' WHERE staff_id = ${X};
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PENDING})
  INSERT INTO retention_pending_r2 (photo_key, staff_id, bucket, created_at) SELECT 'w4rb/pending/' || i, NULL, 'photos', '2020-01-01 00:00:00' FROM n;`)
{
  const sch = (await hq.get('/api/hq/retention/schedule')).data
  ok('#365 猶予が明けた人は次の定期削除の人数に入る', sch.next_run_count >= 1 && sch.next_run_due >= 1, { c: sch.next_run_count, d: sch.next_run_due })
}
const runsBefore = d1('SELECT COALESCE(MAX(run_id), 0) AS m FROM cron_runs')[0][0].m
await waitServer()
ok('（前提）毎日の cron（3:00）を実行（1回目）', await cron(DAILY) === 200)
{
  const a = d1(`SELECT COUNT(*) AS n FROM retention_pending_r2 WHERE photo_key LIKE 'w4rb/pending/%';
    SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${X};
    SELECT target, target_count, deleted_count, failed_count FROM retention_logs WHERE log_id > (SELECT MAX(log_id) - 40 FROM retention_logs) AND dry_run = 0 AND target IN ('r2_photos', 'r2_pending', 'retired_staff_deferred', 'email_logs') ORDER BY log_id DESC;
    SELECT token_hash FROM password_reset_tokens WHERE token_hash LIKE 'w4rb-%' ORDER BY token_hash;
    SELECT token FROM shift_report_tokens WHERE token LIKE 'w4rb%' ORDER BY token;
    SELECT to_email FROM email_logs WHERE to_email LIKE 'w4rb-%';
    SELECT job, status, result_json FROM cron_runs WHERE run_id > ${runsBefore} AND job IN ('token_purge', 'retention')`)
  await waitServer()
  const lg = Object.fromEntries(a[2].reverse().map(x => [x.target, x]))
  ok('#419 R2 は1回の上限（5000件）まで消し、残りは翌日に回す', a[0][0].n === PENDING - 5000 && lg.r2_photos && lg.r2_photos.deleted_count === 5000 && lg.r2_photos.failed_count === 0, { left: a[0][0].n, log: lg.r2_photos })
  ok('#419 上限に達したら退職者の削除も次回に回し、件数を記録する', a[1][0].n > 0 && lg.retired_staff_deferred && lg.retired_staff_deferred.target_count >= 1 && lg.r2_pending && lg.r2_pending.target_count === PENDING - 5000, lg)
  ok('#397 期限切れ・使用済み（1日以上前）の再設定トークンを消し、新しいものは残す（回数制限に使うため）', JSON.stringify(a[3].map(x => x.token_hash)) === JSON.stringify(['w4rb-fresh', 'w4rb-used-recent']), a[3])
  ok('#397 期限から30日たった報告用URLと、取り消して30日たったものを消し、使える URL は残す', JSON.stringify(a[4].map(x => x.token)) === JSON.stringify(['w4rbActiveToken0000000000']), a[4])
  ok('#240 1年を過ぎたメール送信ログを消し、新しいものは残す', JSON.stringify(a[5].map(x => x.to_email)) === JSON.stringify(['w4rb-new@example.com']) && lg.email_logs && lg.email_logs.deleted_count >= 1, a[5])
  const tp = a[6].find(x => x.job === 'token_purge')
  ok('#397 トークンの削除は定期処理の実行記録に残る', tp && tp.status === 'ok' && JSON.parse(tp.result_json).deleted >= 3, a[6])
  const logs = (await hq.get('/api/hq/retention/logs?trigger=cron')).data
  ok('#305 実行元で絞り込める（定期処理だけ）', logs.runs.length >= 2 && logs.runs.every(r => r.trigger_source === 'cron') && logs.latest.last_real_run && logs.latest.last_cron_run, logs.runs.map(r => r.trigger_source))
  const man = (await hq.get('/api/hq/retention/logs?trigger=manual')).data
  ok('#305 手動の dry-run だけに絞り込める', man.runs.length >= 2 && man.runs.every(r => r.trigger_source === 'manual' && r.dry_run === 1), man.runs.map(r => r.trigger_source))
  const tokRun = logs.runs.find(r => r.items.some(i => i.target === 'password_reset_tokens'))
  ok('#397 トークンの削除は retention_logs にも残り、本部の実行ログに出る', tokRun && tokRun.dry_run === 0 && tokRun.items.find(i => i.target === 'expired_report_tokens').deleted_count >= 2, tokRun)
}

// ---------- #419 #437 毎日の cron（2回目）: 残りを消し、退職者を削除する ----------
ok('（前提）毎日の cron（3:00）を実行（2回目）', await cron(DAILY) === 200)
{
  const a = d1(`SELECT COUNT(*) AS n FROM retention_pending_r2;
    SELECT COUNT(*) AS n FROM shifts WHERE staff_id = ${X};
    SELECT COUNT(*) AS n FROM notice_read_staff_reports WHERE staff_id = ${X};
    SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id = ${X};
    SELECT target, target_count, deleted_count, failed_count FROM retention_logs WHERE log_id > (SELECT MAX(log_id) - 40 FROM retention_logs) AND dry_run = 0 AND target IN ('r2_photos', 'r2_pending', 'retired_staff', 'notice_read_staff_reports') ORDER BY log_id DESC`)
  await waitServer()
  const lg = Object.fromEntries(a[4].reverse().map(x => [x.target, x]))
  ok('#419 翌日に回した R2 のファイルと、退職者の写真を消す（残りなし）', a[0][0].n === 0 && lg.r2_pending && lg.r2_pending.target_count === 0 && lg.r2_photos.deleted_count >= 2, { left: a[0][0].n, lg })
  ok('#419 次回に回した退職者を処理する', a[1][0].n === 0 && a[3][0].n === 0 && lg.retired_staff && lg.retired_staff.deleted_count >= 1, a)
  ok('#437 退職後7年でスタッフ別の既読率を削除する', a[2][0].n === 0 && lg.notice_read_staff_reports && lg.notice_read_staff_reports.deleted_count === 1, lg.notice_read_staff_reports)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
