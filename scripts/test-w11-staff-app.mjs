// スタッフアプリの整理（w11-staff-app: #9411 #9412 #9413 #9414）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
//   （STAFF_APP_RECRUIT は付けない。スタッフアプリの募集を止めた状態を確かめる）
// 実行: BASE=http://127.0.0.1:8811 node scripts/test-w11-staff-app.mjs
// テストのたびに DB を作り直すこと（案件・シフト・日報・募集ページを追加するため）
//   #9411 スタッフアプリの募集を外す（スタッフ向けの募集 API は 404・「新しい募集」の通知を送らない・管理者の募集と公開ページはそのまま）
//   #9412 シフト希望を出勤可能日に一本化（画面から提出・取り下げを外す。今までのシフト希望は消さない）
//   #9413 一緒に入る人・申し送りが無いときの理由（reason）と画面の案内
//   #9414 メールアドレスの説明（通知・パスワード再設定に使う）

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
    const send = () => fetch(`${BASE}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const r = await send().catch(() => send())
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, label) => { if (r.status !== 200) throw new Error(`${label}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const PFX = 'W11S' + Date.now().toString(36).slice(-4).toUpperCase()

const admin = client(await login('sample', 'admin'))
const st8 = client(await login('sample', 'st008')) // staff_id 8 中村 花菜
const st9 = client(await login('sample', 'st009')) // staff_id 9 小林 竜也
const pub = client(null)

async function newProject(name, extra = {}) {
  must(await admin.post('/api/admin/projects', { project_name: name, ...extra }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function createShift(staff_id, project_id, work_date, memo, start_time = '10:00', end_time = '18:00') {
  must(await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time, end_time, memo }), 'createShift')
  const s = must(await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`), 'shifts').shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}

// ---------- #9411 スタッフアプリの募集を外す ----------
{
  const pid = await newProject(`${PFX}-募集案件`)
  const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 20),
    allow_staff: true, show_remaining: true, description: '', pay_note: '', contact_note: '', notify_staff: true, notify_staff_email: true }), 'recruit page')
  ok('#9411 管理者は今までどおり募集ページを作れる', page.ok === true && page.page_id && page.token, page)
  ok('#9411 募集ページを作っても、スタッフに「新しい募集」を知らせない（staff_notified を返さない）', page.staff_notified === undefined && page.staff_emailed === undefined, page)
  const n8 = must(await st8.get('/api/staff/notifications?kind=recruit_new'), 'notifs').notifications || []
  ok('#9411 スタッフに「新しい募集」の通知が届かない', !n8.some(x => x.related_id === page.page_id), n8.slice(0, 3))
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'closed' }), 'close')
  const re = must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'open' }), 'reopen')
  ok('#9411 再開しても、スタッフに知らせない', re.staff_notified === undefined && re.staff_notice_skipped === undefined, re)
  const n8b = must(await st8.get('/api/staff/notifications?kind=recruit_new'), 'notifs').notifications || []
  ok('#9411 再開の後も「新しい募集」の通知は無い', !n8b.some(x => x.related_id === page.page_id), n8b.slice(0, 3))
  const list = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages
  ok('#9411 管理者の募集ページの一覧はそのまま', list.some(p => p.page_id === page.page_id && p.status === 'open'), list.length)
  const g = await pub.get(`/api/public/recruit/${page.token}`)
  ok('#9411 公開ページはそのまま開ける', g.status === 200, g.status)

  for (const [m, p, b] of [['get', '/api/staff/recruit'], ['get', '/api/staff/recruit/summary?counts=1'], ['get', `/api/staff/recruit/pages/${page.page_id}/roles`],
    ['post', '/api/staff/recruit/apply', { page_id: page.page_id, slot_role_ids: [1] }], ['post', '/api/staff/recruit/items/1/cancel']]) {
    const r = await st8[m](p, b)
    ok(`#9411 スタッフ向けの募集 API は 404（${m.toUpperCase()} ${p.replace(/\?.*$/, '')}）`, r.status === 404 && r.data && r.data.error, r)
  }
  const ad = await admin.get('/api/staff/recruit')
  ok('#9411 管理者のアカウントからもスタッフ向けの募集 API は使えない', ad.status === 403 || ad.status === 404, ad.status)

  const prefs = must(await st8.get('/api/staff/notification-prefs'), 'prefs').groups
  ok('#9411 スタッフの受け取り設定に「新しい募集」を出さない', !prefs.some(x => x.key === 'recruit_new') && prefs.some(x => x.key === 'shift'), prefs.map(x => x.key))
  ok('#9411 「応募の結果」の設定は残す（公開ページから応募した人・以前の応募の結果）', prefs.some(x => x.key === 'recruit_result'), prefs.map(x => x.key))
  const ap = await admin.get('/api/admin/notification-prefs')
  ok('#9411 管理者の「新しい応募」の設定はそのまま', ap.status === 200 && ap.data.groups.some(x => x.key === 'recruit_applied'), ap.status)
}

// ---------- #9412 出勤可能日に一本化 ----------
{
  const av = await st8.get('/api/staff/availability')
  ok('#9412 出勤可能日の画面の API はそのまま使える', av.status === 200 && av.data.month && Array.isArray(av.data.months), av)
  if (av.status === 200 && av.data.editable) {
    const from = av.data.editable_from && av.data.editable_from > av.data.month + '-01' ? av.data.editable_from : av.data.month + '-01'
    const put = await st8.put('/api/staff/availability', { month: av.data.month, days: [{ date: from, status: 'ok' }] })
    ok('#9412 出勤可能日を提出できる', put.status === 200 && put.data.count === 1, put)
    const a = must(await admin.get('/api/admin/availability?month=' + av.data.month), 'admin availability')
    ok('#9412 管理者は出勤可能日の提出を見られる（シフトの候補で使う）', (a.staff || []).some(x => x.staff_id === 8 && x.submitted_at), (a.staff || []).find(x => x.staff_id === 8))
  }
  // 今までに出たシフト希望は消さない（API は残してあり、管理者の画面で見られる）
  const d = addDays(today, 9)
  const sr = await st9.post('/api/staff/shifts/request', { work_date: d, start_time: '10:00', end_time: '18:00', memo: `${PFX}-希望` })
  ok('#9412 以前のシフト希望のデータは残る（保存済みの希望）', sr.status === 200, sr)
  const adm = must(await admin.get(`/api/admin/shift-requests?from=${today}&to=${addDays(today, 30)}`), 'admin requests').requests
  ok('#9412 管理者はシフト希望を今までどおり見られる', adm.some(r => r.memo === `${PFX}-希望`), adm.length)
  const mine = must(await st9.get(`/api/staff/shifts?from=${d}&to=${d}`), 'staff shifts')
  ok('#9412 スタッフのシフトの API は、以前のシフト希望も返す（画面で表示だけする）', (mine.requests || []).some(r => r.memo === `${PFX}-希望`), mine.requests)
}

// ---------- #9413 一緒に入る人・申し送りの案内 ----------
{
  const tpl = must(await admin.get('/api/admin/templates'), 'templates').templates
  const withShare = tpl.find(t => /store_share/.test(JSON.stringify(t.fields || t.fields_json || '')))
  const noShare = tpl.find(t => t.template_name === '光回線・固定回線テンプレート')
  const pidA = await newProject(`${PFX}-申し送りあり`, withShare ? { report_template_id: withShare.template_id } : {})
  const s8 = await createShift(8, pidA, today, `${PFX}-8`)
  let h = await st8.get(`/api/staff/handover/${s8}`)
  ok('#9413 前のシフトの日報に共有事項が無ければ reason: no_notes（項目名も返す）', h.status === 200 && h.data.notes.length === 0 && h.data.reason === 'no_notes' && h.data.fields.some(f => f.key === 'store_share' && f.label), h.data)
  const c1 = await st8.get(`/api/staff/shifts/${s8}/coworkers`)
  ok('#9413 同じ日・同じ案件にほかの人がいなければ、空の一覧（設定は ON）', c1.status === 200 && c1.data.enabled === true && c1.data.coworkers.length === 0, c1.data)

  const s9y = await createShift(9, pidA, addDays(today, -1), `${PFX}-9Y`)
  must(await st9.post('/api/staff/daily-report', { shift_id: s9y, values: { store_share: `${PFX} 搬入口は北側です` }, flags_explicit: true }), 'report 9y')
  await createShift(9, pidA, today, `${PFX}-9`, '12:00', '20:00')
  h = await st8.get(`/api/staff/handover/${s8}`)
  ok('#9413 前のシフトの日報の共有事項があれば出す（reason は付けない）', h.status === 200 && h.data.notes.some(n => n.values.store_share === `${PFX} 搬入口は北側です`) && h.data.reason === undefined, h.data)
  const c2 = await st8.get(`/api/staff/shifts/${s8}/coworkers`)
  ok('#9413 同じ日・同じ案件のほかの人がいれば出す', c2.status === 200 && c2.data.coworkers.some(x => x.name === '小林'), c2.data)

  if (noShare) {
    const pidB = await newProject(`${PFX}-共有項目なし`, { report_template_id: noShare.template_id })
    const sB = await createShift(8, pidB, addDays(today, 1), `${PFX}-8B`)
    const hb = await st8.get(`/api/staff/handover/${sB}`)
    ok('#9413 日報に共有事項の項目が無い案件は reason: no_share_field', hb.status === 200 && hb.data.notes.length === 0 && hb.data.reason === 'no_share_field', hb.data)
  } else ok('#9413 共有事項の項目が無いテンプレート（光回線・固定回線テンプレート）がある', false, tpl.map(t => t.template_name))
}

// ---------- #9414 メールアドレスの説明 ----------
{
  const pr = await st8.get('/api/staff/self/profile-requests')
  ok('#9414 変更申請のメールの項目名は「通知・パスワード再設定」と分かる名前', pr.status === 200 && pr.data.labels.login_email === 'メールアドレス（通知・パスワード再設定）', pr.data && pr.data.labels)
}

// ---------- 画面（staff.js・staff-profile.js） ----------
{
  const js = await (await fetch(`${BASE}/static/staff.js`)).text()
  ok('#9411 スタッフアプリから募集の API を呼ばない', !js.includes('/api/staff/recruit'))
  ok('#9411 ホーム・シフト画面の「募集中のお仕事」を出さない', !js.includes('募集中のお仕事') && !js.includes('recruit-open'))
  ok('#9412 シフト希望の提出・取り下げの入口を出さない', !js.includes('/api/staff/shifts/request') && !js.includes('shift-requests/') && !js.includes('シフト希望を提出する'))
  ok('#9412 シフト画面の主なボタンは「出勤可能日を提出する」', /<a href="#availability" class="btn btn-primary w-full" id="shift-availability-btn">/.test(js))
  ok('#9413 一緒に入る人が無いときの案内', js.includes('同じ日・同じ案件にほかの人のシフトがないため表示がありません'))
  ok('#9413 申し送りが無いときの案内（どこに書くと出るか）', js.includes('前のシフトの日報に共有事項が書かれていないため表示がありません') && js.includes("ho.reason === 'no_share_field'"))
  ok('#9413 モーダルを閉じるボタンに onclick を使わない', !/data-action="openShiftTeam"[\s\S]{0,50}onclick/.test(js) && js.includes("delegate('closeShiftTeam'"))
  const prof = await (await fetch(`${BASE}/static/staff-profile.js`)).text()
  ok('#9414 変更申請のメールの説明を直す', prof.includes('通知・パスワード再設定に使うメールアドレス（変えるときだけ入力）') && !prof.includes('L.login_email)}（変えるときだけ入力）'))
  // 構文の確認（ブラウザで読み込めること）
  for (const [name, src] of [['staff.js', js], ['staff-profile.js', prof]]) {
    let err = null
    try { new Function(src) } catch (e) { err = String(e) }
    ok(`構文: ${name}`, !err, err)
  }
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
