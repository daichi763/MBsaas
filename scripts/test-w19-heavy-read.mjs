// 重い読み込みを軽くする（Sprint 19・w19-heavy-read）の統合テスト
//   #9937 管理画面の重い集計（ダッシュボード・シフトボード・スタッフ一覧・案件一覧・実績分析）と、スタッフのホーム・申し送りの読み込みで、
//         画面に出る数・金額・並びを変えずに、1回に読む行数と問い合わせの回数を減らす
//         （日報の項目の合計は json_each を全件に使わない。索引は migrations/0101_heavy_read_indexes.sql）
//   #9936 案件の詳細の「開催場所」の説明の文言（開催場所はクライアントごとの一覧で、シフト・募集枠を作るときに選ぶ）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること（追加の起動オプションはない）
// 実行: BASE=http://127.0.0.1:8694 PERSIST=<保存先> node scripts/test-w19-heavy-read.mjs
//   PERSIST に --persist-to の保存先を指定する（形の崩れた日報などをローカルの D1 に直接書き込み、直す前の SQL（json_each）で数えた値と API の値を比べる。テスト用の DB 専用）
//   今日のシフトと日報を足すので、テストのたびに DB を作り直すこと（npm test -- w19-heavy-read なら自動で行う）
// 直す前と直した後の比べ方（任意。性能の計測用のデータで使う）:
//   COMPANY=<会社コード> ADMIN=<管理者のコード> STAFF=<スタッフのコード> で、ログインする会社と人を変えられる（既定は sample / admin / st001。sample 以外ではデータを足さない）
//   SNAP_OUT=<ファイル> で各 API の応答（JSON）を書き出し、SNAP_CMP=<ファイル> で書き出したものと同じかを比べる（今の時刻・経過分・ログインの日時は比べない）
//   サーバーが GET /__perf（D1 の rows read を数える一時的な計測のコード。リポジトリには入れない）を返すときは、API ごとの D1 の回数と rows read を表にする
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8694'
const PERSIST = process.env.PERSIST || ''
const COMPANY = process.env.COMPANY || 'sample'
const ADMIN = process.env.ADMIN || 'admin'
const STAFF = process.env.STAFF || 'st001'
const SAMPLE = COMPANY === 'sample'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body, tag) => {
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
    if (tag) headers['x-perf-tag'] = tag
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p, tag) => call('GET', p, undefined, tag), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const staticJs = async (name) => (await fetch(`${BASE}/static/${name}`)).text()
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
const q = (s) => `'${String(s).replace(/'/g, "''")}'`

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000)
const today = jstNow().toISOString().slice(0, 10)
const month = today.slice(0, 7)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const monday = (d) => { const x = new Date(d + 'T00:00:00Z'); return addDays(d, -((x.getUTCDay() + 6) % 7)) }
const mFrom = month + '-01'
const mTo = (() => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01` })()

// ---------- #9936 開催場所の説明の文言 ----------
{
  const sb = await staticJs('shift-board.js')
  ok('#9936 説明: クライアントごとの開催場所の一覧で、シフト・募集枠を作るときに選ぶ（案件や日ごとに違う場所を選べる）',
    sb.includes('の開催場所の一覧です。シフトや募集枠を作るときに、この中から場所を選びます（案件や日ごとに違う場所を選べます）。'))
  ok('#9936 説明: 名前・住所・位置を変えると、この場所を使うほかの案件にも反映される', sb.includes('同じクライアントのほかの案件とも共通の一覧なので、名前・住所・位置を変えると、この場所を使うほかの案件にも反映されます。'))
  ok('#9936 古い説明（同じクライアントの案件で共通に使います）は残っていない', !sb.includes('同じクライアントの案件で共通に使います'))
}

const admin = client(await login(COMPANY, ADMIN))
const staff = client(await login(COMPANY, STAFF))

// ---------- 準備（sample のときだけ）: 案件・今日のシフト・形の崩れたものを含む日報 ----------
// 日報は D1 に直接入れる（アプリからは入らない形: テンプレートに無いキー・配列・JSON でない文字・" を含むキー・\u で書いたキー・文字の数・小数・null）
let PID = null
if (SAMPLE && PERSIST) {
  const PFX = process.env.PFX || 'W19H' + Date.now().toString(36).slice(-4).toUpperCase()
  const tpl = must(await admin.post('/api/admin/templates', { template_name: `${PFX} テンプレ`, fields: [
    { key: 'seiyaku', label: '成約数', type: 'number' }, { key: 'w19n', label: 'W19件数', type: 'number' }, { key: 'store_share', label: '店舗共有', type: 'textarea' }] }), 'template')
  PID = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, client_id: 1, unit_price_type: 'daily', unit_price: 12000, report_template_id: tpl.template_id }), 'project').project_id
  const ids = Object.fromEntries(d1(`SELECT sp.staff_id, us.user_code FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = 1 AND us.user_code IN ('st001','st002','st003','st004','st005','st006')`)[0].map(r => [r.user_code, r.staff_id]))
  const mk = async (sid) => { const r = await admin.post('/api/admin/shifts', { staff_id: sid, project_id: PID, work_date: today, start_time: '10:00', end_time: '18:00', memo: PFX, force: true }); if (r.status !== 200) throw new Error('shift ' + r.text.slice(0, 200)); return r.data.shift_id }
  const S1 = await mk(ids.st001), S2 = await mk(ids.st002)
  const rv = [
    [ids.st002, S2, JSON.stringify({ seiyaku: 2, w19n: 1.5, store_share: `${PFX} 搬入口は北側です` })],
    [ids.st003, null, JSON.stringify({ seiyaku: '3', w19n: 4, store_share: '   ' })],
    [ids.st004, null, JSON.stringify({ seiyaku: 1, w19zz: 6, store_share: `${PFX} 2つ目` })],
    [ids.st005, null, '[5,6]'],
    [ids.st006, null, 'not json'],
    [ids.st003, null, '{"w19\\"q":2,"seiyaku":1}'],
    [ids.st004, null, '{"w19\\u006e":5,"\\u3042":3,"seiyaku":null}'],
  ]
  for (const [sid, shiftId, v] of rv) {
    d1(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at, entry_method)
      VALUES (1, ${sid}, ${PID}, ${shiftId ?? 'NULL'}, ${q(today)}, ${q(v)}, 0, 0, ${q(today + ' 18:30:00')}, 'app')`)
  }
  ok('準備: 案件・今日のシフト・日報（7件）', d1(`SELECT COUNT(*) AS n FROM daily_reports WHERE project_id = ${PID}`)[0][0].n === rv.length)

  // 直す前の数え方（json_each）。API の値はこれと同じになること
  const legacy = d1(`SELECT dr.project_id, je.key AS k, SUM(CASE WHEN je.type IN ('integer','real') THEN je.value ELSE 0 END) AS v, MAX(je.type IN ('integer','real')) AS isnum
    FROM daily_reports dr JOIN projects p ON p.project_id = dr.project_id AND p.company_id = dr.company_id AND p.status = 'active',
      json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je
    WHERE dr.company_id = 1 AND dr.project_id = ${PID} AND dr.work_date >= ${q(mFrom)} AND dr.work_date < ${q(mTo)} GROUP BY dr.project_id, je.key`)[0]
  const lv = new Map(legacy.map(r => [String(r.k), Number(r.v) || 0]))
  // 実績分析は、配列の日報のキー（数の 0・1）の値を写さない（項目のキーは文字、json_each のキーは数のため。直す前から同じ）
  const lvStr = new Map(legacy.filter(r => typeof r.k === 'string').map(r => [r.k, Number(r.v) || 0]))
  // 数値の項目: テンプレートの数値の項目（seiyaku・w19n）の後ろに、テンプレートに無い数値のキーを json_each の並び（数のキー → 文字のキー）で
  const expectKeys = ['seiyaku', 'w19n', ...legacy.filter(r => r.isnum && !['seiyaku', 'w19n', 'store_share'].includes(String(r.k))).map(r => String(r.k))]
  ok('準備: 直す前の数え方で、テンプレートに無い数値のキー（配列の 0・1、" を含むキー、w19zz、\\u で書いたキー）がある', ['0', '1', 'w19"q', 'w19zz', 'あ'].every(k => expectKeys.includes(k)), expectKeys)
  ok('準備: 直す前の数え方の値（成約 2+1+1、文字の "3" と null は 0。w19n 1.5+4+5）', lv.get('seiyaku') === 4 && lv.get('w19n') === 10.5, legacy)

  // ダッシュボード（案件で絞る）
  {
    const d = must(await admin.get(`/api/admin/dashboard?project_id=${PID}`), 'dashboard')
    const pp = (d.project_performance || []).find(p => p.project_id === PID)
    ok('#9937 ダッシュボード: 今月の案件別実績の日報の数', pp && pp.report_count === rv.length, pp)
    ok('#9937 ダッシュボード: 項目の数と並びが直す前の数え方と同じ', d.performance_field_count === expectKeys.length && d.performance_fields.map(f => String(f.key)).join('|') === expectKeys.slice(0, d.performance_fields.length).join('|'),
      { got: d.performance_fields, count: d.performance_field_count, expectKeys })
    ok('#9937 ダッシュボード: 項目の合計が直す前の数え方と同じ（テンプレートに無いキー・形の崩れた日報を含む）', pp && expectKeys.every(k => Number(pp.values[k] || 0) === (lv.get(k) || 0)), { values: pp?.values, legacy })
  }
  // 実績分析（案件）
  {
    const a = must(await admin.get(`/api/admin/analytics?project_id=${PID}`), 'analytics')
    ok('#9937 実績分析: 日報数・稼働人数', a.totals.reports === rv.length && a.totals.staff_count === 5, a.totals)
    ok('#9937 実績分析: 項目の合計が直す前の数え方と同じ', a.fields.length > 0 && a.fields.every(f => Number(a.totals.values[f.key] || 0) === (lvStr.get(String(f.key)) || 0)), { fields: a.fields, totals: a.totals.values })
    ok('#9937 実績分析: テンプレートに無い数値のキーも項目に出す（今までと同じ）', ['w19zz', 'w19"q', 'あ'].every(k => a.fields.some(f => String(f.key) === k)), a.fields)
    const legacyStaff = d1(`SELECT dr.staff_id AS g, je.key AS k, SUM(CASE WHEN je.type IN ('integer','real') THEN je.value ELSE 0 END) AS v
      FROM daily_reports dr, json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je
      WHERE dr.company_id = 1 AND dr.project_id = ${PID} AND dr.work_date >= ${q(mFrom)} AND dr.work_date < ${q(mTo)} GROUP BY g, je.key`)[0]
    ok('#9937 実績分析: スタッフ別の合計が直す前の数え方と同じ', a.by_staff.length === 5 && a.by_staff.every(s => a.fields.every(f => Number(s.values[f.key] || 0) === Number(legacyStaff.find(r => r.g === s.staff_id && typeof r.k === 'string' && r.k === String(f.key))?.v || 0))), a.by_staff)
    ok('#9937 実績分析: 日別の合計が直す前の数え方と同じ', a.daily.length === 1 && a.daily[0].work_date === today && a.fields.every(f => Number(a.daily[0].values[f.key] || 0) === (lvStr.get(String(f.key)) || 0)), a.daily)
    const all = must(await admin.get('/api/admin/analytics'), 'analytics all')
    const mine = all.by_project.find(p => p.project_id === PID)
    ok('#9937 実績分析（全案件）: 案件別の日報数・案件名・クライアント名', mine && mine.reports === rv.length && mine.staff_count === 5 && /W19H/.test(mine.project_name) && mine.client_name != null, mine)
    const st = all.by_staff.find(s => s.staff_id === ids.st003)
    ok('#9937 実績分析（全案件）: スタッフ別の名前と日報数', st && st.reports >= 2 && typeof st.name === 'string' && st.name.length > 0, st)
  }
  // 成約（スタッフ一覧の「今月成約」・案件一覧の「成約」）
  {
    const legacySei = d1(`SELECT dr.staff_id AS g, SUM((SELECT SUM(CASE WHEN je.type IN ('integer','real') THEN je.value ELSE 0 END)
        FROM json_each(CASE WHEN json_valid(dr.report_values) THEN dr.report_values ELSE '{}' END) je WHERE je.key = 'seiyaku')) AS v
      FROM daily_reports dr WHERE dr.project_id = ${PID} AND dr.work_date >= ${q(mFrom)} AND dr.work_date < ${q(mTo)} GROUP BY dr.staff_id`)[0]
    const sl = must(await admin.get('/api/admin/staff'), 'staff list').staff
    ok('#9937 スタッフ一覧: 今月成約が直す前の数え方と同じ', legacySei.length === 5 && legacySei.every(r => sl.find(s => s.staff_id === r.g)?.month_seiyaku === (Number(r.v) || 0)), { legacySei, got: sl.filter(s => legacySei.some(r => r.g === s.staff_id)).map(s => [s.staff_id, s.month_seiyaku]) })
    ok('#9937 スタッフ一覧: 今日のシフトがある人の本日の入店（未報告は 0）', sl.find(s => s.staff_id === ids.st001)?.today_shift === 1 && sl.find(s => s.staff_id === ids.st001)?.today_checkin === 0)
    const pl = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_id === PID)
    ok('#9937 案件一覧: 成約・稼働人数・シフト数', pl && pl.month_seiyaku === 4 && pl.staff_count === 2 && pl.month_shifts === 2 && pl.incidents === 0, pl)
  }
  // 申し送り（st001 の今日のシフト。ほかの人の日報の store_share）
  {
    const h = must(await staff.get(`/api/staff/handover/${S1}`), 'handover')
    ok('#9937 申し送り: 共有する項目に文字が書かれた日報だけ（空白だけ・形の崩れた日報は出さない）', h.notes.length === 2 && h.notes.every(n => n.values.store_share.startsWith(PFX)), h)
    const home = must(await staff.get('/api/staff/home'), 'home')
    ok('#9937 スタッフのホーム: 今日のシフトと報告の設定', home.shift?.shift_id === S1 && Array.isArray(home.required_attendance) && home.today_shifts.some(s => s.shift_id === S1), home.shift)
  }
}

// ---------- 各 API（形の確認。SNAP_OUT・SNAP_CMP・/__perf のときは応答と rows read も） ----------
const perfOn = await (async () => { try { const r = await rawFetch(`${BASE}/__perf`); return r.ok && Array.isArray(await r.json()) } catch { return false } })()
async function perfOf(tag) {
  if (!perfOn) return null
  for (let i = 0; i < 20; i++) {
    const list = await (await rawFetch(`${BASE}/__perf?detail=1`)).json()
    const r = list.filter(x => x.tag === tag)
    // calls: D1 を呼んだ回数（db.batch は1回）。queries: 文の数（batch の中の文も数える）
    if (r.length) return { calls: r.reduce((a, x) => a + x.batches + x.detail.filter(d => d.via !== 'batch').length, 0), queries: r.reduce((a, x) => a + x.queries, 0), rows_read: r.reduce((a, x) => a + x.rows_read, 0) }
    await new Promise(res => setTimeout(res, 200))
  }
  return null
}
const snap = {}
const table = []
let seq = 0
async function load(who, name, path) {
  const tag = `w19hr-${Date.now().toString(36)}-${seq++}`
  const data = must(await who.get(path, tag), name)
  snap[name] = data
  const p = await perfOf(tag)
  if (p) table.push({ name, ...p })
  return data
}
const wk = monday(today)
const dash = await load(admin, 'GET /api/admin/dashboard', '/api/admin/dashboard')
ok('ダッシュボード: 今日のシフト・未報告・ToDo・今月の案件別実績を返す', Array.isArray(dash.shifts) && dash.unreported && Array.isArray(dash.todos) && Array.isArray(dash.project_performance))
const board = await load(admin, 'GET /api/admin/shift-board（週）', `/api/admin/shift-board?from=${wk}&to=${addDays(wk, 6)}`)
ok('シフトボード（週）: 案件・枠・枠なしのシフト・合計を返す', Array.isArray(board.projects) && Array.isArray(board.slots) && Array.isArray(board.unslotted) && typeof board.totals?.bill === 'number')
const board4 = await load(admin, 'GET /api/admin/shift-board（4週）', `/api/admin/shift-board?from=${wk}&to=${addDays(wk, 27)}`)
ok('シフトボード（4週）: 応答を返す', Array.isArray(board4.slots))
const staffList = await load(admin, 'GET /api/admin/staff', '/api/admin/staff')
ok('スタッフ一覧: スタッフを返す', Array.isArray(staffList.staff) && staffList.staff.length > 0)
const projects = await load(admin, 'GET /api/admin/projects', '/api/admin/projects')
ok('案件一覧: 案件を返す', Array.isArray(projects.projects) && projects.projects.length > 0)
const analytics = await load(admin, 'GET /api/admin/analytics', '/api/admin/analytics')
ok('実績分析（全案件）: 合計・日別・スタッフ別・案件別を返す', analytics.totals && Array.isArray(analytics.daily) && Array.isArray(analytics.by_staff) && Array.isArray(analytics.by_project))
const pid = PID || (analytics.projects || []).find(p => p.status === 'active')?.project_id
if (pid) {
  const ap = await load(admin, 'GET /api/admin/analytics?project_id', `/api/admin/analytics?project_id=${pid}`)
  ok('実績分析（案件）: 項目の列を返す', Array.isArray(ap.fields) && ap.project?.project_id === pid)
}
const home = await load(staff, 'GET /api/staff/home', '/api/staff/home')
ok('スタッフのホーム: 今日のシフト・お知らせ・報告漏れ・次回の稼働を返す', Array.isArray(home.today_shifts) && Array.isArray(home.notices) && home.missed_reports && Array.isArray(home.next_shifts))
const hoId = home.shift?.shift_id || home.today_shifts?.[0]?.shift_id
if (hoId) {
  const ho = await load(staff, 'GET /api/staff/handover/:id', `/api/staff/handover/${hoId}`)
  ok('申し送り: 項目と申し送りを返す', Array.isArray(ho.fields) && Array.isArray(ho.notes))
}

// ---------- 直す前と直した後の比べ ----------
const SNAP_OUT = process.env.SNAP_OUT, SNAP_CMP = process.env.SNAP_CMP
if (SNAP_OUT) { writeFileSync(SNAP_OUT, JSON.stringify(snap, null, 1)); console.log(`応答を書き出しました: ${SNAP_OUT}`) }
// 時刻で変わる値（今の時刻・経過分・ログインした日時・作った日時）と、作るたびに変わる値（連携用ID の採番）は比べない
const VOLATILE = new Set(['now', 'overdue_minutes', 'last_login_at', 'app_last_used_at', 'last_seen_at', 'created_at', 'updated_at', 'global_staff_code'])
const stable = (v) => JSON.stringify(v, (k, x) => (VOLATILE.has(k) ? undefined : x))
if (SNAP_CMP && existsSync(SNAP_CMP)) {
  const before = JSON.parse(readFileSync(SNAP_CMP, 'utf8'))
  for (const k of Object.keys(snap)) {
    const a = stable(before[k]), b = stable(snap[k])
    let at = 0; if (a !== b) { while (at < Math.min(a?.length || 0, b.length) && a[at] === b[at]) at++ }
    ok(`直す前と同じ応答: ${k}`, a === b, a === b ? undefined : { at, before: a?.slice(Math.max(0, at - 120), at + 200), after: b.slice(Math.max(0, at - 120), at + 200) })
  }
}
if (table.length) {
  console.log('\n| API | D1 を呼んだ回数（batch は1回） | 文の数 | rows read |\n|---|---|---|---|')
  for (const r of table) console.log(`| ${r.name} | ${r.calls} | ${r.queries} | ${r.rows_read.toLocaleString()} |`)
  if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(table, null, 1))
}

const fail = results.filter(r => !r.pass)
console.log(`\n${results.length - fail.length}/${results.length} passed`)
process.exit(fail.length ? 1 : 0)
