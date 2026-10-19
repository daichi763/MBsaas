// w4-notifications-mail（#236 #311 #357 #367 #380 #423 #438 #444 #454 #541 と持ち越し #13 #455 #570）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8823 --persist-to <保存先> \
//     --var MAIL_ENABLED:true --var RESEND_WEBHOOK_SECRET:<WEBHOOK_SECRET と同じ値> で起動していること。
//   ローカルでは RESEND_API_KEY が無いので、送るメールは「送信失敗（mail_not_configured）」として記録される。
//   PERSIST に --persist-to の保存先を指定する（送信記録・トークンの確認と準備に使う。テスト用の DB 専用）。
// 実行: BASE=http://127.0.0.1:8823 PERSIST=<保存先> node scripts/test-w4-notifications-mail.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { createHmac, createHash } from 'crypto'
const BASE = process.env.BASE || 'http://127.0.0.1:8823'
const PERSIST = process.env.PERSIST || ''
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whsec_dGVzdC13ZWJob29rLXNlY3JldC1mb3ItbWJzYWFz'
// d1() で待つ間に開発サーバーが閉じた接続を使い回すと ECONNRESET になるので、そのときは1回だけ送り直す（要求はサーバーに届いていない）
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e && e.cause && e.cause.code === 'ECONNRESET') return rawFetch(...args); throw e } }
if (!PERSIST) { console.log('PERSIST を指定してください'); process.exit(2) }
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nowJst = (minus = 0) => new Date(Date.now() + 9 * 3600 * 1000 - minus * 60000).toISOString().slice(0, 19).replace('T', ' ')
const today = nowJst().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tag = Date.now().toString(36).slice(-5)
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }

// Svix 形式の署名（src/services/email.ts の verifySvixSignature と同じ方法）
function signed(body, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000), id = 'msg_' + Math.random().toString(36).slice(2) } = {}) {
  const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' }
}
async function webhook(event, opts) {
  const body = JSON.stringify(event)
  const r = await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: signed(body, opts), body })
  return { status: r.status, data: await r.json().catch(() => null) }
}

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const hq = client(await login('sample', 'hq'))
const anon = client(null)

// ---------- #541 Webhook: 署名の確認 ----------
{
  const ev = { type: 'email.delivered', data: { email_id: 'x', to: ['a@example.com'] } }
  const body = JSON.stringify(ev)
  const bad = await fetch(`${BASE}/webhooks/resend`, { method: 'POST', headers: { ...signed(body), 'svix-signature': 'v1,AAAA' }, body })
  const old = await webhook(ev, { ts: Math.floor(Date.now() / 1000) - 3600 })
  const wrong = await webhook(ev, { secret: 'whsec_' + Buffer.from('other-secret').toString('base64') })
  const none = await fetch(`${BASE}/webhooks/resend`, { method: 'POST', body })
  await bad.text(); await none.text()
  ok('#541 署名が合わない・古い・無い Webhook は受け付けない（401）', bad.status === 401 && old.status === 401 && wrong.status === 401 && none.status === 401, [bad.status, old.status, wrong.status, none.status])
}

// ---------- #541 Webhook: 不達・迷惑メール報告・配信済みを記録し、以後は送らない ----------
const BOUNCE = `bounce-${tag}@example.com`
d1(`INSERT INTO email_logs (company_id, to_email, type, status, provider_message_id) VALUES
  (1, '${BOUNCE}', 'notice', 'sent', 'pm-b-${tag}'), (1, 'ok-${tag}@example.com', 'notice', 'sent', 'pm-d-${tag}'),
  (1, 'soft-${tag}@example.com', 'notice', 'sent', 'pm-s-${tag}'), (1, 'spam-${tag}@example.com', 'notice', 'sent', 'pm-c-${tag}'),
  (2, 'other-${tag}@example.net', 'notice', 'failed', 'pm-o-${tag}')`)
{
  const b = await webhook({ type: 'email.bounced', data: { email_id: `pm-b-${tag}`, to: [BOUNCE.toUpperCase()], bounce: { type: 'Permanent', subType: 'General', message: `Mailbox ${BOUNCE} does not exist` } } })
  const d = await webhook({ type: 'email.delivered', data: { email_id: `pm-d-${tag}`, to: [`ok-${tag}@example.com`] } })
  const s = await webhook({ type: 'email.bounced', data: { email_id: `pm-s-${tag}`, to: [`soft-${tag}@example.com`], bounce: { type: 'Transient', message: 'mailbox full' } } })
  const c = await webhook({ type: 'email.complained', data: { email_id: `pm-c-${tag}`, to: [`spam-${tag}@example.com`] } })
  const again = await webhook({ type: 'email.bounced', data: { email_id: `pm-b-${tag}`, to: [BOUNCE], bounce: { type: 'Permanent' } } })
  ok('#541 署名の合う Webhook を受け付ける（同じイベントの2回目も 200）', [b, d, s, c, again].every(r => r.status === 200), [b, d, s, c, again].map(r => r.status))
  const [logs] = d1(`SELECT provider_message_id AS id, status, error_message FROM email_logs WHERE provider_message_id LIKE 'pm-%-${tag}' ORDER BY log_id`)
  const st = Object.fromEntries(logs.map(l => [l.id, l]))
  ok('#541 送信の記録が 不達・配信済み・一時的な不達・迷惑メール報告 になる', st[`pm-b-${tag}`].status === 'bounced' && st[`pm-d-${tag}`].status === 'delivered' && st[`pm-s-${tag}`].status === 'bounced_soft' && st[`pm-c-${tag}`].status === 'complained', logs)
  ok('#438 不達の理由は宛先を伏せて記録する', /^bounced: Permanent/.test(st[`pm-b-${tag}`].error_message) && !st[`pm-b-${tag}`].error_message.includes(BOUNCE), st[`pm-b-${tag}`].error_message)
  const [sup] = d1(`SELECT email, reason FROM email_suppressions WHERE email LIKE '%-${tag}@example.com' ORDER BY email`)
  ok('#541 恒久的な不達と迷惑メール報告のアドレスだけを送信停止にする（小文字にそろえる）', sup.length === 2 && sup.some(x => x.email === BOUNCE && x.reason === 'bounced') && sup.some(x => x.reason === 'complained'), sup)
}

// ---------- #541 #367 #455 #454 お知らせメール: 送信停止のアドレスには送らない・問い合わせ先・確認のリンク ----------
const ST3 = d1(`SELECT u.user_id, sp.staff_id, u.email FROM users u JOIN staff_profiles sp ON sp.user_id = u.user_id WHERE u.user_code = 'st003' AND u.company_id = 1`)[0][0]
d1(`UPDATE users SET email = '${BOUNCE}' WHERE user_id = ${ST3.user_id}`)
{
  const bad = await admin.put('/api/admin/settings/mail-contact', { reply_to: 'not-an-email', phone: '' })
  const badPhone = await admin.put('/api/admin/settings/mail-contact', { reply_to: '', phone: 'abc' })
  const byMgr = await mgr.put('/api/admin/settings/mail-contact', { reply_to: 'x@example.com' })
  const save = await admin.put('/api/admin/settings/mail-contact', { reply_to: 'support@sample-mobile.jp', phone: '03-1234-5678' })
  const got = (await mgr.get('/api/admin/settings/mail-contact')).data
  ok('#367 問い合わせ先の設定: 形式の確認・会社管理者のみ変更・保存した値を返す', bad.status === 400 && badPhone.status === 400 && byMgr.status === 403 && save.status === 200 && got.reply_to === 'support@sample-mobile.jp' && got.phone === '03-1234-5678' && got.can_edit === false && got.company_name,
    [bad.status, badPhone.status, byMgr.status, save.status, got])
  const [[s]] = d1(`SELECT settings_json FROM companies WHERE company_id = 1`)
  ok('#367 ほかの企業設定を消さない', /ranking_visible/.test(s.settings_json) && /mail_reply_to/.test(s.settings_json), s.settings_json)
}
const title = `メール通知テスト${tag}`
const pub = must(await admin.post('/api/admin/notices', { title, body: '本文です', target_type: 'all', target_ids: '', importance: 'urgent', send_email: true, client_request_id: `nm-${tag}` }), 'notice')
const noticeId = pub.notice_id
let deliveries = []
for (let i = 0; i < 30; i++) {
  deliveries = (await admin.get(`/api/admin/notices/${noticeId}/email-deliveries`)).data.deliveries
  if (deliveries.length && deliveries.every(d => d.status !== 'pending')) break
  await sleep(500)
}
{
  const d3 = deliveries.find(d => d.user_id === ST3.user_id)
  ok('#541 送信停止のアドレスあてのお知らせメールは送らず、理由を記録する', d3 && d3.status === 'failed' && d3.error === 'suppressed_bounced', d3)
  const others = deliveries.filter(d => d.user_id !== ST3.user_id && d.status !== 'no_email')
  ok('（前提）ほかの人は送信設定なしの失敗として記録される', others.length > 0 && others.every(d => d.error === 'mail_not_configured'), others.slice(0, 3))
  const [[t]] = d1(`SELECT COUNT(*) AS n, MIN(expires_at) AS exp FROM notice_ack_tokens WHERE notice_id = ${noticeId}`)
  const withMail = deliveries.filter(d => d.status !== 'no_email').length
  ok('#454 メールを送る人ごとに「確認しました」のトークンを作る（30日の期限）', t.n === withMail && t.exp > addDays(today, 29), [t, withMail])
}

// ---------- #454 「確認しました」のリンク ----------
{
  const token = createHash('sha256').update(`ack-${tag}`).digest('hex').slice(0, 48)
  const hash = createHash('sha256').update(token).digest('hex')
  const exToken = createHash('sha256').update(`ex-${tag}`).digest('hex').slice(0, 48)
  const exHash = createHash('sha256').update(exToken).digest('hex')
  d1(`INSERT INTO notice_ack_tokens (token_hash, notice_id, company_id, user_id, expires_at) VALUES
    ('${hash}', ${noticeId}, 1, ${ST3.user_id}, '${addDays(today, 30)} 00:00:00'), ('${exHash}', ${noticeId}, 1, ${ST3.user_id}, '${addDays(today, -1)} 00:00:00')`)
  const page = await fetch(`${BASE}/notice-ack?token=${token}`)
  await page.text()
  const info = await anon.get(`/api/public/notice-ack?token=${token}`)
  ok('#454 確認のページと、ログインなしでお知らせの件名・会社名を返す（本文は返さない）', page.status === 200 && info.status === 200 && info.data.title === title && info.data.company_name && info.data.used === false && !('body' in info.data), info)
  const st3 = client(await login('sample', 'st003'))
  const before = (await st3.get(`/api/staff/notices/${noticeId}`)).data.notice
  const ack = await anon.post('/api/public/notice-ack', { token })
  const after = (await st3.get(`/api/staff/notices/${noticeId}`)).data.notice
  ok('#454 ボタンを押すとアプリでも確認済みになる', before && !before.is_read && ack.status === 200 && ack.data.ok && after && after.is_read, [before && before.is_read, ack, after && after.is_read])
  const twice = await anon.post('/api/public/notice-ack', { token })
  const info2 = await anon.get(`/api/public/notice-ack?token=${token}`)
  ok('#454 トークンは1回だけ使える（2回目は確認済みと返す）', twice.status === 200 && twice.data.already === true && info2.data.used === true, [twice, info2.data])
  const expired = await anon.post('/api/public/notice-ack', { token: exToken })
  const wrong = await anon.post('/api/public/notice-ack', { token: '0'.repeat(48) })
  const malformed = await anon.post('/api/public/notice-ack', { token: 'abc' })
  ok('#454 期限切れ（410）・存在しない・形の違うトークン（404）', expired.status === 410 && wrong.status === 404 && malformed.status === 404, [expired.status, wrong.status, malformed.status])
}

// ---------- #438 企業のメールの記録 ----------
{
  const r = await admin.get('/api/admin/email-logs?type=notice')
  const own = r.data.logs.find(l => l.to_email === 'staff1@example.com')
  const supRow = r.data.logs.find(l => l.recipient_name && l.suppressed)
  const otherCo = (await admin.get('/api/admin/email-logs?status=failed')).data.logs
  ok('#438 企業は自社の送信記録を見られる（自社のユーザーのアドレス・理由・送信停止の印）', r.status === 200 && own && own.error === 'mail_not_configured' && supRow, [r.status, own, supRow])
  ok('#438 ほかの会社の記録は出さない', !otherCo.some(l => String(l.to_email).includes(`other-${tag}`)), otherCo.slice(0, 2))
  d1(`INSERT INTO email_logs (company_id, to_email, type, status, error_message) VALUES (1, 'outsider-${tag}@other.example', 'attendance_correction', 'failed', 'resend_error: validation_error - outsider-${tag}@other.example is invalid')`)
  const hidden = (await admin.get('/api/admin/email-logs?type=attendance_correction&status=failed')).data.logs.find(l => /outsider/.test(String(l.error)) || l.to_email_hidden)
  ok('#570 自社のユーザーでない宛先（連携スタッフの所属元のアドレス）は伏せる', hidden && hidden.to_email_hidden && !String(hidden.to_email).includes('outsider') && !String(hidden.error).includes(`outsider-${tag}@`), hidden)
  const sups = (await admin.get('/api/admin/email-suppressions')).data
  ok('#541 企業は自社のユーザーのうち送信停止のアドレスを見られる', sups.suppressions.some(x => x.email === BOUNCE && /高橋/.test(x.names)) && sups.can_release === true, sups)
  const relMgr = await mgr.post('/api/admin/email-suppressions/release', { email: BOUNCE })
  const relOther = await admin.post('/api/admin/email-suppressions/release', { email: `spam-${tag}@example.com` })
  ok('#541 送信停止の解除は会社管理者だけ・自社のユーザーのアドレスだけ', relMgr.status === 403 && relOther.status === 404, [relMgr.status, relOther.status])
}

// ---------- #438 #541 本部のメール送信の画面 ----------
{
  const stats = await hq.get('/api/hq/email-stats?days=7')
  const co1 = stats.data.companies && stats.data.companies.find(c => c.company_id === 1)
  ok('#438 本部: 会社別・種類別の件数と失敗率・最後に成功した日時・理由の上位', stats.status === 200 && co1 && co1.total > 0 && co1.types.length > 0 && 'last_success_at' in co1 && Array.isArray(stats.data.reasons) && stats.data.reasons.some(r => r.code === 'mail_not_configured'), stats.data && stats.data.companies)
  ok('#438 本部: 届かなかった割合が高い会社を警告する', stats.data.warnings.some(w => w.company_id === 1), stats.data.warnings)
  const logs = await hq.get('/api/hq/email-logs?company_id=1&status=failed')
  ok('#438 本部: 送信の記録は宛先を伏せる', logs.status === 200 && logs.data.logs.length > 0 && logs.data.logs.every(l => !l.to_email.includes('@') || /\*\*\*@/.test(l.to_email)) && logs.data.logs.every(l => !String(l.error_message || '').includes(`outsider-${tag}@`)), logs.data.logs.slice(0, 3))
  const sup = await hq.get('/api/hq/email-suppressions')
  ok('#541 本部: 送信停止のアドレスの一覧（伏せた表示・会社名）', sup.status === 200 && sup.data.suppressions.some(x => x.email === BOUNCE && /\*\*\*@/.test(x.masked) && x.companies), sup.data.suppressions.slice(0, 2))
  const forbid = await admin.get('/api/hq/email-stats')
  ok('#438 企業の管理者は本部の画面を見られない（403）', forbid.status === 403, forbid.status)
  const rel = await hq.post('/api/hq/email-suppressions/release', { email: `spam-${tag}@example.com` })
  const rel2 = await hq.post('/api/hq/email-suppressions/release', { email: `spam-${tag}@example.com` })
  ok('#541 本部: 送信停止を解除できる（2回目は 404）', rel.status === 200 && rel2.status === 404, [rel.status, rel2.status])
}

// ---------- 打刻修正の通知メール: 止まった送信・まとめて再送・対応不要（#311 #444 #357） ----------
const st1 = client(await login('sample', 'st001'))
const dA = addDays(today, -3)
must(await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 3, work_date: dA, start_time: '10:00', end_time: '19:00', memo: `NM-${tag}` }), 'shift')
const shiftId = (await admin.get(`/api/admin/shifts?from=${dA}&to=${dA}`)).data.shifts.find(x => x.memo === `NM-${tag}`).shift_id
const c1 = must(await st1.post('/api/staff/corrections', { shift_id: shiftId, report_type: 'check_in', kind: 'add', requested_at: `${dA} 09:58`, reason: '入店報告を忘れた' }), 'correction 1').correction_id
const c2 = must(await st1.post('/api/staff/corrections', { shift_id: shiftId, report_type: 'check_out', kind: 'add', requested_at: `${dA} 19:05`, reason: '退店報告を忘れた' }), 'correction 2').correction_id
async function rowsOf(cid) {
  for (let i = 0; i < 30; i++) {
    const all = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.filter(d => d.correction_id === cid)
    if (all.length && all.every(d => d.status !== 'pending')) return all
    await sleep(300)
  }
  return (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.filter(d => d.correction_id === cid)
}
{
  const r1 = await rowsOf(c1), r2 = await rowsOf(c2)
  ok('（前提）申請の通知メールが送信失敗として記録される', r1.length >= 2 && r2.length >= 2 && [...r1, ...r2].every(d => d.status === 'failed'), r1.map(d => [d.status, d.error]))
  // 1件を「送信中のまま止まった」状態にする
  const stuck = r1[0]
  d1(`UPDATE notification_emails SET status = 'pending', last_attempt_at = '${nowJst(30)}' WHERE delivery_id = ${stuck.delivery_id}`)
  const fresh = r1[1]
  d1(`UPDATE notification_emails SET status = 'pending', last_attempt_at = '${nowJst(1)}' WHERE delivery_id = ${fresh.delivery_id}`)
  const list = (await admin.get('/api/admin/notification-emails?status=stalled')).data
  ok('#311 送信中のまま10分以上たった行を「止まった送信」として出す（新しい送信中は出さない）', list.deliveries.some(d => d.delivery_id === stuck.delivery_id && d.stalled) && !list.deliveries.some(d => d.delivery_id === fresh.delivery_id) && list.counts.stalled >= 1, list.counts)
  const rsFresh = await admin.post(`/api/admin/notification-emails/${fresh.delivery_id}/resend`)
  const [x, y] = await Promise.all([admin.post(`/api/admin/notification-emails/${stuck.delivery_id}/resend`), mgr.post(`/api/admin/notification-emails/${stuck.delivery_id}/resend`)])
  const after = (await admin.get('/api/admin/notification-emails?status=all')).data.deliveries.find(d => d.delivery_id === stuck.delivery_id)
  // 2つ目の要求が1つ目の送信の後に届くと、送信失敗に戻った行をもう一度送る（それは正しい）。送った回数と 200 の数が合うこと（同じ claim で二重に送らない）
  const n200 = [x.status, y.status].filter(s => s === 200).length
  ok('#311 止まった行は再送できる（同時に押しても二重に送らない）。送り始めたばかりの行は 409', rsFresh.status === 409 && n200 >= 1 && [x, y].every(r => r.status === 200 || r.status === 409) && after.status === 'failed' && after.attempts === stuck.attempts + n200, [rsFresh.status, x.status, y.status, after])
  d1(`UPDATE notification_emails SET status = 'failed' WHERE delivery_id = ${fresh.delivery_id}`)

  // c1 を承認 → c1 の承認依頼は対応不要になる
  must(await mgr.post(`/api/admin/corrections/${c1}/approve`, { comment: 'OK' }), 'approve')
  await rowsOf(c1)
  const one = (await admin.get('/api/admin/notification-emails?status=failed')).data.deliveries.find(d => d.correction_id === c1 && d.kind === 'correction_submitted')
  const rs1 = await admin.post(`/api/admin/notification-emails/${one.delivery_id}/resend`)
  const one2 = (await admin.get('/api/admin/notification-emails?status=skipped')).data.deliveries.find(d => d.delivery_id === one.delivery_id)
  ok('#357 処理済みの申請の承認依頼は再送せず「対応不要」にする', rs1.status === 409 && rs1.data.reason === 'already_processed' && one2 && one2.error === 'already_processed', [rs1, one2])

  // 停止中の宛先
  const r2rows = await rowsOf(c2)
  const toMgr = r2rows.find(d => d.recipient_name && /藤田/.test(d.recipient_name))
  if (toMgr) d1(`UPDATE users SET status = 'suspended' WHERE user_code = 'mgr01' AND company_id = 1`)
  const beforeCounts = (await admin.get('/api/admin/notification-emails')).data.counts
  let after_ = 0, sent = 0, failed = 0, skipped = 0, calls = 0, last
  for (;;) {
    last = await admin.post('/api/admin/notification-emails/resend-failed', { after: after_ })
    if (last.status !== 200) break
    calls++; sent += last.data.sent; failed += last.data.failed; skipped += last.data.skipped
    if (last.data.done || calls > 50) break
    after_ = last.data.next_after
  }
  if (toMgr) d1(`UPDATE users SET status = 'active' WHERE user_code = 'mgr01' AND company_id = 1`)
  ok('#444 送信失敗をまとめて再送する（失敗の件数・理由を返し、最後まで進む）', last.status === 200 && last.data.done === true && failed > 0 && last.data.reasons && calls < 50, [last, sent, failed, skipped, beforeCounts])
  const skippedRows = (await admin.get('/api/admin/notification-emails?status=skipped')).data.deliveries
  ok('#357 #444 まとめて再送でも、処理済みの承認依頼と停止中の宛先は「対応不要」にして送らない', skippedRows.some(d => d.correction_id === c1 && d.kind === 'correction_submitted') && (!toMgr || skippedRows.some(d => d.delivery_id === toMgr.delivery_id && d.error === 'recipient_suspended')), skippedRows.map(d => [d.delivery_id, d.error]))
  const cnt = (await admin.get('/api/admin/notification-emails')).data.counts
  ok('#444 一覧の件数に「まとめて再送」の対象数（送信失敗＋止まった送信）を返す', typeof cnt.resendable === 'number' && cnt.resendable === (cnt.failed || 0) + (cnt.stalled || 0), cnt)
  const page1 = (await admin.get('/api/admin/notification-emails?status=all')).data
  ok('#444 一覧のページ送り（before）', page1.deliveries.length > 0 && (await admin.get(`/api/admin/notification-emails?status=all&before=${page1.deliveries[0].delivery_id}`)).data.deliveries.every(d => d.delivery_id < page1.deliveries[0].delivery_id), page1.has_more)
  const csv = await fetch(`${BASE}/api/admin/notification-emails/export?status=skipped`, { headers: { Cookie: await login('sample', 'admin') } })
  ok('#357 CSV に「対応不要」を出せる', csv.status === 200 && /対応不要/.test(await csv.text()), csv.status)
}

// ---------- #380 受信箱: 未読だけ・種類・ページ送り ----------
{
  const all = (await admin.get('/api/admin/notifications')).data
  const p1 = (await admin.get('/api/admin/notifications?limit=2')).data
  const p2 = (await admin.get(`/api/admin/notifications?limit=2&before=${p1.notifications[1].notification_id}`)).data
  ok('#380 受信箱のページ送り（limit・before・has_more）', p1.notifications.length === 2 && p1.has_more === (all.notifications.length > 2) && p2.notifications.every(n => n.notification_id < p1.notifications[1].notification_id), [p1.notifications.length, p1.has_more, p2.notifications.length])
  const unread = (await admin.get('/api/admin/notifications?unread=1')).data
  ok('#380 未読だけを返す・種類ごとの未読の件数', unread.notifications.every(n => !n.read_at) && unread.unread === Object.values(unread.unread_by_kind).reduce((a, b) => a + b, 0), [unread.unread, unread.unread_by_kind])
  const kind = (await admin.get('/api/admin/notifications?kind=correction_submitted')).data
  ok('#380 種類で絞り込む', kind.notifications.length > 0 && kind.notifications.every(n => n.kind === 'correction_submitted'), kind.notifications.map(n => n.kind))
  const badKind = await admin.get('/api/admin/notifications?kind=x%27%20OR%201=1')
  ok('#380 形の違う種類の指定は無視する', badKind.status === 200, badKind.status)
}

// ---------- #236 #423 管理画面（スマホのヘッダー・バッジ） ----------
{
  const html = await (await fetch(`${BASE}/admin`, { headers: { Cookie: await login('sample', 'admin') } })).text()
  ok('#236 スマホ用ヘッダーにログアウト・会社名・件数の合計の欄がある', /id="mobile-logout-btn"/.test(html) && /id="mobile-company-name"/.test(html) && /id="mobile-todo-badge"/.test(html), html.length)
  const js = await (await fetch(`${BASE}/static/notifications.js`)).text()
  ok('#423 定期の更新で応募の件数も更新する', /refreshRecruitBadge\(\)/.test(js), '')
  const hqHtml = await (await fetch(`${BASE}/hq`, { headers: { Cookie: await login('sample', 'hq') } })).text()
  ok('#438 本部画面に「メール送信」のタブ', /href="#mail"/.test(hqHtml), '')
}

// 後片付け（ほかのテストに影響しないよう、変えたアドレスを戻す）
d1(`UPDATE users SET email = '${ST3.email}' WHERE user_id = ${ST3.user_id}`)

const failedCount = results.filter(r => !r.pass).length
console.log(`\n${results.length - failedCount}/${results.length} passed`)
process.exit(failedCount ? 1 : 0)
