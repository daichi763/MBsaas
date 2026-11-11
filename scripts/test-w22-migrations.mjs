// 作られていない索引・会社をまたぐトリガー・移行の控えの表（Sprint 22・w22-migrations）の統合テスト
//   #9948 0049 の idx_board_proposals_imported は 0026 と同じ名前で作られていなかった → 0102 で idx_board_proposals_dup_check を作る。
//         migrations の中で、同じ名前の索引を別の定義で作っているものがないかも確かめる
//   #9949 roster_comment_reads の削除トリガーが、会社をまたいで利用者の既読を消していた → 0102 で同じ会社の分だけ消すように作り直す
//   #9950 移行の控えの表3つ（attendance_reports_duplicates_0036・daily_report_duplicates・roster_value_fixes）を 0103 で消す。
//         表が無くても、解約（書き出し・削除）・退職後の削除の集計・案件の削除が動く
//
// 前提: bash scripts/setup-test-db.sh <保存先> でローカルの D1 を作り直し、
//   npx wrangler dev --local --port 8810 --persist-to <保存先> で起動していること（追加の起動オプションはない）。
// 実行: BASE=http://127.0.0.1:8810 PERSIST=<保存先> node --import ./scripts/fetch-origin.mjs scripts/test-w22-migrations.mjs
//   PERSIST は必須（テスト用のデータをローカルの D1 に直接入れる）。本番には接続しない（wrangler d1 execute は --local のみ）。
//   企業を1つ作って解約・削除するので、テストのたびに DB を作り直すこと（npm test -- w22-migrations なら自動で行う）
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rawFetch = globalThis.fetch
globalThis.fetch = async (...args) => { try { return await rawFetch(...args) } catch (e) { if (!['ECONNRESET', 'ECONNABORTED'].includes(e?.cause?.code)) throw e; return rawFetch(...args) } }
const BASE = process.env.BASE || 'http://127.0.0.1:8810'
const PERSIST = process.env.PERSIST || ''
if (!PERSIST) { console.log('PERSIST（ローカルの D1 の保存先）を指定してください'); process.exit(1) }
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`) }

async function rawLogin(company_code, user_code, password = 'pass1234') {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_code, user_code, password }) })
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0]
  if (r.status !== 200 || !cookie) throw new Error(`login failed: ${company_code}/${user_code} ${r.status}`)
  return cookie
}
function client(cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let data = null; try { data = JSON.parse(text) } catch { }
    return { status: r.status, data, text }
  }
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), del: (p) => call('DELETE', p) }
}
// シェルを通さずに wrangler を呼ぶ（ローカルの D1 のみ）。最後の文の結果を返す
const TMP = mkdtempSync(join(tmpdir(), 'w22mg-'))
let seq = 0
function sql(command) {
  const file = join(TMP, `q${++seq}.sql`)
  writeFileSync(file, command)
  const cli = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  // 開発サーバーが D1 を使っている間は、まれに internal error になるので数回やり直す
  for (let i = 0; ; i++) {
    try {
      const out = execFileSync(process.execPath, [cli, 'd1', 'execute', 'mbsaas-production', '--local', '--persist-to', PERSIST, '--json', `--file=${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return JSON.parse(out.slice(out.indexOf('['))).at(-1).results
    } catch (e) { if (i >= 3) throw e }
  }
}
const SUF = String(Date.now()).slice(-6)
const jstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const BACKUP_TABLES = ['attendance_reports_duplicates_0036', 'daily_report_duplicates', 'roster_value_fixes']

// ---------- #9948 migrations の中で、同じ名前の索引を別の定義で作っていないか ----------
{
  const files = readdirSync(join(ROOT, 'migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()
  const seen = new Map() // 索引の名前 → { file, def }（DROP INDEX で消したら忘れる）
  const conflicts = []
  for (const f of files) {
    const text = readFileSync(join(ROOT, 'migrations', f), 'utf8').replace(/--[^\n]*/g, '')
    const re = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+([^;]+);|DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi
    for (const m of text.matchAll(re)) {
      if (m[4]) { seen.delete(m[4]); continue }
      const def = `${m[1] ? 'UNIQUE ' : ''}${m[3]}`.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase()
      const prev = seen.get(m[2])
      if (!prev) seen.set(m[2], { file: f, def })
      else if (prev.def !== def) conflicts.push({ name: m[2], first: `${prev.file}: ${prev.def}`, again: `${f}: ${def}` })
    }
  }
  // 0049 の idx_board_proposals_imported は本番に当てた後なので書き換えない（0102 で別の名前で作り直した）。これ以外は増やさない
  const KNOWN = ['idx_board_proposals_imported']
  ok('#9948 同じ名前の索引を別の定義で作るマイグレーションがない（既知の 0026/0049 を除く）', conflicts.every(c => KNOWN.includes(c.name)), conflicts)
  ok('#9948 既知の重なり（0026 と 0049 の idx_board_proposals_imported）は、このテストで見つけられる', conflicts.some(c => c.name === 'idx_board_proposals_imported' && /0026/.test(c.first) && /0049/.test(c.again)), conflicts)
  const m102 = readFileSync(join(ROOT, 'migrations', files.find(f => f.startsWith('0102_'))), 'utf8')
  ok('#9948 0102 で二重取り込みの確認の索引を別の名前で作る', /CREATE INDEX IF NOT EXISTS idx_board_proposals_dup_check ON board_proposals\(receiver_company_id, proposer_company_id, staff_id\)/.test(m102))
  const m103name = files.find(f => f.startsWith('0103_'))
  const m103 = readFileSync(join(ROOT, 'migrations', m103name), 'utf8')
  ok('#9950 表の削除は 0102 と分けて 0103 に書く（0102 は表を消さない）', !/DROP\s+TABLE/i.test(m102) && BACKUP_TABLES.every(t => new RegExp(`DROP TABLE IF EXISTS ${t};`).test(m103)), m103name)
  ok('#9950 0103 は控えの表3つ以外を消さない', (m103.replace(/--[^\n]*/g, '').match(/DROP\s+\w+/gi) || []).length === 3)
}

// ---------- #9950 コード（src・public・scripts）に、消した表の参照が残っていない ----------
{
  const hits = []
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs|cjs|sh)$/.test(e.name) && !/test-w22-migrations\.mjs$/.test(p)) {
        const s = readFileSync(join(ROOT, p), 'utf8')
        for (const t of BACKUP_TABLES) if (s.includes(t)) hits.push(`${p}: ${t}`)
      }
    }
  }
  for (const d of ['src', 'public/static', 'scripts']) walk(d)
  ok('#9950 src・public・scripts に、消した控えの表の参照がない', hits.length === 0, hits)
}

// ---------- ローカルの D1 の形（0102・0103 を当てた後） ----------
{
  const idx = sql(`SELECT name FROM pragma_index_info('idx_board_proposals_dup_check') ORDER BY seqno`).map(r => r.name)
  ok('#9948 idx_board_proposals_dup_check が (receiver_company_id, proposer_company_id, staff_id) で作られている', idx.join(',') === 'receiver_company_id,proposer_company_id,staff_id', idx)
  const old = sql(`SELECT name FROM pragma_index_info('idx_board_proposals_imported') ORDER BY seqno`).map(r => r.name)
  ok('#9948 0026 の idx_board_proposals_imported（imported_staff_id）はそのまま残る', old.join(',') === 'imported_staff_id', old)
  const plan = sql(`EXPLAIN QUERY PLAN SELECT proposal_id FROM board_proposals INDEXED BY idx_board_proposals_dup_check WHERE receiver_company_id = 1 AND proposer_company_id = 2 AND staff_id = 3`)
  ok('#9948 二重取り込みの確認の条件で、新しい索引を使える', plan.some(r => /idx_board_proposals_dup_check/.test(r.detail || '')), plan)
  const trg = sql(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_roster_comment_reads_delete'`)
  ok('#9949 削除トリガーは同じ会社（company_id = OLD.company_id）の既読だけを消す', trg.length === 1 && /thread_staff_id = OLD\.thread_staff_id AND company_id = OLD\.company_id/.test(trg[0].sql), trg)
  const left = sql(`SELECT name FROM sqlite_master WHERE name IN (${BACKUP_TABLES.map(t => `'${t}'`).join(', ')}) OR name = 'idx_daily_report_duplicates_staff'`)
  ok('#9950 控えの表3つ（と索引）が消えている', left.length === 0, left)
}

const hq = client(await rawLogin('', 'hq'))
const admin = client(await rawLogin('sample', 'admin'))
const B = Number(sql(`SELECT company_id FROM companies WHERE company_code = 'sample'`)[0].company_id)
const bAdmin = Number(sql(`SELECT user_id FROM users WHERE company_id = ${B} AND user_code = 'admin'`)[0].user_id)

// ---------- #9949 トリガー: 会社 X の既読位置を消しても、相手の会社 B の利用者の既読は消えない ----------
{
  // スレッドの行（稼働先 B の連携行のつもり）を2つ。T1 は会社 X の行だけを消す、T2 はスレッドごと消す（退職後の削除と同じ）
  sql(`INSERT INTO users (company_id, user_code, name, role, password_hash) VALUES (${B}, 'w22mg_t1_${SUF}', 'W22 連携 一', 'staff', 'x'), (${B}, 'w22mg_t2_${SUF}', 'W22 連携 二', 'staff', 'x');
    INSERT INTO staff_profiles (user_id, company_id) SELECT user_id, ${B} FROM users WHERE user_code IN ('w22mg_t1_${SUF}', 'w22mg_t2_${SUF}');`)
  const [T1, T2] = sql(`SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.user_code IN ('w22mg_t1_${SUF}', 'w22mg_t2_${SUF}') ORDER BY u.user_code`).map(r => Number(r.staff_id))
  const other = sql(`SELECT company_id, user_id FROM users WHERE company_id != ${B} ORDER BY user_id LIMIT 1`)[0]
  const A = Number(other.company_id), aUser = Number(other.user_id)
  sql(`INSERT INTO roster_comment_reads (thread_staff_id, company_id, last_read_comment_id, read_by) VALUES (${T1}, ${A}, 5, ${aUser}), (${T1}, ${B}, 5, ${bAdmin}), (${T2}, ${A}, 5, ${aUser}), (${T2}, ${B}, 5, ${bAdmin});
    INSERT INTO roster_comment_user_reads (thread_staff_id, user_id, company_id, last_read_comment_id) VALUES (${T1}, ${aUser}, ${A}, 5), (${T1}, ${bAdmin}, ${B}, 5), (${T2}, ${aUser}, ${A}, 5), (${T2}, ${bAdmin}, ${B}, 5);
    DELETE FROM roster_comment_reads WHERE thread_staff_id = ${T1} AND company_id = ${A};
    DELETE FROM roster_comment_reads WHERE thread_staff_id = ${T2};`)
  const t1 = sql(`SELECT company_id FROM roster_comment_user_reads WHERE thread_staff_id = ${T1} ORDER BY company_id`).map(r => Number(r.company_id))
  const t2 = sql(`SELECT COUNT(*) AS n FROM roster_comment_user_reads WHERE thread_staff_id = ${T2}`)[0].n
  ok('#9949 会社 X の既読位置を消すと、X の利用者の既読だけが消え、相手の会社の利用者の既読は残る', t1.length === 1 && t1[0] === B, t1)
  ok('#9949 スレッドの既読位置をすべて消すと（退職後の削除）、両方の会社の利用者の既読が消える', t2 === 0, t2)
}

// ---------- #9949 #9950 解約: 控えの表が無くても書き出し・削除が最後まで動き、相手の会社の既読は残る ----------
{
  const code = `w22mg${SUF}`
  let r = await hq.post('/api/hq/companies', { admin_email: 'admin@example.com', company_code: code, company_name: 'W22 解約テスト企業', admin_code: 'admin', admin_password: 'Passw0rd!Long' })
  ok('（前提）解約するテスト用の企業 X を作る', r.status === 200, r.data)
  const X = Number(sql(`SELECT company_id FROM companies WHERE company_code = '${code}'`)[0].company_id)
  const xAdmin = Number(sql(`SELECT user_id FROM users WHERE company_id = ${X} AND user_code = 'admin'`)[0].user_id)
  // 稼働先 B（sample）の連携行 T のスレッドに、所属元 X が書いたメッセージ。X の既読は既読にした形で入れる
  sql(`INSERT INTO users (company_id, user_code, name, role, password_hash) VALUES (${B}, 'w22mg_t_${SUF}', 'W22 連携 太郎', 'staff', 'x');
    INSERT INTO staff_profiles (user_id, company_id) SELECT user_id, ${B} FROM users WHERE user_code = 'w22mg_t_${SUF}';`)
  const T = Number(sql(`SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE u.user_code = 'w22mg_t_${SUF}'`)[0].staff_id)
  sql(`INSERT INTO roster_comments (thread_staff_id, owner_company_id, host_company_id, author_company_id, author_user_id, body, created_at)
      VALUES (${T}, ${X}, ${B}, ${X}, ${xAdmin}, 'W22 体調についての連絡', datetime('now', '+9 hours', '+1 minute'));`)
  const cid = Number(sql(`SELECT MAX(comment_id) AS c FROM roster_comments WHERE thread_staff_id = ${T}`)[0].c)
  sql(`INSERT INTO roster_comment_reads (thread_staff_id, company_id, last_read_comment_id, read_by) VALUES (${T}, ${X}, ${cid}, ${xAdmin});
    INSERT INTO roster_comment_user_reads (thread_staff_id, user_id, company_id, last_read_comment_id) VALUES (${T}, ${xAdmin}, ${X}, ${cid});`)
  const u0 = await admin.get('/api/admin/roster-chat/unread-count')
  r = await admin.get(`/api/admin/roster-chat/ended/${T}`)
  ok('（前提）B の管理者がスレッドを開いて既読にする', r.status === 200 && r.data?.messages?.length === 1, r.data)
  const u1 = await admin.get('/api/admin/roster-chat/unread-count')
  ok('（前提）B の管理者の未読が1件減る', u0.status === 200 && u1.data?.unread === u0.data?.unread - 1, [u0.data, u1.data])

  // 解約: 停止 → 契約終了の登録（猶予を過ぎた日付）→ 件数 → 書き出し → 削除
  r = await hq.put(`/api/hq/companies/${X}`, { active_status: 'inactive' })
  ok('（前提）企業 X を停止にする', r.status === 200, r.data)
  r = await hq.post(`/api/hq/offboarding/${X}/start`, { contract_end_date: addDays(jstToday, -40), grace_days: 30, confirm_company_code: code })
  ok('（前提）契約終了を登録する（猶予を過ぎた日付）', r.status === 200, r.data)
  r = await hq.get(`/api/hq/offboarding/${X}`)
  const targets = (r.data?.tables || []).map(t => t.target)
  ok('#9950 解約の詳細（件数）が表なしで動き、控えの表は対象に出ない', r.status === 200 && targets.includes('daily_reports') && !targets.some(t => BACKUP_TABLES.includes(t)), { status: r.status, targets })
  ok('#9950 企業の行を持つ表はすべて削除の一覧に入っている（未対応の表なし）', Array.isArray(r.data?.unknown_tables) && r.data.unknown_tables.length === 0, r.data?.unknown_tables)
  ok('#9950 R2 のファイルの件数に、控えの表は出ない', r.data?.files && !Object.keys(r.data.files).some(k => BACKUP_TABLES.includes(k)), r.data?.files)
  r = await hq.get(`/api/hq/offboarding/${X}/files?offset=0`)
  ok('#9950 写真・書類の一覧を返せる', r.status === 200 && Array.isArray(r.data?.files), r.data)
  r = await hq.get(`/api/hq/offboarding/${X}/export/users?offset=0`)
  ok('#9950 書き出し（CSV）が動く', r.status === 200, r.text.slice(0, 200))
  r = await hq.get(`/api/hq/offboarding/${X}/export/daily_report_duplicates?offset=0`)
  ok('#9950 消した表の書き出しは 404（対象にない）', r.status === 404, r.data)
  let p = null
  for (let i = 0; i < 50; i++) {
    r = await hq.post(`/api/hq/offboarding/${X}/delete`, { confirm_company_code: code, confirm_text: '削除する' })
    if (r.status !== 200) break
    p = r.data
    if (p.done || p.error) break
  }
  ok('#9950 解約の削除を最後まで進められる', r.status === 200 && p?.done === true && !p?.error, { status: r.status, data: r.data })
  const reads = sql(`SELECT (SELECT COUNT(*) FROM roster_comment_reads WHERE thread_staff_id = ${T} AND company_id = ${X}) AS xr,
    (SELECT COUNT(*) FROM roster_comment_user_reads WHERE thread_staff_id = ${T} AND company_id = ${X}) AS xu,
    (SELECT COUNT(*) FROM roster_comment_reads WHERE thread_staff_id = ${T} AND company_id = ${B}) AS br,
    (SELECT COUNT(*) FROM roster_comment_user_reads WHERE thread_staff_id = ${T} AND user_id = ${bAdmin} AND last_read_comment_id = ${cid}) AS bu,
    (SELECT COUNT(*) FROM roster_comments WHERE thread_staff_id = ${T}) AS msgs`)[0]
  ok('#9949 解約した会社 X の既読（会社・利用者）は消える', reads.xr === 0 && reads.xu === 0, reads)
  ok('#9949 相手の会社 B の既読（会社・利用者）は残る（メッセージは解約で消さない）', reads.br === 1 && reads.bu === 1 && reads.msgs === 1, reads)
  const u2 = await admin.get('/api/admin/roster-chat/unread-count')
  ok('#9949 B の管理者に、読んだメッセージがまた未読で出ない', u2.status === 200 && u2.data?.unread === u1.data?.unread, [u1.data, u2.data])
}

// ---------- #9950 退職後の削除・在職中の保存期間の削除の集計（dry-run）が、表なしで動く ----------
{
  const dry = await hq.post('/api/hq/retention/dry-run')
  const res = dry.data?.results || []
  ok('#9950 データ保持の dry-run が動き、どの対象も失敗しない', dry.status === 200 && res.length > 0 && !res.some(x => x.failedCount > 0), dry.status === 200 ? res.filter(x => x.failedCount > 0) : dry.data)
  ok('#9950 dry-run の対象に控えの表は出ない', !res.some(x => BACKUP_TABLES.includes(x.target)), res.map(x => x.target))
  const orphan = await hq.post('/api/hq/retention/orphan-photos', { dry_run: true })
  ok('#9950 紐づかない写真の確認が動く', orphan.status === 200 && typeof orphan.data?.orphans === 'number', orphan.data)
}

// ---------- #9950 案件の削除（使われているかの確かめ）が、日報の控えの表なしで動く ----------
{
  sql(`INSERT INTO projects (company_id, project_name, client_id) SELECT ${B}, 'W22 未使用案件 ${SUF}', client_id FROM clients WHERE company_id = ${B} ORDER BY client_id LIMIT 1;
    INSERT INTO projects (company_id, project_name, client_id) SELECT ${B}, 'W22 日報あり案件 ${SUF}', client_id FROM clients WHERE company_id = ${B} ORDER BY client_id LIMIT 1;`)
  const ids = Object.fromEntries(sql(`SELECT project_id, project_name FROM projects WHERE company_id = ${B} AND project_name LIKE 'W22 %${SUF}'`).map(r => [r.project_name.split(' ')[1], Number(r.project_id)]))
  const st = Number(sql(`SELECT staff_id FROM staff_profiles WHERE company_id = ${B} ORDER BY staff_id LIMIT 1`)[0].staff_id)
  sql(`INSERT INTO daily_reports (company_id, staff_id, project_id, work_date) VALUES (${B}, ${st}, ${ids['日報あり案件']}, '${jstToday}');`)
  let r = await admin.del(`/api/admin/projects/${ids['日報あり案件']}`)
  ok('#9950 日報のある案件は「日報 1件」で使われているとして消せない（409）', r.status === 409 && r.data?.usage?.some(u => u.label === '日報' && u.count === 1), r.data)
  r = await admin.del(`/api/admin/projects/${ids['未使用案件']}`)
  ok('#9950 使われていない案件は消せる', r.status === 200 && r.data?.deleted === ids['未使用案件'], r.data)
}

const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} 件成功`)
process.exit(failed.length ? 1 : 0)
