// w23-uploads-mail（#9958 日報の項目が多い会社。本番の障害 e150e5cd の再発防止）の統合テスト
//  D1 は1文で返す列・渡す値とも100個まで。日報のテンプレートの項目が 40・70・100 個の会社を作り、
//  ダッシュボード・日報の一覧・日報の CSV・実績分析（表・CSV・グラフ）・スタッフ詳細・スキルシート・案件の一覧と詳細の API が 500 にならず、合計が正しいことを確かめる。
//  項目の数は、テンプレートの差し替え（前のテンプレートの項目は案件に残す。#9511）で1つの案件に集める（テンプレート1つは50項目まで）。
//  テンプレートに無い数値のキー（extra）も入れて、jsonKeySums の「分かっていないキー」の読み方も通す。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8926 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（日報はローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8926 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w23-many-report-keys.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const BASE = process.env.BASE || 'http://127.0.0.1:8926'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const rawFetch = globalThis.fetch
globalThis.fetch = async (...a) => { try { return await rawFetch(...a) } catch (e) { if (e && e.cause && e.cause.code === 'ECONNRESET') return rawFetch(...a); throw e } }
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
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
// 長い SQL はファイルにして流す
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w23mk-'))
let sqlSeq = 0
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, sql)
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--file', file], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data ?? r.text).slice(0, 300)}`); return r.data }
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const tag = Date.now().toString(36).slice(-5)
const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const month = jst.slice(0, 7)
const monthEnd = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`
const day = (n) => `${month}-${String(n).padStart(2, '0')}`
// 簡単な CSV の読み取り（引用符・改行を含むセルにも対応）。先頭の BOM は除く
function parseCsv(text) {
  const rows = []; let row = [], cell = '', inQ = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else inQ = false } else cell += ch; continue }
    if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const hq = client(await login('sample', 'hq'))

for (const N of [40, 70, 100]) {
  const L = `項目${N}個`
  const code = `w23k${N}${tag}`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `w23項目${N}${tag}`, admin_code: 'admin', admin_password: 'pass1234' }), 'company')
  const admin = client(await login(code, 'admin'))
  const [[co]] = d1(`SELECT company_id FROM companies WHERE company_code = ${q(code)}`)
  const CID = co.company_id
  // テンプレート（50項目ずつ）
  const keys = Array.from({ length: N }, (_, i) => `n${N}k${i}`)
  const label = (i) => `${L}の${i}`
  const chunks = []
  for (let i = 0; i < N; i += 50) chunks.push(keys.slice(i, i + 50))
  const tpls = []
  for (const [j, ks] of chunks.entries()) {
    const t = must(await admin.post('/api/admin/templates', { template_name: `w23-${N}-${j}`, fields: ks.map(k => ({ key: k, label: label(keys.indexOf(k)), type: 'number' })) }), 'template')
    tpls.push(t.template_id)
  }
  // 案件 A（テンプレートを差し替えながら、全項目の日報を持つ）と案件 B（最初のテンプレートだけ）
  must(await admin.post('/api/admin/projects', { project_name: `A${N}`, report_template_id: tpls[0] }), 'project A')
  must(await admin.post('/api/admin/projects', { project_name: `B${N}`, report_template_id: tpls[0] }), 'project B')
  const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
  const PA = projects.find(p => p.project_name === `A${N}`).project_id, PB = projects.find(p => p.project_name === `B${N}`).project_id
  for (const s of [1, 2]) must(await admin.post('/api/admin/staff', { user_code: `s${s}`, name: `スタッフ${s}`, password: 'pass1234' }), 'staff')
  const staff = must(await admin.get('/api/admin/staff'), 'staff list').staff
  const SIDS = [1, 2].map(s => staff.find(x => x.user_code === `s${s}`).staff_id)

  // 日報: スタッフ2人 × 日付2日。値は (キーの番号+1)×(スタッフ番号+1) + 日付の番号×1000。案件 A の1件にだけテンプレートに無い数値のキー（extra）を入れる
  const expected = { [PA]: {}, [PB]: {} }
  let reportCount = 0
  const add = (pid, k, v) => { expected[pid][k] = (expected[pid][k] || 0) + v }
  const insertReports = (pid, ks, days, extra) => {
    const rows = []
    SIDS.forEach((sid, s) => days.forEach((d, di) => {
      const values = {}
      for (const k of ks) { const v = (keys.indexOf(k) + 1) * (s + 1) + di * 1000; values[k] = v; add(pid, k, v) }
      if (extra && s === 0 && di === 0) { values[`extra${N}`] = 7; add(pid, `extra${N}`, 7) }
      rows.push(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, submitted_at) VALUES (${CID}, ${sid}, ${pid}, ${q(d)}, ${q(JSON.stringify(values))}, ${q(d + ' 18:00:00')});`)
      reportCount++
    }))
    d1(rows.join('\n'))
  }
  for (const [j, ks] of chunks.entries()) {
    if (j > 0) must(await admin.put(`/api/admin/projects/${PA}`, { report_template_id: tpls[j], confirm_template_change: true }), 'switch template')
    insertReports(PA, ks, [day(2 * j + 1), day(2 * j + 2)], j === 0)
  }
  insertReports(PB, chunks[0], [day(1), day(2)], false)
  const [[pa]] = d1(`SELECT past_report_fields_json FROM projects WHERE project_id = ${PA}`)
  ok(`${L}: （前提）案件 A は今のテンプレートと残した項目で ${N} 項目を持つ`, chunks.length === 1 || JSON.parse(pa.past_report_fields_json || '[]').length === N - chunks[chunks.length - 1].length, pa)
  const allKeysA = [...keys, `extra${N}`]
  const sumOf = (k) => (expected[PA][k] || 0) + (expected[PB][k] || 0)

  // ---------- ダッシュボード ----------
  const dash = await admin.get('/api/admin/dashboard')
  ok(`${L}: ダッシュボードが 200`, dash.status === 200, [dash.status, dash.text?.slice(0, 200)])
  const perfA = dash.data?.project_performance?.find(p => p.project_id === PA)
  const perfB = dash.data?.project_performance?.find(p => p.project_id === PB)
  ok(`${L}: ダッシュボードの案件別実績: 案件 A の全項目（extra も）の合計が合う`, perfA && allKeysA.every(k => perfA.values[k] === expected[PA][k]) && perfA.report_count === reportCount - 4,
    perfA && allKeysA.filter(k => perfA.values[k] !== expected[PA][k]).slice(0, 5).map(k => [k, perfA.values[k], expected[PA][k]]))
  ok(`${L}: ダッシュボードの案件別実績: 案件 B の合計が合い、案件 A だけの項目は 0`, perfB && chunks[0].every(k => perfB.values[k] === expected[PB][k]) && perfB.report_count === 4
    && keys.filter(k => !chunks[0].includes(k)).every(k => !perfB.values[k]), perfB && Object.entries(perfB.values).slice(0, 5))

  // ---------- 日報の一覧 ----------
  const list = await admin.get(`/api/admin/daily-reports?from=${month}-01&to=${monthEnd}&limit=200`)
  ok(`${L}: 日報の一覧が 200 で、件数が合う`, list.status === 200 && list.data.total === reportCount && list.data.reports?.length === reportCount, [list.status, list.data?.total, list.data?.reports?.length, list.data?.error])
  const pa0 = list.data?.reports?.find(r => r.project_id === PA && r.values && Object.keys(r.values).includes(`extra${N}`))
  ok(`${L}: 日報の一覧: 値を返す`, !!pa0 && pa0.values[keys[0]] === 1, pa0 && Object.entries(pa0.values).slice(0, 3))

  // ---------- 日報の CSV ----------
  const csv = await admin.get(`/api/admin/daily-reports-csv?from=${month}-01&to=${monthEnd}`)
  const rows = csv.status === 200 ? parseCsv(csv.text).filter(r => r.length > 1) : []
  const hi = rows.findIndex(r => r[0] === '稼働日')
  const header = rows[hi] || []
  const body = rows.slice(hi + 1)
  ok(`${L}: 日報の CSV が 200 で、全項目の列（表示名）がある`, csv.status === 200 && keys.every((_, i) => header.includes(label(i))) && header.includes(`extra${N}`) && body.length === reportCount,
    [csv.status, header.length, body.length, keys.map((_, i) => label(i)).filter(l => !header.includes(l)).slice(0, 3)])
  const colSum = (h) => { const c = header.indexOf(h); return body.reduce((a, r) => a + (Number(r[c]) || 0), 0) }
  ok(`${L}: 日報の CSV: 列ごとの合計が合う`, keys.every((k, i) => colSum(label(i)) === sumOf(k)) && colSum(`extra${N}`) === 7,
    keys.map((k, i) => [k, colSum(label(i)), sumOf(k)]).filter(([, a, b]) => a !== b).slice(0, 3))

  // ---------- 実績分析 ----------
  const an = await admin.get(`/api/admin/analytics?month=${month}&project_id=${PA}`)
  ok(`${L}: 実績分析（案件 A）が 200 で、全項目（extra も）を出す`, an.status === 200 && allKeysA.every(k => an.data.fields.some(f => f.key === k)), [an.status, an.data?.fields?.length, an.data?.error])
  ok(`${L}: 実績分析（案件 A）: 合計が合う`, an.status === 200 && allKeysA.every(k => an.data.totals.values[k] === expected[PA][k]) && an.data.totals.reports === reportCount - 4,
    an.data?.totals && allKeysA.filter(k => an.data.totals.values[k] !== expected[PA][k]).slice(0, 3).map(k => [k, an.data.totals.values[k], expected[PA][k]]))
  ok(`${L}: 実績分析（案件 A）: スタッフ別・日別の合計が全体と合う`, an.status === 200
    && allKeysA.every(k => an.data.by_staff.reduce((a, r) => a + r.values[k], 0) === expected[PA][k] && an.data.daily.reduce((a, r) => a + r.values[k], 0) === expected[PA][k]))
  const s1 = an.data?.by_staff?.find(r => r.staff_id === SIDS[0])
  ok(`${L}: 実績分析（案件 A）: スタッフ1 の値が合う`, s1 && s1.values[keys[N - 1]] === 2 * N + 1000, s1 && s1.values[keys[N - 1]])
  const anAll = await admin.get(`/api/admin/analytics?month=${month}`)
  ok(`${L}: 実績分析（全案件）が 200 で、日報数が合う`, anAll.status === 200 && anAll.data.totals.reports === reportCount, [anAll.status, anAll.data?.totals?.reports])
  for (const by of ['staff', 'project', 'client', 'daily']) {
    const r = await admin.get(`/api/admin/analytics/csv?month=${month}&project_id=${PA}&by=${by}`)
    const rr = r.status === 200 ? parseCsv(r.text).filter(x => x.length > 1) : []
    ok(`${L}: 実績分析の CSV（${by}）が 200 で、全項目の列がある`, r.status === 200 && keys.every((_, i) => rr[0]?.includes(label(i))), [r.status, rr[0]?.length])
  }
  for (const k of [keys[0], keys[N - 1], `extra${N}`]) {
    const se = await admin.get(`/api/admin/analytics/series?project_id=${PA}&from=${month}&to=${month}&unit=day&metric=field&key=${k}&split=staff`)
    ok(`${L}: 実績分析のグラフ（${k}）が 200 で、合計が合う`, se.status === 200 && se.data.metric === 'field' && se.data.key === k && se.data.total_sum === expected[PA][k], [se.status, se.data?.metric, se.data?.key, se.data?.total_sum, expected[PA][k], se.data?.error])
  }

  // ---------- スタッフ・案件の画面 ----------
  for (const [name, path] of [['スタッフの一覧', '/api/admin/staff'], ['スタッフ詳細', `/api/admin/staff/${SIDS[0]}`], ['スキルシート', `/api/admin/staff/${SIDS[0]}/skill-sheet`],
    ['案件の一覧', `/api/admin/projects?month=${month}`], ['案件詳細', `/api/admin/projects/${PA}`], ['案件詳細（月指定）', `/api/admin/projects/${PA}?month=${month}`]]) {
    const r = await admin.get(path)
    ok(`${L}: ${name}が 200`, r.status === 200, [r.status, r.text?.slice(0, 200)])
  }
}
rmSync(SQL_DIR, { recursive: true, force: true })

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
