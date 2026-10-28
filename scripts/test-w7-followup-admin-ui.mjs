// 持ち越しの仕上げ（管理画面: w7-followup-admin-ui）の統合テスト
//
// 画面（public/static/*.js）が使う API の形と、配信される画面のコードを確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w7-followup-admin-ui.mjs
//   サーバー側（w7-followup-server-a / server-b）で作る API に頼る確認は、API がまだ無いときは PEND と出して失敗に数えない。
//   統合の後は STRICT=1 を付けて、PEND も失敗として数える
const BASE = process.env.BASE || 'http://127.0.0.1:8812'
const STRICT = process.env.STRICT === '1'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
// サーバー側の対応待ちの確認。ready が false なら PEND（STRICT=1 のときは失敗）
const pend = (name, ready, cond, detail) => {
  if (!ready && !STRICT) { results.push({ name, pass: true, pend: true }); console.log(`PEND  ${name}（サーバー側の対応待ち）`); return }
  ok(name, ready && cond, detail)
}

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
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const staticJs = async (name) => (await fetch(`${BASE}/static/${name}`)).text()

const PFX = 'W7U' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// ---------- 画面のコード（配信される JS） ----------
{
  const a = await staticJs('admin.js'), sb = await staticJs('shift-board.js'), st = await staticJs('settlement.js'), sl = await staticJs('staff-lifecycle.js')
  const rc = await staticJs('recruit.js'), nt = await staticJs('notifications.js'), hqjs = await staticJs('hq.js'), ro = await staticJs('roster.js')
  ok('#159 操作履歴を開く部品（opLogShow）があり、シフト詳細・精算・スタッフ詳細から開ける',
    a.includes("delegate('opLogShow'") && sl.includes('data-action="opLogShow"') && st.includes('data-action="opLogShow"') && sb.includes('data-action="opLogShow"'))
  ok('#393 打刻を修正のボタンが、報告状況・精算の明細と確認事項・スタッフ詳細のシフトにある',
    sl.includes('data-action="corrNew"') && (st.match(/data-action="corrNew"/g) || []).length >= 2 && sb.includes('data-action="corrNew"'))
  ok('#221 シフトボードの状態の変更は putShiftStatus（報告のあるシフトの欠勤は確認する）を使う', sb.includes('window.putShiftStatus') && a.includes('window.putShiftStatus = putShiftStatus'))
  ok('#339 応募がある募集ページには、未対応がなくても「応募を見る」を出す', rc.includes('p.application_count ? `<button') && rc.includes("delegate('recruitPageApps'"))
  ok('#501 応募カードに「要確認（ロボット判定できず）」のバッジ', rc.includes('a.turnstile_unverified') && rc.includes('要確認（ロボット判定できず）'))
  ok('#225 募集ページのカードに止めた送信の件数', rc.includes('p.blocked_count'))
  ok('#464 #479 通知の種類の名前（従業員の口座・給与、掲示板の保存した条件、連携）', ['employee_payroll_changed', 'board_saved_search', 'roster_linked', 'roster_link_ended'].every(k => nt.includes(k + ':')))
  ok('#165 本部のテンプレートの修正で、規則より前のキーを残せる', hqjs.includes('TPL_KEEP_KEYS.has(key)'))
  ok('#344 日報一覧に「未提出」の表示がある', a.includes('function renderMissingReports') && a.includes('/api/admin/daily-reports/missing'))
  ok('#405 写真添付の設定をアカウント設定に置き、ダッシュボードは状態だけを出す', a.includes('id="account-photo-setting"') && !/dash-photo-setting[\s\S]{0,900}data-action="photoRequiredSetting"/.test(a))
  ok('#286 スタッフ詳細のヘッダーに最終ログイン・未ログイン', a.includes('function staffLoginBadge'))
  ok('#153 お知らせの対象の案件から終了した案件を外す', a.includes("d.projects.filter(pj => pj.status === 'active'"))
  ok('9001 連携先のスタッフ詳細は生年月日・備考の欄を出さず年代を出す', a.includes("linked ? bi('年代'") && a.includes("p.affiliation_type === 'linked_external' ? '' : `<div>"))
  ok('9001 連携用QRの説明・連携の終了の確認に「生年月日」を書かない', !ro.includes('氏名・生年月日・最寄駅') && !ro.includes('基本項目（生年月日・最寄駅'))
}

// ---------- 準備: 案件・スタッフ・昨日のシフト ----------
must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件` }), 'project')
const projects = must(await admin.get('/api/admin/projects'), 'projects').projects
const P = projects.find(p => p.project_name === `${PFX}-案件`).project_id
ok('#153 案件の一覧に状態（status）がある（お知らせの対象の絞り込みに使う）', projects.every(p => typeof p.status === 'string'), projects.slice(0, 2))
const A = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} スタッフ1`, phone: phone(1), affiliation_type: 'daily_worker' }), 'staff-quick').staff_id
const Y = addDays(jstToday, -1)
const s1 = must(await admin.post('/api/admin/shifts', { staff_id: A, project_id: P, work_date: Y, start_time: '10:00', end_time: '19:00', unit_price: 12000 }), 'shift').shift_id

// ---------- #159 操作履歴（画面が使う形） ----------
must(await admin.put(`/api/admin/shifts/${s1}`, { start_time: '10:30' }), 'update')
{
  const d = must(await admin.get(`/api/admin/operation-logs?entity=shift&entity_id=${s1}`), 'logs')
  const l = d.logs[0], c = (l?.changes || []).find(x => x.field === 'start_time')
  ok('#159 履歴に操作の名前・操作した人・日時・項目の名前と前後の値がある', l && l.action_label && l.actor_name && l.created_at && c && c.label === '開始' && c.before === '10:00' && c.after === '10:30', l)
  ok('#159 履歴の ID（スタッフ・案件）の名前を返す（画面で名前にする）', String(d.names?.staff?.[A] || '').includes(PFX) && String(d.names?.project?.[P] || '').includes(PFX), d.names)
  ok('#159 続きの読み込みに使う has_more と log_id を返す', typeof d.has_more === 'boolean' && Number(l.log_id) > 0)
}

// ---------- #221 報告のあるシフトの欠勤は確認を求める（409 need_force） ----------
{
  const px = await admin.post(`/api/admin/shifts/${s1}/proxy-attendance`, { report_types: ['check_in'], times: { check_in: '10:25' } })
  ok('（前提）入店を代理入力', px.status === 200, px)
  const r1 = await admin.put(`/api/admin/shifts/${s1}`, { status: 'absent' })
  ok('#221 入店の報告があるシフトを欠勤にすると 409 need_force（画面は報告を示して確認する）', r1.status === 409 && r1.data?.need_force && Array.isArray(r1.data.warnings), r1)
  const rs0 = must(await admin.get(`/api/admin/shifts/${s1}/report-status`), 'report-status')
  ok('#393 報告状況は欠勤でないシフトで proxy_blocked が「欠勤」でない（打刻を修正のボタンを出す）', rs0.proxy_blocked !== '欠勤', rs0.proxy_blocked)
  const r2 = await admin.put(`/api/admin/shifts/${s1}`, { status: 'absent', force: true })
  ok('#221 確認の後（force）は欠勤にできる', r2.status === 200, r2)
  const rs1 = must(await admin.get(`/api/admin/shifts/${s1}/report-status`), 'report-status 2')
  ok('#393 欠勤のシフトは proxy_blocked が「欠勤」（打刻を修正のボタンを出さない）', rs1.proxy_blocked === '欠勤', rs1.proxy_blocked)
}

// ---------- #286 スタッフ詳細の最終ログイン ----------
{
  await login('sample', 'st001')
  const d = must(await admin.get('/api/admin/staff/1'), 'staff 1')
  const usedAt = (p) => p.app_last_used_at !== undefined ? p.app_last_used_at : p.last_login_at
  ok('#286 スタッフ詳細に最終利用（app_last_used_at か last_login_at）・user_role がある（ログインした人は日時）', d.profile.user_role === 'staff' && !!usedAt(d.profile), [d.profile.user_role, d.profile.app_last_used_at, d.profile.last_login_at])
  const q = must(await admin.get(`/api/admin/staff/${A}`), 'staff A')
  ok('#286 ログインしたことがない人は最終利用が空（未ログインの印）', !usedAt(q.profile), [q.profile.app_last_used_at, q.profile.last_login_at])
  ok('#497 #277 勤怠報告履歴に late_minutes・early_leave_minutes・distance_m の列がある', (d.attendance || []).every(a => 'late_minutes' in a && 'early_leave_minutes' in a && 'distance_m' in a), (d.attendance || [])[0])
}

// ---------- #405 #277 会社の設定 ----------
{
  const ph = must(await admin.get('/api/admin/settings/photo-required'), 'photo-required')
  ok('#405 写真添付の設定は今の状態・影響する案件の数・変更の記録を返す', typeof ph.enabled === 'boolean' && ph.projects && Array.isArray(ph.history), ph)
  const sc = must(await admin.get('/api/admin/settings/site-contact'), 'site-contact')
  ok('#277 位置ずれの基準（far_threshold_m）を返す', Number.isInteger(sc.far_threshold_m), sc)
}

// ---------- サーバー側の対応に頼るもの（PEND は統合の後に STRICT=1 で確かめる） ----------
{
  // 9001: 連携先には生年月日・備考を返さず、年代を返す
  const hq = client(await login('sample', 'hq'))
  const code = 'w7u' + Date.now().toString(36).slice(-5), pw = 'W7u-Passw0rd-' + code
  const cr = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: `${PFX}連携先`, admin_code: 'adminb', admin_password: pw, admin_name: 'B社 管理者' })
  ok('（前提）連携先の会社を作成', cr.status === 200, cr)
  const adminB = client(await login(code, 'adminb', pw))
  await admin.get('/api/admin/staff')
  // 所属元（sample）で st001 に生年月日と備考を入れておく
  must(await admin.put('/api/admin/employees/1', { profile: { date_of_birth: '1995-06-15' } }), 'dob')
  must(await admin.put('/api/admin/staff/1', { remarks: `${PFX} 所属元だけの備考` }), 'remarks')
  const own = must(await admin.get('/api/admin/staff/1'), 'own staff 1').profile
  const sc = await admin.get('/api/admin/roster/1/share-code')
  const terms = must(await adminB.get('/api/admin/roster/consent-terms'), 'terms')
  const lk = await adminB.post('/api/admin/roster/link', { code: sc.data?.global_staff_code, agreed: true, consent_version: terms.version })
  ok('（前提）連携先が st001 を連携', sc.status === 200 && lk.status === 200, [sc.status, lk])
  const linked = lk.status === 200 ? must(await adminB.get(`/api/admin/staff/${lk.data.staff_id}`), 'linked staff').profile : {}
  const ready = terms.version === 'v3'
  pend('9001 連携先のスタッフ詳細に生年月日・備考がなく、年代がある', ready, !linked.date_of_birth && !linked.remarks && linked.age_group === '30代' && linked.age == null, linked)
  // 年代の項目は「年代（生年月日から計算。生年月日そのものは共有しません）」の形（server-a の SHARED_SCOPE）。生年月日・備考は not_shared に入る
  pend('9001 同意文面 v3 の共有範囲に生年月日・備考がない', ready, !terms.shared.some(s => /備考/.test(s) || (/生年月日/.test(s) && !/^年代/.test(s))) && terms.shared.some(s => /^年代/.test(s))
    && terms.not_shared.some(s => /生年月日/.test(s)) && terms.not_shared.some(s => /備考/.test(s)), terms)
  ok('9001 所属元では今までどおり生年月日・備考を見られる', own.date_of_birth === '1995-06-15' && own.remarks === `${PFX} 所属元だけの備考`, [own.date_of_birth, own.remarks])

  // #344 日報の未提出の一覧
  const ms = await admin.get(`/api/admin/daily-reports/missing?from=${addDays(jstToday, -6)}&to=${jstToday}`)
  pend('#344 GET /admin/daily-reports/missing が missing[]・使った期間（from・to）・has_more を返す', ms.status !== 404,
    ms.status === 200 && Array.isArray(ms.data?.missing) && !!ms.data.from && !!ms.data.to && typeof ms.data.has_more === 'boolean'
    && ms.data.missing.every(r => r.shift_id && r.staff_name && r.project_name && 'staff_phone' in r && 'has_login' in r), ms)

  // #447 スキルシートの推薦コメントの保存
  const ss = must(await admin.get('/api/admin/staff/1/skill-sheet'), 'skill-sheet')
  const ready447 = ss.skill_sheet_comment !== undefined
  let saved = null
  if (ready447) {
    const put = await admin.put('/api/admin/staff/1/skill-sheet-comment', { comment: `${PFX} 推薦します` })
    saved = put.status === 200 ? must(await admin.get('/api/admin/staff/1/skill-sheet'), 'skill-sheet 2').skill_sheet_comment : null
  }
  pend('#447 推薦コメントを保存して読み直せる（管理者メモとは別）', ready447, saved === `${PFX} 推薦します` && !('memo' in ss.profile), saved)

  // #225 募集ページの止めた送信の件数 / #501 応募の要確認の印（募集枠・募集ページ・公開ページからの応募を作る）
  const D6 = addDays(jstToday, 6)
  must(await admin.post('/api/admin/shift-slots', { project_id: P, dates: [D6], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'slot')
  const slot = must(await admin.get(`/api/admin/shift-board?from=${D6}&to=${D6}`), 'board').slots.filter(s => s.project_id === P).pop()
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [P], date_from: jstToday, date_to: addDays(jstToday, 30), allow_staff: false, show_remaining: true, notify_staff: false, description: '', pay_note: '', contact_note: '' }), 'page')
  const ap = await fetch(`${BASE}/api/public/recruit/${page.token}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${PFX} 応募者`, phone: phone(9), agree: true, slot_role_ids: [slot.roles[0].slot_role_id], issued_at: Date.now() - 10000 }) })
  ok('（前提）公開ページから応募', ap.status === 200, await ap.text())
  const pg = must(await admin.get('/api/admin/recruit-pages'), 'recruit-pages').pages.find(p => p.page_id === page.page_id)
  pend('#225 募集ページに止めた送信の件数（blocked_count）', pg && pg.blocked_count !== undefined, Number(pg?.blocked_count) === 0, pg)
  const app = must(await admin.get(`/api/admin/recruit-applications?status=all&page_id=${page.page_id}`), 'recruit-applications').applications[0]
  pend('#501 応募に turnstile_unverified がある（判定できた・未設定の応募は印なし）', app && app.turnstile_unverified !== undefined, app && !app.turnstile_unverified, app)
  const uv = await admin.get(`/api/admin/recruit-applications?status=all&page_id=${page.page_id}&unverified=1`)
  pend('#501 要確認のみの絞り込み（unverified=1）', app && app.turnstile_unverified !== undefined, uv.status === 200 && uv.data.applications.length === 0, uv.data)

  // #169 案件詳細のインシデントの対応状況（seed の案件2にインシデントがある）
  const pd = must(await admin.get('/api/admin/projects/2'), 'project detail')
  pend('#169 案件詳細のインシデントに incident_status がある', (pd.incidents || []).some(i => i.incident_status !== undefined), pd.incidents.every(i => ['open', 'in_progress', 'done'].includes(i.incident_status || 'open')), pd.incidents)
}

const fail = results.filter(r => !r.pass).length, pendN = results.filter(r => r.pend).length
console.log(`\n${results.length - fail - pendN} passed, ${fail} failed, ${pendN} pending`)
process.exit(fail ? 1 : 0)
