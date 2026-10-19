// 案件掲示板の使い勝手（作業単位 w4-board-ux: #243 #250 #304 #352 #394 #435 #477）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8813 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8813 PERSIST=<保存先> node scripts/test-w4-board-ux.mjs
//   PERSIST を指定すると、ローカルの D1 を直接書き換える確認（提案したスタッフの退職）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8813'
const PERSIST = process.env.PERSIST || ''
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 400) : ''}`) }
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
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    let data = null; try { data = await r.json() } catch { }
    return { status: r.status, data }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w4bux-'))
let sqlSeq = 0
function sql(command) {
  const file = join(SQL_DIR, `q${++sqlSeq}.sql`)
  writeFileSync(file, command)
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', `"${PERSIST}"`, '--json', `--file="${file}"`], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0].results
}
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const SUF = String(Date.now()).slice(-6)

// ---------- 準備: 掲載企業 A（sample の admin と mgr01）と、問い合わせ・提案する企業 B（本部で登録） ----------
const A = client(await login('sample', 'admin'))
const A2 = client(await login('sample', 'mgr01'))
const hq = client((await rawLogin('', 'hq')).cookie)
const coCode = `w4bx${SUF}`
const created = must(await hq.post('/api/hq/companies', { company_code: coCode, company_name: `W4BX 提案社${SUF}`, admin_code: 'boss', admin_name: '提案 次郎', admin_email: `w4bx${SUF}@example.com` }), 'company')
const tmpB = client(await login(coCode, 'boss', created.admin_temp_password))
must(await tmpB.post('/api/auth/change-password', { current_password: created.admin_temp_password, new_password: 'boss-pass-1' }), 'change password')
const B = client(await login(coCode, 'boss', 'boss-pass-1'))
const quick = async (n) => must(await B.post('/api/admin/staff-quick', { name: `提案 人材${n}${SUF}`, phone: '080' + SUF + String(n).padStart(2, '0'), affiliation_type: 'own_employee', force: true }), 'staff-quick').staff_id
const staff1 = await quick(1)
const staff2 = await quick(2)

const spot = (extra = {}) => ({ status: 'open', engagement_type: 'spot', title: `W4BX 掲載${SUF}`, prefecture: '東京都', date_from: addDays(today, 20), time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 1, ...extra })
const unread = async (c) => (await c.get('/api/admin/board/unread-count')).data?.unread ?? -1
const consent = { consent_method: 'written', consent_obtained_on: today }

const post1 = must(await A.post('/api/admin/board/posts', spot()), 'post').post_id
const th1 = must(await B.post(`/api/admin/board/posts/${post1}/threads`, { body: '1通目の問い合わせです' }), 'thread').thread_id

// ---------- #435 同じ会社のやり取りがすでにあるとき ----------
{
  const r = await B.post(`/api/admin/board/posts/${post1}/threads`, { body: '別の担当者からの問い合わせです' })
  ok('#435 やり取りがあるときは、そのやり取りに本文を足す', r.status === 200 && r.data.thread_id === th1 && r.data.existed && r.data.appended, r)
  const msgs = must(await B.get(`/api/admin/board/threads/${th1}`), 'thread').messages
  ok('#435 足した本文がやり取りに残る', msgs.some(m => m.kind === 'text' && m.body === '別の担当者からの問い合わせです'), msgs.map(m => m.body))
  must(await B.post(`/api/admin/board/threads/${th1}/status`, { status: 'closed' }), 'close')
  const closed = await B.post(`/api/admin/board/posts/${post1}/threads`, { body: '終了後の問い合わせ' })
  ok('#435 終了したやり取りがあるときは 409 で知らせ、thread_id を返す', closed.status === 409 && closed.data?.thread_id === th1, closed)
  must(await B.post(`/api/admin/board/threads/${th1}/status`, { status: 'open' }), 'reopen')
}

// ---------- #250 既読はユーザー単位、取得しただけでは既読にしない ----------
{
  must(await A.post(`/api/admin/board/threads/${th1}/read`, {}), 'read A')
  must(await A2.post(`/api/admin/board/threads/${th1}/read`, {}), 'read A2')
  const a0 = await unread(A), b0 = await unread(A2)
  must(await B.post(`/api/admin/board/threads/${th1}/messages`, { body: '新着です' }), 'message')
  ok('#250 新着は掲載企業の各ユーザーの未読に数える', (await unread(A)) === a0 + 1 && (await unread(A2)) === b0 + 1, { a: await unread(A), a2: await unread(A2) })
  await A.get(`/api/admin/board/threads/${th1}`)
  ok('#250 やり取りを取得しただけ（定期の更新）では既読にしない', (await unread(A)) === a0 + 1, await unread(A))
  const rd = must(await A.post(`/api/admin/board/threads/${th1}/read`, {}), 'read')
  ok('#250 既読にすると、そのユーザーの未読だけが減る', (await unread(A)) === a0 && (await unread(A2)) === b0 + 1 && rd.last_read_message_id > 0, { a: await unread(A), a2: await unread(A2) })
  // 画面に出ている最後のメッセージまでしか既読にしない
  must(await B.post(`/api/admin/board/threads/${th1}/messages`, { body: '新着2' }), 'message 2')
  must(await A.post(`/api/admin/board/threads/${th1}/read`, { message_id: rd.last_read_message_id }), 'read upto')
  ok('#250 message_id までの既読では、その後の新着は未読のまま', (await unread(A)) === a0 + 1, await unread(A))
  // 自社のだれかが返信したら、それより前は自社全員にとって対応済み
  must(await A.post(`/api/admin/board/threads/${th1}/messages`, { body: '返信します' }), 'reply')
  ok('#250 自社の返信より前のメッセージは、ほかのユーザーにも未読に数えない', (await unread(A2)) === b0, await unread(A2))
  const list = must(await A2.get('/api/admin/board/threads'), 'threads').threads.find(t => t.thread_id === th1)
  ok('#250 やり取り一覧の未読もユーザー単位', list && list.unread === 0, list)
}

// ---------- #243 提案の二度押し ----------
let prop1
{
  const body = { staff_id: staff1, ...consent }
  const [r1, r2] = await Promise.all([B.post(`/api/admin/board/threads/${th1}/proposals`, body), B.post(`/api/admin/board/threads/${th1}/proposals`, body)])
  const okOnes = [r1, r2].filter(r => r.status === 200)
  ok('#243 同時の2回の送信で、提案は1件だけ登録される（もう一方は 409）', okOnes.length === 1 && [r1, r2].some(r => r.status === 409), [r1, r2])
  prop1 = okOnes[0]?.data?.proposal_id
  const list = must(await A.get(`/api/admin/board/threads/${th1}/proposals`), 'proposals').proposals
  ok('#243 やり取りの提案は1件', list.filter(p => p.status === 'proposed').length === 1, list.map(p => [p.proposal_id, p.status]))
  const msgs = must(await A.get(`/api/admin/board/threads/${th1}`), 'thread').messages
  ok('#243 「人材を提案しました」も1件', msgs.filter(m => m.kind === 'proposal').length === 1)
}

// ---------- #477 ほかの掲載で提案中・採用済み ----------
const post2 = must(await A.post('/api/admin/board/posts', spot({ title: `W4BX 2件目${SUF}`, headcount: 2 })), 'post2').post_id
const th2 = must(await B.post(`/api/admin/board/posts/${post2}/threads`, { body: '2件目の問い合わせ' }), 'thread2').thread_id
{
  const cands = must(await B.get(`/api/admin/board/threads/${th2}/proposal-candidates`), 'candidates').candidates
  const c1 = cands.find(c => c.staff_id === staff1)
  ok('#477 候補一覧に、ほかの掲載で提案中の件数が出る', c1 && c1.other_pending === 1 && c1.other_adopted === 0 && !c1.already, c1)
  const pv = must(await B.get(`/api/admin/board/threads/${th2}/proposal-preview?staff_id=${staff1}`), 'preview')
  ok('#477 プレビューにも、ほかで提案中であることが出る', pv.elsewhere && pv.elsewhere.pending === 1, pv.elsewhere)
}

// ---------- #304 採用人数と充足の勧め ----------
{
  const ad = must(await A.post(`/api/admin/board/proposals/${prop1}/status`, { status: 'adopted' }), 'adopt')
  ok('#304 採用で募集人数に達したら should_fill を返す（募集1名・採用1名）', ad.should_fill === true && ad.adopted_count === 1 && ad.headcount === 1, ad)
  const mine = must(await A.get('/api/admin/board/posts?scope=mine&engagement_type=spot'), 'mine').posts.find(p => p.post_id === post1)
  ok('#304 自社の掲載一覧に採用人数が出る', mine && mine.adopted_count === 1, mine)
  const d = must(await A.get(`/api/admin/board/posts/${post1}`), 'detail').post
  ok('#304 掲載の詳細にも採用人数が出る', d.adopted_count === 1, d.adopted_count)
  const other = must(await B.get('/api/admin/board/posts?engagement_type=spot'), 'open').posts.find(p => p.post_id === post1)
  ok('#304 他社の一覧には採用人数を出さない', other && other.adopted_count === undefined, other)
  const cands = must(await B.get(`/api/admin/board/threads/${th2}/proposal-candidates`), 'candidates').candidates
  const c1 = cands.find(c => c.staff_id === staff1)
  ok('#477 採用されたら、候補一覧に「他で採用済み」と掲載名が出る', c1 && c1.other_adopted === 1 && c1.other_pending === 0 && String(c1.adopted_label || '').includes(`W4BX 掲載${SUF}`), c1)
}

// ---------- #394 提案一覧の絞り込みと未取り込みの印 ----------
{
  const ni = must(await A.get('/api/admin/board/proposals?side=received&status=not_imported'), 'not imported').proposals
  ok('#394 「採用・未取り込み」で絞り込める', ni.some(p => p.proposal_id === prop1 && p.not_imported) && ni.every(p => p.status === 'adopted'), ni.map(p => [p.proposal_id, p.status]))
  const pend = must(await B.get('/api/admin/board/proposals?side=sent&status=pending'), 'pending').proposals
  ok('#394 「返事待ち」には採用済みを含めない', !pend.some(p => p.proposal_id === prop1), pend.map(p => p.status))
  const imp = await A.post(`/api/admin/board/proposals/${prop1}/import`, {})
  const ni2 = must(await A.get('/api/admin/board/proposals?side=received&status=not_imported'), 'not imported 2').proposals
  ok('#394 取り込んだら未取り込みから外れる', imp.status === 200 && !ni2.some(p => p.proposal_id === prop1), { imp, ni2: ni2.map(p => p.proposal_id) })
}

// ---------- #352 退職したスタッフの提案は採用できない ----------
if (PERSIST) {
  const p2 = must(await B.post(`/api/admin/board/threads/${th2}/proposals`, { staff_id: staff2, ...consent }), 'proposal staff2').proposal_id
  sql(`UPDATE staff_profiles SET employment_status = 'retired' WHERE staff_id = ${staff2}`)
  const u0 = await unread(A)
  const ad = await A.post(`/api/admin/board/proposals/${p2}/status`, { status: 'adopted' })
  ok('#352 提案元のスタッフが退職したら採用できない（409）', ad.status === 409, ad)
  const pr = must(await A.get(`/api/admin/board/threads/${th2}/proposals`), 'proposals').proposals.find(p => p.proposal_id === p2)
  ok('#352 その提案は取り下げになり、氏名は開示されない', pr && pr.status === 'withdrawn' && !pr.disclosed, pr)
  const msgs = must(await A.get(`/api/admin/board/threads/${th2}`), 'thread').messages
  ok('#352 やり取りに「利用できなくなった」と知らせる（退職とは書かない）', msgs.filter(m => m.kind === 'system' && m.body.includes('利用できなくなった')).length === 1 && !msgs.some(m => m.body.includes('退職')), msgs.slice(-2))
  ok('#352 その知らせは掲載企業の未読に数える', (await unread(A)) === u0 + 1, { u0, u1: await unread(A) })

  // 退職を状態の変更より前に読んだ場合も、一覧の取得で取り下げになる
  const staff3 = await quick(3)
  const p3 = must(await B.post(`/api/admin/board/threads/${th2}/proposals`, { staff_id: staff3, ...consent }), 'proposal staff3').proposal_id
  sql(`UPDATE staff_profiles SET merged_into_staff_id = ${staff1} WHERE staff_id = ${staff3}`)
  const sent = must(await B.get('/api/admin/board/proposals?side=sent'), 'sent').proposals.find(p => p.proposal_id === p3)
  ok('#352 統合したスタッフの提案も、提案一覧の取得で取り下げになる', sent && sent.status === 'withdrawn', sent)
} else skip('#352 退職・統合したスタッフの提案')

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
