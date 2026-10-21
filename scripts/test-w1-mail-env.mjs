// w1-mail-env（#24 #105 #128 #260 #457）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8815 --persist-to <保存先> --var MAIL_ENABLED:true で起動していること。
//   ローカルでは RESEND_API_KEY が未設定のため、メールは実際には送られず「送信失敗（mail_not_configured）」として記録される。
//   （MAIL_ENABLED:false の既定で起動した場合は「送信停止中（skipped）」として記録される。#260 の確認は MAIL_ENABLED:true のときだけ行う）
// 実行: BASE=http://127.0.0.1:8815 node scripts/test-w1-mail-env.mjs
// 【注意】MAIL_ENABLED を true にせずに起動すると、メールは「送信停止中（skipped）」になり、#260 の確認は SKIP になる（9005）。
//   npm test（scripts/run-tests.mjs）は上の --var を読んで起動に付けるので、そのままで #260 まで確かめる。手で流すときは必ず付けて起動する
const BASE = process.env.BASE || 'http://127.0.0.1:8815'
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
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const uid = () => Math.random().toString(36).slice(2)

const admin = client(await login('sample', 'admin'))

// ---------- #457 本部の標準日報テンプレート（マイグレーションで投入） ----------
{
  const tp = (await admin.get('/api/admin/templates')).data.templates
  const names = ['携帯ショップ稼働テンプレート', '家電量販店稼働テンプレート', '催事・イベント稼働テンプレート', '光回線・固定回線テンプレート']
  ok('#457 標準テンプレート4種が本部テンプレートとして入っている（各1件）', names.every(n => tp.filter(t => t.template_name === n && t.company_id === null && t.template_type === 'hq').length === 1), tp.map(t => [t.template_id, t.template_name]))
  ok('#457 seed の案件が参照する ID 1〜4 がそのテンプレート', [1, 2, 3, 4].every((id, i) => tp.find(t => t.template_id === id)?.template_name === names[i]), tp.map(t => [t.template_id, t.template_name]))
  ok('#457 テンプレートの項目が読める', tp.filter(t => names.includes(t.template_name)).every(t => JSON.parse(t.fields_json).length > 0))
}

// ---------- #24 #105 お知らせの配信とメール送信結果 ----------
async function deliveriesOf(cl, noticeId) {
  for (let i = 0; i < 30; i++) {
    const r = await cl.get(`/api/admin/notices/${noticeId}/email-deliveries`)
    if (r.status === 200 && r.data.deliveries.every(d => d.status !== 'pending')) return r
    await sleep(300)
  }
  return cl.get(`/api/admin/notices/${noticeId}/email-deliveries`)
}
let mode = null
{
  const before = (await admin.get('/api/admin/notices')).data.notices.length
  const key = uid()
  const body = { title: `テスト配信 ${key}`, body: '本文', target_type: 'all', target_ids: '', importance: 'normal', read_required: false, send_email: true, client_request_id: key }
  // 二度押し: 同じキーで同時に2回送る → 1件だけ配信される
  const [a, b] = await Promise.all([admin.post('/api/admin/notices', body), admin.post('/api/admin/notices', body)])
  const okOne = [a, b].filter(r => r.status === 200)
  const dupOne = [a, b].filter(r => r.status === 409)
  ok('#105 同じキーで同時に2回配信しても1件だけ受け付ける（もう一方は409）', okOne.length === 1 && dupOne.length === 1 && dupOne[0].data.duplicate === true, [a.status, b.status, dupOne[0]?.data])
  const res = okOne[0]?.data || {}
  const list = (await admin.get('/api/admin/notices')).data.notices
  ok('#105 お知らせは1件だけ増える', list.length === before + 1 && list.filter(n => n.title === body.title).length === 1, [before, list.length])
  ok('#105 一覧に client_request_id を出さない', list.every(n => !('client_request_id' in n)))
  const again = await admin.post('/api/admin/notices', body)
  ok('#105 同じキーで後から送っても409', again.status === 409 && again.data.duplicate, again)
  const noKey = await admin.post('/api/admin/notices', { ...body, client_request_id: undefined })
  ok('#105 キーが無くても、同じ人が同じ内容を直前に配信していれば409', noKey.status === 409 && noKey.data.duplicate, noKey)
  const other = await admin.post('/api/admin/notices', { ...body, title: body.title + ' 別件', client_request_id: uid(), send_email: false })
  ok('別の内容・別のキーなら配信できる（メールなしは email=null）', other.status === 200 && other.data.email === null, other)

  // 送信結果
  const e = res.email || {}
  mode = e.mode
  const staffActive = list.find(n => n.notice_id === res.notice_id)?.staff_total
  ok('#24 応答に送信対象・メール未登録の人数が入る', e.targets > 0 && e.with_email + e.no_email === e.targets && typeof e.mode === 'string', e)
  ok('#24 対象者数は全スタッフ（在籍中）と同じ', e.targets === staffActive, [e.targets, staffActive])
  const d = await deliveriesOf(admin, res.notice_id)
  const ds = d.data.deliveries
  ok('#24 対象者ごとの結果が記録される', d.status === 200 && ds.length === e.targets, [d.status, ds.length])
  const expect = e.mode === 'disabled' ? 'skipped' : e.mode === 'not_configured' ? 'failed' : 'sent'
  ok(`#24 メールアドレスのある人は ${expect}、無い人は no_email`, ds.filter(x => x.status === 'no_email').length === e.no_email && ds.filter(x => x.status === expect).length === e.with_email, ds.map(x => x.status))
  if (e.mode === 'not_configured') ok('#24 失敗の理由が記録される', ds.filter(x => x.status === 'failed').every(x => x.error === 'mail_not_configured'), ds)
  ok('#24 送信結果にメールアドレスを返さない', ds.every(x => !('email' in x) && !('to_email' in x)))
  const card = (await admin.get('/api/admin/notices')).data.notices.find(n => n.notice_id === res.notice_id)
  ok('#24 お知らせ一覧に状態ごとの人数が入る', card.email_counts && Object.values(card.email_counts).reduce((s, v) => s + v, 0) === e.targets, card.email_counts)
  ok('#24 メールを送らなかったお知らせは email_counts = null', (await admin.get('/api/admin/notices')).data.notices.find(n => n.notice_id === other.data.notice_id)?.email_counts === null)
  ok('#24 存在しないお知らせの送信結果は404', (await admin.get('/api/admin/notices/999999/email-deliveries')).status === 404)
}

// ---------- #128 他社連携スタッフにもお知らせメールを送る ----------
{
  const hq = client(await login('sample', 'hq'))
  const code = 'mt' + uid().slice(0, 6)
  const cr = await hq.post('/api/hq/companies', { company_code: code, company_name: `連携テスト${code}`, admin_code: 'admin', admin_password: 'pass1234', admin_name: '連携先管理者' })
  ok('（前提）連携先の会社を作成', cr.status === 200, cr)
  const admin2 = client(await login(code, 'admin'))
  const share = await admin.get('/api/admin/roster/1/share-code')
  ok('（前提）連携用IDを取得', share.status === 200 && share.data.global_staff_code, share)
  const terms = (await admin2.get('/api/admin/roster/consent-terms')).data
  const link = await admin2.post('/api/admin/roster/link', { code: share.data.global_staff_code, agreed: true, consent_version: terms.version })
  ok('（前提）他社のスタッフを連携', link.status === 200 && link.data.staff_id, link)
  const n = await admin2.post('/api/admin/notices', { title: `連携先のお知らせ ${uid()}`, body: '集合場所変更', target_type: 'all', send_email: true, client_request_id: uid() })
  ok('#128 連携スタッフは送信対象に入る（メール未登録にならない）', n.status === 200 && n.data.email.targets === 1 && n.data.email.with_email === 1 && n.data.email.no_email === 0, n)
  const d = await deliveriesOf(admin2, n.data.notice_id)
  ok('#128 送信結果は記録されるが、所属元のメールアドレスは返さない', d.status === 200 && d.data.deliveries.length === 1 && d.data.deliveries[0].status !== 'no_email' && !JSON.stringify(d.data).includes('@'), d.data)
  ok('他社のお知らせの送信結果は見られない（404）', (await admin.get(`/api/admin/notices/${n.data.notice_id}/email-deliveries`)).status === 404)
}

// ---------- #260 停止中の宛先には再送しない ----------
if (mode === 'not_configured') {
  const st3 = client(await login('sample', 'st003'))
  const dA = addDays(today, -3)
  const memo = 'MT-' + uid()
  const sr = await admin.post('/api/admin/shifts', { staff_id: 3, project_id: 1, work_date: dA, start_time: '10:00', end_time: '19:00', memo })
  const shift = (await admin.get(`/api/admin/shifts?from=${dA}&to=${dA}`)).data.shifts.find(x => x.memo === memo)
  ok('（前提）シフト作成', sr.status === 200 && shift, sr)
  const cr = await st3.post('/api/staff/corrections', { shift_id: shift.shift_id, report_type: 'check_in', kind: 'add', requested_at: `${dA} 09:58`, reason: 'テスト' })
  ok('（前提）スタッフが打刻修正を申請', cr.status === 200, cr)
  // 自分で出した申請の受付（correction_received）は、w4-corrections-staff（#341）から既読の控えだけでメールを送らない。
  // そのため申請者あてのメールは、管理者が却下した結果の通知（correction_rejected）で確かめる。
  // 管理者あての承認依頼（correction_submitted）は、処理した後は再送しない（already_processed）ので、却下の前に再送を確かめる
  const deliveriesOf = async (kind) => {
    let ds = []
    for (let i = 0; i < 30; i++) {
      ds = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.filter(x => x.correction_id === cr.data.correction_id)
      if (ds.some(x => x.kind === kind) && ds.every(x => x.status !== 'pending')) break
      await sleep(300)
    }
    return ds
  }
  const toAdmin = (await deliveriesOf('correction_submitted')).find(x => x.kind === 'correction_submitted')
  ok('（前提）管理者あての承認依頼のメールが送信失敗になっている', toAdmin && toAdmin.status === 'failed', toAdmin)
  const r2 = toAdmin ? await admin.post(`/api/admin/notification-emails/${toAdmin.delivery_id}/resend`) : { status: 0 }
  ok('#260 在籍中の宛先へは再送する', r2.status === 200 && r2.data.ok === true, r2)
  const rj = await admin.post(`/api/admin/corrections/${cr.data.correction_id}/reject`, { reason: 'テスト' })
  ok('（前提）管理者が申請を却下', rj.status === 200, rj)
  const mine = (await deliveriesOf('correction_rejected')).find(x => x.kind === 'correction_rejected')
  ok('（前提）申請者あての通知メール（却下の結果）が送信失敗になっている', mine && mine.status === 'failed', mine)
  if (!mine) { console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`); process.exit(1) }
  // 自社雇用スタッフの退職は従業員管理から設定する
  const put = await admin.put('/api/admin/employees/3', { profile: { retired_at: addDays(today, -1) } })
  ok('（前提）申請者を退職（停止中）にする', put.status === 200, put)
  const r = await admin.post(`/api/admin/notification-emails/${mine.delivery_id}/resend`)
  ok('#260 停止中の宛先への再送は409（送らない）', r.status === 409 && r.data.reason === 'recipient_suspended', r)
  const after = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.find(x => x.delivery_id === mine.delivery_id)
  // w4-notifications-mail（#357）から、送る必要のなくなった行は「対応不要」（skipped）にする
  ok('#260 一覧の理由が「宛先が停止中」になり、試行回数は増えない', after.status === 'skipped' && after.error === 'recipient_suspended' && after.attempts === mine.attempts, after)
  await admin.put('/api/admin/employees/3', { profile: { retired_at: null, employment_status: 'working' } })
} else {
  console.log(`SKIP  #260 の確認（MAIL_ENABLED:true で起動したときだけ行う。mode=${mode}）`)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
