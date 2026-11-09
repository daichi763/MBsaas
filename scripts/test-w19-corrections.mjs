// 打刻修正のまとめて承認を、途中で止まっても半端に残らない形にする（Sprint 19。w19-corrections。#9932）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、
//   npx wrangler dev --local --port 8611 --persist-to <保存先> --var DB_CALL_COUNT:true で起動していること
//   （DB_CALL_COUNT はテスト用の設定。まとめて承認の応答に、その要求の D1 の呼び出しの回数 d1_calls を付ける。本番には書かない）
//   1件の承認は、申請の状態・報告・操作履歴・シフトの実績と金額を1回の db.batch で書く。まとめて承認は、読み込みを最初の1回にまとめ、
//   1件ごとの結果（results）を返し、承認済みの申請は二重に処理しない。通知はすべての承認を書いた後にまとめて作る。
//   ここでは、20件のまとめて承認の D1 の回数（1件あたり5回以下・件数に比例して増えすぎない）、実績・金額の反映（直接の報告と同じ値）、
//   同じシフトの2件（まとめて出した申請）を順に承認できること、途中の1件が承認できなくても残りは承認されること、やり直しで二重にならないこと、
//   通知が1件に1回だけ作られること、画面のコード（1件ごとの結果の表示）を確かめる
// 実行: BASE=http://127.0.0.1:8611 node scripts/test-w19-corrections.mjs
import { readFileSync } from 'node:fs'
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
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const src = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001')) // staff_id 1
const PFX = 'W19C' + String(Date.now()).slice(-5)

// 時給の案件（実働に合わせて数量・金額が変わる）
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-時給`, allow_duplicate: true, unit_price: 1500, unit_price_type: 'hourly' }), 'project').project_id
must(await admin.put(`/api/admin/projects/${P}/pricing`, { unit_price_type: 'hourly', unit_price: 1500, pay_unit_type: 'hourly', pay_rate: 1200, default_break_minutes: 0, hours_basis: 'clipped', pay_transport_type: 'actual' }), 'pricing')

let day = 2
async function shiftWithReports(memo, times = { check_in: '09:55', work_start: '10:00', work_end: '18:00', check_out: '18:05' }) {
  const d = addDays(today, -(day++))
  must(await admin.post('/api/admin/shifts', { staff_id: 1, project_id: P, work_date: d, start_time: '10:00', end_time: '19:00', memo }), 'shift ' + memo)
  const s = must(await admin.get(`/api/admin/shifts?from=${d}&to=${d}`), 'shifts').shifts.find(x => x.memo === memo)
  for (const [t, tm] of Object.entries(times)) must(await admin.post(`/api/admin/shifts/${s.shift_id}/proxy-attendance`, { report_types: [t], time: tm }), `proxy ${memo} ${t}`)
  return { id: s.shift_id, d }
}
const adminReq = async (sh, t, hm, reason = '管理者が確認した時刻に直す') =>
  must(await admin.post('/api/admin/corrections', { shift_id: sh.id, report_type: t, kind: 'modify', requested_at: `${sh.d} ${hm}`, reason }), `req ${sh.id} ${t}`).correction_id
const settleRow = async (sh) => ((await admin.get(`/api/admin/settlement?from=${sh.d}&to=${sh.d}`)).data.rows || []).find(x => x.shift_id === sh.id)
const reportAt = async (sh, t) => ((await admin.get(`/api/admin/shifts/${sh.id}/report-status`)).data.reports || []).find(x => x.report_type === t)?.reported_at
const detail = async (id) => (await admin.get(`/api/admin/corrections/${id}`)).data
const approvedEvents = async (id) => ((await detail(id)).events || []).filter(e => e.event === 'approved' || e.event === 'approved_exception').length
const staffNotes = async () => (await st1.get('/api/staff/notifications?limit=100')).data.notifications || []
const adminNotes = async () => (await admin.get('/api/admin/notifications?limit=100')).data.notifications || []
const bulk = (ids) => admin.post('/api/admin/corrections/bulk-approve', { ids })

// ---------- 画面のコード: 1件ごとの結果を出す ----------
{
  const js = src('public/static/corrections.js')
  const i = js.indexOf("delegate('corrBulkApprove'"), part = js.slice(i, js.indexOf('// ---------- 詳細・操作', i))
  ok('#9932 画面: 応答の1件ごとの結果（results）で、承認・承認済み・個別の確認・承認できなかったを分ける', /data\.results/.test(part) && /already/.test(part) && /skipped/.test(part) && /failed/.test(part))
  ok('#9932 画面: 「N件を承認しました。M件は承認できませんでした（理由）」と出す', /件<\/b>を承認しました。/.test(part) && /件<\/b>は承認できませんでした（理由は下のとおりです）/.test(part))
  ok('#9932 画面: 通信が途切れた分は、もう一度押せば残りだけを承認すると案内する', /通信が途切れたため/.test(part) && /残りだけを承認します/.test(part))
  ok('#9932 画面: 理由は esc を通して出し、イベント属性に値を埋め込まない', /esc\(x\.reason\)/.test(part) && !/onclick="[^"]*\$\{/.test(part))
  const ts = src('src/corrections.ts')
  const ap = ts.slice(ts.indexOf('async function approveCorrection('), ts.indexOf('async function rejectCorrection('))
  ok('#9932 コード: 承認の batch にシフトの実績・金額の書き込みが入る（承認の後に別に書かない）', /UPDATE shifts SET actual_start/.test(ap) && /\.\.\.actualStmt, check/.test(ap)
    && (ap.match(/syncActualFromReports\(/g) || []).length === 1 && /if \(!chk\.same_reports\)/.test(ap))
  const bk = ts.slice(ts.indexOf("correctionsAdminApi.post('/corrections/bulk-approve'"), ts.indexOf('// 申請に添付した画像'))
  ok('#9932 コード: まとめて承認は通知を承認の後にまとめて作る（1件ごとの notifyCorrection を呼ばない）', /notifyCorrections\(/.test(bk) && !/notifyCorrection\(/.test(bk))
}

// ---------- 20件のまとめて承認: D1 の回数・実績と金額・同じシフトの2件 ----------
const small = []
for (let k = 0; k < 3; k++) small.push(await adminReq(await shiftWithReports(`${PFX}-S${k}`), 'work_end', '17:30'))
const pairs = [], singles = [], large = []
for (let k = 0; k < 5; k++) {
  const sh = await shiftWithReports(`${PFX}-P${k}`)
  // 残業で勤務終了と退店を一緒に直す（まとめて申請。1件ずつ承認しても矛盾しない順に登録される: 退店 → 勤務終了）
  const r = must(await st1.post('/api/staff/corrections/bulk', { shift_id: sh.id, items: [{ report_type: 'work_end', requested_at: `${sh.d} 18:30` }, { report_type: 'check_out', requested_at: `${sh.d} 18:40` }], reason: '残業の時刻を押し忘れた' }), 'bulk req')
  pairs.push(sh); large.push(...r.corrections.map(x => x.correction_id))
}
for (let k = 0; k < 10; k++) { const sh = await shiftWithReports(`${PFX}-L${k}`); singles.push(sh); large.push(await adminReq(sh, 'work_end', '17:30')) }
// 比べるための、報告を直接 17:30 にしたシフト（syncActualFromReports の計算）
const control = await shiftWithReports(`${PFX}-C`, { check_in: '09:55', work_start: '10:00', work_end: '17:30', check_out: '18:05' })
{
  ok('前提: まとめて承認の対象が 20件ある', large.length === 20, large.length)
  const rs = await bulk(small)
  ok('#9932 3件のまとめて承認', rs.status === 200 && rs.data.counts.approved === 3 && typeof rs.data.d1_calls === 'number', rs.data)
  const rl = await bulk(large)
  ok('#9932 20件のまとめて承認: すべて承認する（同じシフトの2件も順に承認できる）', rl.status === 200 && rl.data.counts.approved === 20 && rl.data.failed.length === 0 && rl.data.skipped.length === 0, rl.data)
  ok('#9932 応答に1件ごとの結果（results）がある', Array.isArray(rl.data.results) && rl.data.results.length === 20 && rl.data.results.every(x => x.result === 'approved'), rl.data.results)
  const n20 = rl.data.d1_calls, n3 = rs.data.d1_calls
  ok(`#9932 20件のまとめて承認の D1 の呼び出しは 1件あたり5回以下（${n20}回 / 20件）`, typeof n20 === 'number' && n20 <= 5 * 20, { n20 })
  ok(`#9932 件数が増えても D1 の回数は件数に比例して増えすぎない（3件 ${n3}回 → 20件 ${n20}回。1件増えるごとに2回以下）`, typeof n3 === 'number' && (n20 - n3) / 17 <= 2, { n3, n20 })
  console.log(`  D1 の呼び出し: 3件 ${n3}回、20件 ${n20}回（メールの送信を含む）`)

  const p0 = pairs[0]
  ok('#9932 同じシフトの2件: 勤務終了 18:30・退店 18:40 に変わる', (await reportAt(p0, 'work_end')) === `${p0.d} 18:30:00` && (await reportAt(p0, 'check_out')) === `${p0.d} 18:40:00`,
    [await reportAt(p0, 'work_end'), await reportAt(p0, 'check_out')])
  const rp = await settleRow(p0)
  ok('#9932 実績と金額が承認と一緒に変わる（10:00〜18:30 = 8.5h・時給 1500 / 1200）', rp && rp.actual_start === '10:00' && rp.actual_end === '18:30' && rp.bill_qty === 8.5 && rp.bill_base === 12750 && rp.pay_qty === 8.5 && rp.pay_base === 10200,
    rp && [rp.actual_start, rp.actual_end, rp.bill_qty, rp.bill_base, rp.pay_qty, rp.pay_base])
  const keys = ['actual_start', 'actual_end', 'actual_break_minutes', 'actual_source', 'actual_hours', 'hours', 'pay_hours', 'bill_qty', 'bill_base', 'pay_qty', 'pay_base', 'bill_total', 'pay_total']
  const rc = await settleRow(control)
  const diffs = []
  for (const sh of singles) { const r = await settleRow(sh); const bad = keys.filter(k => r?.[k] !== rc?.[k]); if (bad.length) diffs.push({ shift: sh.id, bad, got: bad.map(k => r?.[k]), want: bad.map(k => rc?.[k]) }) }
  ok('#9932 実績・数量・金額は、報告を直接直したシフト（従来の反映）と同じ値になる', rc && rc.actual_end === '17:30' && diffs.length === 0, diffs.slice(0, 3))
  const ev = await Promise.all(large.slice(0, 6).map(approvedEvents))
  ok('#9932 操作履歴の承認は1件に1回', ev.every(n => n === 1), ev)
  const dt = await detail(large[1])
  ok('#9932 承認した申請は承認済みで、反映した報告の ID が入る', dt.correction.status === 'approved' && dt.correction.applied_attendance_id, dt.correction)

  // やり直し: もう一度送っても二重に処理しない
  const again = await bulk(large)
  ok('#9932 やり直し: 承認済みの20件は二重に承認しない（results は already、failed には code: already_approved）', again.status === 200 && again.data.counts.approved === 0
    && again.data.results.every(x => x.result === 'already') && again.data.failed.every(f => f.code === 'already_approved') && again.data.counts.already === 20, again.data.counts)
  const ev2 = await Promise.all(large.slice(0, 6).map(approvedEvents))
  ok('#9932 やり直しの後も操作履歴の承認は1件に1回', ev2.every(n => n === 1), ev2)
  const sn = (await staffNotes()).filter(n => n.kind === 'correction_approved' && large.includes(n.related_id))
  const per = new Map(); for (const n of sn) per.set(n.related_id, (per.get(n.related_id) || 0) + 1)
  const mine = large.slice(0, 10) // スタッフ本人が出した申請（まとめて申請の 10件）
  ok('#9932 申請者への結果の通知は1件に1回（やり直しで増えない）', mine.every(id => per.get(id) === 1), [...per.entries()].slice(0, 12))
  const an = (await adminNotes()).filter(n => n.kind === 'correction_processed' && large.includes(n.related_id))
  ok('#9932 承認した管理者の控えは既読で作る（まとめて承認）', an.length > 0 && an.every(n => n.read_at), an.slice(0, 3))
  const req = (await adminNotes()).filter(n => n.kind === 'correction_submitted' && large.includes(n.related_id))
  ok('#9932 承認した申請の承認依頼は既読になる', req.length > 0 && req.every(n => n.read_at), req.filter(n => !n.read_at).slice(0, 3))
}

// ---------- 途中の1件が承認できなくても残りは承認され、やり直しで二重にならない ----------
{
  const F = []
  for (let k = 0; k < 4; k++) F.push(await shiftWithReports(`${PFX}-F${k}`))
  const ids = []
  for (const sh of F) ids.push(await adminReq(sh, 'work_end', '17:30'))
  // 1件目は前の操作（途中で止まったまとめて承認）で承認済みとする
  must(await admin.post(`/api/admin/corrections/${ids[0]}/approve`, {}), 'approve first')
  // 2件目は、申請の後に打刻が変わった（承認できない）
  must(await admin.del(`/api/admin/shifts/${F[1].id}/proxy-attendance/work_end`), 'delete report')
  must(await admin.post(`/api/admin/shifts/${F[1].id}/proxy-attendance`, { report_types: ['work_end'], time: '17:50' }), 'change report')
  const r = await bulk(ids)
  const by = Object.fromEntries((r.data.results || []).map(x => [x.correction_id, x]))
  ok('#9932 途中の1件が承認できなくても、残りは承認する', r.status === 200 && by[ids[2]]?.result === 'approved' && by[ids[3]]?.result === 'approved', r.data)
  ok('#9932 承認できなかった1件は理由を返し、承認待ちのまま', by[ids[1]]?.result === 'failed' && /変更されました/.test(by[ids[1]]?.reason || '') && (await detail(ids[1])).correction.status === 'pending', by[ids[1]])
  ok('#9932 前に承認済みの1件は二重に処理しない（already）', by[ids[0]]?.result === 'already' && (await approvedEvents(ids[0])) === 1, by[ids[0]])
  ok('#9932 承認できなかったシフトの実績は、その後の報告のまま（17:50）', (await settleRow(F[1]))?.actual_end === '17:50', (await settleRow(F[1]))?.actual_end)
  ok('#9932 承認したシフトの実績は承認した時刻（17:30）', (await settleRow(F[2]))?.actual_end === '17:30' && (await settleRow(F[3]))?.actual_end === '17:30')
  const r2 = await bulk(ids)
  const by2 = Object.fromEntries((r2.data.results || []).map(x => [x.correction_id, x.result]))
  ok('#9932 もう一度押すと、承認済みは二重に処理せず、承認できないものだけが残る', r2.status === 200 && r2.data.counts.approved === 0 && by2[ids[0]] === 'already' && by2[ids[2]] === 'already' && by2[ids[3]] === 'already' && by2[ids[1]] === 'failed', r2.data.results)
  const ev = await Promise.all([ids[0], ids[2], ids[3]].map(approvedEvents))
  ok('#9932 やり直しの後も、操作履歴の承認は1件に1回', ev.every(n => n === 1), ev)
  const reps = ((await admin.get(`/api/admin/shifts/${F[2].id}/report-status`)).data.reports || []).filter(x => x.report_type === 'work_end')
  ok('#9932 報告は二重にならない', reps.length === 1, reps)
}

// ---------- 1件の承認（既存の画面）も、承認と実績・金額を一緒に書く ----------
{
  const sh = await shiftWithReports(`${PFX}-ONE`)
  const id = await adminReq(sh, 'work_end', '17:30')
  const dry = await admin.post(`/api/admin/corrections/${id}/approve`, { dry_run: true })
  ok('1件の承認の確認（dry_run）: 承認した場合の実績・金額を返す', dry.status === 200 && dry.data.preview?.actual?.after?.actual_end === '17:30' && dry.data.preview.actual.after.bill_total === 11250, dry.data.preview)
  const ap = await admin.post(`/api/admin/corrections/${id}/approve`, {})
  const row = await settleRow(sh)
  ok('1件の承認: 実績と金額が承認と一緒に変わる', ap.status === 200 && row?.actual_end === '17:30' && row.bill_qty === 7.5 && row.bill_base === 11250, [ap.status, row && [row.actual_end, row.bill_qty, row.bill_base]])
  const again = await admin.post(`/api/admin/corrections/${id}/approve`, {})
  ok('1件の承認: 承認済みはもう一度承認できない（409）', again.status === 409, again)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log(' - ' + f.name)); process.exit(1) }
