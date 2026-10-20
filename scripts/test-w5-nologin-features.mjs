// ログインのないスタッフ向けの機能の統合テスト（w5-nologin-features: #163 #275 #276 #281 #442 #508）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8821 node scripts/test-w5-nologin-features.mjs
// 画面（report-link.js の予定確認・連絡・お知らせ、staff-lifecycle.js のまとめての画面・日報の代理入力・予定確認URLの行）はブラウザで確かめる。
// ここでは画面が頼る API の応答を確かめる
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
const pub = {
  get: async (token) => { const r = await fetch(`${BASE}/api/public/report/${token}`); return { status: r.status, data: await r.json().catch(() => null) } },
  post: async (token, path, body) => {
    const r = await fetch(`${BASE}/api/public/report/${token}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => null) }
  },
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yesterday = addDays(today, -1), tomorrow = addDays(today, 1)
const tag = Date.now().toString(36).slice(-5)
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data }

const admin = client(await login('sample', 'admin'))
async function createShift(staff_id, project_id, work_date, start_time, end_time) {
  const memo = `W5NL-${tag}-${Math.random().toString(36).slice(2, 7)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, force: true }), 'createShift')
  const s = (await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)).data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const quick = async (name, n) => must(await admin.post('/api/admin/staff-quick', { name, phone: '090' + String(Date.now()).slice(-6) + String(n).padStart(2, '0'), affiliation_type: 'daily_worker', force: true }), 'staff-quick').staff_id

// ---------- 前提 ----------
const P = must(await admin.post('/api/admin/projects', { project_name: `W5NL案件${tag}`, location: '新宿店', allow_duplicate: true }), 'project').project_id
const A = await quick(`仮 太郎${tag}`, 1)
const B = await quick(`仮 次郎${tag}`, 2)
const SA = await createShift(A, P, yesterday, '09:00', '18:00')
const SB = await createShift(B, P, yesterday, '09:00', '18:00')
const S9 = await createShift(9, P, yesterday, '09:00', '18:00') // ログインのある人（st009）
const SA2 = await createShift(A, P, tomorrow, '10:00', '19:00')
const SB2 = await createShift(B, P, addDays(today, 3), '10:00', '19:00')
await admin.put('/api/admin/settings/mail-contact', { reply_to: '', phone: '03-1234-5678' })

// ---------- #281 お知らせ（重要なものだけを報告用ページに出す） ----------
must(await admin.post('/api/admin/notices', { title: `重要W5NL${tag}`, body: '制服が変わります', importance: 'important', target_type: 'all' }), 'notice important')
must(await admin.post('/api/admin/notices', { title: `通常W5NL${tag}`, body: '通常のお知らせ', importance: 'normal', target_type: 'all' }), 'notice normal')

// ---------- #275 報告用URLのまとめての発行 ----------
{
  const g = await admin.get(`/api/admin/report-links/bulk?date=${yesterday}&project_id=${P}`)
  const ids = (g.data.rows || []).map(r => r.shift_id)
  ok('#275 ログインのない人のシフトだけを返す（ログインのある人は出さない）', g.status === 200 && ids.includes(SA) && ids.includes(SB) && !ids.includes(S9), g.data)
  ok('#275 発行前は未発行（token なし）', g.data.rows.every(r => !r.token), g.data.rows)
  ok('#281 本人あての重要なお知らせの数を返す（案内文に添える）', g.data.rows.find(r => r.shift_id === SA).notice_count >= 1, g.data.rows)
  const p = await admin.post('/api/admin/report-links/bulk', { date: yesterday, project_id: P })
  ok('#275 未発行の分をまとめて発行する', p.status === 200 && p.data.issued === 2 && p.data.rows.every(r => r.token), p.data)
  const p2 = await admin.post('/api/admin/report-links/bulk', { date: yesterday, project_id: P })
  ok('#275 もう一度押しても、発行済みのURLは発行し直さない', p2.status === 200 && p2.data.issued === 0 && p2.data.rows.find(r => r.shift_id === SA).token === p.data.rows.find(r => r.shift_id === SA).token, p2.data)
  const tA = p.data.rows.find(r => r.shift_id === SA).token
  const rs = await admin.get(`/api/admin/shifts/${SA}/report-status`)
  ok('#275 発行したURLはシフト詳細の報告パネルでも同じもの', rs.data.token && rs.data.token.token === tA, rs.data.token)
  const bad = await admin.get('/api/admin/report-links/bulk?date=2026-13-01')
  ok('#275 日付の形式が違えば 400', bad.status === 400, bad)

  // ---------- #281 報告用ページのお知らせと #163 連絡 ----------
  const v = await pub.get(tA)
  ok('#281 報告用ページに重要なお知らせを出す', v.status === 200 && v.data.kind === 'shift' && v.data.notices.some(n => n.title === `重要W5NL${tag}`), v.data && v.data.notices)
  ok('#281 通常のお知らせは出さない', !v.data.notices.some(n => n.title === `通常W5NL${tag}`), v.data.notices)
  ok('#163 報告用ページに会社の電話番号を返す', v.data.contact_phone === '03-1234-5678', v.data.contact_phone)
  const c1 = await pub.post(tA, 'consultation', { kind: 'late', body: '電車の遅延で10分遅れます' })
  ok('#163 報告用URLから遅刻を連絡できる', c1.status === 200 && c1.data.consultation_id && c1.data.contact_phone === '03-1234-5678', c1)
  const c2 = await pub.post(tA, 'consultation', { kind: 'late', body: '電車の遅延で10分遅れます' })
  ok('#163 同じ内容の続けての再送は 409', c2.status === 409 && c2.data.duplicate, c2)
  const c3 = await pub.post(tA, 'consultation', { kind: 'trouble', body: '' })
  ok('#163 トラブルは内容が必須', c3.status === 400, c3)
  const c4 = await pub.post(tA, 'consultation', { kind: 'xxx' })
  ok('#163 種類が違えば 400', c4.status === 400, c4)
  const list = await admin.get('/api/admin/consultations?status=all')
  const got = (list.data.consultations || []).find(x => x.consultation_id === c1.data.consultation_id)
  ok('#163 相談の一覧に、シフトの案件・日付と種類付きで届く', got && got.category === 'absence' && got.body.startsWith('【遅刻】') && got.target_date === yesterday && got.target_project_id === P && got.urgency === 'high' && got.entry_method === 'link', got)

  // 無効にしたURLの画面には会社名と電話番号を出す（でたらめなURLには出さない）
  must(await admin.del(`/api/admin/shifts/${SB}/report-link`), 'revoke')
  const tB = p.data.rows.find(r => r.shift_id === SB).token
  const inv = await pub.get(tB)
  ok('#163 無効にしたURLは 404 で、会社名と電話番号を返す', inv.status === 404 && inv.data.company_name && inv.data.contact_phone === '03-1234-5678', inv)
  const rnd = await pub.get('abcdefghijklmnopqrstuvwxyz0123')
  ok('#163 発行されていないURLには会社名を返さない', rnd.status === 404 && !rnd.data.company_name, rnd)
  const c5 = await pub.post(tB, 'consultation', { kind: 'late' })
  ok('#163 無効にしたURLからは連絡できない（404）', c5.status === 404, c5)
}

// ---------- #508 まとめての代理入力 ----------
{
  const g = await admin.get(`/api/admin/proxy-attendance/bulk?date=${yesterday}&project_id=${P}`)
  const order = (g.data.shifts || []).map(s => s.shift_id)
  ok('#508 その日の勤務のシフトを返し、ログインのない人を先に並べる', g.status === 200 && order.indexOf(SA) >= 0 && order.indexOf(S9) > order.indexOf(SA) && order.indexOf(S9) > order.indexOf(SB), order)
  const rowA = g.data.shifts.find(s => s.shift_id === SA)
  ok('#508 予定の時刻（既定値）と必要な報告を返す', rowA && rowA.defaults.check_in === `${yesterday} 09:00:00` && rowA.required.includes('check_in') && rowA.has_login === false, rowA)
  const bad = await admin.post('/api/admin/proxy-attendance/bulk', { scope: 'all', items: [{ shift_id: SA, start: '9時' }] })
  ok('#508 時刻の形式が違えば 400', bad.status === 400, bad)
  const noScope = await admin.post('/api/admin/proxy-attendance/bulk', { items: [{ shift_id: SA }] })
  ok('#508 範囲の指定がなければ 400', noScope.status === 400, noScope)
  const many = await admin.post('/api/admin/proxy-attendance/bulk', { scope: 'all', items: Array.from({ length: 51 }, (_, i) => ({ shift_id: i + 1 })) })
  ok('#508 51件以上は 400', many.status === 400, many)
  const r = await admin.post('/api/admin/proxy-attendance/bulk', { scope: 'all', items: [{ shift_id: SA }, { shift_id: SB, start: '09:20', end: '17:30' }, { shift_id: SA2 }, { shift_id: 99999999 }] })
  ok('#508 まとめて記録できる', r.status === 200 && r.data.created > 0 && r.data.recorded.some(x => x.shift_id === SA) && r.data.recorded.some(x => x.shift_id === SB), r.data)
  ok('#508 稼働日より前のシフトは理由を付けて記録しない', r.data.skipped.some(x => x.shift_id === SA2 && /稼働日より前/.test(x.reason)), r.data.skipped)
  ok('#508 見つからないシフトは理由を付けて記録しない', r.data.skipped.some(x => x.shift_id === 99999999), r.data.skipped)
  ok('#508 入店を予定より遅く直した人は遅刻として記録する', r.data.recorded.find(x => x.shift_id === SB).late === true, r.data.recorded)
  const sa = await admin.get(`/api/admin/shifts/${SA}/report-status`)
  const ci = sa.data.reports.find(x => x.report_type === 'check_in'), co = sa.data.reports.find(x => x.report_type === 'check_out')
  ok('#508 予定どおりの時刻で、代理入力として記録する', ci && ci.reported_at === `${yesterday} 09:00:00` && ci.entry_method === 'proxy' && co && co.reported_at === `${yesterday} 18:00:00`, sa.data.reports)
  const sb = await admin.get(`/api/admin/shifts/${SB}/report-status`)
  const ciB = sb.data.reports.find(x => x.report_type === 'check_in'), coB = sb.data.reports.find(x => x.report_type === 'check_out')
  ok('#508 人ごとに直した開始・終了の時刻で記録する', ciB && ciB.reported_at === `${yesterday} 09:20:00` && coB && coB.reported_at === `${yesterday} 17:30:00`, sb.data.reports)
  const shifts = (await admin.get(`/api/admin/shifts?from=${yesterday}&to=${yesterday}`)).data.shifts
  const shA = shifts.find(s => s.shift_id === SA)
  ok('#508 実績（実働の開始・終了）に反映する', shA && shA.actual_start && shA.actual_end, shA && { actual_start: shA.actual_start, actual_end: shA.actual_end })
  const again = await admin.post('/api/admin/proxy-attendance/bulk', { scope: 'all', items: [{ shift_id: SA }] })
  ok('#508 報告済みのシフトをもう一度送っても二重に記録しない', again.status === 200 && again.data.created === 0 && again.data.skipped.length === 1, again.data)
  const st9 = await admin.post('/api/admin/proxy-attendance/bulk', { scope: 'start', items: [{ shift_id: S9 }] })
  ok('#508 入店・勤務開始だけの範囲では、終了の報告を記録しない', st9.status === 200 && st9.data.recorded[0] && !st9.data.recorded[0].types.includes('check_out') && st9.data.recorded[0].types.includes('check_in'), st9.data)
}

// ---------- #276 日報の代理入力 ----------
{
  const rs = await admin.get(`/api/admin/shifts/${SA}/report-status`)
  ok('#276 報告パネルに日報テンプレートの項目を返す', rs.status === 200 && rs.data.daily_template && Array.isArray(rs.data.daily_template.fields) && rs.data.daily_blocked === null, rs.data.daily_template)
  const values = {}
  for (const f of (rs.data.daily_template ? rs.data.daily_template.fields : [])) values[f.key] = f.type === 'number' ? 1 : '電話で聞き取り'
  if (!rs.data.daily_template || !rs.data.daily_template.fields.length) values.free = '電話で聞き取り'
  const r = await admin.post(`/api/admin/shifts/${SA}/proxy-daily-report`, { values, incident_flag: false, complaint_flag: false })
  ok('#276 日報を代理入力できる', r.status === 200, r)
  const rs2 = await admin.get(`/api/admin/shifts/${SA}/report-status`)
  ok('#276 代理入力の印と入力した管理者を返す', rs2.data.daily_report && rs2.data.daily_report.entry_method === 'proxy' && rs2.data.daily_report.entered_by_name, rs2.data.daily_report)
  const dl = await admin.get(`/api/admin/daily-reports?date=${yesterday}&project_id=${P}`)
  const row = (dl.data.reports || dl.data.daily_reports || []).find(x => x.shift_id === SA)
  ok('#276 日報の一覧でも代理入力と分かる（entry_method・entered_by）', row && row.entry_method === 'proxy' && row.entered_by, row)
  const fut = await admin.post(`/api/admin/shifts/${SA2}/proxy-daily-report`, { values })
  ok('#276 稼働日より前のシフトには代理入力できない', fut.status === 400, fut)
  // 本人が報告用URLから出し直したら、代理の印は外れ、管理者の上書きには確認が要る
  const p = await admin.post(`/api/admin/shifts/${SA}/report-link`, {})
  const sub = await pub.post(p.data.token, 'daily-report', { values, flags_explicit: true })
  ok('#276（前提）本人が報告用URLから日報を出し直す', sub.status === 200, sub)
  const rs3 = await admin.get(`/api/admin/shifts/${SA}/report-status`)
  ok('#276 本人が出し直したら、代理入力の印と入力者は外れる', rs3.data.daily_report.entry_method === 'link' && !rs3.data.daily_report.entered_by_name, rs3.data.daily_report)
  const ow = await admin.post(`/api/admin/shifts/${SA}/proxy-daily-report`, { values })
  ok('#276 本人が提出した日報は、確認なしでは上書きしない（409）', ow.status === 409 && ow.data.need_overwrite, ow)
  const ow2 = await admin.post(`/api/admin/shifts/${SA}/proxy-daily-report`, { values, overwrite: true })
  ok('#276 確認すれば上書きできる', ow2.status === 200 && ow2.data.updated === true, ow2)
}

// ---------- #442 予定確認URL ----------
{
  const no = await admin.post('/api/admin/staff/9/schedule-link', {})
  ok('#442 ログインのある人には発行しない（400）', no.status === 400, no)
  const r = await admin.post(`/api/admin/staff/${B}/schedule-link`, {})
  ok('#442 予定確認URLを発行できる（URL はこの応答だけ）', r.status === 200 && r.data.token && r.data.expires_at, r)
  const life = await admin.get(`/api/admin/staff/${B}/lifecycle`)
  ok('#442 区分・登録状態に、発行済みの予定確認URLの期限を返す（URL そのものは返さない）', life.data.schedule_link && life.data.schedule_link.expires_at === r.data.expires_at && !('token' in life.data.schedule_link), life.data.schedule_link)
  const v = await pub.get(r.data.token)
  const ids = v.data && v.data.shifts ? v.data.shifts.map(s => s.shift_id) : []
  ok('#442 前日〜2週間先の確定シフトを返す', v.status === 200 && v.data.kind === 'schedule' && ids.includes(SB) && ids.includes(SB2), v.data)
  ok('#442 金額を返さない', !JSON.stringify(v.data).match(/pay_|bill_|unit_price|amount/), Object.keys(v.data.shifts[0] || {}))
  ok('#442 前日〜翌日のシフトには報告用URLの入口を付け、それより先には付けない', v.data.shifts.find(s => s.shift_id === SB2).report_token === null, v.data.shifts)
  // SB の報告用URLは上で無効にしたので、予定確認URLから開いたときに新しく発行される
  const near = v.data.shifts.find(s => s.shift_id === SB)
  ok('#442 前日のシフトの報告用URLを（無効にしたものは使わず）新しく用意する', near && near.report_token, near)
  const vv = near && near.report_token ? await pub.get(near.report_token) : { status: 0 }
  ok('#442 入口の報告用URLでそのシフトの報告画面を開ける', vv.status === 200 && vv.data.kind === 'shift', vv)
  ok('#281 予定確認ページにも重要なお知らせを出す', v.data.notices.some(n => n.title === `重要W5NL${tag}`), v.data.notices)
  const c = await pub.post(r.data.token, 'consultation', { kind: 'absent', body: '体調不良のため休みます', shift_id: SB2 })
  ok('#163 予定確認URLから、選んだシフトについて欠勤を連絡できる', c.status === 200, c)
  const cx = await pub.post(r.data.token, 'consultation', { kind: 'absent', body: '別の人', shift_id: SA2 })
  ok('#163 他の人のシフトは選べない（404）', cx.status === 404, cx)
  const att = await pub.post(r.data.token, 'attendance', { report_type: 'check_in' })
  ok('#442 予定確認URLでは勤怠報告を受け付けない（シフトの報告用URLを使う）', att.status === 404, att)
  const r2 = await admin.post(`/api/admin/staff/${B}/schedule-link`, {})
  const old = await pub.get(r.data.token)
  ok('#442 発行し直すと前のURLは使えない', r2.status === 200 && old.status === 404 && old.data.company_name, old)
  must(await admin.del(`/api/admin/staff/${B}/schedule-link`), 'revoke schedule')
  const gone = await pub.get(r2.data.token)
  ok('#442 無効にしたURLは使えない（会社名と連絡先は出す）', gone.status === 404 && gone.data.contact_phone === '03-1234-5678', gone)
  // 退職したら自動で使えなくなる
  const C = await quick(`仮 三郎${tag}`, 3)
  const r3 = must(await admin.post(`/api/admin/staff/${C}/schedule-link`, {}), 'issue C')
  const ok1 = await pub.get(r3.token)
  const pr = await admin.put(`/api/admin/staff/${C}`, { retired_at: yesterday, employment_status: 'retired', retired_at_confirmed: true })
  const ret = await pub.get(r3.token)
  ok('#442 退職したら自動で使えなくなる', ok1.status === 200 && pr.status === 200 && ret.status === 404, { before: ok1.status, put: pr, after: ret.status })
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
