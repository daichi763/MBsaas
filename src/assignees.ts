// =========================================================
// クライアント・協力会社の社内担当者（Sprint 17 #9910。w17-masters。migrations/0100）
// - 主担当1人＋副担当（何人でも）を、自社の管理者のアカウント（管理画面に入れる人）から選ぶ
// - 表は counterparty_assignees（target_type = 'client' | 'partner'、target_id = client_id | affiliation_id）
// - アカウントを止めた・消したときも行は残し、画面で「担当から外れた」と出す（active = false）。編集して保存すると外れる
// - 保存は api.ts（クライアント）・roster.ts（協力会社）の保存と同じ batch で行う（assigneeSaveStmts）
// =========================================================
import { Hono } from 'hono'
import { nowJST } from './lib/time'
import { ADMIN_ROLES } from './lib/permissions'

type Env = { Bindings: { DB: D1Database }; Variables: { user: any } }
export type AssigneeType = 'client' | 'partner'
export type Assignee = { user_id: number; name: string | null; user_code: string | null; role: string | null; is_primary: boolean; active: boolean }
export type AssigneeInput = { main: number | null; subs: number[] }

/** 担当にできるアカウントの権限（管理画面に入れる人。本部 system_admin・スタッフは含めない） */
const ASSIGNABLE_ROLES = ADMIN_ROLES
const ROLES_SQL = ASSIGNABLE_ROLES.map(r => `'${r}'`).join(',')
const MAX_SUBS = 30


/** 担当者の一覧の問い合わせ（id を渡せば1社分）。batch に入れられるよう文だけを返す */
export function assigneeListStmt(db: D1Database, companyId: number, type: AssigneeType, id?: number): D1PreparedStatement {
  return db.prepare(`SELECT a.target_id, a.user_id, a.is_primary, u.name, u.user_code, u.role,
      CASE WHEN u.status = 'active' AND u.role IN (${ROLES_SQL}) THEN 1 ELSE 0 END AS active
    FROM counterparty_assignees a LEFT JOIN users u ON u.user_id = a.user_id AND u.company_id = a.company_id
    WHERE a.company_id = ? AND a.target_type = ?${id != null ? ' AND a.target_id = ?' : ''}
    ORDER BY a.target_id, a.is_primary DESC, u.name, a.user_id`).bind(...[companyId, type, ...(id != null ? [id] : [])])
}
/** 問い合わせの結果を会社ごとにまとめる（主担当が先頭） */
export function groupAssignees(rows: any[]): Map<number, Assignee[]> {
  const m = new Map<number, Assignee[]>()
  for (const r of rows || []) {
    const list = m.get(Number(r.target_id)) || []
    list.push({ user_id: Number(r.user_id), name: r.name ?? null, user_code: r.user_code ?? null, role: r.role ?? null, is_primary: !!r.is_primary, active: !!r.active })
    m.set(Number(r.target_id), list)
  }
  return m
}
export async function loadAssignees(db: D1Database, companyId: number, type: AssigneeType, id: number): Promise<Assignee[]> {
  return groupAssignees(((await assigneeListStmt(db, companyId, type, id).all()).results || []) as any[]).get(id) || []
}

/**
 * 送られた担当者（{ main_user_id, sub_user_ids }）を確かめる。送られていなければ undefined（今の担当を変えない）。
 * 新しく選べるのは、自社の利用中の管理者のアカウントだけ。主担当は副担当から外す
 */
export async function parseAssignees(db: D1Database, companyId: number, raw: any): Promise<{ value?: AssigneeInput; error?: string }> {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: '社内担当者の値が正しくありません' }
  const toId = (v: any) => (v === null || v === undefined || v === '' ? null : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN)
  const main = toId(raw.main_user_id)
  if (Number.isNaN(main)) return { error: '主担当の値が正しくありません' }
  const subsRaw = raw.sub_user_ids === undefined || raw.sub_user_ids === null ? [] : raw.sub_user_ids
  if (!Array.isArray(subsRaw)) return { error: '副担当の値が正しくありません' }
  const subs: number[] = []
  for (const s of subsRaw) {
    const id = toId(s)
    if (id === null) continue
    if (Number.isNaN(id)) return { error: '副担当の値が正しくありません' }
    if (id !== main && !subs.includes(id)) subs.push(id)
  }
  if (subs.length > MAX_SUBS) return { error: `副担当は${MAX_SUBS}人までです` }
  const ids = [...(main ? [main] : []), ...subs]
  if (ids.length) {
    const ok = new Set(((await db.prepare(`SELECT user_id FROM users WHERE company_id = ? AND status = 'active' AND role IN (${ROLES_SQL})
      AND user_id IN (SELECT value FROM json_each(?))`).bind(companyId, JSON.stringify(ids)).all()).results as any[]).map(r => Number(r.user_id)))
    if (ids.some(id => !ok.has(id))) return { error: '社内担当者には、自社の利用中の管理者のアカウントを選んでください（停止中のアカウントは選べません）' }
  }
  return { value: { main: main as number | null, subs } }
}

/** 担当者を入れ替える文（今の担当を消して入れ直す）。保存の batch に入れる */
export function assigneeSaveStmts(db: D1Database, companyId: number, type: AssigneeType, targetId: number, v: AssigneeInput, actorId: number | null): D1PreparedStatement[] {
  const now = nowJST()
  const stmts = [assigneeDeleteStmt(db, companyId, type, targetId)]
  if (v.main) stmts.push(db.prepare(`INSERT INTO counterparty_assignees (company_id, target_type, target_id, user_id, is_primary, created_by, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).bind(companyId, type, targetId, v.main, actorId, now))
  if (v.subs.length) stmts.push(db.prepare(`INSERT OR IGNORE INTO counterparty_assignees (company_id, target_type, target_id, user_id, is_primary, created_by, created_at)
    SELECT ?, ?, ?, CAST(value AS INTEGER), 0, ?, ? FROM json_each(?)`).bind(companyId, type, targetId, actorId, now, JSON.stringify(v.subs)))
  return stmts
}
export function assigneeDeleteStmt(db: D1Database, companyId: number, type: AssigneeType, targetId: number): D1PreparedStatement {
  return db.prepare('DELETE FROM counterparty_assignees WHERE company_id = ? AND target_type = ? AND target_id = ?').bind(companyId, type, targetId)
}
/**
 * 協力会社の統合（roster.ts）: 統合元の担当者を統合先に移す。統合先にすでにいる人は移さない。
 * 主担当は、統合先に主担当がいないときだけ主担当のまま移す（ほかは副担当にする）。移せなかった行は消す
 */
export function assigneeMergeStmts(db: D1Database, companyId: number, fromId: number, intoId: number): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE OR IGNORE counterparty_assignees SET target_id = ?1,
        is_primary = CASE WHEN is_primary = 1 AND NOT EXISTS (SELECT 1 FROM counterparty_assignees x WHERE x.target_type = 'partner' AND x.target_id = ?1 AND x.is_primary = 1) THEN 1 ELSE 0 END
      WHERE company_id = ?2 AND target_type = 'partner' AND target_id = ?3`).bind(intoId, companyId, fromId),
    assigneeDeleteStmt(db, companyId, 'partner', fromId),
  ]
}

// ---------- API（/api/admin/assignees。管理画面に入れる人なら誰でも見られる。権限の確認は api.ts の /admin/* ミドルウェア） ----------
export const assigneesApi = new Hono<Env>()
// 担当に選べるアカウント（自社の利用中の管理者）。同姓の人を見分けられるよう ID と権限も返す
assigneesApi.get('/assignees/options', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT user_id, name, user_code, role FROM users
    WHERE company_id = ? AND status = 'active' AND role IN (${ROLES_SQL}) ORDER BY name, user_id`).bind(u.company_id).all()).results
  return c.json({ accounts: rows, me: u.user_id })
})
// アカウントごとの「担当している会社」（主・副の区別つき）。?user_id= で1人に絞る。
// 統合済み・消した協力会社とクライアントの行は出さない
assigneesApi.get('/assignees', async (c) => {
  const u = c.get('user')
  const uid = Number(c.req.query('user_id'))
  const one = Number.isInteger(uid) && uid > 0
  const rows = (await c.env.DB.prepare(`SELECT a.target_type, a.target_id, a.user_id, a.is_primary,
      CASE a.target_type WHEN 'client' THEN cl.client_name ELSE sa.affiliation_name END AS target_name
    FROM counterparty_assignees a
    LEFT JOIN clients cl ON a.target_type = 'client' AND cl.client_id = a.target_id AND cl.company_id = a.company_id
    LEFT JOIN staff_affiliations sa ON a.target_type = 'partner' AND sa.affiliation_id = a.target_id AND sa.company_id = a.company_id AND sa.merged_into_id IS NULL
    WHERE a.company_id = ?${one ? ' AND a.user_id = ?' : ''}
      AND (cl.client_id IS NOT NULL OR sa.affiliation_id IS NOT NULL)
    ORDER BY a.user_id, a.is_primary DESC, a.target_type, target_name`).bind(...[u.company_id, ...(one ? [uid] : [])]).all()).results as any[]
  return c.json({ assignments: rows.map(r => ({ ...r, is_primary: !!r.is_primary })) })
})
