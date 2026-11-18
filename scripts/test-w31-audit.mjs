// w31-audit（Sprint 31 #9988。利用者の要望 11/17「CSV出力や諸々の操作履歴もわかるようにして欲しい」）の統合テスト
//   1. CSV・ファイルの書き出しを、だれが・いつ・どのファイル・条件・行数・接続元で残す（失敗した書き出しは残さない）。本部の閲覧中の書き出しも「本部」で残す
//   2. 管理の操作（スタッフ・従業員・管理者・設定・案件・クライアント・お知らせ）を1操作1行で残す。前後の値を残し、口座などは「変更あり」だけ
//   3. 「操作の記録」の画面の API: 会社管理者だけ。期間・人・種類で絞り、新しい順にページ送り（同じ秒の行も抜け・重なりなし）。
//      シフト・精算の操作履歴（operation_logs）とログインの履歴（login_events）もまとめて出す。CSV で書き出せ、その書き出しも残る
//   4. 本部の企業詳細からも見られ、見たこと・書き出したことは本部の操作の履歴（hq_audit_logs）に残る
//   5. 画面で作る CSV（請求前確認・ログイン案内）は画面から知らせて残す。1年を過ぎた記録は毎日の cron で消す。解約の削除の対象
//   6. 画面: 管理画面の「操作の記録」・本部の企業詳細の欄が描ける（ヘッドレスの Chrome があるときだけ）
// run-tests: --test-scheduled
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、npm run build の後に
//   `wrangler dev --local --port 9020 --persist-to <保存先> --test-scheduled` で起動していること（ローカルの D1 に直接書き込む。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:9020 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w31-audit.mjs
//   本番には接続しない（wrangler d1 execute は --local のみ）
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED'].includes(e?.cause?.code)) throw e; await new Promise(r => setTimeout(r, 1500)); return rawFetch(...args) } }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BASE || 'http://127.0.0.1:9020'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（--persist-to の保存先）を指定してください'); process.exit(1) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 900) : ''}`) }
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
const CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w31a-'))
let sqlSeq = 0
async function sqlAll(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  let out
  for (let i = 0; ; i++) {
    try { out = execFileSync(process.execPath, [CLI, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); break } catch (e) {
      const msg = String(e.stdout || '') + String(e.stderr || '')
      if (i >= 3 || !/internal error|SQLITE_BUSY|database is locked|bad_alloc|write EOF/i.test(msg)) throw new Error(msg.slice(0, 600))
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  await waitServer()
  return JSON.parse(out.slice(out.indexOf('[')))
}
async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try { const r = await rawFetch(`${BASE}/login`); if (r.ok) return } catch { }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('server did not respond')
}
const sql = async (command) => (await sqlAll(command)).at(-1).results

async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie, extra = {}) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text, headers: r.headers }
  }
  return { cookie, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const q = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null))).toString()
// 直近の audit_logs（会社 1）
const lastAudit = async (n = 1) => sql(`SELECT * FROM audit_logs WHERE company_id = 1 ORDER BY audit_id DESC LIMIT ${n}`)
const auditCount = async () => Number((await sql('SELECT COUNT(*) AS n FROM audit_logs'))[0].n)
const detailOf = (r) => { try { return JSON.parse(r.detail_json || '{}') } catch { return {} } }

const PFX = 'W31A' + Date.now().toString(36).slice(-4).toUpperCase()
const adminCk = await login('sample', 'admin')
const admin = client(adminCk)
const field = client(await login('sample', 'mgr01'))
const sales = client(await login('sample', 'sales01'))
const hqCk = await login('', 'hq')
const hq = client(hqCk)
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
must(await admin.put('/api/admin/tours', { items: ['admin-welcome', 'admin-checklist', 'admin-setup'].map(key => ({ key, status: 'skipped', step: 0 })) }), '案内を閉じる')

// ---------- 0. 表・権限・メニュー ----------
{
  const cols = (await sql(`PRAGMA table_info(audit_logs)`)).map(r => r.name)
  ok('0115: audit_logs の表がある（会社・操作した人・種類・操作・対象・内容・接続元・日時）',
    ['company_id', 'actor_user_id', 'actor_role', 'category', 'action', 'label', 'target_type', 'target_id', 'target_name', 'detail_json', 'ip', 'created_at'].every(c => cols.includes(c)), cols)
  const perms = read('src/lib/permissions.ts')
  ok('権限の表に audit_logs.view があり、会社管理者だけ（4ロールの結論が出たら roles を足し替える）', /'audit_logs\.view': \{[^}]*roles: CA/.test(perms))
  ok('docs/permissions.md に audit_logs.view の行がある', read('docs/permissions.md').includes('`audit_logs.view`'))
  const me = must(await admin.get('/api/auth/me'), 'me')
  const meF = must(await field.get('/api/auth/me'), 'me field')
  ok('/api/auth/me: 会社管理者は audit_logs.view を持ち、現場管理者は持たない', me.permissions.includes('audit_logs.view') && !meF.permissions.includes('audit_logs.view'))
  const page = await (await fetch(`${BASE}/admin`, { headers: { Cookie: adminCk } })).text()
  const pageF = await (await fetch(`${BASE}/admin`, { headers: { Cookie: field.cookie } })).text()
  ok('管理画面のメニュー: 会社管理者に「操作の記録」が出る（設定の見出しの中）・現場管理者には出ない',
    page.includes('data-tab="audit-logs"') && page.includes('操作の記録') && !pageF.includes('data-tab="audit-logs"'))
  ok('管理画面・本部画面が /static/audit-log.js を読み込む', page.includes('/static/audit-log.js') && (await (await fetch(`${BASE}/hq`, { headers: { Cookie: hqCk } })).text()).includes('/static/audit-log.js'))
  for (const [who, cl] of [['現場管理者', field], ['営業管理者', sales]]) {
    const r = await cl.get('/api/admin/audit-logs')
    ok(`${who}は操作の記録の API を使えない（403）`, r.status === 403, r.status)
  }
  ok('会社管理者は操作の記録の API を使える', (await admin.get('/api/admin/audit-logs')).status === 200)
  const js = read('public/static/audit-log.js')
  ok('画面: 値を onclick などのイベント属性に入れず、data-action と delegate を使う', !/\son[a-z]+="/.test(js) && js.includes("delegate('auditKind'") && js.includes("delegate('auditExport'"))
}

// ---------- 1. CSV・ファイルの書き出し ----------
const staffList = must(await admin.get('/api/admin/staff'), 'スタッフ一覧')
const staffArr = staffList.staff || staffList
const own = staffArr.find(s => s.affiliation_type === 'own_employee' && s.user_role === 'staff') || staffArr[0]
{
  const before = await auditCount()
  const r = await fetch(`${BASE}/api/admin/corrections/export?${q({ from: '2026-01-01', to: today })}`, { headers: { Cookie: adminCk, 'CF-Connecting-IP': '203.0.113.7' } })
  const body = await r.text()
  const rowsHeader = r.headers.get('X-Export-Rows')
  const [a] = await lastAudit()
  const d = detailOf(a)
  ok('CSV: 打刻修正の申請の CSV を書き出すと1行残る（種類 csv・ファイル名・条件・行数・接続元・操作した人）',
    (await auditCount()) === before + 1 && a.category === 'csv' && a.label === '打刻修正の申請の CSV' && /^打刻修正申請_/.test(d.file || '')
    && d.filters?.from === '2026-01-01' && d.filters?.to === today && d.rows === Number(rowsHeader) && a.ip === '203.0.113.7' && Number(a.actor_user_id) === 1 && a.actor_role === 'company_admin',
    { a, rowsHeader })
  const lines = body.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
  ok('CSV: 行数（X-Export-Rows）は見出しを除いた行の数', Number(rowsHeader) === lines.length - 1, { rowsHeader, lines: lines.length })
}
{
  await fetch(`${BASE}/api/admin/employees/export?include_pay=1`, { headers: { Cookie: adminCk } }).then(r => r.text())
  const [a] = await lastAudit()
  ok('CSV: 従業員名簿（口座・給与あり）の書き出しが、その名前で残る', a.label === '従業員名簿（口座・給与あり）' && detailOf(a).filters?.include_pay === '1', a)
  await fetch(`${BASE}/api/admin/settlement/export?${q({ from: '2026-10-01', to: '2026-10-31', kind: 'detail' })}`, { headers: { Cookie: adminCk } }).then(r => r.text())
  const [s] = await lastAudit()
  ok('CSV: 精算の CSV（明細）が、行数つきで残る', s.label === '精算の CSV（明細）' && Number.isInteger(detailOf(s).rows), s)
  await fetch(`${BASE}/api/admin/daily-reports-csv?${q({ from: '2026-10-01', to: '2026-10-31' })}`, { headers: { Cookie: field.cookie } }).then(r => r.text())
  const [dr] = await lastAudit()
  ok('CSV: 現場管理者の日報の CSV も残る（ロールつき）', dr.label === '日報の CSV' && dr.actor_role === 'field_manager', dr)
  const before = await auditCount()
  const bad = await fetch(`${BASE}/api/admin/daily-reports-csv?${q({ from: '2026-01-01', to: '2026-12-31' })}`, { headers: { Cookie: adminCk } })
  await bad.text()
  ok('CSV: 書き出せなかったとき（400）は残さない', bad.status === 400 && (await auditCount()) === before, bad.status)
  const before2 = await auditCount()
  await admin.get('/api/admin/staff')
  await admin.get('/api/admin/projects')
  ok('CSV: ふつうの一覧の取得（GET）は残さない', (await auditCount()) === before2)
}

// ---------- 2. 管理の操作 ----------
{
  // スタッフの情報の変更（前後の値）
  const sid = own.staff_id
  const memo = `${PFX} メモ`
  const before = await auditCount()
  must(await admin.put(`/api/admin/staff/${sid}`, { memo }), 'スタッフの変更')
  const [a] = await lastAudit()
  const ch = (detailOf(a).changes || []).find(x => x.f === 'memo')
  ok('操作: スタッフの情報の変更が1操作1行で残り、項目名と前後の値・対象の名前がある',
    (await auditCount()) === before + 1 && a.category === 'staff' && a.label === 'スタッフの情報の変更' && a.target_type === 'staff' && Number(a.target_id) === Number(sid) && a.target_name === own.name
    && ch && ch.l === 'メモ' && ch.a === memo, a)
  // 従業員の口座（秘密の値は「変更あり」だけ）
  const acct = String(Date.now()).slice(-7)
  const r = await admin.put(`/api/admin/employees/${sid}`, { bank_name: `${PFX}銀行`, account_number: acct, department: `${PFX}部` })
  if (r.status === 200) {
    const [e] = await lastAudit()
    const d = detailOf(e)
    const accCh = (d.changes || []).find(x => x.f === 'account_number'), dep = (d.changes || []).find(x => x.f === 'department')
    ok('操作: 従業員の口座の変更は「変更あり」だけ（値は記録に残さない）。ほかの項目は前後の値',
      e.label === '従業員の情報の変更' && accCh && accCh.s === 1 && accCh.a === undefined && !e.detail_json.includes(acct) && !e.detail_json.includes(`${PFX}銀行`) && dep && dep.a === `${PFX}部`, e)
  } else ok('操作: 従業員の情報を保存できる（前提）', false, r)
  // 失敗した操作は残さない
  const b2 = await auditCount()
  const bad = await admin.put(`/api/admin/staff/${sid}`, { name: '' })
  ok('操作: 失敗した操作（400）は残さない', bad.status >= 400 && (await auditCount()) === b2, bad.status)
}
let newUserId = null
{
  // 管理者の追加・ロールの変更・パスワードの再発行（パスワードは残さない）
  const code = `${PFX.toLowerCase()}_of`
  const pw = 'w31pass' + Date.now().toString(36)
  const r = must(await admin.post('/api/admin/users', { user_code: code, name: `${PFX} 事務`, email: `${code}@example.com`, role: 'office_staff', password: pw }), '管理者の追加')
  newUserId = r.user_id
  const [a] = await lastAudit()
  ok('操作: 管理者の追加が、対象の名前・権限つきで残る（パスワードは残さない）',
    a.category === 'admin' && a.label === '管理者の追加' && Number(a.target_id) === Number(newUserId) && a.target_name === `${PFX} 事務` && detailOf(a)['権限'] === '事務担当' && !String(a.detail_json).includes(pw), a)
  must(await admin.put(`/api/admin/users/${newUserId}`, { role: 'field_manager' }), 'ロールの変更')
  const [b] = await lastAudit()
  const rc = (detailOf(b).changes || []).find(x => x.f === 'role')
  ok('操作: 管理者のロールの変更が前後の値で残る', b.label === '管理者の変更' && rc && rc.b === 'office_staff' && rc.a === 'field_manager', b)
  const rp = must(await admin.post(`/api/admin/users/${newUserId}/reset-password`, { mode: 'temp' }), 'パスワードの再発行')
  const [p] = await lastAudit()
  ok('操作: パスワードの再発行が残り、仮のパスワードは残さない', p.label === '管理者のパスワードの再発行' && detailOf(p)['方法'] === '仮のパスワードを発行' && !(rp.temp_password && String(p.detail_json).includes(rp.temp_password)), p)
  must(await admin.del(`/api/admin/staff/${own.staff_id}/sessions`), 'スタッフのログインの終了')
  const [l] = await lastAudit()
  ok('操作: スタッフのログインの強制終了が残る', l.label === 'スタッフのログインの強制終了' && l.category === 'admin' && l.target_type === 'staff' && Number(l.target_id) === Number(own.staff_id), l)
}
{
  // 設定の変更（会社の設定・割増）
  // 同じ DB で流し直しても値が変わるように、今の値と違う値にする
  const cur = Number((await sql(`SELECT json_extract(settings_json, '$.late_grace_minutes') AS g FROM companies WHERE company_id = 1`))[0].g)
  const next = cur === 7 ? 8 : 7
  must(await admin.put('/api/admin/settings/lateness', { grace_minutes: next }), '遅刻の猶予の変更')
  const [a] = await lastAudit()
  const ch = (detailOf(a).changes || []).find(x => x.f === 'late_grace_minutes')
  ok('操作: 勤怠の設定の変更が、項目名と前後の値で残る', a.category === 'settings' && a.label === '勤怠の設定（遅刻の猶予）' && ch && ch.l === '遅刻の猶予（分）' && ch.a === String(next), a)
  const curNight = Number((await sql('SELECT night_rate FROM premium_pay_settings WHERE company_id = 1'))[0]?.night_rate ?? -1)
  must(await admin.put('/api/admin/settlement/premium-settings', { enabled: true, night_rate: curNight === 27 ? 28 : 27, overtime_rate: 25, holiday_rate: 35, holiday_weekdays: [0], daily_limit_minutes: 480 }), '割増の設定')
  const [p] = await lastAudit()
  const pc = (detailOf(p).changes || []).find(x => x.f === 'night_rate')
  ok('操作: 割増の設定の変更が前後の値で残る', p.label === '割増の設定' && pc && Number(pc.a) >= 20 && pc.a !== pc.b, p)
}
{
  // 案件・クライアント・お知らせ
  const cl = must(await admin.post('/api/admin/clients', { client_name: `${PFX} 取引先` }), 'クライアントの登録')
  const [c1] = await lastAudit()
  ok('操作: クライアントの登録（作った行の ID・名前）', c1.category === 'master' && c1.label === 'クライアントの登録' && Number(c1.target_id) === Number(cl.client_id) && c1.target_name === `${PFX} 取引先`, c1)
  const pj = must(await admin.post('/api/admin/projects', { project_name: `${PFX} 案件`, client_id: cl.client_id }), '案件の登録')
  must(await admin.put(`/api/admin/projects/${pj.project_id}`, { project_name: `${PFX} 案件2` }), '案件の変更')
  const [p1] = await lastAudit()
  const pc = (detailOf(p1).changes || []).find(x => x.f === 'project_name')
  ok('操作: 案件の変更（案件名の前後）', p1.label === '案件の変更' && pc && pc.b === `${PFX} 案件` && pc.a === `${PFX} 案件2` && p1.target_name === `${PFX} 案件2`, p1)
  const del = await admin.del(`/api/admin/projects/${pj.project_id}`)
  if (del.status === 200) {
    const [p2] = await lastAudit()
    ok('操作: 案件の削除は、消す前の名前で残る', p2.label === '案件の削除' && p2.target_name === `${PFX} 案件2`, p2)
  } else ok('操作: 案件を削除できる（前提）', false, del)
  const n = must(await admin.post('/api/admin/notices', { title: `${PFX} お知らせ`, body: '本文', target_type: 'all', importance: 'normal', client_request_id: PFX + 'n1' }), 'お知らせの配信')
  const [n1] = await lastAudit()
  ok('操作: お知らせの配信が件名つきで残る', n1.category === 'notice' && n1.label === 'お知らせの配信' && Number(n1.target_id) === Number(n.notice_id) && n1.target_name === `${PFX} お知らせ`, n1)
  must(await admin.post(`/api/admin/notices/${n.notice_id}/withdraw`, { reason: '誤り' }), 'お知らせの取り下げ')
  const [n2] = await lastAudit()
  ok('操作: お知らせの取り下げ（理由つき）', n2.label === 'お知らせの取り下げ' && n2.target_name === `${PFX} お知らせ` && detailOf(n2)['理由'] === '誤り', n2)
  // 下書きは削除できる（消す前の件名で残る）
  const dr = must(await admin.post('/api/admin/notices', { mode: 'draft', title: `${PFX} 下書き`, body: '本文', target_type: 'all', importance: 'normal', client_request_id: PFX + 'n2' }), '下書き')
  const [d1] = await lastAudit()
  ok('操作: お知らせの下書きの保存', d1.label === 'お知らせの下書きの保存', d1)
  const nd = await admin.del(`/api/admin/notices/${dr.notice_id}`)
  const [n3] = await lastAudit()
  ok('操作: お知らせの削除は、消す前の件名で残る', nd.status === 200 && n3.label === 'お知らせの削除' && n3.target_name === `${PFX} 下書き`, { status: nd.status, n3 })
}

// ---------- 3. 「操作の記録」の一覧 ----------
{
  // シフトの操作（operation_logs）を1件作る
  const projects = must(await admin.get('/api/admin/projects'), '案件').projects
  const proj = projects.find(p => p.status === 'active') || projects[0]
  const sh = await admin.post('/api/admin/shifts', { staff_id: own.staff_id, project_id: proj.project_id, work_date: '2016-03-01', start_time: '10:00', end_time: '18:00', status: 'confirmed' })
  const list = must(await admin.get('/api/admin/audit-logs'), '一覧')
  const items = list.items
  const sorted = items.every((x, i) => i === 0 || items[i - 1].at >= x.at)
  ok('一覧: 新しい順に出る', sorted, items.slice(0, 5).map(x => x.at))
  ok('一覧: CSV の書き出し・管理の操作が、種類・操作・操作した人・内容つきで出る',
    items.some(x => x.src === 'a' && x.category === 'csv' && x.lines.some(l => l.startsWith('ファイル: ')) && x.lines.some(l => l.startsWith('行数: ')))
    && items.some(x => x.src === 'a' && x.label === 'スタッフの情報の変更' && x.changes.some(c => c.l === 'メモ') && x.actor && x.actor_role === '会社管理者'), items.slice(0, 3))
  ok('一覧: 口座の変更は「変更あり」の印だけ', items.some(x => x.label === '従業員の情報の変更' && x.changes.some(c => c.f === 'account_number' && c.s === 1 && c.a === undefined)))
  ok('一覧: ログインの履歴もまとめて出る（ログインの成功・ID・端末）', items.some(x => x.src === 'l' && x.category === 'login' && /^ログイン（成功）$/.test(x.label) && x.lines.some(l => l.startsWith('ID: '))), items.filter(x => x.src === 'l').slice(0, 2))
  ok('一覧: 管理者が行ったログインの強制終了はログインの欄に重ねて出さない（管理者・ログインの発行の欄に出る）',
    !items.some(x => x.src === 'l' && /強制終了/.test(x.label)) && items.some(x => x.src === 'a' && x.label === 'スタッフのログインの強制終了'))
  if (sh.status === 200) {
    const s = must(await admin.get('/api/admin/audit-logs?kind=shift'), 'シフト・精算')
    ok('一覧: シフト・精算の操作履歴（#159）も出る（種類「シフト・精算」で絞れる。日付・スタッフ・案件）',
      s.items.length > 0 && s.items.every(x => x.category === 'shift') && s.items.some(x => x.src === 'o' && /^シフト: 登録$/.test(x.label) && (x.target || '').includes('2016-03-01')), s.items.slice(0, 2))
  } else ok('シフトを作れる（前提）', false, sh)
  for (const kind of ['csv', 'staff', 'admin', 'settings', 'master', 'notice', 'login']) {
    const r = must(await admin.get(`/api/admin/audit-logs?kind=${kind}`), kind)
    ok(`一覧: 種類（${kind}）で絞れる`, r.items.length > 0 && r.items.every(x => x.category === kind), r.items.slice(0, 2).map(x => [x.category, x.label]))
  }
  const byField = must(await admin.get('/api/admin/audit-logs?actor=2'), '人で絞る')
  ok('一覧: 操作した人で絞れる（現場管理者の日報の CSV とログインだけ）', byField.items.length > 0 && byField.items.every(x => x.actor === '藤田 現場長'), byField.items.slice(0, 3).map(x => [x.actor, x.label]))
  const empty = must(await admin.get('/api/admin/audit-logs?from=2015-01-01&to=2015-01-31'), '期間')
  ok('一覧: 期間で絞れる（記録のない期間は空）', empty.items.length === 0 && empty.next_cursor === null)
  const opts = must(await admin.get('/api/admin/audit-logs/options'), '選択肢')
  ok('一覧: 絞り込みの選択肢（種類・自社の管理者）', opts.categories.length === 8 && opts.actors.some(a => a.name === '藤田 現場長') && opts.actors.every(a => a.role_label !== 'スタッフ'), opts)
  for (const bad of ['kind=nope', 'from=2026-1-1', 'cursor=abc', 'from=2026-02-01&to=2026-01-01']) {
    const r = await admin.get(`/api/admin/audit-logs?${bad}`)
    ok(`一覧: 正しくない条件（${bad}）は 400`, r.status === 400 && r.data?.error, r.status)
  }
}
{
  // ページ送り: 同じ秒の行を3つの表にまたがって入れ、抜け・重なりがないこと（2016-01-05 の日付で分ける）
  const at = '2016-01-05 10:00:00'
  const vals = []
  for (let i = 0; i < 40; i++) vals.push(`(1, 1, 'company_admin', 'csv', 'export', 'W31 ページ送り ${i}', '${at}')`)
  const utc = '2016-01-05T01:00:00.'
  const lv = []
  for (let i = 0; i < 40; i++) lv.push(`(1, 1, 'sample', 'admin', 'login', 'success', 'password', '198.51.100.1', 'Mozilla/5.0', NULL, '${utc}${String(i).padStart(3, '0')}Z')`)
  // 同じ DB で流し直したときのために、前の回の行を消してから入れる
  await sql(`DELETE FROM operation_logs WHERE op_key LIKE 'w31pg%'; DELETE FROM audit_logs WHERE label LIKE 'W31 ページ送り%';
    DELETE FROM login_events WHERE company_id = 1 AND created_at LIKE '2016-01-05T01:00:00.%';
    INSERT INTO audit_logs (company_id, actor_user_id, actor_role, category, action, label, created_at) VALUES ${vals.join(', ')};
    INSERT INTO login_events (company_id, user_id, company_code, user_code, event_type, result, method, ip, user_agent, actor_user_id, created_at) VALUES ${lv.join(', ')};
    INSERT INTO operation_logs (company_id, entity, entity_id, staff_id, action, before_json, after_json, actor_user_id, op_key, created_at)
      VALUES (1, 'shift', 999001, NULL, 'update', '{"work_date":"2016-01-05"}', '{"work_date":"2016-01-06"}', 1, 'w31pg1', '${at}'),
             (1, 'shift', 999002, NULL, 'update', '{"work_date":"2016-01-05"}', '{"work_date":"2016-01-07"}', 1, 'w31pg1', '${at}'),
             (1, 'shift', 999003, NULL, 'delete', '{"work_date":"2016-01-05"}', NULL, 1, 'w31pg2', '${at}');`)
  const keys = []
  let cursor = null, pages = 0
  do {
    const r = must(await admin.get(`/api/admin/audit-logs?${q({ from: '2016-01-05', to: '2016-01-05', cursor })}`), 'ページ送り')
    keys.push(...r.items.map(x => x.key))
    cursor = r.next_cursor; pages++
  } while (cursor && pages < 10)
  ok('ページ送り: 同じ秒の行（記録 40・ログイン 40・シフトの操作 2）が、50件ずつ抜け・重なりなく出る', keys.length === 82 && new Set(keys).size === 82 && pages === 2, { n: keys.length, uniq: new Set(keys).size, pages })
  ok('ページ送り: まとめての操作（op_key が同じ2行）は1件として出る', keys.filter(k => k.startsWith('o')).length === 2)
  const first = must(await admin.get(`/api/admin/audit-logs?${q({ from: '2016-01-05', to: '2016-01-05', kind: 'shift' })}`), 'まとめて')
  ok('ページ送り: まとめての操作の件数を添える', first.items.some(x => x.lines.some(l => l.includes('まとめての操作（2件）'))), first.items)
}
{
  // CSV で書き出す（その書き出しも残る）
  const before = await auditCount()
  const r = await fetch(`${BASE}/api/admin/audit-logs/export?${q({ kind: 'settings' })}`, { headers: { Cookie: adminCk } })
  const text = await r.text()
  const [a] = await lastAudit()
  ok('CSV: 操作の記録を CSV で書き出せる（見出し・設定の行）', r.status === 200 && text.replace(/^\uFEFF/, '').startsWith('日時,種類,操作,操作した人,ロール,対象,内容,変わった項目,接続元') && text.includes('勤怠の設定（遅刻の猶予）'), text.slice(0, 300))
  ok('CSV: 操作の記録の書き出しも記録に残る', (await auditCount()) === before + 1 && a.label === '操作の記録の CSV' && detailOf(a).filters?.kind === 'settings', a)
  ok('CSV: 現場管理者は操作の記録の CSV を書き出せない', (await field.get('/api/admin/audit-logs/export')).status === 403)
}
{
  // 画面で作る CSV の記録
  must(await admin.post('/api/admin/export-logs', { kind: 'billing', file: 'billing_2026-10.csv', rows: 12, filters: { month: '2026-10' } }), '請求前確認の CSV')
  const [a] = await lastAudit()
  ok('画面で作る CSV: 請求前確認の CSV を書き出したことが残る', a.category === 'csv' && a.label === '請求前確認の CSV' && detailOf(a).rows === 12 && detailOf(a).filters?.month === '2026-10', a)
  ok('画面で作る CSV: 現場管理者の書き出しも残せる（4ロール）', (await field.post('/api/admin/export-logs', { kind: 'roster_logins', rows: 3 })).status === 200)
  ok('画面で作る CSV: 知らない種類は 400', (await admin.post('/api/admin/export-logs', { kind: 'x' })).status === 400)
  const a1 = read('public/static/admin.js'), r1 = read('public/static/roster.js')
  ok('画面で作る CSV: 請求前確認・ログイン案内の書き出しから知らせる', a1.includes("logClientExport('billing'") && r1.includes("logClientExport('roster_logins'"))
}

// ---------- 4. 本部 ----------
{
  const hb = Number((await sql(`SELECT COUNT(*) AS n FROM hq_audit_logs WHERE action LIKE 'audit_logs.%'`))[0].n)
  const r = must(await hq.get('/api/hq/companies/1/audit-logs'), '本部の一覧')
  ok('本部: 企業詳細から同じ記録を見られる', r.items.length > 0 && r.items.some(x => x.label === 'スタッフの情報の変更'))
  const r2 = must(await hq.get(`/api/hq/companies/1/audit-logs?${q({ cursor: r.next_cursor })}`), '本部の続き')
  const exp = await fetch(`${BASE}/api/hq/companies/1/audit-logs/export`, { headers: { Cookie: hqCk } })
  await exp.text()
  const rows = await sql(`SELECT action, company_id, actor_user_id FROM hq_audit_logs WHERE action LIKE 'audit_logs.%' ORDER BY log_id DESC LIMIT 2`)
  const ha = Number((await sql(`SELECT COUNT(*) AS n FROM hq_audit_logs WHERE action LIKE 'audit_logs.%'`))[0].n)
  ok('本部: 見たこと（1ページ目）と書き出したことが本部の操作の履歴に残る（続きのページでは残さない）',
    ha === hb + 2 && rows[0].action === 'audit_logs.export' && rows[1].action === 'audit_logs.view' && Number(rows[0].company_id) === 1 && Number(rows[0].actor_user_id) === 100 && exp.status === 200 && Array.isArray(r2.items), { hb, ha, rows })
  ok('本部: 会社の管理者は本部の API を使えない', (await admin.get('/api/hq/companies/1/audit-logs')).status === 403)
  ok('本部: ない企業は 404', (await hq.get('/api/hq/companies/999999/audit-logs')).status === 404)
  const hqJs = read('public/static/hq.js')
  ok('本部の画面: 企業詳細に「企業の操作の記録」の欄があり、開いたときに読む', hqJs.includes('data-action="hqAuditLogsOpen"') && hqJs.includes("'audit_logs.view': '企業の操作の記録の閲覧'"))
  // 本部の閲覧中の書き出しは、その企業の記録に「本部」で残る
  must(await admin.put('/api/admin/hq-access', { allowed: true }), '本部の閲覧の許可')
  const vs = await fetch(`${BASE}/api/hq/view-sessions`, { method: 'POST', headers: { Cookie: hqCk, 'Content-Type': 'application/json' }, body: JSON.stringify({ company_id: 1, reason: '操作の記録の確認', minutes: 30 }) })
  const viewCk = (vs.headers.getSetCookie?.() || []).map(s => s.split(';')[0]).find(s => s.startsWith('hq_view='))
  if (vs.status === 200 && viewCk) {
    const r3 = await fetch(`${BASE}/api/admin/corrections/export`, { headers: { Cookie: `${hqCk}; ${viewCk}`, 'X-HQ-View': '1' } })
    await r3.text()
    const [a] = await lastAudit()
    ok('本部の閲覧中: 書き出しも、その企業の記録に「本部」として残る', r3.status === 200 && a.actor_role === 'system_admin' && Number(a.actor_user_id) === 100 && a.label === '打刻修正の申請の CSV', { status: r3.status, a })
    const it = must(await admin.get('/api/admin/audit-logs?kind=csv'), '本部の行').items[0]
    ok('本部の閲覧中: 一覧では「本部（名前）」と出る', it.hq === true && /^本部/.test(it.actor), it)
    await fetch(`${BASE}/api/hq/view-sessions/current`, { method: 'DELETE', headers: { Cookie: `${hqCk}; ${viewCk}` } })
  } else ok('本部の閲覧を始められる（前提）', false, { status: vs.status })
}

// ---------- 5. 保存の期間・解約の削除 ----------
{
  await sql(`INSERT INTO audit_logs (company_id, actor_user_id, actor_role, category, action, label, created_at) VALUES (1, 1, 'company_admin', 'csv', 'export', 'W31 古い記録', '2001-01-01 00:00:00')`)
  const sc = await fetch(`${BASE}/__scheduled?cron=0+18+*+*+*`)
  await sc.text()
  await waitServer()
  const left = await sql(`SELECT COUNT(*) AS n FROM audit_logs WHERE label = 'W31 古い記録'`)
  const recent = await sql(`SELECT COUNT(*) AS n FROM audit_logs WHERE company_id = 1 AND created_at >= '${today}'`)
  ok('保存の期間: 1年を過ぎた記録は毎日の cron（auth_purge）で消え、1年以内の記録は残る', sc.status === 200 && Number(left[0].n) === 0 && Number(recent[0].n) > 10, { status: sc.status, left, recent })
  const ret = read('src/services/retention.ts')
  ok('解約の削除（OFFBOARDING_TABLES）と退職後の削除の対象に audit_logs がある', ret.includes("{ target: 'audit_logs', label: '操作の記録', table: 'audit_logs', where: OB_CO }") && ret.includes("DELETE FROM audit_logs WHERE target_type = 'staff' AND target_id = ?"))
  const runs = await sql(`SELECT result_json FROM cron_runs WHERE job = 'auth_purge' ORDER BY run_id DESC LIMIT 1`).catch(() => [])
  if (runs.length) ok('保存の期間: cron の結果に消した操作の記録の件数が出る', /"audit_logs":\s*\d+/.test(String(runs[0].result_json || '')), runs[0])
}

// ---------- 6. 画面 ----------
const CHROME = process.env.CHROME || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p))
async function browserChecks() {
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const PORT = await (await import('./lib/chrome.mjs')).freePort()
  const prof = mkdtempSync(join(tmpdir(), 'w31a-ch-'))
  const chrome = await (await import('./lib/chrome.mjs')).launchChrome(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1280,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  try {
    let tabs
    for (let i = 0; i < 60 && !tabs; i++) { await wait(300); tabs = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json()).catch(() => null) }
    const pg = tabs && tabs.find(t => t.type === 'page')
    if (!pg) { ok('（前提）ヘッドレスの Chrome を起動', false); return }
    ws = new WebSocket(pg.webSocketDebuggerUrl)
    await new Promise(r => ws.onopen = r)
    let id = 0; const pend = new Map(); let errors = []
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.onmessage = e => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: false })
    }
    const ev = async (expr) => { const x = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return x.result?.exceptionDetails ? { __error: x.result.exceptionDetails.exception?.description || x.result.exceptionDetails.text } : x.result?.result?.value }
    const until = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr) === true) return true; await wait(200) } return false }
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return
      const r = await send('Page.captureScreenshot', { format: 'png' })
      if (r.result?.data) writeFileSync(join(process.env.SHOT_DIR, `w31-audit-${name}.png`), Buffer.from(r.result.data, 'base64'))
    }
    const as = async (cookie) => { await send('Network.clearBrowserCookies'); const [n, ...v] = cookie.split('='); await send('Network.setCookie', { name: n, value: v.join('='), url: BASE }) }
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')
    for (const w of [1280, 390]) {
      errors = []
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 })
      await as(adminCk)
      await send('Page.navigate', { url: `${BASE}/admin#audit-logs` })
      const drawn = await until(`!!document.querySelector('#audit-list li') && !!document.querySelector('[data-action="auditKind"][data-kind="csv"]')`, 40000)
      ok(`画面 ${w}px: 管理画面の「操作の記録」が描ける（種類のボタン・一覧）`, drawn)
      if (drawn) {
        await ev(`document.querySelector('[data-action="auditKind"][data-kind="csv"]').click(); true`)
        const filtered = await until(`(() => { const b = [...document.querySelectorAll('#audit-list li .badge')]; return b.length > 0 && b.every(x => x.textContent.includes('CSV')) })()`, 15000)
        ok(`画面 ${w}px: 種類（CSV・ファイル）を押すと絞り込まれる`, filtered)
        const p = await ev(`(() => { const s = document.scrollingElement; return { sw: s.scrollWidth, cw: document.documentElement.clientWidth } })()`)
        ok(`画面 ${w}px: ページ全体が横にスクロールしない`, p && p.sw <= p.cw + 1, p)
        await shot(`admin-${w}`)
      }
      ok(`画面 ${w}px: スクリプトのエラーがない`, errors.length === 0, errors)
    }
    errors = []
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await as(hqCk)
    await send('Page.navigate', { url: `${BASE}/hq#companies/1` })
    if (await until(`!!document.querySelector('[data-action="hqAuditLogsOpen"]')`, 30000)) {
      await ev(`document.querySelector('[data-action="hqAuditLogsOpen"]').click(); true`)
      ok('画面: 本部の企業詳細で「企業の操作の記録」を開ける', await until(`!!document.querySelector('#hq-co-audit-logs #audit-list li')`, 20000))
      await ev(`document.getElementById('hq-co-audit-logs').closest('section').scrollIntoView(); true`)
      await wait(300)
      await shot('hq')
    } else ok('画面: 本部の企業詳細に「記録を開く」がある', false)
    ok('画面: 本部の企業詳細でスクリプトのエラーがない', errors.length === 0, errors)
  } finally {
    try { ws && ws.close() } catch { }
    try { chrome.kill() } catch { }
    await new Promise(r => setTimeout(r, 500))
    try { rmSync(prof, { recursive: true, force: true }) } catch { }
  }
}
if (!CHROME || typeof WebSocket !== 'function') console.log('SKIP  画面の確認（ヘッドレスの Chrome が見つかりません。CHROME=<パス> で指定できます）')
else await browserChecks()

try { rmSync(SQL_DIR, { recursive: true, force: true }) } catch { }
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
