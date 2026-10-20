// 出勤可能日の提出・一覧（#171）と、シフトのカレンダー追加（#301）の統合テスト（w5-staff-schedule）
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8825 node scripts/test-w5-staff-schedule.mjs
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
    return { status: r.status, data, headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const addMonths = (m, n) => { const [y, mm] = m.split('-').map(Number); const t = y * 12 + mm - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}` }
const thisMonth = today.slice(0, 7), defaultMonth = addMonths(thisMonth, 1)
const tag = Date.now().toString(36).slice(-5)

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001')) // staff_id 1
const st2 = client(await login('sample', 'st002')) // staff_id 2

// 同じ DB で流し直せるよう、staff_id 2 がまだ提出していない月（翌月〜3か月先）を使う
let nextMonth = null
for (const m of [1, 2, 3].map(n => addMonths(thisMonth, n))) {
  const a = (await admin.get('/api/admin/availability?month=' + m)).data
  if (a.staff && a.staff.some(x => x.staff_id === 2 && !x.submitted_at) && !a.last_reminded_at) { nextMonth = m; break }
}
if (!nextMonth) { console.log('FAIL  使える月がありません（DB を作り直してください）'); process.exit(1) }

// ---------- #171 スタッフの提出 ----------
const g0 = await st1.get('/api/staff/availability')
ok('#171 既定は翌月を開き、今月〜3か月先を選べる', g0.status === 200 && g0.data.month === defaultMonth && g0.data.months.length === 4 && g0.data.months[0] === thisMonth && g0.data.editable, g0.data)
const d1 = nextMonth + '-03', d2 = nextMonth + '-04', d3 = nextMonth + '-05'
const put1 = await st1.put('/api/staff/availability', { month: nextMonth, days: [
  { date: d1, status: 'ok' },
  { date: d2, status: 'partial', start_time: '10:00', end_time: '15:00', note: `午前のみ${tag}` },
  { date: d3, status: 'ng' },
] })
ok('#171 ○△× をまとめて提出できる', put1.status === 200 && put1.data.count === 3 && put1.data.submitted_at, put1)
const g1 = (await st1.get('/api/staff/availability?month=' + nextMonth)).data
ok('#171 提出した内容と提出日時が本人の画面に出る', g1.days.length === 3 && g1.days.find(x => x.work_date === d2)?.start_time === '10:00' && g1.days.find(x => x.work_date === d2)?.note === `午前のみ${tag}` && !!g1.submitted_at, g1)

const bad = [
  ['△に時間帯がない', { month: nextMonth, days: [{ date: d1, status: 'partial' }] }],
  ['△の開始と終了が同じ', { month: nextMonth, days: [{ date: d1, status: 'partial', start_time: '10:00', end_time: '10:00' }] }],
  ['記号が不正', { month: nextMonth, days: [{ date: d1, status: 'maybe' }] }],
  ['月の外の日付', { month: nextMonth, days: [{ date: addMonths(nextMonth, 1) + '-01', status: 'ok' }] }],
  ['同じ日が2回', { month: nextMonth, days: [{ date: d1, status: 'ok' }, { date: d1, status: 'ng' }] }],
  ['1日も付けていない', { month: nextMonth, days: [] }],
  ['備考が長すぎる', { month: nextMonth, days: [{ date: d1, status: 'ok', note: 'あ'.repeat(101) }] }],
  ['4か月先の月', { month: addMonths(thisMonth, 4), days: [{ date: addMonths(thisMonth, 4) + '-01', status: 'ok' }] }],
  ['先月', { month: addMonths(thisMonth, -1), days: [{ date: addMonths(thisMonth, -1) + '-28', status: 'ok' }] }],
  ['月の形式', { month: '2026-13', days: [{ date: d1, status: 'ok' }] }],
]
for (const [name, body] of bad) {
  const r = await st1.put('/api/staff/availability', body)
  ok(`#171 検証: ${name}は 400`, r.status === 400, r)
}
if (today > thisMonth + '-01') {
  const r = await st1.put('/api/staff/availability', { month: thisMonth, days: [{ date: thisMonth + '-01', status: 'ok' }] })
  ok('#171 今月の過ぎた日は変更できない（400）', r.status === 400, r)
}
// 出し直し: 送らなかった日は未入力に戻り、最初の提出日時は変わらない
const put2 = await st1.put('/api/staff/availability', { month: nextMonth, days: [{ date: d1, status: 'ok' }, { date: d2, status: 'partial', start_time: '10:00', end_time: '15:00', note: `午前のみ${tag}` }] })
const g2 = (await st1.get('/api/staff/availability?month=' + nextMonth)).data
ok('#171 出し直すと月の内容が置き換わる（送らなかった日は未入力）', put2.status === 200 && g2.days.length === 2 && !g2.days.some(x => x.work_date === d3), g2.days)
ok('#171 出し直しても最初の提出日時は変わらない', g2.submitted_at === g1.submitted_at, [g1.submitted_at, g2.submitted_at])
const sum1 = (await st1.get('/api/staff/availability/summary')).data
if (nextMonth === defaultMonth) ok('#171 シフト画面の案内用: 翌月は提出済み', sum1.month === nextMonth && sum1.submitted === true, sum1)

// ---------- #171 管理者の一覧・締切・通知 ----------
const a1 = await admin.get('/api/admin/availability?month=' + nextMonth)
const s1 = a1.data.staff && a1.data.staff.find(s => s.staff_id === 1)
const s2 = a1.data.staff && a1.data.staff.find(s => s.staff_id === 2)
ok('#171 管理者の一覧に提出済みの人と未提出の人が出る', a1.status === 200 && s1 && s1.submitted_at && s2 && !s2.submitted_at, a1.data.staff && a1.data.staff.slice(0, 3))
ok('#171 日ごとの記号（3日=○ 4日=△ 5日=未入力）', s1 && s1.marks.length === a1.data.days && s1.marks[2] === 'o' && s1.marks[3] === 'p' && s1.marks[4] === '-', s1 && s1.marks)
ok('#171 △の時間帯とメモは details で返す', (a1.data.details || []).some(x => x.staff_id === 1 && x.work_date === d2 && x.start_time === '10:00' && x.note === `午前のみ${tag}`), a1.data.details)
ok('#171 スタッフは管理者の一覧を開けない（403）', (await st1.get('/api/admin/availability')).status === 403)
ok('#171 管理者はスタッフの提出 API を使えない（403）', (await admin.put('/api/staff/availability', { month: nextMonth, days: [{ date: d1, status: 'ok' }] })).status === 403)

const lastDay = addDays(addMonths(nextMonth, 1) + '-01', -1)
ok('#171 締切日の形式が違えば 400', (await admin.put('/api/admin/availability/period', { month: nextMonth, deadline: '2026/10/25' })).status === 400)
ok('#171 締切日が月末より後なら 400', (await admin.put('/api/admin/availability/period', { month: nextMonth, deadline: addDays(lastDay, 1) })).status === 400)
const deadline = addDays(today, -1) // 締切を過ぎた状態にして、締切後の提出の印を確かめる
const pp = await admin.put('/api/admin/availability/period', { month: nextMonth, deadline, note: `土日歓迎${tag}` })
ok('#171 締切と案内文を保存できる', pp.status === 200 && pp.data.deadline === deadline, pp)
const g3 = (await st2.get('/api/staff/availability?month=' + nextMonth)).data
ok('#171 スタッフの提出画面に締切と案内文が出る', g3.deadline === deadline && g3.note === `土日歓迎${tag}`, g3)
const sum2 = (await st2.get('/api/staff/availability/summary')).data
if (nextMonth === defaultMonth) ok('#171 未提出の人には案内用に未提出・締切を返す', sum2.submitted === false && sum2.deadline === deadline, sum2)

const rm = await admin.post('/api/admin/availability/remind', { month: nextMonth })
ok('#171 未提出の人に通知できる', rm.status === 200 && rm.data.sent >= 1, rm)
const rm2 = await admin.post('/api/admin/availability/remind', { month: nextMonth })
ok('#171 続けて通知を押しても二重に送らない（409）', rm2.status === 409, rm2)
const n2 = (await st2.get('/api/staff/notifications')).data.notifications || []
ok('#171 未提出の人の通知に提出のお願いが届く', n2.some(x => x.kind === 'availability_request' && x.link === '#availability/' + nextMonth), n2.slice(0, 3))
const n1 = (await st1.get('/api/staff/notifications')).data.notifications || []
ok('#171 提出済みの人には届かない', !n1.some(x => x.kind === 'availability_request' && x.link === '#availability/' + nextMonth))
// 締切の後に初めて提出した人は『締切後』になる
const put3 = await st2.put('/api/staff/availability', { month: nextMonth, days: [{ date: d1, status: 'ng' }] })
ok('#171 締切後に提出すると late が付く', put3.status === 200 && put3.data.late === true, put3)
const a2 = (await admin.get('/api/admin/availability?month=' + nextMonth)).data
ok('#171 管理者の一覧でも締切後の提出が分かる', a2.staff.find(s => s.staff_id === 2)?.late === true, a2.staff.find(s => s.staff_id === 2))
// 締切を今日以降にすると、今日の提出は締切後ではない
await admin.put('/api/admin/availability/period', { month: nextMonth, deadline: lastDay })
const a3 = (await admin.get('/api/admin/availability?month=' + nextMonth)).data
ok('#171 締切までの提出は late にならない', a3.staff.find(s => s.staff_id === 1)?.late === false && a3.staff.find(s => s.staff_id === 2)?.late === false, a3.staff.filter(s => s.staff_id <= 2))
const day = (await admin.get('/api/admin/availability/day?date=' + d1)).data
ok('#171 ある日の出勤可否を staff_id ごとに取れる（シフトを組むときの参考）', (day.availability || []).some(x => x.staff_id === 1 && x.status === 'ok') && day.availability.some(x => x.staff_id === 2 && x.status === 'ng'), day)

// ---------- #301 カレンダー ----------
const proj = (await admin.get('/api/admin/projects')).data.projects[0]
const wd = addDays(today, 3), wdNight = addDays(today, 4)
const mk = async (work_date, start_time, end_time, memo) => {
  const r = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: proj.project_id, work_date, start_time, end_time, memo })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  return r.data.shift_id
}
const sh1 = await mk(wd, '10:00', '19:00', `CAL-A${tag}`)
const sh2 = await mk(wdNight, '22:00', '06:00', `CAL-B${tag}`)
const t0 = (await st1.get('/api/staff/calendar-token')).data
const iss = await st1.post('/api/staff/calendar-token')
ok('#301 購読用の URL を発行できる', iss.status === 200 && /\/api\/public\/calendar\/[0-9a-f]{64}\.ics$/.test(iss.data.url), iss)
const feedPath = new URL(iss.data.url).pathname
const f1 = await fetch(BASE + feedPath)
const ics1 = await f1.text()
ok('#301 購読 URL はログインなしで .ics を返す', f1.status === 200 && (f1.headers.get('content-type') || '').startsWith('text/calendar') && ics1.startsWith('BEGIN:VCALENDAR'), [f1.status, ics1.slice(0, 100)])
ok('#301 確定したシフトが予定として入る（UID はシフトごと）', ics1.includes(`UID:shift-${sh1}@field-os`) && ics1.includes(`UID:shift-${sh2}@field-os`), ics1.slice(0, 600))
// 10:00 JST = 01:00Z、日をまたぐ 22:00〜翌06:00 は翌日の 21:00Z まで
ok('#301 時刻は UTC で、日をまたぐシフトは翌日に終わる', ics1.includes(`DTSTART:${wd.replace(/-/g, '')}T010000Z`) && ics1.includes(`DTEND:${wdNight.replace(/-/g, '')}T210000Z`), ics1.match(/DT(START|END):[^\r]+/g))
ok('#301 行の区切りは CRLF で、1行は75バイト以内', ics1.includes('\r\n') && ics1.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75))
ok('#301 金額は入らない', !/unit_price|pay_|bill_|¥|円/.test(ics1), ics1.slice(0, 300))
// 欠勤にしたシフトは消える
await admin.put(`/api/admin/shifts/${sh1}`, { status: 'absent' })
const ics2 = await (await fetch(BASE + feedPath)).text()
ok('#301 欠勤にしたシフトは購読のカレンダーから消える', !ics2.includes(`UID:shift-${sh1}@field-os`) && ics2.includes(`UID:shift-${sh2}@field-os`))
const t1 = (await st1.get('/api/staff/calendar-token')).data
ok('#301 購読中の状態と最後に読み込まれた日時が分かる（URL そのものは返さない）', t0.active === false && t1.active === true && !!t1.last_accessed_at && !JSON.stringify(t1).includes('calendar/'), [t0, t1])
// 1件ずつ
const one = await fetch(`${BASE}/api/staff/shifts/${sh2}/ics`, { headers: { Cookie: (await login('sample', 'st001')) } })
const oneText = await one.text()
ok('#301 シフト1件の .ics をダウンロードできる', one.status === 200 && /attachment; filename="shift-\d{8}-\d+\.ics"/.test(one.headers.get('content-disposition') || '') && oneText.includes(`UID:shift-${sh2}@field-os`) && (oneText.match(/BEGIN:VEVENT/g) || []).length === 1, [one.status, oneText.slice(0, 200)])
ok('#301 欠勤のシフトの .ics は 404', (await st1.get(`/api/staff/shifts/${sh1}/ics`)).status === 404)
ok('#301 ほかの人のシフトの .ics は 404', (await st2.get(`/api/staff/shifts/${sh2}/ics`)).status === 404)
// 発行し直すと前の URL は使えない。止めると今の URL も使えない
const iss2 = await st1.post('/api/staff/calendar-token')
ok('#301 発行し直すと前の URL は 404', (await fetch(BASE + feedPath)).status === 404 && (await fetch(BASE + new URL(iss2.data.url).pathname)).status === 200)
const rv = await st1.del('/api/staff/calendar-token')
ok('#301 購読を止めると URL は 404', rv.status === 200 && (await fetch(BASE + new URL(iss2.data.url).pathname)).status === 404)
ok('#301 形式の違うトークンは 404', (await fetch(`${BASE}/api/public/calendar/abc.ics`)).status === 404)
ok('#301 管理者はスタッフのカレンダー API を使えない（403）', (await admin.post('/api/staff/calendar-token')).status === 403)

// 後片付け
await admin.del?.(`/api/admin/shifts/${sh1}`)
await admin.del?.(`/api/admin/shifts/${sh2}`)

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
