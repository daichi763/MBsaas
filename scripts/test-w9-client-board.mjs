// w9-client-board（#9101 #9102 #9103 #9104）の統合テスト
// クライアント画面の項目の見直し（代表者氏名・種別・支店・部門）と、案件掲示板の「自社の案件から内容をコピー」を確かめる。
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npm run build && npx wrangler dev --local --port 8810 --persist-to <保存先> で起動していること。
//   PERSIST に --persist-to の保存先を指定する（マイグレーション 0089 の移行を、ローカルの D1 で直接確かめる。テスト用の DB 専用）
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node scripts/test-w9-client-board.mjs
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.error('PERSIST（--persist-to の保存先）を指定してください'); process.exit(2) }
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 500) : ''}`) }
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts) } catch (e) { return fetch(url, opts) }
}
async function login(company_code, user_code, password = 'pass1234') {
  const r = await fetchRetry(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (!r.ok || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetchRetry(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}) }
}
function d1(sql) {
  const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', '--command', sql.replace(/\s+/g, ' ')], { encoding: 'utf8' })
      return JSON.parse(out.slice(out.indexOf('['))).map(r => r.results)
    } catch (e) { if (i >= 3) throw e }
  }
}
const must = (r, what) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.data }
const staticJs = async (name) => (await fetchRetry(`${BASE}/static/${name}`)).text()
const PFX = 'W9C' + Date.now().toString(36).slice(-4).toUpperCase()
const admin = client(await login('sample', 'admin'))

// ---------- #9101 マイグレーション 0089: 担当者（clients.contact_name）を顧客担当者の一覧へ写す ----------
{
  const d = must(await admin.get('/api/admin/clients/1'), 'client 1')
  const names = (d.contacts || []).map(x => x.contact_name)
  ok('#9101 シードのクライアントの担当者（西村 様）が、顧客担当者の一覧に1件として入っている', names.filter(n => n === '西村 様').length === 1, names)
  ok('#9101 クライアントの元の値（担当者・契約形態）は消さずに残す', d.client.contact_name === '西村 様' && d.client.contract_type === '業務委託', d.client)
  ok('#9102 #9103 新しい列（種別・支店・部門）が詳細に含まれる', ['client_kind', 'branch_name', 'department_name'].every(k => k in d.client), Object.keys(d.client))
  // 同じ名前の担当者がすでにあれば写さない（移行の文をもう一度流しても増えない）
  const sql = readFileSync(fileURLToPath(new URL('../migrations/0089_client_fields.sql', import.meta.url)), 'utf8')
  const insert = sql.slice(sql.indexOf('INSERT INTO client_contacts')).split(';')[0]
  const count = () => Number(d1('SELECT COUNT(*) AS n FROM client_contacts')[0][0].n)
  const before = count()
  d1(insert)
  ok('#9101 移行の文をもう一度流しても、同じ名前の担当者は増えない', count() === before, [before, count()])
  // 担当者が空のクライアントは写さない
  const blank = d1(`SELECT COUNT(*) AS n FROM client_contacts WHERE TRIM(contact_name) = ''`)[0][0].n
  ok('#9101 空の名前の担当者は作らない', Number(blank) === 0, blank)
}

// ---------- #9101 #9102 #9103 編集（PUT /admin/clients/:id） ----------
{
  const cid = must(await admin.post('/api/admin/clients', { client_name: `${PFX}-編集用` }), 'create').client_id
  let r = await admin.put(`/api/admin/clients/${cid}`, { representative_name: '  山田 太郎  ', client_kind: 'sole_proprietor', branch_name: ' 新宿支店 ', department_name: '営業部' })
  ok('#9101 #9102 #9103 代表者氏名・種別・支店・部門を保存できる', r.status === 200, r)
  let c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail').client
  ok('#9101 #9102 #9103 保存した値が詳細に出る（前後の空白は除く）', c.representative_name === '山田 太郎' && c.client_kind === 'sole_proprietor' && c.branch_name === '新宿支店' && c.department_name === '営業部', c)
  r = await admin.put(`/api/admin/clients/${cid}`, { client_kind: 'partnership' })
  ok('#9102 決まった種別（法人・個人事業主・その他）以外は 400', r.status === 400 && /種別/.test(r.data && r.data.error), r)
  r = await admin.put(`/api/admin/clients/${cid}`, { branch_name: 'あ'.repeat(101) })
  ok('#9103 支店は100文字まで（超えると 400）', r.status === 400 && /支店/.test(r.data && r.data.error), r)
  r = await admin.put(`/api/admin/clients/${cid}`, { department_name: 123 })
  ok('#9103 部門が文字でなければ 400', r.status === 400, r)
  c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail2').client
  ok('#9103 誤りのある保存では値を変えない', c.branch_name === '新宿支店' && c.client_kind === 'sole_proprietor', c)
  // 支店・部門だけを送っても、他の項目は変わらない（画面の「支店・部門」の保存）
  r = await admin.put(`/api/admin/clients/${cid}`, { branch_name: '', department_name: '管理部' })
  c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail3').client
  ok('#9103 支店・部門だけの保存: 空欄は消し、他の項目はそのまま', r.status === 200 && c.branch_name === null && c.department_name === '管理部' && c.representative_name === '山田 太郎' && c.client_kind === 'sole_proprietor', c)
  r = await admin.put(`/api/admin/clients/${cid}`, { client_kind: '', representative_name: '' })
  c = must(await admin.get(`/api/admin/clients/${cid}`), 'detail4').client
  ok('#9101 #9102 種別・代表者氏名は空欄で未設定に戻せる', r.status === 200 && c.client_kind === null && c.representative_name === null, c)
  for (const k of ['corporation', 'other']) {
    r = await admin.put(`/api/admin/clients/${cid}`, { client_kind: k })
    ok(`#9102 種別 ${k} を保存できる`, r.status === 200 && must(await admin.get(`/api/admin/clients/${cid}`), 'k').client.client_kind === k, r)
  }
  // これまでの API（契約形態・担当者）も受け付ける（既存の連携を壊さない）
  r = await admin.put(`/api/admin/clients/${cid}`, { contract_type: '派遣' })
  ok('#9102 契約形態（contract_type）の保存はこれまでどおり受け付ける（画面には出さない）', r.status === 200 && must(await admin.get(`/api/admin/clients/${cid}`), 'ct').client.contract_type === '派遣', r)
}

// ---------- #9101 #9102 #9103 登録（POST /admin/clients）と一覧 ----------
{
  const name = `${PFX}-新規`
  let r = await admin.post('/api/admin/clients', { client_name: name + '-誤り', client_kind: 'xxx' })
  ok('#9102 登録でも種別を確かめる（誤りは 400）', r.status === 400, r)
  r = await admin.post('/api/admin/clients', { client_name: name, client_kind: 'corporation', representative_name: '佐藤 花子', branch_name: '大阪支店', department_name: '催事部' })
  ok('#9101 #9102 #9103 種別・代表者氏名・支店・部門を付けて登録できる', r.status === 200 && r.data.client_id, r)
  const cid = r.data.client_id
  const c = must(await admin.get(`/api/admin/clients/${cid}`), 'new detail').client
  ok('#9101 #9102 #9103 登録した値が詳細に出る', c.client_kind === 'corporation' && c.representative_name === '佐藤 花子' && c.branch_name === '大阪支店' && c.department_name === '催事部', c)
  // 以前の画面・外部から担当者の名前が送られてきたら、顧客担当者の一覧に入れる
  const r2 = await admin.post('/api/admin/clients', { client_name: name + '-担当者あり', contact_name: ' 鈴木 様 ' })
  const d2 = must(await admin.get(`/api/admin/clients/${r2.data.client_id}`), 'contact detail')
  ok('#9101 登録で担当者の名前が送られたら、顧客担当者の一覧に1件入れる', r2.status === 200 && d2.contacts.length === 1 && d2.contacts[0].contact_name === '鈴木 様', d2.contacts)
  const list = must(await admin.get('/api/admin/clients'), 'list').clients
  const row = list.find(x => x.client_id === cid), row1 = list.find(x => x.client_id === 1)
  ok('#9101 #9102 一覧に代表者氏名・種別が含まれる', row && row.representative_name === '佐藤 花子' && row.client_kind === 'corporation', row)
  ok('#9101 一覧に顧客担当者の名前（検索用の contact_names）が含まれる', row1 && String(row1.contact_names || '').includes('西村 様'), row1 && row1.contact_names)
}

// ---------- 画面のコード（配信される JS） ----------
{
  const a = await staticJs('admin.js'), b = await staticJs('board.js')
  const card = a.slice(a.indexOf('function drawClientCards'), a.indexOf('// クライアント（発注元企業）詳細画面'))
  ok('#9101 #9102 一覧のカードは「代表者氏名」「種別」を出し、「担当者」「契約形態」は出さない',
    card.includes('代表者氏名') && card.includes('clientKindLabel(c.client_kind)') && !card.includes('>担当者<') && !card.includes('契約形態'))
  ok('#9101 一覧の検索は代表者氏名と顧客担当者の名前でも引ける', card.includes('c.representative_name, c.contact_names'))
  const basic = a.slice(a.indexOf('function clientBasicHtml'), a.indexOf('function clientOrgHtml'))
  ok('#9101 会社基本情報は「担当者」の欄を出さず、代表者氏名を表示・編集する（下の代表者・インボイス情報とは重複させない）',
    !basic.includes('c.contact_name') && !basic.includes('cl-contact') && (basic.match(/cl-rep-name/g) || []).length === 1 && (basic.match(/代表者氏名/g) || []).length === 2)
  ok('#9102 会社基本情報は「契約形態」をやめ「種別」（法人・個人事業主・その他）を出す',
    !basic.includes('契約形態') && !basic.includes('contract_type') && basic.includes('id="cl-kind"') && a.includes("corporation: '法人', sole_proprietor: '個人事業主', other: 'その他'"))
  const save = a.slice(a.indexOf('window.saveClientBasicInfo'), a.indexOf('// ============ 社員名簿'))
  ok('#9101 #9102 会社基本情報の保存は代表者氏名・種別を送り、担当者・契約形態は送らない',
    save.includes("representative_name: v('cl-rep-name')") && save.includes("client_kind: v('cl-kind')") && !save.includes('contact_name') && !save.includes('contract_type'))
  const iBasic = a.indexOf('id="client-basic-info"'), iOrg = a.indexOf('id="client-org-info"'), iDeals = a.indexOf('id="client-deals"')
  ok('#9103 支店・部門の欄を、会社基本情報と取引の実績の間に置く', iBasic > 0 && iOrg > iBasic && iDeals > iOrg)
  ok('#9103 支店・部門は「編集」で入力欄に切り替えて保存できる',
    a.includes("delegate('editClientOrg'") && a.includes("delegate('cancelClientOrg'") && a.includes("delegate('saveClientOrg'") && a.includes("inp('cl-branch', '支店'") && a.includes("inp('cl-department', '部門'"))
  const add = a.slice(a.indexOf('window.showAddClient'), a.indexOf('// ============ シフト管理'))
  ok('#9101 #9102 クライアント登録のフォームは「代表者氏名」「種別」（担当者・契約形態はなし）',
    add.includes('代表者氏名') && add.includes('id="nc-kind"') && add.includes("client_kind: document.getElementById('nc-kind').value") && !add.includes('nc-contact') && !add.includes('契約形態'))
  ok('#9104 案件掲示板: 反映ボタンをなくし、案件を選んだらその場でフォームに入れる',
    !b.includes('__boardCopyProject()"') && !b.includes('>反映</button>') && b.includes("copySrc.addEventListener('change'"))
  ok('#9104 フォームに入力があるときだけ上書きを確かめ、やめたら選択を元に戻す',
    b.includes('const filled = COPY_TARGETS.some') && b.includes("if (filled && !confirm(") && b.includes("sel.value = sel.dataset.prev || ''"))
  ok('#9104 読み込みの間に選び直したときは古い結果を入れない', b.includes('seq !== copySeq'))
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
