// 格納型XSSの入口の統合テスト（w1-xss-escape: #2 #3 #4 #6 #39 #93 #132 #138 #460）
//
// 前提: bash scripts/setup-test-db.sh でローカルの D1 を作り直し、`wrangler dev` で起動していること（手順はスクリプトの冒頭）
// 実行: node scripts/test-w1-xss-escape.mjs   （BASE=http://127.0.0.1:8799 で接続先を変更）
// 画面側（data-action と委譲）は、配信している js に危険な書き方が残っていないかと、common.js の esc・delegate の動作で確かめる
import vm from 'node:vm'

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
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

const IMG = '<img src=x onerror=alert(1)>'
const QUOTE = "x');alert(1);//"

const admin = client(await login('sample', 'admin'))
const st1 = client(await login('sample', 'st001')) // staff_id 1

async function createShift(staff_id, project_id, work_date, memo) {
  const r = await admin.post('/api/admin/shifts', { staff_id, project_id, work_date, start_time: '00:01', end_time: '23:30', memo })
  if (r.status !== 200) throw new Error('createShift ' + JSON.stringify(r.data))
  const list = await admin.get(`/api/admin/shifts?from=${work_date}&to=${work_date}`)
  const s = list.data.shifts.find(x => x.memo === memo)
  if (!s) throw new Error('shift not found ' + memo)
  return s.shift_id
}

// ---------- #2 日報の values のキーはテンプレートの項目に限る ----------
{
  const d = addDays(today, -1) // 日報は稼働日以降、報告用URLは稼働日の翌日まで（w2-daily-report #241）。今日にすると、ほかのテストのホームのシフトと重なる
  const shiftId = await createShift(1, 1, d, 'XSS-DR')
  const bad = await st1.post('/api/staff/daily-report', { project_id: 1, shift_id: shiftId, work_date: d, values: { mnp: 'abc' } })
  ok('#2 数値の項目に数値以外は 400', bad.status === 400, bad)
  const long = await st1.post('/api/staff/daily-report', { project_id: 1, shift_id: shiftId, work_date: d, values: { free: 'a'.repeat(2001) } })
  ok('#2 テキストの項目が長すぎると 400', long.status === 400, long)
  const r = await st1.post('/api/staff/daily-report', { project_id: 1, shift_id: shiftId, work_date: d, values: { mnp: 3, free: IMG, [IMG]: 5, __proto__x: 1 } })
  ok('#2 日報の提出は成功', r.status === 200, r)
  const list = await admin.get(`/api/admin/daily-reports?date=${d}`)
  const rep = (list.data.reports || []).find(x => x.shift_id === shiftId) || (list.data.reports || [])[0]
  ok('#2 テンプレートにないキーは保存されない', rep && !(IMG in rep.values) && !('__proto__x' in rep.values), rep && rep.values)
  ok('#2 テンプレートの項目は保存される（数値・文字列）', rep && rep.values.mnp === 3 && rep.values.free === IMG, rep && rep.values)

  // ログイン不要の報告用URL
  const link = await admin.post(`/api/admin/shifts/${shiftId}/report-link`)
  ok('#2 報告用URLの発行', link.status === 200 && link.data.token, link)
  const pub = async (body) => {
    const res = await fetch(`${BASE}/api/public/report/${link.data.token}/daily-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    let data = null; try { data = await res.json() } catch { }
    return { status: res.status, data }
  }
  const pbad = await pub({ values: { mnp: { x: 1 } } })
  ok('#2 報告用URL: 数値の項目にオブジェクトは 400', pbad.status === 400, pbad)
  const pr = await pub({ values: { pi: 2, [IMG]: 'x' } })
  ok('#2 報告用URL: 日報の提出は成功', pr.status === 200, pr)
  const list2 = await admin.get(`/api/admin/daily-reports?date=${d}`)
  const rep2 = (list2.data.reports || []).find(x => x.shift_id === shiftId) || (list2.data.reports || [])[0]
  ok('#2 報告用URL: テンプレートにないキーは保存されない', rep2 && !(IMG in rep2.values) && rep2.values.pi === 2, rep2 && rep2.values)
}

// ---------- #2 既存の使い方を壊さない（日本語のキーのテンプレート・テンプレートの無い案件） ----------
{
  const hq = client(await login('sample', 'hq'))
  const tname = 'XSS-JP-TPL-' + Date.now()
  const ct = await hq.post('/api/hq/templates', { template_name: tname, fields: [{ key: '架電数', label: '架電数', type: 'number' }, { key: 'メモ', label: 'メモ', type: 'textarea' }] })
  ok('#2 日本語のキーのテンプレートを作成', ct.status === 200, ct)
  const tpl = ((await hq.get('/api/hq/templates')).data.templates || []).find(t => t.template_name === tname)
  const pj = async (name, report_template_id) => {
    const r = await admin.post('/api/admin/projects', { project_name: name, client_id: 1, report_template_id })
    if (r.status !== 200) throw new Error('create project ' + JSON.stringify(r.data))
    return ((await admin.get('/api/admin/projects')).data.projects || []).find(p => p.project_name === name).project_id
  }
  const pJp = await pj(tname, tpl && tpl.template_id)
  // テンプレートの無い案件は、画面と同じく空欄で登録する（存在しないテンプレートIDは w1-tenant-guard で 400 になる）
  const pNone = await pj('XSS-NO-TPL-' + Date.now(), '')
  const d = addDays(today, -2)
  const s1 = await createShift(1, pJp, d, 'XSS-JP')
  const r1 = await st1.post('/api/staff/daily-report', { project_id: pJp, shift_id: s1, work_date: d, values: { '架電数': 12, 'メモ': 'テスト' } })
  const rep1 = ((await admin.get(`/api/admin/daily-reports?date=${d}`)).data.reports || []).find(x => x.shift_id === s1)
  ok('#2 日本語のキーの項目も保存される', r1.status === 200 && rep1 && rep1.values['架電数'] === 12 && rep1.values['メモ'] === 'テスト', rep1 && rep1.values)
  const d2 = addDays(today, -1) // 報告用URLは稼働日の翌日まで
  const s2 = await createShift(1, pNone, d2, 'XSS-NOTPL')
  const link = await admin.post(`/api/admin/shifts/${s2}/report-link`)
  const res = await fetch(`${BASE}/api/public/report/${link.data.token}/daily-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { free: '報告です', [IMG]: 1 } }) })
  const rep2 = ((await admin.get(`/api/admin/daily-reports?date=${d2}`)).data.reports || []).find(x => x.shift_id === s2)
  ok('#2 テンプレートの無い案件: 報告用URLの「報告内容」は保存され、それ以外は捨てる', res.status === 200 && rep2 && rep2.values.free === '報告です' && Object.keys(rep2.values).length === 1, rep2 && rep2.values)
}

// ---------- #3 相談のカテゴリ・緊急度は許可リスト ----------
{
  const bad = await st1.post('/api/staff/consultations', { category: IMG, body: 'test' })
  ok('#3 未知のカテゴリは 400', bad.status === 400, bad)
  const badU = await st1.post('/api/staff/consultations', { category: 'health', body: 'test', urgency: IMG })
  ok('#3 未知の緊急度は 400', badU.status === 400, badU)
  const good = await st1.post('/api/staff/consultations', { category: 'health', body: 'XSS-CONSULT', urgency: 'high' })
  ok('#3 決まったカテゴリ・緊急度は成功', good.status === 200, good)
  const list = await admin.get('/api/admin/consultations')
  ok('#3 不正な値は保存されていない', !(list.data.consultations || []).some(c => c.category === IMG || c.urgency === IMG), list.data.consultations && list.data.consultations.length)
}

// ---------- #6 シフト希望の時刻は HH:MM ----------
{
  const d = addDays(today, 41)
  const bad = await st1.post('/api/staff/shifts/request', { work_date: d, start_time: IMG, end_time: '19:00', project_id: 1 })
  ok('#6 開始時刻が HH:MM でないと 400', bad.status === 400, bad)
  const bad2 = await st1.post('/api/staff/shifts/request', { work_date: d, start_time: '10:00', end_time: '25:00', project_id: 1 })
  ok('#6 終了時刻が範囲外だと 400', bad2.status === 400, bad2)
  const good = await st1.post('/api/staff/shifts/request', { work_date: d, start_time: '10:00', end_time: '19:00', project_id: 1 })
  ok('#6 正しい時刻は成功', good.status === 200, good)
  const def = await st1.post('/api/staff/shifts/request', { work_date: addDays(today, 42), project_id: 1 })
  ok('#6 時刻を省略したときは従来どおり既定の時刻で成功', def.status === 200, def)
}

// ---------- #132 アップロードしたファイル名の制御文字を除く ----------
{
  const fd = new FormData()
  fd.append('files', new Blob(['hello'], { type: 'text/plain' }), "O'Brien\r\n_" + QUOTE + '.txt')
  const res = await fetch(`${BASE}/api/admin/staff/1/documents`, { method: 'POST', headers: { Cookie: admin.cookie }, body: fd })
  const up = await res.json().catch(() => null)
  ok('#132 書類のアップロードは成功', res.status === 200 && up && up.results && up.results[0] && up.results[0].ok, up)
  const docs = await admin.get('/api/admin/staff/1/documents')
  const doc = (docs.data.documents || []).find(x => x.document_id === (up && up.results && up.results[0] && up.results[0].document_id))
  ok('#132 ファイル名から改行などの制御文字が除かれる', doc && !/[\r\n]/.test(doc.original_file_name) && doc.original_file_name.includes("O'Brien"), doc)
  if (doc) {
    const dl = await fetch(`${BASE}/api/admin/staff/documents/${doc.document_id}/download`, { headers: { Cookie: admin.cookie } })
    ok('#132 そのファイルをダウンロードできる', dl.status === 200, dl.status)
    const del = await admin.del(`/api/admin/staff/documents/${doc.document_id}`)
    ok('#132 そのファイルを削除できる', del.status === 200, del)
  }
}

// ---------- 画面: common.js の読み込みと esc・delegate ----------
{
  const page = await fetch(`${BASE}/admin`, { headers: { Cookie: admin.cookie } }).then(r => r.text())
  ok('管理画面の head で common.js を読み込む', /<script src="\/static\/common\.js"><\/script>/.test(page) && page.indexOf('/static/common.js') < page.indexOf('/static/admin.js'))
  const staffPage = await fetch(`${BASE}/staff`, { headers: { Cookie: st1.cookie } }).then(r => r.text())
  ok('スタッフ画面でも common.js を読み込む', staffPage.includes('/static/common.js'))

  const src = await fetch(`${BASE}/static/common.js`).then(r => r.text())
  let listener = null
  const ctx = { document: { addEventListener: (type, fn) => { if (type === 'click') listener = fn } }, alert: () => { } }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  ok('esc は & < > " \' ` を実体参照にする', ctx.esc(`&<>"'\``) === '&amp;&lt;&gt;&quot;&#39;&#96;', ctx.esc(`&<>"'\``))
  ok('esc は null・undefined を空文字にする', ctx.esc(null) === '' && ctx.esc(undefined) === '')
  let got = null
  ctx.delegate('t', (el) => { got = el.dataset.name })
  const el = { disabled: false, dataset: { name: QUOTE }, getAttribute: (k) => (k === 'data-action' ? 't' : null) }
  listener({ target: { closest: () => el } })
  ok('delegate は data-action の処理に要素を渡す（値は文字列のまま）', got === QUOTE, got)
  got = null; el.disabled = true
  listener({ target: { closest: () => el } })
  ok('delegate は無効なボタンでは呼ばない', got === null)
  const btn = { disabled: false, dataset: {} }
  let calls = 0
  const p1 = ctx.withSubmitLock(btn, async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 1 })
  const p2 = ctx.withSubmitLock(btn, async () => { calls++ })
  ok('withSubmitLock は処理中のボタンを無効にする', btn.disabled === true)
  await Promise.all([p1, p2])
  ok('withSubmitLock は二重に実行しない・終わったら元に戻す', calls === 1 && btn.disabled === false && !btn.dataset.busy, { calls, btn })
}

// ---------- 画面: 値を onclick の JS 文字列に埋め込む書き方が残っていない（#4 #39 #93 #132 #138 #460） ----------
{
  const files = ['admin.js', 'roster.js', 'shift-board.js']
  const srcs = Object.fromEntries(await Promise.all(files.map(async f => [f, await fetch(`${BASE}/static/${f}`).then(r => r.text())])))
  const all = Object.values(srcs).join('\n')
  ok('admin.js に独自の esc が残っていない（common.js を使う）', !/^function esc\(/m.test(srcs['admin.js']))
  // on*="...'${esc(...)}'..." の形（属性値のデコードで ' に戻り、文字列を抜け出せる）
  ok('onclick に \'${esc(...)}\' を埋め込む箇所がない', !/on[a-z]+="[^"]*'\$\{esc\(/.test(all), (all.match(/on[a-z]+="[^"]*'\$\{esc\([^\n]{0,80}/) || [])[0])
  // onclick に JSON.stringify を埋め込む形（他社の氏名などを含む）
  ok('onclick に JSON.stringify(候補・担当者) を埋め込む箇所がない', !/onclick='showRosterConsent\(|onclick='submitRosterLink\(|showClientContactForm\(\$\{cid\}, \$\{JSON\.stringify/.test(all))
  ok('#4 フォロー記録・シフト操作は data-action で開く', /data-action="showFollowModal"/.test(srcs['admin.js']) && /data-action="showEditShift"/.test(srcs['admin.js']))
  ok('#93 顧客担当者の編集・削除は data-action で開く', /data-action="editClientContact"/.test(srcs['admin.js']) && /data-action="deleteClientContact"/.test(srcs['admin.js']))
  ok('#132 書類の削除は data-action で開く', /data-action="deleteDocument"/.test(srcs['admin.js']) && /button\[data-action="deleteDocument"\]/.test(srcs['admin.js']))
  ok('#138 開催場所の名前の変更は data-action で開く', /data-action="renameSite"/.test(srcs['shift-board.js']))
  ok('#39 連携候補のボタンは data-action で開く', /data-action="rosterConsent"/.test(srcs['roster.js']) && /data-action="rosterLinkSubmit"/.test(srcs['roster.js']))
  ok('#460 従業員管理の入力欄の値はエスケープする', /class="inp text-xs" value="\$\{esc\(value \?\? ''\)\}"/.test(srcs['admin.js']))
  ok('#2 #3 日報の項目名・相談のカテゴリはエスケープする', /\$\{esc\(LABELS\[k\] \|\| k\)\}/.test(srcs['admin.js']) && /\$\{esc\(CAT_LABELS\[co\.category\] \|\| co\.category\)\}/.test(srcs['admin.js']))
  ok('#6 シフト管理・シフトボードの時刻はエスケープする', /\$\{esc\(s\.start_time\)\}〜\$\{esc\(s\.end_time\)\} <span/.test(srcs['admin.js']) && /\$\{esc\(a\._site \|\| ''\)\} \$\{esc\(a\.start_time\)\}/.test(srcs['shift-board.js']))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
