// 打刻修正の管理者側（w4-corrections-admin: #69 #266 #393 #443 #548。持ち越しの #221 の API 側）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8817 PERSIST=<保存先> node scripts/test-w4-corrections-admin.mjs
//   PERSIST を渡すと、API では作れない状態（申請の後に打刻が変わった）をローカルの D1 に直接書いて確かめる（--local のみ）。渡さないときは、その部分を飛ばす
import { execSync } from 'node:child_process'

const BASE = process.env.BASE || 'http://127.0.0.1:8817'
const PERSIST = process.env.PERSIST || ''
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const sql = (command) => execSync(`npx wrangler d1 execute mbsaas-production --local --persist-to "${PERSIST}" --json --command "${command}"`, { stdio: 'pipe' }).toString()
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))
const st3 = client(await login('sample', 'st003'))     // staff_id 3
const S3 = 3
let seq = 0
async function createShift(staff_id, work_date, start_time = '10:00', end_time = '19:00') {
  const memo = `W4CA-${Date.now()}-${++seq}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id: 1, work_date, start_time, end_time, memo }), 'createShift')
  return (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo).shift_id
}
const proxy = (id, times) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: Object.keys(times), times })
const reportOf = async (id, type) => (await admin.get(`/api/admin/shifts/${id}/report-status`)).data.reports.find(r => r.report_type === type)
const request = (cl, body) => cl.post('/api/staff/corrections', body)

// 遅刻の猶予は 0 分で確かめる
must(await admin.put('/api/admin/settings/lateness', { grace_minutes: 0 }), 'grace 0')

// ---------- #69 承認で遅刻を判定し直す ----------
{
  const d = addDays(today, -1)
  const A = await createShift(S3, d)
  must(await proxy(A, { check_in: '10:20' }), 'proxy late check_in')
  let r = await reportOf(A, 'check_in')
  ok('（前提）10:00 開始で 10:20 の入店は遅刻（late・20分）', r.status === 'late' && r.late_minutes === 20, r)
  const id = must(await request(st3, { shift_id: A, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:55`, reason: '実際は 9:55 に入店' }), 'request').correction_id
  must(await admin.post(`/api/admin/corrections/${id}/approve`, {}), 'approve')
  r = await reportOf(A, 'check_in')
  ok('#69 時刻修正を承認すると、遅刻が解消される（normal・0分）', r.reported_at.startsWith(`${d} 09:55`) && r.status === 'normal' && r.late_minutes === 0, r)
  const det = must(await admin.get(`/api/admin/corrections/${id}`), 'detail')
  const ev = det.events.find(e => e.event === 'approved')
  ok('#69 操作履歴に、承認前の判定（late）と承認後の判定が残る', ev && ev.detail.before_status === 'late' && ev.detail.report_status === 'normal', ev)

  // 打刻漏れの追加（遅れた時刻）は遅刻として登録する
  const B = await createShift(S3, d)
  const id2 = must(await request(st3, { shift_id: B, report_type: 'check_in', kind: 'add', requested_at: `${d} 10:30`, reason: '入店の押し忘れ' }), 'request add').correction_id
  must(await admin.post(`/api/admin/corrections/${id2}/approve`, {}), 'approve add')
  r = await reportOf(B, 'check_in')
  ok('#69 打刻漏れの追加（10:30）を承認すると、遅刻（late・30分）で登録される', r.status === 'late' && r.late_minutes === 30, r)

  // 退店の打刻漏れは早退の分数も入る
  const id3 = must(await request(st3, { shift_id: B, report_type: 'check_out', kind: 'add', requested_at: `${d} 18:40`, reason: '退店の押し忘れ' }), 'request add out').correction_id
  must(await admin.post(`/api/admin/corrections/${id3}/approve`, {}), 'approve add out')
  r = await reportOf(B, 'check_out')
  ok('#69 退店の打刻漏れの追加（18:40）は早退20分として登録される', r.early_leave_minutes === 20, r)
}

// ---------- #443 承認画面の根拠と、承認した場合の変化 ----------
{
  const d = addDays(today, -2)
  const C = await createShift(S3, d)
  must(await proxy(C, { check_in: '10:15', check_out: '19:00' }), 'proxy')
  const id = must(await request(st3, { shift_id: C, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:58`, reason: '押し遅れ' }), 'request').correction_id
  const det = must(await admin.get(`/api/admin/corrections/${id}`), 'detail')
  const rep = det.reports.find(r => r.report_type === 'check_in')
  ok('#443 詳細の報告に、入力方法・入力者・遅刻の判定・位置・写真の有無が入る',
    rep && rep.entry_method === 'proxy' && rep.entered_by_name && rep.status === 'late' && rep.late_minutes === 15 && 'latitude' in rep && 'address' in rep && 'has_photo' in rep, rep)
  const p = det.preview
  ok('#443 承認した場合の遅刻の判定（late → normal）が出る', p && p.lateness.before.status === 'late' && p.lateness.after.status === 'normal', p && p.lateness)
  ok('#443 承認した場合の実績（10:15 → 09:58 開始）が出る', p && p.actual.before.actual_start === '10:15' && p.actual.after.actual_start === '09:58' && !p.actual.fixed, p && p.actual)
  ok('#443 金額（請求・支払）の変更前・変更後が数値で出る', p && typeof p.actual.after.bill_total === 'number' && 'pay_total' in p.actual.after, p && p.actual)
  // スタッフ本人の詳細には、根拠の詳細（位置・入力者）と承認の見込みを出さない
  const sd = must(await st3.get(`/api/staff/corrections/${id}`), 'staff detail')
  ok('#443 スタッフ本人の詳細には承認の見込み（preview）と入力者を返さない', sd.preview === undefined && !('entered_by_name' in (sd.reports[0] || {})), sd.reports[0])
  must(await admin.post(`/api/admin/corrections/${id}/reject`, { reason: 'テスト' }), 'cleanup reject')
}

// ---------- #548 日時を修正して承認 ----------
{
  const d = addDays(today, -3)
  const E = await createShift(S3, d)
  must(await proxy(E, { check_in: '09:55', check_out: '19:05' }), 'proxy')
  const id = must(await request(st3, { shift_id: E, report_type: 'check_out', kind: 'modify', requested_at: `${d} 18:30`, reason: '退店の時刻の誤り' }), 'request').correction_id
  let r = await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${d} 18:15` })
  ok('#548 日時を修正して承認するときは、コメント（修正の理由）が必須（400）', r.status === 400 && /コメント/.test(r.data.error), r)
  r = await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${addDays(d, 5)} 18:15`, comment: 'x' })
  ok('#548 稼働日の前日〜翌日の範囲外の日時は 400', r.status === 400, r)
  r = await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${d} 19:05`, comment: 'x' })
  ok('#548 変更前と同じ日時では承認しない（400）', r.status === 400 && /同じ/.test(r.data.error), r)
  r = await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${d} 09:00`, comment: 'x' })
  ok('#548 直した日時でも報告の順序を確かめる（入店より前の退店は 409）', r.status === 409 && (r.data.conflicts || []).length > 0, r)
  r = await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${d} 18:15`, dry_run: true })
  ok('#548 dry_run は書き込まずに、直した日時での見込みを返す', r.status === 200 && r.data.dry_run && r.data.adjusted && r.data.preview.requested_at.startsWith(`${d} 18:15`) && r.data.preview.lateness.after.early_leave_minutes === 45, r.data)
  ok('#548 dry_run の後も申請は承認待ちのまま', (await admin.get(`/api/admin/corrections/${id}`)).data.correction.status === 'pending')
  r = await admin.post(`/api/admin/corrections/${id}/approve`, { requested_at: `${d}T18:15`, comment: '入退室記録で 18:15 を確認' })
  ok('#548 日時を修正して承認できる', r.status === 200 && r.data.adjusted === true, r)
  const rep = await reportOf(E, 'check_out')
  ok('#548 勤怠の記録は承認した日時（18:15）になり、早退の分数も入れ直す', rep.reported_at.startsWith(`${d} 18:15`) && rep.early_leave_minutes === 45, rep)
  const det = must(await admin.get(`/api/admin/corrections/${id}`), 'detail')
  const ev = det.events.find(e => e.event === 'approved')
  ok('#548 申請の日時（18:30）は操作履歴に残り、申請は承認した日時になる',
    det.correction.requested_at.startsWith(`${d} 18:15`) && ev.detail.adjusted && ev.detail.requested_at_original.startsWith(`${d} 18:30`), { c: det.correction.requested_at, ev })
  const sub = det.events.find(e => e.event === 'submitted')
  ok('#548 申請の操作履歴は申請のときの日時のまま', sub.detail.requested_at.startsWith(`${d} 18:30`), sub)
  const hist = must(await admin.get('/api/admin/corrections/events?event=approved'), 'events')
  ok('#548 操作履歴の一覧の内容に「修正して承認」が出る', hist.events.some(e => e.correction_id === id && /修正して承認/.test(e.summary)), hist.events.find(e => e.correction_id === id))

  // 申請の後に打刻が変わった時刻修正（今の記録をもとに承認する）
  if (PERSIST) {
    const F = await createShift(S3, d)
    must(await proxy(F, { check_in: '09:50', check_out: '19:00' }), 'proxy F')
    const id2 = must(await request(st3, { shift_id: F, report_type: 'check_in', kind: 'modify', requested_at: `${d} 09:40`, reason: '入店の時刻の誤り' }), 'request F').correction_id
    sql(`UPDATE attendance_reports SET reported_at = '${d} 09:45:00' WHERE shift_id = ${F} AND report_type = 'check_in'`)
    r = await admin.post(`/api/admin/corrections/${id2}/approve`, {})
    ok('#548 申請の後に打刻が変わったら 409（changed と今の記録を返す）', r.status === 409 && r.data.changed && r.data.current_at === `${d} 09:45:00`, r)
    r = await admin.post(`/api/admin/corrections/${id2}/approve`, { base_at: `${d} 09:30:00`, comment: 'x' })
    ok('#548 今の記録と違う base_at では承認しない', r.status === 409 && r.data.changed, r)
    r = await admin.post(`/api/admin/corrections/${id2}/approve`, { base_at: `${d} 09:45:00`, comment: '今の記録を確認' })
    ok('#548 今の記録（base_at）を確かめれば、今の記録をもとに承認できる', r.status === 200, r)
    const rep2 = await reportOf(F, 'check_in')
    const det2 = must(await admin.get(`/api/admin/corrections/${id2}`), 'detail F')
    ok('#548 変更前は今の記録（09:45）になり、申請時の変更前は履歴に残る',
      rep2.reported_at.startsWith(`${d} 09:40`) && det2.correction.before_at === `${d} 09:45:00` && det2.events.some(e => e.detail && e.detail.rebased && e.detail.before_at_original === `${d} 09:50:00`), { rep2, before: det2.correction.before_at })
  } else console.log('SKIP  #548 申請の後に打刻が変わった場合（PERSIST なし）')
}

// ---------- #393 申請するシフトの候補 ----------
{
  const d = addDays(today, -4)
  const G = await createShift(S3, d)
  const H = await createShift(4, d)
  const X = await createShift(S3, addDays(d, 1))
  must(await admin.put(`/api/admin/shifts/${X}`, { status: 'absent' }), 'absent')
  let r = await admin.get(`/api/admin/corrections/shift-candidates?from=${d}&to=${d}`)
  ok('#393 勤務日でシフトの候補を返す', r.status === 200 && r.data.shifts.some(s => s.shift_id === G) && r.data.shifts.some(s => s.shift_id === H), r.data)
  r = await admin.get(`/api/admin/corrections/shift-candidates?from=${d}&to=${d}&staff_id=${S3}`)
  ok('#393 スタッフで絞れる', r.status === 200 && r.data.shifts.every(s => s.staff_id === S3) && r.data.shifts.some(s => s.shift_id === G), r.data)
  const name = r.data.shifts.find(s => s.shift_id === G).staff_name
  r = await admin.get(`/api/admin/corrections/shift-candidates?from=${d}&to=${d}&q=${encodeURIComponent(name.slice(0, 2))}`)
  ok('#393 氏名の一部で絞れる', r.status === 200 && r.data.shifts.some(s => s.shift_id === G) && r.data.shifts.every(s => s.staff_name.includes(name.slice(0, 2)) || s.project_name.includes(name.slice(0, 2))), r.data)
  r = await admin.get(`/api/admin/corrections/shift-candidates?from=${d}&to=${addDays(d, 1)}&staff_id=${S3}`)
  ok('#393 欠勤のシフトは候補に出さない', r.status === 200 && !r.data.shifts.some(s => s.shift_id === X) && r.data.shifts.some(s => s.shift_id === G), r.data)
  r = await admin.get(`/api/admin/corrections/shift-candidates?from=${d}&to=${addDays(d, 40)}`)
  ok('#393 期間は31日まで（超えたら 400）', r.status === 400, r)
  r = await st3.get(`/api/admin/corrections/shift-candidates?from=${d}&to=${d}`)
  ok('#393 スタッフは候補の API を使えない', r.status === 401 || r.status === 403, r)
}

// ---------- #221（持ち越し） 入店以降の報告があるシフトの欠勤は確認を求める ----------
{
  const d = addDays(today, -5)
  const K = await createShift(S3, d)
  must(await proxy(K, { check_in: '09:58' }), 'proxy')
  let r = await admin.put(`/api/admin/shifts/${K}`, { status: 'absent' })
  ok('#221 入店の報告があるシフトを欠勤にするときは 409 need_force（報告の時刻を示す）', r.status === 409 && r.data.need_force && /09:58/.test(r.data.warnings.join('')), r)
  r = await admin.put(`/api/admin/shifts/${K}`, { status: 'absent', force: true })
  ok('#221 確認（force）すれば欠勤にできる', r.status === 200, r)
  const L = await createShift(S3, d)
  must(await proxy(L, { wake_up: '07:00' }), 'proxy wake')
  r = await admin.put(`/api/admin/shifts/${L}`, { status: 'absent' })
  ok('#221 起床だけのシフトは確認なしで欠勤にできる', r.status === 200, r)
}

// ---------- #266 画面（配信されるスクリプト） ----------
{
  const js = await (await fetch(`${BASE}/static/corrections.js`)).text()
  const adm = await (await fetch(`${BASE}/static/admin.js`)).text()
  ok('#266 共通の modal が閉じたときの処理（onClose）を受け付ける', /function modal\(html, opts = \{\}\)/.test(adm) && /MODAL_ON_CLOSE/.test(adm))
  ok('#266 詳細のモーダルは閉じたときに URL を一覧へ戻す', /onClose: \(\) => \{ if \(location\.hash === '#corrections\/' \+ c\.correction_id\) history\.replaceState/.test(js))
  ok('#266 一覧の行は data-action で開き、onclick に値を埋め込まない', /data-action="corrOpen"/.test(js) && !/onclick="location\.hash='corrections\//.test(js))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
