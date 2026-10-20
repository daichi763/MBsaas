// 本部の支援機能（作業単位 w5-hq-support: #179 #516 #293）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8828 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8828 node scripts/test-w5-hq-support.mjs
//   本番には接続しない。テストのたびに DB を作り直すこと（企業の閲覧の許可・お知らせを登録する）。
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8828'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
// cookies: Cookie ヘッダーの値の配列（Set-Cookie で受けたものを足していく）
function client(cookie) {
  const jar = new Map(cookie.split('; ').filter(Boolean).map(kv => [kv.split('=')[0], kv]))
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: [...jar.values()].join('; '), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    for (const sc of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const kv = sc.split(';')[0]; const name = kv.split('=')[0]
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || kv === `${name}=`) jar.delete(name); else jar.set(name, kv)
    }
    let data = null; const text = await r.text(); try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data, headers: r.headers }
  }
  return {
    jar,
    get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b ?? {}, h), put: (p, b, h) => call('PUT', p, b ?? {}, h), del: (p, h) => call('DELETE', p, undefined, h),
  }
}
const jstLocal = (minOffset) => new Date(Date.now() + 9 * 3600 * 1000 + minOffset * 60000).toISOString().slice(0, 16)

const hqLogin = await rawLogin('', 'hq')
if (hqLogin.status !== 200) { console.log('本部ユーザーでログインできません', hqLogin); process.exit(1) }
const hq = client(hqLogin.cookie)
const admin = client((await rawLogin('sample', 'admin')).cookie)   // 会社管理者（企業1）
const mgr = client((await rawLogin('sample', 'mgr01')).cookie)     // 現場管理者（企業1）
const other = client((await rawLogin('demo3', 'admin')).cookie)    // 別の企業（ログインできない場合は null 扱い）

// ---------- #179 伴走支援の依頼 ----------
{
  let r = await admin.post('/api/admin/support-requests', { menu: 'xxx', detail: 'a' })
  ok('#179 決められていないメニューは 400', r.status === 400, r)
  r = await admin.post('/api/admin/support-requests', { menu: 'setup', detail: '  ' })
  ok('#179 内容が空なら 400', r.status === 400, r)
  r = await mgr.post('/api/admin/support-requests', { menu: 'report_design', detail: '新しい案件の日報項目を相談したい\n2行目', preferred_at: '来週の午後', contact: '090-0000-0002' })
  ok('#179 管理者（現場管理者も）は依頼を送れる', r.status === 200 && r.data?.request_id > 0, r)
  ok('#179 本部ユーザーにメールの送信を予約する（メールアドレスのある本部ユーザー）', r.data?.mail_queued >= 1, r.data)
  const reqId = r.data?.request_id
  r = await admin.get('/api/admin/support-requests')
  ok('#179 自社の依頼の一覧に出る（メニューの選択肢も返す）', r.status === 200 && r.data.requests.some(x => x.request_id === reqId && x.status === 'open' && x.requester_name) && !!r.data.menus?.setup, r.data)
  r = await hq.get('/api/hq/support-requests')
  const row = (r.data?.requests || []).find(x => x.request_id === reqId)
  ok('#179 本部の受付一覧に、会社名・依頼者・内容付きで出る', r.status === 200 && row?.company_name && row?.requester_name === '藤田 現場長' && row?.detail.includes('日報項目') && r.data.counts.open >= 1, row)
  r = await admin.get('/api/hq/support-requests')
  ok('#179 企業の管理者は本部の受付一覧を見られない（403）', r.status === 403)
  r = await hq.put(`/api/hq/support-requests/${reqId}`, { status: 'bogus' })
  ok('#179 対応状況の値を確かめる（400）', r.status === 400, r)
  r = await hq.put(`/api/hq/support-requests/${reqId}`, { status: 'in_progress', hq_note: '来週月曜に電話' })
  ok('#179 本部が対応状況とメモを更新できる', r.status === 200, r)
  r = await admin.get('/api/admin/support-requests')
  const mine = r.data.requests.find(x => x.request_id === reqId)
  ok('#179 企業側にも対応状況が出る（本部のメモは出さない）', mine?.status === 'in_progress' && !('hq_note' in mine), mine)
  r = await hq.get('/api/hq/support-requests?status=open')
  ok('#179 状況で絞り込める', r.status === 200 && !r.data.requests.some(x => x.request_id === reqId), r.data.requests?.length)
  if (other.jar.size) {
    r = await other.get('/api/admin/support-requests')
    ok('#179 他社の依頼は見えない', r.status === 200 && !r.data.requests.some(x => x.request_id === reqId), r.data)
  }
  const page = await fetch(`${BASE}/admin`, { headers: { Cookie: [...admin.jar.values()].join('; ') } }).then(x => x.text())
  ok('#179 管理画面のボタンは架空のアドレスの alert ではなく、依頼のフォームを開く', !page.includes('example.jp') && page.includes('data-action="hqsOpenSupport"') && page.includes('/static/hq-support.js'))
}

// ---------- #516 本部からのお知らせ ----------
let annAll, annMaint, annCo2
{
  let r = await hq.post('/api/hq/announcements', { title: '', body: 'x' })
  ok('#516 タイトルがないと 400', r.status === 400, r)
  r = await hq.post('/api/hq/announcements', { title: 'メンテ', body: 'x', importance: 'maintenance' })
  ok('#516 メンテナンスは掲載終了が必須（400）', r.status === 400, r)
  r = await hq.post('/api/hq/announcements', { title: 't', body: 'x', starts_at: jstLocal(60), ends_at: jstLocal(30) })
  ok('#516 掲載終了が開始より前なら 400', r.status === 400, r)
  r = await hq.post('/api/hq/announcements', { title: 't', body: 'x', target: 'companies', company_ids: [99999] })
  ok('#516 存在しない企業は配信先にできない（400）', r.status === 400, r)
  r = await hq.post('/api/hq/announcements', { title: '新機能のご案内', body: '日報テンプレートが<b>使えます</b>', importance: 'normal', target: 'all' })
  ok('#516 全企業へのお知らせを作れる', r.status === 200, r); annAll = r.data?.announcement_id
  r = await hq.post('/api/hq/announcements', { title: '夜間メンテナンス', body: '10/30 2:00-4:00 停止します', importance: 'maintenance', target: 'plan', target_plan: 'standard', ends_at: jstLocal(24 * 60) })
  ok('#516 プラン別（期限付き）のお知らせを作れる', r.status === 200, r); annMaint = r.data?.announcement_id
  r = await hq.post('/api/hq/announcements', { title: '企業2だけ', body: 'x', target: 'companies', company_ids: [2] })
  annCo2 = r.data?.announcement_id
  r = await hq.post('/api/hq/announcements', { title: '予約のお知らせ', body: 'x', starts_at: jstLocal(120) })
  const annLater = r.data?.announcement_id

  r = await admin.get('/api/admin/hq-support/status')
  const ids = (r.data?.announcements || []).map(a => a.announcement_id)
  ok('#516 管理画面に、全企業・自社のプランのお知らせが出る', r.status === 200 && ids.includes(annAll) && ids.includes(annMaint), r.data)
  ok('#516 他の企業あて・掲載開始前のものは出ない', !ids.includes(annCo2) && !ids.includes(annLater), ids)
  ok('#516 メンテナンスを先頭に出す', ids[0] === annMaint, ids)
  r = await admin.post(`/api/admin/hq-announcements/${annCo2}/read`)
  ok('#516 自社あてでないお知らせは既読にできない（404）', r.status === 404, r)
  r = await admin.post(`/api/admin/hq-announcements/${annAll}/read`)
  ok('#516 「確認しました」で既読にできる', r.status === 200, r)
  r = await admin.get('/api/admin/hq-support/status')
  ok('#516 既読にしたものは上部に出なくなる', !(r.data?.announcements || []).some(a => a.announcement_id === annAll), r.data)
  r = await mgr.get('/api/admin/hq-support/status')
  ok('#516 既読は管理者ごと（同じ会社の別の管理者にはまだ出る）', (r.data?.announcements || []).some(a => a.announcement_id === annAll), r.data)
  r = await hq.get('/api/hq/announcements')
  const a1 = (r.data?.announcements || []).find(a => a.announcement_id === annAll)
  ok('#516 本部の一覧に、配信先の企業数と確認した企業数が出る', a1 && Number(a1.read_companies) === 1 && Number(a1.target_count) >= 2 && a1.state === 'active', a1)
  r = await hq.get(`/api/hq/announcements/${annAll}/reads`)
  const c1 = (r.data?.companies || []).find(c => c.company_id === 1)
  ok('#516 企業別の確認状況が出る', r.status === 200 && Number(c1?.read_users) === 1 && (r.data.companies || []).some(c => Number(c.read_users) === 0), r.data)
  r = await hq.put(`/api/hq/announcements/${annMaint}`, { title: '夜間メンテナンス（時間変更）', body: '3:00-4:00', importance: 'maintenance', target: 'plan', target_plan: 'standard', ends_at: jstLocal(24 * 60) })
  ok('#516 本部が修正できる', r.status === 200, r)
  r = await hq.post(`/api/hq/announcements/${annMaint}/withdraw`)
  ok('#516 本部が取り消せる', r.status === 200, r)
  r = await admin.get('/api/admin/hq-support/status')
  ok('#516 取り消したものは管理画面に出ない', !(r.data?.announcements || []).some(a => a.announcement_id === annMaint), r.data)
  r = await hq.put(`/api/hq/announcements/${annMaint}`, { title: 'x', body: 'x' })
  ok('#516 取り消したものは修正できない（409）', r.status === 409, r)
  r = await admin.post('/api/hq/announcements', { title: 'x', body: 'x' })
  ok('#516 企業の管理者は本部のお知らせを作れない（403）', r.status === 403)
}

// ---------- #293 本部による管理画面の閲覧 ----------
{
  let r = await hq.get('/api/admin/staff')
  ok('#293 閲覧を始めていない本部ユーザーは /api/admin を使えない（403）', r.status === 403 && r.data?.code === 'hq_view_required', r)
  r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: '問い合わせの確認', minutes: 30 })
  ok('#293 企業が許可していなければ閲覧できない（403）', r.status === 403 && r.data?.code === 'hq_view_not_allowed', r)
  r = await mgr.put('/api/admin/hq-access', { allowed: true })
  ok('#293 閲覧の許可は会社管理者だけが変えられる（403）', r.status === 403, r)
  r = await admin.put('/api/admin/hq-access', { allowed: true })
  ok('#293 会社管理者が閲覧を許可できる', r.status === 200, r)
  r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: '', minutes: 30 })
  ok('#293 目的がないと開始できない（400）', r.status === 400, r)
  r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: 'x', minutes: 600 })
  ok('#293 決められた時間（15/30/60分）以外は 400', r.status === 400, r)
  r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: 'シフトが出ないとの問い合わせ', minutes: 15 })
  ok('#293 許可があれば、期限付きの閲覧を始められる（Cookie を発行）', r.status === 200 && hq.jar.has('hq_view'), r)

  // 管理画面の画面（HTML）を開ける
  const pageRes = await fetch(`${BASE}/admin`, { headers: { Cookie: [...hq.jar.values()].join('; ') }, redirect: 'manual' })
  const page = await pageRes.text()
  ok('#293 閲覧中は /admin を開ける（閲覧中の印を付ける）', pageRes.status === 200 && page.includes('window.HQ_VIEW = {'), pageRes.status)

  r = await hq.get('/api/auth/me', { 'X-HQ-View': '1' })
  ok('#293 閲覧の画面の /auth/me は、閲覧先の企業・閲覧用のロールを返す', r.data?.company_id === 1 && r.data?.role === 'sales_manager' && r.data?.can_manage_hr === false && r.data?.hq_view?.view_id > 0, r.data)
  r = await hq.get('/api/auth/me')
  ok('#293 本部画面の /auth/me は本部ユーザーのまま', r.data?.role === 'system_admin', r.data)

  r = await hq.get('/api/admin/staff')
  ok('#293 閲覧中は企業のスタッフ一覧を見られる', r.status === 200, r.status)
  r = await hq.get('/api/admin/employees')
  ok('#293 従業員管理（労務情報）は見られない（403）', r.status === 403, r.status)
  r = await hq.post('/api/admin/clients', { client_name: '本部が作ったクライアント' })
  ok('#293 登録はできない（403 hq_view_readonly）', r.status === 403 && r.data?.code === 'hq_view_readonly', r)
  r = await hq.put('/api/auth/account', { name: 'x' }, { 'X-HQ-View': '1' })
  ok('#293 閲覧の画面から本部のアカウントも変えられない（403）', r.status === 403, r)

  // 管理画面の主な GET を、閲覧中にすべて開けるか（GET の中の書き込みは読み取り専用で止まる。500 にならないこと）
  const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
  const paths = ['/api/admin/dashboard', '/api/admin/staff', '/api/admin/projects', '/api/admin/clients', `/api/admin/shifts?month=${month}`, '/api/admin/daily-reports',
    '/api/admin/notices', '/api/admin/analytics', '/api/admin/follow-logs', '/api/admin/consultations', '/api/admin/corrections', '/api/admin/notifications',
    `/api/admin/settlement?month=${month}`, '/api/admin/settlement/closings', `/api/admin/billing-check?month=${month}`, `/api/admin/shift-board?date=${today}`, '/api/admin/report-settings/projects',
    '/api/admin/board/posts', '/api/admin/roster-chat/threads', '/api/admin/recruit-applications', '/api/admin/recruit-pages', '/api/admin/sites', '/api/admin/rate-rules',
    '/api/admin/templates', '/api/admin/hq-support/status', '/api/admin/hq-access', '/api/admin/support-requests', '/api/admin/staff/1', '/api/admin/projects/1']
  const bad = []
  for (const p of paths) {
    const x = await hq.get(p)
    if (x.status >= 500 || (x.status === 403 && x.data?.code === 'hq_view_readonly')) bad.push(`${p} → ${x.status} ${JSON.stringify(x.data).slice(0, 120)}`)
  }
  ok('#293 管理画面の主な GET は、閲覧中に 500・読み取り専用のエラーにならない', !bad.length, bad)

  r = await admin.get('/api/admin/hq-support/status')
  ok('#293 企業の管理画面に「本部が閲覧中」を出す', (r.data?.active_views || []).length === 1 && r.data.active_views[0].hq_name, r.data)
  r = await admin.get('/api/admin/hq-access')
  const sess = (r.data?.sessions || [])[0]
  ok('#293 企業側で閲覧の記録（目的・開いた画面の数）を確認できる', sess && sess.reason.includes('シフト') && Number(sess.pages) >= 3, sess)
  r = await hq.get('/api/hq/view-sessions')
  ok('#293 本部画面に閲覧中の企業と記録が出る', r.data?.current?.company_id === 1 && r.data.companies.some(c => c.company_id === 1 && c.allowed) && r.data.sessions.length >= 1, r.data?.current)
  const viewId = r.data?.sessions?.[0]?.view_id
  r = await hq.get(`/api/hq/view-sessions/${viewId}/logs`)
  ok('#293 開いた画面（API のパス）を記録している', (r.data?.logs || []).some(l => l.path === '/api/admin/staff' && l.method === 'GET'), r.data?.logs?.slice(0, 3))

  // 許可を取り消すと、閲覧中のものもすぐに終わる
  r = await admin.put('/api/admin/hq-access', { allowed: false })
  r = await hq.get('/api/admin/staff')
  ok('#293 企業が許可を取り消すと、閲覧中でもすぐに使えなくなる', r.status === 403, r.status)
  const pageRes2 = await fetch(`${BASE}/admin`, { headers: { Cookie: [...hq.jar.values()].join('; ') }, redirect: 'manual' })
  ok('#293 閲覧が終わったら /admin は本部画面へ戻す', pageRes2.status === 302 && (pageRes2.headers.get('location') || '').startsWith('/hq'), pageRes2.status)

  // 再度許可 → 開始 → 本部が終了
  await admin.put('/api/admin/hq-access', { allowed: true })
  r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: '設定の確認', minutes: 15, support_request_id: 99999 })
  ok('#293 その企業の依頼でない番号は 400', r.status === 400, r)
  r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: '設定の確認', minutes: 15 })
  ok('#293 再度開始できる', r.status === 200, r)
  r = await hq.del('/api/hq/view-sessions/current')
  ok('#293 本部が閲覧を終了できる', r.status === 200 && r.data?.ended === 1, r)
  r = await hq.get('/api/admin/staff')
  ok('#293 終了した後は使えない', r.status === 403, r.status)
  r = await admin.get('/api/admin/hq-access')
  ok('#293 企業側の記録に終了の理由が残る', ['hq', 'revoked'].every(x => (r.data?.sessions || []).some(s => s.end_reason === x)), r.data?.sessions)
  r = await admin.get('/api/hq/view-sessions')
  ok('#293 企業の管理者は本部の閲覧の API を使えない（403）', r.status === 403)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
