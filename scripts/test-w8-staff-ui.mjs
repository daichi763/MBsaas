// スタッフアプリ・公開ページの残りの仕上げの統合テスト（w8-staff-ui）
//   #427 押した時刻（端末時刻）で記録した報告の、押し間違いの取消の時間（受け取った時刻から数える）と打刻履歴の印
//   #151 公開の募集ページで、メールを送れない設定のときは『結果はメールで届く』と案内しない
//   #285 #171 通知のリンク（#profile・#availability/YYYY-MM）からその画面を開く
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w8-staff-ui.mjs
// 画面の操作はここでは確かめない。画面が使う API の形と、配信される JS（構文と主な処理。小さな関数は取り出して動かす）を確かめる。
// サーバー側（w8-server）の対応を待つ項目は、返されていなければ INFO にする

const BASE = process.env.BASE || 'http://127.0.0.1:8812'
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

const PFX = 'W8U' + Date.now().toString(36).slice(-4).toUpperCase()
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

// ---------- 配信される画面の JS ----------
const js = {}
for (const f of ['staff.js', 'staff-attendance.js', 'staff-profile.js', 'report-link.js', 'apply.js']) {
  const r = await fetch(`${BASE}/static/${f}`)
  js[f] = r.ok ? await r.text() : ''
  let syntax = true
  try { new Function(js[f]) } catch (e) { syntax = String(e) }
  ok(`画面: ${f} を配信し、構文が正しい`, r.ok && syntax === true, syntax)
}
// 画面の JS から1行の定義を取り出して動かす
function pick(src, re) { const m = src.match(re); return m ? m[1] : null }

const pid = await newProject(`${PFX}-案件`)
const A = await newStaff('A')
const stA = client(await login('sample', `${PFX}A`))
// 今日のシフト（1時間前に開始。日をまたがないよう、0時台・22時以降は時刻をずらす）
const nowMs = Date.now()
const startMs = Math.max(nowMs - 60 * 60000, Date.parse(today + 'T00:05:00+09:00'))
const endHm = jst(Math.min(startMs + 8 * 3600000, Date.parse(today + 'T23:55:00+09:00'))).slice(11, 16)
const S1 = await createShift(A.staff_id, pid, today, hm(startMs), endHm)

// ---------- #427 押した時刻で記録した報告の取消と、打刻履歴の印 ----------
{
  // 10分前に押して、今届いた勤務開始（写真の要らない報告）。記録の時刻は押した時刻、取消の時間は受け取った時刻から数える
  const pressed = Math.max(Date.now() - 10 * 60000, startMs + 60000)
  const r1 = await stA.post('/api/staff/attendance', { shift_id: S1, report_type: 'work_start', latitude: null, longitude: null, address: null, client_request_id: key(), pressed_at: pressed })
  ok('#427 押した時刻（10分前）で勤務開始を記録できる', r1.status === 200 && r1.data.device_time === true, r1)
  const home = must(await stA.get('/api/staff/home?shift_id=' + S1), 'home')
  const ws = (home.reports || {}).work_start
  ok('#427 ホームの報告は押した時刻で記録したこと（device_time）と受け取った時刻（received_at）を返す', ws && ws.device_time === true && !!ws.received_at && ws.received_at > ws.reported_at, ws)
  // 画面の withdrawFrom（取消の時間の起点）を取り出して確かめる
  const src = pick(js['staff.js'], /const withdrawFrom = (\(x\) => \([^\n]*\))\r?\n/)
  let withdrawFrom = null; try { withdrawFrom = src ? eval(src) : null } catch { withdrawFrom = null }
  ok('#427 staff.js: 押した時刻で記録した報告は、受け取った時刻から取消の時間を数える（withdrawFrom）',
    withdrawFrom && ws && withdrawFrom(ws) === ws.received_at && withdrawFrom({ reported_at: '2026-01-01 10:00:00' }) === '2026-01-01 10:00:00'
    && withdrawFrom({ reported_at: 'a', received_at: 'b', device_time: false }) === 'a', src)
  ok('#427 staff.js: homeWithdrawable が withdrawFrom を使う', /function homeWithdrawable[\s\S]{0,400}dayjs\(withdrawFrom\(x\)\)/.test(js['staff.js']))
  // サーバーも受け取った時刻から数えるので、押してから5分を過ぎていても、届いてから5分以内なら取り消せる（画面にボタンを出す条件と同じ）
  const wd = await stA.post('/api/staff/attendance/withdraw', { shift_id: S1, report_type: 'work_start', no_break: false })
  ok('#427 押した時刻が10分前でも、届いてから5分以内なら押し間違いを取り消せる（サーバー）', wd.status === 200, wd)
  // もう一度送って、打刻履歴の印を確かめる
  must(await stA.post('/api/staff/attendance', { shift_id: S1, report_type: 'work_start', latitude: null, longitude: null, address: null, client_request_id: key(), pressed_at: pressed }), 'resend')
  const tl = must(await stA.get(`/api/staff/attendance/timeline?from=${today}&to=${today}`), 'timeline')
  const tr = ((tl.shifts || []).find(s => s.shift_id === S1) || { reports: [] }).reports.find(r => r.report_type === 'work_start')
  if (tr && (tr.device_time || tr.time_source === 'device')) ok('#427 打刻履歴の API は押した時刻で記録したこと（time_source / device_time）と受け取った時刻を返す', !!tr.received_at, tr)
  else info('#427 打刻履歴の API（GET /api/staff/attendance/timeline）はまだ time_source・received_at を返さない（w8-server の担当。返されれば画面に印が出る）', tr)
  // 画面の deviceTimeTag を取り出して動かす（esc・showAt は画面と同じ形の代わりを使う）
  const tagSrc = pick(js['staff-attendance.js'], /(function deviceTimeTag\(r, workDate\) \{[\s\S]*?\r?\n  \})/)
  let tag = null
  try {
    tag = tagSrc ? new Function('esc', 'showAt', tagSrc + '\nreturn deviceTimeTag')(
      (s) => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'),
      (at, wd) => at ? (at.slice(0, 10) === wd ? at.slice(11, 16) : at.slice(5, 16)) : '') : null
  } catch { tag = null }
  ok('#427 staff-attendance.js: 打刻履歴に『押した時刻で記録・送信 HH:MM』の印を出す（time_source / device_time のどちらでも）',
    tag && /押した時刻で記録・送信 10:12/.test(tag({ time_source: 'device', received_at: today + ' 10:12:30' }, today))
    && /押した時刻で記録/.test(tag({ device_time: true }, today)), tagSrc && tagSrc.slice(0, 120))
  ok('#427 staff-attendance.js: 打刻修正で直した報告・アプリの報告には印を出さない',
    tag && tag({ time_source: 'device', corrected_by_correction_id: 5 }, today) === '' && tag({ time_source: 'app' }, today) === '' && tag(undefined, today) === '')
  ok('#427 staff-attendance.js: 打刻履歴の行で deviceTimeTag を使う', /\$\{deviceTimeTag\(r, s\.work_date\)\}/.test(js['staff-attendance.js']))
}

// ---------- #151 公開の募集ページのメールの案内 ----------
{
  const D = addDays(today, 6)
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [D], start_time: '10:00', end_time: '18:00', roles: [{ role_name: '販売', headcount: 2 }] }), 'slot')
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 30), allow_staff: true, show_remaining: true,
    description: '', pay_note: '', contact_note: '採用担当 03-0000-0000' }), 'page')
  const g = await pub.get(`/api/public/recruit/${page.token}`)
  ok('#151 公開ページを開ける', g.status === 200, g)
  if (g.data && 'result_mail' in g.data) ok('#151 公開ページは結果のメールを送れるか（result_mail）を真偽値で返す', typeof g.data.result_mail === 'boolean', g.data.result_mail)
  else info('#151 公開ページ（GET /api/public/recruit/:token）はまだ result_mail を返さない（w8-server の担当。返されなければ今までどおりメールで届くと案内する）')
  const src = pick(js['apply.js'], /const mailOk = (\(\) => [^\n]*?)\r?\n/)
  let mailOk = null
  try { mailOk = src ? (DATA) => new Function('DATA', 'return ' + src)(DATA)() : null } catch { mailOk = null }
  ok('#151 apply.js: result_mail が false のときだけメールの案内を外す（返されない古いサーバーでは今までどおり）',
    mailOk && mailOk({ result_mail: false }) === false && mailOk({ result_mail: true }) === true && mailOk({}) === true && mailOk(null) === true, src)
  ok('#151 apply.js: 完了画面の『メールでお知らせ』も mailOk で切り替える', /renderDone\(data, !!email && mailOk\(\)\)/.test(js['apply.js']))
}

// ---------- #285 #171 通知のリンクから画面を開く ----------
{
  // staff-attendance.js の notifOpenStaff の『そのほかの画面へのリンク』の正規表現
  const m = js['staff-attendance.js'].match(/link\.match\((\/\^#\(\[a-z\][^\n]*?\$\/)\)/)
  let re = null; try { re = m ? eval(m[1]) : null } catch { re = null }
  ok('#285 連携の知らせ（リンク #profile）は profile の画面を開く', re && (('#profile'.match(re) || [])[1] === 'profile'), m && m[1])
  ok('#285 staff-profile.js: profile の画面（マイプロフィール）と共有中の会社の一覧', /routes\.profile = /.test(js['staff-profile.js']) && /あなたの情報を共有中の会社/.test(js['staff-profile.js']))
  ok('#171 出勤可能日の提出のお願い（#availability/2026-11）は availability の画面を開く', re && (('#availability/2026-11'.match(re) || [])[1] === 'availability') && /routes\.availability = /.test(js['staff.js']))
  // 連携の知らせは roster.ts が link='#profile' で作る（企業間の連携が必要なので、ここでは作らない）
  info('#285 連携の知らせの作成（roster_linked_staff）は test-w5-roster-features で確かめている')
}

const fail = results.filter(r => !r.pass)
console.log(`\n${results.length - fail.length}/${results.length} passed`)
if (fail.length) process.exit(1)
