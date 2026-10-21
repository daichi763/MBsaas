// 残りの仕上げ（管理画面: w8-admin-ui）の統合テスト
//
// 画面（public/static/*.js）が使う API の形と、配信される画面のコードを確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local --persist-to <保存先>` で起動していること
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w8-admin-ui.mjs
//   サーバー側（w8-server）で作る API（案件ごとの遅刻の猶予・申請の受付期限・空の案件とクライアントの削除）に頼る確認は、
//   API がまだ無いときは PEND と出して失敗に数えない。統合の後は STRICT=1 を付けて、PEND も失敗として数える
const BASE = process.env.BASE || 'http://127.0.0.1:8811'
const STRICT = process.env.STRICT === '1'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }
// サーバー側の対応待ちの確認。ready が false なら PEND（STRICT=1 のときは失敗）
const pend = (name, ready, cond, detail) => {
  if (!ready && !STRICT) { results.push({ name, pass: true, pend: true }); console.log(`PEND  ${name}（サーバー側の対応待ち）`); return }
  ok(name, ready && cond, detail)
}
// ルートが無いとき（Hono の既定の 404。本文が JSON でない）
const routeMissing = (r) => r.status === 404 && r.data === null

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
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const staticJs = async (name) => (await fetch(`${BASE}/static/${name}`)).text()

const PFX = 'W8U' + Date.now().toString(36).slice(-4).toUpperCase()
const phone = (n) => '080' + String(Date.now() % 100000000 + n).padStart(8, '0').slice(-8)
const admin = client(await login('sample', 'admin'))

// ---------- 画面のコード（配信される JS） ----------
{
  const a = await staticJs('admin.js'), sb = await staticJs('shift-board.js'), nt = await staticJs('notifications.js'), co = await staticJs('corrections.js')
  ok('#464 通知の種類の名前（交通費・延長の申請、登録情報の変更申請、書類の提出、休暇の申請、休憩なしの申告）',
    ['pay_request_submitted', 'profile_change_submitted', 'staff_document_submitted', 'leave_submitted', 'attendance_no_break'].every(k => nt.includes(k + ':')))
  ok('#297 #464 書類の有効期限の通知（docs_expiring）とメールの種類（doc_expiry）の名前', nt.includes('docs_expiring:') && nt.includes('doc_expiry:'))
  ok('#184 スタッフ詳細・案件詳細・スキルシートの実績は、API の performance_fields（テンプレートの数値項目）で列を組み立てる',
    a.includes('function perfColumns') && a.split('perfColumns(data.performance_fields)').length - 1 >= 3 && a.includes('const PERF_FIXED_FIELDS'))
  ok('9004 勤怠の設定を変えられない役割（can_edit が false）には、保存のボタンを出さない',
    a.includes('ATTENDANCE_SETTING_DENIED_TEXT') && (a.match(/can_edit === false/g) || []).length >= 4 && co.includes("s.can_edit === false"))
  ok('#464 表にない種類は「その他」と出し、生の種類名をそのまま出さない', nt.includes('const kindLabel') && !nt.includes("KIND[n.kind] || n.kind"))
  ok('#276 日報一覧のカードに入力経路（代理入力・報告用URL）のバッジ', a.includes('function reportEntryBadge') && a.includes('${reportEntryBadge(r)}'))
  ok('#275 シフトボードのツールバーと日付の見出しから、報告用URLのまとめての発行を開ける',
    (sb.match(/data-action="openNologinBulk"/g) || []).length >= 2 && sb.includes('function nologinDayBtn'))
  ok('#275 シフトボードの日付の見出しの枠の作成は、イベント属性に日付を埋め込まない', !sb.includes("onclick=\"openSlotModal({work_date:'") && sb.includes("delegate('boardSlotOnDate'"))
  ok('#497 案件詳細に案件ごとの遅刻の猶予（PUT /admin/projects/:id/lateness）', a.includes('function projectLatenessHtml') && a.includes('/lateness`, { grace_minutes: custom ? Number(v) : null }'))
  ok('#497 会社の遅刻の猶予の画面に、案件ごとに変えている案件の一覧', a.includes('案件ごとに変えている案件はありません') && a.includes('p.late_grace_minutes != null'))
  ok('#215 打刻修正承認に受付期限の設定（GET/PUT /admin/settings/corrections）', co.includes("delegate('corrDeadlineSetting'") && co.includes("axios.put('/api/admin/settings/corrections', { deadline_days: deadline })"))
  ok('#359 案件の編集・クライアントの編集に削除（DELETE /admin/projects/:id・/admin/clients/:id）',
    a.includes("delegate('deleteProject'") && a.includes("delegate('deleteClient'") && a.includes("axios.delete('/api/admin/projects/'") && a.includes("axios.delete('/api/admin/clients/'"))
  // 入力の確認の正規表現（数字だけ）が壊れていない（/^d+$/ は「d の並び」になり、どの数値も通らない）
  ok('#497 #215 案件の猶予・受付期限の入力の確認は数字を受け付ける', !a.includes('/^d+$/') && !co.includes('/^d+$/') && a.includes('custom && (!/^[0-9]+$/.test(v)') && co.includes("mode === 'days' && (!/^[0-9]+$/.test(v.trim())"))
  ok('#184 案件詳細の並べ替えのボタンは、成約率を出さない表では成約率を出さない', a.includes("rankControlsHtml('rankProject', projectPerfColumns(data).hasRate)"))
}

// ---------- 準備: 案件・ログインのないスタッフ・昨日のシフト ----------
const P = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-案件`, allow_duplicate: true }), 'project').project_id
const A = must(await admin.post('/api/admin/staff-quick', { name: `${PFX} 仮スタッフ`, phone: phone(1), affiliation_type: 'daily_worker', force: true }), 'staff-quick').staff_id
const Y = addDays(jstToday, -1)
async function createShift(staff_id, project_id, work_date, start_time, end_time) {
  const memo = `${PFX}-${Math.random().toString(36).slice(2, 7)}`
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo, force: true }), 'shift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}
const S1 = await createShift(A, P, Y, '09:00', '18:00')

// ---------- #275 報告用URLのまとめての発行（シフトボードから開く画面が使う API） ----------
{
  const g = await admin.get(`/api/admin/report-links/bulk?date=${Y}&project_id=${P}`)
  ok('#275 日付・案件で、ログインのない人のシフトと案件の選択肢を返す', g.status === 200 && (g.data.rows || []).some(r => r.shift_id === S1) && (g.data.projects || []).some(p => p.project_id === P), g.data)
  const all = await admin.get(`/api/admin/report-links/bulk?date=${Y}`)
  ok('#275 案件を指定しなくても開ける（ツールバーから開いたとき）', all.status === 200 && (all.data.rows || []).some(r => r.shift_id === S1), all.status)
}

// ---------- #276 日報一覧の代理入力の印 ----------
{
  const rs = must(await admin.get(`/api/admin/shifts/${S1}/report-status`), 'report-status')
  const values = {}
  for (const f of (rs.daily_template ? rs.daily_template.fields : [])) values[f.key] = f.type === 'number' ? 1 : '電話で聞き取り'
  const r = await admin.post(`/api/admin/shifts/${S1}/proxy-daily-report`, { values, incident_flag: false, complaint_flag: false })
  ok('#276 日報を代理入力できる', r.status === 200, r.data)
  const dl = must(await admin.get(`/api/admin/daily-reports?date=${Y}&project_id=${P}`), 'daily-reports')
  const row = (dl.reports || []).find(x => x.shift_id === S1)
  ok('#276 日報一覧の行に entry_method = proxy（画面の「代理入力」のバッジに使う）', row && row.entry_method === 'proxy', row)
  // 記録した管理者の名前（entered_by_name）は API が返すときだけ画面に出す（今は entered_by の ID だけ。必須にしない）
}

// ---------- #184 実績の項目（テンプレートの数値項目） ----------
{
  const d = must(await admin.get(`/api/admin/projects/${P}`), 'project')
  pend('#184 案件詳細が performance_fields と各行の values を返す', 'performance_fields' in d, Array.isArray(d.performance_fields) && d.staff_performance.every(r => r.values && typeof r.values === 'object'), d.performance_fields)
  const st = must(await admin.get(`/api/admin/staff/${A}`), 'staff')
  pend('#184 スタッフ詳細が performance_fields と月ごとの values を返す', 'performance_fields' in st, Array.isArray(st.performance_fields) && st.performance.every(m => m.values && typeof m.values === 'object'), st.performance_fields)
}

// ---------- #464 通知の種類での絞り込み ----------
{
  const r = await admin.get('/api/admin/notifications?kind=pay_request_submitted&limit=5')
  ok('#464 新しく名前を付けた種類でも受信箱を絞り込める', r.status === 200 && Array.isArray(r.data.notifications) && r.data.notifications.every(n => n.kind === 'pay_request_submitted'), r.data)
}

// ---------- #497 案件ごとの遅刻の猶予 ----------
{
  const company = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
  pend('#497 会社の猶予の画面に使う projects（案件ごとの late_grace_minutes）と can_edit を返す', 'projects' in company,
    Array.isArray(company.projects) && company.projects.some(p => p.project_id === P && 'late_grace_minutes' in p) && company.can_edit === true, company)
  const put = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 15 })
  const ready = !routeMissing(put)
  pend('#497 案件の猶予を保存できる（PUT /admin/projects/:id/lateness）', ready, put.status === 200, put)
  if (ready && put.status === 200) {
    const d = must(await admin.get(`/api/admin/projects/${P}`), 'project')
    ok('#497 案件詳細の project.late_grace_minutes に保存した値（画面の「この案件だけ変える」）', Number(d.project.late_grace_minutes) === 15, d.project.late_grace_minutes)
    const list = must(await admin.get('/api/admin/projects'), 'projects').projects
    ok('#497 案件一覧にも late_grace_minutes（会社の猶予の画面の上書き一覧に使う）', Number((list.find(p => p.project_id === P) || {}).late_grace_minutes) === 15)
    const after = must(await admin.get('/api/admin/settings/lateness'), 'lateness')
    ok('#497 案件の猶予を変えても会社の猶予は変わらない', after.grace_minutes === company.grace_minutes, after)
    // 判定にも案件の猶予を使う（会社の猶予を 0 にして、10分遅れの入店を代理入力する）
    must(await admin.put('/api/admin/settings/lateness', { grace_minutes: 0 }), 'company grace 0')
    const S2 = await createShift(A, P, addDays(jstToday, -2), '09:00', '18:00')
    const px = await admin.post('/api/admin/proxy-attendance/bulk', { scope: 'start', items: [{ shift_id: S2, start: '09:10' }] })
    const rec = px.data && (px.data.recorded || []).find(x => x.shift_id === S2)
    ok('#497 案件の猶予（15分）以内の遅れは、会社の猶予が0分でも遅刻にしない', px.status === 200 && rec && rec.late === false, px.data)
    must(await admin.put('/api/admin/settings/lateness', { grace_minutes: Number(company.grace_minutes) || 0 }), 'restore company grace')
    const bad = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: 121 })
    ok('#497 上限を超える猶予は 400', bad.status === 400, bad)
    const neg = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: -1 })
    ok('#497 負の猶予は 400', neg.status === 400, neg)
    const clr = await admin.put(`/api/admin/projects/${P}/lateness`, { grace_minutes: null })
    const d2 = must(await admin.get(`/api/admin/projects/${P}`), 'project')
    ok('#497 null で会社の設定に従うに戻せる', clr.status === 200 && d2.project.late_grace_minutes == null, d2.project.late_grace_minutes)
    const other = await admin.put('/api/admin/projects/99999999/lateness', { grace_minutes: 5 })
    ok('#497 他社・存在しない案件は 404', other.status === 404, other.status)
  }
}

// ---------- #215 申請の受付期限 ----------
{
  const g = await admin.get('/api/admin/settings/corrections')
  const ready = !routeMissing(g)
  pend('#215 受付期限を読める（GET /admin/settings/corrections）', ready, g.status === 200 && 'deadline_days' in (g.data || {}), g)
  if (ready && g.status === 200) {
    const before = g.data.deadline_days ?? null
    const p = await admin.put('/api/admin/settings/corrections', { deadline_days: 7 })
    const g2 = must(await admin.get('/api/admin/settings/corrections'), 'corrections settings')
    ok('#215 受付期限を日数で保存できる', p.status === 200 && Number(g2.deadline_days) === 7, g2)
    for (const v of [0, 367, 1.5, '7日']) {
      const b = await admin.put('/api/admin/settings/corrections', { deadline_days: v })
      ok(`#215 受付期限の不正な値（${JSON.stringify(v)}）は 400`, b.status === 400, b.status)
    }
    const n = await admin.put('/api/admin/settings/corrections', { deadline_days: null })
    const g3 = must(await admin.get('/api/admin/settings/corrections'), 'corrections settings')
    ok('#215 null で期限なしに戻せる', n.status === 200 && g3.deadline_days == null, g3)
    if (before != null) await admin.put('/api/admin/settings/corrections', { deadline_days: before })
  }
}

// ---------- #359 空の案件・クライアントの削除 ----------
{
  const E = must(await admin.post('/api/admin/projects', { project_name: `${PFX}-空の案件`, allow_duplicate: true }), 'empty project').project_id
  const d = await admin.del(`/api/admin/projects/${E}`)
  const ready = !routeMissing(d)
  pend('#359 シフト・日報のない案件は削除できる', ready, d.status === 200, d)
  if (ready) {
    const gone = await admin.get(`/api/admin/projects/${E}`)
    ok('#359 削除した案件は見つからない', gone.status === 404, gone.status)
    const used = await admin.del(`/api/admin/projects/${P}`)
    ok('#359 シフト・日報がある案件は 409 で理由を返し、削除しない', used.status === 409 && used.data && used.data.error && (await admin.get(`/api/admin/projects/${P}`)).status === 200, used)
  }
  const C = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-空のクライアント` }), 'client').client_id
  const dc = await admin.del(`/api/admin/clients/${C}`)
  const readyC = !routeMissing(dc)
  pend('#359 案件のないクライアントは削除できる', readyC, dc.status === 200, dc)
  if (readyC) {
    const C2 = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-案件ありのクライアント` }), 'client2').client_id
    must(await admin.post('/api/admin/projects', { project_name: `${PFX}-クライアントの案件`, client_id: C2, allow_duplicate: true }), 'project of client')
    const used = await admin.del(`/api/admin/clients/${C2}`)
    ok('#359 案件があるクライアントは 409 で理由を返し、削除しない', used.status === 409 && used.data && used.data.error && (await admin.get(`/api/admin/clients/${C2}`)).status === 200, used)
  }
}

const failed = results.filter(r => !r.pass)
const pended = results.filter(r => r.pend)
console.log(`\n${results.length - failed.length}/${results.length} passed${pended.length ? `（うち PEND ${pended.length}件）` : ''}`)
process.exit(failed.length ? 1 : 0)
