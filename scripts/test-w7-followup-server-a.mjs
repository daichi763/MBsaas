// 持ち越しの仕上げ（作業単位 w7-followup-server-a）の統合テスト
//   #9001 企業間連携の共有範囲（生年月日・備考を渡さず年代を渡す・同意 v3）/ #162 連携を終了した行 / #552 企業の切り替えの履歴 / #286 最後の利用
//   #293 本部の閲覧中はトークンを返さない / #513 終了した募集の問い合わせ先 / #225 止めた応募の件数 / #300 スタッフアプリの応募の質問
//   #87 退職者の未対応の応募 / #151 応募の結果のメールの状態 / #155 シフトの変更日時・まとめて外したときの知らせ / #158 日報コメントの既読
//   #344 日報の未提出の一覧 / #387 本部で作る会社コード / #295 前月の請求の自動の記録 / #9002 退職後7年の削除・解約企業の削除で Sprint 5 の表が消えること
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8810 --persist-to <保存先> --test-scheduled --var RETENTION_ENABLED:true で起動していること。
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w7-followup-server-a.mjs
//   PERSIST はローカルの D1 を直接読み書きする確認（応募の件数・退職・削除）に使う。指定しなければその部分は SKIP。
//   本番には接続しない（wrangler d1 execute は --local のみ）。退職後7年の削除（cron）を実行するので、テスト用の DB で行うこと。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED', 'UND_ERR_SOCKET'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
let sqlSeq = 0, SQL_DIR = ''
function sql(command) {
  SQL_DIR = SQL_DIR || mkdtempSync(join(tmpdir(), 'w7fa-'))
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out).map(x => x.results)
}
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
const skip = (name) => console.log(`SKIP  ${name}（PERSIST 未指定）`)

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await rawLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}
// Cookie を受け取り直す（本部の閲覧の Cookie・企業の切り替え）
function client(cookie) {
  const jar = new Map(String(cookie || '').split('; ').filter(Boolean).map(kv => [kv.split('=')[0], kv]))
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: [...jar.values()].join('; '), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    for (const sc of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = sc.split(';')[0]; const name = kv.split('=')[0]
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || kv === `${name}=`) jar.delete(name); else jar.set(name, kv)
    }
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { jar, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
// 所属区分の変更（影響の確認 → 確認した内容で実行）
async function changeAffiliation(api, id, body) {
  const d = await api.post(`/api/admin/staff/${id}/affiliation-change`, { ...body, dry_run: true })
  if (d.status !== 200) return d
  return api.post(`/api/admin/staff/${id}/affiliation-change`, { ...body, preview_token: d.data.preview_token })
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString()
const today = jstNow().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const ageGroup = (dob) => { const [ty, tm, td] = today.split('-').map(Number); const [by, bm, bd] = dob.split('-').map(Number); let a = ty - by; if (tm < bm || (tm === bm && td < bd)) a--; return `${Math.floor(a / 10) * 10}代` }
const PFX = 'FA' + Date.now().toString(36).slice(-4).toUpperCase()
const pfx = PFX.toLowerCase()
let phoneSeq = 0
const newPhone = () => '080' + String((Date.now() + phoneSeq++ * 7919) % 100000000).padStart(8, '0')

const admin = client(await login('sample', 'admin'))
const hq = client(await login('', 'hq'))
const pub = client('')

// ---------- #387 本部で作る会社コードは全角・大文字をそろえて保存する ----------
const codeA = `${pfx}a`
{
  const typed = codeA.toUpperCase().replace(/[A-Z0-9]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xFEE0)) // 全角の大文字で入力
  const r = await hq.post('/api/hq/companies', { company_code: typed, company_name: `${PFX}連携先A`, admin_code: 'admin', admin_password: 'pass1234' })
  ok('#387 全角・大文字で入力した会社コードは、半角の小文字で保存される（そのコードでログインできる）', r.status === 200 && (await rawLogin(codeA, 'admin')).status === 200, r)
  const dup = await hq.post('/api/hq/companies', { company_code: codeA.toUpperCase(), company_name: '重複', admin_code: 'admin', admin_password: 'pass1234' })
  ok('#387 大文字・小文字の違いだけの会社コードは重複として 409', dup.status === 409, dup)
}
const A = client(await login(codeA, 'admin'))

// ---------- #9001 企業間連携の共有範囲 ----------
const terms = must(await admin.get('/api/admin/roster/consent-terms'), 'terms')
ok('#9001 同意の版は v3。共有する範囲に生年月日・備考がなく、年代がある', terms.version === 'v3' && !terms.shared.some(s => /生年月日・年齢|^備考/.test(s)) && terms.shared.some(s => /年代/.test(s))
  && terms.not_shared.includes('生年月日') && terms.not_shared.some(s => /備考/.test(s)), terms)
const DOB = '1990-04-01'
const xr = must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 連携X`, kana: 'レンケイ エックス', gender: 'male', date_of_birth: DOB,
  user_code: `${PFX}X`, password: 'pass1234', force: true }), 'staff X')
const X = { staff_id: xr.staff_id, code: xr.global_staff_code }
must(await admin.put(`/api/admin/staff/${X.staff_id}`, { remarks: `${PFX}の備考（所属元だけ）`, skills: '販売', pr_points: '明るい' }), 'remarks')
const oldVer = await A.post('/api/admin/roster/link', { code: X.code, agreed: true, consent_version: 'v2' })
ok('#9001 古い版（v2）の同意では連携できない（409。画面を読み直す）', oldVer.status === 409, oldVer)
const inA = must(await A.post('/api/admin/roster/link', { code: X.code, agreed: true, consent_version: terms.version }), 'link A').staff_id
{
  const p = must(await A.get(`/api/admin/staff/${inA}`), 'A detail').profile
  ok('#9001 連携先のスタッフ詳細に生年月日・年齢・備考を返さない', p.date_of_birth == null && p.age == null && p.remarks == null, { dob: p.date_of_birth, age: p.age, remarks: p.remarks })
  ok('#9001 連携先には年代（所属元の生年月日から計算）を返す', p.age_group === ageGroup(DOB), p.age_group)
  ok('#9001 共有する項目（フリガナ・スキル・PR）は今までどおり見える', p.kana === 'レンケイ エックス' && p.skills === '販売' && p.pr_points === '明るい', p)
  ok('#286 スタッフ詳細に最後にアプリを使った日時（app_last_used_at）の項目がある', Object.prototype.hasOwnProperty.call(p, 'app_last_used_at'), Object.keys(p).length)
  const sheet = must(await A.get(`/api/admin/staff/${inA}/skill-sheet`), 'A sheet').profile
  ok('#9001 連携先のスキルシートにも生年月日・年齢・備考がなく、年代がある', sheet.date_of_birth == null && sheet.age == null && sheet.remarks == null && sheet.age_group === ageGroup(DOB), sheet)
  const list = must(await A.get('/api/admin/staff'), 'A list').staff.find(s => s.staff_id === inA)
  ok('#9001 連携先のスタッフ一覧に生年月日・備考を返さない', list && list.date_of_birth === undefined && list.remarks === undefined, list)
  const own = must(await admin.get(`/api/admin/staff/${X.staff_id}`), 'own detail').profile
  ok('#9001 所属元では今までどおり生年月日・年齢・備考が見える', own.date_of_birth === DOB && own.age > 0 && own.remarks === `${PFX}の備考（所属元だけ）`, own)
  const rec = must(await A.get(`/api/admin/roster/${inA}/links`), 'consents')
  ok('#9001 連携先の同意履歴には v3 の版が残る', (rec.consents || []).some(x => x.consent_version === 'v3'), rec)
}
// 本人（スタッフ X）が連携先の企業に切り替えても、自分の生年月日は見える。切り替えはログインの履歴に残る（#552）
{
  const xs = client(await login('sample', `${PFX}X`))
  const cos = must(await xs.get('/api/staff/me/companies'), 'companies').companies
  const coA = cos.find(c => c.company_name === `${PFX}連携先A`)
  const sw = coA ? await xs.post('/api/staff/me/switch-company', { company_id: coA.company_id }) : null
  ok('（前提）本人は連携先の企業に切り替えられる', sw && sw.status === 200, sw)
  const me = must(await xs.get('/api/staff/me/profile'), 'me profile').profile
  ok('#9001 本人は連携先の企業に切り替えても、自分の生年月日を見られる', me.affiliation_type === 'linked_external' && me.date_of_birth === DOB, { t: me.affiliation_type, dob: me.date_of_birth })
  const h = must(await hq.get(`/api/hq/login-history?company_id=${coA.company_id}`), 'login history')
  ok('#552 企業の切り替えをログインの履歴に残す（切り替え先の企業・switch_company）', (h.events || []).some(e => e.event_type === 'switch_company' && e.result === 'success'), (h.events || []).slice(0, 3))
}
// #162 所属元が連携を終了したら、連携先の区分変更で所属元の値（生年月日・備考を含む）をコピーしない
{
  must(await admin.post(`/api/admin/roster/${X.staff_id}/links/${inA}/end`, {}), 'end link')
  const p = must(await A.get(`/api/admin/staff/${inA}`), 'A detail after end').profile
  ok('#162 連携を終了した後は、連携先で所属元のスキル・年代を返さない', !p.skills && !p.age_group && p.date_of_birth == null, p)
  const ch = await changeAffiliation(A, inA, { to_type: 'daily_worker', effective_date: today })
  if (ch.status === 200) {
    const q = must(await A.get(`/api/admin/staff/${inA}`), 'A detail after change').profile
    ok('#162 連携を終了した行を自社管理に切り替えても、所属元の基本項目はコピーされない', !q.skills && !q.kana && q.date_of_birth == null && q.remarks == null, q)
  } else ok('#162 連携を終了した行の区分変更（受け付けないか、コピーしない）', ch.status >= 400 && ch.status < 500, ch)
}
// 連携中の行を自社管理に切り替えたときも、生年月日・備考はコピーせず年代だけを入れる
{
  const yr = must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 連携Y`, kana: 'レンケイ ワイ', gender: 'female', date_of_birth: '2001-12-31',
    user_code: `${PFX}Y`, password: 'pass1234', force: true }), 'staff Y')
  must(await admin.put(`/api/admin/staff/${yr.staff_id}`, { remarks: '所属元の備考Y' }), 'remarks Y')
  const inAY = must(await A.post('/api/admin/roster/link', { code: yr.global_staff_code, agreed: true, consent_version: terms.version }), 'link Y').staff_id
  const ch = await changeAffiliation(A, inAY, { to_type: 'daily_worker', effective_date: today })
  const q = ch.status === 200 ? must(await A.get(`/api/admin/staff/${inAY}`), 'Y after change').profile : null
  ok('#9001 連携中の行を自社管理に切り替えると、フリガナ・年代はコピーし、生年月日・備考はコピーしない',
    q && q.kana === 'レンケイ ワイ' && q.age_group === ageGroup('2001-12-31') && q.date_of_birth == null && !q.remarks, { status: ch.status, data: ch.data, q })
}

// ---------- 募集（#513 #225 #300 #87 #151） ----------
async function newProject(name) {
  must(await admin.post('/api/admin/projects', { project_name: name }), 'project ' + name)
  return must(await admin.get('/api/admin/projects'), 'projects').projects.find(p => p.project_name === name).project_id
}
async function newRoles(pid, date, start = '10:00', end = '18:00') {
  must(await admin.post('/api/admin/shift-slots', { project_id: pid, dates: [date], start_time: start, end_time: end, roles: [{ role_name: '販売', headcount: 3 }] }), 'slot')
  const b = must(await admin.get(`/api/admin/shift-board?from=${date}&to=${date}`), 'board')
  const slots = b.slots.filter(s => s.project_id === pid && s.start_time === start)
  return slots[slots.length - 1]
}
const pid = await newProject(`${PFX}-案件`)
const D = addDays(today, 5)
const slot = await newRoles(pid, D)
const roleId = slot.roles[0].slot_role_id
const page = must(await admin.post('/api/admin/recruit-pages', { title: `${PFX} 募集`, project_ids: [pid], date_from: today, date_to: addDays(today, 20), allow_staff: true, show_remaining: true,
  notify_staff: false, description: '集合は10分前', pay_note: '', contact_note: '担当 03-0000-0000',
  questions: [{ label: '販売の経験はありますか', type: 'yesno', required: true }] }), 'page')
// #300 スタッフアプリの応募でも質問に答える
const staffPhone = newPhone()
must(await admin.post('/api/admin/staff', { user_code: `${PFX}S`, name: `${PFX} 応募S`, password: 'pass1234', phone: staffPhone }), 'staff S')
const S = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}S`)
const sc = client(await login('sample', `${PFX}S`))
{
  const list = must(await sc.get('/api/staff/recruit'), 'staff recruit')
  const pg = list.pages.find(p => p.page_id === page.page_id)
  ok('#300 スタッフアプリの募集一覧に、募集ページの質問を返す', pg && pg.questions.length === 1 && pg.questions[0].required === true && pg.questions[0].type === 'yesno', pg && pg.questions)
  const miss = await sc.post('/api/staff/recruit/apply', { pages: [{ page_id: page.page_id, slot_role_ids: [roleId] }], answers_supported: true })
  ok('#300 質問に対応した画面（answers_supported）からは、必須の質問に答えないと 400（どの募集か page_id を返す）', miss.status === 400 && miss.data?.page_id === page.page_id && /販売の経験/.test(miss.data?.error || ''), miss)
  const bad = await sc.post('/api/staff/recruit/apply', { pages: [{ page_id: page.page_id, slot_role_ids: [roleId], answers: { q1: 'たぶん' } }], answers_supported: true })
  ok('#300 はい・いいえの質問に別の値は受け付けない（400）', bad.status === 400, bad)
  const good = await sc.post('/api/staff/recruit/apply', { pages: [{ page_id: page.page_id, slot_role_ids: [roleId], answers: { q1: 'yes' } }], answers_supported: true })
  ok('#300 質問に答えると応募できる', good.status === 200 && good.data?.count === 1, good)
  const apps = must(await admin.get('/api/admin/recruit-applications?status=pending'), 'apps').applications
  const mine = apps.find(a => a.staff_id === S.staff_id && a.page_id === page.page_id)
  ok('#300 スタッフアプリの応募にも回答が保存される', mine && mine.answers.length === 1 && mine.answers[0].value === 'はい', mine && mine.answers)
}
// #151 応募の結果のメールの状態を応募ごとに残す（公開ページからの応募・メールあり。ローカルはメールを送らない設定）
{
  const name = `${PFX} 公開応募`
  const r = await pub.post(`/api/public/recruit/${page.token}/apply`, { name, phone: newPhone(), email: `${pfx}@example.com`, agree: true, slot_role_ids: [roleId], issued_at: Date.now() - 10000, answers: { q1: 'no' } })
  ok('（前提）公開ページから応募できる', r.status === 200, r)
  const app = must(await admin.get('/api/admin/recruit-applications?status=pending'), 'apps').applications.find(a => a.name === name)
  const d = await admin.post(`/api/admin/recruit-applications/${app.application_id}/decide`, { reject: app.items.map(i => i.item_id), notify_applicant: true })
  ok('（前提）見送りにできる', d.status === 200, d)
  let st = null
  for (let i = 0; i < 10 && !(st && st !== 'queued'); i++) {
    const a2 = must(await admin.get('/api/admin/recruit-applications?status=all'), 'apps').applications.find(a => a.application_id === app.application_id)
    st = a2?.result_mail_status
    if (st === 'queued') await new Promise(r => setTimeout(r, 500))
  }
  ok('#151 応募の結果のメールの状態（result_mail_status）を応募に残す（メールを送らない環境では disabled）', ['disabled', 'sent', 'failed'].includes(st), st)
  const rs = await admin.post(`/api/admin/recruit-applications/${app.application_id}/notify-result`, {})
  const a3 = must(await admin.get('/api/admin/recruit-applications?status=all'), 'apps').applications.find(a => a.application_id === app.application_id)
  ok('#151 送り直しでも状態と日時を書き直す', rs.status === 200 && !!a3.result_mail_at && ['disabled', 'sent', 'failed'].includes(a3.result_mail_status), { rs: rs.data, st: a3.result_mail_status })
}
// #225 送信回数の制限で止めた件数をページごとに数える（同じ電話番号から1日3件まで）
if (PERSIST) {
  const phone = newPhone()
  sql(`INSERT INTO recruit_applications (company_id, page_id, source, name, phone, status, created_at)
    SELECT 1, ${page.page_id}, 'public', '${PFX} 回数', '${phone}', 'cancelled', '${jstNow().slice(0, 19).replace('T', ' ')}' FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3)`)
  const r = await pub.post(`/api/public/recruit/${page.token}/apply`, { name: `${PFX} 回数`, phone, agree: true, slot_role_ids: [roleId], issued_at: Date.now() - 10000, answers: { q1: 'yes' } })
  const pg = must(await admin.get('/api/admin/recruit-pages'), 'pages').pages.find(p => p.page_id === page.page_id)
  ok('#225 上限を超えた応募は 429 で、ページの止めた件数（blocked_count）と日時が増える', r.status === 429 && pg.blocked_count === 1 && !!pg.blocked_last_at, { status: r.status, n: pg.blocked_count })
} else skip('#225 止めた件数')
// #87 退職したスタッフの未対応の応募は、応募の一覧を開いたときに取り下げにする
if (PERSIST) {
  sql(`UPDATE staff_profiles SET employment_status = 'retired' WHERE staff_id = ${S.staff_id}`)
  const apps = must(await admin.get('/api/admin/recruit-applications?status=all'), 'apps').applications
  const a = apps.find(x => x.staff_id === S.staff_id && x.page_id === page.page_id)
  ok('#87 退職したスタッフの未対応の応募は取り下げ（cancelled）になる', a && a.status === 'cancelled' && a.items.every(i => i.status === 'cancelled'), a && { s: a.status, items: a.items.map(i => i.status) })
  sql(`UPDATE staff_profiles SET employment_status = 'working' WHERE staff_id = ${S.staff_id}`)
} else skip('#87 退職者の応募')
// #513 終了した募集の公開ページ（410）にも問い合わせ先を返す
{
  must(await admin.put(`/api/admin/recruit-pages/${page.page_id}`, { status: 'closed' }), 'close page')
  const r = await pub.get(`/api/public/recruit/${page.token}`)
  ok('#513 終了した募集の公開ページ（410）は問い合わせ先を返す', r.status === 410 && r.data?.contact_note === '担当 03-0000-0000', r)
}

// ---------- シフト（#155）と日報（#158 #344） ----------
const W = must(await admin.post('/api/admin/staff', { user_code: `${PFX}W`, name: `${PFX} 稼働W`, password: 'pass1234', phone: newPhone() }), 'staff W')
const Wrow = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}W`)
const wc = client(await login('sample', `${PFX}W`))
const D2 = addDays(today, 3)
{
  must(await admin.post('/api/admin/shifts', { staff_id: Wrow.staff_id, project_id: pid, work_date: D2, start_time: '10:00', end_time: '18:00' }), 'shift W')
  const s0 = must(await wc.get(`/api/staff/shifts?from=${D2}&to=${D2}`), 'W shifts').shifts.find(s => s.project_id === pid)
  ok('#155 登録したばかりのシフトは変更日時（staff_changed_at）が空', s0 && s0.staff_changed_at == null, s0)
  must(await admin.put(`/api/admin/shifts/${s0.shift_id}`, { start_time: '11:00', end_time: '18:00' }), 'change time')
  const s1 = must(await wc.get(`/api/staff/shifts?from=${D2}&to=${D2}`), 'W shifts').shifts.find(s => s.shift_id === s0.shift_id)
  ok('#155 時間を変えると、スタッフのシフト一覧に変更日時（staff_changed_at）が付く', s1 && s1.start_time === '11:00' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s1.staff_changed_at || ''), s1)
  const rel = must(await admin.post(`/api/admin/staff/${Wrow.staff_id}/release-future-shifts`, { from: today }), 'release')
  const n = must(await wc.get('/api/staff/notifications'), 'W notifications').notifications
  ok('#155 今後のシフトをまとめて外すと、本人に取消を知らせる', rel.removed >= 1 && n.some(x => x.kind === 'shift_cancelled'), { rel, kinds: n.map(x => x.kind) })
}
{
  // 昨日のシフト（日報なし）→ 未提出の一覧に出る。日報を出して管理者がコメント → 本人が開くと既読
  const Y = addDays(today, -1)
  must(await admin.post('/api/admin/shifts', { staff_id: Wrow.staff_id, project_id: pid, work_date: Y, start_time: '10:00', end_time: '18:00' }), 'shift Y')
  const miss = must(await admin.get(`/api/admin/daily-reports/missing?from=${addDays(Y, -2)}&to=${Y}&project_id=${pid}`), 'missing')
  const row = miss.missing.find(m => m.staff_id === Wrow.staff_id && m.work_date === Y)
  ok('#344 日報の未提出の一覧（期間・案件で絞る）に、日報のないシフトが出る', !!row && row.project_name === `${PFX}-案件`, miss)
  const bad = await admin.get(`/api/admin/daily-reports/missing?from=${addDays(Y, -100)}&to=${Y}`)
  ok('#344 期間が62日を超えると 400', bad.status === 400, bad)
  if (PERSIST) {
    sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, submitted_at) VALUES (1, ${Wrow.staff_id}, ${pid}, ${row.shift_id}, '${Y}', '{}', '${Y} 19:00:00')`)
    const miss2 = must(await admin.get(`/api/admin/daily-reports/missing?from=${Y}&to=${Y}&project_id=${pid}`), 'missing 2')
    ok('#344 日報を出すと未提出の一覧から消える', !miss2.missing.some(m => m.shift_id === row.shift_id), miss2)
    const dr = must(await admin.get(`/api/admin/daily-reports?date=${Y}&staff_id=${Wrow.staff_id}`), 'reports').reports[0]
    must(await admin.put(`/api/admin/daily-reports/${dr.daily_report_id}`, { manager_comment: 'よくできました' }), 'comment')
    const lst = must(await wc.get('/api/staff/my-reports'), 'my reports').reports.find(r => r.daily_report_id === dr.daily_report_id)
    ok('#158 本人の日報一覧に、まだ開いていないコメントの印（unread_comment）が出る', lst && lst.unread_comment === true && lst.comment_read_at == null, lst)
    const one = await wc.get(`/api/staff/my-reports/${dr.daily_report_id}`)
    ok('#158 日報1件を開ける（通知から開く）。開くとコメントが既読になる', one.status === 200 && one.data.report.manager_comment === 'よくできました' && !!one.data.report.comment_read_at, one)
    const adm = must(await admin.get(`/api/admin/daily-reports?date=${Y}&staff_id=${Wrow.staff_id}`), 'reports').reports[0]
    ok('#158 管理画面の日報一覧に、スタッフがコメントを開いた日時（comment_read_at）を返す', !!adm.comment_read_at, adm.comment_read_at)
    must(await admin.put(`/api/admin/daily-reports/${dr.daily_report_id}`, { manager_comment: '書き直しました' }), 'comment 2')
    const adm2 = must(await admin.get(`/api/admin/daily-reports?date=${Y}&staff_id=${Wrow.staff_id}`), 'reports').reports[0]
    ok('#158 コメントを書き直すと、スタッフの既読は外れる', adm2.comment_read_at == null, adm2.comment_read_at)
    const other = await client(await login('sample', `${PFX}S`)).get(`/api/staff/my-reports/${dr.daily_report_id}`)
    ok('#158 他人の日報は開けない（404）', other.status === 404, other.status)
  } else skip('#158 日報コメントの既読')
}

// ---------- #161 統合した取引先の名前で登録すると、統合先の取引先を使う ----------
// 統合した取引先の行は、まだ使われている（確定済みのシフトの支払先など）と統合済みの印を付けて残る。その状態を D1 に直接作って確かめる
if (PERSIST) {
  const p1 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}取引先旧` }), 'partner 1').affiliation_id
  const p2 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}取引先新` }), 'partner 2').affiliation_id
  const mk = async (k) => { must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} ${k}`, password: 'pass1234', phone: newPhone() }), 'staff ' + k); return must(await admin.get('/api/admin/staff'), 'list').staff.find(s => s.user_code === `${PFX}${k}`).staff_id }
  const s2 = await mk('P2')
  sql(`UPDATE staff_affiliations SET merged_into_id = ${p2} WHERE affiliation_id = ${p1} AND company_id = 1`)
  const c2 = await changeAffiliation(admin, s2, { to_type: 'partner_manual', new_partner_name: `${PFX}取引先旧`, effective_date: today })
  const d2 = must(await admin.get(`/api/admin/staff/${s2}`), 'detail').profile
  ok('#161 統合した取引先の名前を入力しても、統合先の取引先に付ける（統合済みの行を使わない）', c2.status === 200 && d2.partner_affiliation_id === p2, { status: c2.status, data: c2.data, pa: d2.partner_affiliation_id, p1, p2 })
  const c3 = await changeAffiliation(admin, s2, { to_type: 'daily_worker', effective_date: today })
  const c4 = c3.status === 200 ? await changeAffiliation(admin, s2, { to_type: 'partner_manual', partner_affiliation_id: p1, effective_date: today }) : c3
  const d4 = must(await admin.get(`/api/admin/staff/${s2}`), 'detail').profile
  ok('#161 統合した取引先の ID を選んでも、統合先の取引先に付ける', c4.status === 200 && d4.partner_affiliation_id === p2, { status: c4.status, data: c4.data, pa: d4.partner_affiliation_id })
} else skip('#161 統合した取引先')

// ---------- #293 本部の閲覧中は、報告用URLのトークンを返さない ----------
{
  must(await admin.put('/api/admin/hq-access', { allowed: true }), 'allow hq view')
  const r = await hq.post('/api/hq/view-sessions', { company_id: 1, reason: '報告の設定の確認', minutes: 15 })
  ok('（前提）本部が閲覧を始められる', r.status === 200, r)
  const shiftId = must(await admin.get(`/api/admin/staff/${Wrow.staff_id}`), 'W detail').shifts.find(s => s.work_date === addDays(today, -1))?.shift_id
  const link = await admin.post(`/api/admin/shifts/${shiftId}/report-link`, {})
  ok('（前提）報告用URLを発行できる', link.status === 200 && !!link.data?.token, link)
  const asAdmin = must(await admin.get(`/api/admin/shifts/${shiftId}/report-status`), 'report-status admin')
  const asHq = await hq.get(`/api/admin/shifts/${shiftId}/report-status`)
  const tk = asAdmin.token?.token
  ok('#293 企業の管理者には報告用URLのトークンを返す', typeof tk === 'string' && tk.length >= 16, asAdmin.token)
  ok('#293 本部の閲覧中は、同じ API でもトークンを返さない（null）', asHq.status === 200 && asHq.data.token?.token === null && asHq.data.shift_id === shiftId && !asHq.text.includes(tk), { status: asHq.status, token: asHq.data?.token })
  await hq.del('/api/hq/view-sessions/current')
  must(await admin.put('/api/admin/hq-access', { allowed: false }), 'disallow hq view')
}

// ---------- #295 前月の請求の自動の記録 / #9002 削除で Sprint 5 の表が消えること ----------
async function cron(expr) {
  await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent(expr).replace(/%20/g, '+')}`)
  for (let i = 0; i < 30; i++) { try { const r = await fetch(`${BASE}/login`); if (r.ok) return } catch { } await new Promise(r => setTimeout(r, 1000)) }
}
// Sprint 5 で足した、スタッフ・シフトに結び付く表（退職後7年の削除・解約企業の削除の対象）
const S5_TABLES = ['payout_accounts', 'profile_change_requests', 'leave_requests', 'staff_availability', 'availability_submissions', 'employee_change_logs',
  'staff_schedule_tokens', 'staff_calendar_tokens', 'reminder_sends', 'staff_pay_requests', 'attendance_correction_attachments']
function seedS5(cid, staffId, userId, shiftId, tag) {
  return `
  INSERT INTO payout_accounts (company_id, staff_id, bank_code, branch_code, account_type, account_number, holder_kana) VALUES (${cid}, ${staffId}, '0001', '001', 'ordinary', '1234567', 'テスト');
  INSERT INTO profile_change_requests (company_id, staff_id, requester_user_id, requester_company_id, changes_json, created_at) VALUES (${cid}, ${staffId}, ${userId}, ${cid}, '{}', '2018-01-01 00:00:00');
  INSERT INTO leave_requests (company_id, staff_id, requester_user_id, leave_date, created_at) VALUES (${cid}, ${staffId}, ${userId}, '2017-12-01', '2017-11-01 00:00:00');
  INSERT INTO staff_availability (company_id, staff_id, work_date, status) VALUES (${cid}, ${staffId}, '2017-12-02', 'ok');
  INSERT INTO availability_submissions (company_id, staff_id, month, submitted_at, updated_at) VALUES (${cid}, ${staffId}, '2017-12', '2017-11-20', '2017-11-20');
  INSERT INTO employee_change_logs (company_id, staff_id, source, field, changed_at) VALUES (${cid}, ${staffId}, 'admin', 'bank_name', '2017-01-01');
  INSERT INTO staff_schedule_tokens (token_hash, company_id, staff_id, expires_at, created_at) VALUES ('${tag}-sched', ${cid}, ${staffId}, '2030-01-01', '2017-01-01');
  INSERT INTO staff_calendar_tokens (user_id, company_id, token_hash) VALUES (${userId}, ${cid}, '${tag}-cal');
  INSERT INTO reminder_sends (company_id, shift_id, staff_id, user_id, reminder_type, created_at) VALUES (${cid}, ${shiftId}, ${staffId}, ${userId}, 'check_in', '2017-12-03 08:00:00');
  INSERT INTO staff_pay_requests (company_id, shift_id, staff_id, kind, created_at) VALUES (${cid}, ${shiftId}, ${staffId}, 'transport', '2017-12-03 20:00:00');
  INSERT INTO attendance_corrections (company_id, project_id, shift_id, staff_id, kind, report_type, requested_at, reason, requested_by, status)
    SELECT ${cid}, project_id, shift_id, staff_id, 'add', 'check_in', work_date || ' 09:00:00', 'テスト', ${userId}, 'rejected' FROM shifts WHERE shift_id = ${shiftId};
  INSERT INTO attendance_correction_attachments (correction_id, company_id, staff_id, shift_id, photo_key) VALUES ((SELECT MAX(correction_id) FROM attendance_corrections WHERE shift_id = ${shiftId}), ${cid}, ${staffId}, ${shiftId}, '${tag}/photo.jpg');`
}
const countS5 = (where) => sql(S5_TABLES.map(t => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t} WHERE ${t === 'staff_calendar_tokens' ? `user_id IN (SELECT user_id FROM staff_profiles WHERE ${where})` : where};`).join('\n'))
  .map(r => r[0]).reduce((m, r) => (m[r.t] = r.n, m), {})
if (PERSIST) {
  // #295: 前月の記録を消してから、毎日の定期処理を動かす（1〜3日だけ記録する。それ以外の日は何もしない）
  const prevMonth = (() => { const d = new Date(today.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7) })()
  sql(`DELETE FROM company_billing_months WHERE month = '${prevMonth}' AND company_id = 1`)
  // 退職後7年の対象（自社のスタッフ。退職日 2018-01-01・猶予の印は8日前）と、その人の Sprint 5 の記録
  const tag = `${pfx}r`
  sql(`INSERT INTO users (company_id, user_code, name, role, password_hash, status, retired_at) VALUES (1, '${tag}', '${PFX} 退職者', 'staff', 'x', 'suspended', '2018-01-01');
    INSERT INTO staff_profiles (user_id, company_id, employment_status, retention_flagged_at) SELECT user_id, 1, 'retired', '${addDays(today, -8)}' FROM users WHERE company_id = 1 AND user_code = '${tag}';
    INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status)
      SELECT 1, sp.staff_id, ${pid}, '2017-12-03', '10:00', '18:00', 'confirmed' FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.company_id = 1 AND u.user_code = '${tag}';`)
  const [ids] = sql(`SELECT sp.staff_id, sp.user_id, (SELECT shift_id FROM shifts WHERE staff_id = sp.staff_id) AS shift_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.company_id = 1 AND u.user_code = '${tag}'`)
  const R = ids[0]
  sql(seedS5(1, R.staff_id, R.user_id, R.shift_id, tag))
  const before = countS5(`staff_id = ${R.staff_id}`)
  ok('（前提）退職者の Sprint 5 の表に1件ずつある', S5_TABLES.every(t => before[t] === 1), before)
  await cron('0 18 * * *')
  const after = countS5(`staff_id = ${R.staff_id}`)
  ok('#9002 退職後7年の削除で、Sprint 5 で足した表（口座・申請・休暇・出勤可能日・トークン・リマインド・交通費の申請・打刻修正の添付）が消える',
    S5_TABLES.every(t => after[t] === 0), after)
  const [pend] = sql(`SELECT COUNT(*) AS n FROM retention_pending_r2 WHERE photo_key = '${tag}/photo.jpg'`)
  ok('#9002 打刻修正の添付写真のキーは、R2 の削除の再試行のために控える（または削除済み）', pend[0].n <= 1, pend)
  const day = Number(today.slice(8, 10))
  const [jobs] = sql(`SELECT job, status FROM cron_runs WHERE job IN ('board_saved_search', 'billing_close') AND cron = '0 18 * * *' ORDER BY run_id DESC LIMIT 2`)
  ok('#479 #295 掲示板の保存した検索条件の知らせ・前月の請求の記録を毎日の定期処理に登録した', ['board_saved_search', 'billing_close'].every(j => jobs.some(x => x.job === j && x.status === 'ok')), jobs)
  await cron('*/15 * * * *')
  const [nj] = sql(`SELECT cron, status FROM cron_runs WHERE job = 'notice_scheduled_publish' ORDER BY run_id DESC LIMIT 1`)
  ok('#291 お知らせの予約配信のメールは15分おきの定期処理で動く', nj.length === 1 && nj[0].cron === '*/15 * * * *' && nj[0].status === 'ok', nj)
  const [bill] = sql(`SELECT COUNT(*) AS n FROM company_billing_months WHERE month = '${prevMonth}' AND company_id = 1`)
  const [run] = sql(`SELECT status, result_json FROM cron_runs WHERE job = 'billing_close' ORDER BY run_id DESC LIMIT 1`)
  ok(`#295 前月の請求の記録の定期処理（1〜3日は記録する。今日は${day}日）`, run.length === 1 && run[0].status === 'ok' && (day <= 3 ? bill[0].n === 1 : bill[0].n === 0), { bill: bill[0], run: run[0] })

  // 解約した企業の削除（停止 → 契約終了の登録（猶予を過ぎた日付）→ 書き出しを省いた理由を付けて削除）
  const codeD = `${pfx}d`
  must(await hq.post('/api/hq/companies', { company_code: codeD, company_name: `${PFX}解約企業`, admin_code: 'admin', admin_password: 'pass1234' }), 'company D')
  const [cd] = sql(`SELECT company_id FROM companies WHERE company_code = '${codeD}'`)
  const cid = cd[0].company_id
  sql(`INSERT INTO users (company_id, user_code, name, role, password_hash) VALUES (${cid}, 's1', '解約 スタッフ', 'staff', 'x');
    INSERT INTO staff_profiles (user_id, company_id) SELECT user_id, ${cid} FROM users WHERE company_id = ${cid} AND user_code = 's1';
    INSERT INTO projects (company_id, project_name) VALUES (${cid}, '解約案件');
    INSERT INTO shifts (company_id, staff_id, project_id, work_date, start_time, end_time, status)
      SELECT ${cid}, sp.staff_id, p.project_id, '2025-01-01', '10:00', '18:00', 'confirmed' FROM staff_profiles sp, projects p WHERE sp.company_id = ${cid} AND p.company_id = ${cid};`)
  const [di] = sql(`SELECT sp.staff_id, sp.user_id, (SELECT shift_id FROM shifts WHERE staff_id = sp.staff_id) AS shift_id FROM staff_profiles sp WHERE sp.company_id = ${cid}`)
  sql(seedS5(cid, di[0].staff_id, di[0].user_id, di[0].shift_id, `${pfx}d`))
  const b2 = countS5(`company_id = ${cid}`)
  ok('（前提）解約企業の Sprint 5 の表に1件ずつある', S5_TABLES.every(t => b2[t] === 1), b2)
  must(await hq.put(`/api/hq/companies/${cid}`, { active_status: 'inactive' }), 'inactive')
  must(await hq.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: addDays(today, -40), grace_days: 30, confirm_company_code: codeD }), 'start offboarding')
  const det = must(await hq.get(`/api/hq/offboarding/${cid}`), 'offboarding detail')
  ok('#9002 解約企業の削除の一覧に、企業の行を持つ表がすべて入っている（未対応の表なし）', Array.isArray(det.unknown_tables) && det.unknown_tables.length === 0, det.unknown_tables)
  let p = null, r = null
  for (let i = 0; i < 60; i++) {
    r = await hq.post(`/api/hq/offboarding/${cid}/delete`, { confirm_company_code: codeD, confirm_text: '削除する', export_skip_reason: 'テスト' })
    if (r.status !== 200) break
    p = r.data
    if (p.done || p.error) break
  }
  ok('#9002 解約企業の削除を最後まで進められる', r.status === 200 && p?.done === true, r)
  const a2 = countS5(`company_id = ${cid}`)
  ok('#9002 解約企業の削除で、Sprint 5 で足した表の行が消える', S5_TABLES.every(t => a2[t] === 0), a2)
  ok('#9002 削除の件数に Sprint 5 の表が記録される', ['payout_accounts', 'staff_pay_requests', 'reminder_sends', 'leave_requests'].every(t => p?.deleted?.[t] === 1), p?.deleted)
} else skip('#295 #9002 削除・請求の定期処理')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
