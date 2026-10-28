// 管理者・企業あての通知と、相談のやり取り・写真（作業単位 w5-notify-admin: #150 #152 #154 #166 #429、持ち越し #187）の統合テスト
// 起動に --var STAFF_APP_RECRUIT:1 を付ける（スタッフアプリの募集は Sprint 11 で止めた。#9411。この試験はスタッフアプリからの応募も使う。npm test は自動で付ける）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8812 --persist-to <保存先> で起動していること（MAIL_ENABLED=false。メールは送らず email_logs に skipped で残る）。
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w5-notify-admin.mjs
//   本番には接続しない。
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8812'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  const upload = async (path, fields) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie || '' }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  const raw = (path) => fetch(`${BASE}${path}`, { headers: { Cookie: cookie || '' } })
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), upload, raw }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = Date.now().toString(36).slice(-5)
let phoneSeq = 0
const newPhone = () => '070' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')

// 通知（自分あて）と、会社のメールの記録の件数
const notifs = async (api, kind) => must(await api.get(`/api/admin/notifications?kind=${kind}&limit=100`), 'notifications').notifications
const unreadOf = async (api, kind, relatedId) => (await notifs(api, kind)).filter(n => n.related_id === relatedId && !n.read_at)
const mailCount = async (api, type) => must(await api.get(`/api/admin/email-logs?type=${type}`), 'email logs').logs.length
const jpeg = (n = 200) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(n).fill(0), 0xff, 0xd9])], { type: 'image/jpeg' })

// ---------- 準備: A 社（sample の admin・mgr01）と B 社（本部で作る） ----------
const A = client(await login('sample', 'admin'))
const A2 = client(await login('sample', 'mgr01'))
const st1 = client(await login('sample', 'st001'))
const st2 = client(await login('sample', 'st002'))
const hq = client((await rawLogin('', 'hq')).cookie)
const coCode = 'na' + SUF, pwB = 'Na-Passw0rd-' + SUF, coNameB = `通知確認B社${SUF}`
must(await hq.post('/api/hq/companies', { company_code: coCode, company_name: coNameB, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者', admin_email: `na${SUF}@example.com` }), 'company B')
const B = client(await login(coCode, 'adminb', pwB))

// ---------- #150 新しい応募を管理者に知らせる ----------
{
  must(await A.post('/api/admin/projects', { project_name: `NA案件${SUF}` }), 'project')
  const pid = must(await A.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `NA案件${SUF}`).project_id
  const D = addDays(today, 40)
  must(await A.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 5 }] }), 'slot')
  const slot = must(await A.get(`/api/admin/shift-board?from=${D}&to=${D}`), 'board').slots.filter(s => s.project_id === pid).pop()
  const roleId = slot.roles[0].slot_role_id
  const page = must(await A.post('/api/admin/recruit-pages', { title: `NA募集${SUF}`, project_ids: [pid], date_from: today, date_to: addDays(today, 60), allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' }), 'page')
  const pub = client(null)
  const apply = (name) => pub.post(`/api/public/recruit/${page.token}/apply`, { name, phone: newPhone(), agree: true, slot_role_ids: [roleId], issued_at: Date.now() - 10000 })
  const m0 = await mailCount(A, 'recruit_applied')
  must(await apply(`応募 一郎${SUF}`), 'apply 1')
  let u = await unreadOf(A, 'recruit_applied', page.page_id)
  ok('#150 公開ページの応募で、管理者に新しい応募の通知が届く', u.length === 1 && u[0].title.includes(`応募 一郎${SUF}`) && u[0].title.includes(`NA募集${SUF}`), u)
  ok('#150 通知のリンクは、その募集ページの応募の一覧', u[0] && u[0].link === `/admin#recruit/page-${page.page_id}`, u[0])
  ok('#150 ほかの管理者（現場責任者）にも届く', (await unreadOf(A2, 'recruit_applied', page.page_id)).length === 1)
  const m1 = await mailCount(A, 'recruit_applied')
  ok('#150 メールも送る（email_logs に残る）', m1 > m0, { m0, m1 })
  must(await apply(`応募 二郎${SUF}`), 'apply 2')
  u = await unreadOf(A, 'recruit_applied', page.page_id)
  ok('#150 続けて届いた応募は、未読の通知1件にまとめる（件数を出す）', u.length === 1 && u[0].title.includes('2件'), u)
  ok('#150 まとめた応募のメールは30分は送らない', (await mailCount(A, 'recruit_applied')) === m1)
  const s = must(await st1.post('/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [roleId] }), 'staff apply')
  u = await unreadOf(A, 'recruit_applied', page.page_id)
  ok('#150 スタッフアプリからの応募も知らせる', s.count === 1 && u.length === 1 && u[0].title.includes('3件'), [s, u])
  must(await A.post('/api/admin/notifications/read-related', { kind: 'recruit_applied' }), 'read related')
  ok('#150 応募の一覧を開いたら（read-related）自分の通知だけ既読になる', (await unreadOf(A, 'recruit_applied', page.page_id)).length === 0 && (await unreadOf(A2, 'recruit_applied', page.page_id)).length === 1)
  const bad = await A.post('/api/admin/notifications/read-related', { kind: 'DROP TABLE' })
  ok('read-related: 不正な種類は 400', bad.status === 400, bad)
  must(await apply(`応募 三郎${SUF}`), 'apply 3')
  u = await unreadOf(A, 'recruit_applied', page.page_id)
  ok('#150 既読にした後の応募は、新しい通知になる', u.length === 1 && u[0].title.includes(`応募 三郎${SUF}`), u)
  ok('#150 B 社には届かない', (await notifs(B, 'recruit_applied')).length === 0)
}

// ---------- #152 案件掲示板のやり取りを相手企業に知らせる ----------
{
  const post = must(await A.post('/api/admin/board/posts', { status: 'open', engagement_type: 'spot', title: `NA掲載${SUF}`, prefecture: '東京都', date_from: addDays(today, 20), time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 1 }), 'post').post_id
  const mA0 = await mailCount(A, 'board_message')
  const secret = `問い合わせの本文${SUF}`
  const th = must(await B.post(`/api/admin/board/posts/${post}/threads`, { body: secret }), 'thread').thread_id
  let u = await unreadOf(A, 'board_message', th)
  ok('#152 問い合わせが来たら、掲載企業の管理者に通知する', u.length === 1 && u[0].title.includes(coNameB) && u[0].title.includes('問い合わせ') && u[0].link === `/admin#board/t${th}`, u)
  ok('#152 通知にメッセージの本文を入れない', u[0] && !u[0].title.includes(secret) && !String(u[0].body || '').includes(secret), u[0])
  const mA1 = await mailCount(A, 'board_message')
  ok('#152 メールでも知らせる', mA1 > mA0, { mA0, mA1 })
  must(await B.post(`/api/admin/board/threads/${th}/messages`, { body: '追加のメッセージ' }), 'message')
  u = await unreadOf(A, 'board_message', th)
  ok('#152 同じやり取りの未読の通知は1件にまとめる', u.length === 1 && u[0].title.includes('2件'), u)
  ok('#152 まとめたやり取りのメールは30分に1通まで', (await mailCount(A, 'board_message')) === mA1)
  ok('#152 自社（問い合わせた側）には届かない', (await unreadOf(B, 'board_message', th)).length === 0)
  must(await A.post(`/api/admin/board/threads/${th}/read`, {}), 'read')
  ok('#152 やり取りを読んだら、自分の通知は既読になる（ほかの管理者の分は残る）', (await unreadOf(A, 'board_message', th)).length === 0 && (await unreadOf(A2, 'board_message', th)).length === 1)
  must(await A.post(`/api/admin/board/threads/${th}/messages`, { body: 'ご連絡ありがとうございます' }), 'reply')
  const ub = await unreadOf(B, 'board_message', th)
  ok('#152 掲載企業の返信は、問い合わせた企業に知らせる', ub.length === 1 && ub[0].link === `/admin#board/t${th}` && ub[0].title.includes('メッセージ'), ub)
  // 提案と採用
  const sid = must(await B.post('/api/admin/staff-quick', { name: `提案 人材${SUF}`, phone: newPhone(), affiliation_type: 'own_employee', force: true }), 'staff-quick').staff_id
  const pr = must(await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: sid, consent_method: 'written', consent_obtained_on: today }), 'proposal')
  u = await unreadOf(A, 'board_message', th)
  ok('#152 人材の提案を知らせる', u.length === 1 && u[0].title.includes('人材の提案'), u)
  const mB0 = await mailCount(B, 'board_message')
  must(await A.post(`/api/admin/board/proposals/${pr.proposal_id}/status`, { status: 'adopted' }), 'adopt')
  const ub2 = await unreadOf(B, 'board_message', th)
  ok('#152 採用は提案した企業に知らせる', ub2.length === 1 && ub2[0].body.includes('採用'), ub2)
  ok('#152 採用は、まとめ中でもメールを送る', (await mailCount(B, 'board_message')) > mB0, { mB0, n: await mailCount(B, 'board_message') })
}

// ---------- #166 企業間チャットの新着を相手企業に知らせる ----------
let linkedB, rosterStaff
{
  // A 社の新しいスタッフを B 社が連携登録する
  const code = `NA${SUF}`
  must(await A.post('/api/admin/staff', { user_code: code, name: `連携 花子${SUF}`, password: 'pass1234', phone: newPhone() }), 'staff')
  rosterStaff = must(await A.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === code)
  const sc = must(await A.get(`/api/admin/roster/${rosterStaff.staff_id}/share-code`), 'share code')
  const terms = must(await B.get('/api/admin/roster/consent-terms'), 'terms')
  linkedB = must(await B.post('/api/admin/roster/link', { code: sc.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
  const mA0 = await mailCount(A, 'roster_chat')
  const secret = `明日の遅刻の件${SUF}`
  must(await B.post(`/api/admin/roster-chat/${linkedB}`, { body: secret }), 'chat B')
  let u = await unreadOf(A, 'roster_chat', linkedB)
  ok('#166 稼働先の投稿を、所属元の管理者に知らせる', u.length === 1 && u[0].title.includes(coNameB) && u[0].title.includes(`連携 花子${SUF}`), u)
  ok('#166 リンク先は所属元のスタッフ詳細', u[0] && u[0].link === `/admin#staff/${rosterStaff.staff_id}`, u[0])
  ok('#166 通知にチャットの本文を入れない', u[0] && !u[0].title.includes(secret) && !String(u[0].body || '').includes(secret), u[0])
  const mA1 = await mailCount(A, 'roster_chat')
  ok('#166 メールでも知らせる', mA1 > mA0, { mA0, mA1 })
  must(await B.post(`/api/admin/roster-chat/${linkedB}`, { body: '2通目' }), 'chat B 2')
  u = await unreadOf(A, 'roster_chat', linkedB)
  ok('#166 未読のあいだは1件にまとめ、メールは送らない', u.length === 1 && (await mailCount(A, 'roster_chat')) === mA1, u)
  must(await A.post(`/api/admin/roster-chat/${rosterStaff.staff_id}/read`, { host_staff_id: linkedB }), 'read')
  ok('#166 チャットを読んだら自分の通知は既読になる', (await unreadOf(A, 'roster_chat', linkedB)).length === 0 && (await unreadOf(A2, 'roster_chat', linkedB)).length === 1)
  must(await A.post(`/api/admin/roster-chat/${rosterStaff.staff_id}`, { body: '承知しました', host_staff_id: linkedB }), 'chat A')
  const ub = await unreadOf(B, 'roster_chat', linkedB)
  ok('#166 所属元の投稿を、稼働先の管理者に知らせる（リンク先は稼働先のスタッフ詳細）', ub.length === 1 && ub[0].link === `/admin#staff/${linkedB}`, ub)
}

// ---------- 持ち越し #187 所属元での退職を連携先に知らせる ----------
{
  const r = await A.put(`/api/admin/employees/${rosterStaff.staff_id}`, { profile: { retired_at: addDays(today, 10), retired_at_confirmed: true } })
  ok('#187（前提）所属元で退職日を設定できる', r.status === 200, r)
  const u = await unreadOf(B, 'roster_source_retired', linkedB)
  ok('#187 連携先の管理者に、所属元での退職を知らせる', u.length === 1 && u[0].title.includes(`連携 花子${SUF}`) && u[0].link === `/admin#staff/${linkedB}`, u)
  ok('#187 所属元には届かない', (await notifs(A, 'roster_source_retired')).length === 0)
}

// ---------- #154 相談を管理者に知らせ、返信をやり取りとして残す ----------
let consultQ
{
  const mail0 = await mailCount(A, 'consultation')
  consultQ = must(await st1.post('/api/staff/consultations', { category: 'question', body: `業務の質問${SUF}` }), 'consult q').consultation_id
  let u = await unreadOf(A, 'consult_received', consultQ)
  ok('#154 相談が届いたら管理者に通知する', u.length === 1 && u[0].link === `/admin#consult/${consultQ}` && u[0].body.includes(`業務の質問${SUF}`), u)
  ok('#154 通常の相談はメールを送らない', (await mailCount(A, 'consultation')) === mail0)
  const urgent = must(await st1.post('/api/staff/consultations', { category: 'health', body: `体調が悪いです${SUF}` }), 'consult h').consultation_id
  const mail1 = await mailCount(A, 'consultation')
  ok('#154 体調不良の相談はメールでもすぐに知らせる', mail1 > mail0 && (await unreadOf(A, 'consult_received', urgent))[0]?.title.includes('至急'), { mail0, mail1 })
  const logs = must(await A.get('/api/admin/email-logs?type=consultation'), 'logs').logs
  ok('#154 メールの記録の種類は consultation', logs.length > 0 && logs.every(l => l.type === 'consultation'), logs.slice(0, 2))
  must(await st1.post('/api/staff/consultations', { category: 'question', body: `急ぎの質問${SUF}`, urgency: 'high' }), 'consult high')
  ok('#154 緊急度『高』もメールで知らせる', (await mailCount(A, 'consultation')) > mail1)
  // 1件を開くと自分の通知が既読
  const one = must(await A.get(`/api/admin/consultations?id=${consultQ}`), 'focus')
  ok('#154 相談を開いたら自分の通知を既読にする', one.consultations.length === 1 && (await unreadOf(A, 'consult_received', consultQ)).length === 0 && (await unreadOf(A2, 'consult_received', consultQ)).length === 1)
  // 返信を2回
  must(await A.put(`/api/admin/consultations/${consultQ}`, { manager_reply: '1回目の返信', status: 'in_progress' }), 'reply 1')
  ok('#154 返信したら、ほかの管理者の通知も既読にする', (await unreadOf(A2, 'consult_received', consultQ)).length === 0)
  must(await A2.put(`/api/admin/consultations/${consultQ}`, { manager_reply: '2回目の返信' }), 'reply 2')
  must(await A2.put(`/api/admin/consultations/${consultQ}`, { manager_reply: '2回目の返信' }), 'reply 2 again')
  let co = must(await A.get(`/api/admin/consultations?id=${consultQ}`), 'focus').consultations[0]
  ok('#154 返信は上書きせず、やり取りとして時系列で残す', co.messages.length === 2 && co.messages[0].body === '1回目の返信' && co.messages[1].body === '2回目の返信' && co.manager_reply === '2回目の返信', co.messages)
  ok('#154 管理画面では返信した人の名前を出す', co.messages[0].author_name === '出井 代表' && co.messages[1].author_name === '藤田 現場長', co.messages)
  // スタッフの追加の連絡
  let g = must(await st1.get('/api/staff/consultations'), 'staff list').consultations.find(x => x.consultation_id === consultQ)
  ok('#154 スタッフにもやり取りを返す（管理者の名前は出さない）', g && g.messages.length === 2 && g.messages.every(m => m.author_name === '管理者'), g && g.messages)
  must(await A.put(`/api/admin/consultations/${consultQ}`, { status: 'done' }), 'done')
  const fm = await st1.post(`/api/staff/consultations/${consultQ}/messages`, { body: `追加の質問です${SUF}` })
  ok('#154 スタッフが追加で連絡できる', fm.status === 200 && fm.data.message_id > 0, fm)
  const dup = await st1.post(`/api/staff/consultations/${consultQ}/messages`, { body: `追加の質問です${SUF}` })
  ok('#154 同じ内容の続けての送信は 409', dup.status === 409, dup)
  co = must(await A.get(`/api/admin/consultations?id=${consultQ}`), 'focus').consultations[0]
  ok('#154 対応済みの相談に追加の連絡が来たら、未対応に戻す', co.status === 'open' && co.messages.length === 3 && co.messages[2].author_side === 'staff', co)
  u = await unreadOf(A2, 'consult_message', consultQ)
  ok('#154 追加の連絡を管理者に知らせる', u.length === 1 && u[0].body.includes(`追加の質問です${SUF}`), u)
  const other = await st2.post(`/api/staff/consultations/${consultQ}/messages`, { body: 'ほかの人の相談' })
  ok('#154 ほかのスタッフの相談には送れない（404）', other.status === 404, other)
  const empty = await st1.post(`/api/staff/consultations/${consultQ}/messages`, { body: '  ' })
  ok('#154 空の追加の連絡は 400', empty.status === 400, empty)
  const st = must(await A.get('/api/admin/consultations?status=open'), 'open').consultations
  ok('#154 状態での絞り込みの一覧にもやり取りが付く', st.some(x => x.consultation_id === consultQ && x.messages.length === 3))
  ok('#154 B 社には届かない', (await notifs(B, 'consult_received')).length === 0)
  must(await A2.put(`/api/admin/consultations/${consultQ}`, { manager_reply: '2回目の返信' }), 'reply same text after follow-up')
  co = must(await A.get(`/api/admin/consultations?id=${consultQ}`), 'focus').consultations[0]
  ok('#154 追加の連絡の後なら、前と同じ文面の返信もやり取りに足す', co.messages.length === 4 && co.messages[3].author_side === 'admin', co.messages)
  // 追加の連絡に写真を付ける（#429）
  const ph = await st1.upload(`/api/staff/consultations/${consultQ}/photos`, { photo: jpeg(), message_id: String(fm.data.message_id) })
  ok('#429 追加の連絡に写真を付けられる', ph.status === 200 && ph.data.attachment_id > 0, ph)
}

// ---------- #429 相談に写真を添付する ----------
{
  const id = must(await st1.post('/api/staff/consultations', { category: 'store_trouble', body: `棚が壊れています${SUF}` }), 'consult').consultation_id
  const up = []
  for (let i = 0; i < 4; i++) up.push(await st1.upload(`/api/staff/consultations/${id}/photos`, { photo: jpeg(100 + i) }))
  ok('#429 1回の送信に3枚まで付けられる', up.slice(0, 3).every(r => r.status === 200 && r.data.attachment_id > 0), up)
  ok('#429 4枚目は 409', up[3].status === 409, up[3])
  const png = await st1.upload(`/api/staff/consultations/${id}/photos`, { photo: new Blob(['GIF89a'], { type: 'image/gif' }) })
  ok('#429 JPEG・PNG 以外は 400', png.status === 400, png)
  const others = await st2.upload(`/api/staff/consultations/${id}/photos`, { photo: jpeg() })
  ok('#429 ほかの人の相談には付けられない（404）', others.status === 404, others)
  const badMsg = await st1.upload(`/api/staff/consultations/${id}/photos`, { photo: jpeg(), message_id: '99999999' })
  ok('#429 相談に属さない追加の連絡には付けられない（404）', badMsg.status === 404, badMsg)
  const co = must(await A.get(`/api/admin/consultations?id=${id}`), 'focus').consultations[0]
  ok('#429 管理画面の相談に写真の ID が付く', co.photos.length === 3 && co.photos.every(p => p.message_id == null), co.photos)
  const aid = co.photos[0].attachment_id
  const r1 = await A.raw(`/api/admin/consultation-photo/${aid}`)
  ok('#429 自社の管理者は写真を見られる', r1.status === 200 && (r1.headers.get('content-type') || '').includes('image/jpeg'), r1.status)
  const r2 = await B.raw(`/api/admin/consultation-photo/${aid}`)
  ok('#429 他社の管理者は見られない（404）', r2.status === 404, r2.status)
  const r3 = await st1.raw(`/api/staff/consultation-photo/${aid}`)
  ok('#429 本人は写真を見られる', r3.status === 200, r3.status)
  const r4 = await st2.raw(`/api/staff/consultation-photo/${aid}`)
  ok('#429 ほかのスタッフは見られない（404）', r4.status === 404, r4.status)
  const g = must(await st1.get('/api/staff/consultations'), 'staff').consultations.find(x => x.consultation_id === id)
  ok('#429 スタッフの相談履歴にも写真の ID が付く', g && g.photos.length === 3, g && g.photos)
}

// ほかのテストと同じ D1 で続けて流すときのために、スタッフあての返信の通知を既読にしておく
await st1.post('/api/staff/consultations/read-replies')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
