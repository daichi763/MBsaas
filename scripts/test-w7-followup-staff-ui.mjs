// スタッフアプリ・報告用URL・公開応募ページの持ち越しの仕上げの統合テスト（w7-followup-staff-ui）
//   #498 『遅れます』の連絡（今日のシフトの遅刻・欠勤相談）/ #486 期間外の自分のシフトを対象にした相談
//   #427 写真なしの報告を押した時刻・一意キーで送る（端末に保存して後から送る経路）/ #163 報告用URLの電話番号
//   #362 #513 公開の募集ページの休憩・問い合わせ先 / 画面の JS の構文と主な処理の有無
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8813 node scripts/test-w7-followup-staff-ui.mjs
// 画面の操作（モーダル・IndexedDB・位置情報）はここでは確かめない。画面が使う API の形と、配信される JS を確かめる

const BASE = process.env.BASE || 'http://127.0.0.1:8813'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const info = (name, detail) => console.log(`INFO  ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`)
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
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
const jst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const today = jst(Date.now()).slice(0, 10)
const hm = (ms) => jst(ms).slice(11, 16)
const key = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36)

const PFX = 'W7U' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const pub = client(null)
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234' }), 'staff ' + k)
  return must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}${k}`)
}
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function createShift(staff_id, project_id, work_date, start_time, end_time) {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 8)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found')
  return s.shift_id
}

const pid = await newProject(`${PFX}-案件`)
const A = await newStaff('A')
const stA = client(await login('sample', `${PFX}A`))
// 今日のシフト（1時間前に開始。日をまたがないよう、0時台・22時以降は時刻をずらす）
const nowMs = Date.now()
const startMs = Math.max(nowMs - 60 * 60000, Date.parse(today + 'T00:05:00+09:00'))
const endHm = jst(Math.min(startMs + 8 * 3600000, Date.parse(today + 'T23:55:00+09:00'))).slice(11, 16)
const S1 = await createShift(A.staff_id, pid, today, hm(startMs), endHm)

// ---------- #498 『遅れます』の連絡 ----------
{
  const home = must(await stA.get('/api/staff/home?shift_id=' + S1), 'home')
  ok('#498 ホームに今日のシフトが出る（『遅れます』のボタンを出す条件: 今日・入店前）', home.shift && home.shift.shift_id === S1 && home.shift.work_date === home.today && !(home.reports || {}).check_in, home.shift)
  const body = `【遅れます】到着の見込み 10:30\n理由: 電車・バスの遅延\n${PFX}`
  const r = await stA.post('/api/staff/consultations', { category: 'absence', urgency: 'high', shift_id: S1, body })
  ok('#498 今日のシフトを対象に遅刻・欠勤相談（緊急度 高）を送れる', r.status === 200 && r.data.consultation_id, r)
  const list = (await stA.get('/api/staff/consultations')).data
  const co = (list.consultations || []).find(x => x.body === body)
  ok('#498 送った連絡は対象の日付・案件つきで相談履歴に残る', co && co.target_date === today && co.category === 'absence' && co.urgency === 'high', co)
  const again = await stA.post('/api/staff/consultations', { category: 'absence', urgency: 'high', shift_id: S1, body })
  ok('#498 二度押しは同じ連絡として断る（409）', again.status === 409, again)
}

// ---------- #486 一覧の期間外の自分のシフトを対象にした相談（打刻修正の申請から開く） ----------
{
  const old = await createShift(A.staff_id, pid, addDays(today, -20), '10:00', '18:00')
  const targets = (await stA.get('/api/staff/consultations')).data.targets || []
  ok('#486 20日前のシフトは相談の対象の一覧（前日〜7日後）にない', !targets.some(t => t.shift_id === old), targets.map(t => t.shift_id))
  const r = await stA.post('/api/staff/consultations', { category: 'other', shift_id: old, body: `管理者が代わりに申請した打刻修正について ${PFX}` })
  ok('#486 一覧にない自分のシフトでも、shift_id を付けて相談を送れる（下書きの shift_label で選んだ状態にする）', r.status === 200, r)
  const B = await newStaff('B')
  const other = await createShift(B.staff_id, pid, addDays(today, -20), '10:00', '18:00')
  const ng = await stA.post('/api/staff/consultations', { category: 'other', shift_id: other, body: `ほかの人のシフト ${PFX}` })
  ok('#486 ほかの人のシフトは対象にできない（404）', ng.status === 404, ng)
}

// ---------- #427 写真なしの報告を押した時刻・一意キーで送る ----------
{
  must(await admin.post('/api/admin/settings/photo-required', { enabled: true }), 'photo on')
  must(await admin.post('/api/admin/settings/photo-skip', { enabled: true }), 'photo skip on')
  try {
    const opt = must(await stA.get('/api/staff/photo-options?shift_id=' + S1), 'photo options')
    const reason = Object.keys(opt.reasons || {}).find(k => k !== 'other')
    ok('#427 写真なしの理由の選択肢を返す', opt.skip_allowed === true && !!reason, opt)
    const k = key(), pressed = Date.now() - 2 * 60000
    const body = { shift_id: S1, report_type: 'check_in', latitude: null, longitude: null, address: null, no_photo_reason: reason, no_photo_note: '', client_request_id: k, pressed_at: pressed }
    const r1 = await stA.post('/api/staff/attendance', body)
    ok('#427 写真なしの入店を押した時刻で記録できる（端末に保存した報告の送信）', r1.status === 200 && r1.data.device_time === true && r1.data.reported_at === jst(pressed).slice(0, 16) + ':00', r1)
    const r2 = await stA.post('/api/staff/attendance', body)
    ok('#427 同じ一意キーの再送は記録済みとして受け付ける（二重にしない）', r2.status === 200 && r2.data.duplicate === true, r2)
    const home = must(await stA.get('/api/staff/home?shift_id=' + S1), 'home 2')
    ok('#498 入店の後は『遅れます』のボタンを出さない（ホームの入店が報告済み）', !!(home.reports || {}).check_in, home.reports)
    const r3 = await stA.post('/api/staff/attendance', { ...body, report_type: 'check_out', client_request_id: key(), no_photo_reason: undefined })
    ok('#427 理由のない写真なしの退店は断る（写真が必要）', r3.status === 400, r3)
  } finally {
    await admin.post('/api/admin/settings/photo-skip', { enabled: false })
    await admin.post('/api/admin/settings/photo-required', { enabled: false })
  }
}

// ---------- #163 報告用URLの電話番号（1か所にまとめて出す） ----------
{
  const before = must(await admin.get('/api/admin/settings/site-contact'), 'site contact')
  must(await admin.put('/api/admin/settings/site-contact', { emergency_phone: '03-1111-2222', emergency_note: '', far_threshold_m: before.far_threshold_m || 500 }), 'set emergency')
  try {
    const S2 = await createShift(A.staff_id, pid, addDays(today, 1), '10:00', '18:00')
    const tok = must(await admin.post(`/api/admin/shifts/${S2}/report-link`, {}), 'issue').token
    const g = await pub.get(`/api/public/report/${tok}`)
    ok('#163 報告用URLは問い合わせの電話番号の項目（contact_phone）を返す', g.status === 200 && 'contact_phone' in g.data, g)
    const c = await pub.get(`/api/public/report/${tok}/contact`)
    ok('#163 緊急連絡先を返す（画面は連絡の欄にこちらを優先して1つだけ出す）', c.status === 200 && c.data.phone === '03-1111-2222', c)
  } finally {
    await admin.put('/api/admin/settings/site-contact', { emergency_phone: before.emergency_phone || '', emergency_note: before.emergency_note || '', far_threshold_m: before.far_threshold_m || 500 })
  }
}

// ---------- #362 #513 公開の募集ページ ----------
{
  const D = addDays(today, 6)
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', break_minutes: 60, roles: [{ role_name: '販売', headcount: 2 }] }), 'slot')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true, show_remaining: true,
    description: '', pay_note: '', contact_note: '採用担当 03-0000-0000' }), 'page')
  const g = await pub.get(`/api/public/recruit/${page.token}`)
  const role = g.data && (g.data.roles || []).find(r => r.work_date === D)
  ok('#362 公開ページの枠は休憩（break_minutes）を返す（画面は『休憩60分』を出す）', g.status === 200 && role && 'break_minutes' in role, role)
  info('#362 枠の休憩の値（枠の作成で休憩を受け付けるかは API 次第）', role && role.break_minutes)
  ok('#513 公開ページは問い合わせ先を返す（画面は電話番号を tel: のリンクにする）', g.data.contact_note === '採用担当 03-0000-0000', g.data.contact_note)
  info('#513 終了した公開ページ（410）の contact_note は w7-followup-server-a の担当。画面は返されたときだけ出す')
}

// ---------- 配信される画面の JS（構文と主な処理） ----------
{
  const js = {}
  for (const f of ['staff.js', 'staff-attendance.js', 'staff-profile.js', 'report-link.js', 'apply.js']) {
    const r = await fetch(`${BASE}/static/${f}`)
    js[f] = r.ok ? await r.text() : ''
    let syntax = true
    try { new Function(js[f]) } catch (e) { syntax = String(e) }
    ok(`画面: ${f} を配信し、構文が正しい`, r.ok && syntax === true, syntax)
  }
  ok('#498 staff.js: ホームの『遅れます』（homeLateOpen / homeLateSend）', /homeLateOpen/.test(js['staff.js']) && /category: 'absence', urgency: 'high', shift_id/.test(js['staff.js']))
  ok('#347 staff.js: 写真の画面の位置情報の表示と『もう一度取得する』', /photoRetryPosition/.test(js['staff.js']) && /id="photo-pos"/.test(js['staff.js']))
  ok('#427 staff.js: 写真なしの報告も端末に保存して送る', /no_photo_reason: it\.no_photo_reason/.test(js['staff.js']))
  ok('#155 staff.js: シフト一覧の『変更あり』（changed_at・staff_changed_at）', /shiftChangedBadge/.test(js['staff.js']) && /s\.staff_changed_at/.test(js['staff.js']))
  ok('#158 staff.js: 一覧にない日報を1件取り直して開く（/my-reports/:id を先に使う）', /daily_report_id: id/.test(js['staff.js']) && /\/api\/staff\/my-reports\/' \+ id/.test(js['staff.js']))
  ok('#158 staff.js: 未読のコメントを開いたら既読にする', /\/comment-read'/.test(js['staff.js']))
  ok('#347 staff.js: 写真の画面で取った位置が古ければ取り直す', /PHOTO_POS_MAX_AGE_MS/.test(js['staff.js']))
  ok('#524 staff.js: 日報の項目がない案件の案内', /report-no-template/.test(js['staff.js']))
  ok('#486 staff-attendance.js: 代わりに出された申請から相談を開く（attConsult）', /attConsult/.test(js['staff-attendance.js']) && /shift_label/.test(js['staff-attendance.js']))
  ok('#524 staff-attendance.js: 修正申請・通知の再読み込みと通知の戻るリンク', /attReloadRequests/.test(js['staff-attendance.js']) && /renderStaffNotifications = async[\s\S]{0,1500}その他へ戻る/.test(js['staff-attendance.js']))
  ok('#524 staff-profile.js: マイプロフィールの再読み込み', /renderMyProfile[\s\S]{0,400}showLoadError/.test(js['staff-profile.js']))
  ok('#163 report-link.js: 緊急連絡先を連絡の欄にまとめる（syncEmergency）', /syncEmergency/.test(js['report-link.js']))
  ok('#362 #513 apply.js: 休憩・終了した募集の問い合わせ先', /break_minutes/.test(js['apply.js']) && /apply-closed-contact/.test(js['apply.js']))
  // #171: 通知のリンク（#availability/YYYY-MM）から画面名を取り出す正規表現（staff-attendance.js と同じ）
  const m = js['staff-attendance.js'].match(/link\.match\((\/\^#\(\[a-z\][^\n]*?\$\/)\)/)
  let re = null; try { re = m ? eval(m[1]) : null } catch { re = null }
  ok('#171 通知のリンクの画面名: #availability/2026-11 → availability、#attendance → attendance、外部の URL は対象外',
    re && (('#availability/2026-11'.match(re) || [])[1] === 'availability') && (('#attendance'.match(re) || [])[1] === 'attendance') && !'https://x.example/#a'.match(re), m && m[1])
}

const fail = results.filter(r => !r.pass)
console.log(`\n${results.length - fail.length}/${results.length} passed`)
if (fail.length) process.exit(1)
