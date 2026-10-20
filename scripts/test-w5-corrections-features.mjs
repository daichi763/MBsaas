// 打刻修正の機能追加（w5-corrections-features: #174 #175 #280 #485）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8822 node scripts/test-w5-corrections-features.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8822'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const go = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const r = await go().catch(e => { if (e?.cause?.code === 'ECONNRESET') return go(); throw e })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const req = () => fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await req().catch(e => { if (e?.cause?.code === 'ECONNRESET') return req(); throw e })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  const raw = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } })
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() }
  }
  // 画像の添付（multipart）
  const upload = async (path, bytes, type = 'image/jpeg') => {
    const fd = new FormData()
    fd.append('photo', new Blob([bytes], { type }), 'a.jpg')
    fd.append('photo_taken_at', String(Date.now() - 60000))
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), raw, upload }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))   // 会社管理者
const mgr = client(await login('sample', 'mgr01'))     // 現場管理者
const st3 = client(await login('sample', 'st003'))     // staff_id 3
const st1 = client(await login('sample', 'st001'))     // staff_id 1
const S3 = 3
let seq = 0
async function createShift(staff_id, work_date, project_id = 1, start_time = '10:00', end_time = '19:00') {
  const memo = `W5CF-${Date.now()}-${++seq}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'createShift')
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo).shift_id
}
const proxy = (id, times) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: Object.keys(times), times })
const reportOf = async (id, type) => (await admin.get(`/api/admin/shifts/${id}/report-status`)).data.reports.find(r => r.report_type === type)
const adminNotes = async (cl) => (await cl.get('/api/admin/notifications')).data.notifications
const staffNotes = async (cl) => (await cl.get('/api/staff/notifications')).data.notifications

// ---------- #174 申請と同時に承認 ----------
{
  const d = addDays(today, -2)
  const A = await createShift(S3, d)
  must(await proxy(A, { check_in: '10:05', check_out: '19:00' }), 'proxy')
  const r = await admin.post('/api/admin/corrections', { shift_id: A, report_type: 'check_out', kind: 'modify', requested_at: `${d} 19:30`, reason: '電話で連絡あり（退店は 19:30）', approve_now: true })
  ok('#174 管理者が申請と同時に承認できる（1回の操作）', r.status === 200 && r.data.approved === true && r.data.correction_id, r)
  const cid = r.data.correction_id
  const rep = await reportOf(A, 'check_out')
  ok('#174 打刻の記録がすぐに変わる', rep && rep.reported_at.startsWith(`${d} 19:30`), rep)
  const det = (await admin.get(`/api/admin/corrections/${cid}`)).data
  ok('#174 申請は承認済みで、操作の履歴に申請と承認の両方が残る', det.correction.status === 'approved' && det.events.map(e => e.event).join(',') === 'submitted,approved' && det.events[1].detail.with_request === true, det.events)
  const mn = await adminNotes(mgr)
  ok('#174 ほかの管理者に承認依頼の通知を出さない', !mn.some(n => n.related_id === cid), mn.filter(n => n.related_id === cid).map(n => n.kind))
  const an = (await adminNotes(admin)).filter(n => n.related_id === cid)
  ok('#174 処理した管理者には既読の控えだけ（承認依頼・結果の未読は作らない）', an.length === 1 && an[0].kind === 'correction_processed' && an[0].read_at, an)
  const sn = (await staffNotes(st3)).filter(n => n.related_id === cid)
  ok('#174 スタッフ本人には「管理者が打刻を修正した」知らせ', sn.some(n => n.kind === 'correction_changed_by_admin' && !n.read_at), sn.map(n => n.kind))
  const ev = (await admin.get('/api/admin/corrections/events')).data.events.find(e => e.correction_id === cid && e.event === 'approved')
  ok('#174 操作の履歴の内容に「申請と同時に承認」', ev && /申請と同時に承認/.test(ev.summary), ev)

  // 順序の矛盾がある打刻漏れの追加: 例外の確認がなければ申請もしない
  const B = await createShift(S3, d, 1, '11:00', '19:00')
  must(await proxy(B, { work_start: '11:00' }), 'proxy B')
  const before = (await admin.get('/api/admin/corrections?status=')).data.corrections.length
  const dry = await admin.post('/api/admin/corrections', { shift_id: B, report_type: 'check_in', kind: 'add', requested_at: `${d} 11:30`, reason: '入店の押し忘れ', approve_now: true, dry_run: true })
  ok('#174 確認（dry_run）では順序の矛盾を警告として返す', dry.status === 200 && dry.data.warnings.length > 0, dry)
  const ng = await admin.post('/api/admin/corrections', { shift_id: B, report_type: 'check_in', kind: 'add', requested_at: `${d} 11:30`, reason: '入店の押し忘れ', approve_now: true })
  const after = (await admin.get('/api/admin/corrections?status=')).data.corrections.length
  ok('#174 矛盾がある追加は、例外の確認がなければ 409（申請も作らない）', ng.status === 409 && ng.data.need_exception && after === before, [ng, before, after])
  const ex = await admin.post('/api/admin/corrections', { shift_id: B, report_type: 'check_in', kind: 'add', requested_at: `${d} 11:30`, reason: '入店の押し忘れ', approve_now: true, exception: true })
  ok('#174 例外の確認を付けると、例外として承認される', ex.status === 200 && ex.data.approved && ex.data.exception === true, ex)

  // チェックを外したとき（approve_now なし）は、これまでどおり承認待ち
  const C = await createShift(S3, d, 1, '12:00', '18:00')
  const p = await admin.post('/api/admin/corrections', { shift_id: C, report_type: 'check_in', kind: 'add', requested_at: `${d} 11:55`, reason: '代わりに申請' })
  ok('#174 approve_now なしは承認待ちの申請になる', p.status === 200 && !p.data.approved && (await admin.get(`/api/admin/corrections/${p.data.correction_id}`)).data.correction.status === 'pending', p)
  ok('#174 approve_now なしの申請は、ほかの管理者に承認依頼を出す', (await adminNotes(mgr)).some(n => n.related_id === p.data.correction_id && n.kind === 'correction_submitted'))
  must(await admin.post(`/api/admin/corrections/${p.data.correction_id}/cancel`), 'cancel C')
}

// ---------- #485 申請に写真・画像を添付する ----------
let photoShift, photoCid
{
  must(await admin.put('/api/admin/projects/1/photo-required', { override: 'on' }), 'photo required on')
  const d = addDays(today, -3)
  photoShift = await createShift(S3, d)
  must(await proxy(photoShift, { check_in: '09:55' }), 'proxy')
  const tl = (await st3.get(`/api/staff/attendance/timeline?to=${d}&from=${d}`)).data.shifts.find(s => s.shift_id === photoShift)
  ok('#485 打刻履歴に、写真が必須の案件かどうかが入る', tl && tl.photo_required === true, tl)
  const r = await st3.post('/api/staff/corrections', { shift_id: photoShift, report_type: 'check_out', kind: 'add', requested_at: `${d} 19:05`, reason: '電波が悪く退店報告を送れなかった' })
  photoCid = r.data.correction_id
  ok('（前提）スタッフが退店の打刻漏れを申請', r.status === 200 && photoCid, r)
  let row = (await admin.get('/api/admin/corrections?status=pending')).data.corrections.find(c => c.correction_id === photoCid)
  ok('#485 写真が必須の案件で添付のない退店の追加は、まとめて承認の対象外', row && /写真/.test(row.bulk_block || ''), row)
  let det = (await admin.get(`/api/admin/corrections/${photoCid}`)).data
  ok('#485 管理者の詳細に、写真が必須の案件であることが出る（添付なし）', det.photo_required === true && det.attachments.length === 0, [det.photo_required, det.attachments])

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])
  const u1 = await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, jpeg)
  ok('#485 申請者本人が画像を添付できる', u1.status === 200 && u1.data.attachment_id, u1)
  const bad = await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, new Uint8Array([1, 2, 3]), 'image/gif')
  ok('#485 JPEG・PNG 以外は 400', bad.status === 400, bad)
  const big = await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, new Uint8Array(600 * 1024))
  ok('#485 500KB を超える画像は 400', big.status === 400, big)
  const other = await st1.upload(`/api/staff/corrections/${photoCid}/attachments`, jpeg)
  ok('#485 ほかのスタッフは添付できない（404）', other.status === 404, other)
  must(await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, jpeg), 'upload 2')
  must(await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, jpeg), 'upload 3')
  const over = await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, jpeg)
  ok('#485 1つの申請に3枚まで（4枚目は 409）', over.status === 409, over)

  det = (await admin.get(`/api/admin/corrections/${photoCid}`)).data
  ok('#485 管理者の詳細に添付が出る（3枚）', det.attachments.length === 3, det.attachments)
  const aid = det.attachments[0].attachment_id
  const img = await admin.raw(`/api/admin/corrections/attachments/${aid}`)
  ok('#485 管理者が添付の画像を取得できる', img.status === 200 && /image\/jpeg/.test(img.type), [img.status, img.type])
  const mine = await st3.raw(`/api/staff/corrections/attachments/${aid}`)
  ok('#485 本人が添付の画像を取得できる', mine.status === 200, mine.status)
  const notMine = await st1.raw(`/api/staff/corrections/attachments/${aid}`)
  ok('#485 ほかのスタッフは添付の画像を取得できない（404）', notMine.status === 404, notMine.status)
  const sdet = (await st3.get(`/api/staff/corrections/${photoCid}`)).data
  ok('#485 本人の申請の経緯に添付が出る', sdet.attachments.length === 3, sdet.attachments)
  ok('#485 本人の申請の一覧に添付の枚数が出る', (await st3.get('/api/staff/corrections')).data.corrections.find(c => c.correction_id === photoCid)?.attachment_count === 3)
  row = (await admin.get('/api/admin/corrections?status=pending')).data.corrections.find(c => c.correction_id === photoCid)
  ok('#485 添付があれば、まとめて承認の対象になる', row && !row.bulk_block && row.attachment_count === 3, row)

  must(await admin.post(`/api/admin/corrections/${photoCid}/approve`, {}), 'approve photo')
  const ph = (await admin.get(`/api/admin/shifts/${photoShift}/attendance-photos`)).data.reports.find(r => r.report_type === 'check_out')
  ok('#485 承認すると、添付の1枚目が退店の報告の写真になる', ph && ph.has_photo === true && ph.entry_method === 'correction', ph)
  const after = await st3.upload(`/api/staff/corrections/${photoCid}/attachments`, jpeg)
  ok('#485 承認の後は添付できない（409）', after.status === 409, after)
  must(await admin.put('/api/admin/projects/1/photo-required', { override: 'inherit' }), 'photo required inherit')
}

// ---------- #280 まとめて承認 ----------
{
  const d1 = addDays(today, -5), d2 = addDays(today, -4)
  const A = await createShift(S3, d1), B = await createShift(S3, d2), C = await createShift(S3, d2, 1, '13:00', '20:00')
  must(await proxy(A, { check_in: '10:10' }), 'proxy A')
  must(await proxy(B, { check_in: '10:10' }), 'proxy B')
  must(await proxy(C, { work_start: '13:00' }), 'proxy C')
  // B を先に申請し、A を後に申請する（申請の古い順では B が先、勤務日の古い順では A が先）
  const rb = must(await st3.post('/api/staff/corrections', { shift_id: B, report_type: 'check_in', kind: 'modify', requested_at: `${d2} 09:58`, reason: '実際は 9:58' }), 'req B').correction_id
  const ra = must(await st3.post('/api/staff/corrections', { shift_id: A, report_type: 'check_in', kind: 'modify', requested_at: `${d1} 09:58`, reason: '実際は 9:58' }), 'req A').correction_id
  // 順序の矛盾がある打刻漏れの追加（勤務開始より後の入店）
  const rc = must(await st3.post('/api/staff/corrections', { shift_id: C, report_type: 'check_in', kind: 'add', requested_at: `${d2} 13:20`, reason: '入店の押し忘れ' }), 'req C').correction_id
  const list = (await admin.get('/api/admin/corrections?status=pending')).data.corrections
  const pos = (id) => list.findIndex(c => c.correction_id === id)
  ok('#280 承認待ちは既定で申請の古い順', pos(rb) < pos(ra), [pos(rb), pos(ra)])
  const byWd = (await admin.get('/api/admin/corrections?status=pending&sort=work_date')).data.corrections
  const pos2 = (id) => byWd.findIndex(c => c.correction_id === id)
  ok('#280 sort=work_date で勤務日の古い順', pos2(ra) < pos2(rb), [pos2(ra), pos2(rb)])
  ok('#280 順序の矛盾がある申請は、一覧でまとめて承認の対象外', /矛盾/.test(list.find(c => c.correction_id === rc)?.bulk_block || ''), list.find(c => c.correction_id === rc))

  const bad = await admin.post('/api/admin/corrections/bulk-approve', { ids: [] })
  ok('#280 申請を選ばないと 400', bad.status === 400, bad)
  const tooMany = await admin.post('/api/admin/corrections/bulk-approve', { ids: Array.from({ length: 21 }, (_, i) => i + 1) })
  ok('#280 21件以上は 400（上限 20件）', tooMany.status === 400, tooMany)
  const r = await admin.post('/api/admin/corrections/bulk-approve', { ids: [ra, rb, rc, 99999999] })
  ok('#280 まとめて承認: 承認できるものだけ承認し、結果を件数と一覧で返す', r.status === 200 && r.data.approved.length === 2 && r.data.approved.includes(ra) && r.data.approved.includes(rb)
    && r.data.skipped.length === 1 && r.data.skipped[0].correction_id === rc && r.data.failed.some(f => f.correction_id === 99999999), r.data)
  ok('#280 承認した申請は打刻に反映される', (await reportOf(A, 'check_in')).reported_at.startsWith(`${d1} 09:58`) && (await reportOf(B, 'check_in')).reported_at.startsWith(`${d2} 09:58`))
  ok('#280 対象外の申請は承認待ちのまま', (await admin.get(`/api/admin/corrections/${rc}`)).data.correction.status === 'pending')
  const sn = (await staffNotes(st3)).filter(n => n.related_id === ra || n.related_id === rb)
  ok('#280 まとめて承認した申請も、申請者に結果を知らせる', sn.filter(n => n.kind === 'correction_approved').length === 2, sn.map(n => n.kind))
  const again = await admin.post('/api/admin/corrections/bulk-approve', { ids: [ra] })
  ok('#280 承認済みの申請をもう一度送っても二重に承認しない（failed）', again.status === 200 && again.data.approved.length === 0 && again.data.failed.length === 1, again.data)
  const staffTry = await st3.post('/api/admin/corrections/bulk-approve', { ids: [rc] })
  ok('#280 スタッフはまとめて承認を使えない', staffTry.status === 401 || staffTry.status === 403, staffTry.status)
  must(await st3.post(`/api/staff/corrections/${rc}/cancel`), 'cancel rc')
}

// ---------- #175 打刻データの一覧と CSV ----------
{
  const from = addDays(today, -6), to = today
  const r = await admin.get(`/api/admin/attendance-punches?from=${from}&to=${to}`)
  ok('#175 期間で打刻データを一覧できる', r.status === 200 && Array.isArray(r.data.rows) && r.data.rows.length > 0, r.status)
  const row = r.data.rows.find(x => x.shift_id === photoShift)
  ok('#175 1シフト1行で、報告ごとの時刻と記録方法が出る', row && row.check_in_at && row.check_in_m === 'proxy' && row.check_out_m === 'correction' && (row.check_out_f & 1) && (row.check_out_f & 2), row)
  ok('#175 記録方法の件数を返す', r.data.counts.proxy > 0 && r.data.counts.corrected > 0, r.data.counts)
  const only = await admin.get(`/api/admin/attendance-punches?from=${from}&to=${to}&method=corrected`)
  ok('#175 記録方法（打刻修正を含む）で絞り込める', only.status === 200 && only.data.rows.length > 0 && only.data.rows.every(x => ['wake_up', 'departure', 'check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'].some(t => Number(x[t + '_f']) & 1)), only.data.rows.length)
  const staffOnly = await admin.get(`/api/admin/attendance-punches?from=${from}&to=${to}&staff_id=1`)
  ok('#175 スタッフで絞り込める', staffOnly.status === 200 && staffOnly.data.rows.every(x => x.staff_id === 1))
  const longRange = await admin.get(`/api/admin/attendance-punches?from=${addDays(today, -40)}&to=${today}`)
  ok('#175 期間は31日まで（超えると 400）', longRange.status === 400, longRange)
  const csv = await admin.raw(`/api/admin/attendance-punches/export?from=${from}&to=${to}`)
  ok('#175 同じ条件で CSV を出せる（報告ごとの記録方法の列）', csv.status === 200 && /text\/csv/.test(csv.type) && /入店報告の記録方法/.test(csv.text) && /代理入力/.test(csv.text) && /打刻修正で追加/.test(csv.text), [csv.status, csv.text.slice(0, 300)])
  const st = await st3.get(`/api/admin/attendance-punches?from=${from}&to=${to}`)
  ok('#175 スタッフは打刻データの一覧を使えない', st.status === 401 || st.status === 403, st.status)
  // 他社の管理者には自社のシフトだけ（sample のシフトは出ない）
  let other = null
  try { other = client(await login('demo2', 'admin')) } catch { }
  if (other) {
    const o = await other.get(`/api/admin/attendance-punches?from=${from}&to=${to}`)
    ok('#175 他社の管理者には自社のシフトだけが出る', o.status === 200 && !o.data.rows.some(x => x.shift_id === photoShift), o.status)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
