// w15-report-edit（利用者の決定 Sprint 15。#9707）の統合テスト: 日報の実績を管理者が直す（上書き＋履歴）
//  - 管理者が日報の値を直すと report_values を上書きし、もとの値・直した人・日時・理由を履歴（daily_report_edits）に残す
//  - テンプレートの検証（必須・文字数・数値）を同じように当てる。全角の数字は半角にする。インシデントの内容は変えずに残す
//  - 直した値が日報の一覧・CSV・実績分析・スタッフの過去の日報に使われ、スタッフにアプリ内の通知が届く
//  - スタッフが値を変えて出し直したら再提出の値を正にし（印を外す）、履歴に「再提出」を残す。同じ値の出し直しは印を残す
//  - 開いた後に出し直された・ほかの管理者が直したときは 409。他社の日報・スタッフのログインからは直せない
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8814 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（履歴の行・日報の値をローカルの D1 から直接読む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8814 PERSIST=<保存先> node scripts/test-w15-report-edit.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8814'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
async function login(company_code, user_code, password = 'pass1234') {
  // ローカルの D1 に直接書いた直後は、開発サーバーへの接続がまれに切れるので、1回だけやり直す
  const send = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await send().catch(async () => { await new Promise(res => setTimeout(res, 1000)); return send() })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    const bytes = new Uint8Array(await r.arrayBuffer())
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
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
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = today.slice(0, 7)
const PFX = 'RE' + Date.now().toString(36).slice(-4).toUpperCase()
const tag = PFX.toLowerCase()

const admin = client(await login('sample', 'admin'))

// ---------- 準備: テンプレート（数値の必須・文字数の上限つき）・案件・スタッフ・今日のシフト・日報 ----------
const ta = must(await admin.post('/api/admin/templates', { template_name: 'w15修正' + tag, fields: [
  { key: 'w15sales', label: '販売数', type: 'number', required: true },
  { key: 'w15memo', label: 'ひとこと', type: 'text', maxLength: 10 },
  { key: 'w15talk', label: '声かけ', type: 'number' }] }), 'template A')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, report_template_id: ta.template_id }), 'project')
const PID = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const phone = '080' + String(Date.now() % 100000000).padStart(8, '0')
must(await admin.post('/api/admin/staff', { user_code: `${PFX}A`, name: `${PFX} 修正`, password: 'pass1234', phone, email: `${tag}-a@example.com` }), 'staff')
const A = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}A`)
const staff = client(await login('sample', `${PFX}A`))
const shift = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: PID, work_date: today, start_time: '00:00', end_time: '23:59' }), 'shift')
const submit = (values, extra = {}) => staff.post('/api/staff/daily-report', { shift_id: shift.shift_id, values, ...extra })
must(await submit({ w15sales: 10, w15memo: 'abc', w15talk: 3 }, { incident_flag: true, incident_note: '什器にぶつかった' }), 'submit')
const listOne = async () => must(await admin.get(`/api/admin/daily-reports?project_id=${PID}`), 'list').reports.find(r => r.shift_id === shift.shift_id)
const rep0 = await listOne()
ok('準備: 日報を出せた（修正の印・履歴はまだ無い）', rep0 && !rep0.admin_edited_at && Number(rep0.edit_count) === 0 && rep0.values.w15sales === 10, rep0)
const RID = rep0.daily_report_id

// ---------- 修正の画面（GET /admin/daily-reports/:id/edits） ----------
const e0 = must(await admin.get(`/api/admin/daily-reports/${RID}/edits`), 'edits')
const fSales = e0.fields.find(f => f.key === 'w15sales'), fMemo = e0.fields.find(f => f.key === 'w15memo')
ok('修正の画面: テンプレートの項目を必須・文字数の上限つきで返す（インシデントの内容は出さない）',
  fSales && fSales.required === true && fSales.type === 'number' && fMemo && fMemo.maxLength === 10 && !e0.fields.some(f => /^incident_/.test(f.key)), e0.fields)
ok('修正の画面: 今の値・提出日時と、空の履歴を返す', e0.report.values.w15sales === 10 && e0.report.submitted_at && e0.edits.length === 0, e0.report)

// ---------- 検証（テンプレートの検証を同じように当てる） ----------
const put = (body) => admin.put(`/api/admin/daily-reports/${RID}/values`, body)
{
  const r1 = await put({ values: { w15sales: '' } })
  ok('検証: 必須の項目を空にすると 400', r1.status === 400 && /販売数/.test(r1.data?.error || ''), r1.data)
  const r2 = await put({ values: { w15memo: 'あいうえおかきくけこさ' } })
  ok('検証: 文字数の上限を超えると 400', r2.status === 400 && /10文字/.test(r2.data?.error || ''), r2.data)
  const r3 = await put({ values: { w15sales: '十二' } })
  ok('検証: 数値でない値は 400', r3.status === 400 && /整数/.test(r3.data?.error || ''), r3.data)
  const r4 = await put({ values: { w15sales: 12 }, reason: 'あ'.repeat(501) })
  ok('検証: 理由が500文字を超えると 400', r4.status === 400 && /500文字/.test(r4.data?.error || ''), r4.data)
  const r5 = await put({ values: [1, 2] })
  ok('検証: 値の形が違うと 400', r5.status === 400, r5.data)
  const r6 = await put({ values: { w15sales: 12 }, expected_submitted_at: '2000-01-01 00:00:00' })
  ok('競合: 開いた後に出し直された（提出日時が違う）ときは 409 で書かない', r6.status === 409, r6.data)
  const [[h]] = d1(`SELECT COUNT(*) AS n FROM daily_report_edits WHERE daily_report_id = ${RID}`)
  ok('検証・競合で断ったときは、履歴も値も変えない', h.n === 0 && (await listOne()).values.w15sales === 10)
}

// ---------- 修正（全角の数字は半角に。テンプレートにないキーは捨てる。インシデントの内容は残す） ----------
const ed1 = await put({ values: { w15sales: '１２', w15memo: 'abc', w15talk: 3, hacker: 'x' }, reason: '店舗の実績に合わせました',
  expected_submitted_at: e0.report.submitted_at, expected_admin_edited_at: null })
ok('修正: 全角の数字でも保存でき、変わった項目だけを返す・スタッフに通知したと返す',
  ed1.status === 200 && ed1.data.changed === true && JSON.stringify(ed1.data.changed_keys) === '["w15sales"]' && ed1.data.staff_notified === true, ed1.data)
const rep1 = await listOne()
ok('修正: 日報の一覧に直した値と「管理者が修正」（直した人）・履歴の件数が出る',
  rep1.values.w15sales === 12 && rep1.admin_edited_at && rep1.admin_edited_by_name && Number(rep1.edit_count) === 1 && rep1.last_edit_kind === 'admin_edit' && !('hacker' in rep1.values), rep1)
ok('修正: インシデントの内容・印は変えずに残す', rep1.values.incident_note === '什器にぶつかった' && rep1.incident_flag === 1, rep1.values)
ok('修正: 提出日時・入力の経路は変えない', rep1.submitted_at === rep0.submitted_at && rep1.entry_method === rep0.entry_method, [rep0.submitted_at, rep1.submitted_at])
{
  const [[row]] = d1(`SELECT kind, before_values, after_values, changed_keys, reason, edited_by FROM daily_report_edits WHERE daily_report_id = ${RID}`)
  ok('履歴: もとの値・直した後の値・変わった項目・理由・直した人を残す', row.kind === 'admin_edit' && JSON.parse(row.before_values).w15sales === 10
    && JSON.parse(row.after_values).w15sales === 12 && row.changed_keys === '["w15sales"]' && row.reason === '店舗の実績に合わせました' && row.edited_by > 0, row)
  const e1 = must(await admin.get(`/api/admin/daily-reports/${RID}/edits`), 'edits 1')
  ok('履歴: 修正履歴の API に、直した人の名前・前後の値が出る', e1.edits.length === 1 && e1.edits[0].edited_by_name && e1.edits[0].before.w15sales === 10 && e1.edits[0].after.w15sales === 12, e1.edits)
  const same = await put({ values: { w15sales: 12 } })
  ok('修正: 値が変わらないときは書かない（changed: false・履歴も増えない）', same.status === 200 && same.data.changed === false
    && d1(`SELECT COUNT(*) AS n FROM daily_report_edits WHERE daily_report_id = ${RID}`)[0][0].n === 1, same.data)
  const stale = await put({ values: { w15sales: 13 }, expected_submitted_at: e0.report.submitted_at, expected_admin_edited_at: null })
  ok('競合: ほかの管理者が直した後の古い画面からは 409', stale.status === 409, stale.data)
}

// ---------- 直した値が使われる（実績分析・CSV） ----------
{
  const a = must(await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${PID}`), 'analytics')
  ok('実績分析: 直した値で集計する', a.totals && a.totals.values && a.totals.values.w15sales === 12, a.totals)
  const c = await admin.get(`/api/admin/daily-reports-csv?from=${today}&to=${today}&project_id=${PID}`)
  const rows = parseCsv(c.text), h = rows[0] || []
  const line = rows.find(x => x[h.indexOf('スタッフID')] === String(A.staff_id))
  ok('CSV: 直した値と「管理者の修正」の日時が出る', c.status === 200 && h.includes('管理者の修正') && line && line[h.indexOf('販売数')] === '12' && line[h.indexOf('管理者の修正')] === rep1.admin_edited_at, { h, line })
}

// ---------- スタッフの画面と通知 ----------
{
  const n = must(await staff.get('/api/staff/notifications?kind=daily_report_edit'), 'notifs').notifications
  ok('通知: スタッフにアプリ内の通知（直した項目・前後の値・理由）が届く', n.length === 1 && n[0].related_id === RID && /販売数: 10 → 12/.test(n[0].body) && /店舗の実績/.test(n[0].body) && n[0].link === '#report', n)
  const mine = must(await staff.get('/api/staff/my-reports'), 'my reports').reports.find(r => r.daily_report_id === RID)
  ok('スタッフの過去の日報: 直した値と「管理者が修正」・提出したときの値が見える',
    mine && mine.values.w15sales === 12 && mine.admin_edited_at && mine.admin_edit && mine.admin_edit.original.w15sales === 10 && mine.admin_edit.changed_keys.includes('w15sales'), mine)
  must(await staff.get(`/api/staff/my-reports/${RID}`), 'my report one')
  const n2 = must(await staff.get('/api/staff/notifications?kind=daily_report_edit'), 'notifs 2').notifications
  ok('通知: 日報を開くと修正の通知も既読になる', n2.length === 1 && n2[0].read_at, n2)
  const form = must(await staff.get(`/api/staff/daily-report/${shift.shift_id}`), 'staff form')
  ok('スタッフの日報の入力画面: 直した値を初期値にする（管理者が直したことも返す）', form.report.values.w15sales === 12 && form.report.admin_edited_at, form.report)
}

// ---------- 権限 ----------
{
  const r1 = await staff.put(`/api/admin/daily-reports/${RID}/values`, { values: { w15sales: 99 } })
  ok('権限: スタッフのログインからは直せない', r1.status === 403, r1.status)
  // 他社（demo2）の管理者をテスト用の DB に足す（パスワードは sample の admin と同じ）
  d1(`INSERT OR IGNORE INTO users (company_id, user_code, name, role, password_hash, status)
    SELECT 2, '${tag}adm', '他社 管理者', 'company_admin', password_hash, 'active' FROM users WHERE company_id = 1 AND user_code = 'admin'`)
  let other = null
  let loginError = null
  try { other = client(await login('demo2', `${tag}adm`)) } catch (e) { loginError = String(e) }
  ok('準備: 他社の管理者でログインできる', !!other, loginError)
  if (other) {
    const r2 = await other.put(`/api/admin/daily-reports/${RID}/values`, { values: { w15sales: 99 } })
    const r3 = await other.get(`/api/admin/daily-reports/${RID}/edits`)
    ok('権限: 他社の管理者は見られず直せない（404）', r2.status === 404 && r3.status === 404, [r2.status, r3.status])
  }
  ok('権限: 断った修正で値は変わらない', (await listOne()).values.w15sales === 12)
}

// ---------- スタッフの出し直し ----------
{
  // 同じ値のまま出し直す（画面の初期値は直した値）→ 印も履歴もそのまま
  must(await submit({ w15sales: 12, w15memo: 'abc', w15talk: 3 }, { incident_flag: true, incident_note: '什器にぶつかった' }), 'resubmit same')
  const r = await listOne()
  ok('出し直し: 直した値のまま出し直したときは「管理者が修正」の印を残し、履歴は増やさない', r.admin_edited_at === rep1.admin_edited_at && Number(r.edit_count) === 1, r)
  // 保存してある値のキーの並びだけが違うとき（RV）も、同じ値の出し直しとして印を残す
  {
    const [[cur]] = d1(`SELECT report_values FROM daily_reports WHERE daily_report_id = ${RID}`)
    const obj = JSON.parse(cur.report_values)
    const reversed = JSON.stringify(Object.fromEntries(Object.entries(obj).reverse())).replace(/'/g, "''")
    d1(`UPDATE daily_reports SET report_values = '${reversed}' WHERE daily_report_id = ${RID}`)
    must(await submit({ w15sales: 12, w15memo: 'abc', w15talk: 3 }, { incident_flag: true, incident_note: '什器にぶつかった' }), 'resubmit same (key order)')
    const rk = await listOne()
    ok('出し直し: キーの並びだけが違う同じ値の出し直しでも印を残し、履歴は増やさない', rk.admin_edited_at === rep1.admin_edited_at && Number(rk.edit_count) === 1, rk)
  }
  // 値を変えて出し直す → 再提出の値を正にし、印を外して履歴に「再提出」を残す
  must(await submit({ w15sales: 15, w15memo: 'abc', w15talk: 3 }, { incident_flag: true, incident_note: '什器にぶつかった' }), 'resubmit changed')
  const r2 = await listOne()
  ok('出し直し: 値を変えて出し直したら再提出の値が正になり、印を外す', r2.values.w15sales === 15 && !r2.admin_edited_at && !r2.admin_edited_by_name && r2.last_edit_kind === 'resubmit' && Number(r2.edit_count) === 2, r2)
  const e = must(await admin.get(`/api/admin/daily-reports/${RID}/edits`), 'edits after resubmit').edits
  ok('出し直し: 履歴に「再提出」（直した値 → 出し直した値・経路）を残し、管理者の修正も残る', e.length === 2 && e[0].kind === 'resubmit' && e[0].entry_method === 'app'
    && e[0].before.w15sales === 12 && e[0].after.w15sales === 15 && JSON.stringify(e[0].changed_keys) === '["w15sales"]' && e[1].kind === 'admin_edit', e)
  const mine = must(await staff.get('/api/staff/my-reports'), 'my reports 2').reports.find(x => x.daily_report_id === RID)
  ok('出し直し: スタッフの画面からも「管理者が修正」が消える', mine && !mine.admin_edited_at && !mine.admin_edit && mine.values.w15sales === 15, mine)
  const a = must(await admin.get(`/api/admin/analytics?month=${MONTH}&project_id=${PID}`), 'analytics 2')
  ok('出し直し: 実績分析は出し直した値で集計する', a.totals.values.w15sales === 15, a.totals)
  // 出し直した後にもう一度直せる（同じ日報に何度でも）
  const again = await put({ values: { w15talk: '５' } })
  const r3 = await listOne()
  ok('出し直しの後にもう一度直せる（送らなかった項目は今の値のまま）', again.status === 200 && again.data.changed && r3.values.w15talk === 5 && r3.values.w15sales === 15 && r3.admin_edited_at && Number(r3.edit_count) === 3, [again.data, r3.values])
  const mine2 = must(await staff.get('/api/staff/my-reports'), 'my reports 3').reports.find(x => x.daily_report_id === RID)
  ok('スタッフの画面: 出し直しの後の修正では、出し直した値を「提出時」として出す', mine2.admin_edit && JSON.stringify(mine2.admin_edit.changed_keys) === '["w15talk"]' && mine2.admin_edit.original.w15talk === 3, mine2.admin_edit)
  const n = must(await staff.get('/api/staff/notifications?kind=daily_report_edit'), 'notifs 3').notifications
  ok('通知: 2回目の修正も知らせる（既読の通知はそのまま残る）', n.length === 2 && /声かけ: 3 → 5/.test(n[0].body), n.map(x => x.body))
}

// ---------- テンプレートを差し替えた後の古い日報 ----------
{
  const tb = must(await admin.post('/api/admin/templates', { template_name: 'w15新' + tag, fields: [{ key: 'w15new', label: '新しい件数', type: 'number', required: true }] }), 'template B')
  must(await admin.put(`/api/admin/projects/${PID}`, { report_template_id: tb.template_id, confirm_template_change: true }), 'switch template')
  const e = must(await admin.get(`/api/admin/daily-reports/${RID}/edits`), 'edits after switch')
  const old = e.fields.find(f => f.key === 'w15sales')
  ok('差し替えた後: 古い項目も元の表示名で直せる（以前の項目の印）', old && old.label === '販売数' && old.past === true && e.fields[0].key === 'w15new', e.fields)
  const r = await put({ values: { w15sales: 20 } })
  const v = (await listOne()).values
  ok('差し替えた後: もとの日報に無い必須の項目は空のままでも直せ、空の項目は足さない', r.status === 200 && r.data.changed && v.w15sales === 20 && !('w15new' in v) && v.w15memo === 'abc' && v.incident_note === '什器にぶつかった', [r.data, v])
}

// ---------- 解約企業の書き出し・削除の対象 ----------
{
  const [[t]] = d1(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'daily_report_edits'`)
  const [[c]] = d1(`SELECT COUNT(*) AS n FROM pragma_table_info('daily_reports') WHERE name IN ('admin_edited_at', 'admin_edited_by')`)
  ok('マイグレーション 0097: 履歴の表と日報の列がある', t.n === 1 && c.n === 2, [t, c])
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
