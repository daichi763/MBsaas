// w12-analytics（利用者の要望 Sprint 12。#9511 #9512）の統合テスト
//  #9511 日報テンプレートを差し替えた後も、古い項目を元の表示名で出す（案件詳細の実績・実績分析・日報の一覧・日報 CSV）
//  #9512 実績分析の案件の選択（全案件は共通の数だけ）・案件と月ごとの CSV（ファイル名に案件名と月）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8811 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（テスト用の日報の値・案件の状態をローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8811 PERSIST=<保存先> node scripts/test-w12-analytics.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8811'
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
    const bytes = new Uint8Array(await r.arrayBuffer())
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
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
const fileNameOf = (r) => { const m = /filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') || ''); return m ? decodeURIComponent(m[1]) : '' }

const admin = client(await login('sample', 'admin'))

// ---------- テスト用のデータ: 日報の多い月・案件 ----------
const [m] = d1(`SELECT dr.project_id, substr(dr.work_date, 1, 7) AS month, COUNT(*) AS n FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id
  WHERE dr.company_id = 1 AND p.report_template_id IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`)[0]
const PID = m.project_id, MONTH = m.month
const [mFrom, mTo] = [MONTH + '-01', MONTH + '-31']
const reps = d1(`SELECT daily_report_id, staff_id FROM daily_reports WHERE project_id = ${PID} AND work_date LIKE '${MONTH}%' ORDER BY daily_report_id LIMIT 3`)[0]
const [{ project_name: PNAME, report_template_id: ORIG_TPL }] = d1(`SELECT project_name, report_template_id FROM projects WHERE project_id = ${PID}`)[0]
const [{ n: ALL_N }] = d1(`SELECT COUNT(*) AS n FROM daily_reports WHERE company_id = 1 AND work_date LIKE '${MONTH}%'`)[0]
const tag = Date.now().toString(36)

// テンプレート A（古い項目 w12old・w12memo）→ 日報に値を入れる → テンプレート B（新しい項目 w12new）に差し替える
const ta = await admin.post('/api/admin/templates', { template_name: 'w12旧' + tag, fields: [
  { key: 'seiyaku', label: '成約数', type: 'number' }, { key: 'w12old', label: '旧の件数', type: 'number' }, { key: 'w12memo', label: '旧メモ', type: 'textarea' }] })
const tb = await admin.post('/api/admin/templates', { template_name: 'w12新' + tag, fields: [
  { key: 'seiyaku', label: '成約数', type: 'number' }, { key: 'w12new', label: '新の件数', type: 'number' }] })
ok('準備: テンプレートを2つ作る', ta.status === 200 && tb.status === 200, [ta.data, tb.data])
const TA = ta.data.template_id, TB = tb.data.template_id
{
  const r1 = await admin.put(`/api/admin/projects/${PID}`, { report_template_id: TA })
  ok('#9511 日報のある案件のテンプレートを変えるときは確かめる（409。元の表示名で出ると伝える）', r1.status === 409 && r1.data.confirm_template_change && /元の表示名/.test(r1.data.error), r1.data)
  const r2 = await admin.put(`/api/admin/projects/${PID}`, { report_template_id: TA, confirm_template_change: true })
  ok('準備: テンプレート A に差し替える', r2.status === 200, r2.data)
  const [{ past }] = d1(`SELECT past_report_fields_json AS past FROM projects WHERE project_id = ${PID}`)[0]
  const arr = JSON.parse(past || '[]')
  ok('#9511 差し替える前のテンプレートの項目を案件に残す（template_id・差し替えた日時つき）', arr.length > 0 && arr.every(f => f.key && f.label && f.template_id === ORIG_TPL && f.replaced_at), arr.slice(0, 3))
}
d1(`UPDATE daily_reports SET report_values = json_set(report_values, '$.w12old', 5, '$.w12memo', 'メモ, "引用"') WHERE daily_report_id = ${reps[0].daily_report_id}`)
d1(`UPDATE daily_reports SET report_values = json_set(report_values, '$.w12old', 2, '$.wifi', 4) WHERE daily_report_id = ${reps[reps.length - 1].daily_report_id}`)
{
  const r = await admin.put(`/api/admin/projects/${PID}`, { report_template_id: TB, confirm_template_change: true })
  ok('準備: テンプレート B に差し替える', r.status === 200, r.data)
  const arr = JSON.parse(d1(`SELECT past_report_fields_json AS past FROM projects WHERE project_id = ${PID}`)[0][0].past || '[]')
  const old = arr.find(f => f.key === 'w12old'), memo = arr.find(f => f.key === 'w12memo')
  ok('#9511 2回目の差し替えでも、前の項目に足して残す', old && old.label === '旧の件数' && old.type === 'number' && old.template_id === TA && memo && memo.label === '旧メモ'
    && arr.some(f => f.template_id === ORIG_TPL), arr)
  const n = arr.length
  // 同じテンプレートを選び直しても（変更なし）増えない
  await admin.put(`/api/admin/projects/${PID}`, { report_template_id: TB, confirm_template_change: true })
  ok('#9511 テンプレートが変わらない更新では残した項目は変わらない', JSON.parse(d1(`SELECT past_report_fields_json AS past FROM projects WHERE project_id = ${PID}`)[0][0].past).length === n)
}
await waitServer()

// ---------- #9511 案件詳細のスタッフ別実績 ----------
{
  const r = await admin.get(`/api/admin/projects/${PID}?month=${MONTH}`)
  const d = r.data
  const pf = d.performance_fields || []
  const old = pf.find(f => f.key === 'w12old')
  ok('#9511 案件詳細: 古い数値項目を元の表示名で出す（past の印つき）', r.status === 200 && old && old.label === '旧の件数' && old.past === true, pf)
  ok('#9511 案件詳細: 今のテンプレートの項目が先、古い項目が後ろ', pf.findIndex(f => f.key === 'seiyaku') < pf.findIndex(f => f.key === 'w12old'), pf.map(f => f.key))
  ok('#9511 案件詳細: その月の日報に値の無い項目は出さない（w12new）', !pf.some(f => f.key === 'w12new'), pf.map(f => f.key))
  const wifi = pf.find(f => f.key === 'wifi')
  ok('#9511 案件詳細: どちらにも無いキーは本部・自社のテンプレートの表示名で補う', wifi && wifi.label === '置き型Wi-Fi件数', wifi)
  const sum = (d.staff_performance || []).reduce((s, x) => s + Number((x.values || {}).w12old || 0), 0)
  ok('#9511 案件詳細: 古い項目の値の合計（5+2）', sum === 7, d.staff_performance)
  const past = d.project.past_report_fields || []
  ok('#9511 案件詳細: 以前のテンプレートの項目（今のテンプレートに無いもの）を返す', past.some(f => f.key === 'w12old' && f.label === '旧の件数') && past.some(f => f.key === 'w12memo') && !past.some(f => f.key === 'seiyaku'), past)
  ok('案件詳細: 内部の列（past_report_fields_json）はそのまま返さない', !('past_report_fields_json' in d.project))
}

// ---------- #9511 日報の一覧・CSV ----------
{
  const r = await admin.get(`/api/admin/daily-reports?project_id=${PID}&from=${mFrom}&to=${MONTH}-28&limit=200`)
  const pf = (r.data.past_fields || {})[PID] || []
  ok('#9511 日報の一覧: 案件ごとの古い項目を元の表示名で返す（数値・文字）', r.status === 200 && pf.some(f => f.key === 'w12old' && f.label === '旧の件数') && pf.some(f => f.key === 'w12memo' && f.label === '旧メモ'), r.data.past_fields)
  ok('#9511 日報の一覧: 今のテンプレートの項目は past_fields に入れない', !pf.some(f => f.key === 'seiyaku' || f.key === 'w12new'), pf.map(f => f.key))
  ok('#9511 日報の一覧: 古い項目の値は消えていない', (r.data.reports || []).some(x => x.values && x.values.w12old === 5 && x.values.w12memo === 'メモ, "引用"'))
  const c = await admin.get(`/api/admin/daily-reports-csv?project_id=${PID}&from=${mFrom}&to=${MONTH}-28`)
  const rows = parseCsv(c.text)
  const h = rows[0] || []
  ok('#9511 日報 CSV: 古い項目は元の表示名の列（キー名の列にしない）', c.status === 200 && h.includes('旧の件数') && h.includes('旧メモ') && !h.includes('w12old') && !h.includes('w12memo'), h)
  ok('#9511 日報 CSV: 今のテンプレートの項目の列が古い項目より前', h.indexOf('新の件数') >= 0 && h.indexOf('新の件数') < h.indexOf('旧の件数'), h)
  const line = rows.find(x => x[h.indexOf('旧メモ')] === 'メモ, "引用"')
  ok('#9511 日報 CSV: 古い項目の値が出る', line && line[h.indexOf('旧の件数')] === '5', line)
  ok('日報 CSV: 行の長さがそろう', rows.every(x => x.length === h.length))
}

// ---------- #9512 実績分析: 全案件 ----------
{
  const r = await admin.get(`/api/admin/analytics?month=${MONTH}`)
  const a = r.data
  ok('#9512 全案件: テンプレートの項目の列は出さない', r.status === 200 && Array.isArray(a.fields) && a.fields.length === 0 && a.project === null, a.fields)
  ok('#9512 全案件: 日報数・稼働人数・稼働日数・案件数を返す', a.totals.reports === ALL_N && a.totals.staff_count > 0 && a.totals.work_days > 0 && a.totals.project_count > 0, a.totals)
  ok('#9512 全案件: 案件別に稼働人数', a.by_project.some(p => p.project_id === PID && p.staff_count > 0 && p.reports > 0), a.by_project.slice(0, 2))
  ok('#9512 案件の選択肢を返す（自社の案件）', Array.isArray(a.projects) && a.projects.some(p => p.project_id === PID && p.project_name === PNAME), a.projects)
  const c = await admin.get(`/api/admin/analytics/csv?month=${MONTH}&by=project`)
  const rows = parseCsv(c.text)
  ok('#9512 全案件の CSV: 共通の数の列だけ・ファイル名に「全案件」と月', c.status === 200 && rows[0].includes('稼働人数') && !rows[0].includes('成約数') && fileNameOf(c) === `実績分析_全案件_案件別_${MONTH}.csv`
    && rows.every(x => x.length === rows[0].length), { h: rows[0], f: fileNameOf(c) })
}

// ---------- #9512 実績分析: 案件を選ぶ ----------
{
  const r = await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${PID}`)
  const a = r.data
  const [{ n }] = d1(`SELECT COUNT(*) AS n FROM daily_reports WHERE project_id = ${PID} AND work_date LIKE '${MONTH}%'`)[0]
  ok('#9512 案件を選ぶと、その案件の日報だけを集計する', r.status === 200 && a.project && a.project.project_id === PID && a.totals.reports === n && a.by_project.length === 1, { got: a.totals, n })
  const old = a.fields.find(f => f.key === 'w12old')
  ok('#9511 #9512 案件の実績分析: 古い数値項目を元の表示名で（後ろに）', old && old.label === '旧の件数' && old.past === true && a.totals.values.w12old === 7
    && a.fields.findIndex(f => f.key === 'seiyaku') < a.fields.indexOf(old), a.fields)
  ok('#9512 案件の実績分析: 文字の項目は集計しない', !a.fields.some(f => f.key === 'w12memo' || f.key === 'free'), a.fields.map(f => f.key))
  ok('#9512 案件の実績分析: スタッフ別の合計が全体と一致する', a.by_staff.reduce((s, x) => s + (x.values.w12old || 0), 0) === 7 && a.by_staff.reduce((s, x) => s + x.reports, 0) === n)
  ok('#9512 案件の実績分析: 日別にも項目の値', a.daily.reduce((s, x) => s + (x.values.w12old || 0), 0) === 7)
  for (const by of ['staff', 'project', 'client', 'daily']) {
    const c = await admin.get(`/api/admin/analytics/csv?month=${MONTH}&by=${by}&project_id=${PID}`)
    const rows = parseCsv(c.text)
    const fn = fileNameOf(c)
    ok(`#9512 案件の CSV（${by}）: 項目の列（古い項目は元の表示名）・行の長さ・ファイル名に案件名と月`, c.status === 200 && rows[0].includes('旧の件数') && !rows[0].includes('w12old') && !rows[0].includes('案件数')
      && rows.every(x => x.length === rows[0].length) && fn.includes(PNAME.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)) && fn.endsWith(`_${MONTH}.csv`), { h: rows[0], fn })
  }
  const sc = parseCsv((await admin.get(`/api/admin/analytics/csv?month=${MONTH}&by=staff&project_id=${PID}`)).text)
  const total = sc.slice(1).reduce((s, x) => s + Number(x[sc[0].indexOf('旧の件数')] || 0), 0)
  ok('#9512 案件のスタッフ別 CSV の合計が画面と同じ', total === 7, sc)
}

// ---------- #9512 案件の確かめ・選択肢 ----------
{
  const [other] = d1(`SELECT project_id FROM projects WHERE company_id != 1 ORDER BY project_id LIMIT 1`)[0]
  if (other) {
    const r = await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${other.project_id}`)
    const c = await admin.get(`/api/admin/analytics/csv?month=${MONTH}&by=staff&project_id=${other.project_id}`)
    ok('#9512 ほかの会社の案件は 404（画面・CSV）', r.status === 404 && c.status === 404, [r.status, c.status])
  }
  for (const bad of ['abc', '0', '-1', '1.5']) {
    const r = await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${encodeURIComponent(bad)}`)
    ok(`#9512 形式の違う案件（${bad}）は 404`, r.status === 404, r.status)
  }
  ok('#9512 project_id=all は全案件', (await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=all`)).data.project === null)
  // 終了した案件: 日報があれば選べる、日報が無ければ出さない
  const [noRep] = d1(`SELECT p.project_id FROM projects p WHERE p.company_id = 1 AND NOT EXISTS (SELECT 1 FROM daily_reports d WHERE d.project_id = p.project_id) ORDER BY p.project_id LIMIT 1`)[0]
  const [{ status: origStatus }] = d1(`SELECT COALESCE(status, 'active') AS status FROM projects WHERE project_id = ${PID}`)[0]
  d1(`UPDATE projects SET status = 'closed' WHERE project_id IN (${PID}${noRep ? ', ' + noRep.project_id : ''})`)
  try {
    await waitServer()
    const a = (await admin.get(`/api/admin/analytics?month=${MONTH}`)).data
    const p = a.projects.find(x => x.project_id === PID)
    ok('#9512 終了した案件も、日報があれば選択肢に出る（終了の印つき）', p && p.status === 'closed', p)
    if (noRep) ok('#9512 日報の無い終了した案件は選択肢に出さない', !a.projects.some(x => x.project_id === noRep.project_id))
    ok('#9512 選択肢は稼働中の案件が先', a.projects.findIndex(x => x.status === 'closed') === -1 || a.projects.slice(a.projects.findIndex(x => x.status === 'closed')).every(x => x.status === 'closed'), a.projects.map(x => x.status))
    const s = await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${PID}`)
    ok('#9512 終了した案件も集計できる', s.status === 200 && s.data.totals.reports > 0)
  } finally {
    d1(`UPDATE projects SET status = '${origStatus}' WHERE project_id = ${PID}`)
    if (noRep) d1(`UPDATE projects SET status = 'active' WHERE project_id = ${noRep.project_id}`)
  }
}

// ---------- 0092 より前に差し替えた案件（残した項目なし）は、テンプレートの同じキーの表示名で補う ----------
{
  const saved = d1(`SELECT past_report_fields_json AS past FROM projects WHERE project_id = ${PID}`)[0][0].past
  d1(`UPDATE projects SET past_report_fields_json = NULL WHERE project_id = ${PID}`)
  try {
    await waitServer()
    const a = (await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${PID}`)).data
    const wifi = a.fields.find(f => f.key === 'wifi'), old = a.fields.find(f => f.key === 'w12old')
    ok('#9511 残した項目が無いときは、自社・本部のテンプレートの同じキーの表示名で補う', wifi && wifi.label === '置き型Wi-Fi件数' && old && old.label === '旧の件数', a.fields)
    const r = await admin.get(`/api/admin/daily-reports?project_id=${PID}&from=${mFrom}&to=${MONTH}-28&limit=200`)
    const pf = (r.data.past_fields || {})[PID] || []
    ok('#9511 日報の一覧も同じように補う', pf.some(f => f.key === 'w12old' && f.label === '旧の件数'), pf)
  } finally {
    d1(`UPDATE projects SET past_report_fields_json = '${String(saved).replace(/'/g, "''")}' WHERE project_id = ${PID}`)
  }
}

// ---------- テンプレートの無かった案件にテンプレートを付けると、「報告内容（free）」を残す ----------
{
  const [{ past: saved, tpl }] = d1(`SELECT past_report_fields_json AS past, report_template_id AS tpl FROM projects WHERE project_id = ${PID}`)[0]
  d1(`UPDATE projects SET report_template_id = NULL, past_report_fields_json = NULL WHERE project_id = ${PID}`)
  try {
    await waitServer()
    const r = await admin.put(`/api/admin/projects/${PID}`, { report_template_id: TA, confirm_template_change: true })
    const arr = JSON.parse(d1(`SELECT past_report_fields_json AS past FROM projects WHERE project_id = ${PID}`)[0][0].past || '[]')
    ok('#9511 テンプレートの無かった案件の差し替えでは「報告内容」（free）を残す', r.status === 200 && arr.some(f => f.key === 'free' && f.label === '報告内容' && f.template_id === null), arr)
  } finally {
    d1(`UPDATE projects SET report_template_id = ${tpl == null ? 'NULL' : Number(tpl)}, past_report_fields_json = ${saved == null ? 'NULL' : `'${String(saved).replace(/'/g, "''")}'`} WHERE project_id = ${PID}`)
  }
}

// ---------- 画面のスクリプト ----------
{
  const js = await (await fetch(`${BASE}/static/admin.js`)).text()
  ok('#9512 実績分析に案件の選択と月の入力（input type=month）', js.includes('data-analytics-project') && js.includes('type="month"') && js.includes('data-analytics-month'))
  ok('#9512 CSV に project_id を付ける', /csvQs[\s\S]{0,200}project_id/.test(js))
  ok('指標の選択を onchange の文字列に埋め込まない', !js.includes('onchange="setAnalyticsKey'))
  ok('#9511 案件詳細: 隠れている列があることを示し、すべての項目に切り替えられる', js.includes('toggleProjectPerfCols') && js.includes('表に出していない項目が'))
  ok('#9511 日報の一覧: past_fields を使う', js.includes('data.past_fields'))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
