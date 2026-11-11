import { JSON_IN, bindJsonArray } from './d1-chunk'

// =========================================================
// 日報のコメント（利用者の要望 11/10。#9965。migrations/0107_daily_report_comments.sql）
// 日報1件に何件でも付けられる。編集・削除は書いた本人だけ（api.ts で確かめる）。既読（read_at）はコメントごと。
// daily_reports の旧列（manager_comment・manager_comment_by・manager_comment_at・comment_read_at）には、
// 最新のコメントと既読を写し続ける（legacyCommentSyncStmt。古いコードに戻しても、今までどおりの表示になるように）
// =========================================================

export const REPORT_COMMENT_MAX = 2000

export type ReportComment = {
  comment_id: number; daily_report_id: number; body: string; author_user_id: number | null; author_name: string | null
  created_at: string; updated_at: string | null; read_at: string | null
}

/** 日報ごとのコメント（古い順）。companyId を渡すと、その会社のコメントだけ */
export async function loadReportComments(db: D1Database, reportIds: number[], companyId?: number): Promise<Map<number, ReportComment[]>> {
  const out = new Map<number, ReportComment[]>()
  if (!reportIds.length) return out
  const rows = (await db.prepare(`SELECT c.comment_id, c.daily_report_id, c.body, c.author_user_id, u.name AS author_name, c.created_at, c.updated_at, c.read_at
    FROM daily_report_comments c LEFT JOIN users u ON u.user_id = c.author_user_id
    WHERE c.daily_report_id IN ${JSON_IN}${companyId != null ? ' AND c.company_id = ?' : ''} ORDER BY c.daily_report_id, c.comment_id`)
    .bind(bindJsonArray(reportIds), ...(companyId != null ? [companyId] : [])).all()).results as any[]
  for (const r of rows) {
    const id = Number(r.daily_report_id)
    const list = out.get(id) || []
    list.push({ comment_id: Number(r.comment_id), daily_report_id: id, body: String(r.body ?? ''), author_user_id: r.author_user_id == null ? null : Number(r.author_user_id),
      author_name: r.author_name ?? null, created_at: r.created_at, updated_at: r.updated_at ?? null, read_at: r.read_at ?? null })
    out.set(id, list)
  }
  return out
}

/** スタッフに返す形（書いた人の ID は出さない） */
export function staffCommentView(c: ReportComment) {
  return { comment_id: c.comment_id, body: c.body, author_name: c.author_name, created_at: c.created_at, updated_at: c.updated_at, read_at: c.read_at }
}

// 日報の旧列に、最新のコメント（直した日時があればその日時）と既読を写す。
// comment_read_at は、未読のコメントがあれば NULL、すべて既読なら最後に開いた日時（コメントが無ければ NULL）
const LATEST = (col: string) => `(SELECT ${col} FROM daily_report_comments c WHERE c.daily_report_id = daily_reports.daily_report_id ORDER BY c.comment_id DESC LIMIT 1)`
export function legacyCommentSyncStmt(db: D1Database, reportId: number): D1PreparedStatement {
  return db.prepare(`UPDATE daily_reports SET manager_comment = ${LATEST('c.body')}, manager_comment_by = ${LATEST('c.author_user_id')},
      manager_comment_at = ${LATEST('COALESCE(c.updated_at, c.created_at)')},
      comment_read_at = CASE WHEN EXISTS (SELECT 1 FROM daily_report_comments c WHERE c.daily_report_id = daily_reports.daily_report_id AND c.read_at IS NULL) THEN NULL
        ELSE (SELECT MAX(c.read_at) FROM daily_report_comments c WHERE c.daily_report_id = daily_reports.daily_report_id) END
    WHERE daily_report_id = ?`).bind(reportId)
}
// 既読だけを写す（スタッフがコメントを開いたとき。最新のコメントの本文などは変わらない）
export function legacyCommentReadSyncStmt(db: D1Database, reportId: number): D1PreparedStatement {
  return db.prepare(`UPDATE daily_reports SET
      comment_read_at = CASE WHEN EXISTS (SELECT 1 FROM daily_report_comments c WHERE c.daily_report_id = daily_reports.daily_report_id AND c.read_at IS NULL) THEN NULL
        ELSE (SELECT MAX(c.read_at) FROM daily_report_comments c WHERE c.daily_report_id = daily_reports.daily_report_id) END
    WHERE daily_report_id = ?`).bind(reportId)
}

/** コメントの本文を確かめる。前後の空白は除く。空欄は null。形が違う・長すぎるときは error */
export function parseCommentBody(v: unknown): { body: string | null } | { error: string } {
  if (v !== null && v !== undefined && typeof v !== 'string') return { error: 'コメントの形式が正しくありません' }
  const body = typeof v === 'string' && v.trim() ? v.trim() : null
  if (body && body.length > REPORT_COMMENT_MAX) return { error: `コメントは${REPORT_COMMENT_MAX}文字以内で入力してください` }
  return { body }
}
