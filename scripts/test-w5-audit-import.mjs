// 従業員データの変更履歴と、スタッフの CSV 一括登録（w5-audit-import: #464 #430 #205）の統合テスト
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、`wrangler dev --local` で起動していること
// 実行: BASE=http://127.0.0.1:8824 node scripts/test-w5-audit-import.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8799'
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }

async function tryLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await tryLogin(company_code, user_code, password)
  if (r.status !== 200 || !r.cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return r.cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { data = text }
    return { status: r.status, data, headers: r.headers }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data }
const PFX = 'AI' + Date.now().toString(36).slice(-4).toUpperCase()
let phoneSeq = 0
const newPhone = () => '080' + String(Date.now() % 100000000 + (phoneSeq++)).padStart(8, '0').slice(-8)

const admin = client(await login('sample', 'admin'))
const mgr = client(await login('sample', 'mgr01'))

// ---------- #464 従業員データの変更履歴 ----------
{
  const code = must(await admin.get('/api/admin/roster/next-code'), 'next-code').code
  const created = must(await admin.post('/api/admin/roster', { route: 'employee', name: `${PFX} 履歴 一郎`, gender: 'male', user_code: code, password: 'pass1234', phone: newPhone() }), 'create employee')
  const sid = created.staff_id
  const history = async () => must(await admin.get(`/api/admin/employees/${sid}/history`), 'history').logs
  const before = await history()

  const put = (c, extra) => c.put(`/api/admin/employees/${sid}`, { profile: { name: `${PFX} 履歴 一郎`, gender: 'male' }, ...extra })
  const r1 = await put(admin, { bank_name: 'サンプル銀行', account_number: '12345678', base_salary: 250000, city: '渋谷区' })
  ok('#464 従業員データを保存できる', r1.status === 200, r1)
  const h1 = await history()
  const acc = h1.find(l => l.field === 'account_number')
  ok('#464 変わった項目が履歴に残る（口座番号・基本給・銀行名・市区町村）',
    ['account_number', 'base_salary', 'bank_name', 'city'].every(f => h1.some(l => l.field === f && l.source === 'employee')) && h1.length - before.length === 4, h1)
  ok('#464 口座番号は下4桁だけを残す', acc && acc.new_value === '****5678' && !JSON.stringify(h1).includes('12345678'), acc)
  ok('#464 変更した人・日時・項目名を返す', acc && acc.changed_by_name === '出井 代表' && /^\d{4}-\d{2}-\d{2} /.test(acc.changed_at) && acc.label === '口座番号', acc)

  const r2 = await put(admin, { bank_name: 'サンプル銀行', account_number: '12345678', base_salary: '250000', city: '渋谷区' })
  ok('#464 値が変わらなければ履歴は増えない（数値と文字列の違いも同じとみなす）', r2.status === 200 && (await history()).length === h1.length, await history())

  const r3 = await put(admin, { account_number: '87654321', city: '' })
  const h3 = await history()
  const acc3 = h3.find(l => l.field === 'account_number')
  const city3 = h3.find(l => l.field === 'city')
  ok('#464 変更前の値も残す（口座番号は伏せる・空欄にした項目は新しい値が空）',
    r3.status === 200 && acc3.old_value === '****5678' && acc3.new_value === '****4321' && city3.old_value === '渋谷区' && city3.new_value === null, h3.slice(0, 3))

  const r4 = await admin.put(`/api/admin/employees/${sid}`, { profile: { name: `${PFX} 履歴 次郎`, gender: 'male', nearest_station: '新宿' } })
  const h4 = await history()
  const nm = h4.find(l => l.field === 'name')
  ok('#464 スタッフ基本情報（氏名・最寄駅）の変更も履歴に残る（source=profile）',
    r4.status === 200 && nm && nm.source === 'profile' && nm.old_value === `${PFX} 履歴 一郎` && nm.new_value === `${PFX} 履歴 次郎` && h4.some(l => l.field === 'nearest_station' && l.new_value === '新宿'), h4.slice(0, 3))
  ok('#464 送っていない・変わっていない基本情報（性別）は残さない', !h4.some(l => l.field === 'gender'), h4)

  // 在籍状況（休職）
  const r5 = await admin.put(`/api/admin/employees/${sid}`, { profile: { name: `${PFX} 履歴 次郎`, gender: 'male', employment_status: 'leave' } })
  const h5 = await history()
  ok('#464 在籍状況の変更が履歴に残る', r5.status === 200 && h5.some(l => l.field === 'employment_status' && l.old_value === 'working' && l.new_value === 'leave'), h5.slice(0, 3))

  // 権限（#205）: 現場担当は従業員管理の履歴を見られない
  const m = await mgr.get(`/api/admin/employees/${sid}/history`)
  ok('#205 現場担当は変更履歴を見られない（403）', m.status === 403, m)
  const other = await admin.get('/api/admin/employees/999999/history')
  ok('#464 社員名簿の対象でないスタッフは 404', other.status === 404, other)

  // ページ送り
  const page = must(await admin.get(`/api/admin/employees/${sid}/history?before=${h5[1].log_id}`), 'history page')
  ok('#464 before で古い履歴を続けて取れる', page.logs.length === h5.length - 2 && page.logs.every(l => l.log_id < h5[1].log_id), page)

  // 口座・給与の変更は、変更した人以外の会社管理者に知らせる
  const notesOf = async (c) => must(await c.get('/api/admin/notifications?kind=employee_payroll_changed'), 'notifications').notifications || []
  const n0 = (await notesOf(admin)).length
  const ofcCode = `${PFX}ofc`
  must(await admin.post('/api/admin/users', { user_code: ofcCode, name: `${PFX} 事務`, role: 'office_staff', password: 'pass1234' }), 'office user')
  const ofc = client(await login('sample', ofcCode))
  const r6 = await put(ofc, { account_number: '11112222', base_salary: 260000 })
  const n1 = await notesOf(admin)
  const note = n1[0]
  ok('#464 事務担当が口座・給与を変えたら会社管理者に通知する', r6.status === 200 && n1.length === n0 + 1 && note.title.includes(`${PFX} 履歴 次郎`) && note.body.includes('口座番号') && note.body.includes('基本給'), n1.slice(0, 1))
  ok('#464 通知に口座番号・金額の値は書かない', note && !note.body.includes('11112222') && !note.body.includes('260000'), note)
  const r7 = await put(admin, { account_number: '33334444' })
  ok('#464 自分の変更は自分に通知しない', r7.status === 200 && (await notesOf(admin)).length === n0 + 1)
  const r8 = await put(ofc, { city: '港区' })
  ok('#464 口座・給与以外の変更は通知しない', r8.status === 200 && (await notesOf(admin)).length === n0 + 1)
}

// ---------- #430 CSV 一括登録 ----------
{
  const tpl = await admin.get('/api/admin/roster/import/template')
  ok('#430 テンプレート CSV を返す', tpl.status === 200 && /text\/csv/.test(tpl.headers.get('content-type') || '') && String(tpl.data).includes('区分,氏名,フリガナ,性別'), String(tpl.data).slice(0, 120))

  const header = ['区分', '氏名', 'フリガナ', '性別', '生年月日', '電話番号', 'スタッフ番号', '取引先名', '社員番号', '入社年月日', '備考の列']
  const p1 = newPhone(), p2 = newPhone(), p3 = newPhone()
  const rows = [
    { line: 2, cells: ['自社雇用', `${PFX} 取込 一郎`, 'トリコミ イチロウ', '男性', '1990/4/1', p1, '', '', `${PFX}E1`, '2026/4/1', 'x'] },
    { line: 3, cells: ['取引先', `${PFX} 取込 花子`, '', '女', '', p2, '', `${PFX}商事`, '', '', ''] },
    { line: 4, cells: ['スキルシートのみ', `${PFX} 取込 三郎`, '', 'male', '', '', '', '', '', '', ''] },
    { line: 5, cells: ['自社雇用', `${PFX} 取込 四郎`, '', '', '', '', '', '', '', '', ''] },
    { line: 6, cells: ['派遣', `${PFX} 取込 五郎`, '', '男性', '', '', '', '', '', '', ''] },
    { line: 7, cells: ['自社雇用', `${PFX} 取込 六郎`, '', '男性', '', '', 'st001', '', '', '', ''] },
    { line: 8, cells: ['取引先', `${PFX} 取込 七子`, '', '女性', '', '9012345678', '', `${PFX}商事`, '', '', ''] },
    { line: 9, cells: ['取引先', `${PFX} 取込 八子`, '', '女性', '', '', '', '株式会社サンプルモバイル人材', '', '', ''] },
    { line: 10, cells: ['取引先', `${PFX} 取込 九子`, '', '女性', '', '', '', '株式会社テレコムスタッフ東海', '', '', ''] },
    { line: 11, cells: ['取引先', `${PFX} 取込 十子`, '', '女性', '', '090-1111-1000', '', `${PFX}商事`, '', '', ''] },
    { line: 12, cells: ['自社雇用', `${PFX} 取込 十一`, '', '男性', '', p3, '', '', `${PFX}E1`, '', ''] },
  ]
  const pv = await admin.post('/api/admin/roster/import/preview', { header, rows })
  const by = (line) => (pv.data.rows || []).find(r => r.line === line) || { errors: [], warnings: [], notes: [] }
  ok('#430 確かめるだけの結果を行ごとに返す', pv.status === 200 && pv.data.rows.length === rows.length, pv)
  ok('#430 知らない見出しは「読まない列」として返す', (pv.data.unknown_columns || []).includes('備考の列'), pv.data.unknown_columns)
  ok('#430 自社雇用の正しい行は登録でき、スタッフ番号は自動で採番する', !by(2).errors.length && !by(2).warnings.length && by(2).login && by(2).notes.some(n => n.includes('空いている番号')), by(2))
  ok('#430 取引先の新しい名前は「新しく登録」と知らせる（ログインは作らない）', !by(3).errors.length && !by(3).login && by(3).notes.some(n => n.includes('新しく登録')), by(3))
  ok('#430 スキルシートのみの行（性別は male でも可）', !by(4).errors.length && !by(4).login, by(4))
  ok('#430 性別がない行はエラー', by(5).errors.some(e => e.includes('性別')), by(5))
  ok('#430 区分が正しくない行はエラー', by(6).errors.some(e => e.includes('区分')), by(6))
  ok('#430 登録済みのスタッフ番号はエラー', by(7).errors.some(e => e.includes('登録済み')), by(7))
  ok('#430 先頭の0が消えた電話番号はエラー', by(8).errors.some(e => e.includes('0から始まる')), by(8))
  ok('#430 取引先名が自社名ならエラー', by(9).errors.some(e => e.includes('自社名')), by(9))
  ok('#430 取引先名が他の導入企業名ならエラー', by(10).errors.some(e => e.includes('導入企業')), by(10))
  ok('#430 登録済みのスタッフと電話番号が同じなら警告', !by(11).errors.length && by(11).warnings.some(w => w.includes('同じ人と思われる')), by(11))
  ok('#430 ファイルの中で社員番号が重複したらエラー', by(12).errors.some(e => e.includes('2 行目と同じ')), by(12))
  ok('#430 件数のまとめ', pv.data.summary && pv.data.summary.error === 7 && pv.data.summary.warning === 1 && pv.data.summary.ok === 3, pv.data.summary)

  const tooMany = await admin.post('/api/admin/roster/import/commit', { header, rows: [rows[0], { line: 13, cells: ['自社雇用', `${PFX} 取込 十二`, '', '男性', '', '', '', '', '', '', ''] }] })
  ok('#430 ログインを作る行を1回に2行送ると 400（CPU 時間の上限のため）', tooMany.status === 400, tooMany)
  const tooManyRows = await admin.post('/api/admin/roster/import/commit', { header, rows: rows.slice(0, 6) })
  ok('#430 1回に6行以上送ると 400', tooManyRows.status === 400, tooManyRows)

  const c1 = await admin.post('/api/admin/roster/import/commit', { header, rows: [rows[0]] })
  const own = c1.data && c1.data.results && c1.data.results[0]
  ok('#430 自社雇用を登録し、スタッフ番号と初期パスワードを返す', c1.status === 200 && own.status === 'created' && own.user_code && own.password && own.password.length >= 8, c1)
  if (own && own.status === 'created') {
    const lg = await tryLogin('sample', own.user_code, own.password)
    ok('#430 返された初期パスワードでログインできる', lg.status === 200, lg)
    const emp = must(await admin.get(`/api/admin/employees/${own.staff_id}`), 'employee')
    ok('#430 自社雇用は従業員管理（社員番号・入社年月日・電話番号）も作る', emp.record && emp.record.employee_number === `${PFX}E1` && emp.record.hire_date === '2026-04-01' && emp.staff.date_of_birth === '1990-04-01' && emp.staff.affiliation === '株式会社サンプルモバイル人材', emp)
  }
  const c2 = await admin.post('/api/admin/roster/import/commit', { header, rows: [rows[1], rows[2], rows[3], rows[9]] })
  const st = (c2.data.results || []).map(r => r.status)
  ok('#430 ログインなしの行はまとめて登録し、エラーは登録せず、警告は accept_warnings がなければ登録しない',
    c2.status === 200 && st.join(',') === 'created,created,error,skipped' && c2.data.results.every(r => !r.password), c2.data)
  const partnerSid = c2.data.results[0].staff_id
  const lc = must(await admin.get(`/api/admin/staff/${partnerSid}`), 'partner staff')
  const prof = lc.profile || lc.staff || lc
  ok('#430 取引先の人は新しい取引先に結び付く', String(JSON.stringify(prof)).includes(`${PFX}商事`), prof)
  const partners = must(await admin.get('/api/admin/roster/partners'), 'partners').partners
  ok('#430 新しい取引先がマスタに登録される', partners.some(p => p.affiliation_name === `${PFX}商事`), partners.slice(-3))
  const c3 = await admin.post('/api/admin/roster/import/commit', { header, rows: [rows[9]], accept_warnings: true })
  ok('#430 accept_warnings なら警告の行も登録する', c3.status === 200 && c3.data.results[0].status === 'created', c3.data)
  const again = await admin.post('/api/admin/roster/import/commit', { header, rows: [rows[1]] })
  ok('#430 同じ行をもう一度送ると、登録済みと同じ人の警告になり登録しない', again.status === 200 && again.data.results[0].status === 'skipped' && again.data.results[0].warnings.some(w => w.includes('同じ人')), again.data)
  const mgrPv = await mgr.post('/api/admin/roster/import/preview', { header, rows: [rows[2]] })
  ok('#430 管理系のロール（現場担当）も 1件ずつの登録と同じく使える', mgrPv.status === 200, mgrPv)
  const noHead = await admin.post('/api/admin/roster/import/preview', { header: ['氏名', '性別'], rows: [rows[2]] })
  ok('#430 区分の列がなければ 400', noHead.status === 400 && String(noHead.data.error).includes('区分'), noHead)
  const staffApi = client((await tryLogin('sample', 'st001')).cookie)
  const forbidden = await staffApi.post('/api/admin/roster/import/preview', { header, rows: [rows[2]] })
  ok('#430 スタッフは使えない', forbidden.status === 403 || forbidden.status === 401, forbidden.status)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
