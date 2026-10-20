// 日報・実績の機能追加の統合テスト（w5-report-features: #169 #279 #292 #496 #522 #523）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w5-report-features.mjs
// テストのたびに DB を作り直すこと（シフト・日報を追加し、会社の設定を変えるため、2 回目は結果が変わる）
// #279（稼働中のカウント）は画面（staff.js）だけの変更なので、ここでは確かめない

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`) }

async function login(company_code, user_code) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password: 'pass1234' }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, label) => { if (r.status !== 200) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.data)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const tag = Date.now().toString(36)

async function createShift(admin, staff_id, project_id, work_date, memo, start_time = '10:00', end_time = '18:00') {
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'createShift')
  const list = await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)
  const s = list.data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const reportOf = async (admin, date, shiftId, extra = '') => ((await admin.get(`/api/admin/daily-reports?date=${date}${extra}`)).data.reports || []).find(r => r.shift_id === shiftId)

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))
const st8 = client(await login('sample', 'st008')) // staff_id 8 中村 花菜
const st9 = client(await login('sample', 'st009')) // staff_id 9 小林 竜也

// 同じ日・同じ案件（1）に2人。前日にも小林さんのシフト
const s8 = await createShift(admin, 8, 1, today, `RF-8-${tag}`)
const s9 = await createShift(admin, 9, 1, today, `RF-9-${tag}`, '12:00', '20:00')
const s9y = await createShift(admin, 9, 1, addDays(today, -1), `RF-9Y-${tag}`)

// ---------- #522 店舗の申し送り ----------
{
  must(await st9.post('/api/staff/daily-report', { shift_id: s9y, values: { mnp: 1, store_share: 'バックヤードの入館は裏口からに変わりました', good_case: '' }, flags_explicit: true }), 'report 9y')
  const h = await st8.get(`/api/staff/handover/${s8}`)
  const n = h.data && (h.data.notes || []).find(x => x.values.store_share === 'バックヤードの入館は裏口からに変わりました')
  ok('#522 同じ案件のほかの人の店舗共有事項が、翌日のシフトの申し送りに出る', h.status === 200 && n && n.work_date === addDays(today, -1), h.data)
  ok('#522 名前は姓だけ・空の項目は出さない', n && n.name === '小林' && !('good_case' in n.values), n)
  ok('#522 項目の表示名を返す', h.status === 200 && h.data.fields.some(f => f.key === 'store_share' && f.label), h.data && h.data.fields)
  const own = await st9.get(`/api/staff/handover/${s9}`)
  ok('#522 自分の日報は自分の申し送りに出さない', own.status === 200 && !(own.data.notes || []).some(x => x.values.store_share === 'バックヤードの入館は裏口からに変わりました'), own.data)
  const other = await st8.get(`/api/staff/handover/${s9}`)
  ok('#522 ほかの人のシフトの申し送りは取れない（404）', other.status === 404, other)
}

// ---------- #523 一緒に入る人 ----------
{
  const c1 = await st8.get(`/api/staff/shifts/${s8}/coworkers`)
  const p = c1.data && (c1.data.coworkers || []).find(x => x.name === '小林')
  ok('#523 会社の設定が ON なら、同じ日・同じ案件のほかの人（姓と時刻）を返す', c1.status === 200 && c1.data.enabled === true && p && p.start_time === '12:00' && p.end_time === '20:00', c1.data)
  ok('#523 電話番号・金額などは返さない', p && Object.keys(p).sort().join(',') === 'end_time,name,same_slot,start_time', p)
  ok('#523 自分は含めない', c1.status === 200 && !(c1.data.coworkers || []).some(x => x.name === '中村'), c1.data)
  const other = await st8.get(`/api/staff/shifts/${s9}/coworkers`)
  ok('#523 ほかの人のシフトは 404', other.status === 404, other)
  // 1週間より前のシフトでは、一緒に入った人も申し送りも返さない（画面の表示条件と同じ）
  const old8 = await createShift(admin, 8, 1, addDays(today, -10), `RF-8O-${tag}`)
  await createShift(admin, 9, 1, addDays(today, -10), `RF-9O-${tag}`)
  const oldC = await st8.get(`/api/staff/shifts/${old8}/coworkers`)
  const oldH = await st8.get(`/api/staff/handover/${old8}`)
  ok('#523 #522 1週間より前のシフトでは返さない', oldC.status === 200 && oldC.data.coworkers.length === 0 && oldH.status === 200 && oldH.data.notes.length === 0, { oldC: oldC.data, oldH: oldH.data })
  const forbidden = await mgr.put('/api/admin/settings/staff-view', { show_coworkers: false })
  ok('#523 会社管理者以外は表示の設定を変えられない（403）', forbidden.status === 403, forbidden)
  const bad = await admin.put('/api/admin/settings/staff-view', { show_coworkers: 'no' })
  ok('#523 設定の値が真偽値でなければ 400', bad.status === 400, bad)
  const off = await admin.put('/api/admin/settings/staff-view', { show_coworkers: false })
  ok('#523 一緒に入る人を出さない設定にできる（ほかの設定は保つ）', off.status === 200 && off.data.show_coworkers === false && off.data.ranking_visible === true, off.data)
  const c2 = await st8.get(`/api/staff/shifts/${s8}/coworkers`)
  ok('#523 OFF なら返さない', c2.status === 200 && c2.data.enabled === false && c2.data.coworkers.length === 0, c2.data)
  const photo = await admin.get('/api/admin/settings/lateness')
  ok('#523 ほかの会社設定（遅刻の猶予）は壊れていない', photo.status === 200, photo)
}

// ---------- #169 インシデント・クレームの対応状況 ----------
let rid
{
  must(await st8.post('/api/staff/daily-report', { shift_id: s8, values: { mnp: 3, pi: 1 }, incident_flag: true, incident_note: '展示機を落とした', flags_explicit: true }), 'report 8')
  let r = await reportOf(admin, today, s8)
  rid = r && r.daily_report_id
  ok('#169 印の付いた日報は未対応（incident_status なし）', r && r.incident_flag === 1 && r.incident_status == null, r)
  let list = (await admin.get(`/api/admin/daily-reports?date=${today}&incident_open=1`)).data
  ok('#169 未対応のみで絞り込める・件数が返る', list.reports.some(x => x.daily_report_id === rid) && list.counts.incident_open >= 1, list.counts)
  const s9r = must(await st9.post('/api/staff/daily-report', { shift_id: s9, values: { mnp: 0 }, flags_explicit: true }), 'report 9')
  const plain = await reportOf(admin, today, s9)
  const np = await admin.put(`/api/admin/daily-reports/${plain.daily_report_id}/incident`, { status: 'done' })
  ok('#169 印の無い日報には記録できない（400）', np.status === 400, np)
  const badSt = await admin.put(`/api/admin/daily-reports/${rid}/incident`, { status: 'closed' })
  ok('#169 対応状況の値が正しくなければ 400', badSt.status === 400, badSt)
  const u1 = await mgr.put(`/api/admin/daily-reports/${rid}/incident`, { status: 'in_progress', memo: '店長に連絡済み。クライアントへの報告は明日', expected_updated_at: null })
  r = await reportOf(admin, today, s8)
  ok('#169 対応中とメモを記録でき、記録した人と日時が残る', u1.status === 200 && r.incident_status === 'in_progress' && r.incident_memo === '店長に連絡済み。クライアントへの報告は明日' && r.incident_updated_by_name === '藤田 現場長' && r.incident_updated_at, r)
  const stale = await admin.put(`/api/admin/daily-reports/${rid}/incident`, { status: 'done', expected_updated_at: null })
  ok('#169 開いた後にほかの管理者が更新していたら 409', stale.status === 409, stale)
  const u2 = await admin.put(`/api/admin/daily-reports/${rid}/incident`, { status: 'done', client_shared: true, expected_updated_at: r.incident_updated_at })
  r = await reportOf(admin, today, s8)
  ok('#169 対応済み・クライアント共有済みにでき、メモは保つ', u2.status === 200 && r.incident_status === 'done' && r.incident_client_shared_at && r.incident_memo === '店長に連絡済み。クライアントへの報告は明日', r)
  const sharedAt = r.incident_client_shared_at
  list = (await admin.get(`/api/admin/daily-reports?date=${today}&incident_open=1`)).data
  ok('#169 対応済みは未対応の絞り込みに出ない（インシデントの絞り込みには出る）', !list.reports.some(x => x.daily_report_id === rid)
    && (await admin.get(`/api/admin/daily-reports?date=${today}&flagged=1`)).data.reports.some(x => x.daily_report_id === rid), list.counts)
  const long = await admin.put(`/api/admin/daily-reports/${rid}/incident`, { memo: 'x'.repeat(2001) })
  ok('#169 メモが2000文字を超えると 400', long.status === 400, long)
  // 同じ印のまま再提出しても対応済みは保つ
  must(await st8.post('/api/staff/daily-report', { shift_id: s8, values: { mnp: 4, pi: 1 }, incident_flag: true, flags_explicit: true }), 'resubmit')
  r = await reportOf(admin, today, s8)
  ok('#169 印が変わらない再提出では対応済みを保つ', r.incident_status === 'done' && r.incident_client_shared_at === sharedAt, r)
  // 新しくクレームの印が付いたら未対応に戻す
  must(await st8.post('/api/staff/daily-report', { shift_id: s8, values: { mnp: 4, pi: 1 }, incident_flag: true, complaint_flag: true, complaint_note: '説明が長いと苦情', flags_explicit: true }), 'resubmit2')
  r = await reportOf(admin, today, s8)
  ok('#169 新しく印が付いたら未対応に戻る', r.incident_status == null && r.incident_memo === '店長に連絡済み。クライアントへの報告は明日', r)
  const other = await st8.put(`/api/admin/daily-reports/${rid}/incident`, { status: 'done' })
  ok('#169 スタッフは対応状況を変えられない', other.status === 401 || other.status === 403, other)
}

// ---------- #292 案件の月間目標 ----------
{
  const g = await admin.get('/api/admin/project-goals')
  const p1 = g.data && g.data.projects.find(p => p.project_id === 1)
  ok('#292 稼働中の案件と、テンプレートの数値項目を返す', g.status === 200 && p1 && p1.fields.some(f => f.key === 'mnp') && !p1.fields.some(f => f.key === 'store_share'), p1)
  const bad1 = await admin.put('/api/admin/projects/1/goals', { goals: { store_share: 3 } })
  ok('#292 数値項目でないキーは 400', bad1.status === 400, bad1)
  const bad2 = await admin.put('/api/admin/projects/1/goals', { goals: { mnp: -1 } })
  ok('#292 負の数は 400', bad2.status === 400, bad2)
  const bad3 = await admin.put('/api/admin/projects/1/goals', { goals: { mnp: 1.5 } })
  ok('#292 小数は 400', bad3.status === 400, bad3)
  const nf = await admin.put('/api/admin/projects/999999/goals', { goals: { mnp: 1 } })
  ok('#292 自社に無い案件は 404', nf.status === 404, nf)
  const u = await admin.put('/api/admin/projects/1/goals', { goals: { mnp: 10, pi: 0, shinki: null } })
  ok('#292 目標を保存できる（0・空欄は目標なし）', u.status === 200 && JSON.stringify(u.data.goals) === '{"mnp":10}', u.data)
  const perf = (await st8.get('/api/staff/performance')).data
  const pj = perf.projects.find(p => p.project_id === 1)
  const goal = pj && pj.goals.find(x => x.key === 'mnp')
  ok('#292 スタッフの実績に目標と実績が出る', goal && goal.target === 10 && goal.actual === 4 && goal.label && pj.goals.length === 1, pj && pj.goals)
  ok('#292 月の日数と経過日数を返す', perf.goal_period && perf.goal_period.days_in_month >= 28 && perf.goal_period.days_elapsed === Number(today.slice(8, 10)), perf.goal_period)
}

// ---------- #496 実績画面の順位 ----------
{
  // seed の会社1は ranking_visible: true / ranking_anonymous: false
  let perf = (await st8.get('/api/staff/performance')).data
  let pj = perf.projects.find(p => p.project_id === 1)
  const k = pj && pj.ranking && pj.ranking.by_key.mnp
  ok('#496 ランキングを出す設定なら、案件の中の順位・人数・平均を返す', pj && pj.ranking && pj.ranking.members >= 2 && k && k.rank === 1 && k.value === 4 && typeof k.average === 'number', pj && pj.ranking)
  ok('#496 匿名でないときは上位のほかの人の姓を出し、自分には me を付ける', k && k.top[0].me === true && !('name' in k.top[0]) && k.top.slice(1).every(t => typeof t.name === 'string' && !/\s/.test(t.name)), k && k.top)
  must(await admin.put('/api/admin/settings/staff-view', { ranking_anonymous: true }), 'anon')
  perf = (await st8.get('/api/staff/performance')).data
  pj = perf.projects.find(p => p.project_id === 1)
  ok('#496 匿名のときは名前を返さない', pj.ranking && pj.ranking.anonymous === true && Object.values(pj.ranking.by_key).every(x => x.top.every(t => !('name' in t))), pj.ranking)
  const s9perf = (await st9.get('/api/staff/performance')).data.projects.find(p => p.project_id === 1)
  ok('#496 小林さんから見た mnp の順位（自分より多い人の数＋1）', s9perf && s9perf.ranking.by_key.mnp.rank >= 2 && s9perf.ranking.by_key.mnp.value === 1, s9perf && s9perf.ranking.by_key.mnp)
  must(await admin.put('/api/admin/settings/staff-view', { ranking_visible: false }), 'hide')
  perf = (await st8.get('/api/staff/performance')).data
  pj = perf.projects.find(p => p.project_id === 1)
  ok('#496 ランキングを出さない設定なら返さない（目標は出す）', pj && !pj.ranking && pj.goals.length === 1, pj)
  const s = (await admin.get('/api/admin/settings/staff-view')).data
  ok('#496 設定を読める（会社管理者は変更できる）', s.ranking_visible === false && s.ranking_anonymous === true && s.show_coworkers === false && s.can_edit === true, s)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
