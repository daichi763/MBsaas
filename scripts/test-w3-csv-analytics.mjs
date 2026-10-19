// w3-csv-analytics（#71 #72 #102 #184 #445 #474 #518 #571）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8824 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（申請・履歴・社員番号などのテスト用データをローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8824 PERSIST=<保存先> node scripts/test-w3-csv-analytics.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8824'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
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
    // Response.text() は BOM を取り除くため、生のバイト列で確かめる
    const bytes = new Uint8Array(await r.arrayBuffer())
    const bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, bom, headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  // 開発サーバーが D1 を使っている間は、まれに internal error になるので数回やり直す
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
// RFC 4180 の CSV を行・列に分ける（BOM は除く）
function parseCsv(text) {
  const s = text.replace(/^﻿/, '')
  const rows = []; let row = []; let cell = ''; let q = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ }
    else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}
const crlfOnly = (t) => !/[^\r]\n/.test(t)

const admin = client(await login('sample', 'admin'))

// ---------- テスト用のデータ ----------
const [shift] = d1(`SELECT s.shift_id, s.staff_id, s.project_id, s.work_date FROM shifts s JOIN staff_profiles sp ON sp.staff_id = s.staff_id
  WHERE s.company_id = 1 AND s.status IN ('confirmed','substitute') ORDER BY s.work_date DESC, s.shift_id LIMIT 1`)[0]
const EMP = '000123'
d1(`INSERT INTO employee_records (staff_id, company_id, employee_number) VALUES (${shift.staff_id}, 1, '${EMP}')
  ON CONFLICT(staff_id) DO UPDATE SET employee_number = '${EMP}'`)
const [{ user_id: adminUserId }] = d1(`SELECT user_id FROM users WHERE company_id = 1 AND user_code = 'admin'`)[0]
d1(`INSERT INTO attendance_corrections (company_id, project_id, shift_id, staff_id, kind, report_type, requested_at, reason, status, requested_by, requested_by_name, requested_by_role)
  VALUES (1, ${shift.project_id}, ${shift.shift_id}, ${shift.staff_id}, 'add', 'check_in', '${shift.work_date} 09:00', 'テスト, "理由"', 'pending', ${adminUserId}, '管理者', 'company_admin')`)
const [{ id: corrId }] = d1(`SELECT MAX(correction_id) AS id FROM attendance_corrections`)[0]
d1(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail)
  VALUES (${corrId}, 1, 'submitted', ${adminUserId}, '管理者', 'office_staff', '{"requested_at":"${shift.work_date} 09:00","reason":"x"}')`)
// 報告設定の変更履歴を上限（10,000件）より多くする: 導入時の移行 10,001 行と、個別変更 1 行（最新）
d1(`INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, changed_by_role)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
  SELECT 1, ${shift.project_id}, ${shift.staff_id}, 'check_in', 1, 1, 'migration', NULL FROM n`)
d1(`INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, changed_by, changed_by_name, changed_by_role)
  VALUES (1, ${shift.project_id}, ${shift.staff_id}, 'work_start', 1, 0, 'individual', ${adminUserId}, '管理者', 'company_admin')`)
const [{ id: lastLogId }] = d1(`SELECT MAX(log_id) AS id FROM report_setting_logs WHERE company_id = 1`)[0]
await waitServer()

// ---------- #571 #445 打刻修正の申請 CSV ----------
{
  const r = await admin.get('/api/admin/corrections/export')
  const rows = parseCsv(r.text); const h = rows[0]
  ok('#445 申請CSV: シフトID・社員番号・クライアント・予定開始・予定終了の列がある', ['シフトID', '社員番号', 'クライアント', '予定開始', '予定終了'].every(c => h.includes(c)), h)
  const line = rows.find(x => x[0] === String(corrId))
  ok('#445 申請CSV: 追加した申請の行にシフトIDが入る', line && line[h.indexOf('シフトID')] === String(shift.shift_id), line)
  ok('#571 社員番号は ="000123" の形で出る（先頭の0を保つ）', line && line[h.indexOf('社員番号')] === `="${EMP}"`, line && line[h.indexOf('社員番号')])
  ok('#71 カンマと引用符を含む理由でも列がずれない', line && line.length === h.length && line[h.indexOf('修正理由')] === 'テスト, "理由"', line)
  ok('#102 申請CSV: X-Csv-Total ヘッダーがある', r.headers.get('x-csv-total') !== null && r.headers.get('x-csv-truncated') === '0')
  ok('CSV は BOM 付き・CRLF', r.bom && crlfOnly(r.text))
  const byEmp = await admin.get('/api/admin/corrections?staff_name=' + EMP)
  ok('#445 スタッフ欄に社員番号を入れても絞り込める', byEmp.status === 200 && byEmp.data.corrections.some(c => c.correction_id === corrId), byEmp.data)
}
// ---------- #445 #474 操作履歴 CSV ----------
{
  const r = await admin.get('/api/admin/corrections/events/export')
  const rows = parseCsv(r.text); const h = rows[0]
  ok('#445 操作履歴CSV: シフトID・社員番号の列がある', h.includes('シフトID') && h.includes('社員番号'), h)
  const line = rows.find(x => x[h.indexOf('申請ID')] === String(corrId))
  ok('#474 操作履歴CSV: ロールが日本語', line && line[h.indexOf('ロール')] === '事務担当', line)
  ok('#102 操作履歴CSV: 古い順に並ぶ', rows.slice(1).every((x, i, a) => i === 0 || Number(a[i - 1][0]) < Number(x[0])))
  const list = await admin.get('/api/admin/corrections/events')
  ok('#102 操作履歴の一覧が全件数を返す', list.status === 200 && typeof list.data.total === 'number' && list.data.total >= 1, list.data && list.data.total)
}
// ---------- #102 #474 報告設定の変更履歴 CSV ----------
{
  const r = await admin.get('/api/admin/report-settings/logs/export')
  const rows = parseCsv(r.text)
  ok('#102 上限を超えたら1行目に注記がある', rows[0].length === 1 && /新しい10,000件/.test(rows[0][0]), rows[0])
  ok('#102 X-Csv-Truncated: 1', r.headers.get('x-csv-truncated') === '1' && Number(r.headers.get('x-csv-total')) > 10000)
  const h = rows[1]
  ok('#102 データは上限の件数ちょうど', rows.length - 2 === 10000, rows.length)
  ok('#102 最新の変更（個別変更）が入り、最後の行になる', rows[rows.length - 1][0] === String(lastLogId), rows[rows.length - 1])
  ok('#474 スタッフID・社員番号の列がある', h.includes('スタッフID') && h.includes('社員番号'), h)
  const last = rows[rows.length - 1]
  ok('#474 変更者のロールが日本語', last[h.indexOf('変更者のロール')] === '会社管理者', last)
  ok('#474 社員番号が文字として出る', last[h.indexOf('社員番号')] === `="${EMP}"`, last)
  const ex = await admin.get('/api/admin/report-settings/logs/export?exclude_migration=1')
  const exRows = parseCsv(ex.text)
  ok('#102 導入時の移行を除くと注記が出ず、移行の行が無い', exRows[0][0] === '履歴ID' && !exRows.slice(1).some(x => x[exRows[0].indexOf('操作')] === '導入時の移行'), exRows[0])
  const list = await admin.get('/api/admin/report-settings/logs?limit=5')
  ok('#102 一覧が全件数と CSV の上限を返す', list.data.total > 10000 && list.data.csv_limit === 10000 && 'employee_number' in list.data.logs[0], { total: list.data.total, csv_limit: list.data.csv_limit })
}
// ---------- #102 通知メールの送信状況 CSV ----------
{
  const r = await admin.get('/api/admin/notification-emails/export')
  ok('#102 送信状況CSV: 応答と X-Csv-Total', r.status === 200 && r.headers.get('x-csv-total') !== null && r.bom, r.status)
}
// ---------- #571 精算 CSV ----------
{
  const from = shift.work_date.slice(0, 8) + '01'
  const r = await admin.get(`/api/admin/settlement/export?from=${from}&to=${shift.work_date}&kind=detail&staff_id=${shift.staff_id}`)
  const rows = parseCsv(r.text); const h = rows[0]
  const line = rows.find(x => x[0] === String(shift.shift_id))
  ok('#571 シフト明細: 社員番号が文字として出て、末尾にスタッフID', r.status === 200 && line && line[h.indexOf('社員番号')] === `="${EMP}"` && h[h.length - 1] === 'スタッフID' && line[h.length - 1] === String(shift.staff_id), { status: r.status, h: h.slice(-2), line })
  const p = await admin.get(`/api/admin/settlement/export?from=${from}&to=${shift.work_date}&kind=payment&staff_id=${shift.staff_id}`)
  const prow = parseCsv(p.text)
  ok('#571 支払集計: 末尾にスタッフID', prow[0][prow[0].length - 1] === 'スタッフID', prow[0])
}
// ---------- #184 実績分析 ----------
{
  const [m] = d1(`SELECT substr(work_date, 1, 7) AS month, COUNT(*) AS n FROM daily_reports WHERE company_id = 1 GROUP BY 1 ORDER BY n DESC LIMIT 1`)[0]
  const [dr] = d1(`SELECT dr.daily_report_id, p.report_template_id FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id
    WHERE dr.company_id = 1 AND dr.work_date LIKE '${m.month}%' AND p.report_template_id IS NOT NULL ORDER BY dr.daily_report_id LIMIT 1`)[0]
  // テンプレートに日本語のキーの数値項目を足し、その値と、テンプレートに無い古い数値項目を日報に入れる
  d1(`UPDATE report_templates SET fields_json = json_insert(fields_json, '$[#]', json('{"key":"入電数","label":"入電数（件）","type":"number"}'))
    WHERE template_id = ${dr.report_template_id} AND fields_json NOT LIKE '%入電数%'`)
  d1(`UPDATE daily_reports SET report_values = json_set(json_set(report_values, '$.入電数', 7), '$.legacy_x', 3) WHERE daily_report_id = ${dr.daily_report_id}`)
  await waitServer()
  const r = await admin.get('/api/admin/analytics?month=' + m.month)
  const a = r.data
  const f = a && a.fields.find(x => x.key === '入電数')
  ok('#184 テンプレートの数値項目（日本語のキー）がラベル付きで集計される', f && f.label === '入電数（件）' && a.totals.values['入電数'] >= 7, a && a.fields)
  ok('#184 テンプレートに無い数値項目もキーの名前で出る', a.fields.some(x => x.key === 'legacy_x' && x.label === 'legacy_x') && a.totals.values.legacy_x >= 3)
  ok('#184 テキスト項目は集計しない', !a.fields.some(x => x.key === 'free' || x.key === 'good_case'), a.fields.map(x => x.key))
  ok('#184 日報数が件数と一致する', a.totals.reports === m.n, { reports: a.totals.reports, n: m.n })
  const sumStaff = a.by_staff.reduce((s, x) => s + (x.values['入電数'] || 0), 0)
  ok('#184 スタッフ別の合計が全体と一致する', sumStaff === a.totals.values['入電数'] && a.by_staff.reduce((s, x) => s + x.reports, 0) === m.n)
  ok('#184 クライアント別・日別もある', a.by_client.length > 0 && a.daily.length > 0 && a.by_project.length > 0)
  const bad = await admin.get('/api/admin/analytics?month=2026-13')
  ok('#184 不正な月は今月にする', bad.status === 200 && /^\d{4}-\d{2}$/.test(bad.data.month) && bad.data.month !== '2026-13', bad.data && bad.data.month)
  for (const by of ['staff', 'project', 'client', 'daily']) {
    const c = await admin.get(`/api/admin/analytics/csv?month=${m.month}&by=${by}`)
    const rows = parseCsv(c.text)
    ok(`#184 実績分析CSV（${by}）: 項目のラベルの列があり、行の長さがそろう`, c.status === 200 && c.bom && rows[0].includes('入電数（件）') && rows.every(x => x.length === rows[0].length) && rows.length > 1, rows[0])
  }
  const sc = parseCsv((await admin.get(`/api/admin/analytics/csv?month=${m.month}&by=staff`)).text)
  ok('#184 スタッフ別CSVにスタッフID・社員番号', sc[0][1] === 'スタッフID' && sc[0][2] === '社員番号', sc[0])
}
// ---------- #72 #518 既読率レポート ----------
{
  const d = new Date(Date.now() + 9 * 3600 * 1000); const fy = d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1
  const title = 'csvテスト' + Date.now().toString(36)
  await admin.post('/api/admin/notices', { title, body: 'x', target_type: 'all', target_ids: '', importance: 'urgent', client_request_id: title })
  const re = await admin.post(`/api/admin/notice-reports/${fy}/recalculate`)
  ok('既読率の再集計', re.status === 200, re.data)
  const rep = (await admin.get(`/api/admin/notice-reports/${fy}`)).data
  const rates = rep.staff_reports.map(x => x.read_rate)
  const nonNull = rates.filter(x => x != null)
  const firstNull = rates.indexOf(null)
  const nullsLast = firstNull < 0 || rates.slice(firstNull).every(x => x == null)
  ok('#518 スタッフ別は既読率の低い順（なしは最後）', nonNull.every((x, i) => i === 0 || nonNull[i - 1] <= x) && nullsLast, rates)
  ok('#518 社員番号を返す', rep.staff_reports.length > 0 && 'employee_number' in rep.staff_reports[0])
  const target = rep.staff_reports.find(x => x.staff_id === shift.staff_id) || rep.staff_reports[0]
  const [{ user_id: uid, name: oldName }] = d1(`SELECT us.user_id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ${target.staff_id}`)[0]
  d1(`UPDATE users SET name = '=山田, 太郎' WHERE user_id = ${uid}`)
  await waitServer()
  try {
    const c = await admin.get(`/api/admin/notice-reports/${fy}/csv`)
    const rows = parseCsv(c.text)
    ok('#72 既読率CSV: BOM・CRLF・見出し', c.bom && crlfOnly(c.text) && rows[0].join(',') === '年度,会社,スタッフID,社員番号,スタッフ,対象数,既読数,未読数,既読率', rows[0])
    const line = rows.find(x => x[2] === String(target.staff_id))
    ok('#72 カンマを含む名前で列がずれず、= で始まる名前は無害化される', line && line.length === rows[0].length && line[4] === "'=山田, 太郎", line)
    ok('#72 Content-Disposition が日本語のファイル名', /filename\*=UTF-8''/.test(c.headers.get('content-disposition') || ''))
    const det = (await admin.get(`/api/admin/notice-reports/${fy}/staff/${target.staff_id}`)).data
    const n = det.notices.find(x => x.title === title)
    ok('#518 詳細に配信日と重要度を返す', n && n.published_at && n.importance === 'urgent' && 'read_required' in n, n)
  } finally {
    d1(`UPDATE users SET name = '${String(oldName).replace(/'/g, "''")}' WHERE user_id = ${uid}`)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
