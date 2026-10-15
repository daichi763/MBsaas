// テナント越えの検証漏れ（w1-tenant-guard）の統合テスト
// 前提: bash scripts/setup-test-db.sh でローカルの D1 を作り直し、`wrangler dev --local` で起動していること。
//   本部（hq）で 2 社目を作り、その会社の ID を自社（sample）から指定したときに 404・400 になることを確かめる。
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w1-tenant-guard.mjs
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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tag = Date.now().toString(36).slice(-5)

// ---------- 2 社目（B 社）を用意する ----------
const hq = client(await login('sample', 'hq'))
const codeB = 'tg' + tag, pwB = 'Tg-Passw0rd-' + tag
const cr = await hq.post('/api/hq/companies', { company_code: codeB, company_name: `テナント確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
ok('（前提）B 社を作成', cr.status === 200, cr)
const adminB = client(await login(codeB, 'adminb', pwB))
const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001'))
const st2 = client(await login('sample', 'st002'))

await adminB.post('/api/admin/clients', { client_name: `B社の取引先${tag}` })
const clientB = (await adminB.get('/api/admin/clients')).data.clients.find(x => x.client_name === `B社の取引先${tag}`)
await adminB.post('/api/admin/projects', { project_name: `B社の案件${tag}`, client_id: clientB.client_id, location: 'B社の店舗', unit_price: 99999 })
const projB = (await adminB.get('/api/admin/projects')).data.projects.find(x => x.project_name === `B社の案件${tag}`)
ok('（前提）B 社のクライアントと案件', clientB && projB && projB.client_name === `B社の取引先${tag}`, [clientB, projB])

// ---------- #21 シフト登録: 他社の案件 ----------
const d1 = addDays(today, 3)
const sx = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: projB.project_id, work_date: d1, memo: 'TG-X' })
ok('#21 他社の案件ではシフトを登録できない（404）', sx.status === 404, sx)
const leaked = (await admin.get(`/api/admin/shifts?from=${d1}&to=${d1}`)).data.shifts.some(s => s.memo === 'TG-X')
ok('#21 他社の案件のシフトが作られていない', !leaked)
const s0 = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 1, work_date: d1, memo: 'TG-OWN' })
ok('#21 自社の案件なら登録できる', s0.status === 200, s0)
const badSt = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: 1, work_date: d1, status: '<img src=x>' })
ok('#58 登録: 状態は許可リストのみ（400）', badSt.status === 400, badSt)
const own = (await admin.get(`/api/admin/shifts?from=${d1}&to=${d1}`)).data.shifts.find(s => s.memo === 'TG-OWN')

// ---------- #58 シフト編集: 他社のスタッフ・不正な状態 ----------
const staffB = await adminB.post('/api/admin/staff', { user_code: 'stb' + tag, name: `B社スタッフ${tag}`, password: 'Tg-Passw0rd-' + tag })
const sB = (await adminB.get('/api/admin/staff')).data
const staffBId = (sB.staff || sB.rows || sB).find?.(x => x.name === `B社スタッフ${tag}`)?.staff_id
ok('（前提）B 社のスタッフ', staffB.status === 200 && staffBId, sB && Object.keys(sB))
const p1 = await admin.put(`/api/admin/shifts/${own.shift_id}`, { staff_id: staffBId })
ok('#58 他社のスタッフには付け替えられない（404）', p1.status === 404, p1)
const p2 = await admin.put(`/api/admin/shifts/${own.shift_id}`, { status: 'hacked' })
ok('#58 状態は許可リストのみ（400）', p2.status === 400, p2)
const p3 = await admin.put(`/api/admin/shifts/${own.shift_id}`, { status: 'substitute' })
ok('#58 正しい状態なら更新できる', p3.status === 200, p3)
const afterPut = (await admin.get(`/api/admin/shifts?from=${d1}&to=${d1}`)).data.shifts.find(s => s.shift_id === own.shift_id)
ok('#58 付け替えられていない（スタッフはそのまま）', afterPut.staff_id === 1 && afterPut.status === 'substitute', afterPut)
await adminB.post('/api/admin/shifts', { staff_id: staffBId, project_id: projB.project_id, work_date: d1, memo: 'TG-B' })
const shiftB = (await adminB.get(`/api/admin/shifts?from=${d1}&to=${d1}`)).data.shifts.find(s => s.memo === 'TG-B')
const p4 = await admin.put(`/api/admin/shifts/${shiftB.shift_id}`, { memo: 'x' })
ok('#58 他社のシフトは編集できない（404）', p4.status === 404, p4)

// ---------- #22 #143 案件登録 ----------
const pr1 = await admin.post('/api/admin/projects', { project_name: `TG他社クライアント${tag}`, client_id: clientB.client_id })
ok('#22 他社のクライアントでは案件を登録できない（400）', pr1.status === 400, pr1)
const projs = (await admin.get('/api/admin/projects')).data.projects
ok('#22 案件一覧に他社のクライアント名が出ない', !projs.some(p => p.client_name === `B社の取引先${tag}`) && !projs.some(p => p.project_name === `TG他社クライアント${tag}`))
const pr2 = await admin.post('/api/admin/projects', { project_name: `TG種別${tag}`, project_type: '<img src=x onerror=alert(1)>' })
ok('#143 業務種別は許可リストのみ（400）', pr2.status === 400, pr2)
const pr3 = await admin.post('/api/admin/projects', { project_name: `TG単価${tag}`, unit_price_type: 'weird' })
ok('#143 単価の種類は許可リストのみ（400）', pr3.status === 400, pr3)
const pr4 = await admin.post('/api/admin/projects', { project_name: `TGテンプレ${tag}`, report_template_id: 999999 })
ok('#22 存在しない・他社の日報テンプレートは指定できない（400）', pr4.status === 400, pr4)
const pr5 = await admin.post('/api/admin/projects', { project_name: `TG正常${tag}`, project_type: 'event', client_id: 1 })
ok('#22 自社のクライアント・正しい種別なら登録できる', pr5.status === 200, pr5)

// ---------- #143 フォロー履歴 ----------
const f1 = await admin.post('/api/admin/follow-logs', { staff_id: 1, follow_type: '<script>x</script>', content: 'x' })
ok('#143 フォロー種別は許可リストのみ（400）', f1.status === 400, f1)
const f2 = await admin.post('/api/admin/follow-logs', { staff_id: 1, follow_type: 'phone', content: 'x', status: 'evil' })
ok('#143 フォローの状態は許可リストのみ（400）', f2.status === 400, f2)
const f3 = await admin.post('/api/admin/follow-logs', { staff_id: 1, follow_type: 'phone', content: 'x', related_project_id: projB.project_id })
ok('フォロー: 他社の案件は関連付けられない（404）', f3.status === 404, f3)
const f4 = await admin.post('/api/admin/follow-logs', { staff_id: 1, follow_type: 'phone', content: 'TGフォロー' })
ok('#143 正しい種別なら記録できる', f4.status === 200, f4)

// ---------- #1 #54 お知らせ ----------
await adminB.post('/api/admin/notices', { title: `B社のお知らせ${tag}`, body: 'b', target_type: 'all' })
const noticeB = (await adminB.get('/api/admin/notices')).data.notices.find(n => n.title === `B社のお知らせ${tag}`)
await admin.post('/api/admin/notices', { title: `A社全員${tag}`, body: 'a', target_type: 'all' })
await admin.post('/api/admin/notices', { title: `A社st002のみ${tag}`, body: 'a', target_type: 'staff', target_ids: '2' })
const aList = (await admin.get('/api/admin/notices')).data.notices
const noticeAll = aList.find(n => n.title === `A社全員${tag}`), noticeOnly2 = aList.find(n => n.title === `A社st002のみ${tag}`)
const rB = await adminB.post(`/api/staff/notices/${noticeB.notice_id}/read`)
const rd1 = await admin.get(`/api/admin/notices/${noticeB.notice_id}/reads`)
ok('#1 他社のお知らせの既読状況は見られない（404）', rd1.status === 404, rd1)
const w1 = await st1.post(`/api/staff/notices/${noticeB.notice_id}/read`)
ok('#54 他社のお知らせは既読にできない（404）', w1.status === 404, w1)
const w2 = await st1.post(`/api/staff/notices/${noticeOnly2.notice_id}/read`)
ok('#54 配信対象外のお知らせは既読にできない（404）', w2.status === 404, w2)
const w3 = await st1.post(`/api/staff/notices/${noticeAll.notice_id}/read`)
const w4 = await st2.post(`/api/staff/notices/${noticeOnly2.notice_id}/read`)
ok('#54 自社の配信対象のお知らせは既読にできる', w3.status === 200 && w4.status === 200, [w3, w4])
const rd2 = await admin.get(`/api/admin/notices/${noticeAll.notice_id}/reads`)
ok('#1 自社のお知らせの既読状況は見られる', rd2.status === 200 && rd2.data.read.some(r => r.name === '佐藤 健太'), rd2)
const bReads = (await adminB.get(`/api/admin/notices/${noticeB.notice_id}/reads`)).data
ok('#54 他社のお知らせの既読数が増えていない', bReads.read.length === 0 || bReads.read.every(r => r.name !== '佐藤 健太'), [rB.status, bReads])

// ---------- #447 スキルシート ----------
const dPast = addDays(today, -2), dFut = addDays(today, 5)
await admin.post('/api/admin/projects', { project_name: `TG欠勤案件${tag}` })
await admin.post('/api/admin/projects', { project_name: `TG未来案件${tag}` })
await admin.post('/api/admin/projects', { project_name: `TG希望案件${tag}` })
await admin.post('/api/admin/projects', { project_name: `TG稼働案件${tag}` })
const plist = (await admin.get('/api/admin/projects')).data.projects
const pid = (n) => plist.find(p => p.project_name === `${n}${tag}`).project_id
await admin.post('/api/admin/shifts', { staff_id: 4, project_id: pid('TG欠勤案件'), work_date: dPast, status: 'absent' })
await admin.post('/api/admin/shifts', { staff_id: 4, project_id: pid('TG未来案件'), work_date: dFut })
await admin.post('/api/admin/shifts', { staff_id: 4, project_id: pid('TG希望案件'), work_date: dPast, status: 'requested' })
await admin.post('/api/admin/shifts', { staff_id: 4, project_id: pid('TG稼働案件'), work_date: dPast })
const ss = await admin.get('/api/admin/staff/4/skill-sheet')
const names = (ss.data.experienced_projects || []).map(p => p.project_name)
ok('#447 経験案件に確定・稼働済みの案件は載る', names.includes(`TG稼働案件${tag}`), names)
ok('#447 欠勤・希望・未来のシフトの案件は載らない', !names.includes(`TG欠勤案件${tag}`) && !names.includes(`TG未来案件${tag}`) && !names.includes(`TG希望案件${tag}`), names)
ok('#447 スキルシートに管理者メモを返さない', ss.status === 200 && !('memo' in ss.data.profile), ss.data.profile && ss.data.profile.memo)

// ---------- #570 他社連携スタッフの申請で、連携先に所属元のメールアドレスを見せない ----------
await admin.get('/api/admin/staff')  // 人物IDの補完（ensureRosterIdentity）
const sc = await admin.get('/api/admin/roster/1/share-code')
const terms = (await adminB.get('/api/admin/roster/consent-terms')).data
const lk = await adminB.post('/api/admin/roster/link', { code: sc.data.global_staff_code, agreed: true, consent_version: terms.version })
ok('（前提）B 社が st001 を連携登録', sc.status === 200 && lk.status === 200, [sc, lk])
const dL = addDays(today, -1)
await adminB.post('/api/admin/shifts', { staff_id: lk.data.staff_id, project_id: projB.project_id, work_date: dL, start_time: '10:00', end_time: '19:00', memo: 'TG-L' })
const shiftL = (await adminB.get(`/api/admin/shifts?from=${dL}&to=${dL}`)).data.shifts.find(s => s.memo === 'TG-L')
const cr1 = await st1.post('/api/staff/corrections', { shift_id: shiftL?.shift_id, report_type: 'check_in', kind: 'add', requested_at: `${dL} 09:58`, reason: '連携先の入店を忘れた' })
ok('（前提）st001 が B 社のシフトに打刻修正を申請', cr1.status === 200, cr1)
let dels = []
for (let i = 0; i < 20; i++) {
  dels = ((await adminB.get('/api/admin/notification-emails?status=all')).data.deliveries || []).filter(d => d.correction_id === cr1.data.correction_id)
  if (dels.length && dels.every(d => d.status !== 'pending')) break
  await new Promise(r => setTimeout(r, 300))
}
ok('#570 連携先の送信状況に所属元のメールアドレスが出ない', dels.length > 0 && dels.every(d => !String(d.to_email).includes('@') && d.to_email_hidden === true), dels)
const csv = await adminB.get('/api/admin/notification-emails/export')
ok('#570 連携先の CSV に所属元のメールアドレスが出ない', csv.status === 200 && !String(csv.data).includes('staff1@example.com'), String(csv.data).slice(0, 300))
const aOwn = ((await admin.get('/api/admin/notification-emails?status=all')).data.deliveries || [])
ok('#570 自社の宛先のアドレスはそのまま見える', aOwn.every(d => !d.to_email_hidden), aOwn.slice(0, 2))

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
