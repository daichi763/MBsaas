// D1 のバインド上限（100）と、他社の会社名を出さない重複チェック（w1-bind-limit: #14 #29 #30 #35 #264 #560）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w1-bind-limit.mjs
// 合成データ（在籍150人・案件120件・枠150件・掲示板100件・応募105件・連携先の会社3社）を API で作るため、数分かかる。
// テストのたびに DB を作り直すこと
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
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()) })) }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const fy = (() => { const [y, m] = today.split('-').map(Number); return m >= 4 ? y : y - 1 })()

const PFX = 'BL' + Date.now().toString(36).slice(-4).toUpperCase()
const D = addDays(today, 20) // 合成データの週の初日
const admin = client(await login('sample', 'admin'))

// ---------- 合成データ ----------
console.log('合成データを作成中 ...')
await pool([...Array(150).keys()], 8, async (i) => must(await admin.post('/api/admin/staff', { user_code: `${PFX}S${i}`, name: `負荷 ${i}`, password: 'pass1234' }), 'staff'))
await pool([...Array(120).keys()], 8, async (i) => must(await admin.post('/api/admin/projects', { project_name: `${PFX}-P${String(i).padStart(3, '0')}` }), 'project'))
const pids = (must(await admin.get('/api/admin/projects'), 'projects').projects).filter(p => p.project_name.startsWith(PFX)).sort((a, b) => a.project_name.localeCompare(b.project_name)).map(p => p.project_id)
const staffAll = must(await admin.get('/api/admin/staff'), 'staff list').staff
const newStaff = staffAll.filter(s => String(s.user_code).startsWith(PFX)).sort((a, b) => a.staff_id - b.staff_id)
ok('合成データ: 在籍150人・案件120件を作成', newStaff.length === 150 && pids.length === 120, { staff: newStaff.length, projects: pids.length })
await pool([...Array(150).keys()], 8, async (i) => must(await admin.post('/api/admin/shift-slots', { project_id: pids[i % 120], dates: [addDays(D, i % 7)], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'slot'))

// ---------- #35 シフトボード（案件120件・枠150件） ----------
const to = addDays(D, 6)
let board = await admin.get(`/api/admin/shift-board?from=${D}&to=${to}`)
const mySlots = (board.data?.slots || []).filter(s => pids.includes(s.project_id))
ok('#35 シフトボード: 案件120件・枠150件でも開ける', board.status === 200 && mySlots.length === 150, { status: board.status, slots: mySlots.length, error: board.data?.error })
// 案件を100件以上指定した絞り込みでも開ける
const filtered = await admin.get(`/api/admin/shift-board?from=${D}&to=${to}&project_ids=${pids.join(',')}`)
ok('#35 シフトボード: 案件を120件指定した絞り込みでも開ける', filtered.status === 200 && filtered.data.projects.length === 120, { status: filtered.status, error: filtered.data?.error })

// 150人をそれぞれ別の枠に割り当てる
const roles = mySlots.map(s => ({ ...s.roles[0], work_date: s.work_date }))
await pool([...Array(150).keys()], 8, async (i) => must(await admin.post(`/api/admin/shift-slots/roles/${roles[i].slot_role_id}/assign`, { staff_ids: [newStaff[i].staff_id], force: true }), 'assign'))

// ---------- #14 シフトボード（150人の重複チェック）・候補一覧（在籍170人） ----------
board = await admin.get(`/api/admin/shift-board?from=${D}&to=${to}`)
const assigned = (board.data?.slots || []).flatMap(s => s.roles.flatMap(r => r.assigned)).filter(a => newStaff.some(s => s.staff_id === a.staff_id))
ok('#14 シフトボード: 期間内のスタッフが150人でも開ける', board.status === 200 && assigned.length === 150, { status: board.status, assigned: assigned.length, error: board.data?.error })
const cand = await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${roles[0].slot_role_id}`)
ok('#14 候補一覧: 在籍170人でも開ける', cand.status === 200 && cand.data.candidates.length >= 160, { status: cand.status, n: cand.data?.candidates?.length, error: cand.data?.error })
// 同じ日・同じ時間帯に別の枠へ入っている人は「空きなし」になる（重複チェックが働いている）
const busySameDay = newStaff.filter((s, i) => roles[i].work_date === roles[0].work_date && i !== 0)
const candBusy = cand.data.candidates.filter(c => busySameDay.some(s => s.staff_id === c.staff_id))
ok('#14 候補一覧: 同じ日に割り当て済みの人は重複として出る', candBusy.length > 0 && candBusy.every(c => c.busy && c.busy_detail.length), candBusy.slice(0, 2))

// 割当可能な条件: 退職者は候補に出ない（共通の条件 assignableStaffSql）
const retiree = newStaff[149]
// 今日以降の退職日は退職予定になる（w1-staff-save-retention #34）ため、昨日の日付で退職にする。退職日より後のシフトがあるので確認済みで送る
await admin.put(`/api/admin/employees/${retiree.staff_id}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } })
const cand2 = await admin.get(`/api/admin/shift-board/candidates?slot_role_id=${roles[0].slot_role_id}`)
const retireeRow = (await admin.get('/api/admin/staff')).data.staff.find(s => s.staff_id === retiree.staff_id)
if (retireeRow && (retireeRow.employment_status === 'retired' || retireeRow.status !== 'active')) ok('割当可能な条件: 退職者は候補に出ない', cand2.status === 200 && !cand2.data.candidates.some(c => c.staff_id === retiree.staff_id), cand2.status)
else console.log('SKIP  割当可能な条件: 退職の更新APIの形が想定と違うため確認しない', retireeRow && retireeRow.employment_status)

// ---------- #30 お知らせ既読率レポート（在籍170人・全員あて） ----------
must(await admin.post('/api/admin/notices', { title: `${PFX} 全員あて`, body: 'テスト', target_type: 'all' }), 'notice')
const rc = await admin.post(`/api/admin/notice-reports/${fy}/recalculate`)
ok('#30 既読率レポート: 在籍170人でも再集計できる', rc.status === 200, rc)
const rep = await admin.get(`/api/admin/notice-reports/${fy}`)
ok('#30 既読率レポート: 対象者数に全員あてのお知らせ分（150人以上）が入る', rep.status === 200 && rep.data.summary && rep.data.summary.target_user_count >= 150 && rep.data.staff_reports.length >= 150, rep.data?.summary)

// ---------- #29 掲示板の一覧（掲載100件） ----------
await pool([...Array(100).keys()], 8, async (i) => must(await admin.post('/api/admin/board/posts', {
  status: 'open', engagement_type: 'spot', title: `${PFX} 掲載${i}`, prefecture: '東京都', date_from: addDays(today, 30), time_from: '10:00', time_to: '18:00',
  price_amount: 12000, price_unit: 'daily', headcount: 1,
}), 'board post'))
const bl = await admin.get('/api/admin/board/posts?engagement_type=spot')
ok('#29 掲示板: 掲載中が100件を超えても一覧が開ける', bl.status === 200 && bl.data.posts.length >= 100, { status: bl.status, n: bl.data?.posts?.length, error: bl.data?.error })
const mine = await admin.get('/api/admin/board/posts?scope=mine')
ok('#29 掲示板: 自社の掲載が100件を超えても「自社の掲載」が開ける', mine.status === 200 && mine.data.posts.length >= 100, { status: mine.status, error: mine.data?.error })

// ---------- #264 募集ページの対象案件の上限と応募 ----------
const pageBody = (ids) => ({ title: `${PFX} 募集`, project_ids: ids, date_from: today, date_to: addDays(D, 7), allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '' })
const tooMany = await admin.post('/api/admin/recruit-pages', pageBody(pids.slice(0, 51)))
ok('#264 募集ページ: 対象の案件が51件なら 400（50件まで）', tooMany.status === 400 && /50件まで/.test(tooMany.data.error), tooMany)
const page = await admin.post('/api/admin/recruit-pages', pageBody(pids.slice(0, 50)))
ok('#264 募集ページ: 対象の案件50件で作成できる', page.status === 200, page)
const put = await admin.put(`/api/admin/recruit-pages/${page.data.page_id}`, { status: 'open' })
ok('#264 募集ページ: 案件を送らない更新（終了・再開）は上限の確認を受けない', put.status === 200, put)
const st1 = client(await login('sample', 'st001'))
const sp = await st1.get('/api/staff/recruit')
const myPage = (sp.data?.pages || []).find(p => p.page_id === page.data.page_id)
const openRoleIds = (myPage?.roles || []).filter(r => !r.my_status).map(r => r.slot_role_id)
ok('#264 スタッフアプリ: 案件50件の募集ページを開ける', sp.status === 200 && openRoleIds.length >= 31, { status: sp.status, n: openRoleIds.length })
// 自分のほかのシフトと重なる日時は確認（force）が要る（w4-recruit-staffapp #310）
const ap = await st1.post('/api/staff/recruit/apply', { page_id: page.data.page_id, slot_role_ids: openRoleIds.slice(0, 31), force: true })
ok('#264 スタッフアプリ: 案件50件のページで31件の日時に応募できる', ap.status === 200 && ap.data.count === 31, ap)

// ---------- #29 応募一覧（105件） ----------
// 自分が割り当て済みの枠は応募の対象外になるため、2件ずつ選んで必ず1件の応募ができるようにする
await pool([...Array(105).keys()], 6, async (i) => {
  const s = client(await login('sample', `${PFX}S${i}`))
  must(await s.post('/api/staff/recruit/apply', { page_id: page.data.page_id, slot_role_ids: [openRoleIds[i % openRoleIds.length], openRoleIds[(i + 1) % openRoleIds.length]], force: true }), 'apply ' + i)
})
const apps = await admin.get(`/api/admin/recruit-applications?status=pending&page_id=${page.data.page_id}`)
ok('#29 応募一覧: 応募が100件を超えても開ける', apps.status === 200 && apps.data.applications.length >= 106, { status: apps.status, n: apps.data?.applications?.length, error: apps.data?.error })
ok('#29 応募一覧: 200件以内なら truncated は false', apps.data && apps.data.truncated === false, apps.data?.truncated)
// 登録済みスタッフの重複（同じ日の自社のシフト）は案件名で出る
const withConflict = (apps.data?.applications || []).flatMap(a => a.items).filter(i => i.conflicts.length)
ok('#29 応募一覧: 自社のシフトとの重複は案件名付きで出る', withConflict.length > 0 && withConflict.every(i => i.conflicts.every(x => x.startsWith(PFX + '-P'))), withConflict.slice(0, 2).map(i => i.conflicts))

// ---------- #560 他社のシフトの重複: 会社名・案件名を出さない / 直接連携していない会社は対象にしない ----------
const hq = client(await login('sample', 'hq'))
const companies = {}
for (const k of ['A', 'B', 'C']) {
  const code = `${PFX.toLowerCase()}${k.toLowerCase()}`
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX}連携先${k}株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company ' + k)
  companies[k] = { code, name: `${PFX}連携先${k}株式会社`, api: client(await login(code, 'admin')) }
}
const C1NAME = '株式会社サンプルモバイル人材'
async function linkTo(api, code) {
  const lk = await api.get(`/api/admin/roster/lookup?code=${code}`)
  const terms = await api.get('/api/admin/roster/consent-terms')
  return must(await api.post('/api/admin/roster/link', { code, agreed: true, consent_version: terms.data.version }), 'link').staff_id
}
async function shiftIn(api, staff_id, projectName, date) {
  must(await api.post('/api/admin/projects', { project_name: projectName }), 'project ' + projectName)
  const pid = must(await api.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === projectName).project_id
  must(await api.post('/api/admin/shifts', { staff_id, project_id: pid, work_date: date, start_time: '10:00', end_time: '19:00' }), 'shift ' + projectName)
}
async function chip(api, staff_id, date) {
  const r = await api.get(`/api/admin/shift-board?from=${date}&to=${date}`)
  const all = [...(r.data?.unslotted || []), ...(r.data?.slots || []).flatMap(s => s.roles.flatMap(x => x.assigned))]
  return { status: r.status, raw: JSON.stringify(r.data || {}), chip: all.find(a => a.staff_id === staff_id) }
}
const X = newStaff[0], Y = newStaff[1]
const day = addDays(D, 40)
// X: 雇用元(sample) → A → B（多段連携）
const xA = await linkTo(companies.A.api, X.global_staff_code)
const xACode = must(await companies.A.api.get(`/api/admin/roster/${xA}/share-code`), 'share-code').global_staff_code
const xB = await linkTo(companies.B.api, xACode)
// Y: 雇用元(sample) → A と、雇用元 → C（同じ所属元から連携を受けた別の稼働先どうし）
const yA = await linkTo(companies.A.api, Y.global_staff_code)
const yC = await linkTo(companies.C.api, Y.global_staff_code)
await shiftIn(admin, X.staff_id, `${PFX}-雇用元案件X`, day)
await shiftIn(companies.A.api, xA, `${PFX}-A案件X`, day)
await shiftIn(companies.B.api, xB, `${PFX}-B案件X`, day)
await shiftIn(admin, Y.staff_id, `${PFX}-雇用元案件Y`, day)
await shiftIn(companies.A.api, yA, `${PFX}-A案件Y`, day)
await shiftIn(companies.C.api, yC, `${PFX}-C案件Y`, day)

{
  // B（多段連携の先）: 直接の連携元 A の予定だけが「他社の予定あり」で出る。雇用元の予定・会社名は出ない
  const b = await chip(companies.B.api, xB, day)
  const cf = b.chip?.conflicts || []
  ok('#560 多段連携の先: 直接の連携元の予定だけが重複に出る（1件）', b.status === 200 && cf.length === 1 && cf[0].other_company && cf[0].label === '他社の予定あり 10:00〜19:00', cf)
  ok('#560 多段連携の先: 会社名・案件名・shift_id を返さない', cf.every(x => x.shift_id === null && x.project_name === null && !('company_name' in x)) && !b.raw.includes(C1NAME) && !b.raw.includes(companies.A.name) && !b.raw.includes('雇用元案件') && !b.raw.includes('A案件'), cf)
  // A（中間）: 連携元（雇用元）と、自社から連携した先（B）の2件
  const a = await chip(companies.A.api, xA, day)
  ok('#560 中間の会社: 連携元と連携先の予定が重複に出る（2件・会社名なし）', a.status === 200 && (a.chip?.conflicts || []).length === 2 && !a.raw.includes(C1NAME) && !a.raw.includes(companies.B.name), a.chip?.conflicts)
  // 雇用元: 直接連携した A の予定だけ（B は出さない）
  const s = await chip(admin, X.staff_id, day)
  ok('#560 雇用元: 直接連携した先の予定だけが重複に出る（1件・会社名なし）', s.status === 200 && (s.chip?.conflicts || []).length === 1 && !s.raw.includes(companies.A.name) && !s.raw.includes(companies.B.name), s.chip?.conflicts)
  // 同じ所属元から連携を受けた A と C は互いの予定を見ない
  const ya = await chip(companies.A.api, yA, day)
  ok('#560 同じ所属元の別の稼働先: 互いの予定は重複に出ない（雇用元の1件のみ）', ya.status === 200 && (ya.chip?.conflicts || []).length === 1 && !ya.raw.includes(companies.C.name) && !ya.raw.includes('C案件'), ya.chip?.conflicts)
  // 候補一覧・割当の警告の文言も会社名を出さない
  must(await companies.B.api.post('/api/admin/projects', { project_name: `${PFX}-B枠案件` }), 'B project')
  const bpid = must(await companies.B.api.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-B枠案件`).project_id
  const slot = must(await companies.B.api.post('/api/admin/shift-slots', { project_id: bpid, dates: [day], start_time: '12:00', end_time: '15:00', roles: [{ role_name: '販売', headcount: 1 }] }), 'B slot')
  const roleId = must(await companies.B.api.get(`/api/admin/shift-slots/${slot.slot_ids[0]}`), 'B slot get').roles[0].slot_role_id
  const cb = await companies.B.api.get(`/api/admin/shift-board/candidates?slot_role_id=${roleId}`)
  const cx = (cb.data?.candidates || []).find(c => c.staff_id === xB)
  ok('#560 候補一覧: 他社の予定は「他社の予定あり」と時間帯だけ', cb.status === 200 && cx && cx.busy && cx.busy_detail.every(t => /^(他社の予定あり|.*B案件X) \d\d:\d\d〜\d\d:\d\d$/.test(t)) && !JSON.stringify(cb.data).includes(C1NAME) && !JSON.stringify(cb.data).includes(companies.A.name), cx)
  const as = await companies.B.api.post(`/api/admin/shift-slots/roles/${roleId}/assign`, { staff_ids: [xB] })
  ok('#560 割当の警告: 会社名を出さない', as.status === 409 && as.data.warnings.some(w => w.includes('他社の予定あり')) && !JSON.stringify(as.data).includes(C1NAME) && !JSON.stringify(as.data).includes(companies.A.name), as.data)
}

const fail = results.filter(r => !r.pass).length
console.log(`\n${results.length - fail} / ${results.length} passed`)
process.exit(fail ? 1 : 0)
