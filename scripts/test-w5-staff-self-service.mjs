// スタッフ本人の手続き（w5-staff-self-service: #272 #288 #289 #297）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   自社（sample）に新しいスタッフを2人作り、登録情報の変更申請・書類の提出・書類の種類と期限・休暇の申請を API で確かめる。
//   画面の表示（スタッフアプリの申請画面、管理画面の「スタッフの申請」・書類の欄・社員の有給欄）は API では確かめない
// 実行: BASE=http://127.0.0.1:8820 node scripts/test-w5-staff-self-service.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
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
    const isForm = body instanceof FormData
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, ...(isForm ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) })
    let data = null
    const text = await r.text()
    try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const ymd = (d) => new Date(Date.now() + 9 * 3600 * 1000 + d * 86400000).toISOString().slice(0, 10)

const PFX = 'SS' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
for (const k of ['A', 'B']) must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} 本人${k}`, password: 'pass1234' }), 'staff ' + k)
const list = must(await admin.get('/api/admin/staff'), 'staff list').staff
const A = list.find(s => s.user_code === `${PFX}A`), B = list.find(s => s.user_code === `${PFX}B`)
const sa = client(await login('sample', `${PFX}A`)), sb = client(await login('sample', `${PFX}B`))
const notifsOf = async (c) => must(await c.get('/api/staff/notifications'), 'notifs').notifications

// ---------- #272 登録情報の変更申請 ----------
{
  const g = must(await sa.get('/api/staff/self/profile-requests'), 'profile-requests')
  ok('#272 本人は申請できる項目と今の値を取得できる', g.available && g.fields.includes('nearest_station') && g.fields.includes('work_area') && g.pending === false, g)
  const same = await sa.post('/api/staff/self/profile-requests', { changes: { nearest_station: g.current.nearest_station ?? '' } })
  ok('#272 今の登録と同じ内容だけなら 400', same.status === 400, same)
  const bad = await sa.post('/api/staff/self/profile-requests', { changes: { commute_minutes: '2000' } })
  ok('#272 通勤可能時間の範囲外は 400', bad.status === 400, bad)
  const badDate = await sa.post('/api/staff/self/profile-requests', { changes: { available_from: '2026-02-30' } })
  ok('#272 実在しない日付は 400', badDate.status === 400, badDate)
  const r = await sa.post('/api/staff/self/profile-requests', { changes: { nearest_station_line: 'JR山手線', nearest_station: '渋谷', work_area: '東京都23区', commute_minutes: '45', available_from: ymd(10), skills: '接客, 販売' }, note: '引っ越し' })
  ok('#272 変更を申請できる', r.status === 200 && r.data.request_id, r)
  const r2 = await sa.post('/api/staff/self/profile-requests', { changes: { work_area: '大阪' } })
  ok('#272 承認待ちがある間は、2件目を出せない（409）', r2.status === 409, r2)
  const before = must(await admin.get(`/api/admin/staff/${A.staff_id}`), 'staff detail')
  const st = before.staff || before.profile || before
  ok('#272 承認するまで登録は変わらない', st.nearest_station !== '渋谷', st.nearest_station)
  const al = must(await admin.get('/api/admin/staff-requests/profile'), 'admin list')
  const row = al.requests.find(x => x.request_id === r.data.request_id)
  ok('#272 管理者の一覧に、今の値と変更後の値が出る', row && row.changes.nearest_station === '渋谷' && row.staff_id === A.staff_id && 'nearest_station' in row.current, row)
  const inbox = must(await admin.get('/api/admin/notifications'), 'admin inbox').notifications
  ok('#272 管理者に申請の通知が届く', inbox.some(n => n.kind === 'profile_change_submitted' && n.related_id === r.data.request_id), inbox.slice(0, 3))
  const sum = must(await admin.get('/api/admin/staff-requests/summary'), 'summary')
  ok('#272 件数に承認待ちが数えられる', sum.profile_pending >= 1, sum)
  const ap = await admin.post(`/api/admin/staff-requests/profile/${r.data.request_id}/approve`, { comment: '反映しました' })
  ok('#272 管理者が承認できる', ap.status === 200, ap)
  const ap2 = await admin.post(`/api/admin/staff-requests/profile/${r.data.request_id}/approve`, {})
  ok('#272 同じ申請を二度承認できない（409）', ap2.status === 409, ap2)
  const prof = must(await sa.get('/api/staff/me/profile'), 'my profile').profile
  ok('#272 承認すると本人の登録に反映される', prof.nearest_station === '渋谷' && prof.nearest_station_line === 'JR山手線' && prof.work_area === '東京都23区' && Number(prof.commute_minutes) === 45 && prof.available_from === ymd(10) && prof.skills === '接客, 販売', prof)
  ok('#272 本人に承認の通知が届く', (await notifsOf(sa)).some(n => n.kind === 'profile_change_approved'))
  // 見送り
  const r3 = must(await sa.post('/api/staff/self/profile-requests', { changes: { work_area: '大阪府' } }), 'request 3')
  const rj0 = await admin.post(`/api/admin/staff-requests/profile/${r3.request_id}/reject`, {})
  ok('#272 見送りには理由が要る（400）', rj0.status === 400, rj0)
  const rj = await admin.post(`/api/admin/staff-requests/profile/${r3.request_id}/reject`, { comment: '稼働エリアは面談で確認します' })
  ok('#272 見送りできる', rj.status === 200, rj)
  const mine = must(await sa.get('/api/staff/self/profile-requests'), 'mine')
  ok('#272 本人の一覧に結果と理由が出る', mine.requests.some(x => x.request_id === r3.request_id && x.status === 'rejected' && /面談/.test(x.review_comment)), mine.requests)
  ok('#272 見送った変更は反映されない', must(await sa.get('/api/staff/me/profile'), 'p').profile.work_area === '東京都23区')
  // 取り消し
  const r4 = must(await sa.post('/api/staff/self/profile-requests', { changes: { nearest_station: '新宿' } }), 'request 4')
  ok('#272 ほかの人は取り消せない', (await sb.post(`/api/staff/self/profile-requests/${r4.request_id}/cancel`)).status === 409)
  ok('#272 本人は承認待ちの申請を取り消せる', (await sa.post(`/api/staff/self/profile-requests/${r4.request_id}/cancel`)).status === 200)
  ok('#272 取り消した申請は承認できない', (await admin.post(`/api/admin/staff-requests/profile/${r4.request_id}/approve`)).status === 409)
  ok('#272 スタッフは管理者の API を使えない', (await sa.get('/api/admin/staff-requests/profile')).status === 403)
  // ログイン用メール（承認すると確認用のメールを送り、すぐには切り替えない）
  const r5 = must(await sa.post('/api/staff/self/profile-requests', { changes: { login_email: `${PFX.toLowerCase()}a@example.com` } }), 'email request')
  const ap5 = await admin.post(`/api/admin/staff-requests/profile/${r5.request_id}/approve`, {})
  ok('#272 ログイン用メールの申請を承認すると、確認待ちになる（すぐには切り替えない）', ap5.status === 200 && ap5.data.login_email && ap5.data.login_email.pending === `${PFX.toLowerCase()}a@example.com`, ap5)
}

// ---------- #288 書類の提出 ----------
const pdf = new Blob([new TextEncoder().encode('%PDF-1.4\n% test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' })
const docForm = (blob, name, type, valid) => { const f = new FormData(); f.append('file', blob, name); if (type) f.append('doc_type', type); if (valid) f.append('valid_until', valid); return f }
let docId
{
  const noType = await sa.post('/api/staff/self/documents', docForm(pdf, 'license.pdf'))
  ok('#288 書類の種類がないと 400', noType.status === 400, noType)
  const fake = await sa.post('/api/staff/self/documents', docForm(new Blob(['not an image'], { type: 'image/jpeg' }), 'photo.jpg', 'id_card'))
  ok('#288 中身が形式と合わないファイルは 400', fake.status === 400, fake)
  const exe = await sa.post('/api/staff/self/documents', docForm(new Blob(['MZ'], { type: 'application/octet-stream' }), 'tool.exe', 'other'))
  ok('#288 写真・PDF 以外は 400', exe.status === 400, exe)
  const up = await sa.post('/api/staff/self/documents', docForm(pdf, '資格証.pdf', 'qualification', ymd(10)))
  ok('#288 本人がスマホから書類を提出できる', up.status === 200 && up.data.document_id, up)
  docId = up.data.document_id
  const mine = must(await sa.get('/api/staff/self/documents'), 'my docs')
  ok('#288 本人の一覧に、種類・期限・確認待ちで出る', mine.documents.some(d => d.document_id === docId && d.doc_type === 'qualification' && d.valid_until === ymd(10) && !d.confirmed_at), mine.documents)
  const dl = await sa.get(`/api/staff/self/documents/${docId}/download`)
  ok('#288 本人は自分の書類を開ける', dl.status === 200 && String(dl.data).startsWith('%PDF'), dl.status)
  ok('#288 ほかのスタッフは開けない（404）', (await sb.get(`/api/staff/self/documents/${docId}/download`)).status === 404)
  ok('#288 ほかのスタッフは削除できない（404）', (await sb.del(`/api/staff/self/documents/${docId}`)).status === 404)
  ok('#288 ほかのスタッフの一覧には出ない', !must(await sb.get('/api/staff/self/documents'), 'b docs').documents.some(d => d.document_id === docId))
  const adminDocs = must(await admin.get(`/api/admin/staff/${A.staff_id}/documents`), 'admin docs').documents
  ok('#288 管理画面の書類の一覧に「本人提出・未確認」で出る', adminDocs.some(d => d.document_id === docId && d.submitted_by_staff === 1 && !d.confirmed_at && d.doc_type === 'qualification'), adminDocs)
  const inbox = must(await admin.get('/api/admin/notifications'), 'admin inbox').notifications
  ok('#288 管理者に提出の通知が届く', inbox.some(n => n.kind === 'staff_document_submitted' && n.related_id === A.staff_id), inbox.slice(0, 3))
  const un = must(await admin.get('/api/admin/staff-requests/documents'), 'docs view')
  ok('#288 「スタッフの申請」に未確認の書類として出る', un.unconfirmed.some(d => d.document_id === docId && d.staff_name), un.unconfirmed)
  const cf = await admin.put(`/api/admin/staff-requests/documents/staff/${docId}`, { confirmed: true })
  ok('#288 管理者が確認済みにできる', cf.status === 200, cf)
  ok('#288 確認済みの書類は本人が削除できない（409）', (await sa.del(`/api/staff/self/documents/${docId}`)).status === 409)
  const up2 = must(await sa.post('/api/staff/self/documents', docForm(pdf, 'resume.pdf', 'resume')), 'up2')
  ok('#288 未確認の書類は本人が削除できる', (await sa.del(`/api/staff/self/documents/${up2.document_id}`)).status === 200)
  const adminUp = new FormData(); adminUp.append('files', pdf, 'admin.pdf')
  const au = must(await admin.post(`/api/admin/staff/${A.staff_id}/documents`, adminUp), 'admin upload')
  const auId = au.results[0].document_id
  ok('#288 管理者が登録した書類は、本人の一覧に出ず、本人は開けない', !must(await sa.get('/api/staff/self/documents'), 'd').documents.some(d => d.document_id === auId) && (await sa.get(`/api/staff/self/documents/${auId}/download`)).status === 404)
  ok('#288 本人提出でない書類は確認済みにできない（400）', (await admin.put(`/api/admin/staff-requests/documents/staff/${auId}`, { confirmed: true })).status === 400)
}

// ---------- #297 書類の種類と有効期限 ----------
{
  const clients = must(await admin.get('/api/admin/clients'), 'clients').clients
  const cid = clients[0].client_id
  const bad = new FormData(); bad.append('files', pdf, 'c.pdf'); bad.append('doc_type', 'id_card')
  ok('#297 クライアントの契約書に、スタッフの書類の種類は付けられない（400）', (await admin.post(`/api/admin/clients/${cid}/documents`, bad)).status === 400)
  const badDate = new FormData(); badDate.append('files', pdf, 'c.pdf'); badDate.append('valid_until', '2026/13/01')
  ok('#297 有効期限の形が違えば 400', (await admin.post(`/api/admin/clients/${cid}/documents`, badDate)).status === 400)
  const f = new FormData(); f.append('files', pdf, `${PFX}基本契約書.pdf`); f.append('doc_type', 'contract_basic'); f.append('valid_until', ymd(-1))
  const up = must(await admin.post(`/api/admin/clients/${cid}/documents`, f), 'client upload')
  const cdoc = up.results[0].document_id
  const cl = must(await admin.get(`/api/admin/clients/${cid}/documents`), 'client docs').documents.find(d => d.document_id === cdoc)
  ok('#297 アップロードで種類と契約終了日を保存できる', cl && cl.doc_type === 'contract_basic' && cl.valid_until === ymd(-1), cl)
  const view = must(await admin.get('/api/admin/staff-requests/documents'), 'expiring')
  ok('#297 期限切れの契約書が期限の一覧に出る', view.expiring.some(d => d.kind === 'client' && d.document_id === cdoc), view.expiring)
  ok('#297 30日以内に期限が来るスタッフの書類も出る', view.expiring.some(d => d.kind === 'staff' && d.document_id === docId))
  const mgrView = must(await mgr.get('/api/admin/staff-requests/documents'), 'mgr expiring')
  ok('#297 現場長も期限の一覧を見られる（入社時書類は含めない）', mgrView.expiring.every(d => d.kind !== 'employee'))
  const ed = await admin.put(`/api/admin/staff-requests/documents/client/${cdoc}`, { valid_until: ymd(400) })
  ok('#297 期限を延ばすと一覧から消える', ed.status === 200 && !must(await admin.get('/api/admin/staff-requests/documents'), 'e2').expiring.some(d => d.kind === 'client' && d.document_id === cdoc), ed)
  ok('#297 種類の値が違えば 400', (await admin.put(`/api/admin/staff-requests/documents/client/${cdoc}`, { doc_type: 'xxx' })).status === 400)
  ok('#297 存在しない書類は 404', (await admin.put(`/api/admin/staff-requests/documents/client/99999999`, { doc_type: 'other' })).status === 404)
  ok('#297 入社時書類の編集は会社管理者・事務担当だけ（403）', (await mgr.put(`/api/admin/staff-requests/documents/employee/1`, { doc_type: 'other' })).status === 403)
}

// ---------- #289 有給の残日数と休暇の申請 ----------
{
  const g0 = must(await sa.get('/api/staff/self/leave'), 'leave 0')
  ok('#289 自社雇用のスタッフは休暇の画面を使える', g0.eligible === true, g0)
  must(await admin.put(`/api/admin/employees/${A.staff_id}`, { paid_leave_remaining: 1.5, paid_leave_granted_at: ymd(-100), telework_remaining_this_month: 3 }), 'employee record')
  const g = must(await sa.get('/api/staff/self/leave'), 'leave')
  ok('#289 本人に有給の残日数・付与日・テレワーク残数が出る', g.balance.paid_leave_remaining === 1.5 && g.balance.paid_leave_granted_at === ymd(-100) && g.balance.telework_remaining_this_month === 3, g.balance)
  ok('#289 日付の形が違えば 400', (await sa.post('/api/staff/self/leave', { leave_date: '2026-02-30' })).status === 400)
  ok('#289 2年先の日付は 400', (await sa.post('/api/staff/self/leave', { leave_date: ymd(800) })).status === 400)
  const l1 = await sa.post('/api/staff/self/leave', { leave_date: ymd(20), leave_type: 'paid', leave_unit: 'full', reason: '私用' })
  ok('#289 休暇を申請できる', l1.status === 200 && l1.data.leave_id, l1)
  ok('#289 同じ日の重なる申請は 409', (await sa.post('/api/staff/self/leave', { leave_date: ymd(20), leave_unit: 'am' })).status === 409)
  const l2 = await sa.post('/api/staff/self/leave', { leave_date: ymd(21), leave_type: 'paid', leave_unit: 'full' })
  ok('#289 承認待ちを含めて残日数が足りない有給は 400', l2.status === 400, l2)
  const l3 = await sa.post('/api/staff/self/leave', { leave_date: ymd(21), leave_type: 'paid', leave_unit: 'am' })
  ok('#289 半休なら残りの 0.5日で申請できる', l3.status === 200, l3)
  ok('#289 現場長は休暇の申請を扱えない（403）', (await mgr.get('/api/admin/staff-requests/leave')).status === 403)
  const inbox = must(await admin.get('/api/admin/notifications'), 'admin inbox').notifications
  ok('#289 会社管理者に休暇の申請の通知が届く', inbox.some(n => n.kind === 'leave_submitted' && n.related_id === l1.data.leave_id))
  const al = must(await admin.get('/api/admin/staff-requests/leave'), 'admin leave')
  ok('#289 管理者の一覧に、承認待ちと有給残数が出る', al.requests.some(x => x.leave_id === l1.data.leave_id && x.paid_leave_remaining === 1.5 && 'shift_count' in x), al.requests)
  const ap = await admin.post(`/api/admin/staff-requests/leave/${l1.data.leave_id}/approve`, { comment: 'OK' })
  ok('#289 承認すると有給残数から引く', ap.status === 200 && must(await sa.get('/api/staff/self/leave'), 'g2').balance.paid_leave_remaining === 0.5, ap)
  ok('#289 二度承認できない（409）', (await admin.post(`/api/admin/staff-requests/leave/${l1.data.leave_id}/approve`)).status === 409)
  ok('#289 本人に承認の通知が届く', (await notifsOf(sa)).some(n => n.kind === 'leave_approved' && n.related_id === l1.data.leave_id))
  const ap3 = await admin.post(`/api/admin/staff-requests/leave/${l3.data.leave_id}/approve`, {})
  ok('#289 半休の承認で 0.5日引く', ap3.status === 200 && must(await sa.get('/api/staff/self/leave'), 'g3').balance.paid_leave_remaining === 0, ap3)
  const l4 = await sa.post('/api/staff/self/leave', { leave_date: ymd(22), leave_type: 'paid', leave_unit: 'full' })
  ok('#289 残数が0なら有給は申請できない', l4.status === 400, l4)
  const l5 = must(await sa.post('/api/staff/self/leave', { leave_date: ymd(22), leave_type: 'other', leave_unit: 'full' }), 'other leave')
  const ap5 = await admin.post(`/api/admin/staff-requests/leave/${l5.leave_id}/approve`, {})
  ok('#289 その他の休暇は残数を変えずに承認できる', ap5.status === 200 && must(await sa.get('/api/staff/self/leave'), 'g5').balance.paid_leave_remaining === 0, ap5)
  ok('#289 承認の取り消しには理由が要る', (await admin.post(`/api/admin/staff-requests/leave/${l1.data.leave_id}/revoke`, {})).status === 400)
  const rv = await admin.post(`/api/admin/staff-requests/leave/${l1.data.leave_id}/revoke`, { comment: '予定変更' })
  ok('#289 承認を取り消すと有給を戻す', rv.status === 200 && rv.data.restored_days === 1 && must(await sa.get('/api/staff/self/leave'), 'g6').balance.paid_leave_remaining === 1, rv)
  const l6 = must(await sa.post('/api/staff/self/leave', { leave_date: ymd(25), leave_unit: 'pm' }), 'l6')
  ok('#289 見送りには理由が要る', (await admin.post(`/api/admin/staff-requests/leave/${l6.leave_id}/reject`, {})).status === 400)
  ok('#289 見送りできる', (await admin.post(`/api/admin/staff-requests/leave/${l6.leave_id}/reject`, { comment: '繁忙期のため' })).status === 200)
  const l7 = must(await sa.post('/api/staff/self/leave', { leave_date: ymd(26) }), 'l7')
  ok('#289 ほかのスタッフは取り消せない', (await sb.post(`/api/staff/self/leave/${l7.leave_id}/cancel`)).status === 409)
  ok('#289 本人は承認待ちを取り消せる', (await sa.post(`/api/staff/self/leave/${l7.leave_id}/cancel`)).status === 200)
  const emp = must(await admin.get(`/api/admin/staff-requests/leave?status=all&staff_id=${A.staff_id}`), 'emp leave')
  ok('#289 社員ごとの一覧（社員の詳細の有給欄）を取れる', emp.requests.length >= 5 && emp.requests.every(x => x.staff_id === A.staff_id), emp.requests.length)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
