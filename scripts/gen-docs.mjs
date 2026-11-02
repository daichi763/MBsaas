// 設計資料（docs/db.md・docs/api.md・docs/screens.md）の「生成する部分」をコードから作り直す（Sprint 13 #9611）。
//
// 使い方:
//   npm run docs                … docs/*.md の生成部分を書き換える
//   npm run docs:check          … 書き換えずに、今のコードと docs が一致しているかを確かめる（ずれていれば終了コード 1）
//   node scripts/gen-docs.mjs --out <フォルダ>   … 別のフォルダに書き出す（テスト用。docs/*.md をそこへ写してから書き換える）
//   node scripts/gen-docs.mjs --json <ファイル>  … 集めた内容（表・API・画面）を JSON で書き出す（テスト用）
//
// 本番には一切アクセスしない。すべてリポジトリの中のファイルだけで作る:
//   DB   … migrations/*.sql を Node の組み込みの SQLite（node:sqlite。メモリ上）に順に当て、sqlite_master と PRAGMA から読む
//   API  … src/api.ts を esbuild で1つにまとめて読み込み、Hono が持つルートの一覧（api.routes）を取る。
//          ファイル:行・用途（直前のコメント）は src/*.ts のルート定義の行を読んで突き合わせる
//   画面 … src/index.tsx（ページと読み込む JS・左メニュー）と public/static/*.js（ハッシュのルート・描画関数・呼ぶ API）を読む
//
// docs/*.md のうち、<!-- BEGIN GENERATED: 名前 --> と <!-- END GENERATED: 名前 --> の間だけを書き換える。
// それ以外（人が書く説明）はそのまま残す。人が書く説明の中の [`名前`](../src/…) のリンクは、そのファイルに名前があるかを確かめ、
// 「本文で参照しているコードの位置」の表に今の行番号を出す（名前が消えたらエラーにする）。
//
// 必要なもの: Node.js 22.13 以降（node:sqlite）。esbuild は vite・wrangler と一緒に node_modules に入っている。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

// node:sqlite の「試験的な機能」の警告は出さない（ほかの警告はそのまま出す）
process.removeAllListeners('warning')
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w) })
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const CHECK = argv.includes('--check')
const OUT_DIR = argOf('--out')
const JSON_OUT = argOf('--json')
const DOC_NAMES = ['db.md', 'api.md', 'screens.md']
const warnings = []
const warn = (msg) => { warnings.push(msg); console.warn(`注意: ${msg}`) }

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const lineAt = (text, offset) => { let n = 1; for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n }
const lineStarts = (text) => { const a = [0]; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) a.push(i + 1); return a }
const lineOf = (starts, offset) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= offset) lo = m; else hi = m - 1 } return lo + 1 }
// 表のセルに入れる文字（| と改行を逃がす）
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`'
const clip = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
const loc = (file, line) => `${file}:${line}`
const link = (file, line) => `[${file.replace(/^src\/|^public\//, '')}:${line}](../${file}#L${line})`

// ---------------------------------------------------------------------------------------------
// JavaScript・TypeScript の簡単な字句の読み取り（文字列・テンプレート・コメント・正規表現を飛ばして、対応する } を探す）
// ---------------------------------------------------------------------------------------------
function skipString(src, i, q) {
  for (i++; i < src.length; i++) { const ch = src[i]; if (ch === '\\') { i++; continue } if (ch === q || ch === '\n') return i + 1 }
  return i
}
function skipRegex(src, i) {
  let cls = false
  for (i++; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') { i++; continue }
    if (ch === '\n') return i
    if (cls) { if (ch === ']') cls = false; continue }
    if (ch === '[') cls = true
    else if (ch === '/') { i++; while (/[a-z]/i.test(src[i] || '')) i++; return i }
  }
  return i
}
const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do'])
/** open は '{'・'('・'[' の位置。対応する閉じ括弧の位置を返す（見つからなければ -1） */
function matchClose(src, open) {
  const pair = { '{': '}', '(': ')', '[': ']' }
  const stack = [{ t: 'code', stack: [] }]
  let prev = '', word = ''
  for (let i = open; i < src.length;) {
    const top = stack[stack.length - 1]
    const ch = src[i]
    if (top.t === 'tmpl') {
      if (ch === '\\') { i += 2; continue }
      if (ch === '`') { stack.pop(); i++; prev = 'a'; word = ''; continue }
      if (ch === '$' && src[i + 1] === '{') { stack.push({ t: 'code', stack: ['}'] }); i += 2; prev = '{'; word = ''; continue }
      i++; continue
    }
    if (ch === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue }
    if (ch === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? src.length : n + 2; continue }
    if (ch === '"' || ch === "'") { i = skipString(src, i, ch); prev = 'a'; word = ''; continue }
    if (ch === '`') { stack.push({ t: 'tmpl' }); i++; continue }
    if (ch === '/' && (prev === '' || REGEX_BEFORE.test(prev) || REGEX_KEYWORDS.has(word))) { i = skipRegex(src, i); prev = 'a'; word = ''; continue }
    if (pair[ch]) top.stack.push(pair[ch])
    else if (ch === '}' || ch === ')' || ch === ']') {
      top.stack.pop()
      if (!top.stack.length) {
        if (stack.length === 1) return i
        stack.pop(); i++; prev = ')'; word = ''; continue
      }
    }
    if (/[A-Za-z0-9_$]/.test(ch)) { word = (/[A-Za-z0-9_$]/.test(prev) ? word : '') + ch; prev = 'a' }
    else if (!/\s/.test(ch)) { prev = ch; word = '' }
    i++
  }
  return -1
}
/** 括弧の中身を、深さ 0 の区切り文字（, など）で分ける */
function splitTop(src, from, to, sep = ',') {
  const parts = []; let start = from
  for (let i = from; i < to;) {
    const ch = src[i]
    if (ch === '{' || ch === '(' || ch === '[') { const e = matchClose(src, i); i = e < 0 ? to : e + 1; continue }
    if (ch === '"' || ch === "'") { i = skipString(src, i, ch); continue }
    if (ch === '`') { i = skipTemplate(src, i); continue }
    if (ch === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? to : n; continue }
    if (ch === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); i = n < 0 ? to : n + 2; continue }
    if (ch === sep) { parts.push([start, i]); start = i + 1 }
    i++
  }
  parts.push([start, to])
  return parts
}
function skipTemplate(src, i) {
  for (i++; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') { i++; continue }
    if (ch === '`') return i + 1
    if (ch === '$' && src[i + 1] === '{') { const e = matchClose(src, i + 1); if (e < 0) return src.length; i = e }
  }
  return i
}
/** 行の直前に続く // のコメント（空行で区切る）を返す */
function leadingComment(lines, lineNo, prefix = '//') {
  const out = []
  for (let i = lineNo - 2; i >= 0; i--) {
    const t = lines[i].trim()
    if (t.startsWith(prefix)) { out.unshift(t.slice(prefix.length).trim()); continue }
    break
  }
  return out.filter(s => !/^[=\-]{3,}/.test(s)).join(' ').replace(/^[=\-]+\s*|\s*[=\-]+$/g, '').trim()
}
/** 行より上にある、いちばん近い見出しのコメント（// ===== 名前 ===== か // ----- 名前 -----） */
function sectionAbove(lines, lineNo) {
  const SEP = /^\s*\/\/\s*[=\-]{5,}\s*$/
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*\/\/\s*(?:={3,}|-{3,})\s*([^=\-\s].*?)\s*(?:={3,}|-{3,})\s*$/)
    if (m) return m[1]
    // // ====== / // 見出し / // ====== の形（下の区切りの行から上へ読む）
    if (SEP.test(lines[i]) && i >= 2 && /^\s*\/\/\s*\S/.test(lines[i - 1]) && !SEP.test(lines[i - 1])) {
      let k = i - 1; const text = []
      while (k >= 0 && !SEP.test(lines[k]) && /^\s*\/\//.test(lines[k])) { text.unshift(lines[k].replace(/^\s*\/\/\s*/, '')); k-- }
      if (k >= 0 && SEP.test(lines[k]) && text.length) return text[0]
    }
  }
  return ''
}

// =============================================================================================
// 1. DB: マイグレーションを順に当てて、表・列・制約・索引・トリガーを読む
// =============================================================================================
async function collectDb() {
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch {
    throw new Error('node:sqlite を読み込めません。Node.js 22.13 以降で実行してください')
  }
  const files = readdirSync(join(ROOT, 'migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()
  const db = new DatabaseSync(':memory:')
  const tablesNow = () => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map(r => r.name)
  const colsOf = (t) => db.prepare(`PRAGMA table_xinfo("${t}")`).all()
  const created = {}        // 表 → 作ったマイグレーション
  const addedCols = {}      // 表 → 列 → 足したマイグレーション
  const migComments = {}    // 表 → 作ったときのコメント
  const alterComments = {}  // 表 → 列 → ALTER の行のコメント
  let prev = new Map()
  for (const f of files) {
    const sql = read(`migrations/${f}`)
    try { db.exec(sql) } catch (e) { throw new Error(`migrations/${f} を当てられませんでした: ${e.message}`) }
    const lines = sql.split('\n')
    const now = new Map(tablesNow().map(t => [t, new Set(colsOf(t).map(c => c.name))]))
    for (const [t, cols] of now) {
      if (!prev.has(t)) {
        created[t] = created[t] || f
        // 作り直し（_new を作って名前を変える）で同じ名前に戻った表は、最初に作ったマイグレーションのままにする
        const idx = lines.findIndex(l => new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${t}["\`]?\\s*\\(`, 'i').test(l))
        if (idx >= 0 && !migComments[t]) migComments[t] = leadingComment(lines, idx + 1, '--')
        continue
      }
      for (const c of cols) if (!prev.get(t).has(c)) (addedCols[t] = addedCols[t] || {})[c] = f
    }
    // ALTER TABLE x ADD COLUMN y …; -- コメント（行末か、直前のコメント）
    lines.forEach((l, i) => {
      const m = l.match(/ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+COLUMN\s+["`]?(\w+)/i)
      if (!m) return
      const tail = (l.match(/;\s*--\s*(.+)$/) || [])[1] || ''
      let above = ''
      for (let k = i - 1; k >= 0; k--) {
        const t = lines[k].trim()
        if (/^ALTER\s+TABLE/i.test(t)) continue
        if (t.startsWith('--')) { above = leadingComment(lines, k + 2, '--'); break }
        break
      }
      const text = tail || above
      if (text) ((alterComments[m[1]] = alterComments[m[1]] || {})[m[2]] = text)
    })
    prev = now
  }
  const master = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all()
  const tables = master.filter(r => r.type === 'table').map(r => {
    const cols = colsOf(r.name)
    const fks = db.prepare(`PRAGMA foreign_key_list("${r.name}")`).all()
    const idx = db.prepare(`PRAGMA index_list("${r.name}")`).all().map(ix => ({
      name: ix.name, unique: !!ix.unique, origin: ix.origin, partial: !!ix.partial,
      columns: db.prepare(`PRAGMA index_xinfo("${ix.name}")`).all().filter(x => x.key).map(x => x.name ?? '(式)'),
      sql: (master.find(m => m.type === 'index' && m.name === ix.name) || {}).sql || null,
    }))
    // CREATE TABLE の中の列のコメント（行末の -- と、列の直前の行の --）
    const colComments = {}
    let pending = ''
    for (const l of String(r.sql || '').split('\n')) {
      const t = l.trim()
      if (t.startsWith('--')) { pending = (pending ? pending + ' ' : '') + t.slice(2).trim(); continue }
      const m = t.match(/^["`]?(\w+)["`]?\s+[A-Za-z]/)
      if (m && cols.some(c => c.name === m[1])) {
        const tail = (t.match(/--\s*(.+)$/) || [])[1] || ''
        const text = [tail, pending].filter(Boolean).join(' ')
        if (text) colComments[m[1]] = text
      }
      pending = ''
    }
    const checks = [...String(r.sql || '').matchAll(/CHECK\s*\(/gi)].map(m => {
      const s = String(r.sql); const open = m.index + m[0].length - 1; const close = matchClose(s, open)
      return close > 0 ? s.slice(m.index, close + 1).replace(/\s+/g, ' ') : null
    }).filter(Boolean)
    return {
      name: r.name, sql: r.sql, created: created[r.name] || null, comment: migComments[r.name] || '',
      columns: cols.map(c => ({
        name: c.name, type: c.type || '', notnull: !!c.notnull, default: c.dflt_value, pk: c.pk, hidden: c.hidden,
        added: (addedCols[r.name] || {})[c.name] || null,
        comment: colComments[c.name] || (alterComments[r.name] || {})[c.name] || '',
      })),
      fks: fks.map(f => ({ from: f.from, table: f.table, to: f.to, on_delete: f.on_delete })),
      indexes: idx, checks,
    }
  })
  const triggers = master.filter(r => r.type === 'trigger').map(r => ({ name: r.name, table: r.tbl_name, sql: r.sql }))
  const views = master.filter(r => r.type === 'view').map(r => ({ name: r.name, sql: r.sql }))
  return { migrations: files, tables, triggers, views }
}

// retention.ts から、解約（offboarding）の対象の表・退職後と在職中の削除の対象・匿名化の列を読む
function collectRetention() {
  const file = 'src/services/retention.ts'
  const src = read(file); const starts = lineStarts(src)
  const offboarding = [...src.matchAll(/\{\s*target:\s*'(\w+)',\s*label:\s*'([^']*)',\s*table:\s*'(\w+)'([^\n]*)/g)].map(m => ({
    table: m[3], label: m[2], line: lineOf(starts, m.index), noDelete: /noDelete:\s*true/.test(m[4]), noExport: /noExport:\s*true/.test(m[4]),
  }))
  const arrayConst = (name) => {
    const m = src.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*\\[`))
    if (!m) { warn(`${file} に ${name} が見つかりません`); return { items: [], line: 0 } }
    const open = m.index + m[0].length - 1; const close = matchClose(src, open)
    return { items: [...src.slice(open, close).matchAll(/'(\w+)'/g)].map(x => x[1]), line: lineOf(starts, m.index) }
  }
  const kept = arrayConst('OFFBOARDING_KEPT_TABLES')
  const retired = arrayConst('RETIRED_TARGETS')
  const inService = arrayConst('IN_SERVICE_TARGETS')
  const anonymize = arrayConst('ANONYMIZE_PROFILE_COLUMNS')
  const byCreated = [...src.matchAll(/cleanupByCreatedAt\(db, dryRun, \{ target: '(\w+)', table: '(\w+)', idCol: '\w+', years: (\w+)/g)]
    .map(m => ({ table: m[2], years: (src.match(new RegExp(`const ${m[3]} = (\\d+)`)) || [])[1] || m[3], line: lineOf(starts, m.index) }))
  const files = [...src.matchAll(/\{\s*source:\s*'(\w+)',\s*bucket:\s*'(\w+)'/g)].map(m => ({ table: m[1], bucket: m[2], line: lineOf(starts, m.index) }))
  return { file, offboarding, kept, retired, inService, anonymize, byCreated, files }
}

// =============================================================================================
// 2. API: Hono のルートの一覧（実行して取る）と、ソースの定義の行（読んで取る）を突き合わせる
// =============================================================================================
async function loadRuntimeRoutes() {
  let esbuild
  try { esbuild = await import('esbuild') } catch { throw new Error('esbuild を読み込めません。npm ci を実行してください（vite・wrangler と一緒に入ります）') }
  const dir = join(tmpdir(), 'mbsaas-gen-docs'); mkdirSync(dir, { recursive: true })
  const out = join(dir, `api-${process.pid}.mjs`)
  await esbuild.build({ entryPoints: [join(ROOT, 'src/api.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' })
  try {
    const mod = await import(pathToFileURL(out).href)
    return mod.default.routes.map((r, i) => ({ order: i, method: r.method, path: r.path, name: r.handler?.name || '' }))
  } finally { rmSync(out, { force: true }) }
}

const ROUTE_RE = /^([ \t]*)([A-Za-z_$][\w$]*)\.(get|post|put|delete|patch|all|use|on)\(\s*(['"`])([^'"`\n]*)\4/gm
function staticRoutesOf(file) {
  const src = read(file); const lines = src.split('\n'); const starts = lineStarts(src)
  // Hono のインスタンス（関数の中で作るもの＝ファクトリも含む）
  const instances = []
  for (const m of src.matchAll(/^([ \t]*)(export\s+)?const\s+(\w+)\s*=\s*new Hono\b/gm)) {
    const line = lineOf(starts, m.index)
    let fn = null, range = null
    if (m[1].length) {
      for (let i = line - 1; i >= 0; i--) {
        const f = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
        if (f) {
          fn = f[1]
          const open = src.indexOf('{', starts[i] + lines[i].indexOf('(')); const close = matchClose(src, src.indexOf('{', starts[i] + lines[i].indexOf(')')))
          range = [i + 1, lineOf(starts, close)]
          break
        }
      }
    }
    instances.push({ file, var: m[3], fn, range, key: `${file}#${fn ? fn + '.' : ''}${m[3]}` })
  }
  // export const X = F(...)（ファクトリで作ったインスタンス）
  const aliases = {}
  for (const m of src.matchAll(/^export\s+const\s+(\w+)\s*=\s*(\w+)\(/gm)) {
    const inst = instances.find(x => x.fn === m[2]); if (inst) aliases[m[1]] = inst.key
  }
  const defaultExport = (src.match(/^export\s+default\s+(\w+)/m) || [])[1] || null
  const entries = []
  for (const m of src.matchAll(ROUTE_RE)) {
    const line = lineOf(starts, m.index)
    const v = m[2]
    if (['c', 'app'].includes(v) && !instances.some(x => x.var === v) && file !== 'src/index.tsx') continue
    let inst = instances.find(x => x.var === v && x.range && line >= x.range[0] && line <= x.range[1]) || instances.find(x => x.var === v && !x.fn)
    let key = inst ? inst.key : (aliases[v] ? `${file}#${v}` : null)
    if (!key) continue
    entries.push({ file, line, var: v, key, method: m[3].toUpperCase(), path: m[5], comment: leadingComment(lines, line), section: sectionAbove(lines, line) })
  }
  return { file, instances, aliases, defaultExport, entries, lines }
}

const joinPath = (a, b) => {
  const p = (a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, '')).replace(/\/+$/, '')
  return p || '/'
}
const normPath = (p) => (p.replace(/\/+$/, '') || '/')

// 権限のミドルウェアの説明（ファイルとパスで見分ける）。roles は通すロール（hq_view は本部の閲覧＝sales_manager と同じ扱い）
const ADMIN4 = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
const HR = ['company_admin', 'office_staff']
const MIDDLEWARE_DEFS = [
  { file: 'src/api.ts', path: '/*', kind: 'auth', label: 'ログイン必須（セッションの確認・延長・二段階認証の登録待ちの制限）' },
  { file: 'src/api.ts', path: '/auth/*', kind: 'note', label: '本部の閲覧中は書き込み不可' },
  { file: 'src/api.ts', path: '/admin/*', name: 'hqViewAdminGuard', kind: 'hqview', label: '本部は、企業が許可した閲覧の間だけ GET を通す（閲覧中は sales_manager として扱う）' },
  { file: 'src/api.ts', path: '/admin/*', name: '', kind: 'roles', roles: ADMIN4, label: '管理系の4ロールだけ' },
  { file: 'src/api.ts', path: '/admin/employees', name: 'hrOnly', kind: 'roles', roles: HR, label: '会社管理者・事務担当だけ（労務情報）' },
  { file: 'src/api.ts', path: '/admin/employees/*', name: 'hrOnly', kind: 'roles', roles: HR, label: '会社管理者・事務担当だけ（労務情報）' },
  { file: 'src/api.ts', path: '/hq/*', nth: 0, kind: 'roles', roles: ['system_admin'], label: '本部（system_admin）だけ' },
  { file: 'src/api.ts', path: '/hq/*', nth: 1, kind: 'note', label: '本部の書き込みを hq_audit_logs に記録' },
  { file: 'src/api.ts', path: '/staff/*', kind: 'roles', roles: ['staff'], label: 'スタッフだけ' },
  { file: 'src/api.ts', name: 'securityAdminOnly', kind: 'roles', roles: ['company_admin'], label: '会社管理者だけ（セキュリティの設定・ログインの履歴）' },
  { file: 'src/accounts.ts', name: 'companyAdminOnly', kind: 'roles', roles: ['company_admin'], label: '会社管理者だけ（管理者アカウントの管理）' },
  { file: 'src/recruit.ts', path: '/public/recruit/:token/*', kind: 'note', label: '募集ページの会社が停止中なら 410' },
  { file: 'src/roster.ts', path: '/admin/roster/*', kind: 'note', label: '会社の連携用の識別子を用意する（権限の制限なし）' },
  { file: 'src/staff-self-service.ts', path: '/admin/staff-requests/leave', kind: 'roles', roles: HR, label: '会社管理者・事務担当だけ（休暇の申請）' },
  { file: 'src/staff-self-service.ts', path: '/admin/staff-requests/leave/*', kind: 'roles', roles: HR, label: '会社管理者・事務担当だけ（休暇の申請）' },
  { file: 'src/roster-chat.ts', path: '/admin/roster-chat/*', kind: 'roles', roles: ADMIN4, label: '管理系の4ロールだけ（企業間チャット）' },
  { file: 'src/recruit.ts', path: '/staff/recruit/*', kind: 'roles', roles: ['staff'], label: 'スタッフだけ（スタッフアプリで募集を扱う設定のとき）' },
]
const ROLE_LABEL = { system_admin: '本部', company_admin: '会社管理者', sales_manager: '営業', field_manager: '現場責任者', office_staff: '事務', staff: 'スタッフ' }
const ALL_ROLES = ['system_admin', ...ADMIN4, 'staff']

// パスのパターン（:param・末尾の *）が、ルートのパスに当たるか
function patternCovers(pattern, path) {
  const ps = pattern.split('/').filter(Boolean), rs = path.split('/').filter(Boolean)
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*' && i === ps.length - 1) return true
    if (i >= rs.length) return false
    if (ps[i].startsWith(':')) continue
    if (ps[i] !== rs[i]) return false
  }
  return ps.length === rs.length
}

async function collectApi() {
  const runtime = await loadRuntimeRoutes()
  const files = readdirSync(join(ROOT, 'src')).filter(f => /\.ts$/.test(f)).map(f => `src/${f}`)
  const parsed = Object.fromEntries(files.map(f => [f, staticRoutesOf(f)]))
  // api.ts の import（名前 → ファイル・書き出しの名前）
  const apiSrc = read('src/api.ts')
  const imports = {}
  for (const m of apiSrc.matchAll(/^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*'\.\/([\w-]+)'/gm)) {
    const file = `src/${m[3]}.ts`
    if (m[1]) imports[m[1]] = { file, name: 'default' }
    for (const part of (m[2] || '').split(',')) { const n = part.trim().split(/\s+as\s+/); if (n[0]) imports[(n[1] || n[0]).trim()] = { file, name: n[0].trim() } }
  }
  // インスタンス → 付けた先のパス
  const prefixes = { 'src/api.ts#api': [''] }
  const apiLines = apiSrc.split('\n')
  apiLines.forEach((l, i) => {
    const m = l.match(/^api\.route\('([^']*)',\s*(\w+)(\()?/)
    if (!m) return
    const imp = imports[m[2]]; if (!imp) { warn(`src/api.ts:${i + 1} の ${m[2]} の import が見つかりません`); return }
    const p = parsed[imp.file]
    const keys = []
    if (imp.name === 'default') keys.push(...p.instances.filter(x => x.var === p.defaultExport).map(x => x.key))
    else if (m[3]) keys.push(...p.instances.filter(x => x.fn === imp.name).map(x => x.key))
    else {
      const own = p.instances.find(x => x.var === imp.name && !x.fn)
      if (own) keys.push(own.key)
      if (p.aliases[imp.name]) keys.push(p.aliases[imp.name], `${imp.file}#${imp.name}`)
    }
    if (!keys.length) warn(`src/api.ts:${i + 1} の ${m[2]} の Hono のインスタンスが見つかりません`)
    for (const k of keys) (prefixes[k] = prefixes[k] || []).push(m[1])
  })
  // ソースの定義に、付けた先のパスを付ける
  const statics = []
  for (const f of files) for (const e of parsed[f].entries) for (const pre of prefixes[e.key] || []) statics.push({ ...e, full: normPath(joinPath(pre, e.path)) })
  // 実行して取ったルートと突き合わせる（同じメソッド・パスが複数あるときは登録の順に当てる）
  const used = new Set()
  const take = (method, path, pred = () => true) => {
    const s = statics.find((x, i) => !used.has(i) && x.method === method && x.full === normPath(path) && pred(x))
    if (s) used.add(statics.indexOf(s))
    return s || null
  }
  const endpoints = [], middlewares = [], unmatched = []
  const mwSeen = {}
  for (const r of runtime) {
    if (r.method === 'ALL') {
      const s = take('USE', r.path) || take('ALL', r.path)
      const k = `${s?.file}|${normPath(r.path)}`; const nth = mwSeen[k] = (mwSeen[k] ?? -1) + 1
      const def = s && MIDDLEWARE_DEFS.find(d => d.file === s.file && (!d.path || normPath(d.path) === normPath(r.path)) && (d.name === undefined || d.name === r.name) && (d.nth === undefined || d.nth === nth))
      if (!s) unmatched.push(`${r.method} ${r.path}`)
      if (s && !def) warn(`権限の説明がないミドルウェアがあります: ${s.file}:${s.line} ${r.path}（scripts/gen-docs.mjs の MIDDLEWARE_DEFS に足してください）`)
      middlewares.push({ order: r.order, path: r.path, name: r.name, file: s?.file, line: s?.line, def: def || null })
      continue
    }
    const s = take(r.method, r.path)
    if (!s) unmatched.push(`${r.method} ${r.path}`)
    endpoints.push({ order: r.order, method: r.method, path: '/api' + (r.path === '/' ? '' : r.path), rawPath: r.path, file: s?.file, line: s?.line, comment: s?.comment || '', section: s?.section || '' })
  }
  for (const e of endpoints) {
    const applied = middlewares.filter(m => m.order < e.order && patternCovers(m.path, e.rawPath))
    e.middlewares = applied.map(m => ({ file: m.file, line: m.line, path: m.path, label: m.def?.label || '（説明なし）', kind: m.def?.kind || 'unknown' }))
    e.access = accessOf(e.method, applied)
    e.extraChecks = e.access.public ? [] : extraChecks(parsed[e.file], e.line)
  }
  const dup = {}
  for (const e of endpoints) { const k = `${e.method} ${e.path}`; dup[k] = (dup[k] || 0) + 1 }
  for (const [k, n] of Object.entries(dup)) if (n > 1) warn(`同じメソッド・パスのルートが ${n} 個あります（先に登録したものだけが使われます）: ${k}`)
  for (const u of unmatched) warn(`ソースの定義の行が見つからないルート: ${u}`)
  // index.tsx の画面・その他のルート
  const idx = read('src/index.tsx'); const idxLines = idx.split('\n'); const idxStarts = lineStarts(idx)
  const pages = [...idx.matchAll(/^app\.(get|post)\('([^']+)'/gm)].map(m => {
    const line = lineOf(idxStarts, m.index)
    return { method: m[1].toUpperCase(), path: m[2], file: 'src/index.tsx', line, comment: leadingComment(idxLines, line), section: sectionAbove(idxLines, line) }
  })
  return { endpoints, middlewares, pages, unmatched, staticCount: statics.filter(s => s.method !== 'USE').length }
}

// 通すロールを計算する
function accessOf(method, applied) {
  if (!applied.some(m => m.def?.kind === 'auth')) return { public: true, roles: [], label: 'ログイン不要' }
  let roles = new Set(ALL_ROLES); let hqView = false
  for (const m of applied) {
    const d = m.def; if (!d) continue
    if (d.kind === 'hqview') { roles.delete('system_admin'); hqView = method === 'GET' }
    if (d.kind === 'roles') {
      roles = new Set([...roles].filter(r => d.roles.includes(r)))
      if (hqView && !d.roles.includes('sales_manager')) hqView = false
    }
  }
  const list = ALL_ROLES.filter(r => roles.has(r))
  let label
  if (list.length === ALL_ROLES.length) label = 'ログイン中の全員'
  else if (list.length === ADMIN4.length && ADMIN4.every(r => roles.has(r))) label = '管理者（4ロール）'
  else label = list.map(r => ROLE_LABEL[r]).join('・')
  if (hqView) label += '＋本部の閲覧（GET）'
  return { public: false, roles: list, hqView, label }
}
// ハンドラの中の権限の追加の確認（次のルートの定義の行までを見る）
function extraChecks(p, line) {
  if (!p) return []
  const next = p.entries.filter(e => e.line > line).map(e => e.line).sort((a, b) => a - b)[0] || p.lines.length + 1
  const body = p.lines.slice(line - 1, next - 1).join('\n')
  const found = []
  if (/HR_ROLES|isHr\(|canManageHr|can_manage_hr/.test(body)) found.push('人事のロール')
  if (/role\s*[!=]==\s*'company_admin'|'company_admin'\s*[!=]==/.test(body)) found.push('会社管理者')
  if (/canEditAttendanceSettings/.test(body)) found.push('勤怠の設定の権限')
  // そのほかのロールの定数（PAYOUT_ROLES など）と、権限を確かめる関数（payoutForbidden など）
  for (const m of new Set([...body.matchAll(/\b([A-Z][A-Z_]*_ROLES)\b(?!\s*=[^=])/g)].map(x => x[1]))) if (m !== 'HR_ROLES' && m !== 'ADMIN_ROLES') found.push(m)
  for (const m of new Set([...body.matchAll(/\b(\w+Forbidden|\w+Only)\(/g)].map(x => x[1]))) found.push(m + '()')
  return found
}

// =============================================================================================
// 3. 画面: index.tsx のページと JS、各 JS のハッシュのルート・描画関数・呼ぶ API
// =============================================================================================
function collectScreens(api) {
  const idx = read('src/index.tsx'); const idxStarts = lineStarts(idx)
  // ページ（app.get('/x') の範囲で読み込む /static/*.js）
  const pageMatches = [...idx.matchAll(/^app\.get\('([^']+)'/gm)]
  const pages = pageMatches.map((m, i) => {
    const end = i + 1 < pageMatches.length ? pageMatches[i + 1].index : idx.length
    const body = idx.slice(m.index, end)
    const scripts = [...body.matchAll(/<script src="\/static\/([\w-]+\.js)"/g)].map(x => x[1])
    const roleCheck = (body.match(/if \(u\.role [!=]== '(\w+)'\)[^\n]*/) || [])[0] || ''
    return { path: m[1], line: lineOf(idxStarts, m.index), scripts, roleCheck: roleCheck.trim(), html: /c\.html\(/.test(body), title: (body.match(/head\('([^']+)'\)/) || [])[1] || '' }
  })
  // 左メニュー（管理画面）。sideNavGroup('key', '見出し', `…リンク…`) と、グループの外のリンク
  const nav = []
  const adminPage = idx.slice(idx.indexOf("app.get('/admin'"), idx.indexOf("app.get('/hq'"))
  const sideNav = adminPage.slice(adminPage.indexOf('id="side-nav"'), adminPage.indexOf('</nav>'))
  const anchorRe = /<a href="#([\w-]+)"[^>]*data-tab="\1"[^>]*>(.*?)<\/a>/g
  const textOf = (h) => h.replace(/<span[^>]*>.*?<\/span>/g, '').replace(/<[^>]+>/g, '').trim()
  let cursor = 0
  for (const g of sideNav.matchAll(/\$\{sideNavGroup\('([\w-]+)', '([^']+)', `([\s\S]*?)`\)\}/g)) {
    for (const a of sideNav.slice(cursor, g.index).matchAll(anchorRe)) nav.push({ group: '', tab: a[1], label: textOf(a[2]) })
    for (const a of g[3].matchAll(anchorRe)) nav.push({ group: g[2], groupKey: g[1], tab: a[1], label: textOf(a[2]) })
    cursor = g.index + g[0].length
  }
  for (const a of sideNav.slice(cursor).matchAll(anchorRe)) nav.push({ group: '', tab: a[1], label: textOf(a[2]) })
  // JS が足すメニュー（#side-nav a[data-tab="Y"] の後ろに <a href="#X">）
  const staticFiles = readdirSync(join(ROOT, 'public/static')).filter(f => f.endsWith('.js')).sort()
  const src = Object.fromEntries(staticFiles.map(f => [f, read(`public/static/${f}`)]))
  // ログイン・パスワードの再設定などの画面は、src/index.tsx の中の script に書いてある
  src['index.tsx'] = idx
  const pathOf = (f) => f === 'index.tsx' ? 'src/index.tsx' : `public/static/${f}`
  const navAdds = []
  for (const f of staticFiles) {
    for (const m of src[f].matchAll(/#side-nav a\[data-tab="([\w-]+)"\]'\)[\s\S]{0,200}?insertAdjacentHTML\('afterend', '<a href="#([\w-]+)"[^>]*>(.*?)<\/a>'\)/g)) {
      const after = nav.findIndex(n => n.tab === m[1])
      const item = { group: after >= 0 ? nav[after].group : '', tab: m[2], label: textOf(m[3]), addedBy: loc(`public/static/${f}`, lineAt(src[f], m.index)) }
      nav.splice(after + 1, 0, item); navAdds.push(item)
    }
  }
  const mobileOnly = []
  for (const f of staticFiles) for (const m of src[f].matchAll(/#mobile-nav option\[value="([\w-]+)"\]'\)\s*\n?.*?insertAdjacentHTML\('afterend', '<option value="([\w-]+)">([^<]+)<\/option>'\)/g)) {
    if (!nav.some(n => n.tab === m[2])) mobileOnly.push({ tab: m[2], label: m[3], after: m[1], addedBy: loc(`public/static/${f}`, lineAt(src[f], m.index)) })
  }
  // 本部画面の上のメニュー
  const hqPage = idx.slice(idx.indexOf("app.get('/hq'"))
  const hqNav = [...hqPage.slice(0, hqPage.indexOf('</nav>')).matchAll(anchorRe)].map(a => ({ tab: a[1], label: textOf(a[2]) }))
  for (const f of staticFiles) for (const m of src[f].matchAll(/a\.href = '#([\w-]+)';[^\n]*a\.textContent = '([^']+)'/g)) hqNav.push({ tab: m[1], label: m[2], addedBy: loc(`public/static/${f}`, lineAt(src[f], m.index)) })
  // スタッフ画面の下のタブと、画面の名前（staff.js の titles）
  const staffPage = idx.slice(idx.indexOf("app.get('/staff'"), idx.indexOf('const sideNavGroup'))
  const staffNav = [...staffPage.matchAll(/<a href="#([\w-]+)" class="nav-item[^"]*" data-tab="\1">(.*?)<\/a>/g)].map(a => ({ tab: a[1], label: textOf(a[2]) }))
  const staffTitles = {}
  {
    const s = src['staff.js'] || ''
    const m = s.match(/const titles = \{/)
    if (m) { const open = m.index + m[0].length - 1; for (const x of s.slice(open, matchClose(s, open)).matchAll(/['"]?([\w-]+)['"]?\s*:\s*'([^']+)'/g)) staffTitles[x[1]] = x[2] }
    for (const f of staticFiles) for (const x of src[f].matchAll(/titles(?:\.([\w]+)|\['([\w-]+)'\])\s*=\s*'([^']+)'/g)) staffTitles[x[1] || x[2]] = x[3]
    for (const f of staticFiles) for (const x of src[f].matchAll(/Object\.assign\(titles,\s*\{([^}]*)\}\)/g)) for (const y of x[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*'([^']+)'/g)) staffTitles[y[1]] = y[2]
  }

  // 関数の定義（どの JS の何行目か・本文の範囲）
  const fnDefs = Object.create(null) // 名前 → [{ file, line, start, end }]
  for (const f of staticFiles) {
    const s = src[f]; const starts = lineStarts(s)
    // (function () { … })() の中の関数はそのファイルの中だけで使える。window.X = … で外に出したものと、外側の関数はどこからでも呼べる
    const iife = [...s.matchAll(/^;?\(\s*(?:async\s*)?(?:function\s*\(\)|\(\)\s*=>)\s*\{/gm)].map(m => { const o = m.index + m[0].length - 1; return [o, matchClose(s, o)] })
    const add = (name, at, bodyFrom, viaWindow = false) => {
      let open = -1
      for (let i = bodyFrom; i < s.length; i++) { const ch = s[i]; if (ch === '{') { open = i; break } if (ch === '\n' && s.slice(bodyFrom, i).includes('=>')) break }
      const end = open >= 0 ? matchClose(s, open) : s.indexOf('\n', bodyFrom)
      const global = viaWindow || !iife.some(([a, b]) => at > a && at < b)
      ;(fnDefs[name] = fnDefs[name] || []).push({ file: f, line: lineOf(starts, at), start: at, end: end < 0 ? s.length : end, global })
    }
    for (const m of s.matchAll(/(?:^|[^\w$.])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const paren = s.indexOf('(', m.index + m[0].length - 1); add(m[1], m.index + (m[0].match(/^[^\w]/) ? 1 : 0), matchClose(s, paren) + 1)
    }
    for (const m of s.matchAll(/(?:window\.([A-Za-z_$][\w$]*)|(?:^|\n)[ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*))\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\(|[A-Za-z_$][\w$]*\s*=>)/g)) {
      const name = m[1] || m[2]
      const paren = s.indexOf('(', m.index + m[0].length - 1)
      const from = m[0].endsWith('=>') ? m.index + m[0].length : (paren >= 0 ? matchClose(s, paren) + 1 : m.index + m[0].length)
      add(name, m.index + (m[0].startsWith('\n') ? 1 : 0), from, !!m[1])
    }
  }
  // API の呼び出し（/api/ の文字列）。メソッドとパスの形（${…} や + の部分は {x}）
  const apiRefs = []
  for (const f of [...staticFiles, 'index.tsx']) {
    const s = src[f]; const starts = lineStarts(s)
    const consts = {}
    for (const m of s.matchAll(/const\s+([A-Z_]+)\s*=\s*(['`])\/api\//g)) consts[m[1]] = exprPath(s, m.index + m[0].length - 6)
    const push = (at, path) => {
      const before = s.slice(Math.max(0, at - 60), at)
      let method = (before.match(/axios\.(get|post|put|delete|patch)\(\s*$/) || [])[1]
      if (!method && /fetch\(\s*$/.test(before)) method = ((s.slice(at, at + 300).match(/method:\s*'(\w+)'/) || [])[1] || 'get')
      if (!method && /((?:href|src)=["']?|window\.open\(\s*|location\.href\s*=\s*|location\.assign\(\s*)$/.test(before)) method = 'get'
      // src/index.tsx はサーバーのコードも含むので、axios・fetch などで呼んでいるものだけを数える
      if (f === 'index.tsx' && !method) return
      apiRefs.push({ file: f, line: lineOf(starts, at), offset: at, method: method ? method.toUpperCase() : '?', path })
    }
    for (const m of s.matchAll(/(['"`])\/api\//g)) {
      // 定数の定義そのもの（const API = '/api/…'）は呼び出しに数えない
      if (/const\s+[A-Z_]+\s*=\s*$/.test(s.slice(Math.max(0, m.index - 40), m.index))) continue
      push(m.index, exprPath(s, m.index))
    }
    for (const [name, base] of Object.entries(consts)) {
      // axios.post(API + '/apply') と axios.get(`${API}/x`)
      for (const m of s.matchAll(new RegExp(`axios\\.(?:get|post|put|delete|patch)\\(\\s*(?:(${name})\\b|\`\\$\\{${name}\\})`, 'g'))) {
        const at = m.index + m[0].length - (m[1] ? name.length : name.length + 4)
        const rest = m[1] ? exprPath(s, at, name) : exprPath(s, at)
        push(at, base + rest.replace(/^\{x\}/, ''))
      }
    }
  }
  const routeList = api.endpoints
  for (const r of apiRefs) {
    r.matches = matchRoutes(r, routeList)
    for (const m of r.matches) (m.callers = m.callers || []).push({ file: pathOf(r.file), line: r.line })
  }
  // 関数ごとの API と、呼んでいる関数（その画面が読み込む JS の中の定義だけをたどる）
  // 呼んだファイルの中に定義があればそれ、なければ画面が読み込む JS のどこからでも呼べる定義
  const defsIn = (name, files, fromFile = null) => {
    const all = (fnDefs[name] || []).filter(d => files.includes(d.file))
    const local = fromFile ? all.filter(d => d.file === fromFile) : []
    return local.length ? local : all.filter(d => d.global)
  }
  const fnInfo = (name, depth, seen, files, fromFile = null) => {
    const out = { apis: [], defs: defsIn(name, files, fromFile) }
    for (const d of out.defs) {
      const k = `${d.file}:${d.start}`
      if (seen.has(k)) continue
      seen.add(k)
      for (const r of apiRefs) if (r.file === d.file && r.offset >= d.start && r.offset <= d.end) out.apis.push(r)
      if (depth <= 0) continue
      const body = src[d.file].slice(d.start, d.end)
      for (const m of new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(x => x[1]))) {
        if (m === name || /^(?:if|for|while|switch|catch|function|return|esc|toast|modal|closeModal|delegate|withSubmitLock|loading|route)$/.test(m)) continue
        out.apis.push(...fnInfo(m, depth - 1, seen, files, d.file).apis)
      }
    }
    return out
  }
  // 画面の見出し（描画する関数の中の最初の <h2>）。メニューにない画面の名前に使う
  const headingOf = (name, files, fromFile) => {
    for (const d of defsIn(name, files, fromFile)) {
      const h = src[d.file].slice(d.start, d.end).match(/<h2[^>]*>([\s\S]*?)<\/h2>/)
      if (h) { const t = h[1].replace(/<[^>]+>/g, '').replace(/\$\{[^}]*\}/g, '').trim(); if (t) return t }
    }
    return ''
  }
  // routes.x = の右辺（() => { … } のように複数の行にわたるものは、対応する } まで）
  const valueAt = (t, from) => {
    const brace = t.slice(from).match(/^\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/)
    if (brace) { const open = from + brace[0].length - 1; return t.slice(from, matchClose(t, open) + 1).trim() }
    const nl = t.indexOf('\n', from); return t.slice(from, nl < 0 ? t.length : nl).trim()
  }
  // SPA ごとのルート（const routes = {…}・routes.x = …・route() の中の詳細の分岐）
  const spas = []
  for (const page of pages.filter(p => p.scripts.length)) {
    const files = page.scripts.filter(f => src[f])
    const routerFile = files.find(f => /const routes = \{/.test(src[f]))
    const routes = []
    if (routerFile) {
      const s = src[routerFile]; const starts = lineStarts(s)
      const m = s.match(/const routes = \{/); const open = m.index + m[0].length - 1; const close = matchClose(s, open)
      for (const [a, b] of splitTop(s, open + 1, close)) {
        const part = s.slice(a, b).replace(/^\s*(\/\/[^\n]*\n\s*)*/, '')
        const km = part.match(/^\s*['"]?([\w-]+)['"]?\s*:\s*([\s\S]*)$/)
        if (km) routes.push({ hash: km[1], value: km[2].trim(), file: routerFile, line: lineOf(starts, a + s.slice(a, b).indexOf(km[1])) })
      }
      for (const f of files) {
        const t = src[f]; const ts = lineStarts(t)
        for (const x of t.matchAll(/routes(?:\.([\w]+)|\[['"]([\w-]+)['"]\])\s*=(?!=)/g)) {
          const hash = x[1] || x[2]
          const ex = routes.find(r => r.hash === hash)
          const item = { hash, value: valueAt(t, x.index + x[0].length), file: f, line: lineOf(ts, x.index) }
          if (ex) { ex.overrides = ex.overrides || []; ex.overrides.push(item) } else routes.push(item)
        }
      }
      // route() の中の分岐: if (tab === 'x' && id …) return fn(…)
      const rm = s.match(/function route\(\) \{/)
      if (rm) {
        const ro = rm.index + rm[0].length - 1; const rc = matchClose(s, ro)
        for (const x of s.slice(ro, rc).matchAll(/if \(tab === '([\w-]+)'(?: && (id === '([\w-]+)'|id !== undefined|id\b))?[^\n]*?\)\s*return (?:window\.)?(\w+)\(/g)) {
          // id の条件のない分岐（#board など）は、routes の表にないタブのときだけ足す（そのタブの画面を route() が直接描く）
          if (!x[2]) { if (!routes.some(r => r.hash === x[1])) routes.push({ hash: x[1], value: x[4], file: routerFile, line: lineOf(starts, ro + x.index) }); continue }
          routes.push({ hash: `${x[1]}/${x[3] || '<ID>'}`, value: x[4], file: routerFile, line: lineOf(starts, ro + x.index), sub: true })
        }
      }
    }
    for (const r of routes) {
      // 後から差し替えた routes.x があれば、そちらが使われる
      const last = r.overrides?.length ? r.overrides[r.overrides.length - 1] : r
      const values = last.value; const from = last.file
      // (window.renderX ? renderX() : renderDashboard()) は、読み込めなかったときの代わりの画面なので renderX だけにする
      const guarded = values.match(/window\.(render[A-Z]\w*)\s*\?/)
      r.renderers = guarded ? [guarded[1]] : [...new Set([...values.matchAll(/\b(render[A-Z]\w*)\b/g)].map(x => x[1]))]
      if (!r.renderers.length) r.renderers = [...new Set([...values.matchAll(/\b([a-z]\w*)\(/g)].map(x => x[1]).filter(n => defsIn(n, files, from).length))]
      const seen = new Set(); const apis = []
      for (const n of r.renderers) apis.push(...fnInfo(n, 2, seen, files, from).apis)
      const keys = new Map()
      for (const a of apis) for (const m of a.matches) keys.set(`${m.method} ${m.path}`, m)
      r.apis = [...keys.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
      r.unresolved = [...new Set(apis.filter(a => !a.matches.length).map(a => `${a.method} ${a.path}`))]
      r.defs = r.renderers.flatMap(n => defsIn(n, files, from).map(d => ({ name: n, file: `public/static/${d.file}`, line: d.line })))
      r.heading = r.renderers.map(n => headingOf(n, files, from)).find(Boolean) || ''
    }
    spas.push({ page: page.path, files, routerFile, routes })
  }
  return { pages, nav, navAdds, mobileOnly, hqNav, staffNav, staffTitles, spas, apiRefs, files: staticFiles }
}

/** /api/ の文字列から始まる式を読み、パスの形（変数の部分は {x}）を返す */
function exprPath(s, at, constName = null) {
  let i = at, out = ''
  const readLit = () => {
    const q = s[i]
    if (q === '`') {
      const end = skipTemplate(s, i)
      // ${…} は {x} にする（中に } を含むものも、対応する } まで飛ばす）
      let k = i + 1
      while (k < end - 1) { if (s[k] === '$' && s[k + 1] === '{') { out += '{x}'; k = matchClose(s, k + 1) + 1 } else if (s[k] === '\\') { out += s[k + 1]; k += 2 } else out += s[k++] }
      i = end
    } else if (q === "'" || q === '"') {
      // HTML を組み立てるテンプレートの中の href="/api/…${id}" も、${…} を {x} にする
      const end = skipString(s, i, q); out += s.slice(i + 1, end - 1).replace(/\$\{[^}]*\}/g, '{x}'); i = end
    } else return false
    return true
  }
  if (constName) { i = at + constName.length; out = '{x}' }
  else if (!readLit()) return ''
  for (;;) {
    const m = s.slice(i).match(/^\s*\+\s*/)
    if (!m) break
    i += m[0].length
    if (s[i] === "'" || s[i] === '"' || s[i] === '`') { readLit(); continue }
    // 変数・関数の呼び出し（括弧の中も飛ばす）
    const id = s.slice(i).match(/^[\w$.]+/)
    if (!id) break
    i += id[0].length
    while (s[i] === '(' || s[i] === '[') { const e = matchClose(s, i); if (e < 0) break; i = e + 1; const more = s.slice(i).match(/^\.[\w$]+/); if (more) i += more[0].length }
    out += '{x}'
  }
  // 最後の {x} が / の直後でないもの（'…/bulk' + q など）は、問い合わせの文字列とみなして外す
  return out.replace(/[?#].*$/, '').replace(/(\{x\})+/g, '{x}').replace(/([^/])\{x\}$/, '$1')
}
function matchRoutes(ref, routes) {
  const segs = ref.path.split('/').filter(Boolean)
  if (!ref.path.startsWith('/api/')) return []
  const scored = []
  for (const r of routes) {
    if (ref.method !== '?' && r.method !== ref.method) continue
    const rs = r.path.split('/').filter(Boolean)
    const rest = rs[rs.length - 1] === '*'
    if (rest ? segs.length < rs.length : rs.length !== segs.length) continue
    // 点数: 同じ文字 3・パラメーター 2・変数の部分（{x}）が固定の文字に当たる 1（ID の変数は、パラメーターのルートを優先する）
    let score = 0, ok = true
    for (let i = 0; i < rs.length; i++) {
      const js = segs[i], rt = rs[i]
      if (rt === '*' && i === rs.length - 1) { score += 2; break }
      if (rt.startsWith(':')) {
        const re = (rt.match(/\{(.+)\}$/) || [])[1]
        if (re && !js.includes('{x}') && !new RegExp(`^(?:${re})$`).test(js)) { ok = false; break }
        score += 2; continue
      }
      if (js === rt) { score += 3; continue }
      if (js.includes('{x}') && new RegExp('^' + js.split('{x}').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$').test(rt)) { score += 1; continue }
      ok = false; break
    }
    if (ok) scored.push({ r, score })
  }
  if (!scored.length) return []
  const best = Math.max(...scored.map(x => x.score))
  return scored.filter(x => x.score === best).map(x => x.r)
}

// =============================================================================================
// 4. Markdown を作る
// =============================================================================================
const TABLE_GROUPS = [
  // 人が決める分類（ER 図と表の一覧の見出し）。どれにも当たらない表は「その他」になる
  ['企業・利用者・ログイン', /^(companies|users|sessions|login_\w+|mfa_challenges|password_reset_tokens|persons)$/],
  ['スタッフ（名簿・人事・所属）', /^(staff_profiles|staff_affiliations?|staff_affiliation_\w+|staff_merges|staff_quick_locks|staff_documents|employee_\w+|employment_periods|evaluations|follow_logs|consultation\w*|roster_\w+|profile_change_requests|leave_requests|payout_accounts|staff_transport_defaults)$/],
  ['クライアント・案件・シフト', /^(clients|client_\w+|projects|project_\w+|sites|shift\w*|slot_patterns|rate_rules|affiliation_excluded_shifts|availability_\w+|staff_availability|staff_calendar_tokens|staff_schedule_tokens|premium_pay_settings)$/],
  ['勤怠・日報・報告の設定', /^(attendance_\w+|daily_report\w*|report_\w+|reminder_sends)$/],
  ['精算・支払', /^(settlement_\w+|payout_settings|staff_pay_requests|operation_logs)$/],
  ['お知らせ・通知・メール', /^(notice\w*|user_notification\w*|push_\w+|notification_emails|email_\w+|todo_dismissals)$/],
  ['募集・応募', /^recruit_\w+$/],
  ['案件掲示板', /^board_\w+$/],
  ['本部・運用', /^(hq_\w+|company_\w+|support_requests|offboarding_\w+|retention_\w+|cron_runs)$/],
]
const groupOf = (t) => (TABLE_GROUPS.find(([, re]) => re.test(t)) || ['その他'])[0]
const GROUP_ORDER = [...TABLE_GROUPS.map(g => g[0]), 'その他']
// 中心の表（全体の ER 図に出す）
const CORE_TABLES = ['companies', 'users', 'persons', 'staff_profiles', 'staff_affiliations', 'clients', 'projects', 'sites', 'shift_slots', 'shift_slot_roles', 'shifts', 'attendance_reports', 'daily_reports', 'attendance_corrections', 'recruit_pages', 'recruit_applications', 'board_posts', 'board_threads', 'board_proposals', 'notices']
const OPERATOR_COL = /(_by|_by_user_id|^actor_user_id|^author_user_id|^manager_id|^hr_staff_user_id|^registered_by)$/

function renderDb(db, ret) {
  const out = {}
  const pkOf = (t) => t.columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name)
  // 主キーが1列の表（列名 → 表）。REFERENCES のない列の対応に使う
  const pkOwner = {}
  for (const t of db.tables) { const pk = pkOf(t); if (pk.length === 1 && /_id$/.test(pk[0])) (pkOwner[pk[0]] = pkOwner[pk[0]] || []).push(t.name) }
  const PREFERRED = { staff_id: 'staff_profiles', user_id: 'users', company_id: 'companies', project_id: 'projects', client_id: 'clients', shift_id: 'shifts', notice_id: 'notices', person_id: 'persons' }
  const ownerFor = (col) => PREFERRED[col] || ((pkOwner[col] || []).length === 1 ? pkOwner[col][0] : null)
  const relations = []
  for (const t of db.tables) {
    for (const f of t.fks) relations.push({ from: t.name, col: f.from, to: f.table, toCol: f.to, declared: true })
    for (const c of t.columns) {
      if (!/_id$/.test(c.name) || c.pk || t.fks.some(f => f.from === c.name)) continue
      const o = ownerFor(c.name)
      if (o && o !== t.name) relations.push({ from: t.name, col: c.name, to: o, toCol: c.name, declared: false })
    }
  }
  out.summary = [
    `- マイグレーション: ${db.migrations.length} 本（${db.migrations[0]} 〜 ${db.migrations[db.migrations.length - 1]}）`,
    `- 表: ${db.tables.length}・索引: ${db.tables.reduce((a, t) => a + t.indexes.length, 0)}・トリガー: ${db.triggers.length}・ビュー: ${db.views.length}`,
    `- REFERENCES（外部キー）で宣言した関係: ${relations.filter(r => r.declared).length}・宣言のない \`*_id\` の列で、ほかの表の主キーと同じ名前のもの: ${relations.filter(r => !r.declared).length}`,
    `- 主キーが INTEGER の1列（ROWID。AUTOINCREMENT を含む）の表: ${db.tables.filter(t => { const pk = t.columns.filter(c => c.pk); return pk.length === 1 && /^INTEGER$/i.test(pk[0].type) }).length}・それ以外の主キーの表: ${db.tables.filter(t => { const pk = t.columns.filter(c => c.pk); return !(pk.length === 1 && /^INTEGER$/i.test(pk[0].type)) }).length}`,
    `- company_id の列がある表: ${db.tables.filter(t => t.columns.some(c => c.name === 'company_id')).length}`,
  ].join('\n')

  // ER 図。company_id（ほぼ全部の表にある）と、操作した人（*_by・actor_user_id など）の列は、線が多くなりすぎるので図には出さない（列の表には出す）
  const erOf = (names, extraTargets) => {
    const set = new Set(names)
    const rels = relations.filter(r => r.col !== 'company_id' && !OPERATOR_COL.test(r.col) && set.has(r.from) && (set.has(r.to) || extraTargets.includes(r.to)))
    const ents = new Set([...names, ...rels.map(r => r.to)])
    const lines = ['```mermaid', 'erDiagram']
    const seen = new Set()
    for (const r of rels) {
      const k = `${r.from}|${r.to}|${r.col}`; if (seen.has(k)) continue; seen.add(k)
      lines.push(`  ${r.to} ||--o{ ${r.from} : "${r.col}${r.declared ? '' : ' *'}"`)
    }
    for (const n of ents) if (!rels.some(r => r.from === n || r.to === n)) {
      // 線のない表も、主キー（なければ最初の列）を1つ書いて図に出す
      const t = db.tables.find(x => x.name === n); const c = t.columns.find(x => x.pk) || t.columns[0]
      lines.push(`  ${n} {\n    ${(c.type || 'ANY').replace(/\W/g, '_')} ${c.name}${c.pk ? ' PK' : ''}\n  }`)
    }
    lines.push('```')
    return lines.join('\n')
  }
  const missingCore = CORE_TABLES.filter(n => !db.tables.some(t => t.name === n))
  if (missingCore.length) warn(`CORE_TABLES の表がありません: ${missingCore.join(' ')}`)
  out.core = erOf(CORE_TABLES.filter(n => !missingCore.includes(n)), [])
  // 分類ごと
  const er = []
  for (const g of GROUP_ORDER) {
    const names = db.tables.map(t => t.name).filter(n => groupOf(n) === g)
    if (!names.length) continue
    er.push(`### ${g}\n\n${erOf(names, ['staff_profiles', 'users', 'projects', 'shifts'])}`)
  }
  out.er = er.join('\n\n')

  // 削除・匿名化・解約
  const ob = Object.fromEntries(ret.offboarding.map(o => [o.table, o]))
  const retiredSet = new Set(ret.retired.items); const inServiceSet = new Set(ret.inService.items)
  const byCreated = Object.fromEntries(ret.byCreated.map(b => [b.table, b]))
  const filesBy = {}; for (const f of ret.files) (filesBy[f.table] = filesBy[f.table] || []).push(f)
  const lifeOf = (t) => {
    const a = []
    if (byCreated[t]) a.push(`作成から${byCreated[t].years}年で削除（${link(ret.file, byCreated[t].line)}）`)
    if (retiredSet.has(t)) a.push(`退職後7年の削除の対象（\`RETIRED_TARGETS\`）`)
    if (t === 'staff_profiles' || t === 'users') a.push('退職後7年で匿名化（行は残す）')
    if (ob[t]) a.push(`解約時: ${ob[t].noDelete ? '書き出しのみ（行は残す）' : ob[t].noExport ? '削除（書き出さない）' : '書き出して削除'}`)
    if (ret.kept.items.includes(t)) a.push('解約時も残す（`OFFBOARDING_KEPT_TABLES`）')
    if (filesBy[t]) a.push(`R2 のファイル（${filesBy[t].map(f => f.bucket).join('・')}）`)
    return a
  }
  out.retention = [
    `| 対象（${code('RETIRED_TARGETS')}・${link(ret.file, ret.retired.line)}） | 種類 |`, '|---|---|',
    ...ret.retired.items.map(x => `| ${code(x)} | ${db.tables.some(t => t.name === x) ? '表' : '表ではない対象（人数・R2 のファイル・匿名化など）'} |`),
    '', `在職中の保存期間で消すもの（${code('IN_SERVICE_TARGETS')}・${link(ret.file, ret.inService.line)}）: ${ret.inService.items.map(code).join('・')}`,
    '', `退職後7年の匿名化で空にする ${code('staff_profiles')} の列（${code('ANONYMIZE_PROFILE_COLUMNS')}・${link(ret.file, ret.anonymize.line)}）: ${ret.anonymize.items.map(code).join('・')}`,
    '', `作成からの年数で消す表: ${ret.byCreated.map(b => `${code(b.table)}（${b.years}年・${link(ret.file, b.line)}）`).join('・')}`,
    '', `R2 に置くファイル（解約時の書き出しの対象。${code('OFFBOARDING_FILE_SOURCES')}）: ${ret.files.map(f => `${code(f.table)}→${f.bucket}`).join('・')}`,
  ].join('\n')
  const missingOb = db.tables.filter(t => t.columns.some(c => c.name === 'company_id') && !ob[t.name] && !ret.kept.items.includes(t.name)).map(t => t.name)
  out.offboarding = [
    `解約（企業のデータの書き出しと削除）の対象は ${code('OFFBOARDING_TABLES')}（${ret.offboarding.length} 表）、残す表は ${code('OFFBOARDING_KEPT_TABLES')}（${link(ret.file, ret.kept.line)}）。`,
    missingOb.length ? `\n**company_id の列があるのに、どちらにも入っていない表**（新しく表を足したら retention.ts に入れる決まり）: ${missingOb.map(code).join('・')}` : '\ncompany_id の列がある表は、すべてどちらかに入っています。',
  ].join('\n')

  // 表の一覧
  const list = []
  for (const g of GROUP_ORDER) {
    const ts = db.tables.filter(t => groupOf(t.name) === g)
    if (!ts.length) continue
    list.push(`### ${g}\n`, '| 表 | 名前（retention.ts） | 用途（作ったマイグレーションのコメント） | 作成 | 行の扱い |', '|---|---|---|---|---|')
    for (const t of ts) list.push(`| [${code(t.name)}](#${t.name}) | ${cell(ob[t.name]?.label || '')} | ${cell(clip(t.comment, 120))} | ${t.created ? t.created.slice(0, 4) : ''} | ${cell(lifeOf(t.name).join('<br>'))} |`)
    list.push('')
  }
  out.tables = list.join('\n')

  // 表の定義
  const defs = []
  for (const g of GROUP_ORDER) {
    const ts = db.tables.filter(t => groupOf(t.name) === g)
    if (!ts.length) continue
    defs.push(`### ${g}`)
    for (const t of ts) {
      const fkOf = (c) => t.fks.find(f => f.from === c)
      defs.push('', `<a id="${t.name}"></a>`, `#### ${t.name}${ob[t.name] ? ` — ${ob[t.name].label}` : ''}`, '')
      if (t.comment) defs.push(`> ${clip(t.comment, 400)}`, '')
      defs.push(`作成: ${link('migrations/' + t.created, 1)}${lifeOf(t.name).length ? '　／　' + lifeOf(t.name).join('　／　') : ''}`, '')
      defs.push('| 列 | 型 | NULL | 既定値 | キー・参照 | 追加 | 説明（マイグレーションのコメント） |', '|---|---|---|---|---|---|---|')
      for (const c of t.columns) {
        const fk = fkOf(c.name)
        const rel = relations.find(r => r.from === t.name && r.col === c.name && !r.declared)
        const key = [c.pk ? 'PK' : '', fk ? `→ ${fk.table}.${fk.to}${fk.on_delete && fk.on_delete !== 'NO ACTION' ? `（${fk.on_delete}）` : ''}` : '', !fk && rel && c.name !== 'company_id' ? `（${rel.to}）` : ''].filter(Boolean).join(' ')
        defs.push(`| ${code(c.name)} | ${cell(c.type)} | ${c.notnull || c.pk ? '' : '可'} | ${cell(c.default ?? '')} | ${cell(key)} | ${c.added ? c.added.slice(0, 4) : ''} | ${cell(clip(c.comment, 160))} |`)
      }
      const uniq = t.indexes.filter(i => i.origin === 'u'), idx = t.indexes.filter(i => i.origin === 'c')
      if (uniq.length) defs.push('', `UNIQUE 制約: ${uniq.map(i => `(${i.columns.join(', ')})`).join('・')}`)
      if (t.checks.length) defs.push('', `CHECK 制約: ${t.checks.map(x => code(clip(x, 200))).join('・')}`)
      if (idx.length) {
        defs.push('', '索引:', '')
        for (const i of idx) {
          const where = (String(i.sql || '').match(/\bWHERE\b([\s\S]*)$/i) || [])[1]
          defs.push(`- ${code(i.name)}${i.unique ? '（UNIQUE）' : ''}: (${i.columns.join(', ')})${where ? ` WHERE ${code(clip(where, 160))}` : ''}`)
        }
      }
      const trg = db.triggers.filter(x => x.table === t.name)
      if (trg.length) defs.push('', `トリガー: ${trg.map(x => `[${code(x.name)}](#trigger-${x.name})`).join('・')}`)
    }
    defs.push('')
  }
  out.definitions = defs.join('\n')

  out.triggers = db.triggers.map(t => {
    const ev = (t.sql.match(/\b(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)(\s+OF\s+[\w, ]+?)?\s+ON\b/i) || [])
    return `<a id="trigger-${t.name}"></a>\n#### ${t.name}（${t.table}・${ev[1] || ''} ${ev[2] || ''}${ev[3] ? ev[3] : ''}）\n\n\`\`\`sql\n${t.sql.trim()}\n\`\`\``
  }).join('\n\n') + (db.views.length ? '\n\nビュー: ' + db.views.map(v => code(v.name)).join('・') : '')
  return out
}

function renderApi(api, screens) {
  const out = {}
  const AREAS = [
    ['/api/public', '公開（ログイン不要。トークンの URL）'], ['/api/auth', 'ログイン・自分のアカウント'], ['/api/staff', 'スタッフアプリ'],
    ['/api/admin', '管理画面'], ['/api/hq', '本部画面'], ['/api', 'その他'],
  ]
  const areaOf = (p) => AREAS.find(([pre]) => p === pre || p.startsWith(pre + '/'))[0]
  const byArea = {}
  for (const e of api.endpoints) (byArea[areaOf(e.path)] = byArea[areaOf(e.path)] || []).push(e)
  const accessCount = {}
  for (const e of api.endpoints) accessCount[e.access.label] = (accessCount[e.access.label] || 0) + 1
  out.summary = [
    `- エンドポイント: ${api.endpoints.length}（${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => `${m} ${api.endpoints.filter(e => e.method === m).length}`).join('・')}）`,
    `- ミドルウェア: ${api.middlewares.length}・画面などのルート（src/index.tsx）: ${api.pages.length}`,
    `- 画面の JS（public/static）から呼んでいる形が見つかったもの: ${api.endpoints.filter(e => e.callers?.length).length}・見つからないもの: ${api.endpoints.filter(e => !e.callers?.length).length}`,
    '', '| 区分 | 数 |', '|---|---|',
    ...AREAS.filter(([p]) => byArea[p]).map(([p, label]) => `| ${code(p + '/…')} ${label} | ${byArea[p].length} |`),
    '', '| 通すロール | 数 |', '|---|---|',
    ...Object.entries(accessCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`),
  ].join('\n')
  out.middlewares = ['| 順 | パス | 定義 | 内容 |', '|---|---|---|---|',
    ...api.middlewares.map((m, i) => `| ${i + 1} | ${code('/api' + m.path)} | ${m.file ? link(m.file, m.line) : '?'} | ${cell(m.def?.label || '（説明なし）')} |`)].join('\n')
  out.pages = ['| メソッド | パス | 定義 | 用途 |', '|---|---|---|---|',
    ...api.pages.map(p => `| ${p.method} | ${code(p.path)} | ${link(p.file, p.line)} | ${cell(clip(p.comment || p.section, 160))} |`)].join('\n')
  const sections = []
  for (const [pre, label] of AREAS) {
    const list = (byArea[pre] || []).slice().sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    if (!list.length) continue
    sections.push(`### ${code(pre + '/…')} ${label}（${list.length}）`, '', '| メソッド | パス | 通すロール | 定義 | 用途（直前のコメント・なければ見出し） | 画面の JS |', '|---|---|---|---|---|---|')
    for (const e of list) {
      const callers = [...new Set((e.callers || []).map(c => c.file.replace('public/static/', '')))]
      const purpose = e.comment || (e.section ? `〔見出し〕${e.section}` : '')
      const access = e.access.label + (e.extraChecks.length ? `<br>＋本文で確認: ${e.extraChecks.join('・')}` : '')
      sections.push(`| ${e.method} | ${code(e.path)} | ${cell(access)} | ${e.file ? link(e.file, e.line) : '?'} | ${cell(clip(purpose, 160))} | ${cell(callers.join(' '))} |`)
    }
    sections.push('')
  }
  out.endpoints = sections.join('\n')
  return out
}

function renderScreens(sc, api) {
  const out = {}
  out.pages = ['| パス | 定義 | ログイン | 読み込む画面の JS |', '|---|---|---|---|',
    ...sc.pages.map(p => `| ${code(p.path)} | ${link('src/index.tsx', p.line)} | ${cell(p.roleCheck ? code(p.roleCheck) : (/^\/(staff|admin|hq)$/.test(p.path) ? '要' : ''))} | ${p.scripts.map(s => code(s)).join(' ')} |`)].join('\n')
  const g = []
  let cur = null
  for (const n of sc.nav) {
    if (n.group !== cur) { g.push(`- ${n.group ? `**${n.group}**` : '（見出しなし）'}`); cur = n.group }
    g.push(`  - ${code('#' + n.tab)} ${n.label}${n.addedBy ? `（${n.addedBy} が足す）` : ''}`)
  }
  for (const m of sc.mobileOnly) g.push(`- （スマホのメニューだけ）${code('#' + m.tab)} ${m.label}（${code('#' + m.after)} の後ろ。${m.addedBy} が足す）`)
  out.adminNav = g.join('\n')
  out.hqNav = sc.hqNav.map(n => `- ${code('#' + n.tab)} ${n.label}${n.addedBy ? `（${n.addedBy} が足す）` : ''}`).join('\n')
  out.staffNav = sc.staffNav.map(n => `- ${code('#' + n.tab)} ${n.label}`).join('\n')
  const labelFor = (spa, hash) => {
    const [tab, sub] = hash.split('/')
    let base = spa.page === '/admin' ? (sc.nav.find(n => n.tab === tab)?.label || sc.mobileOnly.find(n => n.tab === tab)?.label)
      : spa.page === '/hq' ? sc.hqNav.find(n => n.tab === tab)?.label : sc.staffTitles[tab]
    return (base || '') + (sub ? `（${sub === '<ID>' ? '詳細' : sub}）` : '')
  }
  const per = []
  for (const spa of sc.spas.filter(s => s.routes.length)) {
    per.push(`### ${code(spa.page)}（ルートの表: ${link('public/static/' + spa.routerFile, spa.routes[0]?.line || 1)}）`, '',
      '| ハッシュ | 画面 | 描画する関数（定義） | 使う API（描画する関数と、そこから呼ぶ関数を2段まで。ボタンの操作で呼ぶものを含む） |', '|---|---|---|---|')
    const sorted = spa.routes.slice().sort((a, b) => a.hash.localeCompare(b.hash))
    for (const r of sorted) {
      const defs = r.defs.map(d => `${code(d.name)} ${link(d.file, d.line)}`).join('<br>')
      const apis = r.apis.map(a => `${a.method} ${code(a.path)}`).join('<br>') + (r.unresolved.length ? `<br>（対応する API が見つからない呼び出し: ${r.unresolved.map(code).join(' ')}）` : '')
      const label = labelFor(spa, r.hash) || (r.heading ? `${r.heading}（メニューにない画面。見出しから）` : '')
      per.push(`| ${code('#' + r.hash)} | ${cell(label)} | ${defs} | ${apis} |`)
    }
    per.push('')
  }
  out.routes = per.join('\n')
  // 画面の JS ごとの API の呼び出し
  const byFile = {}
  for (const r of sc.apiRefs) (byFile[r.file] = byFile[r.file] || []).push(r)
  const fl = ['| 画面の JS | 呼び出しの数 | 対応する API の数 | 対応する API が見つからない呼び出し（メソッド パス:行） |', '|---|---|---|---|']
  for (const f of Object.keys(byFile).sort()) {
    const refs = byFile[f]
    const ok = new Set(refs.flatMap(r => r.matches.map(m => `${m.method} ${m.path}`)))
    const ng = [...new Set(refs.filter(r => !r.matches.length).map(r => `${r.method} ${r.path}:${r.line}`))]
    fl.push(`| ${code(f)} | ${refs.length} | ${ok.size} | ${cell(ng.map(code).join(' '))} |`)
  }
  out.files = fl.join('\n')
  return out
}

// 人が書く説明の中の [`名前`](../src/…) のリンクを確かめる
function checkRefs(docs, db) {
  const rows = []; const errors = []
  for (const [name, text] of Object.entries(docs)) {
    const human = text.replace(/<!-- BEGIN GENERATED: [\w-]+ -->[\s\S]*?<!-- END GENERATED: [\w-]+ -->/g, '')
    for (const m of human.matchAll(/\[`([\w$.]+)`\]\(\.\.\/((?:src|public|migrations|scripts)\/[\w./-]+?)\)/g)) {
      const [, sym, file] = m
      if (!existsSync(join(ROOT, file))) { errors.push(`${name}: ${file} がありません`); continue }
      const s = read(file); const starts = lineStarts(s)
      const last = sym.split('.').pop().replace(/\$/g, '\\$')
      // 定義（const・function など）を優先し、なければ最初に出てくる所
      const mm = [`(?:const|let|var|function|class|type|interface)\\s+${last}\\b`, `\\bwindow\\.${last}\\s*=`, `^\\s*(?:async\\s+)?${last}\\s*[:(=]`, `\\b${last}\\b`]
        .map(p => s.match(new RegExp(p, 'm'))).find(Boolean)
      if (!mm) { errors.push(`${name}: ${file} に ${sym} が見つかりません`); continue }
      rows.push({ doc: name, sym, file, line: lineOf(starts, mm.index) })
    }
    // `表.列` と書いた列が、今の DB にあるか
    if (db) for (const m of human.matchAll(/`([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)`/g)) {
      const t = db.tables.find(x => x.name === m[1])
      if (t && !t.columns.some(c => c.name === m[2])) errors.push(`${name}: ${m[1]} に列 ${m[2]} がありません`)
    }
  }
  return { rows, errors }
}

function replaceBlocks(text, blocks, docName) {
  let out = text
  for (const [name, body] of Object.entries(blocks)) {
    const re = new RegExp(`(<!-- BEGIN GENERATED: ${name} -->)[\\s\\S]*?(<!-- END GENERATED: ${name} -->)`)
    if (!re.test(out)) { warn(`docs/${docName} に生成の区切り「${name}」がありません`); process.exitCode = 1; continue }
    out = out.replace(re, (_, a, b) => `${a}\n${body.trim()}\n${b}`)
  }
  return out
}

// =============================================================================================
async function main() {
  const db = await collectDb()
  const ret = collectRetention()
  const api = await collectApi()
  const screens = collectScreens(api)
  const docsDir = join(ROOT, 'docs')
  const original = Object.fromEntries(DOC_NAMES.map(n => [n, existsSync(join(docsDir, n)) ? readFileSync(join(docsDir, n), 'utf8').replace(/\r\n/g, '\n') : null]))
  for (const [n, t] of Object.entries(original)) if (t === null) throw new Error(`docs/${n} がありません（人が書く部分と生成の区切りを書いた雛形が必要です）`)
  const refs = checkRefs(original, db)
  const refTable = (doc) => {
    const rows = refs.rows.filter((r, i, a) => r.doc === doc && a.findIndex(x => x.doc === doc && x.sym === r.sym && x.file === r.file) === i)
    if (!rows.length) return '（なし）'
    return ['| 名前 | 位置 |', '|---|---|', ...rows.map(r => `| ${code(r.sym)} | ${link(r.file, r.line)} |`)].join('\n')
  }
  const blocks = {
    'db.md': { ...prefixKeys('db', renderDb(db, ret)), 'db-refs': refTable('db.md') },
    'api.md': { ...prefixKeys('api', renderApi(api, screens)), 'api-refs': refTable('api.md') },
    'screens.md': { ...prefixKeys('screens', renderScreens(screens, api)), 'screens-refs': refTable('screens.md') },
  }
  for (const e of refs.errors) warn(e)
  const result = Object.fromEntries(DOC_NAMES.map(n => [n, replaceBlocks(original[n], blocks[n], n)]))

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({
      migrations: db.migrations, tables: db.tables.map(t => ({ name: t.name, columns: t.columns.map(c => c.name), created: t.created })), triggers: db.triggers.map(t => t.name),
      endpoints: api.endpoints.map(e => ({ method: e.method, path: e.path, file: e.file, line: e.line, access: e.access, extraChecks: e.extraChecks, callers: (e.callers || []).length })),
      middlewares: api.middlewares.map(m => ({ path: m.path, file: m.file, line: m.line, label: m.def?.label || null })),
      unmatched: api.unmatched, pages: screens.pages, nav: screens.nav, hqNav: screens.hqNav, staffNav: screens.staffNav,
      spas: screens.spas.map(s => ({ page: s.page, routes: s.routes.map(r => ({ hash: r.hash, renderers: r.renderers, defs: r.defs, apis: r.apis.map(a => `${a.method} ${a.path}`) })) })),
      refErrors: refs.errors, warnings,
    }, null, 1))
  }
  if (CHECK) {
    const stale = DOC_NAMES.filter(n => result[n] !== original[n])
    if (stale.length) { console.error(`docs が今のコードと合っていません: ${stale.map(n => 'docs/' + n).join(' ')}（npm run docs で作り直してください）`); process.exit(1) }
    if (refs.errors.length) process.exit(1)
    console.log('docs は今のコードと合っています')
    return
  }
  const target = OUT_DIR ? OUT_DIR : docsDir
  mkdirSync(target, { recursive: true })
  for (const n of DOC_NAMES) writeFileSync(join(target, n), result[n])
  console.log(`書き出しました: ${DOC_NAMES.map(n => rel(join(target, n))).join(' ')}（表 ${db.tables.length}・API ${api.endpoints.length}・画面のルート ${screens.spas.reduce((a, s) => a + s.routes.length, 0)}）`)
  if (refs.errors.length) process.exit(1)
}
const prefixKeys = (p, o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${p}-${k}`, v]))

main().catch(e => { console.error(e.message || e); process.exit(1) })
