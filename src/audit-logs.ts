// 「操作の記録」の画面の API（Sprint 31 w31-audit: #9988）。
// 管理画面（会社管理者だけ。権限の表の audit_logs.view）と、本部の企業詳細（本部が見たことは hq_audit_logs に残す）で同じ一覧を返す。
// 次の3つの表を作り直さずに、読むときに新しい順に合わせて出す:
//   a: audit_logs（CSV・ファイルの書き出しと管理の操作。src/lib/audit-log.ts）
//   o: operation_logs（シフト・募集枠・精算の操作履歴 #159。1回の操作（op_key）の先頭の行を1件として出す）
//   l: login_events（ログインの履歴。created_at は UTC なので日本時間にそろえる。管理者が行った強制終了・パスワードの再発行は a に残るので出さない）
// ページ送りは「最後の行の日時・表・ID」を cursor に渡す形（OFFSET を使わず、読む行数をページの大きさに抑える）
import { Hono } from 'hono'
import { requirePerm, ADMIN_ROLES, ROLE_LABELS } from './lib/permissions'
import { AUDIT_CATEGORY_LABELS, AUDIT_TARGET_LABELS, AUDIT_FILTER_LABELS, CLIENT_EXPORT_KINDS, auditInsertStmt, type AuditChange } from './lib/audit-log'
import { OP_ACTION_LABELS, opChanges } from './lib/operation-log'
import { deviceLabel } from './lib/login-security'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'
import { toCsv, csvResponse } from './csv'
import { nowJST, jstOf, addDays, isDate } from './lib/time'
import { readJson } from './lib/http'

type Bindings = { DB: D1Database }
type Variables = { user: any }
type Env = { Bindings: Bindings; Variables: Variables }

export const AUDIT_PAGE = 50
/** CSV の上限（新しい順。Free プランの CPU 時間に収めるため、日報の CSV と同じ 2,000 件） */
export const AUDIT_CSV_LIMIT = 2000
const RANK: Record<string, number> = { a: 3, o: 2, l: 1 }
const LOGIN_EVENT_LABEL: Record<string, string> = {
  login: 'ログイン', password_reset: 'パスワードの再設定', logout_all: '本人がすべての端末からログアウト', forced_logout: 'ログインの強制終了', switch_company: '企業の切り替え',
}
const LOGIN_RESULT_LABEL: Record<string, string> = {
  success: '成功', bad_password: 'ID・パスワードの誤り', locked: '失敗が続き一時停止', inactive: '停止中のアカウント', company_inactive: '契約停止中',
  ip_denied: '接続元の制限', mfa_failed: '確認コードの誤り',
}
const LOGIN_METHOD_LABEL: Record<string, string> = { password: 'パスワード', totp: 'パスワード＋認証アプリ', recovery: 'パスワード＋予備コード' }

export type AuditFilter = { kind: string; actor: number | null; from: string | null; to: string | null; cursor: { at: string; src: string; id: number } | null }
export type AuditItem = {
  key: string; src: 'a' | 'o' | 'l'; id: number; at: string; category: string; category_label: string; label: string
  actor: string; actor_role: string | null; hq: boolean; target: string | null; lines: string[]; changes: AuditChange[]; ip: string | null; failed?: boolean
}

/** 絞り込みの条件を読む。誤りがあれば文言を返す */
export function parseAuditFilter(q: (k: string) => string | undefined): AuditFilter | { error: string } {
  const kind = q('kind') || ''
  if (kind && !AUDIT_CATEGORY_LABELS[kind]) return { error: '種類が正しくありません' }
  const actorRaw = q('actor') || ''
  if (actorRaw && !/^\d{1,10}$/.test(actorRaw)) return { error: '操作した人が正しくありません' }
  const from = q('from') || null, to = q('to') || null
  if ((from && !isDate(from)) || (to && !isDate(to))) return { error: '期間の日付の形式が正しくありません' }
  if (from && to && from > to) return { error: '開始日は終了日より前にしてください' }
  let cursor: AuditFilter['cursor'] = null
  const cur = q('cursor')
  if (cur) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|([aol])\|(\d{1,12})$/.exec(cur)
    if (!m) return { error: '続きの位置が正しくありません。画面を読み込み直してください' }
    cursor = { at: m[1], src: m[2], id: Number(m[3]) }
  }
  return { kind, actor: actorRaw ? Number(actorRaw) : null, from, to, cursor }
}

// 日本時間の 'YYYY-MM-DD HH:MM:SS' → UTC の ISO 文字列（login_events と比べる）
const utcOf = (jst: string, plusMs = 0) => new Date(Date.parse(jst.replace(' ', 'T') + '+09:00') + plusMs).toISOString()
// cursor より後ろ（古い）の行の条件。同じ秒の行は、表の順（a → o → l）と ID の大きい順で並べる
function cursorCond(src: string, col: string, idCol: string, f: AuditFilter, binds: unknown[]): string | null {
  const cur = f.cursor
  if (!cur) return null
  const mine = RANK[src], theirs = RANK[cur.src]
  if (src === 'l') {
    const start = utcOf(cur.at), end = utcOf(cur.at, 1000)
    if (mine > theirs) { binds.push(start); return `${col} < ?` }
    if (mine < theirs) { binds.push(end); return `${col} < ?` }
    binds.push(start, end, cur.id); return `(${col} < ? OR (${col} < ? AND ${idCol} < ?))`
  }
  if (mine > theirs) { binds.push(cur.at); return `${col} < ?` }
  if (mine < theirs) { binds.push(cur.at); return `${col} <= ?` }
  binds.push(cur.at, cur.at, cur.id); return `(${col} < ? OR (${col} = ? AND ${idCol} < ?))`
}
function periodConds(src: string, col: string, f: AuditFilter, where: string[], binds: unknown[]) {
  if (f.from) { where.push(`${col} >= ?`); binds.push(src === 'l' ? utcOf(`${f.from} 00:00:00`) : `${f.from} 00:00:00`) }
  if (f.to) { where.push(`${col} < ?`); binds.push(src === 'l' ? utcOf(`${addDays(f.to, 1)} 00:00:00`) : `${addDays(f.to, 1)} 00:00:00`) }
}
const actorName = (name: unknown, role: unknown) => role === 'system_admin' ? `本部${name ? `（${String(name).replace(/^本部（|）$/g, '')}）` : ''}` : (name ? String(name) : '（不明）')
const roleLabel = (r: unknown) => (r ? (ROLE_LABELS as Record<string, string>)[String(r)] || String(r) : null)

// 条件の値の表示（種類・形式など、コードの値のままでは分からないもの）
const FILTER_VALUE_LABELS: Record<string, Record<string, string>> = {
  kind: { ...AUDIT_CATEGORY_LABELS, detail: '明細', billing: '請求', payment: '支払' },
  format: { csv: 'CSV', zengin: '全銀の形式' }, include_pay: { '1': '含める' }, issues_only: { '1': 'はい' },
}
function filterText(filters: Record<string, string>): string {
  return Object.entries(filters).map(([k, v]) => `${AUDIT_FILTER_LABELS[k] || k}: ${FILTER_VALUE_LABELS[k]?.[v] ?? v}`).join('・')
}
function auditLines(d: any): string[] {
  if (!d || typeof d !== 'object') return []
  const out: string[] = []
  if (d.file) out.push(`ファイル: ${d.file}`)
  if (d.rows != null) out.push(`行数: ${Number(d.rows).toLocaleString('ja-JP')}行${d.truncated ? `（上限で切りました。全${Number(d.truncated) || ''}件）` : ''}`)
  if (d.filters && typeof d.filters === 'object') out.push(`条件: ${filterText(d.filters)}`)
  if (d.count != null) out.push(`登録した人数: ${Number(d.count)}人${d.skipped ? `（登録しなかった行 ${Number(d.skipped)}行）` : ''}`)
  for (const [k, v] of Object.entries(d)) {
    if (['file', 'rows', 'filters', 'truncated', 'changes', 'more_changes', 'count', 'skipped', 'note', 'staff_id'].includes(k)) continue
    out.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  if (Array.isArray(d.changes) && !d.changes.length) out.push('変わった項目はありません')
  if (d.more_changes) out.push(`ほか${Number(d.more_changes)}項目が変わりました`)
  if (d.note) out.push(String(d.note))
  return out
}
function parseJson(v: unknown): any {
  if (typeof v !== 'string' || !v) return null
  try { return JSON.parse(v) } catch { return null }
}

/** 一覧の1ページ（limit 件）。has_more のときは next_cursor で続きを読む */
export async function loadAuditItems(db: D1Database, companyId: number, f: AuditFilter, limit: number): Promise<{ items: AuditItem[]; next_cursor: string | null }> {
  const useA = f.kind !== 'login', useO = f.kind === '' || f.kind === 'shift', useL = f.kind === '' || f.kind === 'login'
  const stmts: D1PreparedStatement[] = [], kinds: string[] = []
  if (useA) {
    const where = ['l.company_id = ?'], binds: unknown[] = [companyId]
    if (f.kind) { where.push('l.category = ?'); binds.push(f.kind) }
    if (f.actor) { where.push('l.actor_user_id = ?'); binds.push(f.actor) }
    periodConds('a', 'l.created_at', f, where, binds)
    const cc = cursorCond('a', 'l.created_at', 'l.audit_id', f, binds); if (cc) where.push(cc)
    stmts.push(db.prepare(`SELECT l.audit_id AS id, l.created_at AS at, l.category, l.action, l.label, l.actor_role, us.name AS actor_name,
        l.target_type, l.target_name, l.detail_json, l.ip
      FROM audit_logs l LEFT JOIN users us ON us.user_id = l.actor_user_id
      WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.audit_id DESC LIMIT ?`).bind(...binds, limit + 1))
    kinds.push('a')
  }
  if (useO) {
    // 1回の操作（op_key）の先頭の行だけ（まとめての操作は件数を添える）
    const where = ['l.company_id = ?', 'NOT EXISTS (SELECT 1 FROM operation_logs o2 WHERE o2.op_key = l.op_key AND o2.log_id < l.log_id)'], binds: unknown[] = [companyId]
    if (f.actor) { where.push('l.actor_user_id = ?'); binds.push(f.actor) }
    periodConds('o', 'l.created_at', f, where, binds)
    const cc = cursorCond('o', 'l.created_at', 'l.log_id', f, binds); if (cc) where.push(cc)
    stmts.push(db.prepare(`SELECT l.log_id AS id, l.created_at AS at, l.entity, l.action, l.before_json, l.after_json, us.name AS actor_name, us.role AS actor_role,
        (SELECT COUNT(*) FROM operation_logs o3 WHERE o3.op_key = l.op_key) AS n
      FROM operation_logs l LEFT JOIN users us ON us.user_id = l.actor_user_id
      WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.log_id DESC LIMIT ?`).bind(...binds, limit + 1))
    kinds.push('o')
  }
  if (useL) {
    const where = ['e.company_id = ?',
      // 自社の管理者が行った強制終了・パスワードの再発行は、管理者の操作（audit_logs）として出す
      `NOT (e.event_type IN ('password_reset', 'forced_logout') AND e.actor_user_id IS NOT NULL AND (SELECT a.company_id FROM users a WHERE a.user_id = e.actor_user_id) = e.company_id)`]
    const binds: unknown[] = [companyId]
    if (f.actor) { where.push('(e.user_id = ? OR e.actor_user_id = ?)'); binds.push(f.actor, f.actor) }
    periodConds('l', 'e.created_at', f, where, binds)
    const cc = cursorCond('l', 'e.created_at', 'e.event_id', f, binds); if (cc) where.push(cc)
    stmts.push(db.prepare(`SELECT e.event_id AS id, e.created_at AS at_utc, e.event_type, e.result, e.method, e.ip, e.user_agent, e.user_code,
        us.name AS user_name, us.role AS user_role, ac.name AS actor_name
      FROM login_events e LEFT JOIN users us ON us.user_id = e.user_id LEFT JOIN users ac ON ac.user_id = e.actor_user_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.event_id DESC LIMIT ?`).bind(...binds, limit + 1))
    kinds.push('l')
  }
  const res = stmts.length ? await db.batch(stmts) : []
  const rows: { src: string; at: string; id: number; r: any }[] = []
  res.forEach((r, i) => {
    for (const x of (r.results || []) as any[]) {
      const at = kinds[i] === 'l' ? jstOf(Date.parse(String(x.at_utc))) : String(x.at)
      rows.push({ src: kinds[i], at, id: Number(x.id), r: x })
    }
  })
  rows.sort((p, q) => (p.at < q.at ? 1 : p.at > q.at ? -1 : RANK[q.src] - RANK[p.src] || q.id - p.id))
  const page = rows.slice(0, limit)
  const more = rows.length > limit

  // シフトの操作の、スタッフ・案件の名前（自社のものだけ）
  const opRows = page.filter(x => x.src === 'o').map(x => ({ x, d: opChanges(x.r.entity, x.r.before_json, x.r.after_json) }))
  const staffIds = new Set<number>(), projectIds = new Set<number>()
  for (const { d } of opRows) {
    const cur = d.after || d.before || {}
    if (Number(cur.staff_id) > 0) staffIds.add(Number(cur.staff_id))
    if (Number(cur.project_id) > 0) projectIds.add(Number(cur.project_id))
  }
  const names = { staff: new Map<number, string>(), project: new Map<number, string>() }
  if (staffIds.size || projectIds.size) {
    const [s, p] = await db.batch([
      db.prepare(`SELECT sp.staff_id AS id, us.name FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.company_id = ? AND sp.staff_id IN ${JSON_IN}`).bind(companyId, bindJsonArray([...staffIds])),
      db.prepare(`SELECT project_id AS id, project_name AS name FROM projects WHERE company_id = ? AND project_id IN ${JSON_IN}`).bind(companyId, bindJsonArray([...projectIds])),
    ])
    for (const r of s.results as any[]) names.staff.set(Number(r.id), String(r.name))
    for (const r of p.results as any[]) names.project.set(Number(r.id), String(r.name))
  }
  const opDetail = new Map(opRows.map(o => [o.x, o.d]))
  const opValue = (field: string, v: unknown) => {
    if (v == null || v === '') return null
    if (field === 'staff_id') return names.staff.get(Number(v)) || `#${v}`
    if (field === 'project_id') return names.project.get(Number(v)) || `#${v}`
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return s.length > 120 ? s.slice(0, 120) + '…' : s
  }

  const items: AuditItem[] = page.map(x => {
    const r = x.r
    if (x.src === 'a') {
      const d = parseJson(r.detail_json)
      const tl = r.target_type && r.target_type !== 'company' ? AUDIT_TARGET_LABELS[r.target_type] || '' : ''
      return { key: `a${x.id}`, src: 'a', id: x.id, at: x.at, category: r.category, category_label: AUDIT_CATEGORY_LABELS[r.category] || r.category, label: String(r.label || r.action),
        actor: actorName(r.actor_name, r.actor_role), actor_role: roleLabel(r.actor_role), hq: r.actor_role === 'system_admin',
        target: r.target_name ? (tl ? `${tl}: ${r.target_name}` : String(r.target_name)) : null,
        lines: auditLines(d), changes: Array.isArray(d?.changes) ? d.changes : [], ip: r.ip || null }
    }
    if (x.src === 'o') {
      const d = opDetail.get(x)!
      const cur: any = d.after || d.before || {}
      const n = Number(r.n) || 1
      const when = [cur.work_date, cur.start_time && cur.end_time ? `${cur.start_time}〜${cur.end_time}` : null].filter(Boolean).join(' ')
      const who = [Number(cur.staff_id) > 0 ? names.staff.get(Number(cur.staff_id)) || `#${cur.staff_id}` : null, Number(cur.project_id) > 0 ? names.project.get(Number(cur.project_id)) || `#${cur.project_id}` : null].filter(Boolean).join('・')
      return { key: `o${x.id}`, src: 'o', id: x.id, at: x.at, category: 'shift', category_label: AUDIT_CATEGORY_LABELS.shift,
        label: `${r.entity === 'slot' ? '募集枠' : 'シフト'}: ${OP_ACTION_LABELS[r.action] || r.action}`,
        actor: actorName(r.actor_name, r.actor_role), actor_role: roleLabel(r.actor_role), hq: false,
        target: [when, who].filter(Boolean).join(' ') || null,
        lines: n > 1 ? [`まとめての操作（${n}件）。下は1件目の内容です`] : [],
        changes: d.changes.slice(0, 8).map(ch => ({ f: ch.field, l: ch.label, b: opValue(ch.field, ch.before), a: opValue(ch.field, ch.after) })), ip: null }
    }
    const failed = r.result !== 'success'
    const lines = [`ID: ${r.user_code || '-'}`]
    if (r.event_type === 'login' && r.method && !failed) lines.push(`方法: ${LOGIN_METHOD_LABEL[r.method] || r.method}`)
    if (r.user_agent) lines.push(`端末: ${deviceLabel(r.user_agent)}`)
    if (r.actor_name) lines.push(`操作した人: ${r.actor_name}`)
    return { key: `l${x.id}`, src: 'l', id: x.id, at: x.at, category: 'login', category_label: AUDIT_CATEGORY_LABELS.login,
      label: `${LOGIN_EVENT_LABEL[r.event_type] || r.event_type}（${LOGIN_RESULT_LABEL[r.result] || r.result}）`,
      actor: r.user_name ? String(r.user_name) : (r.user_code ? `ID ${r.user_code}（該当なし）` : '（不明）'), actor_role: roleLabel(r.user_role), hq: false,
      target: null, lines, changes: [], ip: r.ip || null, failed }
  })
  const last = page[page.length - 1]
  return { items, next_cursor: more && last ? `${last.at}|${last.src}|${last.id}` : null }
}

/** 絞り込みの選択肢（種類と、操作した人＝自社の管理者） */
async function auditOptions(db: D1Database, companyId: number) {
  const users = (await db.prepare(`SELECT user_id, name, role, status FROM users WHERE company_id = ? AND role IN (SELECT value FROM json_each(?))
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, user_id`).bind(companyId, JSON.stringify(ADMIN_ROLES)).all()).results as any[]
  return {
    categories: Object.entries(AUDIT_CATEGORY_LABELS),
    actors: users.map(u => ({ user_id: u.user_id, name: u.name, role_label: roleLabel(u.role), active: u.status === 'active' })),
    page_size: AUDIT_PAGE, csv_limit: AUDIT_CSV_LIMIT, keep_days: 365,
  }
}

const CSV_HEADER = ['日時', '種類', '操作', '操作した人', 'ロール', '対象', '内容', '変わった項目', '接続元']
function csvRows(items: AuditItem[]) {
  return items.map(i => [i.at, i.category_label, i.label, i.actor, i.actor_role || '', i.target || '', i.lines.join(' / '),
    i.changes.map(ch => ch.s ? `${ch.l}: 変更あり` : `${ch.l}: ${ch.b ?? '（なし）'} → ${ch.a ?? '（なし）'}`).join(' / '), i.ip || ''])
}
async function auditCsv(db: D1Database, companyId: number, f: AuditFilter, fileBase: string) {
  const { items, next_cursor } = await loadAuditItems(db, companyId, { ...f, cursor: null }, AUDIT_CSV_LIMIT)
  const note = next_cursor ? `※ 条件に合う記録のうち、新しい${AUDIT_CSV_LIMIT.toLocaleString('ja-JP')}件を出力しています。期間を区切って、複数回に分けて出力してください` : undefined
  // 古い順に並べて出す（ほかの履歴の CSV と同じ）
  return csvResponse(`${fileBase}_${nowJST().slice(0, 10)}.csv`, toCsv(CSV_HEADER, csvRows(items.slice().reverse()), { note }),
    { 'X-Csv-Truncated': next_cursor ? '1' : '0' })
}

// =========================================================
// 管理画面（/api/admin/audit-logs*。会社管理者だけ）
// =========================================================
export const auditAdminApi = new Hono<Env>()
const auditViewOnly = requirePerm('audit_logs.view', '操作の記録は会社管理者だけが見られます', 'role_forbidden')
auditAdminApi.use('/audit-logs', auditViewOnly)
auditAdminApi.use('/audit-logs/*', auditViewOnly)
auditAdminApi.get('/audit-logs/options', async (c) => c.json(await auditOptions(c.env.DB, c.get('user').company_id)))
auditAdminApi.get('/audit-logs', async (c) => {
  const f = parseAuditFilter(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  return c.json(await loadAuditItems(c.env.DB, c.get('user').company_id, f, AUDIT_PAGE))
})
// この書き出しも、ミドルウェア（src/lib/audit-log.ts）が「操作の記録の CSV」として残す
auditAdminApi.get('/audit-logs/export', async (c) => {
  const f = parseAuditFilter(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  return auditCsv(c.env.DB, c.get('user').company_id, f, '操作の記録')
})
// 画面で作る CSV（請求前確認・ログイン案内）を書き出したことを画面から知らせる（管理画面の4ロール。1回の書き出しで1行）
auditAdminApi.post('/export-logs', async (c) => {
  const u = c.get('user')
  const b = await readJson(c)
  const label = CLIENT_EXPORT_KINDS[String(b?.kind || '')]
  if (!label) return c.json({ error: '書き出しの種類が正しくありません' }, 400)
  const rows = Number(b.rows)
  const filters: Record<string, string> = {}
  if (b.filters && typeof b.filters === 'object') {
    for (const [k, v] of Object.entries(b.filters).slice(0, 10)) if (v !== null && v !== undefined && v !== '' && typeof v !== 'object') filters[String(k).slice(0, 40)] = String(v).slice(0, 100)
  }
  const detail: Record<string, unknown> = {}
  if (typeof b.file === 'string' && b.file) detail.file = b.file.slice(0, 200)
  if (Number.isInteger(rows) && rows >= 0 && rows <= 1000000) detail.rows = rows
  if (Object.keys(filters).length) detail.filters = filters
  await auditInsertStmt(c.env.DB, { companyId: u.company_id, actorId: u.user_id, actorRole: u.role, category: 'csv', action: 'export_client', label, detail, ip: c.req.header('CF-Connecting-IP') || null }).run()
  return c.json({ ok: true })
})

// =========================================================
// 本部（/api/hq/companies/:id/audit-logs*）。見たこと・書き出したことは hq_audit_logs に残す（1ページ目と CSV のたびに1行）
// =========================================================
export const auditHqApi = new Hono<Env>()
async function hqCompany(c: any): Promise<{ company_id: number; company_code: string; company_name: string } | null> {
  const id = c.req.param('id')
  if (!/^\d+$/.test(String(id))) return null
  return c.env.DB.prepare('SELECT company_id, company_code, company_name FROM companies WHERE company_id = ?').bind(Number(id)).first()
}
function hqViewLog(c: any, action: string, companyId: number, f: AuditFilter) {
  const cond = [f.kind ? AUDIT_CATEGORY_LABELS[f.kind] : '', f.from || f.to ? `${f.from || ''}〜${f.to || ''}` : '', f.actor ? `操作した人 #${f.actor}` : ''].filter(Boolean).join('・')
  return (c.env.DB as D1Database).prepare('INSERT INTO hq_audit_logs (actor_user_id, action, company_id, target, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(c.get('user')?.user_id ?? null, action, companyId, cond || null, nowJST())
}
auditHqApi.get('/companies/:id/audit-logs/options', async (c) => {
  const co = await hqCompany(c)
  if (!co) return c.json({ error: '企業が見つかりません' }, 404)
  return c.json(await auditOptions(c.env.DB, co.company_id))
})
auditHqApi.get('/companies/:id/audit-logs', async (c) => {
  const co = await hqCompany(c)
  if (!co) return c.json({ error: '企業が見つかりません' }, 404)
  const f = parseAuditFilter(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const out = await loadAuditItems(c.env.DB, co.company_id, f, AUDIT_PAGE)
  if (!f.cursor) await hqViewLog(c, 'audit_logs.view', co.company_id, f).run().catch(e => console.log(`hq audit view log failed: ${e}`))
  return c.json(out)
})
auditHqApi.get('/companies/:id/audit-logs/export', async (c) => {
  const co = await hqCompany(c)
  if (!co) return c.json({ error: '企業が見つかりません' }, 404)
  const f = parseAuditFilter(k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const res = await auditCsv(c.env.DB, co.company_id, f, `${co.company_code}_操作の記録`)
  await hqViewLog(c, 'audit_logs.export', co.company_id, f).run().catch(e => console.log(`hq audit export log failed: ${e}`))
  return res
})
