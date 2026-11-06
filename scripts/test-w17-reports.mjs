// w17-reports（バグ管理表 11/5。#9901 #9902 #9903）の統合テスト
//  - #9901 スタッフアプリの日報のコメントに「コメントした人の名前」を返す（今日の日報の入力・過去の日報の一覧と1件・実績の日別）。引けないときは null（画面は「管理者」）
//  - #9902 一覧に最後の修正（誰が・どの項目を・いくつからいくつに）を返す。テンプレートの無い日報・確認済みの日報も直せる。
//          スタッフが値を変えて出し直したら確認（manager_checked・_by・_at）を外して未確認の数に入れ、「確認後に出し直し」の印を付ける。
//          値（キーの並びを除く）とインシデント・クレームの印が同じ出し直しは、確認済みのまま
//  - #9903 日報の入力欄の描画（report-form.js）をスタッフアプリと管理画面の両方で読み込み、テンプレートのプレビューで使う
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8812 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（日報の行をローカルの D1 から直接読む・書く。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8812 PERSIST=<保存先> node scripts/test-w17-reports.mjs
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import vm from 'vm'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8812'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
async function login(company_code, user_code, password = 'pass1234') {
  const send = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await send().catch(async () => { await new Promise(res => setTimeout(res, 1000)); return send() })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const send = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    const r = await send().catch(() => send())
    const text = await r.text()
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
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const MONTH = today.slice(0, 7)
const PFX = 'RW' + Date.now().toString(36).slice(-4).toUpperCase()
const tag = PFX.toLowerCase()

const admin = client(await login('sample', 'admin'))
const [[adminRow]] = d1(`SELECT name FROM users WHERE company_id = 1 AND user_code = 'admin'`)

// ---------- 準備: テンプレート・案件（テンプレートあり／なし）・スタッフ・今日のシフト ----------
const tpl = must(await admin.post('/api/admin/templates', { template_name: 'w17日報' + tag, fields: [
  { key: 'w17sales', label: '販売数', type: 'number', required: true },
  { key: 'w17talk', label: '声かけ', type: 'number' },
  { key: 'w17memo', label: 'ひとこと', type: 'text' }] }), 'template')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, report_template_id: tpl.template_id }), 'project')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-テンプレなし`, report_template_id: tpl.template_id }), 'project 2')
const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
const PID = projects.find(p => p.project_name === `${PFX}-案件`).project_id
const PID2 = projects.find(p => p.project_name === `${PFX}-テンプレなし`).project_id
// テンプレートの無い案件（古い案件など）
d1(`UPDATE projects SET report_template_id = NULL WHERE project_id = ${PID2}`)
const phone = '080' + String(Date.now() % 100000000).padStart(8, '0')
must(await admin.post('/api/admin/staff', { user_code: `${PFX}A`, name: `${PFX} 日報`, password: 'pass1234', phone, email: `${tag}-a@example.com` }), 'staff')
const A = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}A`)
const staff = client(await login('sample', `${PFX}A`))
const shift = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: PID, work_date: today, start_time: '00:00', end_time: '11:00' }), 'shift')
const shift2 = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: PID2, work_date: today, start_time: '12:00', end_time: '23:59' }), 'shift 2')
const submit = (values, extra = {}) => staff.post('/api/staff/daily-report', { shift_id: shift.shift_id, values, ...extra })
must(await submit({ w17sales: 10, w17talk: 3, w17memo: 'abc' }), 'submit')
must(await staff.post('/api/staff/daily-report', { shift_id: shift2.shift_id, values: { free: '今日は5件' } }), 'submit 2')
const list = async (q = '') => must(await admin.get(`/api/admin/daily-reports?from=${today}&to=${today}&staff_id=${A.staff_id}${q}`), 'list')
const one = async (sid = shift.shift_id) => (await list()).reports.find(r => r.shift_id === sid)
const rep0 = await one()
const RID = rep0.daily_report_id
const RID2 = (await one(shift2.shift_id)).daily_report_id
ok('準備: 日報を2件出せた', rep0 && RID2 && rep0.values.w17sales === 10 && rep0.last_edit === null, rep0)

// ---------- #9901 コメントした人の名前 ----------
{
  must(await admin.put(`/api/admin/daily-reports/${RID}`, { manager_comment: 'よく頑張りました' }), 'comment')
  const form = must(await staff.get(`/api/staff/daily-report/${shift.shift_id}`), 'staff form').report
  ok('#9901 今日の日報の入力画面: コメントとコメントした人の名前・日時を返す', form.manager_comment === 'よく頑張りました' && form.manager_comment_by_name === adminRow.name && !!form.manager_comment_at, form)
  const mine = must(await staff.get('/api/staff/my-reports'), 'my reports').reports.find(r => r.daily_report_id === RID)
  ok('#9901 過去の日報の一覧: コメントした人の名前を返す', mine && mine.manager_comment_by_name === adminRow.name && !!mine.manager_comment_at, mine)
  const single = must(await staff.get(`/api/staff/my-reports/${RID}`), 'my report').report
  ok('#9901 過去の日報の1件（詳細）: コメントした人の名前を返す', single.manager_comment_by_name === adminRow.name, single)
  const perf = must(await staff.get(`/api/staff/performance?month=${MONTH}`), 'perf').daily.find(d => d.project_id === PID)
  ok('#9901 実績の日別: コメントとコメントした人の名前を返す', perf && perf.comment === 'よく頑張りました' && perf.comment_by_name === adminRow.name, perf)
  const n = must(await staff.get('/api/staff/notifications?kind=daily_report_comment'), 'notifs').notifications.find(x => x.related_id === RID)
  ok('#9901 コメントの通知の「コメントした人」と同じ名前', n && n.body.includes(`コメントした人: ${adminRow.name}`), n)
  // コメントした人のアカウントが引けない（消えた）ときは null（画面は「管理者からのコメント」）
  d1(`UPDATE daily_reports SET manager_comment_by = 99999999 WHERE daily_report_id = ${RID}`)
  const gone = must(await staff.get(`/api/staff/my-reports/${RID}`), 'my report gone').report
  const goneForm = must(await staff.get(`/api/staff/daily-report/${shift.shift_id}`), 'staff form gone').report
  ok('#9901 コメントした人が引けないときは名前を null で返す', gone.manager_comment === 'よく頑張りました' && gone.manager_comment_by_name == null && goneForm.manager_comment_by_name == null, [gone, goneForm])
  const r2 = must(await staff.get(`/api/staff/my-reports/${RID2}`), 'no comment').report
  ok('#9901 コメントの無い日報は名前も日時も出さない', !r2.manager_comment && r2.manager_comment_by_name == null, r2)
  must(await admin.put(`/api/admin/daily-reports/${RID}`, { manager_comment: 'よく頑張りました' }), 'comment again')
}

// ---------- #9902 実績の修正の入り口になる値（テンプレートの無い日報・確認済みの日報） ----------
{
  must(await admin.put(`/api/admin/daily-reports/${RID}`, { manager_checked: 1 }), 'check')
  const e = must(await admin.get(`/api/admin/daily-reports/${RID}/edits`), 'edits')
  const r = await admin.put(`/api/admin/daily-reports/${RID}/values`, { values: { w17sales: 12 }, reason: '店舗の実績', expected_submitted_at: e.report.submitted_at, expected_admin_edited_at: null })
  const rep = await one()
  ok('#9902 確認済みの日報も直せる（確認済みのまま）', r.status === 200 && r.data.changed && rep.values.w17sales === 12 && rep.manager_checked === 1, [r.data, rep.manager_checked])
  ok('#9902 一覧に最後の修正（直した人・項目・前後の値・理由）を返す', rep.last_edit && rep.last_edit.kind === 'admin_edit' && rep.last_edit.edited_by_name === adminRow.name
    && rep.last_edit.reason === '店舗の実績' && JSON.stringify(rep.last_edit.changes) === JSON.stringify([{ key: 'w17sales', before: 10, after: 12 }]) && rep.last_edit.more === 0, rep.last_edit)
  const e2 = must(await admin.get(`/api/admin/daily-reports/${RID2}/edits`), 'edits 2')
  ok('#9902 テンプレートの無い案件の日報は「報告内容」を直せる', e2.fields.some(f => f.key === 'free'), e2.fields)
  const r2 = await admin.put(`/api/admin/daily-reports/${RID2}/values`, { values: { free: '今日は6件' } })
  ok('#9902 テンプレートの無い案件の日報も直せる', r2.status === 200 && (await one(shift2.shift_id)).values.free === '今日は6件', r2.data)
  const n = (await list()).counts.unchecked
  ok('#9902 未確認の数: 確認済みの日報は数えない（もう1件は未確認）', n === 1, (await list()).counts)
}

// ---------- #9902 出し直しで未確認に戻す ----------
{
  const before = d1(`SELECT manager_checked, manager_checked_by, manager_checked_at, revised_after_check_at, report_values FROM daily_reports WHERE daily_report_id = ${RID}`)[0][0]
  // 同じ値のまま出し直す（キーの並びも違う）→ 確認済みのまま
  must(await submit({ w17memo: 'abc', w17talk: 3, w17sales: 12 }), 'resubmit same')
  const same = d1(`SELECT manager_checked, manager_checked_by, manager_checked_at, revised_after_check_at, admin_edited_at FROM daily_reports WHERE daily_report_id = ${RID}`)[0][0]
  ok('#9902 値の変わらない出し直し（キーの並びだけ違う）は確認済みのまま', same.manager_checked === 1 && same.manager_checked_by === before.manager_checked_by
    && same.manager_checked_at === before.manager_checked_at && same.revised_after_check_at == null && same.admin_edited_at, [before, same])
  ok('#9902 値の変わらない出し直しでは未確認の数は増えない', (await list()).counts.unchecked === 1)
  // 値を変えて出し直す → 確認を外し、未確認の数に入れ、「確認後に出し直し」の印を付ける
  must(await submit({ w17sales: 15, w17talk: 3, w17memo: 'abc' }), 'resubmit changed')
  const ch = d1(`SELECT manager_checked, manager_checked_by, manager_checked_at, revised_after_check_at, submitted_at FROM daily_reports WHERE daily_report_id = ${RID}`)[0][0]
  ok('#9902 値を変えた出し直しは確認（manager_checked・_by・_at）を外し、出し直した日時を残す', ch.manager_checked === 0 && ch.manager_checked_by == null && ch.manager_checked_at == null && ch.revised_after_check_at === ch.submitted_at, ch)
  const L = await list()
  ok('#9902 値を変えた出し直しは未確認の数・未確認のみの一覧に入る', L.counts.unchecked === 2 && (await list('&unchecked=1')).reports.some(r => r.daily_report_id === RID), L.counts)
  const rep = L.reports.find(r => r.daily_report_id === RID)
  ok('#9902 一覧の最後の修正は「再提出」（前後の値つき）', rep.last_edit && rep.last_edit.kind === 'resubmit' && JSON.stringify(rep.last_edit.changes) === JSON.stringify([{ key: 'w17sales', before: 12, after: 15 }]) && rep.revised_after_check_at, rep.last_edit)
  // 同じ値でインシデントの印を付けて出し直す → 内容が変わったので未確認に戻す
  must(await admin.put(`/api/admin/daily-reports/${RID}`, { manager_checked: 1 }), 'check again')
  must(await submit({ w17sales: 15, w17talk: 3, w17memo: 'abc' }, { incident_flag: true, incident_note: '什器にぶつかった', flags_explicit: true }), 'resubmit incident')
  const inc = await one()
  ok('#9902 インシデントの印を付けた出し直しは未確認に戻す', inc.manager_checked === 0 && inc.incident_flag === 1 && !!inc.revised_after_check_at, inc)
  // 同じ値・同じ印のまま（flags_explicit なし）の出し直しは確認済みのまま
  must(await admin.put(`/api/admin/daily-reports/${RID}`, { manager_checked: 1 }), 'check 3')
  must(await submit({ w17sales: 15, w17talk: 3, w17memo: 'abc', incident_note: '什器にぶつかった' }), 'resubmit same flags')
  ok('#9902 印も値も同じ出し直しは確認済みのまま', (await one()).manager_checked === 1)
  // 印を外して出し直す → 未確認に戻す
  must(await submit({ w17sales: 15, w17talk: 3, w17memo: 'abc' }, { incident_flag: false, flags_explicit: true }), 'resubmit unflag')
  const un = await one()
  ok('#9902 インシデントの印を外した出し直しも未確認に戻す', un.manager_checked === 0 && un.incident_flag === 0, un)
  // 未確認のときの出し直し（値を変える）は、確認後の印を新しく付けない
  must(await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_checked: 0 }), 'uncheck 2')
  must(await staff.post('/api/staff/daily-report', { shift_id: shift2.shift_id, values: { free: '今日は7件' } }), 'resubmit 2')
  const r2 = await one(shift2.shift_id)
  ok('#9902 未確認の日報の出し直しは未確認のまま（確認後の印は付けない）', r2.manager_checked === 0 && !r2.revised_after_check_at && r2.values.free === '今日は7件', r2)
  // 確認済みにし直すと、出し直しの印は外れる
  must(await admin.post('/api/admin/daily-reports/check', { ids: [RID] }), 'check bulk')
  const back = await one()
  ok('#9902 確認済みにし直すと、出し直しの印は外れる', back.manager_checked === 1 && !back.revised_after_check_at, back)
}

// ---------- #9902 一覧の最後の修正: 長いテキストは先頭だけ返す（全文は修正履歴） ----------
{
  const long = 'あ'.repeat(100)
  const r = await admin.put(`/api/admin/daily-reports/${RID2}/values`, { values: { free: long } })
  const le = (await one(shift2.shift_id)).last_edit
  const h = must(await admin.get(`/api/admin/daily-reports/${RID2}/edits`), 'edits long')
  ok('#9902 一覧の最後の修正は長いテキストを60文字＋「…」にし、修正履歴は全文を返す', r.status === 200 && le && le.changes[0].after === 'あ'.repeat(60) + '…'
    && JSON.stringify(h).includes(long), le)
}

// ---------- #9903 日報の入力欄の描画を共用する（report-form.js） ----------
{
  const js = await (await fetch(`${BASE}/static/report-form.js`)).text()
  ok('#9903 report-form.js を配信している', /function reportFormBodyHtml/.test(js) && /function reportFormBind/.test(js), js.slice(0, 200))
  const adminHtml = (await admin.get('/admin')).text
  const ai = adminHtml.indexOf('/static/report-form.js'), aj = adminHtml.indexOf('/static/admin.js')
  ok('#9903 管理画面は admin.js より前に report-form.js を読み込む', ai > 0 && aj > ai, [ai, aj])
  const staffHtml = (await staff.get('/staff')).text
  const si = staffHtml.indexOf('/static/report-form.js'), sj = staffHtml.indexOf('/static/staff.js')
  ok('#9903 スタッフアプリは staff.js より前に report-form.js を読み込む', si > 0 && sj > si, [si, sj])
  const staffJs = await (await fetch(`${BASE}/static/staff.js`)).text()
  const adminJs = await (await fetch(`${BASE}/static/admin.js`)).text()
  ok('#9903 スタッフアプリの日報の画面とテンプレートのプレビューは同じ関数で描く（二重に書かない）',
    /reportFormBodyHtml\(fields, pv/.test(staffJs) && /reportFormBodyHtml\(fields, k => typed\[k\]/.test(adminJs)
    && !/function reportFormBodyHtml|const REPORT_TEXT_MAX|delegate\('reportCount'/.test(staffJs + adminJs))
  // 描画の中身（common.js の esc を使う）
  const ctx = { document: { addEventListener() { }, documentElement: null, querySelectorAll: () => [] }, window: {}, console, setTimeout, clearTimeout }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(readFileSync(new URL('../public/static/common.js', import.meta.url), 'utf8'), ctx)
  vm.runInContext(js + '\n;globalThis.__f = reportFormBodyHtml', ctx)
  const html = ctx.__f([{ key: 'a1', label: '販売<数>', type: 'number', required: true }, { key: 'm', label: 'メモ', type: 'text', maxLength: 50 }], k => ({ a1: 3 })[k], { submitLabel: '日報を提出する' })
  ok('#9903 項目の種類・必須・文字数・表示名（エスケープ）を、スタッフアプリと同じ形で描く',
    /実績件数/.test(html) && /data-key="a1"/.test(html) && /value="3"/.test(html) && /販売&lt;数&gt;<span class="text-red-500/.test(html)
    && /報告事項/.test(html) && /maxlength="50"/.test(html) && /インシデントがあった/.test(html) && /日報を提出する/.test(html), html.slice(0, 400))
  const onlyText = ctx.__f([{ key: 'm', label: 'メモ', type: 'textarea' }], null, {})
  ok('#9903 数値の項目が無ければ「実績件数」の欄は出さない', !/実績件数/.test(onlyText) && /rows="3"/.test(onlyText))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
