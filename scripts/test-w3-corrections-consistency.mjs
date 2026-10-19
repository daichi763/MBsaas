// シフトの差し替え・欠勤・削除と打刻修正・報告用URLの整合（w3-corrections-consistency: #52 #68 #70 #81 #96 #101 #115 #181 #189 #252）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8811 PERSIST=<保存先> node scripts/test-w3-corrections-consistency.mjs
//   PERSIST を渡すと、API では作れない状態（シフトの日付の変更・同じ人の別企業のユーザー・送信失敗のメール）をローカルの D1 に直接書いて確かめる
//   （--local のみ。本番には接続しない）。渡さないときは、その部分を飛ばす
import { execSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:8811'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const go = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await go().catch(e => { if (e?.cause?.code === 'ECONNRESET') return go(); throw e })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const req = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    // D1 を直接書き換えている間に切れた接続を使い回すと ECONNRESET になる（サーバーには届いていない）ので、1回だけやり直す
    const r = await req().catch(e => { if (e?.cause?.code === 'ECONNRESET') return req(); throw e })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sql = (command) => execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --json --command "${command}"`, { stdio: 'pipe' }).toString()
const sqlRows = (command) => { const out = JSON.parse(sql(command)); return (Array.isArray(out) ? out[0] : out).results || [] }
// 報告用URL（ログイン不要）の取得。D1 を直接書き換えた直後の ECONNRESET は1回だけやり直す
const pubGet = async (token) => { const go = () => fetch(`${BASE}/api/public/report/${token}`); const r = await go().catch(e => { if (e?.cause?.code === 'ECONNRESET') return go(); throw e }); let data = null; try { data = await r.json() } catch { } return { status: r.status, data } }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))   // user_id 1（会社管理者）
const mgr = client(await login('sample', 'mgr01'))     // user_id 2（現場管理者）
const st3 = client(await login('sample', 'st003'))     // staff_id 3
const S3 = 3, S4 = 4
let seq = 0
async function createShift(staff_id, work_date, start_time = '10:00', end_time = '19:00') {
  const memo = `W3CC-${Date.now()}-${++seq}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id: 1, work_date, start_time, end_time, memo }), 'createShift')
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo).shift_id
}
const proxy = (id, times) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: Object.keys(times), times })
const status = (id) => admin.get(`/api/admin/shifts/${id}/report-status`).then(r => r.data)
const myList = async (cl) => (await cl.get('/api/staff/corrections')).data.corrections
const adminNotices = async (cl) => (await cl.get('/api/admin/notifications')).data.notifications

// ---------- #52 夜勤の勤務終了・退店の打刻漏れ ----------
{
  const d = addDays(today, -2)
  const N = await createShift(S3, d, '22:00', '06:00')
  must(await proxy(N, { check_in: '21:55' }), 'proxy check_in (night)')
  let r = await st3.post('/api/staff/corrections', { shift_id: N, report_type: 'check_out', kind: 'add', requested_at: `${d} 06:00`, reason: '退店の押し忘れ', dry_run: true })
  ok('#52 夜勤の退店を稼働日の日付のまま申請すると、翌日ではないかの案内が警告に出る', r.status === 200 && (r.data.warnings || []).some(w => /翌日/.test(w)), r)
  r = await st3.post('/api/staff/corrections', { shift_id: N, report_type: 'check_out', kind: 'add', requested_at: `${addDays(d, 1)} 06:00`, reason: '退店の押し忘れ', dry_run: true })
  ok('#52 翌日の日時なら警告は出ない', r.status === 200 && !(r.data.warnings || []).length, r)
  r = await st3.post('/api/staff/corrections', { shift_id: N, report_type: 'check_out', kind: 'add', requested_at: `${addDays(d, 5)} 06:00`, reason: '退店の押し忘れ', dry_run: true })
  ok('#52 稼働日の前日〜翌日の範囲外の日時は 400', r.status === 400, r)
}

// ---------- #101 #115 #81 担当者の差し替え ----------
{
  const d = addDays(today, -1)
  const X = await createShift(S3, d)
  must(await proxy(X, { check_in: '09:55' }), 'proxy check_in')
  const link = must(await admin.post(`/api/admin/shifts/${X}/report-link`, {}), 'issue link')
  ok('（前提）報告用URLは使える', (await pubGet(link.token)).status === 200)
  const rej = must(await st3.post('/api/staff/corrections', { shift_id: X, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:50`, reason: '時刻の誤り' }), 'request rej').correction_id
  must(await admin.post(`/api/admin/corrections/${rej}/reject`, { reason: '確認できません' }), 'reject')
  const pend = must(await st3.post('/api/staff/corrections', { shift_id: X, report_type: 'check_out', kind: 'add', requested_at: `${d} 19:05`, reason: '退店の押し忘れ' }), 'request pend').correction_id

  let r = await admin.put(`/api/admin/shifts/${X}`, { staff_id: S4 })
  ok('#115 報告・承認待ちのあるシフトの差し替えは確認を求める（409 need_force）', r.status === 409 && r.data.need_force && r.data.warnings.some(w => /勤怠報告/.test(w)) && r.data.warnings.some(w => /承認待ち/.test(w)), r)
  r = await admin.put(`/api/admin/shifts/${X}`, { staff_id: S4, force: true })
  ok('#101 確認して差し替えると、前の担当者の承認待ちを取り消す', r.status === 200 && r.data.cancelled_corrections === 1, r)
  const mine = await myList(st3)
  const c = mine.find(x => x.correction_id === pend)
  ok('#101 取り消した申請は理由（担当者の差し替え）付きで本人の一覧に出る', c && c.status === 'cancelled' && /差し替え/.test(c.cancel_reason_label || ''), c)
  const notes = (await st3.get('/api/staff/notifications')).data.notifications
  ok('#101 前の担当者に取り消しを知らせる', notes.some(n => n.kind === 'correction_cancelled' && n.related_id === pend), notes.slice(0, 3))
  r = await st3.post(`/api/staff/corrections/${rej}/resubmit`, { requested_at: `${d} 09:50`, reason: 'もう一度' })
  ok('#101 前の担当者は、差し替えられたシフトに再申請できない（409）', r.status === 409, r)
  r = await st3.get(`/api/staff/corrections/${rej}`)
  ok('#101 前の担当者の申請の詳細に、新しい担当者の打刻を返さない', r.status === 200 && Array.isArray(r.data.reports) && r.data.reports.length === 0, r.data && r.data.reports)
  const tl = (await st3.get(`/api/staff/attendance/timeline?from=${d}&to=${d}`)).data.shifts
  ok('（前提）前の担当者の打刻履歴にはこのシフトが出ない', !tl.some(s => s.shift_id === X), tl)
  const st = await status(X)
  ok('#81 差し替えると前の担当者の報告用URLは画面に出さない（再発行できる）', st.token === null, st.token)
  ok('#81 前の担当者の報告用URLは使えない', (await pubGet(link.token)).status !== 200)
  const again = must(await admin.post(`/api/admin/shifts/${X}/report-link`, {}), 'issue link again')
  ok('#81 新しい担当者の報告用URLを発行できる（前のURLとは別）', again.token && again.token !== link.token, again)
  if (PERSIST) {
    const rows = sqlRows(`SELECT staff_id FROM attendance_reports WHERE shift_id = ${X}`)
    ok('#115 報告の staff_id を新しい担当者に付け替える', rows.length > 0 && rows.every(x => x.staff_id === S4), rows)
    // 承認待ちのまま担当者だけが変わった古いデータ（移行前）は承認できない
    const Y = await createShift(S3, addDays(today, -6))
    must(await proxy(Y, { check_in: '10:00' }), 'proxy Y')
    const cy = must(await st3.post('/api/staff/corrections', { shift_id: Y, report_type: 'check_out', kind: 'add', requested_at: `${addDays(today, -6)} 19:00`, reason: 'x' }), 'request Y').correction_id
    sql(`UPDATE shifts SET staff_id = ${S4} WHERE shift_id = ${Y}`)
    r = await admin.post(`/api/admin/corrections/${cy}/approve`, {})
    ok('#101 担当者が変わったシフトの申請は承認できない（409）', r.status === 409 && /担当者/.test(r.data.error), r)
  }
}

// ---------- #70 欠勤・削除 ----------
{
  const d = addDays(today, -3)
  const V = await createShift(S3, d)
  const cv = must(await st3.post('/api/staff/corrections', { shift_id: V, report_type: 'check_in', kind: 'add', requested_at: `${d} 10:00`, reason: '入店の押し忘れ' }), 'request V').correction_id
  let r = await admin.put(`/api/admin/shifts/${V}`, { status: 'absent' })
  ok('#70 承認待ちのあるシフトを欠勤にすると、承認待ちの件数を返す', r.status === 200 && r.data.pending_corrections === 1, r)
  r = await admin.post(`/api/admin/corrections/${cv}/approve`, {})
  ok('#70 欠勤のシフトの申請は承認できない（409）', r.status === 409 && /欠勤/.test(r.data.error), r)
  ok('#70 欠勤のシフトに打刻は入らない', !(await status(V)).reports.length)

  const U = await createShift(S3, addDays(today, -4))
  const cu = must(await st3.post('/api/staff/corrections', { shift_id: U, report_type: 'check_in', kind: 'add', requested_at: `${addDays(today, -4)} 10:00`, reason: '入店の押し忘れ' }), 'request U').correction_id
  const before = (await admin.get('/api/admin/corrections/pending-count')).data.count
  r = await admin.del(`/api/admin/shifts/${U}`)
  ok('#70 承認待ちのあるシフトを削除できる（承認待ちは取り消し）', r.status === 200 && r.data.cancelled_corrections === 1, r)
  const after = (await admin.get('/api/admin/corrections/pending-count')).data.count
  ok('#70 削除したシフトの申請は承認待ちの件数に残らない', after === before - 1, { before, after })
  const c = (await myList(st3)).find(x => x.correction_id === cu)
  ok('#70 本人の一覧に『シフトが削除されたため』取り消しと出る', c && c.status === 'cancelled' && /削除/.test(c.cancel_reason_label || ''), c)
  const detail = (await admin.get(`/api/admin/corrections/${cu}`)).data
  ok('#70 操作履歴に自動の取り消しが残る', detail.events.some(e => e.event === 'cancelled' && e.detail && e.detail.auto && e.detail.reason === 'shift_deleted'), detail.events)
}

// ---------- #252 修正の印と代理入力の取消 / #181 管理者が出した修正の本人への通知 ----------
{
  const d = addDays(today, -5)
  const W = await createShift(S3, d)
  must(await proxy(W, { check_in: '10:00', check_out: '19:00' }), 'proxy W')
  // #181: 管理者が申請して承認
  const ca = must(await admin.post('/api/admin/corrections', { shift_id: W, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:58`, reason: '現場からの連絡で修正' }), 'admin request').correction_id
  must(await admin.post(`/api/admin/corrections/${ca}/approve`, {}), 'admin approve')
  const notes = (await st3.get('/api/staff/notifications')).data.notifications
  ok('#181 管理者が出して承認した修正は、記録が変わったスタッフ本人に通知する', notes.some(n => n.kind === 'correction_changed_by_admin' && n.related_id === ca && /管理者があなたの打刻を修正/.test(n.title)), notes.slice(0, 3))
  // #252: スタッフの時刻修正を承認
  const cs = must(await st3.post('/api/staff/corrections', { shift_id: W, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:30`, reason: '退店の時刻の誤り' }), 'staff request').correction_id
  must(await mgr.post(`/api/admin/corrections/${cs}/approve`, {}), 'approve')
  const rep = (await status(W)).reports.find(x => x.report_type === 'check_out')
  ok('#252 時刻修正の承認で修正の印を付け、元の打刻の方法と日時を残す', rep && rep.reported_at === `${d} 19:30:00` && rep.entry_method === 'proxy' && rep.corrected_by_correction_id === cs && rep.original_reported_at === `${d} 19:00:00`, rep)
  const tl = (await st3.get(`/api/staff/attendance/timeline?from=${d}&to=${d}`)).data.shifts.find(s => s.shift_id === W)
  const tr = tl && tl.reports.find(x => x.report_type === 'check_out')
  ok('#252 打刻履歴にも修正の印と元の日時を返す', tr && tr.corrected_by_correction_id === cs && tr.original_reported_at === `${d} 19:00:00`, tr)
  let r = await admin.del(`/api/admin/shifts/${W}/proxy-attendance/check_out`)
  ok('#252 承認済みの修正がある代理入力は取り消せない（409）', r.status === 409, r)
  ok('#252 取り消しを拒否した報告は残る', (await status(W)).reports.some(x => x.report_type === 'check_out'))
  // #189: 承認・取り消しの後は、ほかの管理者の承認依頼を既読にする
  const ad = (await adminNotices(admin)).find(n => n.kind === 'correction_submitted' && n.related_id === cs)
  ok('#189 ほかの管理者が承認した申請の承認依頼は既読になり、処理済みと分かる', ad && ad.read_at && ad.correction_status === 'approved' && ad.correction_decided_by, ad)
  const cc = must(await st3.post('/api/staff/corrections', { shift_id: W, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:59`, reason: 'x' }), 'request to cancel').correction_id
  const unreadBefore = (await adminNotices(admin)).find(n => n.kind === 'correction_submitted' && n.related_id === cc)
  must(await st3.post(`/api/staff/corrections/${cc}/cancel`), 'cancel')
  const ad2 = (await adminNotices(admin)).find(n => n.kind === 'correction_submitted' && n.related_id === cc)
  ok('#189 本人が取り消した申請の承認依頼は既読になる', unreadBefore && !unreadBefore.read_at && ad2 && ad2.read_at && ad2.correction_status === 'cancelled', { unreadBefore, ad2 })
  if (PERSIST) {
    sql(`UPDATE notification_emails SET status = 'failed', error = 'resend_error' WHERE correction_id = ${cs} AND kind = 'correction_submitted'`)
    const del = sqlRows(`SELECT delivery_id FROM notification_emails WHERE correction_id = ${cs} AND kind = 'correction_submitted' LIMIT 1`)[0]
    if (del) {
      r = await admin.post(`/api/admin/notification-emails/${del.delivery_id}/resend`)
      ok('#189 処理済みの申請の承認依頼メールは再送しない（409）', r.status === 409 && r.data.reason === 'already_processed', r)
    }
  }
}

// ---------- #68 報告用URLの有効期限はシフトの今の稼働日から ----------
{
  const T = await createShift(S3, today)
  const link = must(await admin.post(`/api/admin/shifts/${T}/report-link`, {}), 'issue link T')
  ok('#68 有効期限は稼働日の翌日 23:59', link.expires_at === `${addDays(today, 1)} 23:59:59`, link)
  if (PERSIST) {
    // シフトの移動（枠の日付の変更）と同じ状態にする
    sql(`UPDATE shifts SET work_date = '${addDays(today, 5)}' WHERE shift_id = ${T}`)
    const pub = await pubGet(link.token)
    ok('#68 シフトの日付を後ろに変えても、新しい稼働日の翌日まで使える', pub.status === 200 && pub.data.expires_at === `${addDays(today, 6)} 23:59:59`, pub)
    sql(`UPDATE shifts SET work_date = '${addDays(today, -3)}' WHERE shift_id = ${T}`)
    ok('#68 シフトの日付を前に変えると、その稼働日の翌日を過ぎていれば使えない', (await pubGet(link.token)).status !== 200)
  }
}

// ---------- #96 所属企業を切り替えても自分の申請・通知を扱える ----------
if (PERSIST) {
  // 伊藤 翔太（user 8 / staff 5。ほかのテストで退職にしない人）と同じ人のユーザーを会社3に作る（人の ID が無ければ付ける）
  sql(`INSERT OR IGNORE INTO persons (person_id, global_staff_code, created_company_id) VALUES ('w3cc0000000000000000000000000005', 'FSW3CC0005', 1)`)
  sql(`UPDATE users SET person_id = 'w3cc0000000000000000000000000005' WHERE user_id = 8 AND person_id IS NULL`)
  sql(`UPDATE staff_profiles SET person_id = (SELECT person_id FROM users WHERE user_id = 8) WHERE user_id = 8 AND person_id IS NULL`)
  sql(`INSERT INTO users (user_id, company_id, user_code, name, role, password_hash, status, person_id) SELECT 9301, 3, 'w3cc01', name, 'staff', password_hash, 'active', person_id FROM users WHERE user_id = 8 AND NOT EXISTS (SELECT 1 FROM users WHERE user_id = 9301)`)
  sql(`INSERT INTO staff_profiles (user_id, company_id, person_id) SELECT 9301, 3, person_id FROM users WHERE user_id = 8 AND NOT EXISTS (SELECT 1 FROM staff_profiles WHERE user_id = 9301)`)
  sql(`UPDATE users SET person_id = (SELECT person_id FROM users WHERE user_id = 8), status = 'active' WHERE user_id = 9301`)
  sql(`UPDATE staff_profiles SET person_id = (SELECT person_id FROM users WHERE user_id = 8) WHERE user_id = 9301`)
  const st1 = client(await login('sample', 'st005'))
  const d = addDays(today, -7)
  const Z = await createShift(5, d)
  const cz = must(await st1.post('/api/staff/corrections', { shift_id: Z, report_type: 'check_out', kind: 'add', requested_at: `${d} 19:00`, reason: '退店の押し忘れ' }), 'request Z').correction_id
  const sw = await st1.post('/api/staff/me/switch-company', { company_id: 3 })
  ok('（前提）同じ人の別の企業に切り替えられる', sw.status === 200, sw)
  if (sw.status !== 200) throw new Error('switch-company failed')
  const list = await myList(st1)
  ok('#96 切り替えた後も、自分の出した申請は本人の申請（取り消せる）として出る', list.some(x => x.correction_id === cz && x.mine), list.slice(0, 3))
  const notes = (await st1.get('/api/staff/notifications')).data.notifications
  ok('#96 切り替えた後も、切り替える前のユーザーあての通知が見える', notes.some(n => n.related_id === cz && n.kind === 'correction_received'), notes.slice(0, 3))
  const r = await st1.post(`/api/staff/corrections/${cz}/cancel`)
  ok('#96 切り替えた後も、自分の申請を取り消せる', r.status === 200, r)
  await st1.post('/api/staff/me/switch-company', { company_id: 1 })
  // 後で流す別のテストに影響しないよう、作ったユーザーを止める
  sql(`UPDATE users SET status = 'suspended' WHERE user_id = 9301`)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
