// 日報の月ごとの集計の表（作業単位 w26-summary: #9972。migrations/0111・src/lib/monthly-summary.ts）の統合テスト
//  確定した過去の月（今月と前月より前）の実績分析・グラフ・CSV・スキルシートの通算実績を、集計の表から出しても、
//  日報の表から数えたとき（これまでのコード）と応答が1文字も変わらないことを、いろいろな絞り込み・期間で確かめる。
//   - これまでのコードの応答は、本部の閲覧（D1 が読み取り専用で集計を書けないので、日報の表から数える）で、集計済みの印を消してから取る
//   - あわせて、いくつかの数は日報の表から SQL で数えた値とも突き合わせる
//  集計の表の作り直し: 日報の追加・修正・削除で印が消え（トリガー）、次に開いたときに作り直す。今月の日報・確認では何も書かない
//  読み取り・書き込みの行は応答のヘッダー X-Test-D1-Rows（「読み取り/書き込み」。TEST_HOOKS のときだけ付く）で数える
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --var TEST_HOOKS:true --port 9025 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9025 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w26-summary.mjs
//   本番には接続しない
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:9025'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 900) : ''}`) }
const info = (name, v) => console.log(`INFO  ${name}: ${JSON.stringify(v)}`)

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w26sm-'))
let sqlSeq = 0
async function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); break } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '')
      if (i >= 3 || !/internal error|SQLITE_BUSY|database is locked|bad_alloc|write EOF/i.test(msg)) throw new Error(msg.slice(0, 600))
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  await waitServer()
  return JSON.parse(out.slice(out.indexOf('['))).at(-1).results
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const rowsOf = (h) => { const [a, b] = String(h || '').split('/').map(Number); return { read: Number.isFinite(a) ? a : null, written: Number.isFinite(b) ? b : null } }
async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (r.status !== 200 || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, ...rowsOf(r.headers.get('x-test-d1-rows')) }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`); return r.data }
const jst = (ms = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst().slice(0, 10)
const cur = today.slice(0, 7)
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7) }
const LAST_SUM = ymAdd(cur, -2) // 集計の表から読む最後の月

const PFX = 'W26S' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
const P1 = await newProject(`${PFX}-案件1`), P2 = await newProject(`${PFX}-案件2`), P3 = await newProject(`${PFX}-案件3`)
const A = await newStaff('A'), B = await newStaff('B'), C = await newStaff('C')
const S = [A.staff_id, B.staff_id, C.staff_id]
// 案件1は本部のテンプレート（数値の項目あり）と、差し替える前の項目（oldkey）。案件2は別のテンプレート、案件3はテンプレートなし
await sql(`UPDATE projects SET report_template_id = 1, past_report_fields_json = '[{"key":"oldkey","label":"旧の項目","type":"number"}]' WHERE project_id = ${P1};
  UPDATE projects SET report_template_id = 2 WHERE project_id = ${P2}`)
// 他社（company_id = 2）の日報。案件は他社の案件
const [co2p] = await sql(`INSERT INTO projects (company_id, project_name) VALUES (2, '${PFX}-他社の案件') RETURNING project_id`)
const co2 = { sid: A.staff_id, pid: co2p.project_id }

// 日報を SQL で入れる（8か月前の1日〜今日。値はいろいろな形: 数値・小数・負の数・数値でない値・JSON でない文字・空・重なったキー・
// テンプレートに無いキー・パスで表せないキー・配列・数値を文字で書いた値）。同じキーが2つある JSON はアプリでは作られないので入れない（notes 参照）。同じ人が同じ日に2つの案件に出す日もある。他社の日報も入れる（混ざらないこと）
const VALS = [
  `'{"mnp":' || (i % 5) || ',"seiyaku":' || (i % 3) || ',"memo":"x"}'`, `'{"mnp":1.5,"pi":-2,"oldkey":3}'`, `'not json'`, `'{}'`,
  `'{"seiyaku":"3","koekake":true}'`, `'{"a\\"b":4,"unknown_k":2.25}'`, `'{"mnp":"3","seiyaku":2}'`, `'[1,2]'`, `'{"koekake":10,"shodan":4,"seiyaku":1}'`,
]
async function insertReports(n, seed, startYm = ymAdd(cur, -7)) {
  const span = Math.round((Date.parse(today) - Date.parse(startYm + '-01')) / 86400e3) + 1
  await sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, manager_checked, incident_flag, complaint_flag, submitted_at)
    WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n})
    SELECT 1, CASE (i / 5) % 3 WHEN 0 THEN ${S[0]} WHEN 1 THEN ${S[1]} ELSE ${S[2]} END, CASE (i / 7) % 3 WHEN 0 THEN ${P1} WHEN 1 THEN ${P2} ELSE ${P3} END, NULL,
      date('${startYm}-01', '+' || ((i * ${seed}) % ${span}) || ' days'),
      CASE i % ${VALS.length} ${VALS.map((v, j) => `WHEN ${j} THEN ${v}`).join(' ')} END,
      i % 2, CASE WHEN i % 11 = 0 THEN 1 ELSE 0 END, CASE WHEN i % 13 = 0 THEN 1 ELSE 0 END, '${today} 09:00:00'
    FROM k;
    INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, submitted_at)
    WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 60)
    SELECT 2, ${co2.sid}, ${co2.pid}, date('${startYm}-01', '+' || ((i * 5) % ${span}) || ' days'), '{"mnp":7,"seiyaku":9}', '${today} 09:00:00' FROM k`)
}
await insertReports(2400, 7)

// ---------- 本部の閲覧（読み取り専用。集計を書けないので、これまでどおり日報の表から数える） ----------
must(await admin.put('/api/admin/hq-access', { allowed: true }), 'hq-access')
const hqL = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code: '', user_code: 'hq', password: 'pass1234' }) })
const jar = [(hqL.headers.get('set-cookie') || '').split(';')[0]]
async function startView() {
  const vs = await fetch(`${BASE}/api/hq/view-sessions`, { method: 'POST', headers: { Cookie: jar[0], 'Content-Type': 'application/json' }, body: JSON.stringify({ company_id: 1, reason: 'w26-summary の確認', minutes: 30 }) })
  jar.splice(1)
  for (const sc of vs.headers.getSetCookie()) if (sc.startsWith('hq_view=')) jar.push(sc.split(';')[0])
  return vs.status
}
const vsStatus = await startView()
ok('本部の閲覧を始められる', hqL.status === 200 && vsStatus === 200 && jar.length === 2, { login: hqL.status, view: vsStatus })
// 閲覧の期限（30分）が切れたら始め直す
const hq = { get: async (p) => {
  let r = await client(jar.join('; ')).get(p)
  if (r.status === 403 && r.data?.code === 'hq_view_required') { await startView(); r = await client(jar.join('; ')).get(p) }
  return r
} }
const marks = async () => (await sql('SELECT ym FROM report_summary_months WHERE company_id = 1 ORDER BY ym')).map(r => r.ym)
const dropMarks = () => sql('DELETE FROM report_summary_months WHERE company_id = 1')

// 管理者（集計の表）と本部の閲覧（日報の表）で、応答が同じか。管理者は2回開く（1回目は集計を作る・2回目は集計から読む）
const rowsTable = []
async function same(name, path, opts = {}) {
  const first = await admin.get(path)
  const second = await admin.get(path)
  await dropMarks()
  const legacy = await hq.get(path)
  const a = opts.text ? second.text : JSON.stringify(second.data), b = opts.text ? legacy.text : JSON.stringify(legacy.data)
  ok(`${name}: 集計の表から出しても、日報の表から数えたときと同じ`, second.status === 200 && legacy.status === 200 && a === b,
    { status: [second.status, legacy.status], diff: firstDiff(a, b) })
  if (opts.noWrite !== false) ok(`${name}: 2回目は書き込みが無い`, second.written === 0, { written: second.written })
  rowsTable.push({ name, detail_read: legacy.read, first_read: first.read, first_written: first.written, summary_read: second.read })
  return second.data
}
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return { at: i, summary: a.slice(Math.max(0, i - 80), i + 120), detail: b.slice(Math.max(0, i - 80), i + 120) }
  return null
}

// ---------- 実績分析（月）。確定した過去の月・前月・今月、案件・スタッフの絞り込み ----------
const qs = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''))).toString()
const monthCases = []
for (const m of [ymAdd(cur, -2), ymAdd(cur, -4), ymAdd(cur, -7), ymAdd(cur, -1), cur]) {
  monthCases.push([`${m} 全案件`, { month: m }], [`${m} 案件1（テンプレートあり）`, { month: m, project_id: P1 }])
}
monthCases.push(
  ['3か月前 案件2', { month: ymAdd(cur, -3), project_id: P2 }], ['3か月前 案件3（テンプレートなし）', { month: ymAdd(cur, -3), project_id: P3 }],
  ['3か月前 スタッフ1人', { month: ymAdd(cur, -3), staff_ids: A.staff_id }], ['3か月前 スタッフ2人', { month: ymAdd(cur, -3), staff_ids: `${A.staff_id},${B.staff_id}` }],
  ['3か月前 案件1＋スタッフ2人', { month: ymAdd(cur, -3), project_id: P1, staff_ids: `${B.staff_id},${C.staff_id}` }],
  ['日報の無い月（2年前）', { month: ymAdd(cur, -24) }], ['日報の無い月（2年前）案件1', { month: ymAdd(cur, -24), project_id: P1 }],
)
for (const [name, q] of monthCases) await same(`実績分析 ${name}`, `/api/admin/analytics?${qs(q)}`)

// 日報の表から SQL で数えた値とも突き合わせる（全体の数・案件1の項目の合計）
{
  const m = ymAdd(cur, -3), from = `${m}-01`, to = `${ymAdd(m, 1)}-01`
  const a = must(await admin.get(`/api/admin/analytics?month=${m}`), 'analytics')
  const [w] = await sql(`SELECT COUNT(*) AS reports, COUNT(DISTINCT staff_id) AS staff_count, COUNT(DISTINCT work_date) AS work_days, COUNT(DISTINCT project_id) AS project_count,
    SUM(CASE WHEN incident_flag = 1 OR complaint_flag = 1 THEN 1 ELSE 0 END) AS flagged FROM daily_reports WHERE company_id = 1 AND work_date >= '${from}' AND work_date < '${to}'`)
  ok('実績分析（3か月前）の全体の数が、日報の表から数えた値と同じ', ['reports', 'staff_count', 'work_days', 'project_count', 'flagged'].every(k => a.totals[k] === w[k]), { api: a.totals, want: w })
  const bySt = await sql(`SELECT staff_id, COUNT(*) AS reports, COUNT(DISTINCT work_date) AS work_days FROM daily_reports WHERE company_id = 1 AND work_date >= '${from}' AND work_date < '${to}' GROUP BY staff_id`)
  ok('実績分析（3か月前）のスタッフ別の日報数・稼働日数が、日報の表から数えた値と同じ',
    bySt.length === a.by_staff.length && bySt.every(r => a.by_staff.some(x => x.staff_id === r.staff_id && x.reports === r.reports && x.work_days === r.work_days)), { api: a.by_staff.map(x => [x.staff_id, x.reports, x.work_days]), want: bySt })
  const p = must(await admin.get(`/api/admin/analytics?month=${m}&project_id=${P1}`), 'analytics p1')
  const sums = await sql(`SELECT je.key AS k, SUM(je.value) AS v FROM daily_reports dr, json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je
    WHERE dr.company_id = 1 AND dr.project_id = ${P1} AND dr.work_date >= '${from}' AND dr.work_date < '${to}' AND je.type IN ('integer','real') GROUP BY je.key`)
  ok('実績分析（3か月前・案件1）の項目の合計が、日報の表から数えた値と同じ', sums.length > 0 && sums.every(r => !p.fields.some(f => f.key === r.k) || p.totals.values[r.k] === r.v),
    { api: p.totals.values, want: sums })
  ok('実績分析（3か月前・案件1）: 差し替える前の項目（oldkey）も表示名つきで出る', p.fields.some(f => f.key === 'oldkey' && f.label === '旧の項目' && f.past))
  const other = must(await admin.get(`/api/admin/analytics?month=${m}`), 'analytics').by_project.some(r => r.project_id === co2.pid)
  ok('他社の日報は混ざらない', !other)
}

// ---------- CSV（実績分析の CSV も同じ集計を使う） ----------
for (const by of ['staff', 'project', 'client', 'daily']) {
  await same(`実績分析の CSV（${by}・3か月前・案件1）`, `/api/admin/analytics/csv?${qs({ month: ymAdd(cur, -3), project_id: P1, by })}`, { text: true })
}
await same('実績分析の CSV（staff・4か月前・全案件・スタッフ2人）', `/api/admin/analytics/csv?${qs({ month: ymAdd(cur, -4), by: 'staff', staff_ids: `${A.staff_id},${C.staff_id}` })}`, { text: true })

// ---------- グラフ（期間・まとめ方・分け方・指標） ----------
const from8 = ymAdd(cur, -7)
const seriesCases = [
  ['8か月・月ごと・全体', { from: from8, to: cur, unit: 'month' }],
  ['8か月・月ごと・案件別', { from: from8, to: cur, unit: 'month', split: 'project' }],
  ['8か月・月ごと・案件別・インシデント', { from: from8, to: cur, unit: 'month', split: 'project', metric: 'flagged' }],
  ['8か月・週ごと・全体', { from: from8, to: cur, unit: 'week' }],
  ['8か月・日ごと・案件別（上位3）', { from: from8, to: cur, unit: 'day', split: 'project', top: 3 }],
  ['8か月・週ごと・案件別（選んだ案件）', { from: from8, to: cur, unit: 'week', split: 'project', ids: `${P2},${P3}` }],
  ['8か月・月ごと・スタッフ2人', { from: from8, to: cur, unit: 'month', staff_ids: `${A.staff_id},${B.staff_id}` }],
  ['8か月・週ごと・スタッフ1人（日報の表から）', { from: from8, to: cur, unit: 'week', staff_ids: A.staff_id }],
  ['案件1・8か月・月ごと・項目（mnp）', { from: from8, to: cur, unit: 'month', project_id: P1, metric: 'field', key: 'mnp' }],
  ['案件1・8か月・月ごと・項目（oldkey）・スタッフ別', { from: from8, to: cur, unit: 'month', project_id: P1, metric: 'field', key: 'oldkey', split: 'staff' }],
  ['案件1・8か月・月ごと・日報数・スタッフ別（選んだ人）', { from: from8, to: cur, unit: 'month', project_id: P1, metric: 'reports', split: 'staff', ids: `${C.staff_id}` }],
  ['案件1・8か月・週ごと・日報数', { from: from8, to: cur, unit: 'week', project_id: P1, metric: 'reports' }],
  ['案件1・8か月・日ごと・項目（日報の表から）', { from: from8, to: cur, unit: 'day', project_id: P1, metric: 'field', key: 'seiyaku' }],
  ['案件1・8か月・月ごと・開催場所別（日報の表から）', { from: from8, to: cur, unit: 'month', project_id: P1, split: 'site' }],
  ['案件2・確定した月だけ・月ごと・項目（未指定）', { from: from8, to: ymAdd(cur, -3), unit: 'month', project_id: P2 }],
  ['今月と前月だけ（集計を使わない）', { from: ymAdd(cur, -1), to: cur, unit: 'month', split: 'project' }],
  ['12か月・月ごと・全体（日報の無い月を含む）', { from: ymAdd(cur, -11), to: cur, unit: 'month' }],
]
for (const [name, q] of seriesCases) await same(`グラフ ${name}`, `/api/admin/analytics/series?${qs(q)}`)

// ---------- スキルシートの通算実績 ----------
// 集計はスキルシートでは作らない（実績分析で作られた月だけを使う）。全部の月・一部の月（飛び飛び）の集計があるときに、日報の表から数えたときと同じ
async function sameSheet(name, prepare) {
  await prepare()
  const r = await admin.get(`/api/admin/staff/${A.staff_id}/skill-sheet`)
  await dropMarks()
  const legacy = await hq.get(`/api/admin/staff/${A.staff_id}/skill-sheet`)
  const pick = (d) => JSON.stringify({ performance: d.performance, performance_fields: d.performance_fields })
  ok(`スキルシート ${name}: 通算実績が日報の表から数えたときと同じ`, r.status === 200 && legacy.status === 200 && pick(r.data) === pick(legacy.data),
    { diff: firstDiff(pick(r.data), pick(legacy.data)) })
  ok(`スキルシート ${name}: 書き込みが無い`, r.written === 0, r.written)
  rowsTable.push({ name: `スキルシート ${name}`, detail_read: legacy.read, summary_read: r.read })
  return r.data
}
const buildAll = () => admin.get(`/api/admin/analytics/series?from=${from8}&to=${cur}&unit=month`)
await sameSheet('（集計なし）', async () => { await dropMarks() })
const sheet = await sameSheet('（確定した月がすべて集計済み）', buildAll)
await sameSheet('（集計済みの月が飛び飛び）', async () => { await buildAll(); await sql(`DELETE FROM report_summary_months WHERE company_id = 1 AND ym IN ('${ymAdd(cur, -4)}', '${ymAdd(cur, -6)}')`) })
const [w] = await sql(`SELECT COUNT(*) AS n FROM daily_reports WHERE staff_id = ${A.staff_id}`)
ok('スキルシートの通算の稼働日（日報の数）が、日報の表から数えた値と同じ', sheet.performance.total_days === w.n, { api: sheet.performance.total_days, want: w.n })

// ---------- 集計の作り直し（トリガーで印が消える） ----------
{
  const M = ymAdd(cur, -3)
  await buildAll()
  const has = async (ym) => (await marks()).includes(ym)
  ok('集計済みの印は確定した過去の月だけ（今月・前月には作らない）', (await marks()).every(m => m <= LAST_SUM) && await has(M), await marks())
  // 今月の日報が増えても、過去の月の印は消えない（書き込みも出ない）
  const nMarks = (await marks()).length
  await sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, submitted_at) VALUES (1, ${A.staff_id}, ${P1}, '${today}', '{"mnp":1}', '${today} 10:00:00')`)
  ok('今月の日報を足しても、集計済みの印は変わらない', (await marks()).length === nMarks)
  // 確認（manager_checked）は集計に関係ないので、印は消えない
  const rid = (await sql(`SELECT daily_report_id FROM daily_reports WHERE company_id = 1 AND project_id = ${P1} AND work_date >= '${M}-01' AND work_date < '${ymAdd(M, 1)}-01'
    AND json_valid(report_values) AND json_type(report_values) = 'object' AND COALESCE(manager_checked, 0) = 0 ORDER BY daily_report_id LIMIT 1`))[0].daily_report_id
  must(await admin.post('/api/admin/daily-reports/check', { ids: [rid] }), 'check')
  ok('過去の月の日報を確認しても、印は消えない（集計を作り直さない）', await has(M))
  // 管理者の実績の修正（#9707）で値が変わると、その月の印が消え、次に開いたときに直った値が出る
  const ed = await admin.put(`/api/admin/daily-reports/${rid}/values`, { values: { mnp: 40, seiyaku: 30 }, reason: 'w26-summary のテスト' })
  ok('過去の月の日報の値を管理者が直せる', ed.status === 200 && ed.data.changed, ed.data)
  ok('値を直すと、その月の印が消える', !(await has(M)))
  await same('値を直した後の実績分析（案件1）', `/api/admin/analytics?month=${M}&project_id=${P1}`)
  // SQL で直接変えた行（担当の付け替え・削除・追加）も、トリガーで印が消える
  await admin.get(`/api/admin/analytics?month=${M}`)
  await sql(`UPDATE daily_reports SET staff_id = ${B.staff_id} WHERE daily_report_id = ${rid}`)
  ok('担当を付け替えると、その月の印が消える', !(await has(M)))
  await same('担当を付け替えた後の実績分析', `/api/admin/analytics?month=${M}&staff_ids=${A.staff_id},${B.staff_id}`)
  await admin.get(`/api/admin/analytics?month=${M}`)
  await sql(`UPDATE daily_reports SET work_date = '${ymAdd(cur, -5)}-15' WHERE daily_report_id = ${rid}`)
  ok('稼働日を別の月に移すと、前と後の月の印が消える', !(await has(M)) && !(await has(ymAdd(cur, -5))))
  await admin.get(`/api/admin/analytics?month=${M}`)
  await sql(`DELETE FROM daily_reports WHERE company_id = 1 AND work_date >= '${M}-01' AND work_date < '${M}-04'`)
  ok('日報を消すと、その月の印が消える', !(await has(M)))
  await same('日報を消した後の実績分析', `/api/admin/analytics?month=${M}`)
  // 古くなった集計（30日）は作り直す
  await admin.get(`/api/admin/analytics?month=${M}`)
  await sql(`INSERT INTO report_month_summaries (company_id, ym, project_id, staff_id, reports) VALUES (1, '${M}', 999999, 999999, 5);
    UPDATE report_summary_months SET computed_at = '${jst(Date.now() - 31 * 86400e3)}' WHERE company_id = 1 AND ym = '${M}'`)
  await same('古くなった集計を作り直した後の実績分析', `/api/admin/analytics?month=${M}`)
  ok('作り直すと、古い集計の行は残らない', (await sql(`SELECT COUNT(*) AS n FROM report_month_summaries WHERE project_id = 999999`))[0].n === 0)
  // 本部の閲覧中は集計を書かない
  await dropMarks()
  await hq.get(`/api/admin/analytics?month=${M}`)
  await hq.get(`/api/admin/analytics/series?from=${from8}&to=${cur}&unit=month`)
  ok('本部の閲覧中は集計を書かない', (await marks()).length === 0)
}

// ---------- データが倍になっても、集計済みの月の読み取りはほとんど増えない ----------
{
  const path = `/api/admin/analytics/series?from=${from8}&to=${LAST_SUM}&unit=month&project_id=${P1}&metric=field&key=mnp&split=staff`
  await admin.get(path)
  const before = await admin.get(path)
  await insertReports(2400, 11)
  await admin.get(path)
  const after = await admin.get(path)
  ok('過去の日報を倍にしても、集計済みの月のグラフの読み取りの行はほとんど増えない', after.read <= before.read + 50, { before: before.read, after: after.read })
  info('確定した月だけのグラフ（案件1・項目・スタッフ別）の読み取り 2400件→4800件', [before.read, after.read])
  await same('日報を倍にした後のグラフ（8か月・月ごと・案件別）', `/api/admin/analytics/series?from=${from8}&to=${cur}&unit=month&split=project`)
  await same('日報を倍にした後の実績分析（3か月前・案件1）', `/api/admin/analytics?month=${ymAdd(cur, -3)}&project_id=${P1}`)
}

// ---------- 0111 の索引・トリガー ----------
{
  const plan = (await sql(`EXPLAIN QUERY PLAN SELECT reports FROM report_month_summaries WHERE staff_id = ${A.staff_id} AND company_id = 1 AND ym IN ('${LAST_SUM}')`)).map(r => r.detail).join(' / ')
  ok('スキルシートの集計はスタッフの索引で引く（会社の行をすべて読まない）', /idx_report_month_summaries_staff/.test(plan), plan)
  const trg = (await sql(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'daily_reports' AND name LIKE 'trg_daily_reports_summary_%' ORDER BY name`)).map(r => r.name)
  ok('日報のトリガー（追加・削除・更新）がある', trg.length === 3, trg)
  // 解約企業の削除（retention.ts）は rowid で消すので、新しい表に rowid があること（WITHOUT ROWID だと消せない）
  const rid = await sql(`SELECT (SELECT rowid FROM report_summary_months LIMIT 1) AS a, (SELECT rowid FROM report_month_summaries LIMIT 1) AS b,
    (SELECT rowid FROM report_day_summaries LIMIT 1) AS c`)
  ok('集計の表は rowid で引ける（解約企業の削除の形）', rid[0].a != null && rid[0].b != null && rid[0].c != null, rid)
}

must(await admin.put('/api/admin/hq-access', { allowed: false }), 'hq-access off')
console.log('\n読み取り・書き込みの行（detail_read = 日報の表から（本部の閲覧の分を含む）、first = 集計を作る回、summary_read = 集計から）')
console.table(rowsTable)
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:\n' + failed.map(f => '  ' + f.name).join('\n')); process.exit(1) }
