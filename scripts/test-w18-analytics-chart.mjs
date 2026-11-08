// w18-analytics-chart（利用者の要望 Sprint 18。#9916）の統合テスト
//  実績分析のグラフ（GET /api/admin/analytics/series）: 期間（開始月〜終了月。12か月まで）・まとめ方（日・週〈月曜はじまり〉・月）・
//  分け方（案件のときはスタッフ別・開催場所別、全案件のときは案件別）。分けた合計が全体と合うこと・他社のデータが混ざらないこと
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8871 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（期待する値を SQL で数え、他社の日報をローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8871 PERSIST=<保存先> node scripts/test-w18-analytics-chart.mjs
//   画面の確認は、ヘッドレスの Chrome がある環境だけで行う（CHROME=<chrome.exe のパス>。無ければ省く）。SHOT_DIR=<フォルダ> で画面の写しを残す
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8871'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
// d1() で数秒止まる間に、開発サーバーが使い終わった接続を閉じることがある。閉じた接続を使ったとき（ECONNRESET）は1回だけやり直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...a) => {
  try { return await rawFetch(...a) } catch (e) {
    if (e && e.cause && e.cause.code === 'ECONNRESET') return rawFetch(...a)
    throw e
  }
}
const results = []
const ok =(name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
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
const sum = a => a.reduce((x, y) => x + y, 0)
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6
const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString()
const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const i = y * 12 + mo - 1 + n; return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}` }
const nextMonthStart = m => addMonths(m, 1) + '-01'
const daysIn = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()
// 分けた系列と「ほか」の合計が、日付の枠ごとにも全体と合うか
const splitAddsUp = d => d.buckets.every((_, i) => near(sum(d.series.map(s => s.values[i])) + (d.other ? d.other.values[i] : 0), d.total[i]))
  && near(sum(d.series.map(s => s.total)) + (d.other ? d.other.total : 0), d.total_sum)

const admin = client(await login('sample', 'admin'))
const series = p => admin.get('/api/admin/analytics/series?' + qs(p))

// ---------- テスト用のデータ: 成約数の項目があり、日報の多い案件・月 ----------
const [m] = d1(`SELECT dr.project_id, substr(dr.work_date, 1, 7) AS month, COUNT(*) AS n FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id
  JOIN report_templates rt ON rt.template_id = p.report_template_id
  WHERE dr.company_id = 1 AND rt.fields_json LIKE '%"seiyaku"%' GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`)[0]
const PID = m.project_id, MONTH = m.month
const SEIYAKU = `CASE WHEN json_valid(report_values) AND json_type(report_values, '$.seiyaku') IN ('integer','real') THEN json_extract(report_values, '$.seiyaku') ELSE 0 END`
const expSum = (from, to, extra = '') => Number(d1(`SELECT COALESCE(SUM(${SEIYAKU}), 0) AS v FROM daily_reports WHERE company_id = 1 AND project_id = ${PID}
  AND work_date >= '${from}' AND work_date < '${to}' ${extra}`)[0][0].v)
const EXP_MONTH = expSum(MONTH + '-01', nextMonthStart(MONTH))
console.log(`INFO  案件 ${PID}・${MONTH}（日報 ${m.n} 件・成約 ${EXP_MONTH}）`)

// ---------- 日ごと（選んだ月。今までのグラフと同じ） ----------
let DAY
{
  const r = await series({ project_id: PID, month: MONTH, metric: 'field', key: 'seiyaku' })
  DAY = r.data
  ok('日ごと: 月の1日から末日まで並べる（日報のない日も 0）', r.status === 200 && DAY.unit === 'day' && DAY.buckets.length === daysIn(MONTH) && DAY.buckets[0] === MONTH + '-01' && DAY.total.length === DAY.buckets.length, r.data)
  ok('日ごと: 指標は成約数（その案件の日報テンプレートの項目）', DAY.metric === 'field' && DAY.key === 'seiyaku' && DAY.label === '成約数' && DAY.metrics.some(x => x.metric === 'field' && x.key === 'seiyaku') && DAY.metrics.some(x => x.metric === 'reports'))
  ok('日ごと: 合計が日報の成約数の合計と合う', near(DAY.total_sum, EXP_MONTH), [DAY.total_sum, EXP_MONTH])
  const a = await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${PID}`)
  ok('日ごと: 実績分析の表（今までの集計）の合計と合う', near(DAY.total_sum, a.data.totals.values.seiyaku), [DAY.total_sum, a.data.totals.values.seiyaku])
  const d0 = a.data.daily.find(x => x.values.seiyaku > 0)
  ok('日ごと: 日ごとの値が今までの日別の値と同じ', !d0 || near(DAY.total[DAY.buckets.indexOf(d0.work_date)], d0.values.seiyaku), d0)
  const n = await series({ project_id: PID, month: MONTH, metric: 'reports' })
  ok('日報数の指標: 日報の件数と合う', n.status === 200 && n.data.metric === 'reports' && n.data.total_sum === Number(a.data.totals.reports), [n.data.total_sum, a.data.totals.reports])
  const f = await series({ project_id: PID, month: MONTH, metric: 'flagged' })
  ok('インシデント・クレームの指標: 印のある日報の数と合う', f.status === 200 && f.data.metric === 'flagged' && f.data.total_sum === Number(a.data.totals.flagged), [f.data.total_sum, a.data.totals.flagged])
  const fb = await series({ project_id: PID, month: MONTH, metric: 'field', key: 'w18-no-such-key' })
  ok('その期間に無い項目を指定したときは成約数にする', fb.status === 200 && fb.data.key === 'seiyaku', fb.data && fb.data.key)
}

// ---------- 週ごと（月曜はじまり） ----------
{
  const r = await series({ project_id: PID, month: MONTH, unit: 'week', metric: 'field', key: 'seiyaku' })
  const d = r.data
  const mondays = d.buckets.every(b => new Date(b + 'T00:00:00Z').getUTCDay() === 1)
  ok('週ごと: 枠は月曜日（最初の週は月の1日を含む週）', r.status === 200 && mondays && d.buckets[0] <= MONTH + '-01' && new Date(d.buckets[0] + 'T00:00:00Z').getTime() > new Date(MONTH + '-01T00:00:00Z').getTime() - 7 * 864e5, d.buckets)
  // 週の値 = その週（月〜日）の日ごとの値の合計
  const weekOf = day => { const x = new Date(day + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - (x.getUTCDay() + 6) % 7); return x.toISOString().slice(0, 10) }
  const exp = d.buckets.map(w => sum(DAY.buckets.map((b, i) => (weekOf(b) === w ? DAY.total[i] : 0))))
  ok('週ごと: 週の値が日ごとの値の合計と合う（期間の外の日は数えない）', d.total.every((v, i) => near(v, exp[i])) && near(d.total_sum, EXP_MONTH), [d.total, exp])
}

// ---------- 月ごと・月をまたぐ期間 ----------
{
  const from = addMonths(MONTH, -2), to = addMonths(MONTH, 1)
  const r = await series({ project_id: PID, from, to, unit: 'month', metric: 'field', key: 'seiyaku' })
  const d = r.data
  ok('月ごと: 開始月〜終了月の各月を並べる', r.status === 200 && d.from === from && d.to === to && JSON.stringify(d.buckets) === JSON.stringify([from, addMonths(MONTH, -1), MONTH, to]), d.buckets)
  const exp = d.buckets.map(b => expSum(b + '-01', nextMonthStart(b)))
  ok('月ごと: 各月の値が SQL で数えた成約数と合う', d.total.every((v, i) => near(v, exp[i])), [d.total, exp])
  const dd = await series({ project_id: PID, from, to, unit: 'day', metric: 'field', key: 'seiyaku' })
  ok('月をまたぐ期間の日ごと: 枠の数は期間の日数、合計は月ごとと同じ', dd.status === 200 && dd.data.buckets.length === sum(d.buckets.map(daysIn)) && near(dd.data.total_sum, d.total_sum), [dd.data.buckets.length, dd.data.total_sum, d.total_sum])
  const ww = await series({ project_id: PID, from, to, unit: 'week', metric: 'field', key: 'seiyaku' })
  ok('月をまたぐ期間の週ごと: 合計は月ごとと同じ', ww.status === 200 && near(ww.data.total_sum, d.total_sum), [ww.data.total_sum, d.total_sum])
  const sw = await series({ project_id: PID, from: to, to: from, unit: 'month' })
  ok('開始月が終了月より後のときは入れ替える', sw.status === 200 && sw.data.from === from && sw.data.to === to, sw.data && [sw.data.from, sw.data.to])
  const y = await series({ project_id: PID, from: '2025-11', to: '2026-02', unit: 'month' })
  ok('年をまたぐ期間の月ごと', y.status === 200 && JSON.stringify(y.data.buckets) === JSON.stringify(['2025-11', '2025-12', '2026-01', '2026-02']), y.data && y.data.buckets)
}

// ---------- 期間の上限（12か月） ----------
{
  const r12 = await series({ from: addMonths(MONTH, -11), to: MONTH, unit: 'week' })
  ok('期間の上限: 12か月は出せる', r12.status === 200 && r12.data.max_months === 12, r12.data)
  const r13 = await series({ from: addMonths(MONTH, -12), to: MONTH, unit: 'month' })
  ok('期間の上限: 13か月は 400（12か月までと伝える）', r13.status === 400 && /12か月まで/.test(r13.data.error), r13.data)
  const r12d = await series({ project_id: PID, from: addMonths(MONTH, -11), to: MONTH, unit: 'day', split: 'staff', metric: 'field', key: 'seiyaku' })
  ok('期間の上限: 12か月の日ごと・スタッフ別も出せて、合計が合う', r12d.status === 200 && r12d.data.buckets.length >= 365 && splitAddsUp(r12d.data), r12d.status)
}

// ---------- 分け方の組み合わせ ----------
{
  const a = await series({ split: 'staff' })
  ok('全案件のときはスタッフ別にできない（400）', a.status === 400, a.data)
  const b = await series({ project_id: PID, split: 'project' })
  ok('案件のときは案件別にできない（400）', b.status === 400, b.data)
  const c = await series({ project_id: PID, split: 'staff' })
  const d = await series({ split: 'project' })
  ok('案件のときは「分けない・スタッフ別・開催場所別」、全案件のときは「分けない・案件別」を返す', c.status === 200 && JSON.stringify(c.data.splits) === '["none","staff","site"]' && d.status === 200 && JSON.stringify(d.data.splits) === '["none","project"]')
  const e = await series({ month: MONTH, metric: 'field', key: 'seiyaku' })
  ok('全案件のときは日報の項目を指標にしない（日報数）', e.status === 200 && e.data.metric === 'reports' && !e.data.metrics.some(x => x.metric === 'field'), e.data && e.data.metrics)
}

// ---------- スタッフ別 ----------
{
  const from = addMonths(MONTH, -1)
  const r = await series({ project_id: PID, from, to: MONTH, unit: 'week', split: 'staff', top: 3, metric: 'field', key: 'seiyaku' })
  const d = r.data
  ok('スタッフ別: 上位3人まで（合計の多い順）', r.status === 200 && d.series.length <= 3 && d.series.every((s, i, arr) => i === 0 || arr[i - 1].total >= s.total), d.series && d.series.map(s => [s.label, s.total]))
  ok('スタッフ別: 分けた合計と「ほか」の合計が全体と合う（週ごとにも）', splitAddsUp(d))
  const exp = d1(`SELECT staff_id, SUM(${SEIYAKU}) AS v FROM daily_reports WHERE company_id = 1 AND project_id = ${PID}
    AND work_date >= '${from}-01' AND work_date < '${nextMonthStart(MONTH)}' GROUP BY staff_id ORDER BY v DESC`)[0]
  ok('スタッフ別: 各人の合計が SQL で数えた値と合う', d.series.every(s => near(s.total, (exp.find(x => x.staff_id === s.id) || {}).v)), [d.series.map(s => [s.id, s.total]), exp.slice(0, 4)])
  ok('スタッフ別: 名前を出す', d.series.every(s => s.label && s.label !== '（名前なし）'), d.series.map(s => s.label))
  ok('スタッフ別: 選べる人の一覧（期間に日報のある人）を返す', d.choices.length === exp.length, [d.choices.length, exp.length])
  // 選んだ人で比べる（期間に日報のある人だけ。ほかは「ほか」）
  const pick = exp.slice(-2).map(x => x.staff_id)
  const p = await series({ project_id: PID, from, to: MONTH, unit: 'week', split: 'staff', ids: [...pick, 999999].join(','), metric: 'field', key: 'seiyaku' })
  ok('スタッフ別: 選んだ人だけを出す（日報のない人・存在しない人は出さない）', p.status === 200 && JSON.stringify(p.data.series.map(s => s.id).sort()) === JSON.stringify([...pick].sort()) && splitAddsUp(p.data), p.data && p.data.series.map(s => s.id))
  const big = await series({ project_id: PID, month: MONTH, split: 'staff', top: 50 })
  ok('スタッフ別: 件数は8まで（それより多い指定は既定の5）', big.status === 200 && big.data.top === 5 && big.data.series.length <= 5)
}

// ---------- 開催場所別 ----------
{
  // 開催場所を2つ作り、その月の日報のシフトに付ける（一部は付けない → 「（開催場所なし）」）。
  // 1件は他社の開催場所の ID を付ける（他社の開催場所の名前は出さず、「（開催場所なし）」に数える）
  const tag = Date.now().toString(36).slice(-5)
  const [{ cl }] = d1(`SELECT client_id AS cl FROM projects WHERE project_id = ${PID}`)[0]
  d1(`INSERT INTO sites (company_id, client_id, site_name) VALUES (1, ${cl ?? 'NULL'}, 'w18会場A${tag}'), (1, ${cl ?? 'NULL'}, 'w18会場B${tag}'), (2, NULL, 'w18他社会場${tag}')`)
  const sites = d1(`SELECT site_id, site_name FROM sites WHERE site_name LIKE 'w18%${tag}' ORDER BY site_id`)[0]
  const shiftIds = d1(`SELECT shift_id FROM daily_reports WHERE company_id = 1 AND project_id = ${PID} AND shift_id IS NOT NULL
    AND work_date >= '${MONTH}-01' AND work_date < '${nextMonthStart(MONTH)}' ORDER BY daily_report_id`)[0].map(x => x.shift_id)
  const part = (from, to) => shiftIds.slice(from, to).join(',') || '0'
  d1(`UPDATE shifts SET site_id = ${sites[0].site_id} WHERE shift_id IN (${part(0, 6)})`)
  d1(`UPDATE shifts SET site_id = ${sites[1].site_id} WHERE shift_id IN (${part(6, 9)})`)
  d1(`UPDATE shifts SET site_id = ${sites[2].site_id} WHERE shift_id IN (${part(9, 10)})`)
  const r = await series({ project_id: PID, month: MONTH, split: 'site', top: 8, metric: 'reports' })
  const d = r.data
  ok('開催場所別: 分けた合計と「ほか」の合計が全体と合う', r.status === 200 && splitAddsUp(d), d)
  const exp = d1(`SELECT COALESCE(si.site_id, 0) AS s, MAX(si.site_name) AS name, COUNT(*) AS v FROM daily_reports dr
    LEFT JOIN shifts sh ON sh.shift_id = dr.shift_id AND sh.company_id = dr.company_id LEFT JOIN sites si ON si.site_id = sh.site_id AND si.company_id = dr.company_id
    WHERE dr.company_id = 1 AND dr.project_id = ${PID} AND dr.work_date >= '${MONTH}-01' AND dr.work_date < '${nextMonthStart(MONTH)}' GROUP BY 1`)[0]
  ok('開催場所別: 開催場所ごとの日報数が SQL で数えた値と合う（シフトの開催場所。無いものは「（開催場所なし）」）',
    d.choices.length === exp.length && d.choices.every(ch => { const x = exp.find(e => e.s === ch.id); return x && x.v === ch.total && ch.label === (x.name || '（開催場所なし）') }), [d.choices, exp])
  console.log(`INFO  開催場所: ${exp.map(x => `${x.name || 'なし'}=${x.v}`).join(', ')}`)
  const byName = n => d.choices.find(ch => ch.label === n)
  ok('開催場所別: 付けた開催場所ごとに数える（会場A 6件・会場B 3件・残りは開催場所なし）', shiftIds.length >= 10 && byName(`w18会場A${tag}`)?.total === 6 && byName(`w18会場B${tag}`)?.total === 3
    && byName('（開催場所なし）')?.total === shiftIds.length - 9 + (d.total_sum - shiftIds.length), d.choices)
  ok('開催場所別: 他社の開催場所の名前は出さない', !JSON.stringify(d).includes('w18他社会場'))
}

// ---------- 全案件・案件別 ----------
{
  const from = addMonths(MONTH, -1)
  const r = await series({ from, to: MONTH, unit: 'month', split: 'project', top: 3 })
  const d = r.data
  const [{ n }] = d1(`SELECT COUNT(*) AS n FROM daily_reports WHERE company_id = 1 AND work_date >= '${from}-01' AND work_date < '${nextMonthStart(MONTH)}'`)[0]
  ok('全案件: 日報数の合計が自社の日報の件数と合う', r.status === 200 && d.total_sum === n, [d.total_sum, n])
  ok('案件別: 分けた合計と「ほか」の合計が全体と合う', splitAddsUp(d) && d.series.length <= 3)
  ok('案件別: 案件名を出す', d.series.every(s => s.label && s.label !== '（案件名なし）'), d.series.map(s => s.label))
}

// ---------- 他社のデータが混ざらない ----------
{
  const tag = Date.now().toString(36).slice(-5)
  const hq = client(await login('sample', 'hq'))
  const codeB = 'ac' + tag, pwB = 'Ac-Passw0rd-' + tag
  const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `グラフ確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
  ok('（前提）B 社を作る', cr.status === 200, cr.data)
  const [{ cid }] = d1(`SELECT company_id AS cid FROM companies WHERE company_code = '${codeB}'`)[0]
  const [{ sid }] = d1(`SELECT staff_id AS sid FROM daily_reports WHERE project_id = ${PID} LIMIT 1`)[0]
  // B 社の日報（A 社の案件の ID・同じ月に、大きな成約数）。案件で絞っても会社で絞るので混ざらない
  d1(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, incident_flag) VALUES (${cid}, ${sid}, ${PID}, '${MONTH}-02', '{"seiyaku": 100000}', 1)`)
  const r = await series({ project_id: PID, month: MONTH, metric: 'field', key: 'seiyaku', split: 'staff' })
  ok('他社: 他社の日報は案件の集計に入らない', r.status === 200 && near(r.data.total_sum, EXP_MONTH) && splitAddsUp(r.data), r.data && r.data.total_sum)
  const all = await series({ month: MONTH, split: 'project', metric: 'flagged' })
  const [{ f }] = d1(`SELECT SUM(CASE WHEN incident_flag = 1 OR complaint_flag = 1 THEN 1 ELSE 0 END) AS f FROM daily_reports WHERE company_id = 1 AND work_date >= '${MONTH}-01' AND work_date < '${nextMonthStart(MONTH)}'`)[0]
  ok('他社: 全案件の集計にも入らない', all.status === 200 && all.data.total_sum === f, [all.data && all.data.total_sum, f])
  const adminB = client(await login(codeB, 'adminb', pwB))
  const rb = await adminB.get('/api/admin/analytics/series?' + qs({ project_id: PID, month: MONTH }))
  ok('他社: 他社の案件は選べない（404）', rb.status === 404, rb.data)
  const rb2 = await adminB.get('/api/admin/analytics/series?' + qs({ month: MONTH, split: 'project' }))
  const [{ pname }] = d1(`SELECT project_name AS pname FROM projects WHERE project_id = ${PID}`)[0]
  ok('他社: B 社には B 社の日報だけ（A 社の案件名は出さない）', rb2.status === 200 && rb2.data.total_sum === 1 && !rb2.text.includes(pname), rb2.data)
  d1(`DELETE FROM daily_reports WHERE company_id = ${cid}`)
}

// ---------- 画面のスクリプト ----------
{
  const js = await (await fetch(`${BASE}/static/admin.js`)).text()
  ok('画面: グラフは /api/admin/analytics/series で描く', js.includes('/api/admin/analytics/series') && js.includes('data-chart="${name}"'))
  ok('画面: グラフの設定を onchange・onclick の文字列に埋め込まない', !/on(change|click)="[^"]*(ACHART|AnalyticsChart)/.test(js))
}

// ---------- 画面（ヘッドレスの Chrome） ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = 9300 + Math.floor(Math.random() * 400)
  const prof = mkdtempSync(join(tmpdir(), 'w18ac-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let list
    for (let i = 0; i < 60 && !list; i++) { await wait(300); list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const page = list && list.find(t => t.type === 'page')
    if (!page) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); const errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w18-analytics-chart-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    // 設定を変えて、グラフが描き直されるのを待つ（Chart.js の図が新しくなり、読み込み中でない）
    const change = async (name, value) => {
      await ev(`window.__oldChart = ACHART.chart; (() => { const s = document.querySelector('#analytics-chart-card [data-chart="${name}"]'); s.value = ${JSON.stringify(String(value))}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
      return until(`!!ACHART.chart && ACHART.chart !== window.__oldChart && !!document.querySelector('#analytics-chart-card [data-chart]')`, 15000)
    }
    const chartInfo = `(() => { const c = ACHART.chart; return { type: c.config.type, axis: c.options.indexAxis || 'x', sets: c.data.datasets.length, labels: c.data.labels.length, legend: c.options.plugins.legend.display, stacked: !!(c.options.scales.y && c.options.scales.y.stacked), title: document.querySelector('#analytics-chart-card h3').innerText } })()`
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    const ck = await login('sample', 'admin')
    const [n, ...v] = ck.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE })
    // 案内（はじめての案内・はじめにやること）は済んだことにしておく（src/tours.ts）
    await admin.put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist'].map(key => ({ key, status: 'skipped', step: 0 })) })
    await send('Page.navigate', { url: `${BASE}/admin#analytics/${PID}` })
    await until(`typeof ACHART !== 'undefined' && !!ACHART.chart && !!document.querySelector('#analytics-chart-card [data-chart="range"]')`, 40000)
    // 上の月を、日報のある月にする
    await ev(`renderAnalytics(${JSON.stringify(MONTH)}, ${JSON.stringify(String(PID))})`)
    await until(`!!ACHART.chart && !!ACHART.data && ACHART.data.from === ${JSON.stringify(MONTH)}`, 15000)
    let c = await ev(chartInfo)
    ok('画面: はじめは選んだ月の日ごとの棒グラフ（成約数）', c.type === 'bar' && c.labels === daysIn(MONTH) && c.sets === 1 && /成約数/.test(c.title), c)
    ok('画面: 今までのランキング・表はグラフの下に残る', await ev(`(() => { const g = document.getElementById('analytics-chart-card'); const t = document.querySelector('.tbl'); return !!t && !!(g.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) && /スタッフ別/.test(document.getElementById('app').innerText) })()`))
    await shot('day')
    // ランキングの並べ替え（グラフの設定は同じ）では、グラフを読み込み直さない（RV）
    await ev(`window.__seriesCalls = 0; window.__axGet = window.__axGet || axios.get; axios.get = (u, o) => { if (String(u).includes('/analytics/series')) window.__seriesCalls++; return window.__axGet.call(axios, u, o) }; true`)
    const hasRank = await ev(`document.querySelectorAll('[data-action="rankAnalytics"]').length > 1`)
    ok('（前提）ランキングの並べ替えのボタンがある', hasRank)
    if (hasRank) {
      await ev(`window.__oldChart = ACHART.chart; document.querySelectorAll('[data-action="rankAnalytics"]')[1]?.click()`)
      const redrawn = await until(`!!ACHART.chart && ACHART.chart !== window.__oldChart`, 5000)
      ok('画面: ランキングを並べ替えても、グラフは読み込み直さずに描き直す', redrawn && (await ev(`window.__seriesCalls`)) === 0, await ev(`window.__seriesCalls`))
    }
    ok('画面: 期間を直近3か月・週ごとにすると描き直す', await change('range', '3') && await change('unit', 'week'))
    c = await ev(chartInfo)
    ok('画面: 週ごとの枠の数（3か月分）', c.labels >= 13 && c.labels <= 15, c)
    ok('画面: スタッフ別にすると積み上げ棒で、凡例を出す', await change('split', 'staff') && (c = await ev(chartInfo)) && c.stacked && (c.sets <= 1 || c.legend), c)
    await shot('staff-stack')
    ok('画面: 折れ線に切り替えられる', await change('view', 'line') && (await ev(chartInfo)).type === 'line')
    ok('画面: 合計の横棒に切り替えられる', await change('view', 'hbar') && (c = await ev(chartInfo)) && c.axis === 'y' && c.type === 'bar', c)
    await shot('staff-hbar')
    // 人を選んで比べる
    ok('画面: 対象を「人を選ぶ」にすると、選ぶボタンを出す', await change('staffMode', 'pick') && await ev(`!!document.querySelector('#analytics-chart-card [data-action="pickAnalyticsStaff"]')`))
    await ev(`document.querySelector('#analytics-chart-card [data-action="pickAnalyticsStaff"]').click()`)
    await until(`document.querySelectorAll('.achart-pick').length > 1`, 5000)
    await ev(`window.__oldChart = ACHART.chart; [...document.querySelectorAll('.achart-pick')].slice(-2).forEach(x => { x.checked = true }); document.querySelector('[data-action="savePickAnalyticsStaff"]').click()`)
    await until(`!!ACHART.chart && ACHART.chart !== window.__oldChart`, 15000)
    c = await ev(chartInfo)
    ok('画面: 選んだ2人と「ほか」で描き直す', (await ev(`ACHART.data.ids.length`)) === 2 && c.labels === 3 && (await ev(`document.getElementById('analytics-chart-card').innerText`)).includes('（2人）'), c)
    await change('staffMode', 'top')
    ok('画面: 開催場所別に切り替えられる', await change('split', 'site') && /開催場所別/.test((await ev(chartInfo)).title))
    ok('画面: 月ごと・期間を指定に切り替えられる', await change('unit', 'month') && await change('range', 'custom') && !!(await ev(`!!document.querySelector('#analytics-chart-card [data-chart="from"]')`)))
    ok('画面: 期間を指定（開始月を変える）', await change('from', addMonths(MONTH, -5)) && (await ev(`ACHART.data.buckets.length`)) === 6)
    // 13か月にしようとすると止める（グラフはそのまま）
    await ev(`(() => { const s = document.querySelector('#analytics-chart-card [data-chart="from"]'); s.value = ${JSON.stringify(addMonths(MONTH, -12))}; s.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    await wait(800)
    ok('画面: 12か月を超える期間は選べない（今の期間のまま）', (await ev(`ACHART.data.buckets.length`)) === 6 && (await ev(`ACHART.from`)) === addMonths(MONTH, -5))
    // 全案件に移ると、全案件の分け方（案件別）。案件に戻ると、案件の設定（開催場所別）に戻る
    await ev(`renderAnalytics(undefined, '')`)
    await until(`!!ACHART.data && !ACHART.data.project && !!ACHART.chart`, 15000)
    ok('画面: 全案件では「分けない・案件別」だけを選べ、期間・まとめ方は引き継ぐ', await ev(`[...document.querySelectorAll('#analytics-chart-card [data-chart="split"] option')].map(o => o.value).join() === 'none,project' && ACHART.data.unit === 'month' && ACHART.data.buckets.length === 6`))
    ok('画面: 全案件で案件別にできる', await change('split', 'project') && /案件別/.test((await ev(chartInfo)).title))
    await shot('all-project')
    await ev(`renderAnalytics(undefined, ${JSON.stringify(String(PID))})`)
    await until(`!!ACHART.data && !!ACHART.data.project && !!ACHART.chart`, 15000)
    ok('画面: 案件に戻ると、案件で選んでいた分け方（開催場所別）に戻る', await ev(`document.querySelector('#analytics-chart-card [data-chart="split"]').value === 'site'`))
    // スマホの幅で横にはみ出さない
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await wait(800)
    ok('画面: スマホの幅でもグラフの設定が横にはみ出さない', await ev(`[...document.querySelectorAll('#analytics-chart-card [data-chart]')].every(s => { const r = s.getBoundingClientRect(); return r.right <= document.documentElement.clientWidth + 0.5 && r.left >= 0 })`))
    await shot('mobile')
    await send('Emulation.clearDeviceMetricsOverride')
    ok('画面: スクリプトのエラーがない', errors.length === 0, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
