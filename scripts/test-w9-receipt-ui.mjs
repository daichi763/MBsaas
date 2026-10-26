// 交通費の申請の領収書の写真の画面（w9-receipt-ui: #273）の統合テスト
//   スタッフアプリ（勤務時間・支払）: 申請と一緒に写真を付ける・後から付ける・差し替える・確認する
//   管理画面（精算のスタッフからの申請）: 一覧と承認・却下の画面で写真を見る
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8812 node scripts/test-w9-receipt-ui.mjs
// 画面の操作はここでは確かめない。画面が使う API の流れ（申請 → 写真 → 一覧 → 画像 → 承認・却下）と、配信される JS（構文と主な処理）を確かめる。
import vm from 'node:vm'

const BASE = process.env.BASE || 'http://127.0.0.1:8812'
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
    const isForm = body instanceof FormData
    const headers = { Cookie: cookie || '' }
    if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) })
    const buf = Buffer.from(await r.arrayBuffer())
    let data = null; try { data = JSON.parse(buf.toString('utf8')) } catch { }
    return { status: r.status, data, buf, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '' }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(jstNow().slice(0, 10), -1)
const month = yesterday.slice(0, 7)

// 画面で圧縮した写真と同じ形（JPEG）。中身は最小の JPEG（SOI〜EOI）
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9', 'hex')
const JPEG2 = Buffer.concat([JPEG.subarray(0, JPEG.length - 2), Buffer.from([0x00, 0xff, 0xd9])])
// 画面と同じ送り方（FormData の photo。ファイル名は receipt.jpg）
const form = (buf) => { const f = new FormData(); f.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'receipt.jpg'); return f }

const PFX = 'W9R' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
let seq = 0
const phoneOf = () => '080' + String((Date.now() + (++seq) * 7919) % 100000000).padStart(8, '0')
async function newStaff(k) {
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: phoneOf() }), 'staff ' + k)
  const list = must(await admin.get('/api/admin/staff'), 'staff list').staff
  return list.find(s => s.user_code === `${PFX}${k}`).staff_id
}
async function newShift(staff_id, project_id, work_date) {
  const memo = `${PFX}-${++seq}`
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '10:00', end_time: '19:00', memo, force: true, confirm_warnings: true })
  if (r.status !== 200) throw new Error('shift ' + JSON.stringify(r.data))
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
}
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-領収書`, allow_duplicate: true }), 'project').project_id
const SA = await newStaff('A'), SB = await newStaff('B')
const stA = client(await login('sample', `${PFX}A`)), stB = client(await login('sample', `${PFX}B`))
const s1 = await newShift(SA, P, yesterday), s2 = await newShift(SA, P, addDays(yesterday, -1))
const shiftReqs = async (st, shiftId) => (must(await st.get(`/api/staff/pay?month=${month}`), 'staff pay').shifts.find(x => x.shift_id === shiftId) || {}).requests || []
const adminReq = async (id) => must(await admin.get('/api/admin/pay-requests'), 'admin list').requests.find(x => x.request_id === id)

// ---------- スタッフ: 申請と一緒に写真を付ける（申請 → 写真の順に送る） ----------
let id1
{
  const rq = await stA.post('/api/staff/pay/requests', { shift_id: s1.shift_id, kind: 'transport', amount: 840, route: '新宿駅〜渋谷駅', round_trip: true })
  ok('（前提）交通費を申請した（画面は返った request_id に写真を送る）', rq.status === 200 && rq.data.request_id, rq.data)
  id1 = rq.data.request_id
  let mine = (await shiftReqs(stA, s1.shift_id)).find(q => q.request_id === id1)
  ok('#273 写真を付ける前は has_receipt が false（画面は「領収書の写真を付ける」を出す）', mine && mine.has_receipt === false && mine.receipt_uploaded_at === null, mine)
  const r = await stA.post(`/api/staff/pay/requests/${id1}/receipt`, form(JPEG))
  ok('#273 画面と同じ形（JPEG・photo）で写真を送れる', r.status === 200 && r.data.has_receipt === true, r.data)
  mine = (await shiftReqs(stA, s1.shift_id)).find(q => q.request_id === id1)
  ok('#273 一覧に has_receipt と添付の時刻が出る（画面は小さな写真を出す）', mine && mine.has_receipt === true && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(mine.receipt_uploaded_at || ''), mine)
  const img = await stA.get(`/api/staff/pay/requests/${id1}/receipt?v=${encodeURIComponent(mine.receipt_uploaded_at)}`)
  ok('#273 画面の URL（?v=添付の時刻 付き）で本人が写真を見られる', img.status === 200 && /image\/jpeg/.test(img.type) && img.buf.equals(JPEG), { status: img.status, type: img.type, len: img.buf.length })
  ok('#273 写真は本人だけのキャッシュ（private）', /private/.test(img.cache), img.cache)
  const other = await stB.get(`/api/staff/pay/requests/${id1}/receipt`)
  ok('#273 ほかのスタッフは見られない（404）', other.status === 404, other.status)
  const unauth = await client('').get(`/api/staff/pay/requests/${id1}/receipt`)
  ok('#273 ログインしていなければ見られない', unauth.status === 401 || unauth.status === 403 || unauth.status === 302, unauth.status)
}

// ---------- スタッフ: 差し替える（承認されるまで） ----------
{
  const before = (await shiftReqs(stA, s1.shift_id)).find(q => q.request_id === id1).receipt_uploaded_at
  await new Promise(r => setTimeout(r, 1100)) // 添付の時刻（秒まで）が変わるように
  const r = await stA.post(`/api/staff/pay/requests/${id1}/receipt`, form(JPEG2))
  ok('#273 承認待ちの間は写真を差し替えられる', r.status === 200, r.data)
  const after = (await shiftReqs(stA, s1.shift_id)).find(q => q.request_id === id1).receipt_uploaded_at
  ok('#273 差し替えると添付の時刻が変わる（画面の URL が変わり、古い写真がキャッシュから出ない）', after && after !== before, { before, after })
  const img = await stA.get(`/api/staff/pay/requests/${id1}/receipt?v=${encodeURIComponent(after)}`)
  ok('#273 差し替えた後の写真が返る', img.status === 200 && img.buf.equals(JPEG2), img.buf.length)
}

// ---------- 管理者: 一覧・承認の画面で写真を見る ----------
{
  const q = await adminReq(id1)
  ok('#273 管理者の承認待ちの一覧に has_receipt と添付の時刻が出る', q && q.has_receipt === true && !!q.receipt_uploaded_at && !('receipt_key' in q), q)
  const img = await admin.get(`/api/admin/pay-requests/${id1}/receipt?v=${encodeURIComponent(q.receipt_uploaded_at)}`)
  ok('#273 管理者は画面の URL で写真を見られる', img.status === 200 && /image\/jpeg/.test(img.type) && img.buf.equals(JPEG2), { status: img.status, type: img.type })
  must(await admin.post(`/api/admin/pay-requests/${id1}/approve`, { amount: 840 }), 'approve')
  const mine = (await shiftReqs(stA, s1.shift_id)).find(x => x.request_id === id1)
  ok('#273 承認した後もスタッフは写真を見られる（has_receipt のまま）', mine && mine.status === 'approved' && mine.has_receipt === true, mine)
  const again = await stA.post(`/api/staff/pay/requests/${id1}/receipt`, form(JPEG))
  ok('#273 承認した後は差し替えられない（画面も「差し替える」を出さない）', again.status === 409, again.data)
}

// ---------- 写真なしの申請・後から付ける・却下の画面 ----------
{
  const rq = must(await stA.post('/api/staff/pay/requests', { shift_id: s2.shift_id, kind: 'transport', amount: 420, route: '品川駅〜大崎駅', round_trip: false }), 'request 2')
  const id2 = rq.request_id
  let q = await adminReq(id2)
  ok('#273 写真のない申請は has_receipt が false（管理画面は「領収書の写真なし」を出す）', q && q.has_receipt === false, q)
  const none = await admin.get(`/api/admin/pay-requests/${id2}/receipt`)
  ok('#273 写真のない申請の画像は 404', none.status === 404, none.status)
  must(await stA.post(`/api/staff/pay/requests/${id2}/receipt`, form(JPEG)), 'attach later')
  q = await adminReq(id2)
  ok('#273 申請した後から付けた写真が管理者の一覧に出る', q && q.has_receipt === true, q)
  must(await admin.post(`/api/admin/pay-requests/${id2}/reject`, { note: `${PFX} 区間を確認してください` }), 'reject')
  const mine = (await shiftReqs(stA, s2.shift_id)).find(x => x.request_id === id2)
  ok('#273 却下した申請も写真を見られる（has_receipt のまま）', mine && mine.status === 'rejected' && mine.has_receipt === true, mine)
  const ot = await stA.post('/api/staff/pay/requests', { shift_id: s2.shift_id, kind: 'overtime', new_end_time: '20:00', reason: `${PFX} 延長` })
  if (ot.status === 200) {
    const r = await stA.post(`/api/staff/pay/requests/${ot.data.request_id}/receipt`, form(JPEG))
    ok('#273 延長の申請には付けられない（画面も延長には写真の欄を出さない）', r.status === 400, r.data)
  } else ok('（前提）延長を申請した', false, ot.data)
}

// ---------- 配信される画面の JS ----------
const staticJs = async (name) => (await (await fetch(`${BASE}/static/${name}`)).text()).replace(/\r\n/g, '\n')
{
  const sa = await staticJs('staff-attendance.js'), st = await staticJs('settlement.js')
  const parses = (code) => { try { new vm.Script(code); return true } catch (e) { return String(e) } }
  ok('staff-attendance.js が構文として正しい', parses(sa) === true, parses(sa))
  ok('settlement.js が構文として正しい', parses(st) === true, parses(st))
  ok('#273 スタッフ: 申請の画面に写真の欄（pay-receipt-file）があり、申請の後に写真を送る', sa.includes('id="pay-receipt-file"') && /uploadReceipt\(res\.request_id/.test(sa) && sa.includes("fd.append('photo', blob, 'receipt.jpg')"))
  ok('#273 スタッフ: 一覧から写真を付ける・見る・差し替える', ['payReceiptAttach', 'payReceiptView', 'payReceiptClear'].every(a => sa.includes(`delegate('${a}'`)) && sa.includes('差し替える'))
  ok('#273 スタッフ: 写真は compressImage で縮小してから送る', /compressImage\(file\)[\s\S]{0,400}uploadReceipt|blob = await compressImage\(file\)/.test(sa))
  ok('#273 管理: 承認・却下の画面と一覧で写真を出す', st.includes("delegate('settlePayReqReceipt'") && /receiptBox\(q\)[\s\S]{0,40}\$\{field\}/.test(st) && /receiptBox\(q\)[\s\S]{0,80}却下の理由/.test(st))
  ok('#273 画像の URL に添付の時刻を付ける（差し替えの後のキャッシュ対策）', /pay\/requests\/\$\{Number\(q\.request_id\)\}\/receipt\?v=/.test(sa) && /pay-requests\/\$\{Number\(q\.request_id\)\}\/receipt\?v=/.test(st))
  // 値はイベント属性に埋め込まない（data-* と delegate）
  const added = (code) => code.split('\n').filter(l => /receipt|Receipt/.test(l))
  ok('#273 追加した部分は onclick に値を埋め込まない', [...added(sa), ...added(st)].every(l => !/onclick="[^"]*\$\{/.test(l)))

  // 小さな関数を取り出して動かす: 一覧の写真の行（スタッフ）
  const m = sa.match(/const receiptUrl = [\s\S]*?\n  function receiptLine\(q\) \{[\s\S]*?\n  \}\n/)
  if (m) {
    const ctx = { esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
    vm.runInNewContext(m[0] + '\nthis.receiptLine = receiptLine', ctx)
    const pend = ctx.receiptLine({ request_id: 5, kind: 'transport', status: 'pending', has_receipt: false })
    const withPhoto = ctx.receiptLine({ request_id: 5, kind: 'transport', status: 'pending', has_receipt: true, receipt_uploaded_at: '2026-10-25 10:00:00' })
    const done = ctx.receiptLine({ request_id: 5, kind: 'transport', status: 'approved', has_receipt: true, receipt_uploaded_at: '2026-10-25 10:00:00' })
    ok('#273 写真のない承認待ちの申請に「領収書の写真を付ける」', /data-action="payReceiptAttach" data-id="5"/.test(pend), pend)
    ok('#273 写真のある申請に小さな写真（?v=添付の時刻）と「確認・差し替え」', /receipt\?v=2026-10-25%2010%3A00%3A00/.test(withPhoto) && withPhoto.includes('確認・差し替え'), withPhoto)
    ok('#273 承認済みは見るだけ（差し替えの案内を出さない）', done.includes('payReceiptView') && !done.includes('差し替え'), done)
    ok('#273 延長・写真のない処理済みの申請には何も出さない', ctx.receiptLine({ request_id: 5, kind: 'overtime', status: 'pending' }) === '' && ctx.receiptLine({ request_id: 5, kind: 'transport', status: 'rejected', has_receipt: false }) === '')
  } else ok('（前提）receiptLine を取り出せた', false)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
