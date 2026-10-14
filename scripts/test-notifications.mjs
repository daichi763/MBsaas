// 打刻修正申請の通知（docs/spec_attendance_correction.md 5章）の統合テスト
// 前提: bash scripts/setup-test-db.sh でローカルの D1 を作り直し、`wrangler dev` で起動していること。
//   ローカルでは RESEND_API_KEY が未設定のため、メールは実際には送られず「送信失敗（mail_not_configured）」として記録される。
// 実行:
//   1) node scripts/test-notifications.mjs                     （通常の起動: 通知・送信失敗の記録・再送の失敗）
//   2) wrangler dev を --var MAIL_ENABLED:false で起動し直して
//      node scripts/test-notifications.mjs --mail-disabled     （再送の成功・送信済みの再送拒否）
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const MAIL_DISABLED = process.argv.includes('--mail-disabled')
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))  // 会社管理者
const mgr = client(await login('sample', 'mgr01'))    // 現場管理者
const st1 = client(await login('sample', 'st001'))
const st2 = client(await login('sample', 'st002'))
const notes = async (cl) => (await cl.get(cl === admin || cl === mgr ? '/api/admin/notifications' : '/api/staff/notifications')).data
// メールは waitUntil で送るため、送信状態が pending でなくなるまで待つ
async function deliveriesOf(cid) {
  for (let i = 0; i < 20; i++) {
    const all = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.filter(d => d.correction_id === cid)
    if (all.length && all.every(d => d.status !== 'pending')) return all
    await sleep(300)
  }
  return (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.filter(d => d.correction_id === cid)
}

if (MAIL_DISABLED) {
  const failed = (await admin.get('/api/admin/notification-emails?status=failed')).data.deliveries
  ok('（前提）送信失敗のメールがある', failed.length > 0, failed.length)
  const d = failed[0]
  const r = await admin.post(`/api/admin/notification-emails/${d.delivery_id}/resend`)
  ok('再送が成功すると送信済みになる', r.status === 200 && r.data.sent === true, r)
  const after = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.find(x => x.delivery_id === d.delivery_id)
  ok('再送の結果（送信済み・試行回数・再送した人）が記録される', after.status === 'sent' && after.attempts === d.attempts + 1 && after.last_attempt_by_name && !after.error, after)
  const again = await admin.post(`/api/admin/notification-emails/${d.delivery_id}/resend`)
  ok('送信済みのメールは再送しない（409）', again.status === 409, again)
  const d2 = failed[1]
  const [x, y] = await Promise.all([admin.post(`/api/admin/notification-emails/${d2.delivery_id}/resend`), mgr.post(`/api/admin/notification-emails/${d2.delivery_id}/resend`)])
  const after2 = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.find(z => z.delivery_id === d2.delivery_id)
  ok('同じメールを同時に再送しても送るのは 1 回だけ', [x.status, y.status].filter(s => s === 200).length === 1 && after2.status === 'sent' && after2.attempts === d2.attempts + 1, [x.status, y.status, after2.attempts])
} else {
  const dA = addDays(today, -4)
  const sr = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 3, work_date: dA, start_time: '10:00', end_time: '19:00', memo: 'NT-A' })
  const A = (await admin.get(`/api/admin/shifts?from=${dA}&to=${dA}`)).data.shifts.find(x => x.memo === 'NT-A').shift_id
  ok('（前提）シフト作成', sr.status === 200 && A)
  const before = { admin: (await notes(admin)).notifications.length, mgr: (await notes(mgr)).notifications.length, st2: (await notes(st2)).notifications.length }

  // ---------- 申請 ----------
  const r = await st1.post('/api/staff/corrections', { shift_id: A, report_type: 'check_in', kind: 'add', requested_at: `${dA} 09:58`, reason: '入店報告を忘れた' })
  ok('（前提）スタッフが申請', r.status === 200, r)
  const cid = r.data.correction_id
  const na = await notes(admin), nm = await notes(mgr), ns = await notes(st1), n2 = await notes(st2)
  const req = na.notifications.find(n => n.related_id === cid)
  ok('申請: 管理者全員にアプリ内通知（承認依頼）', req && req.kind === 'correction_submitted' && nm.notifications.some(n => n.related_id === cid && n.kind === 'correction_submitted'), [req, nm.notifications[0]])
  ok('申請: 通知に案件名・スタッフ名・報告・対象日時・修正理由が入る', req && /佐藤/.test(req.title) && /入店報告/.test(req.title) && /案件: /.test(req.body) && /09:58/.test(req.body) && /入店報告を忘れた/.test(req.body), req)
  ok('申請: リンクは打刻修正承認の詳細', req && req.link === `/admin#corrections/${cid}`, req && req.link)
  ok('申請: 申請者本人に受付の通知', ns.notifications.some(n => n.related_id === cid && n.kind === 'correction_received' && n.link === '/staff#attendance'), ns.notifications[0])
  ok('申請: 関係のないスタッフには通知しない', n2.notifications.length === before.st2, n2.notifications.length)
  ok('申請: 未読件数', na.unread > 0 && ns.unread > 0, [na.unread, ns.unread])
  const ds = await deliveriesOf(cid)
  ok('申請: メールは宛先ごとに記録される（メールアドレスのある人のみ）', ds.length >= 2 && ds.every(d => d.event === 'submitted'), ds.map(d => [d.recipient_name, d.status]))
  ok('メール送信に失敗しても申請は保存されている', ds.every(d => d.status === 'failed' && d.error === 'mail_not_configured') && (await admin.get(`/api/admin/corrections/${cid}`)).data.correction.status === 'pending', ds.map(d => [d.status, d.error]))

  // ---------- 承認 ----------
  const ap = await mgr.post(`/api/admin/corrections/${cid}/approve`, { comment: '確認済み' })
  ok('（前提）現場管理者が承認', ap.status === 200, ap)
  const ns2 = await notes(st1), nm2 = await notes(mgr), na2 = await notes(admin)
  const res = ns2.notifications.find(n => n.related_id === cid && n.kind === 'correction_approved')
  ok('承認: 申請者に結果の通知（承認者・コメント付き）', res && /承認/.test(res.title) && /確認済み/.test(res.body) && /承認者: /.test(res.body), res)
  ok('承認: 処理した管理者に控えの通知', nm2.notifications.some(n => n.related_id === cid && n.kind === 'correction_processed'), nm2.notifications[0])
  ok('承認: 処理していない管理者には結果を通知しない', !na2.notifications.some(n => n.related_id === cid && n.kind !== 'correction_submitted'), na2.notifications.filter(n => n.related_id === cid).map(n => n.kind))
  const dsA = (await deliveriesOf(cid)).filter(d => d.event === 'approved')
  ok('承認: メールの送信状態が記録される', dsA.length === 2, dsA.map(d => [d.recipient_name, d.kind, d.status]))

  // ---------- 却下・再申請 ----------
  const r2 = await st1.post('/api/staff/corrections', { shift_id: A, report_type: 'check_out', kind: 'add', requested_at: `${dA} 19:10`, reason: '退店報告を忘れた' })
  const cid2 = r2.data.correction_id
  await admin.post(`/api/admin/corrections/${cid2}/reject`, { reason: '時刻が店舗の記録と違います' })
  const rej = (await notes(st1)).notifications.find(n => n.related_id === cid2 && n.kind === 'correction_rejected')
  ok('却下: 申請者に却下の理由付きで通知', rej && /却下/.test(rej.title) && /時刻が店舗の記録と違います/.test(rej.body), rej)
  const re = await st1.post(`/api/staff/corrections/${cid2}/resubmit`, { requested_at: `${dA} 19:05`, reason: '店舗の記録に合わせた' })
  const reN = (await notes(admin)).notifications.find(n => n.related_id === re.data.correction_id && n.kind === 'correction_submitted')
  ok('再申請: 管理者に承認依頼の通知', re.status === 200 && reN, [re.status, reN])
  const dry = await st1.post('/api/staff/corrections', { shift_id: A, report_type: 'work_start', kind: 'add', requested_at: `${dA} 10:00`, reason: 'x', dry_run: true })
  const dryN = (await notes(admin)).notifications.filter(n => /勤務開始/.test(n.title))
  ok('確認（dry_run）では通知しない', dry.status === 200 && dryN.length === 0, dryN.length)

  // ---------- 既読・権限 ----------
  const mine = (await notes(st1)).notifications[0]
  const steal = await st2.post(`/api/staff/notifications/${mine.notification_id}/read`)
  ok('他人の通知は既読にできない（404）', steal.status === 404, steal)
  const before1 = (await notes(st1)).unread
  const rd = await st1.post(`/api/staff/notifications/${mine.notification_id}/read`)
  ok('既読にすると未読件数が減る', rd.status === 200 && (await notes(st1)).unread === before1 - 1, [before1, (await notes(st1)).unread])
  await admin.post('/api/admin/notifications/read-all')
  ok('すべて既読', (await admin.get('/api/admin/notifications/unread-count')).data.count === 0)
  const forbid = await st1.get('/api/admin/notification-emails')
  ok('スタッフは送信状況を見られない（403）', forbid.status === 403, forbid.status)
  const anon = await fetch(`${BASE}/api/staff/notifications`)
  ok('未ログインは 401', anon.status === 401, anon.status)

  // ---------- 再送 ----------
  const failed = (await admin.get('/api/admin/notification-emails?status=failed')).data.deliveries
  ok('送信失敗の一覧に出る（宛先・申請・理由・試行回数）', failed.length > 0 && failed.every(d => d.to_email && d.correction_id && d.error && d.attempts >= 1), failed[0])
  const d = failed[0]
  const rs = await admin.post(`/api/admin/notification-emails/${d.delivery_id}/resend`)
  const after = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.find(x => x.delivery_id === d.delivery_id)
  ok('再送の失敗も記録される（成功扱いにしない・試行回数が増える・再送した人）', rs.status === 200 && rs.data.sent === false && after.status === 'failed' && after.attempts === d.attempts + 1 && after.last_attempt_by_name, [rs.data, after])
}

const failedTests = results.filter(r => !r.pass)
console.log(`\n${results.length - failedTests.length} / ${results.length} passed`)
process.exit(failedTests.length ? 1 : 0)
