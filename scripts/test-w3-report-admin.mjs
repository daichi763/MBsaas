// 管理画面の日報一覧の統合テスト（w3-report-admin: #106 #113 #183 #360 #404、持ち越し #16 #521）
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8799 node scripts/test-w3-report-admin.mjs
// テストのたびに DB を作り直すこと（確認済み・コメントを書き換えるため）

const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`) }

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
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
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)

const admin = client(await login('sample', 'admin'))
const st8 = client(await login('sample', 'st008')) // staff_id 8
const list = async (q) => (await admin.get('/api/admin/daily-reports' + (q ? '?' + q : '')))

// ---------- #113 ページ送りと総件数、#521 生の report_values を返さない ----------
{
  const p1 = await list('limit=10&offset=0'), p2 = await list('limit=10&offset=10')
  ok('一覧を取得できる', p1.status === 200 && p2.status === 200, [p1.status, p2.status])
  ok('#113 総件数（total）が1ページの件数より多い', p1.data.total > 10 && p1.data.reports.length === 10 && p1.data.counts.all === p1.data.total, { total: p1.data.total, n: p1.data.reports.length })
  const ids1 = new Set(p1.data.reports.map(r => r.daily_report_id))
  ok('#113 2ページ目は1ページ目と重ならない', p2.data.reports.length > 0 && p2.data.reports.every(r => !ids1.has(r.daily_report_id)), p2.data.reports.map(r => r.daily_report_id))
  const all = []
  for (let off = 0; off < p1.data.total; off += 200) all.push(...(await list(`limit=200&offset=${off}`)).data.reports)
  ok('#113 ページを順に送ると、全件を重複なく取得できる', all.length === p1.data.total && new Set(all.map(r => r.daily_report_id)).size === all.length, { got: all.length, total: p1.data.total })
  ok('#113 limit の上限は200', (await list('limit=1000')).data.limit === 200)
  ok('#521 生の report_values を返さず、values だけを返す', p1.data.reports.every(r => !('report_values' in r) && r.values && typeof r.values === 'object'), Object.keys(p1.data.reports[0] || {}))
}

// ---------- #106 テンプレートの項目（テキスト項目を含む）を返す ----------
{
  const r = await list('project_id=1&limit=5')
  const rep = r.data.reports[0]
  const fields = rep && r.data.templates[rep.report_template_id]
  ok('#106 案件のテンプレートの項目を返す', Array.isArray(fields) && fields.length > 0, r.data.templates)
  ok('#106 テキスト項目（他社実績 other_result）も項目として返る', fields && fields.some(f => f.key === 'other_result' && f.type !== 'number' && f.label), fields)
}

// ---------- #404 案件・スタッフ・期間で絞り込む ----------
{
  const d = '2026-06-23'
  const byDate = await list(`date=${d}&limit=200`)
  ok('#404 日付で絞り込む', byDate.data.reports.length > 0 && byDate.data.reports.every(r => r.work_date === d), byDate.data.reports.map(r => r.work_date))
  const range = await list('from=2026-06-23&to=2026-06-24&limit=200')
  ok('#404 期間で絞り込む', range.data.reports.length > byDate.data.reports.length && range.data.reports.every(r => r.work_date >= '2026-06-23' && r.work_date <= '2026-06-24'), range.data.total)
  const proj = await list('project_id=2&limit=200')
  ok('#404 案件で絞り込む', proj.data.reports.length > 0 && proj.data.reports.every(r => r.project_id === 2))
  const staff = await list('staff_id=1&limit=200')
  ok('#404 スタッフで絞り込む', staff.data.reports.length > 0 && staff.data.reports.every(r => r.staff_id === 1))
  const both = await list(`project_id=1&staff_id=1&from=${d}&to=${d}`)
  ok('#404 条件を組み合わせて絞り込む', both.data.reports.length > 0 && both.data.reports.every(r => r.project_id === 1 && r.staff_id === 1 && r.work_date === d), both.data)
  ok('#404 日付の形式が正しくないと 400', (await list('from=2026-6-1')).status === 400)
  ok('#404 開始日が終了日より後だと 400', (await list('from=2026-07-01&to=2026-06-01')).status === 400)
  ok('#404 案件の指定が数字でないと 400', (await list('project_id=abc')).status === 400)
  const opt = await list('options=1&limit=1')
  ok('#404 options=1 で絞り込みの選択肢（案件・スタッフ）を返す', Array.isArray(opt.data.options?.projects) && opt.data.options.projects.length > 0 && Array.isArray(opt.data.options?.staff) && opt.data.options.staff.length > 0, opt.data.options)
  ok('#404 options を付けないときは選択肢を返さない', !('options' in (await list('limit=1')).data))
}

// ---------- #183 未確認のみ・まとめて確認済み、#360 確認済みの取消 ----------
{
  const ids = (await list('date=2026-06-23&limit=3')).data.reports.map(r => r.daily_report_id)
  for (const id of ids) await admin.put(`/api/admin/daily-reports/${id}`, { manager_checked: 0 })
  const un = await list('date=2026-06-23&unchecked=1&limit=200')
  ok('#360 確認済みを未確認に戻せる', ids.every(id => un.data.reports.some(r => r.daily_report_id === id && !r.manager_checked && r.manager_checked_by == null)), un.data.reports.map(r => [r.daily_report_id, r.manager_checked]))
  ok('#183 unchecked=1 は未確認の日報だけを返す', un.data.reports.length > 0 && un.data.reports.every(r => !r.manager_checked), un.data.reports.length)
  ok('#183 未確認の件数（counts.unchecked）が絞り込みの件数と合う', un.data.counts.unchecked === un.data.total, un.data.counts)
  const chk = await admin.post('/api/admin/daily-reports/check', { ids })
  ok('#183 まとめて確認済みにする', chk.status === 200 && chk.data.checked === ids.length, chk)
  const again = await admin.post('/api/admin/daily-reports/check', { ids })
  ok('#183 確認済みのものはもう一度確認しても変わらない', again.status === 200 && again.data.checked === 0, again)
  const after = await list('date=2026-06-23&limit=200')
  const r0 = after.data.reports.find(r => r.daily_report_id === ids[0])
  ok('#183 誰がいつ確認したかが残る', r0 && r0.manager_checked === 1 && r0.manager_checked_by_name === '出井 代表' && r0.manager_checked_at, r0)
  ok('#183 空の ids は 400', (await admin.post('/api/admin/daily-reports/check', { ids: [] })).status === 400)
  ok('#183 201件以上は 400', (await admin.post('/api/admin/daily-reports/check', { ids: Array.from({ length: 201 }, (_, i) => i + 1) })).status === 400)
  ok('確認の状態が不正だと 400', (await admin.put(`/api/admin/daily-reports/${ids[0]}`, { manager_checked: 'yes' })).status === 400)
  ok('変更する項目がないと 400', (await admin.put(`/api/admin/daily-reports/${ids[0]}`, {})).status === 400)
  ok('存在しない日報は 404', (await admin.put('/api/admin/daily-reports/99999999', { manager_checked: 1 })).status === 404)
  const flagged = await list('flagged=1&limit=200')
  ok('#183 flagged=1 はインシデント・クレームの日報だけを返す', flagged.status === 200 && flagged.data.reports.every(r => r.incident_flag || r.complaint_flag) && flagged.data.total === flagged.data.counts.flagged, flagged.data.counts)
}

// ---------- #360 コメントの編集・削除と、ほかの管理者の変更を黙って上書きしない ----------
{
  const id = (await list('date=2026-06-24&limit=1')).data.reports[0].daily_report_id
  const get = async () => (await list('date=2026-06-24&limit=200')).data.reports.find(r => r.daily_report_id === id)
  let r = await admin.put(`/api/admin/daily-reports/${id}`, { manager_comment: '  1行目\n2行目  ' })
  let row = await get()
  ok('#360 コメントを保存し、書いた人と日時が残る（改行は保つ）', r.status === 200 && row.manager_comment === '1行目\n2行目' && row.manager_comment_by_name === '出井 代表' && row.manager_comment_at, row)
  r = await admin.put(`/api/admin/daily-reports/${id}`, { manager_comment: '別の内容', expected_comment: '古い内容' })
  ok('#360 開いたときの内容と今の内容が違うと 409 で書かない', r.status === 409 && r.data.current_comment === '1行目\n2行目' && (await get()).manager_comment === '1行目\n2行目', r)
  r = await admin.put(`/api/admin/daily-reports/${id}`, { manager_comment: '追記しました', expected_comment: '1行目\n2行目' })
  ok('#360 今の内容を確かめたうえで編集できる', r.status === 200 && (await get()).manager_comment === '追記しました', r)
  r = await admin.put(`/api/admin/daily-reports/${id}`, { manager_comment: '', expected_comment: '追記しました' })
  row = await get()
  ok('#360 空にして保存するとコメントを削除する', r.status === 200 && row.manager_comment == null && row.manager_comment_by == null && row.manager_comment_at == null, row)
  ok('#360 コメントが文字列でないと 400', (await admin.put(`/api/admin/daily-reports/${id}`, { manager_comment: 123 })).status === 400)
  ok('#360 2000文字を超えるコメントは 400', (await admin.put(`/api/admin/daily-reports/${id}`, { manager_comment: 'あ'.repeat(2001) })).status === 400)
  r = await admin.put(`/api/admin/daily-reports/${id}`, { manager_checked: 0 })
  ok('#360 確認済みだけを変えてもコメントは変わらない（キーのない項目は変えない）', r.status === 200 && (await get()).manager_comment == null)
}

// ---------- 持ち越し #16 確認後に修正された日報が一覧で分かる ----------
{
  const memo = 'RA-' + Date.now()
  const c = await admin.post('/api/admin/shifts', { staff_id: 8, project_id: 1, work_date: today, start_time: '00:01', end_time: '00:02', memo })
  const s = c.status === 200 ? (await admin.get(`/api/admin/shifts?from=${today}&to=${today}`)).data.shifts.find(x => x.memo === memo) : null
  if (!s) ok('シフトを作成できる', false, c)
  else {
    await st8.post('/api/staff/daily-report', { shift_id: s.shift_id, values: { mnp: 1 } })
    const find = async () => (await list(`date=${today}&staff_id=8&limit=200`)).data.reports.find(r => r.shift_id === s.shift_id)
    const before = await find()
    await admin.put(`/api/admin/daily-reports/${before.daily_report_id}`, { manager_checked: 1 })
    await st8.post('/api/staff/daily-report', { shift_id: s.shift_id, values: { mnp: 2 } })
    const after = await find()
    ok('#16 確認後にスタッフが直した日報は、未確認に戻り、修正の日時が一覧に返る', after && !after.manager_checked && after.revised_after_check_at && after.values.mnp === 2, after)
    const un = await list(`date=${today}&unchecked=1&limit=200`)
    ok('#16 確認後に直した日報は「未確認のみ」に出る', un.data.reports.some(r => r.daily_report_id === after.daily_report_id))
    // 一覧を読んだ後（as_of より後）にスタッフが出し直した日報は、見ないまま確認済みにしない
    const asOf = un.data.as_of
    ok('一覧は読んだ時刻（as_of）を返す', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(asOf || ''), asOf)
    await new Promise(res => setTimeout(res, 1100))
    await st8.post('/api/staff/daily-report', { shift_id: s.shift_id, values: { mnp: 3 } })
    const stale = await admin.put(`/api/admin/daily-reports/${after.daily_report_id}`, { manager_checked: 1, as_of: asOf })
    ok('#16 一覧を読んだ後に出し直された日報は、確認済みにすると 409 で書かない', stale.status === 409 && !(await find()).manager_checked, stale)
    const staleBulk = await admin.post('/api/admin/daily-reports/check', { ids: [after.daily_report_id], as_of: asOf })
    ok('#16 まとめて確認でも、一覧を読んだ後に出し直された日報は除く', staleBulk.status === 200 && staleBulk.data.checked === 0 && !(await find()).manager_checked, staleBulk)
    const fresh = await list(`date=${today}&staff_id=8&limit=200`)
    const okBulk = await admin.post('/api/admin/daily-reports/check', { ids: [after.daily_report_id], as_of: fresh.data.as_of })
    const checked = await find()
    ok('#16 読み直した後なら確認済みにでき、「確認後に修正あり」の印は外れる', okBulk.data.checked === 1 && checked.manager_checked === 1 && checked.revised_after_check_at == null, checked)
    await admin.put(`/api/admin/daily-reports/${after.daily_report_id}`, { manager_checked: 0 })
    ok('#16 未確認に戻しても、古い「確認後に修正あり」の印は出ない', (await find()).revised_after_check_at == null)
  }
}

// ---------- 権限 ----------
{
  // 他社の管理者は、この会社の日報を一覧・確認・コメントできない
  const tag = Date.now().toString(36).slice(-5)
  const hq = client(await login('sample', 'hq'))
  const codeB = 'ra' + tag, pwB = 'Ra-Passw0rd-' + tag
  const cr = await hq.post('/api/hq/companies', { company_code: codeB, company_name: `日報確認B社${tag}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' })
  if (cr.status !== 200) ok('（前提）B 社を作成', false, cr)
  else {
    const adminB = client(await login(codeB, 'adminb', pwB))
    const target = (await list('date=2026-06-23&limit=1')).data.reports[0]
    const lb = await adminB.get('/api/admin/daily-reports?limit=200&options=1')
    ok('他社の管理者の一覧には出ない', lb.status === 200 && lb.data.total === 0 && !lb.data.reports.some(r => r.daily_report_id === target.daily_report_id) && lb.data.options.staff.length === 0, lb.data.total)
    ok('他社の管理者はコメントできない（404）', (await adminB.put(`/api/admin/daily-reports/${target.daily_report_id}`, { manager_comment: 'x' })).status === 404)
    await admin.put(`/api/admin/daily-reports/${target.daily_report_id}`, { manager_checked: 0 })
    const bb = await adminB.post('/api/admin/daily-reports/check', { ids: [target.daily_report_id] })
    const t2 = (await list('date=2026-06-23&limit=200')).data.reports.find(r => r.daily_report_id === target.daily_report_id)
    ok('他社の管理者はまとめて確認できない', bb.status === 200 && bb.data.checked === 0 && !t2.manager_checked, bb)
  }

  ok('スタッフは日報一覧を取得できない', [401, 403].includes((await st8.get('/api/admin/daily-reports')).status))
  ok('スタッフはまとめて確認できない', [401, 403].includes((await st8.post('/api/admin/daily-reports/check', { ids: [1] })).status))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
