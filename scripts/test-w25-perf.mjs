// 性能の直し（作業単位 w25-perf: #9970）の統合テスト
//  (1) 日報一覧 GET /api/admin/daily-reports: 今月より前の月の件数を控え（daily_report_month_counts。migrations/0108）から足すので、
//      2回目からは過去の日報の量で読み取りの行が増えない。件数・総数・並び順・スタッフの選択肢は、日報の表から数えた値（SQL）と同じ。
//      確認・未確認に戻す・対応状況・代理入力（出し直し）で、その月の件数が直る。SQL で直接変えた行も、古くなった控えは数え直す
//  (2) アプリを開く（API を同時に何本も）: セッションの延長・最終アクセスの書き込みは、先に書いた要求があれば書かない（期限・最終アクセスは今までどおり）
//  (3) ログイン: 回数の多いパスワードのハッシュ（seed の 100000 回）は、ログインの成功で今の回数（10000 回）に作り直す（CPU を減らす）
//  (4) 打刻: 読み書きの行数を出す（索引の行が大半で、索引を消さないと減らせない。記録は今までどおり）
// 読み書きの行数は応答のヘッダー X-Test-D1-Rows（「読み取り/書き込み」。TEST_HOOKS のときだけ付く。src/lib/d1-retry.ts の d1RowsHook）で数える
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --var TEST_HOOKS:true --port 9021 --persist-to <保存先>` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9021 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w25-perf.mjs
//   本番には接続しない
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE || 'http://127.0.0.1:9021'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 700) : ''}`) }
const info = (name, v) => console.log(`INFO  ${name}: ${JSON.stringify(v)}`)

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w25pf-'))
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
async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], ...rowsOf(r.headers.get('x-test-d1-rows')) }
}
async function login(company_code, user_code) {
  const r = await rawLogin(company_code, user_code)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body, form) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, ...(form ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data, ...rowsOf(r.headers.get('x-test-d1-rows')), expires: r.headers.get('x-session-expires') }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), form: (p, f) => call('POST', p, f, true) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`); return r.data }
const jst = (ms = Date.now()) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jst().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7) }

const PFX = 'W25P' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function createShift(staff_id, project_id, work_date, start_time = '00:00', end_time = '23:59') {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}
const P1 = await newProject(`${PFX}-案件1`), P2 = await newProject(`${PFX}-案件2`)
const A = await newStaff('A'), B = await newStaff('B')

// ---------- (1) 日報一覧の件数 ----------
const U = 'COALESCE(manager_checked, 0) = 0', F = '(incident_flag = 1 OR complaint_flag = 1)', O = `(incident_flag = 1 OR complaint_flag = 1) AND COALESCE(incident_status, 'open') != 'done'`
// 過去の日報を SQL で入れる（稼働日は today から days 日前。状態は i で決める）。控えは SQL では直らないので消しておく
async function insertOld(n, minDays, spanDays, seed) {
  await sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, manager_checked, incident_flag, complaint_flag, incident_status, submitted_at)
    WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ${n})
    SELECT 1, CASE WHEN i % 2 = 0 THEN ${A.staff_id} ELSE ${B.staff_id} END, CASE WHEN i % 3 = 0 THEN ${P2} ELSE ${P1} END, NULL,
      date('${today}', '-' || (${minDays} + (i * ${seed}) % ${spanDays}) || ' days'), '{}',
      CASE WHEN i % 7 = 0 THEN 0 ELSE 1 END, CASE WHEN i % 11 = 0 THEN 1 ELSE 0 END, CASE WHEN i % 13 = 0 THEN 1 ELSE 0 END,
      CASE WHEN i % 22 = 0 THEN 'done' WHEN i % 26 = 0 THEN 'in_progress' ELSE NULL END,
      datetime('${today}', '-' || (${minDays} + (i * ${seed}) % ${spanDays}) || ' days', '+' || (i % 700) || ' minutes')
    FROM k; DELETE FROM daily_report_month_counts WHERE company_id = 1`)
}
// 日報の表から数えた件数（これまでの式と同じ）
async function oracle(f = {}) {
  const w = ['company_id = 1']
  if (f.date) w.push(`work_date = '${f.date}'`)
  if (f.from) w.push(`work_date >= '${f.from}'`)
  if (f.to) w.push(`work_date <= '${f.to}'`)
  if (f.project) w.push(`project_id = ${f.project}`)
  if (f.staff) w.push(`staff_id = ${f.staff}`)
  const ex = (f.unchecked ? ` AND ${U}` : '') + (f.flagged ? ` AND ${F}` : '') + (f.open ? ` AND ${O}` : '')
  const [r] = await sql(`SELECT COUNT(*) AS a, COALESCE(SUM(CASE WHEN ${U} THEN 1 ELSE 0 END), 0) AS u, COALESCE(SUM(CASE WHEN ${F} THEN 1 ELSE 0 END), 0) AS f,
    COALESCE(SUM(CASE WHEN ${O} THEN 1 ELSE 0 END), 0) AS o, COALESCE(SUM(CASE WHEN 1${ex} THEN 1 ELSE 0 END), 0) AS t FROM daily_reports WHERE ${w.join(' AND ')}`)
  return { total: r.t, counts: { all: r.a, unchecked: r.u, flagged: r.f, incident_open: r.o } }
}
const qs = (f = {}) => {
  const p = new URLSearchParams({ offset: String(f.offset || 0), limit: String(f.limit || 50) })
  for (const [k, n] of [['date', 'date'], ['from', 'from'], ['to', 'to'], ['project', 'project_id'], ['staff', 'staff_id']]) if (f[k]) p.set(n, String(f[k]))
  if (f.unchecked) p.set('unchecked', '1'); if (f.flagged) p.set('flagged', '1'); if (f.open) p.set('incident_open', '1'); if (f.options) p.set('options', '1')
  return '/api/admin/daily-reports?' + p.toString()
}
const list = async (f) => { const r = await admin.get(qs(f)); return { ...must(r, 'daily-reports'), read: r.read, written: r.written } }
async function sameCounts(name, f) {
  const [api, want] = [await list(f), await oracle(f)]
  ok(`${name}: 件数・総数が日報の表から数えた値と同じ`, api.total === want.total && JSON.stringify(api.counts) === JSON.stringify(want.counts), { api: { total: api.total, counts: api.counts }, want })
  return api
}
{
  await insertOld(1500, 35, 330, 7)
  // 今月の日報も少し入れる（今月は控えを作らず、日報の表から数える）
  await sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, manager_checked, incident_flag, submitted_at)
    VALUES (1, ${A.staff_id}, ${P1}, '${today}', '{}', 0, 1, '${today} 09:00:00'), (1, ${B.staff_id}, ${P2}, '${today}', '{}', 1, 0, '${today} 10:00:00')`)
  const first = await sameCounts('既定（はじめて開く。控えを作る）', { options: true })
  const second = await sameCounts('既定（2回目。控えから足す）', { options: true })
  info('日報一覧（options=1）の読み取り・書き込み 1回目→2回目', { first: [first.read, first.written], second: [second.read, second.written] })
  ok('2回目は書き込みが無く、過去の日報（1500件）をすべては読まない', second.written === 0 && second.read < 1500, { read: second.read, written: second.written })
  // 並び順は今までどおり（稼働日・提出日時・番号の降順）。深いページも同じ
  for (const off of [0, 400]) {
    const api = await list({ offset: off, limit: 50 })
    const want = (await sql(`SELECT daily_report_id FROM daily_reports WHERE company_id = 1 ORDER BY work_date DESC, submitted_at DESC, daily_report_id DESC LIMIT 50 OFFSET ${off}`)).map(r => r.daily_report_id)
    ok(`並び順が今までと同じ（offset ${off}）`, JSON.stringify(api.reports.map(r => r.daily_report_id)) === JSON.stringify(want))
  }
  // スタッフの選択肢（日報のあるスタッフ。名前の順）
  const wantStaff = (await sql(`SELECT sp.staff_id FROM staff_profiles sp JOIN users us ON sp.user_id = us.user_id
    WHERE sp.staff_id IN (SELECT DISTINCT staff_id FROM daily_reports WHERE company_id = 1) ORDER BY us.name, sp.staff_id`)).map(r => r.staff_id)
  ok('スタッフの選択肢が今までと同じ（日報のあるスタッフ・名前の順）', JSON.stringify(second.options.staff.map(s => s.staff_id)) === JSON.stringify(wantStaff), { api: second.options.staff.length, want: wantStaff.length })
  // 絞り込みの組み合わせ（月の途中から・途中まで・案件・スタッフ・日付・状態）
  const mid = (n) => addDays(today, -n)
  const cases = [
    ['未確認のみ', { unchecked: 1 }], ['インシデント・クレームのみ', { flagged: 1 }], ['未対応のみ', { open: 1 }],
    ['未確認＋インシデント', { unchecked: 1, flagged: 1 }], ['未確認＋未対応', { unchecked: 1, open: 1 }], ['インシデント＋未対応', { flagged: 1, open: 1 }], ['3つとも', { unchecked: 1, flagged: 1, open: 1 }],
    ['期間（月の途中から途中まで）', { from: mid(200), to: mid(50) }], ['開始日だけ（月の途中）', { from: mid(123) }], ['終了日だけ（月の途中）', { to: mid(77) }],
    ['期間（月の初めから終わりまで）', { from: ymAdd(today.slice(0, 7), -6) + '-01', to: addDays(ymAdd(today.slice(0, 7), -2) + '-01', -1) }],
    ['期間が今月にかかる', { from: mid(45), to: today }], ['期間が同じ月の中', { from: ymAdd(today.slice(0, 7), -3) + '-03', to: ymAdd(today.slice(0, 7), -3) + '-20' }],
    ['案件', { project: P2 }], ['案件＋期間＋未確認', { project: P1, from: mid(250), to: mid(40), unchecked: 1 }], ['スタッフ', { staff: A.staff_id }],
    ['日付1日', { date: mid(35 + 7) }], ['日報の無い期間', { from: '2001-01-01', to: '2001-03-31' }],
  ]
  for (const [name, f] of cases) await sameCounts(name, f)
  // 過去の日報が倍になっても、控えができた後の読み取りの行はほとんど変わらない（月数・件数に比例しない）
  await insertOld(1500, 35, 330, 11)
  await list({ options: true })
  const after = await sameCounts('過去の日報を倍にした後（2回目）', { options: true })
  ok('過去の日報を倍にしても、2回目の読み取りの行はほとんど増えない', after.read <= second.read + 60, { before: second.read, after: after.read })
  info('日報一覧（options=1）の読み取り 3000件の後の2回目', after.read)

  // 状態を変えると、その月の件数が直る
  const old = (await sql(`SELECT daily_report_id, work_date FROM daily_reports WHERE company_id = 1 AND work_date < '${ymAdd(today.slice(0, 7), -1)}-01' AND ${U} ORDER BY daily_report_id LIMIT 1`))[0]
  const chk = must(await admin.post('/api/admin/daily-reports/check', { ids: [old.daily_report_id] }), 'check')
  ok('まとめて確認: 確認できた件数は今までどおり', chk.checked === 1, chk)
  await sameCounts('過去の月の日報を確認した後', { options: true })
  must(await admin.put(`/api/admin/daily-reports/${old.daily_report_id}`, { manager_checked: false }), 'uncheck')
  await sameCounts('未確認に戻した後', { unchecked: 1 })
  const inc = (await sql(`SELECT daily_report_id FROM daily_reports WHERE company_id = 1 AND work_date < '${ymAdd(today.slice(0, 7), -1)}-01' AND ${O} ORDER BY daily_report_id LIMIT 1`))[0]
  must(await admin.put(`/api/admin/daily-reports/${inc.daily_report_id}/incident`, { status: 'done' }), 'incident done')
  await sameCounts('対応済みにした後', { open: 1 })
  // 代理入力（出し直しの経路 saveDailyReport）で過去の月の日報が増える
  const pastDay = addDays(ymAdd(today.slice(0, 7), -2) + '-01', 9)
  // SQL で入れた日報（shift_id なし）と重ならないよう、別の案件にする
  const sid = await createShift(A.staff_id, await newProject(`${PFX}-案件3`), pastDay)
  const px = await admin.post(`/api/admin/shifts/${sid}/proxy-daily-report`, { values: { free: '代理入力' }, incident_flag: true })
  ok('過去の月のシフトに代理入力できる', px.status === 200, px)
  await sameCounts('過去の月に代理入力した後', { options: true })
  await sameCounts('過去の月に代理入力した後（未対応のみ）', { open: 1 })
  // SQL で直接入れた行は、控えが古くなるまで出ない。古くなった控え（前月は1日・それより前は7日）は数え直す
  await sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date, report_values, submitted_at) VALUES (1, ${B.staff_id}, ${P1}, '${addDays(today, -100)}', '{}', '${addDays(today, -100)} 12:00:00');
    UPDATE daily_report_month_counts SET computed_at = '${jst(Date.now() - 8 * 86400e3)}' WHERE company_id = 1 AND project_id = 0`)
  await sameCounts('控えが古くなった後（数え直す）', { options: true })
  const cnt = (await sql(`SELECT COUNT(*) AS n FROM daily_report_month_counts WHERE company_id = 1 AND project_id = 0 AND ym >= '${today.slice(0, 7)}'`))[0].n
  ok('今月以降の控えは作らない（今月の日報の追加・確認で控えを消す書き込みが出ない）', cnt === 0, cnt)
  // 今月の日報の確認では、控えの印を消す書き込みは出ない（確認の1行と、その索引の分だけ）
  const curId = (await sql(`SELECT daily_report_id FROM daily_reports WHERE company_id = 1 AND work_date = '${today}' AND ${U} LIMIT 1`))[0].daily_report_id
  const before = (await sql(`SELECT COUNT(*) AS n FROM daily_report_month_counts WHERE company_id = 1`))[0].n
  must(await admin.post('/api/admin/daily-reports/check', { ids: [curId] }), 'check current')
  ok('今月の日報の確認では、控えは変わらない', (await sql(`SELECT COUNT(*) AS n FROM daily_report_month_counts WHERE company_id = 1`))[0].n === before)
  await sameCounts('今月の日報を確認した後', { options: true })

  // 本部の閲覧中（D1 は読み取り専用で、控えを書けない）でも、件数は日報の表から数えた値と同じ（RV）
  must(await admin.put('/api/admin/hq-access', { allowed: true }), 'hq-access')
  const hqL = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code: '', user_code: 'hq', password: 'pass1234' }) })
  const jar = [(hqL.headers.get('set-cookie') || '').split(';')[0]]
  const vs = await fetch(`${BASE}/api/hq/view-sessions`, { method: 'POST', headers: { Cookie: jar.join('; '), 'Content-Type': 'application/json' }, body: JSON.stringify({ company_id: 1, reason: 'w25-perf の確認', minutes: 15 }) })
  for (const sc of vs.headers.getSetCookie()) if (sc.startsWith('hq_view=')) jar.push(sc.split(';')[0])
  ok('本部の閲覧を始められる', hqL.status === 200 && vs.status === 200 && jar.length === 2, { login: hqL.status, view: vs.status })
  const hq = client(jar.join('; '))
  await sql('DELETE FROM daily_report_month_counts WHERE company_id = 1')
  for (const f of [{}, { unchecked: 1 }, { open: 1 }, { project: P1, from: addDays(today, -250) }]) {
    const [r, want] = [await hq.get(qs(f)), await oracle(f)]
    ok(`本部の閲覧中: 件数・総数が日報の表から数えた値と同じ ${JSON.stringify(f)}`, r.status === 200 && r.data.total === want.total && JSON.stringify(r.data.counts) === JSON.stringify(want.counts), { status: r.status, api: r.data && { total: r.data.total, counts: r.data.counts }, want })
  }
  ok('本部の閲覧中は控えを書かない', (await sql('SELECT COUNT(*) AS n FROM daily_report_month_counts WHERE company_id = 1'))[0].n === 0)
  must(await admin.put('/api/admin/hq-access', { allowed: false }), 'hq-access off')
}

// ---------- (2) アプリを開く（同時に何本も） ----------
{
  const L = await rawLogin('sample', `${PFX}A`)
  info('スタッフのログインの読み取り・書き込み', [L.read, L.written])
  const st = client(L.cookie)
  const OPEN = ['/api/auth/me', '/api/auth/me', '/api/staff/tours', '/api/staff/badges', '/api/staff/me/companies', '/api/staff/home', '/api/staff/emergency-contacts']
  const sum = (rs) => rs.reduce((a, r) => ({ read: a.read + r.read, written: a.written + r.written }), { read: 0, written: 0 })
  // 最終アクセスから1時間・セッションの延長から10分を過ぎた状態にする
  const stale = new Date(Date.now() + 3600e3).toISOString()
  await sql(`UPDATE users SET last_seen_at = '${jst(Date.now() - 2 * 3600e3)}' WHERE user_id = ${A.user_id}; UPDATE sessions SET expires_at = '${stale}' WHERE user_id = ${A.user_id}`)
  const rs = await Promise.all(OPEN.map(p => st.get(p)))
  const s1 = sum(rs)
  info('アプリを開く（7本を同時に）の読み取り・書き込み', s1)
  ok('アプリを開く: すべて 200', rs.every(r => r.status === 200), rs.map(r => r.status))
  ok('アプリを開く: 延長と最終アクセスの書き込みは1回ずつだけ（書き込み 3 行以下）', s1.written <= 3, s1)
  const [sess] = await sql(`SELECT expires_at FROM sessions WHERE user_id = ${A.user_id} ORDER BY rowid DESC LIMIT 1`)
  const [usr] = await sql(`SELECT last_seen_at FROM users WHERE user_id = ${A.user_id}`)
  ok('セッションの期限は今までどおり延びる（スタッフは今から72時間）', Math.abs(Date.parse(sess.expires_at) - (Date.now() + 72 * 3600e3)) < 5 * 60e3, sess)
  ok('最終アクセスは今までどおり更新される', usr.last_seen_at > jst(Date.now() - 5 * 60e3), usr)
  const exps = rs.map(r => r.expires).filter(Boolean)
  ok('どの応答の X-Session-Expires も延ばした後の期限', exps.length === rs.length && exps.every(e => e === sess.expires_at), { exps, db: sess.expires_at })
  const s2 = sum(await Promise.all(OPEN.map(p => st.get(p))))
  ok('続けて開いたときは書き込まない', s2.written === 0, s2)

  // ---------- (4) 打刻の読み書きの行数（記録は今までどおり） ----------
  const sid = await createShift(A.staff_id, P1, today)
  const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), ch => ch.charCodeAt(0))
  const rows = {}
  for (const t of ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out']) {
    const key = 'k' + Math.random().toString(36).slice(2)
    let r
    if (t === 'check_in' || t === 'check_out') {
      const f = new FormData(); f.append('shift_id', String(sid)); f.append('report_type', t); f.append('latitude', '35.68'); f.append('longitude', '139.76')
      f.append('photo', new Blob([PNG], { type: 'image/png' }), 'a.png'); f.append('client_request_id', key); f.append('pressed_at', String(Date.now())); f.append('device_now', String(Date.now()))
      r = await st.form('/api/staff/attendance-photo', f)
    } else r = await st.post('/api/staff/attendance', { shift_id: sid, report_type: t, latitude: 35.68, longitude: 139.76, client_request_id: key, pressed_at: Date.now(), device_now: Date.now() })
    rows[t] = [r.status, r.read, r.written]
  }
  info('打刻 8 種類の [状態, 読み取り, 書き込み]', rows)
  ok('打刻 8 種類がすべて記録される', Object.values(rows).every(r => r[0] === 200), rows)
  const [sh] = await sql(`SELECT actual_start, actual_end, actual_break_minutes FROM shifts WHERE shift_id = ${sid}`)
  ok('実績（実働時間）は今までどおり打刻から入る', !!sh.actual_start && !!sh.actual_end && sh.actual_break_minutes != null, sh)
}

// ---------- (3) ログイン: 回数の多いハッシュを今の回数に作り直す ----------
{
  const u = (await sql(`SELECT user_id, user_code FROM users WHERE company_id = 1 AND role = 'staff' AND status = 'active' AND password_hash LIKE 'pbkdf2$100000$%' ORDER BY user_id LIMIT 1`))[0]
  if (!u) ok('seed のハッシュ（100000 回）のスタッフがいる', false)
  else {
    const r1 = await rawLogin('sample', u.user_code)
    const [h] = await sql(`SELECT password_hash FROM users WHERE user_id = ${u.user_id}`)
    ok('100000 回のハッシュは、ログインの成功で 10000 回に作り直す', r1.status === 200 && h.password_hash.startsWith('pbkdf2$10000$'), { status: r1.status, h: h.password_hash.slice(0, 20) })
    ok('作り直した後も同じパスワードでログインできる', (await rawLogin('sample', u.user_code)).status === 200)
    ok('違うパスワードは今までどおり通らない', (await rawLogin('sample', u.user_code, 'wrongpass1')).status === 401)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
