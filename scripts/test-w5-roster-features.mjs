// 企業間連携の機能追加（w5-roster-features: #161 #162 #285 #539）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   本部（hq）で連携先の会社 A・B・C を作り、自社（sample）のスタッフを A に、A からさらに B に連携して、
//   連携の通知・所属元による終了と再開・本人の「共有中の会社」・連携用IDの一覧・取引先の管理を API で確かめる。
//   画面（まとめて連携の画面は 1人ずつ POST /link を呼ぶ。CSV・印刷の出力）は API では確かめない
// 実行: BASE=http://127.0.0.1:8819 node scripts/test-w5-roster-features.mjs
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

const PFX = 'RF' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const hq = client(await login('sample', 'hq'))
const companies = {}
for (const k of ['a', 'b', 'c']) {
  const code = `${PFX.toLowerCase()}${k}`, name = `${PFX}連携先${k.toUpperCase()}株式会社`
  must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: name, admin_code: 'admin', admin_password: 'pass1234' }), 'company ' + k)
  companies[k] = { name, api: client(await login(code, 'admin')) }
}
const A = companies.a.api, B = companies.b.api, C = companies.c.api
const terms = must(await admin.get('/api/admin/roster/consent-terms'), 'terms')
const link = (api, code) => api.post('/api/admin/roster/link', { code, agreed: true, consent_version: terms.version })
const notifs = async (api, kind) => must(await api.get('/api/admin/notifications?kind=' + kind), 'notifications ' + kind).notifications

// 自社雇用のスタッフ X（ログインあり・生年月日・フリガナあり）
const xr = must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 連携X`, kana: 'レンケイ エックス', gender: 'male', date_of_birth: '1990-04-01',
  user_code: `${PFX}X`, password: 'pass1234', email: `x${PFX.toLowerCase()}@example.com`, force: true }), 'staff X')
const X = { staff_id: xr.staff_id, code: xr.global_staff_code }
ok('（前提）自社雇用のスタッフに恒久ID（FS…）がある', /^FS[0-9A-F]{10}$/.test(X.code || ''), xr)

// ---------- #162 連携の成立を所属元に知らせる ----------
const inA = must(await link(A, X.code), 'link A').staff_id
{
  const n = (await notifs(admin, 'roster_linked')).filter(x => x.related_id === X.staff_id)
  ok('#162 連携が成立すると、所属元の管理者に通知が届く（連携先の企業名つき）', n.length === 1 && n[0].title.includes(companies.a.name) && n[0].link === `/admin#staff/${X.staff_id}`, n)
  const links = must(await admin.get(`/api/admin/roster/${X.staff_id}/links`), 'links')
  const l = links.links.find(x => x.linked_staff_id === inA)
  ok('#162 所属元の連携状況に、共有中の連携が出る', links.role === 'owner' && l && !l.link_revoked_at, links)
}
// A からさらに B へ連携（多段連携）。B の連携は A の行の自社専用コード（RL…）で行う
const rlA = must(await A.get(`/api/admin/roster/${inA}/share-code`), 'A share-code').global_staff_code
const inB = must(await link(B, rlA), 'link B').staff_id
{
  const n = (await notifs(A, 'roster_linked')).filter(x => x.related_id === inA)
  ok('#162 多段連携では、直前の企業（A）に通知が届く', n.length === 1 && n[0].title.includes(companies.b.name), n)
  const n0 = (await notifs(admin, 'roster_linked')).filter(x => x.title.includes(companies.b.name))
  ok('#162 多段連携の先の企業名は、雇用元（自社）には通知しない', n0.length === 0, n0)
}
const detailA = async () => must(await A.get(`/api/admin/staff/${inA}`), 'A detail').profile
{
  const p = await detailA()
  // 同意 v3（#9001）からは、連携先には生年月日を渡さず年代を渡す
  ok('（前提）連携中は、連携先で所属元の基本項目（フリガナ・年代）が見える', !p.date_of_birth && /^[0-9]0代$/.test(p.age_group || '') && p.kana === 'レンケイ エックス', p)
}

// ---------- #162 所属元が連携を終了する ----------
{
  const bad = await admin.post(`/api/admin/roster/${X.staff_id}/links/999999999/end`, {})
  ok('#162 自社の行から連携していない行は終了できない（404）', bad.status === 404, bad)
  const other = await B.post(`/api/admin/roster/${inB}/links/${inA}/end`, {})
  ok('#162 稼働先（連携先）からは所属元の連携を終了できない（404）', other.status === 404, other)
  const r = await admin.post(`/api/admin/roster/${X.staff_id}/links/${inA}/end`, {})
  ok('#162 所属元が連携を終了できる（その先の B の連携も終了する）', r.status === 200 && r.data.ended === 2, r)
  const again = await admin.post(`/api/admin/roster/${X.staff_id}/links/${inA}/end`, {})
  ok('#162 終了済みの連携をもう一度終了すると 409', again.status === 409, again)
  const p = await detailA()
  ok('#162 終了すると、連携先で所属元の基本項目（年代・フリガナ）が見えなくなる', !p.date_of_birth && !p.age_group && !p.kana && p.link_revoked_at, p)
  ok('#162 終了した連携行は取引終了になる', !!p.link_ended_at, p)
  const listA = must(await A.get('/api/admin/staff'), 'A staff').staff.find(s => s.staff_id === inA)
  ok('#162 スタッフ一覧でも基本項目（フリガナ）を出さない', listA && !listA.kana && listA.assignable === 0, listA)
  const opts = must(await A.get('/api/admin/staff/options'), 'A options').staff
  ok('#162 シフトの候補から外れる', !opts.some(s => s.staff_id === inA), opts.length)
  const hs = await A.put(`/api/admin/roster/${inA}/host-status`, { status: 'working' })
  ok('#162 連携先は取引状況を「稼働中」に戻せない（409）', hs.status === 409, hs)
  const sc = await A.get(`/api/admin/roster/${inA}/share-code`)
  ok('#162 終了した連携行の連携用IDは共有できない', sc.status === 400, sc)
  const lkC = await C.get('/api/admin/roster/lookup?code=' + rlA)
  ok('#162 終了した連携行の自社専用コード（RL）では、別の企業も連携できない', lkC.status === 404, lkC)
  const reA = await link(A, X.code)
  ok('#162 連携先が同じIDで連携し直して、終了を外すことはできない（409 連携済み）', reA.status === 409, reA)
  const nA = (await notifs(A, 'roster_link_ended')).filter(x => x.related_id === inA)
  const nB = (await notifs(B, 'roster_link_ended')).filter(x => x.related_id === inB)
  ok('#162 連携先（A）と、その先（B）の管理者に終了の通知が届く', nA.length === 1 && nB.length === 1, { nA, nB })
  const links = must(await admin.get(`/api/admin/roster/${X.staff_id}/links`), 'links').links.find(x => x.linked_staff_id === inA)
  ok('#162 所属元の連携状況に、終了日と操作者が出る', links && links.link_revoked_at && links.revoked_by_name, links)
  const hostLinks = must(await A.get(`/api/admin/roster/${inA}/links`), 'host links')
  ok('#162 連携先の同意履歴の画面に、終了したことを返す', hostLinks.role === 'host' && !!hostLinks.link_revoked_at, hostLinks)
}

// ---------- #162 再開 ----------
{
  const r = await admin.post(`/api/admin/roster/${X.staff_id}/links/${inA}/resume`, {})
  ok('#162 所属元は終了した連携を再開できる', r.status === 200, r)
  const p = await detailA()
  ok('#162 再開すると、基本項目（フリガナ・年代）がふたたび見える（取引状況は取引終了のまま）', p.kana === 'レンケイ エックス' && /^[0-9]0代$/.test(p.age_group || '') && !p.link_revoked_at && !!p.link_ended_at, p)
  const pB = must(await B.get(`/api/admin/staff/${inB}`), 'B detail').profile
  ok('#162 その先の連携（B）は終了のまま（B の所属元の A が再開する）', !pB.date_of_birth && pB.link_revoked_at, pB)
  const hs = await A.put(`/api/admin/roster/${inA}/host-status`, { status: 'working' })
  ok('#162 再開した後は、連携先が取引状況を戻せる', hs.status === 200, hs)
  const n = (await notifs(A, 'roster_link_resumed')).filter(x => x.related_id === inA)
  ok('#162 再開を連携先に通知する', n.length === 1, n)
}

// ---------- #285 本人の「共有中の会社」と、連携されたときの本人への通知 ----------
{
  const st = client(await login('sample', `${PFX}X`))
  const p = must(await st.get('/api/staff/me/profile'), 'profile').profile
  const sw = p.shared_with || []
  const a = sw.find(x => x.company_name === companies.a.name), b = sw.find(x => x.company_name === companies.b.name)
  ok('#285 本人のプロフィールに共有中の会社（連携日つき）が出る', a && !a.ended && a.linked_at, sw)
  ok('#285 多段連携の先（B）も本人には出し、終了した連携は ended', b && b.ended && b.ended_at, sw)
  const ns = must(await st.get('/api/staff/notifications'), 'staff notifications').notifications.filter(n => n.kind === 'roster_linked_staff')
  ok('#285 連携されると本人に通知が届く（A と B の2件）', ns.length === 2 && ns.some(n => n.title.includes(companies.a.name)) && ns.some(n => n.title.includes(companies.b.name)), ns)
  const other = client(await login('sample', 'admin'))
  const pa = await other.get('/api/staff/me/profile')
  ok('#285 管理者のセッションではスタッフ本人の API を使えない（403）', pa.status === 403, pa)
}

// ---------- #539 連携用IDの一覧（所属元）と、まとめて連携（稼働先） ----------
{
  const mk = async (s) => must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 一括${s}`, gender: 'female', user_code: `${PFX}${s}`, password: 'pass1234', force: true }), 'staff ' + s)
  const Y = await mk('Y'), Z = await mk('Z')
  const list = must(await admin.get('/api/admin/roster/share-codes'), 'share-codes').staff
  ok('#539 連携用IDを共有できるスタッフの一覧に、自社雇用のスタッフと恒久IDが出る', [X, Y, Z].every(s => list.some(r => r.staff_id === s.staff_id && /^FS/.test(r.code || ''))), list.length)
  const out = must(await admin.post('/api/admin/roster/share-codes', { staff_ids: [Y.staff_id, Z.staff_id, 999999999] }), 'share-codes post')
  ok('#539 選んだ人の氏名とIDを返す（自社にいない人は数えるだけ）', out.staff.length === 2 && out.staff.every(s => /^FS[0-9A-F]{10}$/.test(s.code)) && out.skipped === 1, out)
  const none = await admin.post('/api/admin/roster/share-codes', { staff_ids: [] })
  ok('#539 誰も選ばないと 400', none.status === 400, none)
  // 稼働先 C は、受け取った2人のIDを1回の同意で連携する（画面は 1人ずつ POST /link を呼ぶ）
  const rs = await Promise.all(out.staff.map(s => link(C, s.code)))
  ok('#539 まとめて連携できる（同意の記録は1人ずつ残る）', rs.every(r => r.status === 200), rs)
  const cons = must(await C.get('/api/admin/roster/consents'), 'consents').consents
  ok('#539 同意の記録が人数分ある', rs.every(r => cons.some(c => c.staff_id === r.data.staff_id)), cons.length)
  // C で連携した行の自社専用コード（RL）は、一覧の出力でまとめて発行する
  const ids = rs.map(r => r.data.staff_id)
  const before = must(await C.get('/api/admin/roster/share-codes'), 'C list').staff.filter(r => ids.includes(r.staff_id))
  ok('（前提）連携で受け入れた行は、まだ自社専用コードがない', before.length === 2 && before.every(r => r.relink && !r.code), before)
  const issued = must(await C.post('/api/admin/roster/share-codes', { staff_ids: ids }), 'C issue').staff
  ok('#539 自社専用コード（RL…）をまとめて発行して返す', issued.length === 2 && issued.every(s => /^RL[0-9A-F]{10}$/.test(s.code)) && issued[0].code !== issued[1].code, issued)
  const again = must(await C.post('/api/admin/roster/share-codes', { staff_ids: ids }), 'C issue 2').staff
  ok('#539 もう一度出力しても同じコード（固定）', again.map(s => s.code).sort().join() === issued.map(s => s.code).sort().join(), again)
  const one = must(await C.get(`/api/admin/roster/${ids[0]}/share-code`), 'C single').global_staff_code
  ok('#539 1人ずつの連携用QRと同じコード', issued.some(s => s.code === one), one)
}

// ---------- #161 取引先の管理 ----------
{
  const n1 = `${PFX}株式会社ピー`, n2 = `${PFX}(株)ピー`
  const p1 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: n1, contact_name: '担当 一郎' }), 'partner 1').affiliation_id
  const p2 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: n2, phone: '0312345678', email: 'p2@example.com', memo: '旧表記' }), 'partner 2').affiliation_id
  const dup = await admin.post('/api/admin/roster/partners', { affiliation_name: n1 })
  ok('#161 同じ名前の取引先は登録できない（409）', dup.status === 409, dup)
  const ownName = await admin.post('/api/admin/roster/partners', { affiliation_name: companies.a.name })
  ok('#161 導入企業の会社名は取引先にできない（400）', ownName.status === 400, ownName)
  const s1 = must(await admin.post('/api/admin/roster', { route: 'partner', name: `${PFX} 取引先 花子`, gender: 'female', partner_affiliation_id: p2, force: true }), 'partner staff').staff_id
  const list = async () => must(await admin.get('/api/admin/roster/partners'), 'partners').partners
  let L = await list()
  const r2 = L.find(p => p.affiliation_id === p2), r1 = L.find(p => p.affiliation_id === p1)
  ok('#161 一覧に連絡先・所属スタッフ数・削除できるかが出る', r2 && r2.staff_count === 1 && r2.active_staff_count === 1 && r2.phone === '0312345678' && r2.can_delete === false && r1 && r1.can_delete === true, { r1, r2 })
  const badMail = await admin.put(`/api/admin/roster/partners/${p1}`, { email: 'not-mail' })
  ok('#161 メールの形式が違うと 400', badMail.status === 400, badMail)
  must(await admin.put(`/api/admin/roster/partners/${p1}`, { phone: '0398765432', memo: '正式名称' }), 'edit p1')
  const clash = await admin.put(`/api/admin/roster/partners/${p1}`, { affiliation_name: n2 })
  ok('#161 別の取引先と同じ名前には変えられない（409）', clash.status === 409, clash)
  const delUsed = await admin.del(`/api/admin/roster/partners/${p2}`)
  ok('#161 所属スタッフのいる取引先は削除できない（409）', delUsed.status === 409, delUsed)
  // スタッフ詳細の所属会社は、登録済みの取引先から選ぶ（自由入力の名前は取引先として自動で登録しない）
  const free = await admin.put(`/api/admin/staff/${s1}`, { affiliation: `${PFX}未登録の会社` })
  ok('#161 スタッフ詳細で未登録の会社名にすると 400（取引先を自動で作らない）', free.status === 400 && /登録されていません/.test(free.data.error || ''), free)
  ok('#161 未登録の名前は取引先に増えない', !(await list()).some(p => p.affiliation_name === `${PFX}未登録の会社`))
  // 統合
  const m = await admin.post(`/api/admin/roster/partners/${p2}/merge`, { into_id: p1 })
  ok('#161 統合すると、所属スタッフを統合先に付け替える', m.status === 200 && m.data.moved_staff === 1 && m.data.removed === true, m)
  L = await list()
  const merged = L.find(p => p.affiliation_id === p1)
  ok('#161 統合元は一覧から消え、統合先の空欄の連絡先は統合元の値で埋まる（入力済みの値は残す）', !L.some(p => p.affiliation_id === p2) && merged.staff_count === 1 && merged.phone === '0398765432' && merged.email === 'p2@example.com' && /正式名称/.test(merged.memo) && /旧表記/.test(merged.memo), merged)
  const sd = must(await admin.get(`/api/admin/staff/${s1}`), 'staff detail').profile
  ok('#161 統合後、スタッフの所属会社名は統合先の名前', sd.affiliation === n1 && sd.partner_affiliation_id === p1, sd)
  const opts = must(await admin.get('/api/admin/staff-affiliations'), 'affiliations').affiliations
  ok('#161 所属会社の選択肢に統合元は出ない', opts.some(a => a.affiliation_id === p1) && !opts.some(a => a.affiliation_id === p2), opts.length)
  // 名前の変更は所属スタッフの所属会社名にも反映する
  const n3 = `${PFX}ピー株式会社`
  must(await admin.put(`/api/admin/roster/partners/${p1}`, { affiliation_name: n3 }), 'rename')
  const sd2 = must(await admin.get(`/api/admin/staff/${s1}`), 'staff detail 2').profile
  ok('#161 取引先の名前を変えると、所属スタッフの所属会社名もそろう', sd2.affiliation === n3, sd2)
  // 登録済みの取引先への付け替えはスタッフ詳細からできる
  const p4 = must(await admin.post('/api/admin/roster/partners', { affiliation_name: `${PFX}別の取引先` }), 'partner 4').affiliation_id
  const move = await admin.put(`/api/admin/staff/${s1}`, { affiliation: `${PFX}別の取引先` })
  const sd3 = must(await admin.get(`/api/admin/staff/${s1}`), 'staff detail 3').profile
  ok('#161 スタッフ詳細で登録済みの取引先を選ぶと付け替わる', move.status === 200 && sd3.partner_affiliation_id === p4, { move, sd3 })
  const del = await admin.del(`/api/admin/roster/partners/${p1}`)
  ok('#161 所属スタッフのいなくなった取引先は削除できる', del.status === 200 && !(await list()).some(p => p.affiliation_id === p1), del)
  const other = await A.put(`/api/admin/roster/partners/${p4}`, { memo: 'x' })
  ok('#161 他社の取引先は編集できない（404）', other.status === 404, other)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
