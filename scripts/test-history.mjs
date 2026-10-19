// 履歴の検索・CSV 出力・保存期間（docs/spec_attendance_correction.md 8章・10章）の統合テスト
// 前提: test-report-settings → test-corrections → test-notifications の後に、同じ DB で実行する（申請・履歴のデータを使う）
//   定期削除の確認には、wrangler dev を --test-scheduled 付きで起動し、環境変数 PERSIST に --persist-to の保存先を指定する
//   （wrangler.jsonc のローカルの既定は RETENTION_ENABLED=false（dry-run）なので、--var RETENTION_ENABLED:true も付ける）
//   （ローカルの D1 に退職日・古い通知を書き込み、/__scheduled で毎日の cron を実行する。テスト用の DB 専用）
//   注意: 現状のビルド設定（cloudflare-pages）は scheduled を出力しないため、定期削除の確認は
//   vite.config.ts を @hono/vite-build/cloudflare-workers（output: '_worker.js'）にしたビルドで行う（別 PR で修正予定）
// 実行: PERSIST=<保存先> node scripts/test-history.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // Response.text() は UTF-8 の BOM を取り除くため、生のバイト列で BOM を確かめる
    const bytes = new Uint8Array(await r.arrayBuffer())
    const bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, bom, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '' }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
// CSV を行・列に分解（引用符・改行を含むセルに対応）
function parseCsv(text) {
  const s = text.replace(/^﻿/, ''); const rows = []; let row = [], cell = '', q = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += ch }
    else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r') { }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}
// シェルを通さずに wrangler を呼ぶ（Windows で SQL が分割されないように）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
// 別プロセスから D1 に書き込むと、ローカルの開発サーバーの接続がいったん切れるため、応答が戻るまで待つ
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001'))
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

// ---------- 申請の一覧の CSV ----------
{
  const r = await admin.get('/api/admin/corrections/export')
  const rows = parseCsv(r.text)
  const list = (await admin.get('/api/admin/corrections')).data.corrections
  ok('申請 CSV: text/csv・UTF-8 BOM 付き・日本語のファイル名', r.status === 200 && /text\/csv/.test(r.type) && r.bom && /filename\*=UTF-8''/.test(r.disp), [r.status, r.type, r.disp])
  ok('申請 CSV: 見出しと件数（一覧と同じ）', rows[0][0] === '申請ID' && rows[0].includes('修正理由') && rows[0].includes('却下理由') && rows.length - 1 === list.length, [rows[0].slice(0, 5), rows.length - 1, list.length])
  const ap = parseCsv((await admin.get('/api/admin/corrections/export?status=approved&kind=add')).text)
  ok('申請 CSV: 絞り込み（状態・申請の種類）', ap.length > 1 && ap.slice(1).every(x => x[1] === '承認済み' && x[2] === '打刻漏れの追加'), ap.slice(1).map(x => [x[1], x[2]]))
  // 数式インジェクション対策
  const sh = (await admin.get(`/api/admin/shifts?from=${today}&to=${today}`)).data.shifts.find(s => s.staff_id === 1)
  const inj = await st1.post('/api/staff/corrections', { shift_id: sh.shift_id, report_type: 'departure', kind: 'add', requested_at: `${today} 08:00`, reason: '=HYPERLINK("http://example.com","x")' })
  const all = parseCsv((await admin.get('/api/admin/corrections/export')).text)
  const row = all.find(x => x[0] === String(inj.data && inj.data.correction_id))
  ok('申請 CSV: 数式として実行される値の先頭に \' を付ける', inj.status === 200 && row && row[10].startsWith("'="), [inj.status, row && row[10]])
}

// ---------- 打刻修正の操作履歴 ----------
{
  const ev = (await admin.get('/api/admin/corrections/events')).data.events
  const kinds = new Set(ev.map(e => e.event))
  ok('操作履歴: 申請・再申請・承認・例外承認・却下・取り消しが記録されている', ['submitted', 'resubmitted', 'approved', 'approved_exception', 'rejected', 'cancelled'].every(k => kinds.has(k)), [...kinds])
  const rej = (await admin.get('/api/admin/corrections/events?event=rejected')).data.events
  ok('操作履歴: 絞り込み（却下）と内容（却下理由）', rej.length > 0 && rej.every(e => e.event === 'rejected' && /却下理由/.test(e.summary)), rej.map(e => e.summary))
  const ex = parseCsv((await admin.get('/api/admin/corrections/events/export?event=approved_exception')).text)
  ok('操作履歴 CSV: 例外承認と矛盾の内容', ex.length > 1 && ex.slice(1).every(x => x[2] === '例外承認' && /矛盾/.test(x[12])), ex.slice(1).map(x => [x[2], x[12]]))
  const cr = parseCsv((await admin.get('/api/admin/corrections/events/export?event=cancelled,resubmitted')).text)
  ok('操作履歴 CSV: 取り消し・再申請（再申請の元の申請 ID 付き）', cr.length > 1 && cr.slice(1).every(x => ['取り消し', '再申請'].includes(x[2])) && cr.slice(1).some(x => x[2] === '再申請' && x[6]), cr.slice(1).map(x => [x[2], x[6]]))
}

// ---------- 報告設定の変更履歴（全案件）----------
{
  const logs = (await admin.get('/api/admin/report-settings/logs?action=bulk')).data.logs
  ok('設定変更履歴: 全案件から操作で絞り込み', logs.length > 0 && logs.every(l => l.action === 'bulk'), logs.length)
  const byName = (await admin.get('/api/admin/report-settings/logs?staff_name=' + encodeURIComponent('佐藤'))).data.logs
  ok('設定変更履歴: スタッフ名で絞り込み', byName.length > 0 && byName.every(l => /佐藤/.test(l.staff_name || '')), byName.map(l => l.staff_name))
  const csv = parseCsv((await admin.get('/api/admin/report-settings/logs/export?action=project_default')).text)
  ok('設定変更履歴 CSV: 見出し・標準設定の変更・変更者', csv[0][0] === '履歴ID' && csv.length > 1 && csv.slice(1).every(x => x[4] === '標準設定' && x[8] === '標準設定' && x[10]), csv.slice(0, 3))
}

// ---------- メール送信状況の CSV・権限・回帰 ----------
{
  const m = parseCsv((await admin.get('/api/admin/notification-emails/export?status=failed')).text)
  ok('メール送信状況 CSV: 送信失敗の宛先・理由・試行回数', m.length > 1 && m.slice(1).every(x => x[2] === '送信失敗' && x[5] && x[10] && Number(x[11]) >= 1), m.slice(0, 2))
  for (const p of ['/api/admin/corrections/export', '/api/admin/corrections/events/export', '/api/admin/report-settings/logs/export', '/api/admin/notification-emails/export']) {
    const r = await st1.get(p)
    ok(`権限: スタッフは CSV を出力できない（403）${p}`, r.status === 403, r.status)
  }
  const anon = await fetch(`${BASE}/api/admin/corrections/export`)
  ok('権限: 未ログインは 401', anon.status === 401, anon.status)
  const from = new Date(Date.now() + 9 * 3600e3 - 30 * 86400e3).toISOString().slice(0, 10)
  const se = await admin.get(`/api/admin/settlement/export?from=${from}&to=${today}`)
  ok('回帰: 精算の CSV は従来どおり（BOM・見出し）', se.status === 200 && se.bom && parseCsv(se.text)[0][0] === 'シフトID', [se.status, parseCsv(se.text)[0].slice(0, 3)])
}

// ---------- 保存期間（定期削除）----------
if (!PERSIST) {
  console.log('SKIP  定期削除の確認（PERSIST が未指定）')
} else {
  // スタッフ 1 を 8 年前に退職したことにし、3 年前の通知を 1 件入れる（テスト用の DB のみ）
  // 退職日より後にシフトがある人と、猶予中の人は削除しないため、シフトを退職日より前へ移し、猶予も明けたことにする
  d1(`UPDATE users SET retired_at = '2018-01-01' WHERE user_id = (SELECT user_id FROM staff_profiles WHERE staff_id = 1);
      UPDATE shifts SET work_date = date(work_date, '-9 years') WHERE staff_id = 1;
      UPDATE staff_profiles SET retention_flagged_at = '2000-01-01' WHERE staff_id = 1;
      INSERT INTO user_notifications (company_id, user_id, kind, title, created_at) VALUES (1, 1, 'correction_submitted', '古い通知', '2023-01-01 09:00:00');`)
  await waitServer()
  const hq = client(await login('sample', 'hq'))
  const dry = await hq.post('/api/hq/retention/dry-run')
  const t = Object.fromEntries((dry.data.results || []).map(r => [r.target, r.targetCount]))
  ok('定期削除の確認（dry-run）: 退職後 7 年の打刻修正・操作履歴・報告設定・通知メール、2 年経過の通知が対象', dry.status === 200 && t.attendance_corrections > 0 && t.attendance_correction_events > 0 && t.report_setting_logs > 0 && t.project_staff_report_settings > 0 && t.notification_emails > 0 && t.user_notifications >= 1, t)
  const before = d1(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id = 1; SELECT COUNT(*) AS n FROM report_setting_logs WHERE staff_id IS NULL; SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id != 1`)
  await waitServer()
  const sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  ok('（前提）毎日の cron を実行', sc.status === 200, sc.status)
  const after = d1(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id = 1;
    SELECT COUNT(*) AS n FROM attendance_correction_events e WHERE NOT EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.correction_id = e.correction_id);
    SELECT COUNT(*) AS n FROM notification_emails e WHERE NOT EXISTS (SELECT 1 FROM attendance_corrections c WHERE c.correction_id = e.correction_id);
    SELECT COUNT(*) AS n FROM report_setting_logs WHERE staff_id = 1; SELECT COUNT(*) AS n FROM project_staff_report_settings WHERE staff_id = 1;
    SELECT COUNT(*) AS n FROM user_notifications WHERE title = '古い通知';
    SELECT COUNT(*) AS n FROM report_setting_logs WHERE staff_id IS NULL; SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id != 1`)
  const n = after.map(r => r[0].n)
  ok('定期削除: 退職後 7 年のスタッフの申請・操作履歴・通知メール・報告設定とその履歴を削除', before[0][0].n > 0 && n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0 && n[4] === 0, [before[0][0].n, n])
  ok('定期削除: 2 年経過の通知を削除', n[5] === 0, n[5])
  ok('定期削除: 他のスタッフの申請と、案件の標準設定の履歴（個人情報なし）は残る', n[6] === before[1][0].n && n[7] === before[2][0].n && n[7] > 0, [n[6], before[1][0].n, n[7], before[2][0].n])
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
