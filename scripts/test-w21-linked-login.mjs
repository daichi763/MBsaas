// 他社連携のスタッフのセッション・企業切替を自社だけに絞る（作業単位 w21-linked-login: #9940 #9941 #9942。D-53）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8780 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8780 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w21-linked-login.mjs
//   PERSIST を指定すると、メールのリンクでのパスワードの再設定（#9941）も確かめる（再設定のトークンをローカルの D1 に直接入れる）。
//   本番には接続しない（wrangler d1 execute は --local のみ）。テストのたびに DB を作り直すこと。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// wrangler d1 execute を待つ間に keep-alive の接続が切られることがあるため、接続エラーは1回だけやり直す
const baseFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await baseFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return baseFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8780'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
const skip = (name, why) => console.log(`SKIP  ${name}（${why}）`)
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

async function req(method, path, { cookie, body, headers = {} } = {}) {
  const r = await fetch(`${BASE}${path}`, { method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null; try { data = await r.json() } catch { }
  return { status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234', ua) {
  const r = await req('POST', '/api/auth/login', { body: { company_code, user_code, password }, headers: ua ? { 'User-Agent': ua } : {} })
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status} ${JSON.stringify(r.data)}`)
  return r.cookie
}
function client(cookie) {
  return {
    cookie,
    get: (p) => req('GET', p, { cookie }),
    post: (p, b) => req('POST', p, { cookie, body: b ?? {} }),
    put: (p, b) => req('PUT', p, { cookie, body: b ?? {} }),
    del: (p) => req('DELETE', p, { cookie }),
  }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
// SQL は一時ファイル経由で渡す（Windows の shell で引数の引用符が崩れないように）
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w21ll-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// ---------- 前提: 稼働先の会社 B を作り、自社（sample）のスタッフ X・Y を B に連携する ----------
const PFX = 'LL' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const coCode = `${PFX.toLowerCase()}b`
const coName = `${PFX}稼働先B株式会社`
must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: coCode, company_name: coName, admin_code: 'admin', admin_password: 'pass1234' }), 'company B')
const B = client(await login(coCode, 'admin'))
const staffList = async () => must(await admin.get('/api/admin/staff'), 'staff list').staff
for (const k of ['X', 'Y', 'Z']) must(await admin.post('/api/admin/staff', { user_code: `${PFX}${k}`, name: `${PFX} 連携${k}`, password: 'pass1234' }), 'staff ' + k)
const all = await staffList()
const X = all.find(s => s.user_code === `${PFX}X`), Y = all.find(s => s.user_code === `${PFX}Y`), Z = all.find(s => s.user_code === `${PFX}Z`)
async function linkToB(s) {
  const terms = must(await B.get('/api/admin/roster/lookup?code=' + encodeURIComponent(s.global_staff_code)), 'lookup').consent
  return must(await B.post('/api/admin/roster/link', { code: s.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
}
const xInB = await linkToB(X)
const yInB = await linkToB(Y)
ok('（前提）X・Y を稼働先 B に連携できた', !!xInB && !!yInB, [xInB, yInB])
const coB = async (st) => (await st.get('/api/staff/me/companies')).data?.companies?.find(c => c.company_name === coName)
// X が所属元にログインしたセッション（iPhone）と、B に切り替えたセッション（Windows）
async function switchedToB(code, ua = WIN_UA) {
  const st = client(await login('sample', code, 'pass1234', ua))
  const b = await coB(st)
  if (!b) throw new Error('B が企業切替の一覧にない')
  must(await st.post('/api/staff/me/switch-company', { company_id: b.company_id }), 'switch')
  return st
}

// ---------- #9940 稼働先の管理者から、所属元でのセッションは見えない・消せない ----------
{
  const home = client(await login('sample', `${PFX}X`, 'pass1234', IPHONE_UA))
  const inB = await switchedToB(`${PFX}X`)
  const bv = await B.get(`/api/admin/staff/${xInB}/sessions`)
  ok('#9940 稼働先 B の管理者には、B に切り替えている端末だけが見える（所属元の iPhone は出ない）',
    bv.status === 200 && bv.data.sessions.length === 1 && bv.data.sessions.every(s => !s.other_company && s.device !== 'iPhone / Safari'), bv.data)
  ok('#9940 連携行であることを返す（画面で「自社に切り替えている端末だけ」と案内する）', bv.data?.staff?.linked === true, bv.data?.staff)
  const pick = must(await B.get('/api/admin/security/staff?q=' + encodeURIComponent(`${PFX} 連携X`)), 'B staff pick').staff.find(s => s.staff_id === xInB)
  ok('#9940 稼働先の「ログインを終了させるスタッフ」の台数も、B に切り替えている分だけ', pick && Number(pick.session_count) === 1, pick)
  const av = await admin.get(`/api/admin/staff/${X.staff_id}/sessions`)
  ok('#9940 所属元の管理者からは今どおり、B に切り替えた端末も「他社の画面」として見える',
    av.status === 200 && av.data.sessions.length === 2 && av.data.sessions.some(s => s.other_company) && av.data.sessions.some(s => s.device === 'iPhone / Safari') && !av.data.staff.linked, av.data)
  const apick = must(await admin.get('/api/admin/security/staff?q=' + encodeURIComponent(`${PFX} 連携X`)), 'A staff pick').staff.find(s => s.staff_id === X.staff_id)
  ok('#9940 所属元の「ログインを終了させるスタッフ」の台数は今どおり（他社の画面を含む）', apick && Number(apick.session_count) === 2, apick)
  const del = await B.del(`/api/admin/staff/${xInB}/sessions`)
  ok('#9940 稼働先 B の強制ログアウトは、B に切り替えている1台だけを終了する', del.status === 200 && del.data.revoked === 1, del)
  ok('#9940 B に切り替えていたセッションは使えない', (await inB.get('/api/staff/me/companies')).status === 401)
  ok('#9940 所属元でのセッションは残る', (await home.get('/api/staff/me/companies')).status === 200)
  // 所属元の強制ログアウトは今どおり、他社に切り替えた分も消す
  const inB2 = await switchedToB(`${PFX}X`)
  const del2 = await admin.del(`/api/admin/staff/${X.staff_id}/sessions`)
  ok('#9940 所属元の強制ログアウトは今どおり、B に切り替えた端末も終了する', del2.status === 200 && del2.data.revoked === 2, del2)
  ok('#9940 （所属元の強制ログアウトの後）B のセッションも所属元のセッションも使えない',
    (await inB2.get('/api/staff/me/companies')).status === 401 && (await home.get('/api/staff/me/companies')).status === 401)
  ok('#9940 他社の連携行でない ID（存在しない）は 404', (await B.get('/api/admin/staff/99999999/sessions')).status === 404)
  ok('#9940 稼働先 B から所属元の行の ID を指定しても 404', (await B.get(`/api/admin/staff/${X.staff_id}/sessions`)).status === 404
    && (await B.del(`/api/admin/staff/${X.staff_id}/sessions`)).status === 404)
}

// ---------- #9941 メールのリンクでの再設定で、企業を切り替えたセッションも消す ----------
if (!PERSIST) skip('#9941 パスワードの再設定（メールのリンク）', 'PERSIST 未指定')
else {
  const home = client(await login('sample', `${PFX}X`, 'pass1234', IPHONE_UA))
  const inB = await switchedToB(`${PFX}X`)
  const uid = sql(`SELECT us.user_id FROM users us JOIN companies co ON co.company_id = us.company_id WHERE co.company_code = 'sample' AND us.user_code = ${q(`${PFX}X`)}`)[0].user_id
  const tok = `w21ll-${PFX}-${Math.random().toString(36).slice(2)}`
  sql(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (${uid}, ${q(sha256(tok))}, ${q(new Date(Date.now() + 30 * 60 * 1000).toISOString())})`)
  const r = await req('POST', '/api/auth/reset-password', { body: { token: tok, password: 'newpassword1' } })
  ok('（前提）再設定できる', r.status === 200 && r.data.ok, r)
  ok('#9941 再設定の後、B に切り替えていたセッションは使えない', (await inB.get('/api/staff/me/companies')).status === 401)
  ok('#9941 再設定の後、所属元のセッションも使えない', (await home.get('/api/staff/me/companies')).status === 401)
  const n = sql(`SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (SELECT user_id FROM users WHERE person_id = (SELECT person_id FROM users WHERE user_id = ${uid}))`)[0].n
  ok('#9941 同じ人のセッションは1件も残らない', n === 0, n)
  const re = await req('POST', '/api/auth/login', { body: { company_code: 'sample', user_code: `${PFX}X`, password: 'newpassword1' } })
  ok('#9941 新しいパスワードでログインできる', re.status === 200, re)
  // 以降のテストのためにパスワードを戻す
  must(await client(re.cookie).post('/api/auth/change-password', { current_password: 'newpassword1', new_password: 'pass1234' }), 'change password back')
}

// ---------- #9941 スタッフの統合で、統合元の人が他社に切り替えたセッションも消す ----------
{
  const zSess = client(await login('sample', `${PFX}Z`))
  const yInBSess = await switchedToB(`${PFX}Y`)
  ok('（前提）Y は B に切り替えて使える', (await yInBSess.get('/api/staff/me/companies')).status === 200)
  const m = await admin.post(`/api/admin/staff/${Y.staff_id}/merge`, { target_staff_id: Z.staff_id, force: true })
  ok('（前提）Y を Z に統合できる', m.status === 200, m)
  ok('#9941 統合の後、統合元 Y が B に切り替えていたセッションは使えない', (await yInBSess.get('/api/staff/me/companies')).status === 401)
  ok('#9941 統合先 Z のセッションは残る', (await zSess.get('/api/staff/me/companies')).status === 200)
}

// ---------- #9942 連携の終了・取引終了の後は、稼働先の会社に切り替えられない ----------
{
  const noticeTitle = `${PFX} 全員へのお知らせ`
  must(await B.post('/api/admin/notices', { title: noticeTitle, body: 'x', target_type: 'all', target_ids: '', client_request_id: `${PFX}-n1` }), 'B notice')
  const total = async () => must(await B.get('/api/admin/notices'), 'B notices').notices.find(n => n.title === noticeTitle)?.staff_total
  const recip = async () => must(await B.get('/api/admin/notices/recipients'), 'recipients').staff.map(s => s.staff_id)
  const total0 = await total()
  ok('（前提）終了の前は、B のお知らせの対象と個人あての候補に X の連携行が入る', total0 >= 1 && (await recip()).includes(xInB), total0)

  const home = client(await login('sample', `${PFX}X`))
  const inB = await switchedToB(`${PFX}X`)
  ok('#9942 終了の前は B に切り替えて使える', (await inB.get('/api/staff/me/companies')).status === 200 && !!(await coB(home)))

  must(await admin.post(`/api/admin/roster/${X.staff_id}/links/${xInB}/end`, {}), 'end link')
  const r1 = await inB.get('/api/staff/me/companies')
  ok('#9942 所属元が連携を終了した後、B に切り替えたままのセッションは 401（理由のコード link_ended）', r1.status === 401 && r1.data?.code === 'link_ended' && /連携が終了/.test(r1.data?.error || ''), r1)
  ok('#9942 そのセッションは消える（次も 401）', (await inB.get('/api/staff/me/profile')).status === 401)
  const list = must(await home.get('/api/staff/me/companies'), 'companies after end')
  ok('#9942 所属元のセッションは使え、企業切替の一覧に B が出ない', !list.companies.some(c => c.company_name === coName) && list.companies.some(c => c.current), list)
  const bId = must(await B.get('/api/auth/me'), 'B me').company_id
  const sw = await home.post('/api/staff/me/switch-company', { company_id: bId })
  ok('#9942 B への切り替えは 404 で拒否される', sw.status === 404, [bId, sw])
  ok('#9942 B のお知らせの対象（人数）から外れる', (await total()) === total0 - 1, [await total(), total0])
  ok('#9942 B の個人あての配信先の候補から外れる', !(await recip()).includes(xInB))
  ok('#9942 B の過去の記録（連携行）は残る', (await B.get(`/api/admin/staff/${xInB}`)).status === 200)

  // 所属元が再開しても、稼働先の取引状況が「取引終了」のままなら切り替えられない
  must(await admin.post(`/api/admin/roster/${X.staff_id}/links/${xInB}/resume`, {}), 'resume')
  ok('#9942 連携を再開しても、取引終了のままなら一覧に出ない', !(await coB(home)))
  must(await B.put(`/api/admin/roster/${xInB}/host-status`, { status: 'working' }), 'host working')
  ok('#9942 稼働先が取引状況を戻すと、また切り替えられる', !!(await coB(home)))
  ok('#9942 お知らせの対象にも戻る', (await total()) === total0)
  const inB2 = await switchedToB(`${PFX}X`)
  ok('（前提）B に切り替えた', (await inB2.get('/api/staff/me/companies')).status === 200)
  must(await B.put(`/api/admin/roster/${xInB}/host-status`, { status: 'ended' }), 'host ended')
  const r2 = await inB2.get('/api/staff/me/companies')
  ok('#9942 稼働先が取引終了にした後も、B に切り替えたままのセッションは 401', r2.status === 401 && r2.data?.code === 'link_ended', r2)
  ok('#9942 取引終了の後、企業切替の一覧に B が出ない・所属元は使える', !(await coB(home)) && (await home.get('/api/staff/me/profile')).status === 200)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
