// シフト希望（出勤可能日）の回収の対象をスタッフごとに選ぶ（Sprint 17 #9907。w17-shift-collect）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w17-shift-collect.mjs
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addMonths = (m, n) => { const [y, mm] = m.split('-').map(Number); const t = y * 12 + mm - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}` }
const thisMonth = today.slice(0, 7), defaultMonth = addMonths(thisMonth, 1)

const admin = client(await login('sample', 'admin'))
const st3 = client(await login('sample', 'st003')) // staff_id 3（対象外にする人）
const st4 = client(await login('sample', 'st004')) // staff_id 4（対象のままの人）
const S_EX = 3, S_IN = 4

// 同じ DB で流し直せるよう、まだ通知していない月で、staff_id 3・4 が未提出の月（翌月〜3か月先）を使う
let month = null
for (const m of [1, 2, 3].map(n => addMonths(thisMonth, n))) {
  const a = (await admin.get('/api/admin/availability?month=' + m)).data
  if (a.staff && !a.last_reminded_at && [S_EX, S_IN].every(id => a.staff.some(x => x.staff_id === id && !x.submitted_at))) { month = m; break }
}
if (!month) { console.log('FAIL  使える月がありません（DB を作り直してください）'); process.exit(1) }
// 前回の実行で対象外にしたままなら戻しておく
await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX, S_IN], target: true })

// ---------- 既定は今までどおり「対象」 ----------
const list0 = (await admin.get('/api/admin/staff')).data.staff
ok('#9907 スタッフ一覧に回収の対象外の印（availability_exempt）が付き、既定は 0（対象）', list0.length && list0.every(s => Number(s.availability_exempt) === 0), list0.slice(0, 2))
const a0 = (await admin.get('/api/admin/availability?month=' + month)).data
ok('#9907 出勤可能日の一覧に exempt が付き、既定は false', a0.staff.every(s => s.exempt === false), a0.staff.slice(0, 2))
if (month === defaultMonth) {
  const sm0 = (await st3.get('/api/staff/availability/summary')).data
  ok('#9907 対象の人には案内用に target: true・未提出を返す（今までどおり案内が出る）', sm0.target === true && sm0.submitted === false, sm0)
}
const g0 = (await st3.get('/api/staff/availability?month=' + month)).data
ok('#9907 提出画面にも target: true を返す', g0.target === true, g0)

// ---------- 検証・権限 ----------
const bad = [
  ['target が真偽値でない', { staff_ids: [S_EX], target: 'false' }],
  ['target がない', { staff_ids: [S_EX] }],
  ['staff_ids が空', { staff_ids: [], target: false }],
  ['staff_ids が配列でない', { staff_ids: S_EX, target: false }],
  ['staff_ids に数でない値', { staff_ids: [S_EX, 'abc'], target: false }],
  ['staff_ids に 0', { staff_ids: [0], target: false }],
  ['501人', { staff_ids: Array.from({ length: 501 }, (_, i) => i + 1), target: false }],
]
for (const [name, body] of bad) {
  const r = await admin.put('/api/admin/availability/targets', body)
  ok(`#9907 検証: ${name}は 400`, r.status === 400, r)
}
const nf = await admin.put('/api/admin/availability/targets', { staff_ids: [999999], target: false })
ok('#9907 ほかの会社・存在しないスタッフは 404', nf.status === 404, nf)
const forb = await st3.put('/api/admin/availability/targets', { staff_ids: [S_EX], target: false })
ok('#9907 スタッフは管理者の API を使えない（403）', forb.status === 403, forb)
// ほかの会社の管理者は、この会社のスタッフを変えられない（会社の行だけを変える）
const tag = Date.now().toString(36).slice(-5)
const hq = client(await login('sample', 'hq'))
const codeB = 'sc' + tag, pwB = 'Sc-Passw0rd-' + tag
const crB = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `回収対象B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
ok('（前提）B 社を作成', crB.status === 200, crB)
const adminB = client(await login(codeB, 'adminb', pwB))
const xB = await adminB.put('/api/admin/availability/targets', { staff_ids: [S_EX, S_IN], target: false })
ok('#9907 ほかの会社の管理者がこの会社のスタッフを指定しても 404（変わらない）', xB.status === 404, xB)
const after = (await admin.get('/api/admin/staff')).data.staff.find(s => s.staff_id === S_EX)
ok('#9907 失敗した操作では変わらない', Number(after.availability_exempt) === 0, after)

// ---------- 対象外にする ----------
const t1 = await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX], target: false })
ok('#9907 スタッフを回収の対象外にできる', t1.status === 200 && t1.data.staff === 1 && t1.data.changed === 1 && t1.data.target === false, t1)
const t1b = await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX], target: false })
ok('#9907 すでに対象外の人をもう一度対象外にしても changed は 0', t1b.status === 200 && t1b.data.staff === 1 && t1b.data.changed === 0, t1b)
const list1 = (await admin.get('/api/admin/staff')).data.staff
ok('#9907 スタッフ一覧で対象外の人が分かる（ほかの人は変わらない）', Number(list1.find(s => s.staff_id === S_EX).availability_exempt) === 1 && Number(list1.find(s => s.staff_id === S_IN).availability_exempt) === 0)
const det = (await admin.get('/api/admin/staff/' + S_EX)).data
ok('#9907 スタッフ詳細にも availability_exempt を返す（詳細の「する／しない」に使う）', Number((det.profile || det).availability_exempt) === 1, Object.keys(det).slice(0, 5))

const a1 = (await admin.get('/api/admin/availability?month=' + month)).data
const ex = a1.staff.find(s => s.staff_id === S_EX)
ok('#9907 出勤可能日の一覧で対象外の人に exempt: true が付く', ex && ex.exempt === true, ex)
const lastTargetIdx = a1.staff.map(s => s.exempt).lastIndexOf(false), firstExIdx = a1.staff.findIndex(s => s.exempt)
ok('#9907 対象外の人は一覧の後ろに出る', firstExIdx > lastTargetIdx, { firstExIdx, lastTargetIdx })
ok('#9907 対象外にしても出勤可能日の一覧からは消えない（提出すれば見られる）', a1.staff.length === a0.staff.length, [a0.staff.length, a1.staff.length])

// スタッフアプリ: 対象外の人には案内を出さない（target: false）。対象の人は今までどおり
if (month === defaultMonth) {
  const sm1 = (await st3.get('/api/staff/availability/summary')).data
  ok('#9907 対象外の人のシフト画面の案内用に target: false を返す', sm1.target === false && sm1.submitted === false, sm1)
  const sm2 = (await st4.get('/api/staff/availability/summary')).data
  ok('#9907 対象の人は target: true のまま', sm2.target === true, sm2)
}
const g1 = (await st3.get('/api/staff/availability?month=' + month)).data
ok('#9907 対象外の人の提出画面に target: false を返す（提出はできる: editable のまま）', g1.target === false && g1.editable === true, g1)

// 提出のお願いの通知: 対象外の人には届かず、対象の未提出の人には届く
const rm = await admin.post('/api/admin/availability/remind', { month })
ok('#9907 未提出の人に通知できる', rm.status === 200 && rm.data.sent >= 1, rm)
const n3 = (await st3.get('/api/staff/notifications')).data.notifications || []
ok('#9907 対象外の人には提出のお願いの通知が届かない', !n3.some(x => x.kind === 'availability_request' && x.link === '#availability/' + month), n3.slice(0, 3))
const n4 = (await st4.get('/api/staff/notifications')).data.notifications || []
ok('#9907 対象の未提出の人には今までどおり届く', n4.some(x => x.kind === 'availability_request' && x.link === '#availability/' + month), n4.slice(0, 3))
// 送った人数 = 対象（ログインあり・対象外でない）で未提出の人数
const expected = a1.staff.filter(s => s.has_login && !s.exempt && !s.submitted_at).length
ok('#9907 通知した人数は、対象の未提出の人数と同じ（対象外の人を数えない）', rm.data.sent === expected, [rm.data.sent, expected])

// 対象外の人も自分から提出できる
const put = await st3.put('/api/staff/availability', { month, days: [{ date: month + '-28', status: 'ok' }] })
ok('#9907 対象外の人も自分から提出できる', put.status === 200 && put.data.count === 1, put)
const a2 = (await admin.get('/api/admin/availability?month=' + month)).data
const ex2 = a2.staff.find(s => s.staff_id === S_EX)
ok('#9907 対象外の人が提出した分は一覧に出る', ex2 && ex2.submitted_at && ex2.exempt === true && ex2.marks[27] === 'o', ex2)

// ---------- まとめて切り替える・対象に戻す ----------
const t2 = await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX, S_IN, S_IN], target: false })
ok('#9907 複数のスタッフをまとめて対象外にできる（重複は1人に数える）', t2.status === 200 && t2.data.staff === 2 && t2.data.changed === 1, t2)
const t3 = await admin.put('/api/admin/availability/targets', { staff_ids: [S_EX, S_IN, 999999], target: true })
ok('#9907 まとめて対象に戻せる（ほかの会社・存在しない人は数えない）', t3.status === 200 && t3.data.staff === 2 && t3.data.changed === 2, t3)
const list3 = (await admin.get('/api/admin/staff')).data.staff
ok('#9907 対象に戻すと一覧の印が消える', [S_EX, S_IN].every(id => Number(list3.find(s => s.staff_id === id).availability_exempt) === 0))
if (month === defaultMonth) {
  const sm3 = (await st4.get('/api/staff/availability/summary')).data
  ok('#9907 対象に戻した人には、また案内が出る（target: true・未提出）', sm3.target === true && sm3.submitted === false, sm3)
}

// 後片付け: 提出した分は残る（ほかのテストに影響しない月の末日だけ）
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
