// バックアップから戻す訓練（Sprint 26 #9979。手順は docs/operations.md の 4章）。ローカルのテスト用 DB だけを使う。
//   本番・mbsaas-stg には接続しない（wrangler はすべて --local。--remote・--env は付けない）。本番のバックアップの SQL（個人情報を含む）も使わない。
//
// 流れ（本番で戻すときと同じコマンドを、ローカルの写しに対して使う）:
//   1. 元の DB（テスト用 DB の写し）の、すべての表の行数と中身のハッシュを控える
//   2. wrangler d1 export で SQL に書き出す（本番の 3.2 の 2 と同じ）
//   3. 誤操作をまねて壊す（行を消す・書き換える）
//   4. A: DB 全体を戻す … 空の DB に書き出した SQL を流し込み（wrangler d1 execute --file）、1 と比べる
//   5. B: 一部の行だけを戻す … 4 の DB から、消えた行・書き換わった行を戻す SQL を作って、壊れた DB に流し、1 と比べる
//   かかった時間・ファイルの大きさ・比べた結果を出す。--json <ファイル> で結果を JSON にも残す。
//
// 使い方:
//   bash scripts/setup-test-db.sh <保存先>                         # テスト用 DB（seed のデータ）を作る
//   node scripts/restore-drill.mjs <保存先> [--json <結果のファイル>] [--keep]
//   <保存先> は setup-test-db.sh か wrangler dev --persist-to に渡したフォルダ。中身は変えない（写しを作って使う）。
//   作業用のフォルダは OS の一時フォルダに作り、終わったら消す（--keep で残す）。
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const DB_NAME = 'mbsaas-production'   // ローカルの写しの名前（wrangler.jsonc と同じ。--local なので本番には触らない）

// ---- 引数 ----
const argv = process.argv.slice(2)
const src = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--json')
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null
const KEEP = argv.includes('--keep')
if (!src) { console.log('使い方: node scripts/restore-drill.mjs <テスト用 DB の保存先> [--json <結果のファイル>] [--keep]'); process.exit(2) }
const srcD1 = join(resolve(src), 'v3', 'd1')
if (!existsSync(srcD1)) { console.log(`${src} にローカルの D1 がありません（v3/d1 が無い）。bash scripts/setup-test-db.sh <保存先> で作ってください`); process.exit(2) }

// ---- wrangler（ローカルだけ） ----
function wrangler(args, cwd) {
  if (!args.includes('--local') || args.some(a => a === '--remote' || a.startsWith('--env') || a === '-e')) throw new Error('この訓練はローカルの DB だけを使います（--local 以外は実行しない）')
  return execFileSync(process.execPath, [WRANGLER, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } })
}
// 訓練用のプロジェクト（D1 の設定だけの wrangler.json）。ローカルの DB は <dir>/.wrangler/state/v3/d1 に置かれる
const DB_ID = (readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/) || [])[1]
function project(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify({ name: 'restore-drill', compatibility_date: '2025-01-01', d1_databases: [{ binding: 'DB', database_name: DB_NAME, database_id: DB_ID }] }, null, 2))
  return dir
}
const sqliteOf = (dir) => {
  const d = join(dir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject')
  const f = existsSync(d) && readdirSync(d).find(n => n.endsWith('.sqlite') && n !== 'metadata.sqlite')
  if (!f) throw new Error(`${dir} に DB がありません`)
  return join(d, f)
}

// ---- 中身を控える（表ごとの行数と、行の並びによらないハッシュ） ----
const SKIP_TABLE = (n) => n.startsWith('sqlite_') || n.startsWith('_cf_')
const cell = (v) => v instanceof Uint8Array ? 'x' + Buffer.from(v).toString('hex') : typeof v === 'bigint' ? String(v) : v
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name).filter(n => !SKIP_TABLE(n))
    const out = { tables: {}, schema: {} }
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t}"`).all().map(r => JSON.stringify(Object.values(r).map(cell))).sort()
      out.tables[t] = { rows: rows.length, hash: createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) }
    }
    for (const r of db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all()) out.schema[`${r.type}:${r.name}`] = r.sql.replace(/\s+/g, ' ').trim()
    return out
  } finally { db.close() }
}
function diff(a, b) {
  const t = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].filter(n => JSON.stringify(a.tables[n]) !== JSON.stringify(b.tables[n]))
  const s = [...new Set([...Object.keys(a.schema), ...Object.keys(b.schema)])].filter(n => a.schema[n] !== b.schema[n])
  return { tables: t.map(n => ({ table: n, before: a.tables[n], after: b.tables[n] })), schema: s }
}
const totalRows = (s) => Object.values(s.tables).reduce((n, t) => n + t.rows, 0)
const timed = (fn) => { const t0 = Date.now(); const r = fn(); return [r, (Date.now() - t0) / 1000] }
const kb = (f) => Math.round(statSync(f).size / 1024)

// ---- 一部の行だけを戻す SQL（主キーで突き合わせる） ----
const lit = (v) => v === null || v === undefined ? 'NULL' : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'` : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
function repairSql(goodFile, brokenFile, tables) {
  const good = new DatabaseSync(goodFile, { readOnly: true }), broken = new DatabaseSync(brokenFile, { readOnly: true })
  const out = [], notes = []
  try {
    // 親の表から入れる（外部キーの順）
    const deps = Object.fromEntries(tables.map(t => [t, good.prepare(`PRAGMA foreign_key_list("${t}")`).all().map(f => f.table).filter(p => p !== t && tables.includes(p))]))
    const order = [], seen = new Set()
    const visit = (t) => { if (seen.has(t)) return; seen.add(t); deps[t].forEach(visit); order.push(t) }
    tables.forEach(visit)
    for (const t of order) {
      const cols = good.prepare(`PRAGMA table_info("${t}")`).all()
      const pk = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name)
      if (!pk.length) { notes.push(`${t}: 主キーが無いので自動では戻せない（手で確かめる）`); continue }
      const key = (r) => JSON.stringify(pk.map(k => cell(r[k])))
      const now = new Map(broken.prepare(`SELECT * FROM "${t}"`).all().map(r => [key(r), r]))
      let ins = 0, upd = 0
      for (const r of good.prepare(`SELECT * FROM "${t}"`).all()) {
        const cur = now.get(key(r))
        const where = pk.map(k => `"${k}" = ${lit(r[k])}`).join(' AND ')
        if (!cur) { out.push(`INSERT INTO "${t}" (${cols.map(c => `"${c.name}"`).join(', ')}) VALUES (${cols.map(c => lit(r[c.name])).join(', ')});`); ins++ }
        else {
          const changed = cols.filter(c => JSON.stringify(cell(cur[c.name])) !== JSON.stringify(cell(r[c.name])))
          if (changed.length) { out.push(`UPDATE "${t}" SET ${changed.map(c => `"${c.name}" = ${lit(r[c.name])}`).join(', ')} WHERE ${where};`); upd++ }
        }
        now.delete(key(r))
      }
      notes.push(`${t}: 足す ${ins} 行・直す ${upd} 行${now.size ? `・バックアップの後に増えた ${now.size} 行はそのまま` : ''}`)
    }
  } finally { good.close(); broken.close() }
  return { sql: out.join('\n'), notes }
}

// ---- 本体 ----
const WORK = mkdtempSync(join(tmpdir(), 'mbsaas-restore-drill-'))
const result = { started_at: new Date().toISOString(), wrangler: '', steps: [], ok: false }
const step = (name, data) => { result.steps.push({ name, ...data }); console.log(`\n■ ${name}`); for (const [k, v] of Object.entries(data)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) }
let failed = false
const check = (name, cond, detail) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 600) : ''}`); if (!cond) failed = true; return cond }
try {
  result.wrangler = execFileSync(process.execPath, [WRANGLER, '--version'], { encoding: 'utf8' }).trim().split('\n').pop()
  // 0. 元の DB: テスト用 DB の写し
  const orig = project(join(WORK, 'orig'))
  cpSync(join(resolve(src), 'v3'), join(orig, '.wrangler', 'state', 'v3'), { recursive: true })
  const base = snapshot(sqliteOf(orig))
  step('1. 元の DB を控える', { 表の数: Object.keys(base.tables).length, 行の合計: totalRows(base), 'スキーマ（表・索引・トリガー）': Object.keys(base.schema).length })

  // 2. 書き出す
  const backup = join(WORK, 'backup.sql')
  const [, tExport] = timed(() => wrangler(['d1', 'export', DB_NAME, '--local', `--output=${backup}`], orig))
  const sqlText = readFileSync(backup, 'utf8')
  const firstInsert = sqlText.indexOf('INSERT INTO'), firstTrigger = sqlText.indexOf('CREATE TRIGGER')
  step('2. wrangler d1 export で書き出す', { 秒: tExport, 'ファイル（KB）': kb(backup), INSERT: (sqlText.match(/^INSERT INTO/gm) || []).length,
    トリガーを作るのはデータの後: firstTrigger < 0 || firstInsert < 0 || firstTrigger > firstInsert })
  check('書き出しの SQL がある', existsSync(backup) && kb(backup) > 0)

  // 3. 壊す（誤操作のまね）: 日報の半分を消す・打刻の時刻を書き換える・1人分の評価を消す
  const broken = [
    'DELETE FROM daily_reports WHERE daily_report_id % 2 = 0;',
    "UPDATE attendance_reports SET reported_at = '2000-01-01 00:00:00' WHERE attendance_id % 3 = 0;",
    'DELETE FROM evaluations WHERE staff_id = (SELECT MIN(staff_id) FROM evaluations);',
  ]
  const brokenFile = join(WORK, 'break.sql')
  writeFileSync(brokenFile, broken.join('\n'))
  wrangler(['d1', 'execute', DB_NAME, '--local', `--file=${brokenFile}`, '--yes'], orig)
  const afterBreak = snapshot(sqliteOf(orig))
  const d0 = diff(base, afterBreak)
  step('3. 壊す（誤操作のまね）', { SQL: broken.join(' '), 変わった表: d0.tables.map(x => `${x.table} ${x.before?.rows}→${x.after?.rows} 行`) })
  check('壊した DB は元と違う', d0.tables.length > 0)

  // 4. A: DB 全体を戻す（空の DB に流し込む。本番では新しい D1 を作って流し込む）
  const restored = project(join(WORK, 'restored'))
  const [, tImport] = timed(() => wrangler(['d1', 'execute', DB_NAME, '--local', `--file=${backup}`, '--yes'], restored))
  const afterRestore = snapshot(sqliteOf(restored))
  const d1 = diff(base, afterRestore)
  step('4. A: DB 全体を戻す（空の DB に流し込む）', { 秒: tImport, 行の合計: totalRows(afterRestore), 違う表: d1.tables.map(x => x.table), 違うスキーマ: d1.schema })
  check('A: すべての表の行数と中身が元と同じ', d1.tables.length === 0, d1.tables)
  check('A: 表・索引・トリガーが元と同じ', d1.schema.length === 0, d1.schema)

  // 5. B: 一部の行だけを戻す（戻した DB から、壊れた DB に足りない行・違う行を戻す）
  const { sql, notes } = repairSql(sqliteOf(restored), sqliteOf(orig), d0.tables.map(x => x.table))
  const repairFile = join(WORK, 'repair.sql')
  writeFileSync(repairFile, sql)
  const [, tRepair] = timed(() => wrangler(['d1', 'execute', DB_NAME, '--local', `--file=${repairFile}`, '--yes'], orig))
  const afterRepair = snapshot(sqliteOf(orig))
  const d2 = diff(base, afterRepair)
  step('5. B: 一部の行だけを戻す', { 秒: tRepair, 'SQL の文': sql.split('\n').filter(Boolean).length, 内訳: notes, 違う表: d2.tables.map(x => x.table) })
  check('B: 壊した表が元と同じに戻った（ほかの表も変わっていない）', d2.tables.length === 0, d2.tables)
  result.ok = !failed
} catch (e) {
  check('訓練を最後まで流せた', false, String(e.stderr || e.message).slice(0, 1200))
} finally {
  result.finished_at = new Date().toISOString()
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2))
  if (KEEP) console.log(`\n作業用のフォルダを残しました: ${WORK}`)
  else rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
console.log(failed ? '\n訓練: 失敗があります' : '\n訓練: すべて元に戻せました')
process.exit(failed ? 1 : 0)
