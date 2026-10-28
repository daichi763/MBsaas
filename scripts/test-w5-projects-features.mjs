// 案件の編集・終了、企業の日報テンプレート、スタッフ評価（w5-projects-features: #153 #164 #165）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8814 node scripts/test-w5-projects-features.mjs
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
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const thisMonth = today.slice(0, 7)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const addMonths = (ym, n) => { const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7) }

const PFX = 'PF' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
// 2 社目（B 社）
const codeB = 'pf' + PFX.toLowerCase(), pwB = 'Pf-Passw0rd-' + PFX
must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: codeB, company_name: `案件機能B社${PFX}`, admin_code: 'adminb', admin_password: pwB, admin_name: 'B社 管理者' }), 'company B')
const adminB = client(await login(codeB, 'adminb', pwB))

const projectsOf = async (api) => must(await api.get('/api/admin/projects'), 'projects').projects
const detailOf = async (pid) => must(await admin.get('/api/admin/projects/' + pid), 'project detail').project

// ================= #153 案件の編集・終了 =================
const name = `${PFX}-案件`
must(await admin.post('/api/admin/projects', { project_name: name, location: '新宿', manual_text: '集合は9:45', requirements: '接客' }), 'create project')
const pid = (await projectsOf(admin)).find(p => p.project_name === name).project_id
{
  const p = await detailOf(pid)
  ok('#153 登録でマニュアル・注意事項を保存できる', p.manual_text === '集合は9:45', p)
  const r = await admin.put('/api/admin/projects/' + pid, { project_name: name + '改', location: '渋谷', manual_text: '集合は10:00\n制服あり', required_skills: 'MNP、光回線', show_performance: false, memo: 'メモ' })
  const q = await detailOf(pid)
  ok('#153 案件名・場所・マニュアル・必要スキル・実績表示・メモを編集できる', r.status === 200 && q.project_name === name + '改' && q.location === '渋谷'
    && q.manual_text === '集合は10:00\n制服あり' && q.required_skills === 'MNP,光回線' && q.show_performance === 0 && q.memo === 'メモ', [r, q])
  const clr = await admin.put('/api/admin/projects/' + pid, { location: '' })
  ok('#153 空欄で保存すると消える（送らなかった項目はそのまま）', clr.status === 200 && (await detailOf(pid)).location === null && (await detailOf(pid)).manual_text === '集合は10:00\n制服あり', clr)
  ok('#153 案件名を空にはできない（400）', (await admin.put('/api/admin/projects/' + pid, { project_name: '  ' })).status === 400)
  ok('#153 業務種別は選択肢のみ（400）', (await admin.put('/api/admin/projects/' + pid, { project_type: 'xxx' })).status === 400)
  ok('#153 長すぎるマニュアルは 400', (await admin.put('/api/admin/projects/' + pid, { manual_text: 'あ'.repeat(5001) })).status === 400)
  ok('#153 存在しない案件は 404', (await admin.put('/api/admin/projects/99999999', { project_name: 'x' })).status === 404)
  ok('#153 他社の案件は編集できない（404）', (await adminB.put('/api/admin/projects/' + pid, { project_name: '乗っ取り' })).status === 404)
  ok('#153 他社の案件の名前は変わっていない', (await detailOf(pid)).project_name === name + '改')
  // B 社のクライアントは指定できない
  must(await adminB.post('/api/admin/clients', { client_name: `B社取引先${PFX}` }), 'client B')
  const clB = must(await adminB.get('/api/admin/clients'), 'clients B').clients.find(c => c.client_name === `B社取引先${PFX}`)
  ok('#153 他社のクライアントは指定できない（400）', (await admin.put('/api/admin/projects/' + pid, { client_id: clB.client_id })).status === 400)
  // 同名の確認
  const other = `${PFX}-別案件`
  must(await admin.post('/api/admin/projects', { project_name: other }), 'other project')
  const dup = await admin.put('/api/admin/projects/' + pid, { project_name: other })
  ok('#153 稼働中の別の案件と同じ名前にすると確認を求める（409 confirm_duplicate）', dup.status === 409 && dup.data.confirm_duplicate, dup)
  ok('#153 確認済みなら同じ名前にできる', (await admin.put('/api/admin/projects/' + pid, { project_name: other, allow_duplicate: true })).status === 200)
  must(await admin.put('/api/admin/projects/' + pid, { project_name: name }), 'rename back')
}
{
  // 今日以降のシフトがある案件の終了は確認を求める
  const d = addDays(today, 20)
  const s = await admin.post('/api/admin/shifts', { staff_id: 1, project_id: pid, work_date: d, start_time: '10:00', end_time: '18:00', memo: PFX + '-S', confirm_warnings: true })
  ok('（前提）稼働中の案件にシフトを登録できる', s.status === 200, s)
  const c1 = await admin.put('/api/admin/projects/' + pid, { status: 'closed' })
  ok('#153 今日以降のシフトがある案件の終了は確認を求める（409 confirm_close）', c1.status === 409 && c1.data.confirm_close && c1.data.future_shifts >= 1, c1)
  ok('#153 確認前は終了になっていない', (await detailOf(pid)).status === 'active')
  ok('#153 状態は active / closed のみ（400）', (await admin.put('/api/admin/projects/' + pid, { status: 'deleted' })).status === 400)
  const c2 = await admin.put('/api/admin/projects/' + pid, { status: 'closed', confirm_close: true })
  const p = await detailOf(pid)
  ok('#153 確認済みなら終了できる（終了日時を残す）', c2.status === 200 && p.status === 'closed' && !!p.closed_at, [c2, p])
  const kept = must(await admin.get(`/api/admin/shifts?from=${d}&to=${d}`), 'shifts').shifts.some(x => x.memo === PFX + '-S' && x.status !== 'absent')
  ok('#153 終了しても既存のシフトは取り消されない', kept)
  const s2 = await admin.post('/api/admin/shifts', { staff_id: 2, project_id: pid, work_date: addDays(today, 21), start_time: '10:00', end_time: '18:00', confirm_warnings: true })
  ok('#153 終了した案件には新しいシフトを登録できない（assertAssignable で 400）', s2.status === 400 && /終了した案件/.test(s2.data.error || ''), s2)
  const dash = must(await admin.get('/api/admin/projects'), 'projects').projects.find(x => x.project_id === pid)
  ok('#153 一覧で終了の状態が分かる', dash.status === 'closed', dash)
  const r = await admin.put('/api/admin/projects/' + pid, { status: 'active' })
  const p2 = await detailOf(pid)
  ok('#153 稼働中に戻せる（終了日時は消える）', r.status === 200 && p2.status === 'active' && !p2.closed_at, [r, p2])
  const s3 = await admin.post('/api/admin/shifts', { staff_id: 2, project_id: pid, work_date: addDays(today, 21), start_time: '10:00', end_time: '18:00', confirm_warnings: true })
  ok('#153 稼働中に戻すとシフトを登録できる', s3.status === 200, s3)
}

// ================= #165 日報テンプレート =================
const tplsOf = async (api) => must(await api.get('/api/admin/templates'), 'templates').templates
const hqT1 = (await tplsOf(admin)).find(t => t.template_id === 1)
const tName = `${PFX}テンプレ`
{
  const fields = [...hqT1.fields, { key: 'extra_cnt', label: '追加の件数', type: 'number' }]
  const r = await admin.post('/api/admin/templates', { template_name: tName, fields })
  ok('#165 企業が自社のテンプレートを作成できる', r.status === 200 && r.data.template_id, r)
  const t = (await tplsOf(admin)).find(x => x.template_name === tName)
  ok('#165 自社のテンプレートは編集できる印（editable）が付き、本部のものは付かない', t && t.editable === true && t.template_type === 'custom' && hqT1.editable === false, [t, hqT1])
  ok('#165 同じ名前は 409', (await admin.post('/api/admin/templates', { template_name: tName, fields })).status === 409)
  ok('#165 キーが不正な項目は 400', (await admin.post('/api/admin/templates', { template_name: tName + 'x', fields: [{ key: '1bad', label: 'x', type: 'number' }] })).status === 400)
  ok('#165 本部のテンプレートは企業から編集できない（404）', (await admin.put('/api/admin/templates/1', { template_name: '改ざん' })).status === 404)
  ok('#165 他社のテンプレートは編集できない（404）', (await adminB.put('/api/admin/templates/' + t.template_id, { template_name: '改ざん' })).status === 404)
  ok('#165 他社のテンプレートは一覧に出ない', !(await tplsOf(adminB)).some(x => x.template_id === t.template_id))
  // 日報のない状態なら、項目を自由に消せる
  const noRep = await admin.put('/api/admin/templates/' + t.template_id, { fields: fields.filter(f => f.key !== 'card') })
  ok('#165 日報のないテンプレートは項目を削除できる', noRep.status === 200, noRep)
  must(await admin.put('/api/admin/templates/' + t.template_id, { fields }), 'restore fields')

  // 日報のある案件（seed の案件1）に付けると、値の入った項目は消せない
  const ch = await admin.put('/api/admin/projects/1', { report_template_id: t.template_id })
  ok('#153 日報がある案件のテンプレートの変更は確認を求める（409 confirm_template_change）', ch.status === 409 && ch.data.confirm_template_change, ch)
  must(await admin.put('/api/admin/projects/1', { report_template_id: t.template_id, confirm_template_change: true }), 'set template on project 1')
  const t2 = (await tplsOf(admin)).find(x => x.template_id === t.template_id)
  ok('#165 使用中の案件の数と日報の有無を返す', t2.project_count >= 1 && t2.has_reports == 1, t2)
  const rm = await admin.put('/api/admin/templates/' + t.template_id, { fields: fields.filter(f => f.key !== 'seiyaku') })
  ok('#165 値が入った日報がある項目は削除できない（400）', rm.status === 400 && /seiyaku/.test(rm.data.error || ''), rm)
  const sw = await admin.put('/api/admin/templates/' + t.template_id, { fields: fields.map(f => f.key === 'seiyaku' ? { ...f, type: 'text' } : f) })
  ok('#165 値が入った日報がある項目は数値とテキストを切り替えられない（400）', sw.status === 400, sw)
  const rmUnused = await admin.put('/api/admin/templates/' + t.template_id, { fields: fields.filter(f => f.key !== 'extra_cnt') })
  ok('#165 値の入っていない項目は、日報があっても削除できる', rmUnused.status === 200, rmUnused)
  const ren = await admin.put('/api/admin/templates/' + t.template_id, { template_name: tName, fields: [{ key: 'new_item', label: '新しい項目', type: 'number' }, ...fields.filter(f => f.key !== 'extra_cnt').map(f => f.key === 'seiyaku' ? { ...f, label: '成約（改）', required: true } : f)] })
  const t3 = (await tplsOf(admin)).find(x => x.template_id === t.template_id)
  ok('#165 表示名・順序・必須の変更と項目の追加はできる', ren.status === 200 && t3.fields[0].key === 'new_item' && t3.fields.find(f => f.key === 'seiyaku').label === '成約（改）', [ren, t3 && t3.fields.slice(0, 2)])
  // 配信停止: 新しい案件・他の案件では選べないが、使っている案件はそのまま
  must(await admin.put('/api/admin/templates/' + t.template_id, { status: 'stopped' }), 'stop')
  const np = await admin.post('/api/admin/projects', { project_name: `${PFX}-停止テンプレ案件`, report_template_id: t.template_id })
  ok('#165 配信停止のテンプレートは新しい案件で選べない（400）', np.status === 400, np)
  const op = await admin.put('/api/admin/projects/' + pid, { report_template_id: t.template_id })
  ok('#165 配信停止のテンプレートは案件の編集でも選べない（400）', op.status === 400, op)
  ok('#165 使っている案件はそのまま（ほかの項目を保存できる）', (await admin.put('/api/admin/projects/1', { report_template_id: t.template_id, memo: 'x' })).status === 200)
  ok('#165 状態は active / stopped のみ（400）', (await admin.put('/api/admin/templates/' + t.template_id, { status: 'deleted' })).status === 400)
  must(await admin.put('/api/admin/templates/' + t.template_id, { status: 'active' }), 'resume')
  // 案件1を元のテンプレートに戻す
  must(await admin.put('/api/admin/projects/1', { report_template_id: 1, memo: null, confirm_template_change: true }), 'restore project 1')
  ok('（後始末）案件1のテンプレートを元に戻した', (await detailOf(1)).report_template_id === 1)
}
{
  // 本部: 既存のテンプレートの修正・配信停止
  ok('#165 企業の管理者は本部のテンプレート API を使えない（403）', (await admin.put('/api/hq/templates/1', { template_name: 'x' })).status === 403)
  const list = must(await hq.get('/api/hq/templates'), 'hq templates').templates
  const h1 = list.find(t => t.template_id === 1)
  ok('#165 本部の一覧に状態・使用中の案件数・日報の有無を返す', h1 && h1.status === 'active' && h1.project_count >= 1 && h1.has_reports == 1, h1)
  const rm = await hq.put('/api/hq/templates/1', { fields: h1.fields.filter(f => f.key !== 'mnp') })
  ok('#165 本部も、値が入った日報がある項目は削除できない（400）', rm.status === 400, rm)
  const lbl = await hq.put('/api/hq/templates/1', { fields: h1.fields.map(f => f.key === 'mnp' ? { ...f, label: 'MNP件数（改）' } : f) })
  const after = must(await hq.get('/api/hq/templates'), 'hq templates').templates.find(t => t.template_id === 1)
  ok('#165 本部は既存のテンプレートの表示名を直せる', lbl.status === 200 && after.fields.find(f => f.key === 'mnp').label === 'MNP件数（改）', lbl)
  must(await hq.put('/api/hq/templates/1', { fields: h1.fields }), 'restore hq template 1')
  const hn = `${PFX}本部テンプレ`
  must(await hq.post('/api/hq/templates', { template_name: hn, fields: [{ key: 'calls', label: '架電数', type: 'number' }] }), 'hq create')
  const ht = must(await hq.get('/api/hq/templates'), 'hq templates').templates.find(t => t.template_name === hn)
  ok('#165 本部のテンプレート名の重複は 409', (await hq.put('/api/hq/templates/' + ht.template_id, { template_name: '携帯ショップ稼働テンプレート' })).status === 409)
  must(await hq.put('/api/hq/templates/' + ht.template_id, { status: 'stopped' }), 'hq stop')
  const np = await admin.post('/api/admin/projects', { project_name: `${PFX}-本部停止`, report_template_id: ht.template_id })
  ok('#165 本部が配信停止にしたテンプレートは企業の新しい案件で選べない', np.status === 400, np)
  must(await hq.put('/api/hq/templates/' + ht.template_id, { status: 'active' }), 'hq resume')
  const np2 = await admin.post('/api/admin/projects', { project_name: `${PFX}-本部再開`, report_template_id: ht.template_id })
  ok('#165 配信を再開すると選べる', np2.status === 200, np2)
  const ct = (await tplsOf(admin)).find(x => x.template_name === tName)
  const hqFix = await hq.put('/api/hq/templates/' + ct.template_id, { template_name: tName + '（本部修正）' })
  ok('#165 本部は企業独自のテンプレートも直せる', hqFix.status === 200 && (await tplsOf(admin)).some(x => x.template_name === tName + '（本部修正）'), hqFix)
}

// ================= #164 スタッフ評価 =================
{
  must(await admin.post('/api/admin/staff', { user_code: `${PFX}EV`, name: `${PFX} 評価`, password: 'pass1234' }), 'staff')
  const sid = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}EV`).staff_id
  const score = async () => Number(must(await admin.get('/api/admin/staff/' + sid), 'staff detail').profile.evaluation_score)
  const evals = async () => must(await admin.get('/api/admin/staff/' + sid), 'staff detail').evaluations
  ok('#164 評価のないスタッフの総合評価は 0（未評価）', (await score()) === 0)
  const body = (period, n, comment) => ({ evaluation_period: period, attendance_score: n, report_score: n, performance_score: n, client_score: n, growth_score: n, retention_score: n, comment })
  const r1 = await admin.post(`/api/admin/staff/${sid}/evaluations`, { ...body(thisMonth, 4), retention_score: 1, comment: '良好' })
  ok('#164 評価を登録すると総合評価が6項目の平均になる', r1.status === 200 && r1.data.evaluation_score === 3.5 && (await score()) === 3.5, r1)
  const e1 = await evals()
  ok('#164 スタッフ詳細に評価と評価者が出る', e1.length === 1 && e1[0].evaluator_name && e1[0].comment === '良好', e1)
  const r2 = await admin.post(`/api/admin/staff/${sid}/evaluations`, body(thisMonth, 2))
  const e2 = await evals()
  ok('#164 同じ期間は上書き（1件のまま）', r2.status === 200 && r2.data.updated === true && e2.length === 1 && e2[0].attendance_score === 2 && (await score()) === 2, [r2, e2])
  const prev = addMonths(thisMonth, -1)
  const r3 = await admin.post(`/api/admin/staff/${sid}/evaluations`, body(prev, 5))
  ok('#164 過去の期間を足しても、総合評価は最新の期間の平均のまま', r3.status === 200 && (await score()) === 2, r3)
  ok('#164 推移は新しい期間から並ぶ', (await evals()).map(e => e.evaluation_period).join() === [thisMonth, prev].join())
  ok('#164 1〜5 以外は 400', (await admin.post(`/api/admin/staff/${sid}/evaluations`, body(thisMonth, 6))).status === 400)
  ok('#164 期間の形式が違えば 400', (await admin.post(`/api/admin/staff/${sid}/evaluations`, body('2026/10', 3))).status === 400)
  ok('#164 2か月以上先の期間は 400', (await admin.post(`/api/admin/staff/${sid}/evaluations`, body(addMonths(thisMonth, 2), 3))).status === 400)
  ok('#164 コメントが長すぎれば 400', (await admin.post(`/api/admin/staff/${sid}/evaluations`, body(thisMonth, 3, 'あ'.repeat(1001)))).status === 400)
  ok('#164 他社のスタッフには登録できない（404）', (await adminB.post(`/api/admin/staff/${sid}/evaluations`, body(thisMonth, 3))).status === 404)
  const latest = (await evals()).find(e => e.evaluation_period === thisMonth)
  ok('#164 他社からは削除できない（404）', (await adminB.del(`/api/admin/staff/${sid}/evaluations/${latest.evaluation_id}`)).status === 404)
  const d1 = await admin.del(`/api/admin/staff/${sid}/evaluations/${latest.evaluation_id}`)
  ok('#164 最新の評価を消すと、次に新しい期間の平均になる', d1.status === 200 && d1.data.evaluation_score === 5 && (await score()) === 5, d1)
  const rest = (await evals())[0]
  const d2 = await admin.del(`/api/admin/staff/${sid}/evaluations/${rest.evaluation_id}`)
  ok('#164 評価をすべて消すと未評価（0）に戻る', d2.status === 200 && (await score()) === 0, d2)
  ok('#164 消した評価をもう一度消すと 404', (await admin.del(`/api/admin/staff/${sid}/evaluations/${rest.evaluation_id}`)).status === 404)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
