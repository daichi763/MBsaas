// 案件掲示板の不具合（作業単位 w3-board: #88 #124 #125 #135 #141 #476 #502 #540）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8822 --persist-to <保存先> で起動していること。
// 実行: BASE=http://127.0.0.1:8822 PERSIST=<保存先> node scripts/test-w3-board.mjs
//   PERSIST を指定すると、ローカルの D1 を直接書き換える確認（実施日を過ぎた掲載・案件の支払単価）も行う。
//   本番には接続しない（wrangler d1 execute は --local のみ）。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// wrangler d1 execute を待つ間に keep-alive の接続が切られることがあるため、接続エラーは1回だけやり直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (e?.cause?.code !== 'ECONNRESET') throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8822'
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
const SQL_DIR = mkdtempSync(join(tmpdir(), 'w3board-'))
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

// ---------- 準備: 掲載企業 A（sample）と、問い合わせ・提案する企業 B（本部で登録） ----------
const A = client(await login('sample', 'admin'))
const hq = client((await rawLogin('', 'hq')).cookie)
const coCode = `w3bd${SUF}`
const created = must(await hq.post('/api/hq/companies', { company_code: coCode, company_name: `W3BD 提案社${SUF}`, admin_code: 'boss', admin_name: '提案 太郎', admin_email: `w3bd${SUF}@example.com` }), 'company')
const tmpB = client(await login(coCode, 'boss', created.admin_temp_password))
must(await tmpB.post('/api/auth/change-password', { current_password: created.admin_temp_password, new_password: 'boss-pass-1' }), 'change password')
const B = client(await login(coCode, 'boss', 'boss-pass-1'))
const staffB = must(await B.post('/api/admin/staff-quick', { name: `提案 花子${SUF}`, phone: '080' + SUF + '12', affiliation_type: 'own_employee', force: true }), 'staff-quick').staff_id

const spot = (extra = {}) => ({ status: 'open', engagement_type: 'spot', title: `W3BD 掲載${SUF}`, prefecture: '東京都', date_from: addDays(today, 20), time_from: '10:00', time_to: '18:00', price_amount: 12000, price_unit: 'daily', headcount: 2, ...extra })
const unread = async (c) => (await c.get('/api/admin/board/unread-count')).data?.unread ?? -1
const consent = { consent_method: 'written', consent_obtained_on: today, consent_note: '面談時に書面で確認' }

// ---------- #88 実施日を過ぎたスポット掲載 ----------
{
  const past = await A.post('/api/admin/board/posts', spot({ date_from: addDays(today, -1) }))
  ok('#88 実施日が過去のスポット掲載は掲載できない（400）', past.status === 400, past)
  const pastTo = await A.post('/api/admin/board/posts', spot({ date_from: addDays(today, -3), date_to: addDays(today, -1) }))
  ok('#88 終了日が過去のスポット掲載も掲載できない（400）', pastTo.status === 400, pastTo)
  const draft = await A.post('/api/admin/board/posts', spot({ status: 'draft', date_from: addDays(today, -1) }))
  ok('#88 下書きなら保存できる', draft.status === 200, draft)
  if (PERSIST) {
    const p = must(await A.post('/api/admin/board/posts', spot({ title: `W3BD 期限切れ${SUF}` })), 'post')
    const th = must(await B.post(`/api/admin/board/posts/${p.post_id}/threads`, { body: '問い合わせです' }), 'thread')
    await B.get(`/api/admin/board/threads/${th.thread_id}`)
    const before = await unread(B)
    sql(`UPDATE board_posts SET date_from = '${addDays(today, -2)}', deadline = NULL WHERE post_id = ${p.post_id}`)
    const list = must(await B.get('/api/admin/board/posts'), 'list')
    ok('#88 締切日のないスポット掲載は、実施日を過ぎると一覧から消える', !list.posts.some(x => x.post_id === p.post_id))
    const d = must(await A.get(`/api/admin/board/posts/${p.post_id}`), 'detail')
    ok('#88 実施日を過ぎた掲載は「締切」になる', d.post.status === 'closed', d.post?.status)
    ok('#476 自動の締切も、問い合わせ中の企業の未読に数える', (await unread(B)) === before + 1, { before, after: await unread(B) })
    const pr = await B.post(`/api/admin/board/threads/${th.thread_id}/proposals`, { staff_id: staffB, ...consent })
    ok('#476 締切の掲載には提案できない（409）', pr.status === 409, pr)
  } else skip('#88 実施日を過ぎた掲載の自動締切')
}

// ---------- #540 自社の案件からコピー（支払単価と支払の単位） ----------
if (PERSIST) {
  const pid = sql(`SELECT project_id FROM projects WHERE company_id = 1 ORDER BY project_id LIMIT 2`).map(r => r.project_id)
  sql(`UPDATE projects SET unit_price = 30000, unit_price_type = 'daily', pay_rate = 1300, pay_unit_type = 'hourly' WHERE project_id = ${pid[0]};
       UPDATE projects SET unit_price = 30000, unit_price_type = 'daily', pay_rate = NULL WHERE project_id = ${pid[1]}`)
  const t1 = must(await A.get(`/api/admin/board/project-template/${pid[0]}`), 'template').template
  ok('#540 支払単価は支払の単位で反映する（請求=日額 → 支払=時給 1,300円）', Number(t1.price_amount) === 1300 && t1.price_unit === 'hourly', t1)
  const t2 = must(await A.get(`/api/admin/board/project-template/${pid[1]}`), 'template').template
  ok('#540 支払単価が未設定なら、単価・単位とも空にする', t2.price_amount === '' && t2.price_unit === '', t2)
} else skip('#540 自社の案件からコピー')

// ---------- #125 締切・充足の掲載の編集 ----------
const post = must(await A.post('/api/admin/board/posts', spot()), 'post').post_id
{
  must(await A.post(`/api/admin/board/posts/${post}/status`, { status: 'filled' }), 'filled')
  const keep = await A.put(`/api/admin/board/posts/${post}`, { description: '説明を直しました' })
  const d1 = must(await A.get(`/api/admin/board/posts/${post}`), 'detail').post
  ok('#125 充足の掲載を status なしで保存すると、充足のまま', keep.status === 200 && d1.status === 'filled' && d1.description === '説明を直しました', { keep, st: d1.status })
  const reopen = await A.put(`/api/admin/board/posts/${post}`, { status: 'open' })
  ok('#125 充足の掲載を、再掲載の指定なしで掲載中に戻すと 409', reopen.status === 409 && reopen.data?.need_republish, reopen)
  const rep = await A.put(`/api/admin/board/posts/${post}`, { status: 'open', republish: true })
  ok('#125 「保存して再掲載」なら掲載中に戻る', rep.status === 200 && must(await A.get(`/api/admin/board/posts/${post}`), 'detail').post.status === 'open', rep)
}

// ---------- #476 #502 問い合わせ・提案 ----------
const th = must(await B.post(`/api/admin/board/posts/${post}/threads`, { body: '人材を紹介できます' }), 'thread').thread_id
await B.get(`/api/admin/board/threads/${th}`)
{
  const u0 = await unread(B)
  must(await A.put(`/api/admin/board/posts/${post}`, { price_amount: 11000 }), 'price change')
  ok('#476 掲載の変更は相手企業の未読に数える', (await unread(B)) === u0 + 1, { u0, u1: await unread(B) })
  const msgs = must(await B.get(`/api/admin/board/threads/${th}`), 'thread').messages
  ok('#476 単価を変えると、やり取りに変更内容のシステムメッセージが入る', msgs.some(m => m.kind === 'system' && m.body.includes('単価') && m.body.includes('12,000') && m.body.includes('11,000')), msgs.map(m => m.body))
  const u1 = await unread(B)
  must(await A.put(`/api/admin/board/posts/${post}`, { description: '業務内容だけ変更' }), 'desc change')
  ok('#476 単価・日程・人数以外の変更では知らせない', (await unread(B)) === u1)

  const none = await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: staffB })
  ok('#502 本人の同意の記録がない提案は 400', none.status === 400, none)
  const future = await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: staffB, ...consent, consent_obtained_on: addDays(today, 1) })
  ok('#502 同意を得た日が未来の提案は 400', future.status === 400, future)
}
const prop1 = must(await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: staffB, ...consent }), 'proposal').proposal_id
{
  const list = must(await A.get(`/api/admin/board/threads/${th}/proposals`), 'proposals').proposals
  const p = list.find(x => x.proposal_id === prop1)
  ok('#502 提案先にも本人の同意の取得方法・日付が見える', p?.consent?.method === 'written' && p.consent.obtained_on === today && p.consent.note === undefined, p?.consent)

  // #124 提案の結果は提案した企業の未読に数える
  await B.get(`/api/admin/board/threads/${th}`)
  const u0 = await unread(B)
  must(await A.post(`/api/admin/board/proposals/${prop1}/status`, { status: 'interview' }), 'interview')
  ok('#124 面談希望にすると、提案した企業の未読が増える', (await unread(B)) === u0 + 1, { u0, u1: await unread(B) })
  const thList = must(await B.get('/api/admin/board/threads'), 'threads').threads.find(t => t.thread_id === th)
  ok('#124 やり取り一覧の未読にも数える', (thList?.unread || 0) >= 1, thList)
  const twice = await A.post(`/api/admin/board/proposals/${prop1}/status`, { status: 'interview' })
  ok('#124 同じ状態への二度押しは記録を増やさない', twice.status !== 200, twice)
  const sent = must(await B.get('/api/admin/board/proposals?side=sent'), 'sent').proposals
  ok('#124 送った提案の一覧に状態が出る', sent.some(x => x.proposal_id === prop1 && x.status === 'interview'), sent)

  // #141 終了したやり取りでは採用できない
  must(await B.post(`/api/admin/board/threads/${th}/status`, { status: 'closed' }), 'close')
  const after = must(await A.get(`/api/admin/board/threads/${th}/proposals`), 'proposals').proposals.find(x => x.proposal_id === prop1)
  ok('#141 やり取りを終了すると、未決の提案は取り下げになる', after?.status === 'withdrawn', after?.status)
  const adopt = await A.post(`/api/admin/board/proposals/${prop1}/status`, { status: 'adopted' })
  ok('#141 終了したやり取りの提案は採用できない', adopt.status === 409 || adopt.status === 400, adopt)
  must(await A.post(`/api/admin/board/threads/${th}/status`, { status: 'open' }), 'reopen')
  const still = must(await A.get(`/api/admin/board/threads/${th}/proposals`), 'proposals').proposals.find(x => x.proposal_id === prop1)
  ok('#141 再開しても取り下げた提案は戻らない', still?.status === 'withdrawn', still?.status)
}

// ---------- #135 同じ人の二重取り込み ----------
{
  const p2 = must(await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: staffB, ...consent }), 'proposal 2').proposal_id
  must(await A.post(`/api/admin/board/proposals/${p2}/status`, { status: 'adopted' }), 'adopt')
  const imp1 = await A.post(`/api/admin/board/proposals/${p2}/import`, {})
  ok('#135 準備: 1回目の取り込みは新しい行を作る', imp1.status === 200 && imp1.data.staff_id && !imp1.data.provisional, imp1)
  const remarks = (await A.get(`/api/admin/staff/${imp1.data.staff_id}`)).data
  ok('#502 取り込んだ行の備考に本人同意の記録が残る', JSON.stringify(remarks || {}).includes('本人の同意'), remarks?.staff?.remarks ?? remarks?.remarks)

  // 別の掲載で同じ人をもう一度採用する
  const post2 = must(await A.post('/api/admin/board/posts', spot({ title: `W3BD 2件目${SUF}` })), 'post2').post_id
  const th2 = must(await B.post(`/api/admin/board/posts/${post2}/threads`, { body: '同じ人を提案します' }), 'thread2').thread_id
  const p3 = must(await B.post(`/api/admin/board/threads/${th2}/proposals`, { staff_id: staffB, ...consent }), 'proposal 3').proposal_id
  must(await A.post(`/api/admin/board/proposals/${p3}/status`, { status: 'adopted' }), 'adopt 3')
  const imp2 = await A.post(`/api/admin/board/proposals/${p3}/import`, {})
  ok('#135 同じ提案元の同じスタッフを取り込むと、確認を求める（409 need_choice）', imp2.status === 409 && imp2.data?.need_choice && imp2.data.existing.some(x => x.staff_id === imp1.data.staff_id), imp2)
  const link = await A.post(`/api/admin/board/proposals/${p3}/import`, { mode: 'link', staff_id: imp1.data.staff_id })
  ok('#135 登録済みのスタッフに紐づけると、新しい行を作らない', link.status === 200 && link.data.linked && link.data.staff_id === imp1.data.staff_id, link)
  const again = await A.post(`/api/admin/board/proposals/${p3}/import`, { mode: 'new' })
  ok('#135 紐づけた提案は取り込み済み（409）', again.status === 409, again)

  // 3件目は別の行として登録 → 仮登録になり、統合できる
  const post3 = must(await A.post('/api/admin/board/posts', spot({ title: `W3BD 3件目${SUF}` })), 'post3').post_id
  const th3 = must(await B.post(`/api/admin/board/posts/${post3}/threads`, { body: 'もう一度' }), 'thread3').thread_id
  const p4 = must(await B.post(`/api/admin/board/threads/${th3}/proposals`, { staff_id: staffB, ...consent }), 'proposal 4').proposal_id
  must(await A.post(`/api/admin/board/proposals/${p4}/status`, { status: 'adopted' }), 'adopt 4')
  const sep = await A.post(`/api/admin/board/proposals/${p4}/import`, { mode: 'new' })
  ok('#135 別の行として登録すると仮登録になる', sep.status === 200 && sep.data.provisional && sep.data.staff_id !== imp1.data.staff_id, sep)
  const dry = await A.post(`/api/admin/staff/${sep.data.staff_id}/merge`, { target_staff_id: imp1.data.staff_id, dry_run: true })
  ok('#135 別の行として登録した行は、既存のスタッフに統合できる（dry_run）', dry.status === 200, dry)
}

// ---------- #476 締切・充足の後は提案を受け付けない ----------
{
  must(await A.post(`/api/admin/board/posts/${post}/status`, { status: 'closed' }), 'close post')
  const msgs = must(await B.get(`/api/admin/board/threads/${th}`), 'thread').messages
  ok('#476 締め切ると、やり取りにシステムメッセージが入る', msgs.some(m => m.kind === 'system' && m.body.includes('締め切られました')), msgs.slice(-2))
  const pr = await B.post(`/api/admin/board/threads/${th}/proposals`, { staff_id: staffB, ...consent })
  ok('#476 締め切った掲載には提案できない（409）', pr.status === 409, pr)
  const msg = await B.post(`/api/admin/board/threads/${th}/messages`, { body: '了解しました' })
  ok('#476 メッセージのやり取りは続けられる', msg.status === 200, msg)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
