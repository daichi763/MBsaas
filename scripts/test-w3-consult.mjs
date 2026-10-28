// 相談・連絡の統合テスト（w3-consult: #90 #194 #195 #222 #235 #320 #422）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
//   本部（hq）で 2 社目（B 社）を作り、B 社が st001 を連携登録して、B 社のシフトについての相談が B 社に届くことを確かめる。
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w3-consult.mjs
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

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001')) // staff_id 1
const st2 = client(await login('sample', 'st002')) // staff_id 2

// ---------- 前提: B 社・案件・st001 の連携・シフト ----------
const hq = client(await login('sample', 'hq'))
const codeB = 'cs' + tag, pwB = 'Cs-Passw0rd-' + tag
const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `相談確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
ok('（前提）B 社を作成', cr.status === 200, cr)
const adminB = client(await login(codeB, 'adminb', pwB))
await adminB.post('/api/admin/clients', { client_name: `B社の取引先${tag}` })
const clientB = (await adminB.get('/api/admin/clients')).data.clients.find(x => x.client_name === `B社の取引先${tag}`)
await adminB.post('/api/admin/projects', { project_name: `B社の案件${tag}`, client_id: clientB.client_id, location: 'B社の店舗' })
const projB = (await adminB.get('/api/admin/projects')).data.projects.find(x => x.project_name === `B社の案件${tag}`)
await admin.get('/api/admin/staff') // 人物IDの補完（ensureRosterIdentity）
const sc = await admin.get('/api/admin/roster/1/share-code')
const terms = (await adminB.get('/api/admin/roster/consent-terms')).data
const lk = await adminB.post('/api/admin/roster/link', { code: sc.data.global_staff_code, agreed: true, consent_version: terms.version })
ok('（前提）B 社が st001 を連携登録', sc.status === 200 && lk.status === 200, [sc, lk])
const sB = await adminB.post('/api/admin/shifts', { staff_id: lk.data.staff_id, project_id: projB.project_id, work_date: today, start_time: '10:00', end_time: '19:00', memo: `CS-B${tag}` })
const shiftB = (await adminB.get(`/api/admin/shifts?from=${today}&to=${today}`)).data.shifts.find(s => s.memo === `CS-B${tag}`)
ok('（前提）B 社の本日のシフト', sB.status === 200 && shiftB, sB)
// 自社（sample）の案件で、st001 と st002 のシフト
const projA = (await admin.get('/api/admin/projects')).data.projects[0]
const dA = addDays(today, 3)
await admin.post('/api/admin/shifts', { staff_id: 1, project_id: projA.project_id, work_date: dA, start_time: '09:00', end_time: '18:00', memo: `CS-A${tag}` })
await admin.post('/api/admin/shifts', { staff_id: 2, project_id: projA.project_id, work_date: dA, start_time: '09:00', end_time: '18:00', memo: `CS-2${tag}` })
const shiftsA = (await admin.get(`/api/admin/shifts?from=${dA}&to=${dA}`)).data.shifts
const shiftA = shiftsA.find(s => s.memo === `CS-A${tag}`), shift2 = shiftsA.find(s => s.memo === `CS-2${tag}`)
ok('（前提）自社のシフト', shiftA && shift2, shiftsA.map(s => s.memo))

// ---------- #222 #195 送り先の会社と対象のシフトの候補 ----------
let g = (await st1.get('/api/staff/consultations')).data
ok('#222 相談画面に所属の会社（2社）を返す', (g.companies || []).length === 2 && g.companies.some(c => c.company_name === `相談確認B社${tag}`), g.companies)
ok('#195 対象のシフトの候補に B 社の本日のシフトと自社のシフトが出る', g.targets.some(s => s.shift_id === shiftB.shift_id && s.company_name === `相談確認B社${tag}`) && g.targets.some(s => s.shift_id === shiftA.shift_id), g.targets)
ok('#195 候補に他人のシフトは出ない', !g.targets.some(s => s.shift_id === shift2.shift_id))

// ---------- #235 カテゴリは必須 ----------
let r = await st1.post('/api/staff/consultations', { category: '', body: 'カテゴリなし' })
ok('#235 カテゴリ未選択は 400', r.status === 400, r)
r = await st1.post('/api/staff/consultations', { category: 'bogus', body: 'x' })
ok('#235 不正なカテゴリは 400', r.status === 400, r)
r = await st1.post('/api/staff/consultations', { category: 'question', body: 'あ'.repeat(2001) })
ok('内容が長すぎると 400', r.status === 400, r)

// ---------- #222 シフトを選ぶと、そのシフトの会社に届く ----------
const bodyB = `B社のシフトの遅刻連絡${tag}\n電車が遅れています\n10分ほど遅れます`
r = await st1.post('/api/staff/consultations', { category: 'absence', body: bodyB, urgency: 'high', shift_id: shiftB.shift_id })
ok('#222 B 社のシフトを選んだ相談を送れる（送り先の会社名を返す）', r.status === 200 && r.data.company_name === `相談確認B社${tag}`, r)
const consultB = r.data.consultation_id
let la = (await adminB.get('/api/admin/consultations')).data
const inB = la.consultations.find(c => c.consultation_id === consultB)
ok('#222 B 社の相談対応に届く', !!inB, la)
ok('#195 対象の日付・案件・シフトが付いている', inB && inB.target_date === today && inB.target_project_name === `B社の案件${tag}` && inB.target_shift_id === shiftB.shift_id, inB)
ok('#422 本文の改行がそのまま保存される', inB && inB.body === bodyB, inB && inB.body)
let lsample = (await admin.get('/api/admin/consultations?status=all')).data
ok('#222 自社（sample）の相談対応には出ない', !lsample.consultations.some(c => c.consultation_id === consultB))

// ---------- #194 二度押し・同じ内容の連続送信 ----------
r = await st1.post('/api/staff/consultations', { category: 'absence', body: bodyB, urgency: 'high', shift_id: shiftB.shift_id })
ok('#194 同じ内容を続けて送ると 409', r.status === 409, r)

// ---------- 送り先・対象の検証 ----------
r = await st1.post('/api/staff/consultations', { category: 'question', body: `B社への質問${tag}`, company_id: cr.data.company_id || (g.companies.find(c => !c.current) || {}).company_id })
const viaCompany = (await adminB.get('/api/admin/consultations')).data.consultations.find(c => c.body === `B社への質問${tag}`)
ok('#222 会社を選んだ相談（シフトなし）はその会社に届く', r.status === 200 && viaCompany && viaCompany.target_date == null, [r, viaCompany])
r = await st1.post('/api/staff/consultations', { category: 'question', body: 'x', company_id: 999999 })
ok('所属していない会社は 404', r.status === 404, r)
r = await st1.post('/api/staff/consultations', { category: 'absence', body: '他人のシフト', shift_id: shift2.shift_id })
ok('他人のシフトは 404', r.status === 404, r)
r = await st1.post('/api/staff/consultations', { category: 'question', body: '他社の案件', target_project_id: projB.project_id })
ok('自社の行で、シフトのない（他社の）案件は指定できない（404）', r.status === 404, r)
r = await st1.post('/api/staff/consultations', { category: 'question', body: '日付が変', target_date: '2026-02-30' })
ok('実在しない日付は 400', r.status === 400, r)
r = await st1.post('/api/staff/consultations', { category: 'shift', body: `自社シフトの相談${tag}`, shift_id: shiftA.shift_id })
ok('自社のシフトを選んだ相談は自社に届く', r.status === 200 && r.data.company_name !== `相談確認B社${tag}`, r)
const consultA = r.data.consultation_id

// ---------- #222 相談履歴は全所属分を会社名付きで ----------
g = (await st1.get('/api/staff/consultations')).data
const hB = g.consultations.find(c => c.consultation_id === consultB), hA = g.consultations.find(c => c.consultation_id === consultA)
ok('#222 相談履歴に B 社と自社の相談が会社名付きで出る', hB && hA && hB.company_name === `相談確認B社${tag}` && hB.target_project_name === `B社の案件${tag}`, [hB, hA])

// ---------- #320 返信の既読 ----------
let home = (await st1.get('/api/staff/home')).data
ok('#320 返信がなければバナーの件数は 0', home.replied_consultations === 0, home.replied_consultations)
const replyA = `ご連絡ありがとうございます。\n・体調に気をつけてください\n・明日の朝に連絡します`
r = await admin.put(`/api/admin/consultations/${consultA}`, { manager_reply: replyA, status: 'in_progress' })
ok('#422 複数行の返信を保存できる', r.status === 200, r)
home = (await st1.get('/api/staff/home')).data
ok('#320 返信するとバナーの件数が 1 になる', home.replied_consultations === 1, home.replied_consultations)
g = (await st1.get('/api/staff/consultations')).data
ok('#320 未読の返信がある相談を先頭に出す', g.consultations[0].consultation_id === consultA && g.consultations[0].reply_unread === 1, g.consultations.slice(0, 2))
ok('#422 返信の改行が保たれる', g.consultations[0].manager_reply === replyA, g.consultations[0].manager_reply)
const notifs = (await st1.get('/api/staff/notifications')).data
ok('#320 スタッフの通知一覧に返信の通知が出る', notifs.notifications.some(n => n.kind === 'consult_reply' && n.related_id === consultA && !n.read_at), notifs.notifications.slice(0, 2))
// B 社からの返信も（企業を切り替えずに）バナーに数える
r = await adminB.put(`/api/admin/consultations/${consultB}`, { manager_reply: '承知しました。気をつけて来てください', status: 'in_progress' })
home = (await st1.get('/api/staff/home')).data
ok('#320 #222 他の所属会社からの返信もバナーに数える', r.status === 200 && home.replied_consultations === 2, [r, home.replied_consultations])
r = await st1.post('/api/staff/consultations/read-replies')
home = (await st1.get('/api/staff/home')).data
ok('#320 相談画面を開いて既読にするとバナーが消える', r.status === 200 && home.replied_consultations === 0, [r, home.replied_consultations])
g = (await st1.get('/api/staff/consultations')).data
ok('#320 既読にした相談は未読の印が消える', g.consultations.every(c => !c.reply_unread), g.consultations.slice(0, 2))
await admin.put(`/api/admin/consultations/${consultA}`, { manager_reply: replyA + '\n追記: 明日はお休みで大丈夫です' })
home = (await st1.get('/api/staff/home')).data
ok('#320 返信を書き直すと未読に戻る', home.replied_consultations === 1, home.replied_consultations)
await admin.put(`/api/admin/consultations/${consultA}`, { manager_reply: replyA + '\n追記: 明日はお休みで大丈夫です', status: 'done' })
home = (await st1.get('/api/staff/home')).data
ok('#320 同じ返信のままなら通知を増やさない', home.replied_consultations === 1, home.replied_consultations)
await st1.post('/api/staff/consultations/read-replies')

// ---------- 管理者の更新の検証 ----------
r = await admin.put(`/api/admin/consultations/${consultA}`, { status: 'bogus' })
ok('不正な状態は 400', r.status === 400, r)
r = await admin.put(`/api/admin/consultations/${consultA}`, { manager_reply: '   ' })
ok('空の返信は 400', r.status === 400, r)
r = await admin.put(`/api/admin/consultations/${consultB}`, { status: 'done' })
ok('他社の相談は更新できない（404）', r.status === 404, r)
r = await admin.put('/api/admin/consultations/99999999', { status: 'done' })
ok('存在しない相談は 404', r.status === 404, r)

// ---------- #90 状態での絞り込みとページ送り ----------
const old = await st2.post('/api/staff/consultations', { category: 'health', body: `古い未対応の相談${tag}` })
const oldId = old.data.consultation_id
const newer = []
// 1人が24時間に送れる相談は20件まで（#510）なので、4人で分けて送る
const senders = [st2, ...await Promise.all(['st004', 'st005', 'st006'].map(async code => client(await login('sample', code))))]
for (let i = 0; i < 52; i++) {
  const x = await senders[i % senders.length].post('/api/staff/consultations', { category: 'question', body: `質問${tag}-${i}` })
  newer.push(x.data.consultation_id)
}
for (const id of newer) await admin.put(`/api/admin/consultations/${id}`, { status: 'done' })
let act = (await admin.get('/api/admin/consultations')).data
ok('#90 既定は未完了（未対応・対応中）で、古い未対応の相談も出る', act.status === 'active' && act.consultations.some(c => c.consultation_id === oldId) && act.consultations.every(c => c.status !== 'done'), act.consultations.map(c => c.status))
const done1 = (await admin.get('/api/admin/consultations?status=done')).data
const done2 = (await admin.get('/api/admin/consultations?status=done&page=2')).data
ok('#90 対応済みはページ送りで見られる（1ページ50件）', done1.consultations.length === 50 && done2.consultations.length >= 2 && done1.total === done2.total && done1.total >= 52, [done1.consultations.length, done2.consultations.length, done1.total])
ok('#90 ページ間で重複しない', !done2.consultations.some(c => done1.consultations.some(d => d.consultation_id === c.consultation_id)))
ok('#90 状態ごとの件数を返す', done1.counts && done1.counts.done === done1.total && typeof done1.counts.open === 'number', done1.counts)
const openOnly = (await admin.get('/api/admin/consultations?status=open')).data
ok('#90 未対応だけに絞れる', openOnly.consultations.length > 0 && openOnly.consultations.every(c => c.status === 'open'), openOnly.consultations.map(c => c.status))
const bad = (await admin.get('/api/admin/consultations?status=xxx&page=-3')).data
ok('#90 不正な状態・ページは既定に戻す', bad.status === 'active' && bad.page === 1, [bad.status, bad.page])

const failed = results.filter(x => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
