// 管理画面・本部画面の不具合（w11-admin-fixes: #9421 募集ページの枠と人数 / #9423 企業の停止 / #9424 #9425 企業登録の初期管理者）の統合テスト。
// #9422（入力欄のあるモーダルは背景のタップで閉じない）は画面の部品（public/static/common.js）のため、配信される common.js の中身を確かめる。
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8812 --persist-to <保存先> で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w11-admin-fixes.mjs
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8812'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = String(Date.now()).slice(-6)
const PFX = 'W11AF' + SUF

const hqLogin = await rawLogin('', 'hq')
if (hqLogin.status !== 200) { console.log('本部ユーザーでログインできません', hqLogin); process.exit(1) }
const hq = client(hqLogin.cookie)
const admin = client((await rawLogin('sample', 'admin')).cookie)

// =========================================================
// #9421 募集ページの画面で枠（日付・開始・終了・役割・募集人数）を作り、人数を直す
// =========================================================
{
  must(await admin.post('/api/admin/projects', { project_name: `${PFX} 募集案件A` }), 'project A')
  must(await admin.post('/api/admin/projects', { project_name: `${PFX} 募集案件B` }), 'project B')
  must(await admin.post('/api/admin/projects', { project_name: `${PFX} 対象外の案件` }), 'project C')
  const plist = must(await admin.get('/api/admin/projects'), 'projects').projects
  const pidA = plist.find(p => p.project_name === `${PFX} 募集案件A`).project_id
  const pidB = plist.find(p => p.project_name === `${PFX} 募集案件B`).project_id
  const pidC = plist.find(p => p.project_name === `${PFX} 対象外の案件`).project_id
  const d1 = addDays(today, 3), d2 = addDays(today, 4), dTo = addDays(today, 20)
  const base = { title: `${PFX} 週末のスタッフ`, project_ids: [pidA], date_from: today, date_to: dTo, notify_staff: false }
  const slotsOf = async (pids = [pidA], from = today, to = dTo) => must(await admin.get(`/api/admin/recruit-slots?project_ids=${pids.join(',')}&from=${from}&to=${to}`), 'recruit-slots').roles

  // 検証（どれも 400 で、ページも枠も作らない）
  const bad = [
    [{ work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 0 }, '募集人数 0'],
    [{ work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 1.5 }, '募集人数が整数でない'],
    [{ work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '', headcount: 2 }, '役割なし'],
    [{ work_date: addDays(dTo, 1), start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 2 }, '期間外の日付'],
    [{ work_date: addDays(today, -1), start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 2 }, '過ぎた日'],
    [{ work_date: d1, start_time: '10:00', end_time: '10:00', role_name: '販売', headcount: 2 }, '開始と終了が同じ'],
    [{ work_date: d1, start_time: '25:00', end_time: '19:00', role_name: '販売', headcount: 2 }, '時刻の形式'],
    [{ project_id: pidC, work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 2 }, '対象外の案件'],
  ]
  const pagesBefore = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.length
  for (const [row, label] of bad) {
    const r = await admin.post('/api/admin/recruit-pages', { ...base, new_slots: [row] })
    ok(`#9421 枠の行の検証: ${label} は 400`, r.status === 400 && /枠/.test(r.data?.error || ''), r)
  }
  const dup = await admin.post('/api/admin/recruit-pages', { ...base, new_slots: [
    { work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 2 },
    { work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 1 }] })
  ok('#9421 同じ日時・同じ役割の行が2つあると 400', dup.status === 400 && /2つ/.test(dup.data?.error || ''), dup)
  ok('#9421 検証で止めたときは、募集ページも枠も作らない', must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.length === pagesBefore && (await slotsOf()).length === 0)

  // 作成と同時に枠を作る。同じ日時の行は1つの枠の役割になる。対象の案件が1つなら案件は省略できる
  const created = await admin.post('/api/admin/recruit-pages', { ...base, new_slots: [
    { work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 3 },
    { work_date: d1, start_time: '10:00', end_time: '19:00', role_name: 'ＭＣ', headcount: 1 },
    { project_id: pidA, work_date: d2, start_time: '22:00', end_time: '06:00', role_name: '設営', headcount: 2 }] })
  ok('#9421 募集ページの作成で枠を3件作れる', created.status === 200 && created.data?.slots_created === 3, created)
  const pageId = created.data?.page_id
  let roles = await slotsOf()
  const sale = roles.find(r => r.role_name === '販売'), mc = roles.find(r => r.role_name === 'MC'), setup = roles.find(r => r.role_name === '設営')
  ok('#9421 一覧に、日付・時刻・役割・募集人数のとおりに出る（役割名は全角を半角にそろえる）', roles.length === 3 && sale?.headcount === 3 && sale.work_date === d1 && sale.start_time === '10:00' && sale.end_time === '19:00'
    && mc?.headcount === 1 && setup?.headcount === 2 && setup.start_time === '22:00' && setup.end_time === '06:00', roles)
  ok('#9421 同じ日時の行は1つの枠（shift_slots）の役割にまとまり、別の日時は別の枠になる', sale && mc && sale.slot_id === mc.slot_id && setup.slot_id !== sale.slot_id, roles)
  const pages = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages
  const page = pages.find(p => p.page_id === pageId)
  ok('#9421 募集ページの一覧の「募集中の枠・残り」に反映される', page && page.open_roles === 3 && page.open_remaining === 6, page)
  const pub = await client(null).get(`/api/public/recruit/${page?.token}`)
  const pubRoles = pub.data?.roles || []
  ok('#9421 公開ページにも枠と残り人数が出る', pub.status === 200 && pubRoles.length === 3 && pubRoles.some(r => r.role_name === '販売' && r.remaining === 3), pub.data)
  const board = must(await admin.get(`/api/admin/shift-board?from=${d1}&to=${d1}`), 'board')
  ok('#9421 作った枠はシフトボードの募集枠として出る', (board.slots || []).some(s => s.project_id === pidA && s.work_date === d1 && JSON.stringify(s).includes('販売')), (board.slots || []).length)

  // 既存の枠の人数を直す（割り当て済みより少なくはできない）
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}s1`, name: `${PFX} 一郎`, password: 'pass1234' }), 'staff')
  const st = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}s1`)
  const asg = await admin.post(`/api/admin/shift-slots/roles/${sale.slot_role_id}/assign`, { staff_ids: [st.staff_id], force: true })
  ok('（準備）販売の枠にスタッフを1名割り当てる', asg.status === 200, asg)
  let r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { slot_headcounts: [{ slot_role_id: sale.slot_role_id, headcount: 0 }] })
  ok('#9421 人数 0 には直せない（400）', r.status === 400, r)
  r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { slot_headcounts: [{ slot_role_id: mc.slot_role_id, headcount: 5 }, { slot_role_id: sale.slot_role_id, headcount: 0 }] })
  ok('#9421 1件でも正しくない人数があれば、ほかの人数も変えない', r.status === 400 && (await slotsOf()).find(x => x.slot_role_id === mc.slot_role_id).headcount === 1, r)
  // 割り当て済み（1名）より少なくはできない: 割り当て済みが2名のときに1名へ
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}s2`, name: `${PFX} 二郎`, password: 'pass1234' }), 'staff2')
  const st2 = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}s2`)
  must(await admin.post(`/api/admin/shift-slots/roles/${sale.slot_role_id}/assign`, { staff_ids: [st2.staff_id], force: true }), 'assign 2')
  r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { slot_headcounts: [{ slot_role_id: sale.slot_role_id, headcount: 1 }] })
  ok('#9421 割り当て済み（2名）より少ない人数には直せない（400・理由を返す）', r.status === 400 && /割り当て済みが2名/.test(r.data?.error || ''), r)
  r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { slot_headcounts: [{ slot_role_id: sale.slot_role_id, headcount: 2 }, { slot_role_id: mc.slot_role_id, headcount: 4 }, { slot_role_id: setup.slot_role_id, headcount: 2 }],
    new_slots: [{ work_date: d2, start_time: '09:00', end_time: '18:00', role_name: '受付', headcount: 1 }] })
  roles = await slotsOf()
  ok('#9421 編集で人数を直し、枠も足せる（変わっていない人数は数えない）', r.status === 200 && r.data?.headcounts_updated === 2 && r.data?.slots_created === 1
    && roles.find(x => x.slot_role_id === sale.slot_role_id).headcount === 2 && roles.find(x => x.slot_role_id === mc.slot_role_id).headcount === 4 && roles.some(x => x.role_name === '受付' && x.headcount === 1), { r: r.data, roles })
  ok('#9421 一覧の割り当て済みの人数', roles.find(x => x.slot_role_id === sale.slot_role_id).assigned === 2)
  r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { status: 'closed' })
  ok('#9421 枠を送らない保存（募集の終了）はこれまでどおり', r.status === 200 && r.data?.slots_created === undefined, r)
  must(await admin.put(`/api/admin/recruit-pages/${pageId}`, { status: 'open' }), 'reopen')

  // 対象の案件が2つのときは、行ごとに案件を選ぶ（省略できない）
  r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { project_ids: [pidA, pidB], new_slots: [{ work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 1 }] })
  ok('#9421 対象の案件が2つ以上のときは、案件を省略した行は 400', r.status === 400, r)
  r = await admin.put(`/api/admin/recruit-pages/${pageId}`, { project_ids: [pidA, pidB], new_slots: [{ project_id: pidB, work_date: d1, start_time: '10:00', end_time: '19:00', role_name: '販売', headcount: 2 }] })
  ok('#9421 対象の案件を足して、その案件の枠を作れる', r.status === 200 && r.data?.slots_created === 1 && (await slotsOf([pidB])).length === 1, r)

  // 他社の枠の人数は変えられない
  const otherCode = `w11o${SUF}`
  must(await hq.post('/api/hq/companies', { company_code: otherCode, company_name: `${PFX} 他社`, admin_code: 'admin', admin_name: '他社 管理者', admin_email: `w11o${SUF}@example.com`, admin_password: 'pass1234' }), 'other company')
  const other = client((await rawLogin(otherCode, 'admin')).cookie)
  r = await other.get(`/api/admin/recruit-slots?project_ids=${pidA}&from=${today}&to=${dTo}`)
  ok('#9421 他社の案件の枠は一覧に出ない', r.status === 200 && r.data.roles.length === 0, r)
  must(await other.post('/api/admin/projects', { project_name: '他社の案件' }), 'other project')
  const opid = must(await other.get('/api/admin/projects'), 'other projects').projects[0].project_id
  r = await other.post('/api/admin/recruit-pages', { title: '他社の募集', project_ids: [opid], date_from: today, date_to: dTo, notify_staff: false, slot_headcounts: [{ slot_role_id: mc.slot_role_id, headcount: 9 }] })
  ok('#9421 他社の枠の人数は変えられない（400）', r.status === 400 && (await slotsOf()).find(x => x.slot_role_id === mc.slot_role_id).headcount === 4, r)
  r = await admin.get(`/api/admin/recruit-slots?project_ids=${pidA}&from=${today}&to=${addDays(today, 70)}`)
  ok('#9421 一覧の期間は62日まで', r.status === 400, r)
}

// =========================================================
// #9422 入力欄のあるモーダルは背景のタップで閉じない（全画面で読み込む common.js）
// =========================================================
{
  const js = await (await fetch(`${BASE}/static/common.js`)).text()
  ok('#9422 common.js に、入力欄のあるモーダルの背景のクリックを止める処理がある', /modalHasInputs/.test(js) && /stopImmediatePropagation/.test(js) && /addEventListener\('click'[\s\S]*?, true\)/.test(js))
  ok('#9422 common.js に、✕（閉じる）を足す処理がある', /modal-x/.test(js) && /delegate\('modalX'/.test(js))
  for (const path of ['/admin', '/hq', '/staff']) {
    const html = await (await fetch(`${BASE}${path}`, { redirect: 'manual' })).text()
    if (/<html/i.test(html)) ok(`#9422 ${path} の画面は common.js を読み込む`, html.includes('/static/common.js'))
  }
}

// =========================================================
// #9424 #9425 企業の登録: 初期管理者のメールアドレスは必須。企業の担当者は既定で管理者と同じ
// =========================================================
{
  const co = (k) => `w11c${k}${SUF}`
  let r = await hq.post('/api/hq/companies', { company_code: co('a'), company_name: `${PFX} 登録A`, admin_code: 'admin', admin_name: '登録 太郎' })
  ok('#9425 初期管理者のメールアドレスがないと 400（入力欄を返す）', r.status === 400 && r.data?.field === 'admin_email' && /入力/.test(r.data?.error || ''), r)
  r = await hq.post('/api/hq/companies', { company_code: co('a'), company_name: `${PFX} 登録A`, admin_code: 'admin', admin_name: '登録 太郎', admin_email: '   ' })
  ok('#9425 空白だけのメールアドレスも 400', r.status === 400 && r.data?.field === 'admin_email', r)
  r = await hq.post('/api/hq/companies', { company_code: co('a'), company_name: `${PFX} 登録A`, admin_code: 'admin', admin_name: '登録 太郎', admin_email: 'taro@example' })
  ok('#9425 形式が正しくないメールアドレスは 400', r.status === 400 && r.data?.field === 'admin_email' && /形式/.test(r.data?.error || ''), r)
  const list0 = must(await hq.get('/api/hq/companies'), 'companies').companies
  ok('#9425 登録できなかった企業は作られない', !list0.some(c => c.company_code === co('a')))

  r = await hq.post('/api/hq/companies', { company_code: co('a'), company_name: `${PFX} 登録A`, admin_code: 'admin', admin_name: '登録 太郎', admin_email: ' taro@example.com ', contact_same_as_admin: true })
  ok('#9424 管理者と同じ（contact_same_as_admin）で登録できる', r.status === 200, r)
  r = await hq.post('/api/hq/companies', { company_code: co('b'), company_name: `${PFX} 登録B`, admin_code: 'boss', admin_name: '登録 花子', admin_email: 'hanako@example.com' })
  ok('#9424 企業の担当者を送らなければ管理者と同じ', r.status === 200, r)
  r = await hq.post('/api/hq/companies', { company_code: co('c'), company_name: `${PFX} 登録C`, admin_code: 'admin', admin_name: '登録 次郎', admin_email: 'jiro@example.com',
    contact_name: '経理 三郎', contact_email: 'keiri@example.com', contact_phone: '03-1111-2222' })
  ok('#9424 企業の担当者を別の人にもできる', r.status === 200, r)
  const list = must(await hq.get('/api/hq/companies'), 'companies').companies
  const A = list.find(c => c.company_code === co('a')), B = list.find(c => c.company_code === co('b')), C = list.find(c => c.company_code === co('c'))
  ok('#9424 管理者と同じ: 企業の担当者は管理者の氏名・メール', A && A.contact_name === '登録 太郎' && A.contact_email === 'taro@example.com', A)
  ok('#9424 担当者を送らないとき: 企業の担当者は管理者の氏名・メール', B && B.contact_name === '登録 花子' && B.contact_email === 'hanako@example.com', B)
  ok('#9424 別の人を入れたときはその人', C && C.contact_name === '経理 三郎' && C.contact_email === 'keiri@example.com' && C.contact_phone === '03-1111-2222', C)
  const detail = must(await hq.get(`/api/hq/companies/${A.company_id}`), 'detail')
  const adminUser = (detail.users || []).find(u => u.user_code === 'admin')
  ok('#9425 初期管理者にメールアドレスが入る', adminUser && adminUser.email === 'taro@example.com' && adminUser.name === '登録 太郎', adminUser || detail)
  r = await hq.put(`/api/hq/companies/${A.company_id}`, { contact_name: '経理 四郎', contact_email: 'shiro@example.com' })
  const A2 = must(await hq.get('/api/hq/companies'), 'companies').companies.find(c => c.company_id === A.company_id)
  ok('#9424 登録の後に企業詳細で担当者を別の人に変えられる', r.status === 200 && A2.contact_name === '経理 四郎' && A2.contact_email === 'shiro@example.com', A2)
}

// =========================================================
// #9423 解約・データの画面から企業を停止して、書き出し・契約終了へ進む
// =========================================================
{
  const code = `w11s${SUF}`
  must(await hq.post('/api/hq/companies', { company_code: code, company_name: `${PFX} 停止テスト`, admin_code: 'admin', admin_name: '停止 管理者', admin_email: `stop${SUF}@example.com`, admin_password: 'pass1234' }), 'stop company')
  const target = must(await hq.get('/api/hq/companies'), 'companies').companies.find(c => c.company_code === code)
  const adminLogin = await rawLogin(code, 'admin')
  ok('（準備）停止する企業の管理者でログインできる', adminLogin.status === 200, adminLogin)
  let ob = must(await hq.get('/api/hq/offboarding'), 'offboarding')
  ok('#9423 解約・データの一覧に、停止していない企業（停止の選択肢）が出る', (ob.active_companies || []).some(c => c.company_id === target.company_id && c.active_status === 'trial')
    && !ob.companies.some(c => c.company_id === target.company_id), ob.active_companies)
  ok('#9423 停止の選択肢に、停止中の企業と本部専用の企業は出ない', !(ob.active_companies || []).some(c => c.active_status === 'inactive' || c.active_status === 'internal'))
  let d = must(await hq.get(`/api/hq/offboarding/${target.company_id}`), 'detail')
  ok('（準備）停止前は契約終了を登録できない', (await hq.post(`/api/hq/offboarding/${target.company_id}/start`, { contract_end_date: today, confirm_company_code: code })).status === 409)
  // 画面の「この企業を停止する」と同じ呼び出し
  const r = await hq.put(`/api/hq/companies/${target.company_id}`, { active_status: 'inactive', reason: '契約終了のため（w11 テスト）' })
  ok('#9423 停止できる（その企業のログインを終える）', r.status === 200 && r.data?.revoked_sessions >= 1 && (r.data?.changed || []).includes('active_status'), r)
  const me = await client(adminLogin.cookie).get('/api/auth/me')
  ok('#9423 停止した企業の管理者はログインが切れる', me.status === 401 || me.status === 403, me.status)
  ob = must(await hq.get('/api/hq/offboarding'), 'offboarding')
  ok('#9423 停止すると、停止の選択肢から消え、解約・データの一覧に出る', !(ob.active_companies || []).some(c => c.company_id === target.company_id) && ob.companies.some(c => c.company_id === target.company_id && c.active_status === 'inactive'))
  d = must(await hq.get(`/api/hq/offboarding/${target.company_id}`), 'detail')
  ok('#9423 停止の後は、書き出しの件数を出せる', d.company.active_status === 'inactive' && Array.isArray(d.tables) && d.tables.length > 0)
  const start = await hq.post(`/api/hq/offboarding/${target.company_id}/start`, { contract_end_date: today, confirm_company_code: code })
  ok('#9423 停止の後は、そのまま契約終了を登録できる', start.status === 200 && !!start.data?.delete_after, start)
  const logs = await hq.get(`/api/hq/audit-logs?company_id=${target.company_id}`)
  if (logs.status === 200) ok('#9423 停止の理由が本部の操作の履歴に残る', JSON.stringify(logs.data).includes('契約終了のため（w11 テスト）'), logs.data)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
