// スタッフ統合・本登録と、応募時の未確認メールの扱い（w2-merge-identity: #10 #38 #89 #97 #103 #108 #109 #148 #248 #499 #505）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w2-merge-identity.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
async function tryLogin(company_code, user_code, password) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'MI' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '090' + String(Date.now() % 100000000 + (phoneSeq++)).padStart(8, '0').slice(-8)

const admin = client(await login('sample', 'admin'))
const pub = client(null)

// ---------- 共通の準備 ----------
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const pid = must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === `${PFX}-案件`).project_id
async function quick(name, type = 'own_employee', extra = {}) {
  return must(await admin.post('/api/admin/staff-quick', { name, phone: newPhone(), affiliation_type: type, force: true, ...extra }), 'staff-quick ' + name).staff_id
}
async function staffWithLogin(code, name) {
  must(await admin.post('/api/admin/staff', { user_code: code, name, password: 'pass1234' }), 'staff ' + code)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === code).staff_id
}
const lifecycle = async (sid) => must(await admin.get(`/api/admin/staff/${sid}/lifecycle`), 'lifecycle ' + sid)
const merge = (src, tgt, extra = {}) => admin.post(`/api/admin/staff/${src}/merge`, { target_staff_id: tgt, ...extra })

// ---------- #38 #148 応募フォームのメールは未確認として持ち、ログイン・再設定に使わない ----------
{
  const D = addDays(today, 10)
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 3 }] }), 'slot')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX}募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 20), description: '', pay_note: '', contact_note: '' }), 'recruit page')
  const pg = must(await pub.get(`/api/public/recruit/${page.token}`), 'public page')
  const role = pg.roles.find(r => r.work_date === D)
  const phone = newPhone(), mail = `${PFX.toLowerCase()}-apply@example.com`
  must(await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 応募 太郎`, kana: 'オウボ タロウ', phone, email: mail, agree: true, slot_role_ids: [role.slot_role_id], issued_at: Date.now() - 10000 }), 'apply')
  const app = must(await admin.get('/api/admin/recruit-applications'), 'apps').applications.find(a => a.phone === phone)
  const dec = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), new_staff_type: 'own_employee', force_new: true, force: true }), 'decide')
  const sid = dec.staff_id
  let lc = await lifecycle(sid)
  ok('#38 応募から仮登録: メールはログイン用（users.email）に入らず、未確認のメールとして持つ', lc.email === null && lc.unverified_email === mail, { email: lc.email, unverified: lc.unverified_email })
  ok('#505 本登録の画面用: lifecycle が今のフリガナを返す', lc.kana === 'オウボ タロウ', lc.kana)

  // #505 フリガナ空欄で本登録しても消えない / #148 メール欄が空欄なら未確認のメールは使われない
  const code = `${PFX}A1`
  must(await admin.post(`/api/admin/staff/${sid}/finalize`, { gender: 'male', kana: '', user_code: code, password: 'pass1234', email: '' }), 'finalize')
  lc = await lifecycle(sid)
  ok('#505 本登録: フリガナを空欄で送っても応募時のフリガナが残る', lc.kana === 'オウボ タロウ', lc.kana)
  ok('#148 本登録: メールを空欄で発行すると、ログイン用のメールは空のまま（未確認のメールは残る）', lc.email === null && lc.unverified_email === mail && lc.has_own_login, lc)
  // 再設定は users.email に一致するユーザーだけが対象（未確認のメールでは送られない）。応答は常に同じなので、メール送信ログで確かめられない場合は API の結果のみ確認
  const fp = await pub.post('/api/auth/forgot-password', { email: mail })
  ok('#148 未確認のメールで再設定を申し込んでも、同じ応答（宛先の有無を明かさない）', fp.status === 200, fp)

  // 管理者が確認したら設定できる
  const cf = await admin.post(`/api/admin/staff/${sid}/unverified-email`, { action: 'confirm' })
  lc = await lifecycle(sid)
  ok('#148 未確認のメールを確認して設定すると、ログイン用のメールに移る', cf.status === 200 && lc.email === mail && lc.unverified_email === null, { cf, lc })
}

// ---------- #148 本登録で、確認した未確認のメールを使う ----------
{
  const D = addDays(today, 11)
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 3 }] }), 'slot2')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX}募集2`, project_ids: [pid], date_from: today, date_to: addDays(today, 20), description: '', pay_note: '', contact_note: '' }), 'recruit page2')
  const pg = must(await pub.get(`/api/public/recruit/${page.token}`), 'public page2')
  const role = pg.roles.find(r => r.work_date === D)
  const phone = newPhone(), mail = `${PFX.toLowerCase()}-apply2@example.com`
  must(await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 応募 次郎`, phone, email: mail, agree: true, slot_role_ids: [role.slot_role_id], issued_at: Date.now() - 10000 }), 'apply2')
  const app = must(await admin.get('/api/admin/recruit-applications'), 'apps2').applications.find(a => a.phone === phone)
  const sid = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), new_staff_type: 'own_employee', force_new: true, force: true }), 'decide2').staff_id
  const bad = await admin.post(`/api/admin/staff/${sid}/finalize`, { gender: 'female', user_code: `${PFX}A2`, password: 'short' })
  let lc = await lifecycle(sid)
  ok('本登録: パスワードが条件に合わないと、仮登録のまま（性別も保存しない）', bad.status === 400 && lc.is_provisional && !lc.gender, { bad: bad.status, lc })
  must(await admin.post(`/api/admin/staff/${sid}/finalize`, { gender: 'female', user_code: `${PFX}A2`, password: 'pass1234', use_unverified_email: true }), 'finalize2')
  lc = await lifecycle(sid)
  ok('#148 本登録: 未確認のメールを使うと選んだときだけ、ログイン用のメールに入る', lc.email === mail && lc.unverified_email === null, lc)
}

// ---------- #89 ログインのないスタッフに後からログインを発行する ----------
{
  const r = must(await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 取引先 花子`, gender: 'female', new_partner_name: `${PFX}取引先` }), 'roster partner')
  const sid = r.staff_id
  let lc = await lifecycle(sid)
  ok('#89 ログインなしで登録したスタッフは「ログインを発行」の対象', !lc.has_login && lc.can_issue_login === true, lc)
  const code = `${PFX}P1`
  const iss = await admin.post(`/api/admin/staff/${sid}/issue-login`, { user_code: code, password: 'pass1234', email: `${PFX.toLowerCase()}-p1@example.com` })
  lc = await lifecycle(sid)
  ok('#89 ログインを発行できる', iss.status === 200 && lc.has_own_login && lc.user_code === code && lc.email === `${PFX.toLowerCase()}-p1@example.com`, { iss, lc })
  const lg = await tryLogin('sample', code, 'pass1234')
  ok('#89 発行したスタッフ番号とパスワードでログインできる', lg.status === 200 && !!lg.cookie, lg.status)
  const again = await admin.post(`/api/admin/staff/${sid}/issue-login`, { user_code: code + 'X', password: 'pass1234' })
  ok('#89 すでにログインがあるスタッフには発行できない（409）', again.status === 409, again)
  const prov = await quick(`${PFX} 仮 発行不可`)
  const pv = await admin.post(`/api/admin/staff/${prov}/issue-login`, { user_code: `${PFX}P2`, password: 'pass1234' })
  ok('#89 仮登録は本登録から発行する（issue-login は 400）', pv.status === 400, pv)
  const dup = await admin.post(`/api/admin/staff/${(must(await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 取引先 二郎`, gender: 'male', new_partner_name: `${PFX}取引先` }), 'roster p2')).staff_id}/issue-login`, { user_code: code, password: 'pass1234' })
  ok('#89 スタッフ番号が重複していれば 409', dup.status === 409, dup)
}

// ---------- #10 打刻修正申請と報告設定を移す ----------
{
  const src = await quick(`${PFX} 統合元 一郎`)
  const tgt = await staffWithLogin(`${PFX}T1`, `${PFX} 統合先 一郎`)
  const past = addDays(today, -2)
  must(await admin.post('/api/admin/shifts', { staff_id: src, project_id: pid, work_date: past, start_time: '10:00', end_time: '18:00' }), 'past shift')
  const shift = must(await admin.get(`/api/admin/shifts?from=${past}&to=${past}`), 'shifts').shifts.find(s => s.staff_id === src)
  const cr = must(await admin.post('/api/admin/corrections', { shift_id: shift.shift_id, kind: 'add', report_type: 'check_in', requested_at: `${past} 10:00`, reason: '打刻漏れ' }), 'correction')
  // 統合元の報告設定（入店のみ OFF）
  const settings = { wake_up: true, departure: true, check_in: false, work_start: true, break_start: true, break_end: true, work_end: true, check_out: true }
  must(await admin.put(`/api/admin/report-settings/projects/${pid}/staff/${src}`, { settings }), 'report settings')
  const dry = must(await merge(src, tgt, { dry_run: true }), 'dry run')
  ok('#10 dry_run: 打刻修正申請（承認待ちを含む）と引き継ぐ報告設定の件数を出す', dry.counts.attendance_corrections === 1 && dry.counts.attendance_corrections_pending === 1 && dry.counts.report_settings === 8
    && dry.effects.some(e => e.includes('打刻修正申請 1件（うち承認待ち 1件）')) && dry.effects.some(e => e.includes('報告設定 8件')), dry)
  const mr = await merge(src, tgt, { force: true })
  ok('#10 統合できる', mr.status === 200, mr)
  const det = must(await admin.get(`/api/admin/corrections/${cr.correction_id}`), 'correction detail')
  const c = det.correction || det
  ok('#10 打刻修正申請の staff_id が統合先になる', c.staff_id === tgt, det)
  const ap = await admin.post(`/api/admin/corrections/${cr.correction_id}/approve`, { exception: true })
  const sh = must(await admin.get(`/api/admin/shifts?from=${past}&to=${past}`), 'shifts2').shifts.find(s => s.shift_id === shift.shift_id)
  ok('#10 承認すると、統合先のシフトとして勤怠が作られる', ap.status === 200 && sh && sh.staff_id === tgt, { ap: ap.status, sh })
  const rs = must(await admin.get(`/api/admin/report-settings/projects/${pid}`), 'report settings get')
  const row = (rs.staff || rs.members || []).find(s => s.staff_id === tgt)
  ok('#10 報告設定（入店 OFF）が統合先に引き継がれる', row && (row.values ? row.values.check_in === 0 : row.settings?.check_in === 0), row || Object.keys(rs))
}

// ---------- #97 統合先が退職済みなら統合できない / #499 単価ルールの重なり ----------
{
  const src = await quick(`${PFX} 統合元 二郎`)
  const tgt = await staffWithLogin(`${PFX}T2`, `${PFX} 統合先 二郎`)
  must(await admin.post('/api/admin/rate-rules', { project_id: pid, staff_id: tgt, pay_unit_type: 'hourly', pay_rate: 1500 }), 'rule tgt')
  const srcRule = must(await admin.post('/api/admin/rate-rules', { project_id: pid, staff_id: src, pay_unit_type: 'hourly', pay_rate: 1200 }), 'rule src').rule_id
  let dry = must(await merge(src, tgt, { dry_run: true }), 'dry 499')
  ok('#499 dry_run: 同じ範囲のスタッフ別ルールの重なりを警告に出す（統合先 1,500円／統合元 1,200円）', dry.warnings.some(w => w.includes('単価ルール') && w.includes('1,500円') && w.includes('1,200円')), dry.warnings)
  const nf = await merge(src, tgt, {})
  ok('#499 確認なし（force なし）では実行しない（409）', nf.status === 409 && nf.data.need_force, nf)
  // 統合先を退職にする（昨日の退職日）
  await admin.put(`/api/admin/employees/${tgt}`, { profile: { retired_at: addDays(today, -1), employment_status: 'retired', retired_at_confirmed: true } })
  const cand = must(await admin.get(`/api/admin/staff/${src}/merge-candidates?q=${encodeURIComponent(PFX + ' 統合先 二郎')}`), 'candidates')
  const cRow = cand.candidates.find(x => x.staff_id === tgt)
  ok('#97 統合候補に「退職」の印が付く', cRow && cRow.inactive === '退職', cRow)
  const rd = await merge(src, tgt, { dry_run: true })
  const rf = await merge(src, tgt, { force: true })
  ok('#97 統合先が退職済みなら、確認画面でも force を付けても統合できない（409）', rd.status === 409 && rf.status === 409 && String(rf.data?.error || '').includes('退職済み'), { rd, rf })
  ok('#97 拒否したとき、統合元は統合されないまま', !(await lifecycle(src)).merged_into_staff_id)
  // 在籍状況を戻してから統合する
  must(await admin.put(`/api/admin/employees/${tgt}`, { profile: { retired_at: null, employment_status: 'working' } }), 'restore tgt')
  const mr = await merge(src, tgt, { force: true })
  const rules = must(await admin.get(`/api/admin/rate-rules?project_id=${pid}`), 'rules').rules.filter(r => r.staff_id === tgt || r.staff_id === src || r.rule_id === srcRule)
  ok('#499 実行後: 統合先のルール（1,500円）だけが残り、統合元のルールは削除される', mr.status === 200 && rules.length === 1 && rules[0].pay_rate === 1500 && rules[0].staff_id === tgt, rules)
}

// ---------- #108 #109 従業員管理のデータ ----------
{
  // #108: 統合元・統合先の両方に従業員データ → 統合元は在職者一覧から外れ、雇用終了の欄に出る。保存もできない
  const src = await quick(`${PFX} 統合元 三郎`)
  const tgt = await staffWithLogin(`${PFX}T3`, `${PFX} 統合先 三郎`)
  must(await admin.put(`/api/admin/employees/${src}`, { employee_number: `${PFX}E1` }), 'emp src')
  must(await admin.put(`/api/admin/employees/${tgt}`, { employee_number: `${PFX}E2` }), 'emp tgt')
  const mr = await merge(src, tgt, { force: true })
  const emps = must(await admin.get('/api/admin/employees'), 'employees')
  ok('#108 統合済みの行は従業員管理の在職者一覧に出ない', mr.status === 200 && !emps.employees.some(e => e.staff_id === src) && emps.employees.some(e => e.staff_id === tgt), mr.status)
  const endedRow = emps.ended.find(e => e.staff_id === src)
  ok('#108 統合元に残った従業員データは雇用終了の欄に出る（統合済みの印）', endedRow && endedRow.merged_into_staff_id === tgt && endedRow.employment_ended_at === addDays(today, -1), endedRow)
  const put = await admin.put(`/api/admin/employees/${src}`, { employee_number: `${PFX}E1`, profile: { retired_at: null, employment_status: 'working' } })
  ok('#108 統合済みの行は従業員管理から保存できない', put.status === 404 || put.status === 409, put)

  // #109: 統合先が自社雇用でない → 従業員データを移さず、統合元に雇用終了として残す
  const src2 = await quick(`${PFX} 統合元 四郎`)
  const tgt2 = await quick(`${PFX} 統合先 四郎`, 'daily_worker')
  must(await admin.post(`/api/admin/staff/${tgt2}/finalize`, { gender: 'male' }), 'finalize tgt2')
  must(await admin.put(`/api/admin/employees/${src2}`, { employee_number: `${PFX}E3`, bank_name: 'テスト銀行' }), 'emp src2')
  const dry = must(await merge(src2, tgt2, { dry_run: true }), 'dry 109')
  ok('#109 dry_run: 統合先が自社雇用でなければ、従業員データを移さないことを警告する', dry.warnings.some(w => w.includes('移さず')) && !dry.effects.some(e => e.includes('統合先へ移します')), dry)
  must(await merge(src2, tgt2, { force: true }), 'merge 109')
  const d = await admin.get(`/api/admin/employees/${src2}`)
  ok('#109 統合元の従業員データは統合元に残り、閲覧のみで開ける', d.status === 200 && d.data.read_only && d.data.record && d.data.record.bank_name === 'テスト銀行', d)
}

// ---------- #248 #103 他社に連携した仮登録の統合と、本登録でのログイン ----------
{
  const hq = client(await login('sample', 'hq'))
  const bCode = `${PFX.toLowerCase()}b`
  must(await hq.post('/api/hq/companies', { company_code: bCode, company_name: `${PFX}連携先B株式会社`, admin_code: 'admin', admin_password: 'pass1234' }), 'company B')
  const B = client(await login(bCode, 'admin'))
  const linkTo = async (api, code) => {
    const terms = await api.get('/api/admin/roster/consent-terms')
    return must(await api.post('/api/admin/roster/link', { code, agreed: true, consent_version: terms.data.version }), 'link').staff_id
  }
  // #103: 仮登録のまま B に連携 → 本登録でログインを発行 → B のシフトもアプリに出る（企業の切り替えに B が出る）
  const p1 = await quick(`${PFX} 連携 五郎`)
  const p1Code = must(await admin.get(`/api/admin/roster/${p1}/share-code`), 'share-code').global_staff_code
  await linkTo(B, p1Code)
  must(await admin.post(`/api/admin/staff/${p1}/finalize`, { gender: 'male', user_code: `${PFX}L1`, password: 'pass1234' }), 'finalize p1')
  const st = client(await login('sample', `${PFX}L1`))
  const cos = must(await st.get('/api/staff/me/companies'), 'companies')
  ok('#103 本登録でログインを発行すると、仮登録中に連携した会社も切り替え先に出る', cos.companies.some(x => x.company_name === `${PFX}連携先B株式会社`), cos)

  // #248: 仮登録を B に連携 → 既存のスタッフに統合 → B の連携は統合先に引き継がれる
  const p2 = await quick(`${PFX} 連携 六郎`)
  const p2Code = must(await admin.get(`/api/admin/roster/${p2}/share-code`), 'share-code2').global_staff_code
  const bRow = await linkTo(B, p2Code)
  const tgt = await staffWithLogin(`${PFX}T6`, `${PFX} 連携先 六郎`)
  const dry = must(await merge(p2, tgt, { dry_run: true }), 'dry 248')
  ok('#248 dry_run: 他社の連携を統合先に引き継ぐことを出す', dry.counts.linked_rows === 1 && dry.effects.some(e => e.includes('他社 1社 の連携を統合先に引き継ぎます')), dry)
  must(await merge(p2, tgt, { force: true }), 'merge 248')
  const links = must(await admin.get(`/api/admin/roster/${tgt}/links`), 'links')
  ok('#248 統合先の「連携状況」に B が出る', (links.links || []).some(l => l.linked_staff_id === bRow), links)
  const chat = await admin.get(`/api/admin/roster-chat/${tgt}?host_staff_id=${bRow}`)
  ok('#248 統合先から B との企業間チャットを開ける', chat.status === 200, chat)
  // 統合先はログインあり（staff）なので、B の行もアプリで使える
  const st6 = client(await login('sample', `${PFX}T6`))
  const cos6 = must(await st6.get('/api/staff/me/companies'), 'companies6')
  ok('#103 #248 統合先のログインから、B が切り替え先に出る', cos6.companies.some(x => x.company_name === `${PFX}連携先B株式会社`), cos6)
}

// ---------- #38 統合で未確認のメールを統合先のログイン用にコピーしない ----------
{
  const D = addDays(today, 12)
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 3 }] }), 'slot3')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX}募集3`, project_ids: [pid], date_from: today, date_to: addDays(today, 20), description: '', pay_note: '', contact_note: '' }), 'recruit page3')
  const pg = must(await pub.get(`/api/public/recruit/${page.token}`), 'public page3')
  const role = pg.roles.find(r => r.work_date === D)
  const phone = newPhone(), mail = `${PFX.toLowerCase()}-attacker@example.com`
  must(await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 統合先 七郎`, phone, email: mail, agree: true, slot_role_ids: [role.slot_role_id], issued_at: Date.now() - 10000 }), 'apply3')
  const app = must(await admin.get('/api/admin/recruit-applications'), 'apps3').applications.find(a => a.phone === phone)
  const src = must(await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { approve: app.items.map(i => i.item_id), new_staff_type: 'own_employee', force_new: true, force: true }), 'decide3').staff_id
  const tgt = await staffWithLogin(`${PFX}T7`, `${PFX} 統合先 七郎`) // メールなし
  const dry = must(await merge(src, tgt, { dry_run: true }), 'dry 38')
  ok('#38 dry_run: 統合元のメールをログイン用に使わないことを出す', dry.effects.some(e => e.includes(mail) && e.includes('未確認')), dry.effects)
  must(await merge(src, tgt, { force: true }), 'merge 38')
  const lc = await lifecycle(tgt)
  ok('#38 統合先のログイン用のメールは空のまま、未確認のメールとして残る', lc.email === null && lc.unverified_email === mail, lc)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
