// w24-requests（利用者の要望 11/10。#9963 #9964 #9965）の統合テスト
//  - #9963 実績分析の絞り込みをページの上（案件・スタッフ・月）に一本化。スタッフで絞ると一覧・グラフ・CSV が同じ条件になる
//  - #9964 クライアント・顧客担当者・協力会社（会社名と先方の担当者）のフリガナ。全角カタカナにそろえ（ひらがな・半角カナは変換）、一覧の検索でも引ける
//  - #9965 日報のコメントを複数に（daily_report_comments）。編集・削除は書いた本人だけ（ほかの人は 403）。既読・通知はコメントごと。
//          旧列（manager_comment など）は最新のコメントの写し。以前の形の PUT（manager_comment）も受け付ける。既存のコメントは 0107 で写す
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 9035 --persist-to <保存先> で起動していること（本番には接続しない）。
//   PERSIST に --persist-to の保存先を指定する（ローカルの D1 を直接読む・書く。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9035 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w24-requests.mjs
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import vm from 'vm'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:9035'
const PERSIST = process.env.PERSIST || process.env.TEST_PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
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
    return { status: r.status, data, text, headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
// ローカルの D1 を直接読む（PERSIST がないときは、その確かめを飛ばす）
function d1(sql) {
  if (!PERSIST) return null
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
const PFX = 'RQ' + Date.now().toString(36).slice(-4).toUpperCase()
const tag = PFX.toLowerCase()
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const admin = client(await login('sample', 'admin'))
const sales = client(await login('sample', 'sales01'))
const ADMIN_NAME = '出井 代表', SALES_NAME = '岡本 営業'

// ---------- 準備: テンプレート・案件・スタッフ2人・今日のシフトと日報 ----------
const tpl = must(await admin.post('/api/admin/templates', { template_name: 'w24日報' + tag, fields: [
  { key: 'w24sales', label: '販売数', type: 'number' }, { key: 'w24memo', label: 'ひとこと', type: 'text' }] }), 'template')
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, report_template_id: tpl.template_id }), 'project')
const PID = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
const mkStaff = async (k) => {
  const phone = '080' + String((Date.now() + k.charCodeAt(0)) % 100000000).padStart(8, '0')
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}さん`, password: 'pass1234', phone, email: `${tag}-${k.toLowerCase()}@example.com` }), 'staff ' + k)
  const row = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(x => x.user_code === `${PFX}${k}`)
  return { ...row, api: client(await login('sample', `${PFX}${k}`)) }
}
const A = await mkStaff('A'), B = await mkStaff('B')
const shiftA = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: PID, work_date: today, start_time: '00:00', end_time: '11:00' }), 'shift A')
const shiftA2 = must(await admin.post('/api/admin/shifts', { staff_id: A.staff_id, project_id: PID, work_date: today, start_time: '12:00', end_time: '23:59' }), 'shift A2')
const shiftB = must(await admin.post('/api/admin/shifts', { staff_id: B.staff_id, project_id: PID, work_date: today, start_time: '00:00', end_time: '23:59' }), 'shift B')
must(await A.api.post('/api/staff/daily-report', { shift_id: shiftA.shift_id, values: { w24sales: 3, w24memo: 'A1' } }), 'report A')
must(await A.api.post('/api/staff/daily-report', { shift_id: shiftA2.shift_id, values: { w24sales: 4, w24memo: 'A2' } }), 'report A2')
must(await B.api.post('/api/staff/daily-report', { shift_id: shiftB.shift_id, values: { w24sales: 10, w24memo: 'B1' } }), 'report B')
const listOf = async (who, staffId) => must(await who.get(`/api/admin/daily-reports?from=${today}&to=${today}&staff_id=${staffId}&limit=50`), 'list').reports
const repA = (await listOf(admin, A.staff_id)).find(r => r.shift_id === shiftA.shift_id)
const RID = repA.daily_report_id
const rowOf = async (who = admin) => (await listOf(who, A.staff_id)).find(r => r.daily_report_id === RID)
const notifs = async () => (must(await A.api.get('/api/staff/notifications?kind=daily_report_comment'), 'notifs').notifications || []).filter(n => n.related_id === RID)
const unreadNotifs = async () => (await notifs()).filter(n => !n.read_at)
ok('準備: 日報を3件出せた（コメントはまだ無い）', RID && Array.isArray(repA.comments) && repA.comments.length === 0, repA)

// ---------- #9965 日報のコメントを複数に ----------
let C1, C2
{
  const r1 = await admin.post(`/api/admin/daily-reports/${RID}/comments`, { body: '  1件目のコメント\n改行あり  ' })
  ok('#9965 コメントを追加できる（前後の空白は除く。スタッフに通知したことを返す）', r1.status === 200 && r1.data.staff_notified === true && r1.data.comments.length === 1 && r1.data.comments[0].body === '1件目のコメント\n改行あり', r1.data)
  C1 = r1.data.comment_id
  let row = await rowOf()
  ok('#9965 一覧にコメントの一覧（書いた人・日時・自分のものか）を返す', row.comments.length === 1 && row.comments[0].author_name === ADMIN_NAME && row.comments[0].mine === true && !!row.comments[0].created_at && row.comments[0].read_at == null, row.comments)
  ok('#9965 旧列（manager_comment など）に最新のコメントを写す（古いコードでも同じ表示）', row.manager_comment === '1件目のコメント\n改行あり' && row.manager_comment_by_name === ADMIN_NAME && !!row.manager_comment_at && row.comment_read_at == null, row)
  const srow = await rowOf(sales)
  ok('#9965 ほかの管理者から見ると、自分のコメントではない（mine: false）', srow.comments[0].mine === false, srow.comments)
  const e403 = await sales.put(`/api/admin/daily-reports/${RID}/comments/${C1}`, { body: '書き換え' })
  ok('#9965 ほかの人のコメントは編集できない（403）', e403.status === 403 && /書いた人だけ/.test(e403.data?.error || ''), e403)
  const d403 = await sales.del(`/api/admin/daily-reports/${RID}/comments/${C1}`)
  ok('#9965 ほかの人のコメントは削除できない（403）', d403.status === 403, d403)
  row = await rowOf()
  ok('#9965 403 のときは内容を変えない', row.comments.length === 1 && row.comments[0].body === '1件目のコメント\n改行あり')

  const r2 = await sales.post(`/api/admin/daily-reports/${RID}/comments`, { body: '2件目（営業）' })
  ok('#9965 ほかの人は「コメントを追加」で別のコメントとして送れる', r2.status === 200 && r2.data.comments.length === 2, r2.data)
  C2 = r2.data.comment_id
  row = await rowOf()
  ok('#9965 コメントは古い順に、書いた人の名前つきで返す', row.comments.map(c => c.body).join('|') === '1件目のコメント\n改行あり|2件目（営業）' && row.comments[1].author_name === SALES_NAME && row.comments[1].mine === false, row.comments)
  ok('#9965 旧列は最新のコメント（2件目）の写しになる', row.manager_comment === '2件目（営業）' && row.manager_comment_by_name === SALES_NAME, row)
  const un = await unreadNotifs()
  ok('#9965 通知は同じ日報の未読を1件にまとめ、最新のコメントと書いた人を出す（未読の数は日報の数のまま）', un.length === 1 && un[0].body.includes('2件目（営業）') && un[0].body.includes(`コメントした人: ${SALES_NAME}`), un)

  // スタッフアプリ
  const mine = must(await A.api.get('/api/staff/my-reports'), 'my reports').reports.find(r => r.daily_report_id === RID)
  ok('#9965 スタッフの日報一覧: コメントをすべて（書いた人の名前つき）返し、未読の印が付く', mine && mine.comments.length === 2 && mine.comments[1].author_name === SALES_NAME && mine.unread_comment === true && mine.comments.every(c => c.author_user_id === undefined), mine)
  const form = must(await A.api.get(`/api/staff/daily-report/${shiftA.shift_id}`), 'form').report
  ok('#9965 日報の入力画面にもコメントの一覧を返す', form.comments.length === 2 && form.manager_comment === '2件目（営業）', form)
  const perf = must(await A.api.get(`/api/staff/performance?month=${MONTH}`), 'perf').daily.filter(d => d.project_id === PID)
  ok('#9965 実績の日別にもコメントの一覧を返す（旧の comment は最新のコメント）', perf.some(d => d.comments && d.comments.length === 2 && d.comment === '2件目（営業）') && perf.every(d => Array.isArray(d.comments) && d._rid === undefined), perf)
  const one = must(await A.api.get(`/api/staff/my-reports/${RID}`), 'open').report
  ok('#9965 スタッフが日報を開くと、すべてのコメントが既読になる', one.unread_comment === false && one.comments.every(c => !!c.read_at), one.comments)
  row = await rowOf()
  ok('#9965 管理画面にコメントごとの既読と、旧列の既読（comment_read_at）を返す', row.comments.every(c => !!c.read_at) && !!row.comment_read_at, row)
  ok('#9965 開いたら通知も既読になる', (await unreadNotifs()).length === 0)

  // 自分のコメントを直す → そのコメントだけ未読に戻り、もう一度知らせる
  const e1 = await admin.put(`/api/admin/daily-reports/${RID}/comments/${C1}`, { body: '1件目を直しました' })
  ok('#9965 自分のコメントは直せる（スタッフに知らせる）', e1.status === 200 && e1.data.staff_notified === true, e1.data)
  row = await rowOf()
  const c1 = row.comments.find(c => c.comment_id === C1), c2 = row.comments.find(c => c.comment_id === C2)
  ok('#9965 直したコメントだけ未読に戻り、編集の日時が付く（ほかのコメントの既読はそのまま）', c1.body === '1件目を直しました' && c1.read_at == null && !!c1.updated_at && !!c2.read_at, row.comments)
  ok('#9965 未読のコメントがあれば、旧列の既読は空（最新のコメントは2件目のまま）', row.comment_read_at == null && row.manager_comment === '2件目（営業）', row)
  ok('#9965 直したときも、未読の通知は1件', (await unreadNotifs()).length === 1)
  const same = await admin.put(`/api/admin/daily-reports/${RID}/comments/${C1}`, { body: '1件目を直しました' })
  ok('#9965 同じ内容で保存しても通知しない', same.status === 200 && same.data.staff_notified === undefined, same.data)
  const read = await A.api.post(`/api/staff/my-reports/${RID}/comment-read`)
  ok('#9965 一覧で開いたとき（comment-read）も、コメントを既読にする', read.status === 200 && read.data.updated === 1 && (await rowOf()).comments.every(c => !!c.read_at), read.data)
  ok('#9965 既読のものをもう一度既読にしても変わらない（updated: 0）', (await A.api.post(`/api/staff/my-reports/${RID}/comment-read`)).data.updated === 0)
  ok('#9965 ほかの人の日報は既読にできない（updated: 0）', (await B.api.post(`/api/staff/my-reports/${RID}/comment-read`)).data.updated === 0)

  // 入力の確かめ
  ok('#9965 空のコメントは 400', (await admin.post(`/api/admin/daily-reports/${RID}/comments`, { body: '   ' })).status === 400)
  ok('#9965 2000文字を超えるコメントは 400', (await admin.post(`/api/admin/daily-reports/${RID}/comments`, { body: 'あ'.repeat(2001) })).status === 400)
  ok('#9965 文字列でないコメントは 400', (await admin.post(`/api/admin/daily-reports/${RID}/comments`, { body: 123 })).status === 400)
  ok('#9965 編集で空にすると 400（消すときは DELETE）', (await admin.put(`/api/admin/daily-reports/${RID}/comments/${C1}`, { body: '' })).status === 400)
  ok('#9965 無い日報へのコメントは 404', (await admin.post('/api/admin/daily-reports/99999999/comments', { body: 'x' })).status === 404)
  ok('#9965 ほかの日報の番号でコメントを指定しても 404', (await admin.put(`/api/admin/daily-reports/${RID + 99999}/comments/${C1}`, { body: 'x' })).status === 404)

  // 自分のコメントを消す
  must(await admin.post(`/api/admin/daily-reports/${RID}/comments`, { body: '3件目（消す）' }), 'third')
  ok('（前提）3件目で未読の通知が1件', (await unreadNotifs()).length === 1)
  row = await rowOf()
  const c3 = row.comments[row.comments.length - 1]
  const del = await admin.del(`/api/admin/daily-reports/${RID}/comments/${c3.comment_id}`)
  row = await rowOf()
  ok('#9965 自分のコメントは消せる。旧列は残ったうちの最新（2件目）に戻る', del.status === 200 && row.comments.length === 2 && row.manager_comment === '2件目（営業）' && row.manager_comment_by_name === SALES_NAME, row)
  ok('#9965 消して未読のコメントが無くなったら、まだ読んでいない通知も消す（未読の数が残らない）', (await unreadNotifs()).length === 0 && !!row.comment_read_at, await notifs())
}

// ---------- #9965 以前の形の PUT（manager_comment。古い画面・外部から） ----------
{
  const RID2 = (await listOf(admin, A.staff_id)).find(r => r.shift_id === shiftA2.shift_id).daily_report_id
  const get = async () => (await listOf(admin, A.staff_id)).find(r => r.daily_report_id === RID2)
  let r = await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: '旧の形1', expected_comment: null })
  let row = await get()
  ok('#9965 旧の形: コメントの無い日報には、コメントを1件足す', r.status === 200 && r.data.staff_notified === true && row.comments.length === 1 && row.manager_comment === '旧の形1', row)
  r = await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: '旧の形1を直した', expected_comment: '旧の形1' })
  row = await get()
  ok('#9965 旧の形: 最新のコメントが自分のものなら、それを直す', r.status === 200 && row.comments.length === 1 && row.comments[0].body === '旧の形1を直した', row.comments)
  r = await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: 'x', expected_comment: '古い内容' })
  ok('#9965 旧の形: 開いたときの最新のコメントと違うと 409（今のコメントを返す）', r.status === 409 && r.data.current_comment === '旧の形1を直した', r.data)
  r = await sales.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: '営業から追記', expected_comment: '旧の形1を直した' })
  row = await get()
  ok('#9965 旧の形: 最新のコメントがほかの人のものなら、上書きせずにコメントを足す', r.status === 200 && row.comments.length === 2 && row.comments[0].body === '旧の形1を直した' && row.manager_comment === '営業から追記', row.comments)
  r = await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: '' })
  ok('#9965 旧の形: ほかの人の最新のコメントを空欄で消そうとすると 403', r.status === 403 && (await get()).comments.length === 2, r)
  r = await sales.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: null })
  row = await get()
  ok('#9965 旧の形: 自分の最新のコメントは空欄で消せる（旧列は残ったコメントに戻る）', r.status === 200 && row.comments.length === 1 && row.manager_comment === '旧の形1を直した' && row.manager_comment_by_name === ADMIN_NAME, row)
  r = await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_checked: 1 })
  ok('#9965 旧の形: 確認済みだけを変えてもコメントは変わらない', r.status === 200 && (await get()).comments.length === 1 && (await get()).manager_checked)
  ok('#9965 旧の形: 文字列でないコメントは 400', (await admin.put(`/api/admin/daily-reports/${RID2}`, { manager_comment: 5 })).status === 400)
}

// ---------- #9965 CSV・移行・トリガー・保存期間 ----------
{
  const csv = await admin.get(`/api/admin/daily-reports-csv?from=${today}&to=${today}&staff_id=${A.staff_id}`)
  ok('#9965 日報の CSV の「管理者コメント」に、すべてのコメントを書いた人・日時つきで出す', csv.status === 200 && csv.text.includes(`${ADMIN_NAME} `) && csv.text.includes(': 1件目を直しました') && csv.text.includes(`${SALES_NAME} `) && csv.text.includes(': 2件目（営業）'), csv.text.slice(0, 400))
  if (PERSIST) {
    const [[mig]] = d1(`SELECT (SELECT COUNT(*) FROM daily_reports dr WHERE TRIM(COALESCE(dr.manager_comment, '')) <> '' AND dr.daily_report_id < ${RID}
        AND NOT EXISTS (SELECT 1 FROM daily_report_comments c WHERE c.daily_report_id = dr.daily_report_id)) AS missing,
      (SELECT body FROM daily_report_comments WHERE daily_report_id = 109 ORDER BY comment_id LIMIT 1) AS seed_body,
      (SELECT created_at FROM daily_report_comments WHERE daily_report_id = 109 ORDER BY comment_id LIMIT 1) AS seed_at,
      (SELECT submitted_at FROM daily_reports WHERE daily_report_id = 109) AS seed_submitted`)
    ok('#9965 0107: 既存のコメント（seed の日報 109 など）をすべて新しい表に写す（日時の無いものは提出日時）', mig.missing === 0 && mig.seed_body === 'PI好調です。この調子で！' && mig.seed_at === mig.seed_submitted, mig)
    // 古いコード（マイグレーションを当ててから新しいコードを出すまで）が manager_comment を書き換えたときは、コメントとして足す
    d1(`UPDATE daily_reports SET manager_comment = '古いコードのコメント', manager_comment_by = 1, manager_comment_at = '2026-11-01 10:00:00', comment_read_at = NULL WHERE daily_report_id = ${RID}`)
    let row = await rowOf()
    ok('#9965 0107 のトリガー: 古いコードが書いたコメントも新しい表に入る', row.comments.length === 3 && row.comments[2].body === '古いコードのコメント' && row.comments[2].created_at === '2026-11-01 10:00:00', row.comments)
    d1(`UPDATE daily_reports SET manager_comment = '古いコードのコメント' WHERE daily_report_id = ${RID}`)
    d1(`UPDATE daily_reports SET manager_comment = NULL WHERE daily_report_id = ${RID}`)
    row = await rowOf()
    ok('#9965 0107 のトリガー: 同じ内容・空にしたときは足さない（新しいコードの写しでも足さない）', row.comments.length === 3, row.comments)
    const [[cnt]] = d1(`SELECT COUNT(*) AS n FROM daily_report_comments WHERE daily_report_id = ${RID}`)
    ok('#9965 新しいコードの写し（追加・編集・削除）でトリガーがコメントを増やしていない', cnt.n === 3, cnt)
  } else ok('（PERSIST がないため、移行とトリガーの確かめを飛ばしました）', true)
  const ret = src('src/services/retention.ts')
  ok('#9965 日報の3年の削除でコメントも消し、解約企業の削除・書き出しの対象に入れる', ret.includes('DELETE FROM daily_report_comments WHERE daily_report_id IN (${pick})') && ret.includes("{ target: 'daily_report_comments', label: '日報のコメント', table: 'daily_report_comments', where: OB_CO }"))
  const dry = await client(await login('sample', 'hq')).post('/api/hq/retention/dry-run', {})
  ok('#9965 保存期間の削除の試算（dry-run）がエラーにならない', dry.status === 200, dry.status)
}

// ---------- #9965 画面のコード ----------
{
  const ad = src('public/static/admin.js'), st = src('public/static/staff.js')
  ok('#9965 管理画面: コメントを一覧で出し、自分のコメント（と書いた人の記録がない古いコメント。#9975）だけ「編集」「削除」を出す。ボタンは「コメントを追加」', /function reportCommentsHtml\(r, fmt\)/.test(ad) && ad.includes('${cm.mine || cm.editable ?') && ad.includes('data-action="deleteReportComment"') && ad.includes("'コメントを追加'"))
  ok('#9965 管理画面: 追加は POST、編集は PUT（/comments/:id）を使う', ad.includes("'/comments'") && ad.includes("axios.put(url + '/' + cid, { body: text })") && ad.includes('axios.post(url, { body: text })'))
  ok('#9965 スタッフアプリ: コメントを新しい順に、書いた人の名前つきで出す', /function reportCommentsHtml\(comments, legacy, opts\)/.test(st) && st.includes('comments.slice().reverse()') && (st.match(/reportCommentsHtml\(/g) || []).length >= 5)
  // スタッフアプリの描画を実際に動かす（新しい順・名前・件数の省略）
  const fnSrc = (name) => { const i = st.indexOf(`function ${name}(`); let d = 0, j = st.indexOf('{', i); for (; j < st.length; j++) { if (st[j] === '{') d++; else if (st[j] === '}' && --d === 0) break } return st.slice(i, j + 1) }
  const ctx = { esc: s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])), linkify: s => s,
    dayjs: d => ({ format: () => String(d).slice(5, 16) }) }
  vm.createContext(ctx)
  vm.runInContext(fnSrc('reportCommentHtml') + '\n' + fnSrc('reportCommentsHtml'), ctx)
  const html = ctx.reportCommentsHtml([{ body: '古い', author_name: '甲', created_at: '2026-11-01 10:00:00' }, { body: '新しい', author_name: '乙', created_at: '2026-11-02 10:00:00' }], null, {})
  ok('#9965 スタッフアプリの描画: 新しいコメントが先、「〇〇さんからのコメント」', html.indexOf('新しい') < html.indexOf('古い') && html.includes('乙さんからのコメント') && html.includes('甲さんからのコメント'), html.slice(0, 300))
  const one = ctx.reportCommentsHtml([{ body: '古い', author_name: '甲', created_at: 'x' }, { body: '新しい', author_name: null, created_at: 'y' }], null, { max: 1 })
  ok('#9965 スタッフアプリの描画: 一覧のカードは最新の1件と「ほか○件」。名前が無ければ「管理者」', one.includes('新しい') && !one.includes('古い') && one.includes('ほか1件のコメント') && one.includes('管理者からのコメント'), one)
  const legacy = ctx.reportCommentsHtml(undefined, { text: '旧', by: '丙', at: 'z' }, {})
  ok('#9965 スタッフアプリの描画: comments の無い古い応答では最新の1件（manager_comment）を出す', legacy.includes('旧') && legacy.includes('丙さん'), legacy)
}

// ---------- #9964 フリガナ ----------
{
  const cname = `${PFX}フリガナ商事`
  const r = await admin.post('/api/admin/clients', { client_name: cname, client_name_kana: 'ふりがな しょうじ' })
  ok('#9964 クライアントの登録でフリガナを保存できる', r.status === 200, r.data)
  const CID = r.data.client_id
  let cl = must(await admin.get(`/api/admin/clients/${CID}`), 'client').client
  ok('#9964 ひらがなは全角カタカナにして保存する', cl.client_name_kana === 'フリガナ ショウジ', cl.client_name_kana)
  must(await admin.put(`/api/admin/clients/${CID}`, { client_name: cname, client_name_kana: 'ﾌﾘｶﾞﾅｼｮｳｼﾞ　ｶﾌﾞｼｷｶﾞｲｼｬ' }), 'put kana')
  cl = must(await admin.get(`/api/admin/clients/${CID}`), 'client').client
  ok('#9964 半角カナ・全角の空白もそろえる', cl.client_name_kana === 'フリガナショウジ カブシキガイシャ', cl.client_name_kana)
  ok('#9964 フリガナが長すぎると 400', (await admin.put(`/api/admin/clients/${CID}`, { client_name: cname, client_name_kana: 'ア'.repeat(101) })).status === 400)
  must(await admin.put(`/api/admin/clients/${CID}`, { client_name: cname, memo: 'メモだけ' }), 'put memo')
  ok('#9964 フリガナを送らない保存では、フリガナは変わらない', must(await admin.get(`/api/admin/clients/${CID}`), 'client').client.client_name_kana === 'フリガナショウジ カブシキガイシャ')
  must(await admin.post(`/api/admin/clients/${CID}/contacts`, { contact_name: '山田 太郎', contact_name_kana: 'やまだ たろう' }), 'contact')
  let ct = must(await admin.get(`/api/admin/clients/${CID}`), 'client').contacts[0]
  ok('#9964 顧客担当者のフリガナを保存できる（カタカナにそろえる）', ct.contact_name_kana === 'ヤマダ タロウ', ct)
  must(await admin.put(`/api/admin/clients/contacts/${ct.contact_id}`, { contact_name: '山田 太郎', contact_name_kana: '' }), 'contact put')
  ct = must(await admin.get(`/api/admin/clients/${CID}`), 'client').contacts[0]
  ok('#9964 顧客担当者のフリガナは空欄で消せる', ct.contact_name_kana == null, ct)
  must(await admin.put(`/api/admin/clients/contacts/${ct.contact_id}`, { contact_name: '山田 太郎', contact_name_kana: 'ヤマダ タロウ' }), 'contact put 2')
  ok('#9964 顧客担当者のフリガナが長すぎると 400', (await admin.post(`/api/admin/clients/${CID}/contacts`, { contact_name: 'x', contact_name_kana: 'ア'.repeat(101) })).status === 400)
  const lc = must(await admin.get('/api/admin/clients'), 'clients').clients.find(c => c.client_id === CID)
  ok('#9964 クライアント一覧に会社名と担当者のフリガナを返す（検索に使う）', lc.client_name_kana === 'フリガナショウジ カブシキガイシャ' && lc.contact_kanas === 'ヤマダ タロウ', lc)

  const pr = await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}協力`, affiliation_name_kana: 'きょうりょく', contact_name: '佐藤', contact_name_kana: 'ｻﾄｳ' })
  ok('#9964 協力会社の登録で会社名・先方の担当者のフリガナを保存できる', pr.status === 200, pr.data)
  const PTID = pr.data.affiliation_id
  let pd = must(await admin.get(`/api/admin/roster/partners/${PTID}`), 'partner').partner
  ok('#9964 協力会社のフリガナもカタカナにそろえる', pd.affiliation_name_kana === 'キョウリョク' && pd.contact_name_kana === 'サトウ', pd)
  must(await admin.put(`/api/admin/roster/partners/${PTID}`, { contact_name_kana: 'さとう はなこ' }), 'partner put')
  pd = must(await admin.get(`/api/admin/roster/partners/${PTID}`), 'partner').partner
  ok('#9964 先方の担当者のフリガナだけを直せる（ほかの項目は変わらない）', pd.contact_name_kana === 'サトウ ハナコ' && pd.affiliation_name_kana === 'キョウリョク' && pd.contact_name === '佐藤', pd)
  ok('#9964 協力会社のフリガナが長すぎると 400', (await admin.put(`/api/admin/roster/partners/${PTID}`, { affiliation_name_kana: 'ア'.repeat(101) })).status === 400)
  const pl = must(await admin.get('/api/admin/roster/partners'), 'partners').partners.find(p => p.affiliation_id === PTID)
  ok('#9964 協力会社の一覧にフリガナを返す', pl && pl.affiliation_name_kana === 'キョウリョク' && pl.contact_name_kana === 'サトウ ハナコ', pl)

  // 検索（画面の matchesKeyword）: ひらがな・カタカナどちらでも引ける
  const ad = src('public/static/admin.js'), ro = src('public/static/roster.js')
  const fnSrc = (s, name) => { const i = s.indexOf(`function ${name}(`); let d = 0, j = s.indexOf('{', i); for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break } return s.slice(i, j + 1) }
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc(ad, 'searchNorm') + '\n' + fnSrc(ad, 'matchesKeyword'), ctx)
  ok('#9964 一覧の検索はフリガナでも引ける（ひらがなで入れても、カタカナのフリガナに当たる）', ctx.matchesKeyword('ふりがな', [cname, 'フリガナショウジ']) && ctx.matchesKeyword('ヤマダ', ['山田', 'ヤマダ タロウ']) && !ctx.matchesKeyword('すずき', ['山田', 'ヤマダ']))
  ok('#9964 クライアント一覧の検索の対象に会社名・担当者のフリガナを入れる', ad.includes('c.client_name, c.client_name_kana,') && ad.includes('c.contact_names, c.contact_kanas,'))
  ok('#9964 協力会社一覧の検索の対象に会社名・担当者のフリガナを入れる', ro.includes('p.affiliation_name, p.affiliation_name_kana,') && ro.includes('p.contact_name, p.contact_name_kana,'))
  ok('#9964 入力欄: クライアントの登録・編集・顧客担当者・協力会社の登録・編集・先方の担当者', ['nc-name-kana', 'cl-name-kana', 'cc-name-kana'].every(id => ad.includes(`id="${id}"`) || ad.includes(`'${id}'`)) && ['pt-name-kana', 'pc-name-kana'].every(id => ro.includes(`'${id}'`)))
  ok('#9964 0106: 列を足すだけ（NULL 可。DROP しない）', /ALTER TABLE clients ADD COLUMN client_name_kana TEXT;/.test(src('migrations/0106_kana_fields.sql')) && !/DROP/i.test(src('migrations/0106_kana_fields.sql').replace(/^--.*$/gm, '')))
}

// ---------- #9963 実績分析の絞り込み（スタッフ） ----------
{
  const q = (extra) => `/api/admin/analytics?month=${MONTH}&project_id=${PID}${extra || ''}`
  const all = must(await admin.get(q()), 'analytics')
  ok('（前提）この案件の日報は A 2件・B 1件', all.totals.reports === 3 && all.by_staff.length === 2, all.totals)
  ok('#9963 絞り込みの選択肢に、この月・この案件に日報のある人（日報の多い順）を返す', Array.isArray(all.staff_options) && all.staff_options.length === 2 && all.staff_options[0].staff_id === A.staff_id && all.staff_options[0].reports === 2, all.staff_options)
  const fa = must(await admin.get(q(`&staff_ids=${A.staff_id}`)), 'analytics A')
  ok('#9963 スタッフで絞ると、合計・スタッフ別・日別が選んだ人の日報だけになる', fa.totals.reports === 2 && fa.totals.values.w24sales === 7 && fa.by_staff.length === 1 && fa.by_staff[0].staff_id === A.staff_id && fa.daily.reduce((n, d) => n + d.reports, 0) === 2, fa)
  ok('#9963 選んだ人の名前（staff_filter）を返し、選択肢は絞り込みに関係なく出す', fa.staff_filter.length === 1 && fa.staff_filter[0].name === `${PFX} Aさん` && fa.staff_options.length === 2, fa.staff_filter)
  const both = must(await admin.get(q(`&staff_ids=${A.staff_id},${B.staff_id}`)), 'analytics AB')
  ok('#9963 複数の人で絞れる', both.totals.reports === 3 && both.totals.values.w24sales === 17, both.totals)
  const allp = must(await admin.get(`/api/admin/analytics?month=${MONTH}&staff_ids=${B.staff_id}`), 'analytics all projects B')
  ok('#9963 全案件のときもスタッフで絞れる', allp.totals.reports === 1 && allp.by_project.length === 1 && allp.by_project[0].project_id === PID, allp.totals)
  ok('#9963 staff_id（1人）の形でも絞れる', must(await admin.get(q(`&staff_id=${B.staff_id}`)), 'single').totals.reports === 1)
  ok('#9963 スタッフの指定が数でないと 400', (await admin.get(q('&staff_ids=abc'))).status === 400)
  ok('#9963 31人以上を選ぶと 400', (await admin.get(q('&staff_ids=' + Array.from({ length: 31 }, (_, i) => i + 1).join(',')))).status === 400)

  const s = (extra) => `/api/admin/analytics/series?from=${MONTH}&to=${MONTH}&unit=day&project_id=${PID}&metric=field&key=w24sales${extra || ''}`
  const sa = must(await admin.get(s(`&split=none&staff_ids=${A.staff_id}`)), 'series A')
  ok('#9963 グラフもページの上のスタッフの絞り込みに従う', sa.total_sum === 7 && sa.staff_ids.length === 1, sa)
  const sp = must(await admin.get(s(`&split=staff&staff_ids=${A.staff_id},${B.staff_id}&ids=${A.staff_id},${B.staff_id}`)), 'series split')
  ok('#9963 グラフのスタッフ別は、選んだ人を並べる（「ほか」は出ない）', sp.series.length === 2 && sp.other === null && sp.total_sum === 17, sp)
  const sb = must(await admin.get(s(`&split=staff&staff_ids=${B.staff_id}`)), 'series B')
  ok('#9963 グラフのスタッフ別でも、選んでいない人は数えない', sb.total_sum === 10 && sb.series.length === 1 && sb.series[0].id === B.staff_id && sb.other === null, sb)
  ok('#9963 グラフでもスタッフの指定が正しくなければ 400', (await admin.get(s('&staff_ids=x'))).status === 400)

  const csv = await admin.get(`/api/admin/analytics/csv?month=${MONTH}&project_id=${PID}&by=staff&staff_ids=${A.staff_id}`)
  ok('#9963 CSV も同じ条件になる（選んだ人の行だけ。ファイル名に人数）', csv.status === 200 && csv.text.includes(`${PFX} Aさん`) && !csv.text.includes(`${PFX} Bさん`) && decodeURIComponent(csv.headers.get('content-disposition') || '').includes('_スタッフ1人_'), csv.text.slice(0, 300))
  const csvd = await admin.get(`/api/admin/analytics/csv?month=${MONTH}&project_id=${PID}&by=daily&staff_ids=${B.staff_id}`)
  ok('#9963 日別の CSV も選んだ人の日報だけ', csvd.status === 200 && csvd.text.includes(`${today},1,`) && csvd.text.includes(',10'), csvd.text)
  ok('#9963 CSV でもスタッフの指定が正しくなければ 400', (await admin.get(`/api/admin/analytics/csv?month=${MONTH}&by=staff&staff_ids=-1`)).status === 400)

  const ad = src('public/static/admin.js')
  ok('#9963 画面: ページの上にスタッフの絞り込みを出し、表・グラフ・CSV に同じ staff_ids を付ける', ad.includes('data-action="pickAnalyticsStaff" aria-label="スタッフで絞り込む"') && (ad.match(/\.\.\.analyticsStaffParams\(\)/g) || []).length >= 3)
  ok('#9963 画面: グラフの「対象（上位から／人を選ぶ）」は外し、ページの上の絞り込みに一本化する', !ad.includes("sel('staffMode'") && !ad.includes('比べるスタッフを選ぶ') && ad.includes('const achartStaffPicked = ()'))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
