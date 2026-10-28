// 企業間連携の共有情報とマイプロフィール（w4-roster-share: #229 #259 #337 #462 #466 #475 #482 #538、持ち越し #263）の統合テスト
// 前提: bash scripts/setup-test-db.sh <保存先> で作り直したローカルの D1 を、`wrangler dev --local --persist-to <保存先>` で起動していること
//   本部（hq）で連携先の会社 A を作り、自社（sample）のスタッフを連携して、チャットの既読・追記の履歴・プロフィールを API で確かめる。
//   画面の表示（経歴の改行 #259、コピー・共有ボタン #475、QR を確認してから出す #229、切替失敗時の選択欄 #466）は API では確かめない
// 実行: BASE=http://127.0.0.1:8816 node scripts/test-w4-roster-share.mjs
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }

const PFX = 'RS' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))
const sales = client(await login('sample', 'sales01'))
const hq = client(await login('sample', 'hq'))
const coCode = `${PFX.toLowerCase()}a`
const coName = `${PFX}連携先A株式会社`
must(await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: coCode, company_name: coName, admin_code: 'admin', admin_password: 'pass1234' }), 'company A')
const A = client(await login(coCode, 'admin'))

// 自社雇用のスタッフ（ログイン・メール・電話あり）を作り、A に連携する
must(await admin.post('/api/admin/staff', { user_code: `${PFX}X`, name: `${PFX} 共有X`, password: 'pass1234', email: `x${PFX.toLowerCase()}@example.com`, phone: '09012345678' }), 'staff X')
const X = must(await admin.get('/api/admin/staff'), 'staff list').staff.find(s => s.user_code === `${PFX}X`)
ok('（前提）自社雇用のスタッフに恒久ID（FS…）がある', X && /^FS[0-9A-F]{10}$/.test(X.global_staff_code), X)
const terms = must(await admin.get('/api/admin/roster/consent-terms'), 'terms')
const inA = must(await A.post('/api/admin/roster/link', { code: X.global_staff_code, agreed: true, consent_version: terms.version }), 'link').staff_id
ok('（前提）A に連携できた', !!inA)

// ---------- #475 IDの書き写しの誤りの案内・空白入りのID ----------
{
  const bad = await A.get('/api/admin/roster/lookup?code=' + encodeURIComponent('FS12345'))
  ok('#475 形の違うIDで検索すると、12文字であることを案内する', bad.status === 404 && /12文字/.test(bad.data.error), bad)
  const spaced = X.global_staff_code.replace(/(.{4})(?=.)/g, '$1 ')
  const r = await A.get('/api/admin/roster/lookup?code=' + encodeURIComponent(spaced))
  ok('#475 4文字ずつ区切ったIDでも同じ人が見つかる（連携済み）', r.status === 200 && r.data.already_linked_staff_id === inA, r)
}

// ---------- #462 チャットの既読はユーザー単位、取得しただけでは既読にしない ----------
{
  const unread = async (api) => must(await api.get('/api/admin/roster-chat/unread-count'), 'unread').unread
  const a0 = await unread(admin), s0 = await unread(sales)
  const body = `${PFX} 明日の入店時間の確認です`
  const p1 = await A.post(`/api/admin/roster-chat/${inA}`, { body })
  ok('（前提）稼働先 A から所属元へ投稿できる', p1.status === 200 && p1.data.comment_id, p1)
  // 持ち越し #263: 同じ本文の再送（二度押し・別タブ）は1件だけ
  const [p2, p3] = await Promise.all([A.post(`/api/admin/roster-chat/${inA}`, { body }), A.post(`/api/admin/roster-chat/${inA}`, { body })])
  ok('#263 同じ人が同じ本文を続けて送っても、2件目以降は登録しない（duplicate）', p2.data?.duplicate && p3.data?.duplicate && p2.data.comment_id === p1.data.comment_id, [p2, p3])
  const thread = must(await A.get(`/api/admin/roster-chat/${inA}`), 'A thread')
  ok('#263 スレッドのメッセージは1件だけ', thread.messages.filter(m => m.body === body).length === 1, thread.messages)
  ok('#462 所属元の担当者2人とも未読が1件増える', (await unread(admin)) === a0 + 1 && (await unread(sales)) === s0 + 1)
  const g = must(await admin.get(`/api/admin/roster-chat/${X.staff_id}?host_staff_id=${inA}`), 'owner thread')
  ok('#462 スタッフ詳細でメッセージを取得しただけでは既読にならない', (await unread(admin)) === a0 + 1 && g.my_last_read_comment_id < p1.data.comment_id, g)
  const rd = await admin.post(`/api/admin/roster-chat/${X.staff_id}/read`, { host_staff_id: String(inA), last_comment_id: p1.data.comment_id })
  ok('#462 既読にするAPIで、自分の未読だけが減る', rd.status === 200 && (await unread(admin)) === a0 && (await unread(sales)) === s0 + 1, rd)
  const th = must(await sales.get('/api/admin/roster-chat/threads'), 'threads').threads.find(t => t.thread_staff_id === inA)
  ok('#462 スレッド一覧の未読も人ごと（ほかの担当者には未読のまま）', th && th.unread === 1, th)
  const g2 = must(await sales.get(`/api/admin/roster-chat/${X.staff_id}?host_staff_id=${inA}`), 'thread reads')
  ok('#462 誰がどこまで読んだかを返す（自社の担当者のみ）', (g2.reads || []).some(r => r.last_read_comment_id >= p1.data.comment_id && !r.me), g2.reads)
  const other = await A.post(`/api/admin/roster-chat/99999999/read`, {})
  ok('#462 自社が参加していないスレッドは既読にできない（404）', other.status === 404, other)
}

// ---------- #538 連携先が書いた現場評価・稼働メモの履歴・一覧・通知 ----------
{
  const notesOf = async (q = '') => must(await admin.get('/api/admin/roster/host-notes' + q), 'host-notes')
  const before = await notesOf()
  const inbox0 = must(await admin.get('/api/admin/notifications'), 'inbox').notifications.filter(n => n.kind === 'roster_host_note' && n.related_id === X.staff_id && !n.read_at).length
  must(await A.put(`/api/admin/staff/${inA}`, { site_evaluation: '接客が丁寧', work_memo: '遅刻なし' }), 'host notes 1')
  let n = await notesOf()
  const mine = n.notes.filter(x => x.staff_id === X.staff_id)
  ok('#538 所属元の一覧に、連携先が書いた評価・メモが出る（未確認）', mine.length === 1 && mine[0].site_evaluation === '接客が丁寧' && mine[0].unseen && mine[0].host_company_name === coName, n)
  ok('#538 未確認の件数が増える', n.unseen_count === before.unseen_count + 1, [n.unseen_count, before.unseen_count])
  const inbox1 = must(await admin.get('/api/admin/notifications'), 'inbox').notifications.filter(x => x.kind === 'roster_host_note' && x.related_id === X.staff_id && !x.read_at)
  ok('#538 所属元の管理者の受信箱に通知が届く（本文に評価の内容は入れない）', inbox1.length === inbox0 + 1 && inbox1[0].link === '/admin#roster-notes' && !/接客が丁寧/.test(inbox1[0].body || ''), inbox1)
  must(await A.put(`/api/admin/staff/${inA}`, { site_evaluation: '接客が丁寧。リーダー候補' }), 'host notes 2')
  must(await A.put(`/api/admin/staff/${inA}`, { site_evaluation: '接客が丁寧。リーダー候補', work_memo: '遅刻なし' }), 'host notes same')
  n = await notesOf()
  const h = n.notes.filter(x => x.staff_id === X.staff_id)
  ok('#538 上書きせず履歴に残る（変わらない保存は残さない）', h.length === 2 && h[0].site_evaluation === '接客が丁寧。リーダー候補' && h[0].work_memo === '遅刻なし' && h[0].prev_site_evaluation === '接客が丁寧', h)
  const inbox2 = must(await admin.get('/api/admin/notifications'), 'inbox').notifications.filter(x => x.kind === 'roster_host_note' && x.related_id === X.staff_id && !x.read_at)
  ok('#538 未読の通知が残っている間は、同じスタッフの通知を重ねて作らない', inbox2.length === inbox1.length, inbox2)
  const links = must(await admin.get(`/api/admin/roster/${X.staff_id}/links`), 'links').links.find(l => l.linked_staff_id === inA)
  ok('#538 スタッフ詳細の連携先パネルにも変更の履歴を返す', links && links.history.length === 2 && links.host_note_updated_at, links)
  must(await admin.post('/api/admin/roster/host-notes/seen', {}), 'seen')
  ok('#538 確認済みはユーザーごと（別の担当者には未確認のまま）', must(await sales.get('/api/admin/roster/host-notes'), 'sales notes').unseen_count >= 2)
  ok('#538 すべて確認済みにすると未確認が0件', (await notesOf()).unseen_count === 0 && (await notesOf('?unseen=1')).notes.length === 0)
  ok('#538 他社（稼働先 A）からは所属元向けの一覧に出ない', must(await A.get('/api/admin/roster/host-notes'), 'A notes').notes.every(x => x.staff_id !== X.staff_id))
}

// ---------- #482 氏名の同期は対象の人だけ ----------
{
  const r = await admin.put(`/api/admin/employees/${X.staff_id}`, { profile: { name: `${PFX} 共有X改` } })
  ok('（前提）従業員管理で氏名を変える', r.status === 200, r)
  const d = must(await A.get(`/api/admin/staff/${inA}`), 'A detail').profile
  ok('#482 連携先の表示名も変わる', d.name === `${PFX} 共有X改`, d.name)
  const same = await admin.put(`/api/admin/employees/${X.staff_id}`, { profile: { name: `${PFX} 共有X改` } })
  ok('#482 氏名を変えずに保存してもエラーにならない', same.status === 200, same)
}

// ---------- #337 #229 マイプロフィール（ログイン情報・共有範囲・企業を切り替えても QR） ----------
{
  const st = client(await login('sample', `${PFX}X`))
  const p = must(await st.get('/api/staff/me/profile'), 'profile').profile
  const l = (p.logins || [])[0]
  ok('#337 ログイン情報（会社コード・スタッフ番号）を返す', l && l.company_code === 'sample' && l.user_code === `${PFX}X`, p.logins)
  ok('#337 電話・メールは伏せ字で返す', l && l.phone_masked === '*******5678' && /^x\*\*\*@example\.com$/.test(l.email_masked || ''), l)
  // 同意 v3（#9001）からは、備考は共有しない項目（所属元だけ）
  ok('#229 共有範囲（PRポイントを含み、備考は共有しない）を返す', p.share_terms && !p.share_terms.shared.includes('備考') && p.share_terms.not_shared.some(s => /備考/.test(s)) && p.share_terms.shared.some(s => /PRポイント/.test(s)), p.share_terms)
  ok('#229 本人向けには PRポイント・備考の内容は返さない', !('pr_points' in p) && !('remarks' in p), Object.keys(p))
  ok('#337 自社雇用の画面では QR（恒久ID）を返す', p.global_staff_code === X.global_staff_code, p.global_staff_code)
  const cos = must(await st.get('/api/staff/me/companies'), 'companies')
  const a = cos.companies.find(c => c.company_name === coName)
  ok('（前提）連携先 A に切り替えられる', !!a, cos)
  // #466: 切り替え先が無いときは 404 で、今の会社のまま
  const bad = await st.post('/api/staff/me/switch-company', { company_id: 99999999 })
  ok('#466 切り替えに失敗したら 404 で、セッションの会社は変わらない', bad.status === 404 && must(await st.get('/api/staff/me/companies'), 'c').current_company_id === cos.current_company_id, bad)
  must(await st.post('/api/staff/me/switch-company', { company_id: a.company_id }), 'switch')
  const p2 = must(await st.get('/api/staff/me/profile'), 'profile 2').profile
  ok('#337 連携先の企業に切り替えても QR（所属元の恒久ID）を返す', p2.affiliation_type === 'linked_external' && p2.global_staff_code === X.global_staff_code && p2.qr_company_name && p2.qr_company_name !== coName, p2)
  ok('#337 切り替えた後もログイン情報は所属元のスタッフ番号（LK- の行は出さない）', (p2.logins || []).length === 1 && p2.logins[0].user_code === `${PFX}X`, p2.logins)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
