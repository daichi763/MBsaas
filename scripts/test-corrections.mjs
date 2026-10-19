// 打刻修正申請（docs/spec_attendance_correction.md 4章）の統合テスト
// 前提: bash scripts/setup-test-db.sh でローカルの D1 を作り直し、`wrangler dev` で起動していること（手順はスクリプトの冒頭）
// 実行: node scripts/test-corrections.mjs   （BASE=http://127.0.0.1:8799 で接続先を変更）
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))   // user_id 1（会社管理者）
const mgr = client(await login('sample', 'mgr01'))     // 現場管理者（別の管理者）
const st1 = client(await login('sample', 'st001'))     // staff_id 1
const st2 = client(await login('sample', 'st002'))     // staff_id 2

async function createShift(staff_id, project_id, work_date, memo, start_time = '10:00', end_time = '19:00') {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const s = (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
  return s.shift_id
}
const proxy = (id, t, time) => admin.post(`/api/admin/shifts/${id}/proxy-attendance`, { report_types: [t], time })
// 代理入力は、報告設定で OFF の種類を受け付けない（#20）。test-report-settings の後は案件1・スタッフ1 の入店が OFF なので、
// OFF の種類を記録するときだけ一時的に ON にして、元の設定に戻す
async function proxyEvenIfOff(id, t, time) {
  const cur = (await admin.get('/api/admin/report-settings/projects/1')).data.staff.find(x => x.staff_id === 1)?.settings?.[t]
  if (cur === 0) await admin.put('/api/admin/report-settings/projects/1/staff/1', { settings: { [t]: true } })
  const r = await proxy(id, t, time)
  if (cur === 0) await admin.put('/api/admin/report-settings/projects/1/staff/1', { settings: { [t]: false } })
  if (r.status !== 200) throw new Error('proxy ' + t + ' ' + JSON.stringify(r.data))
  return r
}
async function reports(id) { return (await admin.get(`/api/admin/shifts/${id}/report-status`)).data.reports }
async function reportAt(id, t) { const r = (await reports(id)).find(x => x.report_type === t); return r ? r.reported_at : null }
async function settle(id, date) { return ((await admin.get(`/api/admin/settlement?from=${date}&to=${date}`)).data.rows || []).find(x => x.shift_id === id) }
const req = (cl, body) => cl.post(cl === admin || cl === mgr ? '/api/admin/corrections' : '/api/staff/corrections', body)

const dA = addDays(today, -2)
const A = await createShift(1, 1, dA, 'CR-A')
for (const [t, tm] of [['check_in', '09:55'], ['work_start', '10:00'], ['break_start', '12:00'], ['break_end', '13:00'], ['work_end', '18:00'], ['check_out', '18:05']]) await proxyEvenIfOff(A, t, tm)

// ---------- 申請の入力チェック ----------
{
  let r = await req(st1, { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 18:30`, reason: '' })
  ok('修正理由が空なら 400', r.status === 400 && /理由/.test(r.data.error), r)
  r = await req(st1, { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: '2026-02-30 18:30', reason: 'x' })
  ok('存在しない日時は 400', r.status === 400, r)
  r = await req(st1, { shift_id: A, report_type: ['work_end', 'check_out'], kind: 'modify', requested_at: `${dA} 18:30`, reason: 'x' })
  ok('1 申請に複数の報告は指定できない（400）', r.status === 400, r)
  r = await req(st1, { shift_id: A, report_type: 'check_in', kind: 'add', requested_at: `${dA} 09:40`, reason: 'x' })
  ok('登録済みの報告の追加申請は 409（重複追加の防止）', r.status === 409, r)
  r = await req(st1, { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 18:00`, reason: 'x' })
  ok('変更前と同じ日時は 400', r.status === 400, r)
  r = await req(st1, { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 11:00`, reason: '押し間違い' })
  ok('時刻修正で順序の矛盾（勤務終了が休憩入より前）は 400 で具体的な内容を返す', r.status === 400 && r.data.conflicts && r.data.conflicts.some(c => /勤務終了.*休憩入/.test(c)), r)
}

// ---------- 時刻修正: 承認待ちの間は正式データを変えない → 承認で反映・集計 ----------
let c1
{
  const r = await req(st1, { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 17:45`, reason: '勤務終了を押すのが遅れた' })
  ok('スタッフ本人が時刻修正を申請できる', r.status === 200 && r.data.correction_id, r)
  c1 = r.data.correction_id
  const dup = await req(st1, { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 17:50`, reason: 'x' })
  ok('同じ報告に承認待ちがあると 409', dup.status === 409, dup)
  ok('承認待ちの間は正式な打刻は変わらない', await reportAt(A, 'work_end') === `${dA} 18:00:00`, await reportAt(A, 'work_end'))
  const tl = await st1.get(`/api/staff/attendance/timeline?to=${today}`)
  const s = tl.data.shifts.find(x => x.shift_id === A)
  ok('タイムライン: 自分のシフトの報告と申請中の内容が見える', s && s.reports.length === 6 && s.pending.some(p => p.report_type === 'work_end'), s)
  const ap = await admin.post(`/api/admin/corrections/${c1}/approve`, { comment: '確認しました' })
  ok('管理者が承認できる', ap.status === 200 && ap.data.ok, ap)
  ok('承認で正式な打刻が更新される', await reportAt(A, 'work_end') === `${dA} 17:45:00`, await reportAt(A, 'work_end'))
  const row = await settle(A, dA)
  ok('集計: 承認後の時刻が実績に反映される（10:00〜17:45・休憩60分 = 6.75h）', row && row.actual_end === '17:45' && row.actual_hours === 6.75, row && [row.actual_start, row.actual_end, row.actual_hours])
  const again = await admin.post(`/api/admin/corrections/${c1}/approve`, {})
  ok('承認済みの申請は再度承認できない（409）', again.status === 409, again)
  const mine = await st1.get('/api/staff/corrections')
  const m = mine.data.corrections.find(x => x.correction_id === c1)
  ok('スタッフの申請一覧に承認者・コメントが出る', m && m.status === 'approved' && m.decided_by_name && m.decision_comment === '確認しました', m)
}

// ---------- 打刻漏れの追加（矛盾なし / 矛盾あり → 例外承認）----------
{
  const dB = addDays(today, -1)
  const B = await createShift(1, 1, dB, 'CR-B', '22:00', '06:00')
  await proxy(B, 'work_start', '22:00')
  let r = await req(st1, { shift_id: B, report_type: 'work_end', kind: 'add', requested_at: `${addDays(dB, 1)} 05:30`, reason: '終了を押し忘れた' })
  ok('日付をまたぐ打刻漏れの追加（翌日 05:30）を申請できる', r.status === 200 && r.data.warnings.length === 0, r)
  const ap = await admin.post(`/api/admin/corrections/${r.data.correction_id}/approve`, {})
  const row = await settle(B, dB)
  ok('追加の承認で報告が登録され、日またぎの実績になる', ap.status === 200 && row && row.actual_start === '22:00' && row.actual_end === '05:30', [ap.status, row && [row.actual_start, row.actual_end]])
  const rep = (await reports(B)).find(x => x.report_type === 'work_end')
  ok('追加した報告は「修正申請の承認」として記録される', rep && rep.entry_method === 'correction', rep)

  r = await req(st1, { shift_id: A, report_type: 'departure', kind: 'add', requested_at: `${dA} 10:30`, reason: '出発報告を忘れた' })
  ok('打刻漏れの追加は順序の矛盾があっても申請でき、警告を返す', r.status === 200 && r.data.warnings.length > 0 && r.data.warnings.some(w => /出発報告/.test(w)), r)
  const cAdd = r.data.correction_id
  const det = await admin.get(`/api/admin/corrections/${cAdd}`)
  ok('詳細に順序の矛盾の内容が出る', det.data.correction.order_warnings.length > 0 && det.data.current_conflicts.length > 0, det.data.correction.order_warnings)
  const noEx = await admin.post(`/api/admin/corrections/${cAdd}/approve`, {})
  ok('矛盾のある追加は、例外の指定なしでは承認できない（409）', noEx.status === 409 && noEx.data.need_exception, noEx)
  const ex = await mgr.post(`/api/admin/corrections/${cAdd}/approve`, { exception: true })
  ok('例外として承認できる（承認者コメントは任意）', ex.status === 200 && ex.data.exception === true, ex)
  const det2 = await admin.get(`/api/admin/corrections/${cAdd}`)
  const ev = det2.data.events.find(e => e.event === 'approved_exception')
  ok('例外承認・矛盾内容・承認者・承認日時が履歴に残る', det2.data.correction.is_exception === 1 && ev && ev.detail.conflicts.length > 0 && ev.actor_name && ev.created_at && det2.data.correction.decided_by_name, det2.data.correction)
}

// ---------- 報告設定 OFF の報告・未来日時・過去の日付 ----------
{
  await admin.put('/api/admin/report-settings/projects/1/staff/1', { settings: { wake_up: false } })
  let r = await req(st1, { shift_id: A, report_type: 'wake_up', kind: 'add', requested_at: `${dA} 07:00`, reason: '起床報告を忘れた' })
  ok('報告設定が OFF の報告も追加申請できる', r.status === 200, r)
  const C = await createShift(1, 3, addDays(today, 3), 'CR-C')
  r = await req(st1, { shift_id: C, report_type: 'wake_up', kind: 'add', requested_at: `${addDays(today, 3)} 06:00`, reason: '先に申請しておく' })
  ok('まだ来ていない日時は申請できない（#312）', r.status === 400, r)
  const old = await createShift(1, 1, '2025-01-10', 'CR-OLD')
  await proxyEvenIfOff(old, 'check_in', '10:00')
  r = await req(st1, { shift_id: old, report_type: 'check_in', kind: 'modify', requested_at: '2025-01-10 09:58', reason: '期限のない過去分の修正' })
  ok('期限なし: 過去の勤務日の修正を申請できる', r.status === 200, r)
  const ap = await admin.post(`/api/admin/corrections/${r.data.correction_id}/approve`, {})
  ok('OFF・過去の報告の修正を承認できる', ap.status === 200, ap)
}

// ---------- 却下・再申請・取り消し ----------
{
  let r = await req(st1, { shift_id: A, report_type: 'check_out', kind: 'modify', requested_at: `${dA} 19:00`, reason: '退店が遅れた' })
  const cid = r.data.correction_id
  let rj = await admin.post(`/api/admin/corrections/${cid}/reject`, { reason: '' })
  ok('却下理由が空なら 400', rj.status === 400, rj)
  rj = await admin.post(`/api/admin/corrections/${cid}/reject`, { reason: '店舗の記録では 18:50 です' })
  ok('却下できる', rj.status === 200, rj)
  ok('却下では正式な打刻は変わらない', await reportAt(A, 'check_out') === `${dA} 18:05:00`, await reportAt(A, 'check_out'))
  const mine = (await st1.get('/api/staff/corrections')).data.corrections.find(x => x.correction_id === cid)
  ok('却下理由がスタッフに表示される', mine && mine.status === 'rejected' && mine.reject_reason === '店舗の記録では 18:50 です', mine)
  const otherRe = await st2.post(`/api/staff/corrections/${cid}/resubmit`, { requested_at: `${dA} 18:50`, reason: 'x' })
  ok('他人は再申請できない（404）', otherRe.status === 404, otherRe)
  const re = await st1.post(`/api/staff/corrections/${cid}/resubmit`, { requested_at: `${dA} 18:50`, reason: '店舗の記録に合わせて修正' })
  ok('却下後に修正して再申請できる', re.status === 200 && re.data.correction_id && re.data.correction_id !== cid, re)
  const det = await admin.get(`/api/admin/corrections/${re.data.correction_id}`)
  ok('再申請は元の申請と別に記録され、経緯を追える', det.data.correction.resubmitted_from === cid && det.data.history.some(h => h.correction_id === cid && h.status === 'rejected') && det.data.events[0].event === 'resubmitted', det.data.history)
  const byAdmin = await admin.post(`/api/admin/corrections/${re.data.correction_id}/cancel`)
  ok('申請者以外は取り消せない（403）', byAdmin.status === 403, byAdmin)
  const cn = await st1.post(`/api/staff/corrections/${re.data.correction_id}/cancel`)
  ok('申請者本人は承認待ちを取り消せる', cn.status === 200, cn)
  const apAfter = await admin.post(`/api/admin/corrections/${re.data.correction_id}/approve`, {})
  ok('取り消し後は承認できない（409）', apAfter.status === 409, apAfter)
  const cn2 = await st1.post(`/api/staff/corrections/${c1}/cancel`)
  ok('承認済みは取り消せない（409）', cn2.status === 409, cn2)
}

// ---------- 同時操作 ----------
{
  let r = await req(st1, { shift_id: A, report_type: 'check_out', kind: 'modify', requested_at: `${dA} 18:10`, reason: '同時承認のテスト' })
  ok('（前提）同時承認のテスト用の申請', r.status === 200, r)
  const cid = r.data.correction_id
  const [x, y] = await Promise.all([admin.post(`/api/admin/corrections/${cid}/approve`, {}), mgr.post(`/api/admin/corrections/${cid}/approve`, {})])
  ok('同じ申請を 2 人が同時に承認しても成功は 1 件だけ', [x.status, y.status].filter(s => s === 200).length === 1 && [x.status, y.status].includes(409), [x.status, y.status, x.data, y.data])
  r = await req(st1, { shift_id: A, report_type: 'break_start', kind: 'modify', requested_at: `${dA} 12:10`, reason: '承認と却下の競合テスト' })
  const cid2 = r.data.correction_id
  const [p, q] = await Promise.all([admin.post(`/api/admin/corrections/${cid2}/approve`, {}), mgr.post(`/api/admin/corrections/${cid2}/reject`, { reason: '競合' })])
  const st = (await admin.get(`/api/admin/corrections/${cid2}`)).data.correction.status
  ok('承認と却下が同時でも片方だけ成功し、状態と記録が一致する', [p.status, q.status].filter(s => s === 200).length === 1 && ((p.status === 200 && st === 'approved' && await reportAt(A, 'break_start') === `${dA} 12:10:00`) || (q.status === 200 && st === 'rejected' && await reportAt(A, 'break_start') === `${dA} 12:00:00`)), [p.status, q.status, st])
  r = await req(st1, { shift_id: A, report_type: 'break_end', kind: 'modify', requested_at: `${dA} 13:05`, reason: '取り消しと承認の競合テスト' })
  const cid3 = r.data.correction_id
  const [u, v] = await Promise.all([st1.post(`/api/staff/corrections/${cid3}/cancel`), admin.post(`/api/admin/corrections/${cid3}/approve`, {})])
  ok('取り消しと承認が同時でも片方だけ成功する', [u.status, v.status].filter(s => s === 200).length === 1, [u.status, v.status])
  // 申請後に打刻が変わった
  const D = await createShift(3, 1, dA, 'CR-D')
  await proxy(D, 'check_in', '10:00')
  r = await req(admin, { shift_id: D, report_type: 'check_in', kind: 'modify', requested_at: `${dA} 09:45`, reason: '管理者による申請' })
  ok('管理者も申請できる', r.status === 200, r)
  await admin.del(`/api/admin/shifts/${D}/proxy-attendance/check_in`)
  await proxy(D, 'check_in', '10:20')
  const chg = await admin.post(`/api/admin/corrections/${r.data.correction_id}/approve`, {})
  ok('申請後に対象の打刻が変わったら承認できない（409）', chg.status === 409 && /変更/.test(chg.data.error), chg)
  ok('その場合、正式データは変わらない', await reportAt(D, 'check_in') === `${dA} 10:20:00`, await reportAt(D, 'check_in'))
  const cnSelf = await admin.post(`/api/admin/corrections/${r.data.correction_id}/cancel`)
  ok('管理者は自分の申請を取り消せる', cnSelf.status === 200, cnSelf)
  r = await req(admin, { shift_id: D, report_type: 'check_in', kind: 'modify', requested_at: `${dA} 10:05`, reason: '管理者による申請（自分で承認）' })
  const self = await admin.post(`/api/admin/corrections/${r.data.correction_id}/approve`, {})
  ok('管理者は自分の申請も承認できる', self.status === 200, self)
  const counts = (await reports(A)).reduce((m, x) => (m[x.report_type] = (m[x.report_type] || 0) + 1, m), {})
  ok('二重登録が発生していない（1 シフト・1 種類につき 1 件）', Object.values(counts).every(n => n === 1), counts)
}

// ---------- 確定後の修正 ----------
{
  const dE = addDays(today, -3)
  const E = await createShift(4, 1, dE, 'CR-E')
  await proxy(E, 'check_in', '10:00'); await proxy(E, 'check_out', '19:00')
  await admin.post('/api/admin/settlement/confirm', { shift_ids: [E], force: true })
  const r = await req(admin, { shift_id: E, report_type: 'check_out', kind: 'modify', requested_at: `${dE} 18:00`, reason: '確定後の修正' })
  ok('確定後も申請できる', r.status === 200, r)
  const ap = await admin.post(`/api/admin/corrections/${r.data.correction_id}/approve`, {})
  let row = await settle(E, dE)
  ok('確定済みのシフト: 報告は更新、実績は確定時のまま（既存の規則）', ap.status === 200 && ap.data.applied_while_settled && await reportAt(E, 'check_out') === `${dE} 18:00:00` && row.actual_end === '19:00', [ap.data, row && row.actual_end])
  ok('精算の確認事項に「確定後に打刻修正あり」が出る', row.issues.includes('確定後に打刻修正あり'), row.issues)
  await admin.post('/api/admin/settlement/unconfirm', { shift_ids: [E] })
  await admin.post('/api/admin/settlement/sync-actuals', { from: dE, to: dE })
  row = await settle(E, dE)
  ok('確定を取り消して「実績を反映」すると修正後の時刻になる', row.actual_end === '18:00' && !row.issues.includes('確定後に打刻修正あり'), [row.actual_end, row.issues])
}

// ---------- 権限・未ログイン ----------
{
  const r = await st2.get(`/api/staff/corrections/${c1}`)
  ok('他人の申請は閲覧できない（404）', r.status === 404, r)
  const cr = await st2.post('/api/staff/corrections', { shift_id: A, report_type: 'work_end', kind: 'modify', requested_at: `${dA} 18:40`, reason: 'x' })
  ok('他人のシフトには申請できない（404）', cr.status === 404, cr)
  const lst = await st2.get('/api/staff/corrections')
  ok('自分の申請一覧に他人の申請は含まれない', lst.status === 200 && !lst.data.corrections.some(x => x.correction_id === c1), lst.data.corrections.length)
  const tl = await st2.get(`/api/staff/attendance/timeline?to=${today}`)
  ok('タイムラインに他人のシフトは含まれない', !tl.data.shifts.some(s => s.shift_id === A), tl.data.shifts.map(s => s.shift_id))
  const ap = await st1.post(`/api/admin/corrections/${c1}/approve`, {})
  ok('スタッフは承認・却下できない（403）', ap.status === 403, ap)
  const nf = await admin.get('/api/admin/corrections/999999')
  ok('存在しない申請は 404', nf.status === 404, nf)
  const anon = await fetch(`${BASE}/api/staff/corrections`)
  ok('未ログインは 401', anon.status === 401, anon.status)
  const list = await admin.get('/api/admin/corrections?status=approved&kind=add')
  ok('一覧の絞り込み（状態・申請の種類）', list.status === 200 && list.data.corrections.length > 0 && list.data.corrections.every(c => c.status === 'approved' && c.kind === 'add'), list.data.corrections.map(c => [c.status, c.kind]))
  const byName = await admin.get('/api/admin/corrections?staff_name=' + encodeURIComponent('佐藤'))
  ok('一覧の絞り込み（スタッフ名）', byName.data.corrections.length > 0 && byName.data.corrections.every(c => /佐藤/.test(c.staff_name)), byName.data.corrections.map(c => c.staff_name))
  const cnt = await admin.get('/api/admin/corrections/pending-count')
  ok('承認待ちの件数', cnt.status === 200 && typeof cnt.data.count === 'number', cnt)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length} / ${results.length} passed`)
process.exit(failed.length ? 1 : 0)
