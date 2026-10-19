// w4-admin-lists（#197 #257 #307 #345 #381 #432 #433 #450 #463 #489 #490 #537 #550 #556）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8819 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（テスト用のデータをローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8819 PERSIST=<保存先> node scripts/test-w4-admin-lists.mjs
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8819'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
// テストの途中で d1 execute を待つ間に、使い回しの接続が切られることがあるので、接続の失敗は1回だけやり直す
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts) } catch (e) { return fetch(url, opts) }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetchRetry(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  // 開発サーバーが D1 を使っている間は、まれに internal error になるので数回やり直す
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const todayJST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const monthOf = (d) => d.slice(0, 7)

await waitServer()
const admin = client(await login('sample', 'admin'))
const today = todayJST(); const yesterday = addDays(today, -1)

// ---------- テスト用のデータ ----------
// 代打だけで入った日が最終稼働になるか: 昨日・今日にシフトのない人に、昨日の代打シフトを足す
const [cand] = d1(`SELECT sp.staff_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = 1 AND sp.merged_into_staff_id IS NULL
  AND COALESCE(sp.employment_status,'working') != 'retired' AND us.status = 'active' AND COALESCE(sp.affiliation_type,'own_employee') != 'skillsheet_only'
  AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = sp.staff_id AND s.work_date >= '${yesterday}' AND s.status IN ('confirmed','substitute'))
  ORDER BY sp.staff_id LIMIT 1`)[0]
const subStaff = cand.staff_id
d1(`INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status) VALUES (1, ${subStaff}, 1, '${yesterday}', '10:00', '19:00', 'substitute')`)
// 退職者: 選択肢の既定から外れ、include=all では出る
const [ret] = d1(`SELECT sp.staff_id FROM staff_profiles sp WHERE sp.company_id = 1 AND sp.staff_id != ${subStaff} AND sp.merged_into_staff_id IS NULL
  AND COALESCE(sp.affiliation_type,'own_employee') != 'skillsheet_only' ORDER BY sp.staff_id DESC LIMIT 1`)[0]
const retStaff = ret.staff_id
const [{ employment_status: retOrig }] = d1(`SELECT COALESCE(employment_status,'working') AS employment_status FROM staff_profiles WHERE staff_id = ${retStaff}`)[0]
d1(`UPDATE staff_profiles SET employment_status = 'retired' WHERE staff_id = ${retStaff}`)
// 他社の案件（必要スキルの変更は自社の案件だけ）
d1(`INSERT INTO projects (company_id, project_name, project_type, status) VALUES (2, 'w4-admin-lists 他社の案件', 'other', 'active')`)
const [{ id: otherProject }] = d1(`SELECT MAX(project_id) AS id FROM projects WHERE company_id = 2`)[0]
// 書類の日時: 既定値（UTC）で保存された行を日本時間で返す
d1(`INSERT INTO client_documents (company_id, client_id, original_file_name, storage_key, mime_type, file_size, uploaded_by, uploaded_at)
  VALUES (1, 1, 'w4-al-utc.pdf', 'client-documents/1/1/w4-al/w4-al-utc.pdf', 'application/pdf', 10, 1, '2026-01-01 23:30:00')`)

try {
  // ---------- #463 名前を選ぶための軽い API ----------
  {
    const r = await admin.get('/api/admin/staff/options')
    ok('#463 GET /admin/staff/options が 200', r.status === 200 && Array.isArray(r.data.staff), r.status)
    const row = r.data.staff[0] || {}
    ok('#463 選択肢は名前などだけを返し、電話番号や集計を含まない', !('phone' in row) && !('month_days' in row) && 'name' in row && 'assignable' in row, Object.keys(row))
    ok('#463 既定では退職者を含まない', !r.data.staff.some(s => s.staff_id === retStaff))
    ok('#463 既定ではすべて割り当てられる人', r.data.staff.every(s => s.assignable === 1))
    const all = await admin.get('/api/admin/staff/options?include=all')
    ok('#463 include=all では退職者も出る（NG スタッフの選択用）', all.data.staff.some(s => s.staff_id === retStaff && s.employment_status === 'retired'))
    ok('#463 統合済み・スキルシートのみは出さない', all.data.staff.every(s => s.affiliation_type !== 'skillsheet_only'))
  }

  // ---------- #432 #433 #197 スタッフ一覧 ----------
  {
    const r = await admin.get('/api/admin/staff')
    const s = r.data.staff.find(x => x.staff_id === subStaff)
    ok('#432 代打のシフトも最終稼働に入る', s && s.last_work_date === yesterday, s && s.last_work_date)
    ok('#432 今月稼働は日数で数える（代打を含む）', s && (monthOf(yesterday) === monthOf(today) ? s.month_days >= 1 : true), s && s.month_days)
    const rr = r.data.staff.find(x => x.staff_id === retStaff)
    ok('#197 一覧APIは在籍状況を返す（画面で退職者を分けて表示する）', rr && rr.employment_status === 'retired' && 'status' in rr, rr && rr.employment_status)
  }

  // ---------- #381 離職リスク ----------
  {
    const bad = await admin.put('/api/admin/staff/' + subStaff, { retention_risk: 'extreme' })
    ok('#381 low/mid/high 以外は 400', bad.status === 400, bad)
    const good = await admin.put('/api/admin/staff/' + subStaff, { retention_risk: 'mid' })
    ok('#381 中にできる', good.status === 200, good)
    const d = await admin.get('/api/admin/staff/' + subStaff)
    ok('#381 詳細に反映される', d.data.profile.retention_risk === 'mid', d.data.profile.retention_risk)
    await admin.put('/api/admin/staff/' + subStaff, { retention_risk: 'low' })
  }

  // ---------- #550 月次実績推移 ----------
  {
    const d = await admin.get('/api/admin/staff/' + subStaff)
    const perf = d.data.performance
    const m0 = monthOf(today)
    ok('#550 月次実績推移は今月から3か月を新しい順に返す', Array.isArray(perf) && perf.length === 3 && perf[0].ym === m0 && perf[1].ym < perf[0].ym && perf[2].ym < perf[1].ym, perf && perf.map(p => p.ym))
    ok('#550 日報のない月も0の行で返す', perf.every(p => typeof p.days === 'number'), perf)
  }

  // ---------- #450 案件の月の切り替え・#489 商談の合計 ----------
  {
    const old = await admin.get('/api/admin/projects?month=2001-01')
    ok('#450 案件一覧は ?month を受け取る', old.status === 200 && old.data.month === '2001-01' && old.data.projects.every(p => !p.month_shifts), old.data && old.data.month)
    const bad = await admin.get('/api/admin/projects?month=2026-13')
    ok('#450 形式の違う月は今月にする', bad.data.month === monthOf(today), bad.data.month)
    const cur = await admin.get('/api/admin/projects')
    ok('#450 月の指定がなければ今月', cur.data.month === monthOf(today))
    const pd = await admin.get('/api/admin/projects/1?month=2001-01')
    ok('#450 案件詳細も ?month を受け取る', pd.status === 200 && pd.data.month === '2001-01' && pd.data.staff_performance.length === 0, pd.data && pd.data.month)
    const pdNow = await admin.get('/api/admin/projects/1')
    ok('#489 案件詳細のスタッフ別実績に商談の合計がある（成約率の計算用）', pdNow.data.staff_performance.every(s => 'shodan' in s), pdNow.data.staff_performance[0])
  }

  // ---------- #556 必要スキル ----------
  {
    const name = 'w4-admin-lists 案件 ' + Date.now()
    const c = await admin.post('/api/admin/projects', { project_name: name, required_skills: ' MNP、光回線，接客 ,MNP' })
    ok('#556 案件登録で必要スキルを送れる', c.status === 200 && c.data.project_id, c)
    const [{ required_skills: saved }] = d1(`SELECT required_skills FROM projects WHERE project_id = ${Number(c.data.project_id)}`)[0]
    ok('#556 読点・全角カンマを半角カンマにそろえ、重複を除いて保存する', saved === 'MNP,光回線,接客', saved)
    const u = await admin.put(`/api/admin/projects/${c.data.project_id}/required-skills`, { required_skills: 'クロージング、PI' })
    ok('#556 必要スキルを後から変えられる', u.status === 200 && u.data.required_skills === 'クロージング,PI', u.data)
    const cl = await admin.put(`/api/admin/projects/${c.data.project_id}/required-skills`, { required_skills: '' })
    ok('#556 空欄にすると消える', cl.status === 200 && cl.data.required_skills === null, cl.data)
    const other = await admin.put(`/api/admin/projects/${otherProject}/required-skills`, { required_skills: 'MNP' })
    ok('#556 他社の案件は変えられない（404）', other.status === 404, other.status)
    const [{ required_skills: otherSkills }] = d1(`SELECT required_skills FROM projects WHERE project_id = ${otherProject}`)[0]
    ok('#556 他社の案件の値は変わらない', otherSkills === null, otherSkills)
    const long = await admin.put(`/api/admin/projects/${c.data.project_id}/required-skills`, { required_skills: 'あ'.repeat(501) })
    ok('#556 長すぎる値は 400', long.status === 400, long.status)
    d1(`UPDATE projects SET status = 'ended' WHERE project_id = ${Number(c.data.project_id)}`)
  }

  // ---------- #307 クライアント情報の編集 ----------
  {
    const before = await admin.get('/api/admin/clients/3')
    const orig = before.data.client
    const u = await admin.put('/api/admin/clients/3', { contact_name: '片山 太郎 様', phone: '03-0000-9999', email: 'new@bba.example.jp', address: '東京都渋谷区1-2-3', contract_type: '派遣', billing_rule: '20日締め', client_rating: 5 })
    ok('#307 担当者・電話・メール・住所・契約形態・請求条件・評価を保存できる', u.status === 200, u)
    const after = (await admin.get('/api/admin/clients/3')).data.client
    ok('#307 保存した値が詳細に出る', after.contact_name === '片山 太郎 様' && after.phone === '03-0000-9999' && after.email === 'new@bba.example.jp' && after.address === '東京都渋谷区1-2-3'
      && after.contract_type === '派遣' && after.billing_rule === '20日締め' && after.client_rating === 5, after)
    const bad = await admin.put('/api/admin/clients/3', { email: 'not-an-email' })
    ok('#307 メールの形式が違うと 400', bad.status === 400, bad)
    const clear = await admin.put('/api/admin/clients/3', { address: '' })
    ok('#307 空欄にすると消せる', clear.status === 200 && (await admin.get('/api/admin/clients/3')).data.client.address === null)
    const badStream = await admin.put('/api/admin/clients/3', { stream_type: 'sideways' })
    ok('#307 上流・下流以外の区分は 400', badStream.status === 400, badStream.status)
    await admin.put('/api/admin/clients/3', { contact_name: orig.contact_name, phone: orig.phone, email: orig.email, address: orig.address, contract_type: orig.contract_type, billing_rule: orig.billing_rule, client_rating: orig.client_rating })
    const newName = 'w4-admin-lists クライアント ' + Date.now()
    const badPost = await admin.post('/api/admin/clients', { client_name: newName, email: 'x@' })
    ok('#307 登録でもメールの形式を確かめる', badPost.status === 400, badPost.status)
    const post = await admin.post('/api/admin/clients', { client_name: newName, email: 'ok@example.jp', address: '大阪府大阪市1-1' })
    const [row] = d1(`SELECT email, address FROM clients WHERE client_id = ${Number(post.data && post.data.client_id)}`)[0]
    ok('#307 登録でメールと住所を保存できる', post.status === 200 && row && row.email === 'ok@example.jp' && row.address === '大阪府大阪市1-1', row)
  }

  // ---------- #345 #490 クライアントの取引の実績・一覧 ----------
  {
    const d = await admin.get('/api/admin/clients/1')
    ok('#345 クライアント詳細が案件の一覧を返す（終了した案件を含む）', Array.isArray(d.data.projects) && d.data.projects.length >= 1 && d.data.projects.every(p => 'status' in p && 'shifts' in p && 'bill_total' in p && 'reports' in p && 'incidents' in p), d.data.projects && d.data.projects[0])
    ok('#345 6か月の月別推移を返す（最後が選んだ月）', Array.isArray(d.data.trend) && d.data.trend.length === 6 && d.data.trend[5].ym === monthOf(today), d.data.trend)
    const [{ n }] = d1(`SELECT COUNT(*) AS n FROM projects WHERE client_id = 1 AND company_id = 1`)[0]
    ok('#345 そのクライアントの全案件が出る', d.data.projects.length === n, { got: d.data.projects.length, n })
    const sumShifts = d.data.projects.reduce((a, p) => a + p.shifts, 0)
    const [{ n: expectShifts }] = d1(`SELECT COUNT(*) AS n FROM shifts s JOIN projects p ON p.project_id = s.project_id WHERE p.client_id = 1 AND s.company_id = 1
      AND s.work_date >= '${monthOf(today)}-01' AND s.work_date <= '${today}' AND s.status IN ('confirmed','substitute')`)[0]
    ok('#345 今月の稼働件数（今日まで・確定と代打）が合う', sumShifts === expectShifts, { sumShifts, expectShifts })
    ok('#345 月別推移の今月の件数も同じ', d.data.trend[5].shifts === expectShifts, d.data.trend[5])
    const old = await admin.get('/api/admin/clients/1?month=2001-01')
    ok('#345 ?month で月を選べる', old.data.month === '2001-01' && old.data.trend[5].ym === '2001-01' && old.data.projects.every(p => p.shifts === 0), old.data.month)
    const list = await admin.get('/api/admin/clients')
    const c1 = list.data.clients.find(c => c.client_id === 1)
    ok('#490 クライアント一覧は稼働中と全体の案件数を返す（並べ替え用）', c1 && typeof c1.active_project_count === 'number' && c1.project_count >= c1.active_project_count, c1)
  }

  // ---------- #257 書類の日時 ----------
  {
    const r = await admin.get('/api/admin/clients/1/documents')
    const doc = (r.data.documents || []).find(x => x.original_file_name === 'w4-al-utc.pdf')
    ok('#257 書類のアップロード日時を日本時間で返す（UTC 23:30 → 翌日 8:30）', doc && doc.uploaded_at === '2026-01-02 08:30:00', doc)
    const s = await admin.get('/api/admin/staff/1/documents')
    ok('#257 スタッフの書類一覧も 200', s.status === 200 && Array.isArray(s.data.documents))
  }

  // ---------- #550 実績分析（月の範囲の条件に変えても同じ集計） ----------
  {
    const a = await admin.get('/api/admin/analytics?month=' + monthOf(today))
    const [{ n }] = d1(`SELECT COUNT(*) AS n FROM daily_reports WHERE company_id = 1 AND work_date LIKE '${monthOf(today)}%'`)[0]
    ok('#212 実績分析の日報数が LIKE で数えた件数と同じ', a.status === 200 && (a.data.totals.reports || 0) === n, { got: a.data.totals && a.data.totals.reports, n })
  }

  // ---------- 画面のスクリプト ----------
  {
    const js = await (await fetchRetry(`${BASE}/static/admin.js`)).text()
    ok('#463 シフト登録・NGスタッフは軽いAPIを使う', js.includes("/api/admin/staff/options") && !js.includes("axios.get('/api/admin/staff'), axios.get('/api/admin/projects')"))
    ok('#537 スタッフ一覧の絞り込みを onclick の文字列に埋め込まない', !js.includes(`onclick="drawStaffTable('`))
    const sb = await (await fetchRetry(`${BASE}/static/shift-board.js`)).text()
    ok('#463 シフトボードも軽いAPIを使う', sb.includes('/api/admin/staff/options') && !sb.includes("axios.get('/api/admin/staff')])"))
  }
} finally {
  d1(`UPDATE staff_profiles SET employment_status = '${retOrig}' WHERE staff_id = ${retStaff}`)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
