// 契約ユーザー数を会社の画面に出す・画面を作らない履歴の API を消す（Sprint 20。w20-contract。#9928 #9929）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   #9928 GET /api/admin/contract-usage: 数え方が本部の企業一覧・企業詳細と同じこと（名簿のみ・停止は数えない）、
//         上限なし・ふつう・9割以上（near_limit）・上限ちょうど・超過の返し方、管理者の4ロールが見られてスタッフは見られないこと。
//         画面（アカウント設定の「契約ユーザー数」の欄）はヘッドレスの Chrome で別に確かめる
//   #9929 GET /api/admin/staff/:id/merges と GET /api/admin/roster/consents は無い（404）。記録の表は残る（PERSIST があるとき D1 で確かめる）
// 実行: BASE=http://127.0.0.1:8713 PERSIST=<保存先> node scripts/test-w20-contract.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// wrangler d1 execute の後に、つなぎっぱなしの接続が切られることがあるので、1回だけやり直す
const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const PERSIST = process.env.PERSIST || ''
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
// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
  return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
}

const PFX = 'WC' + Date.now().toString(36).slice(-4).toUpperCase()
const pfx = PFX.toLowerCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const sample = must(await hq.get('/api/hq/companies'), 'hq companies').companies.find(c => c.company_code === 'sample')
const SID = sample.company_id
const beforeLimit = sample.user_limit ?? null
const usage = async (api = admin) => must(await api.get('/api/admin/contract-usage'), 'contract-usage')
const hqCount = async () => ({
  list: must(await hq.get('/api/hq/companies'), 'hq companies').companies.find(c => c.company_id === SID).user_count,
  detail: must(await hq.get(`/api/hq/companies/${SID}`), 'hq company').usage.user_count,
})
const setLimit = async (v) => must(await hq.put(`/api/hq/companies/${SID}`, { user_limit: v }), 'set limit ' + v)

try {
  // ---------- #9928 数え方は本部の画面と同じ ----------
  {
    const u0 = await usage(), h0 = await hqCount()
    ok('#9928 企業の管理者の利用数は、本部の企業一覧・企業詳細の利用数と同じ', u0.user_count > 0 && u0.user_count === h0.list && u0.user_count === h0.detail, { u0, h0 })
    // ログインなし（名簿のみ）の登録は数えない
    must(await admin.post('/api/admin/roster', { route: 'skillsheet', name: `${PFX} 名簿のみ`, gender: 'male', force: true }), 'skillsheet')
    const u1 = await usage()
    ok('#9928 ログインのない名簿のみのスタッフは数えない', u1.user_count === u0.user_count, { before: u0.user_count, after: u1.user_count })
    // 管理者を足すと1人増え、停止すると戻る
    must(await admin.post('/api/admin/users', { user_code: `${pfx}j`, name: `${PFX} 事務`, role: 'office_staff', password: 'pass1234abcd' }), 'add office_staff')
    const u2 = await usage(), h2 = await hqCount()
    ok('#9928 管理者のアカウントを足すと1人増える（本部の画面と同じ数）', u2.user_count === u0.user_count + 1 && u2.user_count === h2.list && u2.user_count === h2.detail, { u0: u0.user_count, u2: u2.user_count, h2 })
    // 足した事務担当（office_staff）も見られる
    const jim = client(await login('sample', `${pfx}j`, 'pass1234abcd'))
    const uj = await jim.get('/api/admin/contract-usage')
    ok('#9928 事務担当も契約ユーザー数を見られる', uj.status === 200 && uj.data?.user_count === u2.user_count, uj)
    const jid = must(await admin.get('/api/admin/users'), 'users').users.find(u => u.user_code === `${pfx}j`).user_id
    must(await admin.put(`/api/admin/users/${jid}`, { status: 'suspended' }), 'suspend')
    const u3 = await usage(), h3 = await hqCount()
    ok('#9928 停止したアカウントは数えない（本部の画面と同じ数）', u3.user_count === u0.user_count && u3.user_count === h3.list && u3.user_count === h3.detail, { u0: u0.user_count, u3: u3.user_count, h3 })
  }

  // ---------- #9928 上限なし・ふつう・9割以上・上限ちょうど・超過 ----------
  {
    const n = (await usage()).user_count
    await setLimit(null)
    let u = await usage()
    ok('#9928 上限が未設定なら user_limit は null（上限なし）で、注意の印は付かない', u.user_limit === null && u.over_limit === false && u.near_limit === false && u.remaining === null, u)

    const roomy = Math.ceil(n / 0.9) + 1 // 9割に届かない上限
    await setLimit(roomy)
    u = await usage()
    ok('#9928 上限の9割に届かないときは注意の印が付かない', u.user_limit === roomy && u.over_limit === false && u.near_limit === false && u.remaining === roomy - n, { n, roomy, u })

    if (n >= 9) {
      await setLimit(n + 1) // n / (n + 1) は 9割以上
      u = await usage()
      ok('#9928 上限の9割以上で、まだ超えていないときは near_limit', u.near_limit === true && u.over_limit === false && u.remaining === 1, { n, u })
    } else console.log(`SKIP  #9928 上限の9割以上で上限未満（利用数が ${n} 人で9人より少ない）`)

    await setLimit(n)
    u = await usage()
    ok('#9928 上限ちょうどは near_limit（超過ではない）で、残りは 0', u.near_limit === true && u.over_limit === false && u.remaining === 0, { n, u })

    if (n >= 2) {
      await setLimit(n - 1)
      u = await usage()
      const d = must(await hq.get(`/api/hq/companies/${SID}`), 'hq company').usage
      ok('#9928 上限を超えたら over_limit（near_limit ではない）。本部の企業詳細の超過と同じ', u.over_limit === true && u.near_limit === false && u.remaining === -1 && d.over_limit === true, { n, u, d })
    }

    // 管理者の4ロールが見られる（現場管理者・営業管理者。事務担当は上で確かめた）
    for (const code of ['mgr01', 'sales01']) {
      const r = await client(await login('sample', code)).get('/api/admin/contract-usage')
      ok(`#9928 ${code} も契約ユーザー数を見られる`, r.status === 200 && r.data?.user_count === n && r.data?.user_limit === n - 1, r)
    }
    let staffStatus = null
    try { staffStatus = (await client(await login('sample', 'st001')).get('/api/admin/contract-usage')).status } catch (e) { staffStatus = 'login: ' + e.message }
    ok('#9928 スタッフは見られない（403）', staffStatus === 403, staffStatus)
  }

  // ---------- #9929 画面を作らない履歴の API は無い。記録は残る ----------
  {
    const staff = must(await admin.get('/api/admin/staff'), 'staff')
    const anyId = (staff.staff || staff)[0]?.staff_id || 1
    const m = await admin.get(`/api/admin/staff/${anyId}/merges`)
    ok('#9929 GET /api/admin/staff/:id/merges は無い（404）', m.status === 404 && !m.data?.merges, m)
    const c = await admin.get('/api/admin/roster/consents')
    ok('#9929 GET /api/admin/roster/consents は無い（404）', c.status === 404 && !c.data?.consents, c)
    const c2 = await admin.get('/api/admin/roster/consents?staff_id=' + anyId)
    ok('#9929 staff_id を付けても同意履歴の一覧は返らない', c2.status === 404 && !c2.data?.consents, c2)
    if (PERSIST) {
      const [t] = d1(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('staff_merges', 'roster_consents') ORDER BY name`)
      ok('#9929 記録の表（staff_merges・roster_consents）は残っている', t.map(x => x.name).join() === 'roster_consents,staff_merges', t)
    } else console.log('SKIP  #9929 記録の表が残っていること（PERSIST がない）')
  }
} finally {
  await hq.put(`/api/hq/companies/${SID}`, { user_limit: beforeLimit })
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
