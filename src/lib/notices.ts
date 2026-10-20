// お知らせの配信対象の判定と、スタッフ本人向けのお知らせの取得（api.ts・roster.ts で共通）
import { JSON_IN, bindJsonArray } from './d1-chunk'

// 配信対象の判定は下の SQL の条件にまとめ、一覧の「既読 x/y名」・既読状況・メールの宛先・既読率レポート・
// スタッフの一覧とホームで同じものを使う（#7）。
// 条件は n = notices、us = users、sp = staff_profiles の別名を前提にする。
//  ・登録より前に公開されたお知らせは対象外（#227）。users.created_at は UTC、published_at は JST なので +9時間して比べる。
//    仮登録から本登録した人は、仮登録の日を基準にする
//  ・案件あては、公開日の30日前以降に、その案件で確定・代打のシフトがある人（#335）。
//    昔に一度だけ入った人や、欠勤・希望（仮）のシフトしかない人は外す
//  ・配信先の案件・スタッフは notice_targets（target_ids を展開した表）を索引で引く（#370。LIKE での走査はしない）
export const NOTICE_PROJECT_LOOKBACK_DAYS = 30
const NOTICE_PROJECT_SHIFT_SQL = `sh.staff_id = sp.staff_id AND sh.project_id = nt.target_id AND sh.company_id = n.company_id
  AND sh.status IN ('confirmed', 'substitute') AND sh.work_date >= date(n.published_at, '-${NOTICE_PROJECT_LOOKBACK_DAYS} days')`
export const NOTICE_TARGET_SQL = `datetime(us.created_at, '+9 hours') <= n.published_at
  AND (n.target_type = 'all'
    OR (n.target_type = 'staff' AND EXISTS (SELECT 1 FROM notice_targets nt
         WHERE nt.notice_id = n.notice_id AND nt.target_type = 'staff' AND nt.target_id = sp.staff_id))
    OR (n.target_type = 'project' AND EXISTS (SELECT 1 FROM notice_targets nt JOIN shifts sh ON ${NOTICE_PROJECT_SHIFT_SQL}
         WHERE nt.notice_id = n.notice_id AND nt.target_type = 'project')))`

// 本人あての案件名（案件あてのお知らせで、本人が対象になっている案件だけ。#455）
const NOTICE_MY_PROJECT_NAMES_SQL = `CASE WHEN n.target_type = 'project' THEN (SELECT group_concat(p.project_name, '、')
    FROM notice_targets nt JOIN projects p ON p.project_id = nt.target_id AND p.company_id = n.company_id
    WHERE nt.notice_id = n.notice_id AND nt.target_type = 'project'
      AND EXISTS (SELECT 1 FROM shifts sh WHERE ${NOTICE_PROJECT_SHIFT_SQL})) END`

// 公開中のお知らせ（#291 #157）: 配信済みと、配信予定日時を過ぎた予約。下書き・予約前・取り消したものは除く。
// 予約は時刻で見せ始め、メールは定期処理（publishDueNotices）で送って published にする（定期処理の間隔に関係なく時刻どおりに見えるように）。
// published_at は日本時間の 'YYYY-MM-DD HH:MM:SS'
export const NOTICE_LIVE_SQL = `(n.status = 'published' OR (n.status = 'scheduled' AND n.published_at <= datetime('now', '+9 hours')))`
// 掲載期限を過ぎたもの（#294。ホーム・一覧・未読の数から外し、一覧の「掲載終了」に出す。既読率レポートは公開日の基準のまま数える）
export const NOTICE_EXPIRED_SQL = `(n.expires_at IS NOT NULL AND n.expires_at < datetime('now', '+9 hours'))`

// 確認が要らないお知らせ: 公開から2年たって既読の記録を削除したもの（#245。未読に戻さない）
const NOTICE_NO_CONFIRM_SQL = `(n.reads_purged_at IS NOT NULL)`
const NOTICE_IS_READ_SQL = `(${NOTICE_NO_CONFIRM_SQL} OR EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = us.user_id))`
// まとめて確認できないお知らせ（既読確認が必須・緊急のもの。1件ずつ開いて確認してもらう #553）
export const NOTICE_CONFIRM_ONE_BY_ONE_SQL = `(n.read_required = 1 OR n.importance = 'urgent')`

export type StaffNoticeOptions = {
  id?: number
  unreadOnly?: boolean
  limit?: number
  offset?: number
  // 'unread_first': 未読（必須・緊急を先）→ 既読の順（お知らせ一覧）。'recent': 新しい順（ホーム）
  order?: 'unread_first' | 'recent'
  ids?: number[]
  // 掲載期限を過ぎたものの扱い（#294）。既定は、id を指定したら含め、それ以外は除く。'only' は掲載終了の一覧
  expired?: 'include' | 'exclude' | 'only'
}

// スタッフ本人（users.user_id）あてのお知らせ。配信先の ID（target_ids）や作成者は返さない
export async function loadStaffNotices(db: D1Database, userId: number, opts: StaffNoticeOptions = {}) {
  const where: string[] = []
  const binds: any[] = [userId]
  if (opts.id != null) { where.push('n.notice_id = ?'); binds.push(opts.id) }
  if (opts.ids) { where.push(`n.notice_id IN ${JSON_IN}`); binds.push(bindJsonArray(opts.ids)) }
  if (opts.unreadOnly) where.push(`NOT ${NOTICE_IS_READ_SQL}`)
  const expired = opts.expired ?? (opts.id != null ? 'include' : 'exclude')
  if (expired === 'exclude') where.push(`NOT ${NOTICE_EXPIRED_SQL}`)
  if (expired === 'only') where.push(NOTICE_EXPIRED_SQL)
  const order = opts.order === 'recent'
    ? 'n.published_at DESC, n.notice_id DESC'
    : `is_read, CASE WHEN ${NOTICE_CONFIRM_ONE_BY_ONE_SQL} THEN 0 ELSE 1 END, n.published_at DESC, n.notice_id DESC`
  binds.push(opts.limit ?? 50, opts.offset ?? 0)
  const rows = (await db.prepare(`
    SELECT n.notice_id, n.title, n.body, n.target_type, n.importance, n.read_required, n.published_at,
      ${NOTICE_IS_READ_SQL} AS is_read, ${NOTICE_NO_CONFIRM_SQL} AS no_confirm,
      (SELECT datetime(r.read_at, '+9 hours') FROM notice_reads r WHERE r.notice_id = n.notice_id AND r.user_id = us.user_id) AS read_at,
      ${NOTICE_MY_PROJECT_NAMES_SQL} AS project_names,
      n.expires_at, ${NOTICE_EXPIRED_SQL} AS expired, n.updated_at, n.response_options, n.response_comment,
      (SELECT COUNT(*) FROM notice_attachments a WHERE a.notice_id = n.notice_id) AS attachment_count,
      (SELECT json_object('choice', nr.choice, 'comment', nr.comment, 'answered_at', COALESCE(nr.updated_at, nr.answered_at))
        FROM notice_responses nr WHERE nr.notice_id = n.notice_id AND nr.user_id = us.user_id) AS my_response
    FROM users us JOIN staff_profiles sp ON sp.user_id = us.user_id JOIN notices n ON n.company_id = us.company_id
    WHERE us.user_id = ? AND ${NOTICE_LIVE_SQL} AND ${NOTICE_TARGET_SQL} ${where.map(w => 'AND ' + w).join(' ')}
    ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds).all()).results as any[]
  return rows.map(r => ({ ...r, is_read: r.is_read ? 1 : 0, no_confirm: r.no_confirm ? 1 : 0, read_required: r.read_required ? 1 : 0,
    expired: r.expired ? 1 : 0, response_options: parseResponseOptions(r.response_options), response_comment: r.response_comment ? 1 : 0,
    my_response: r.my_response ? JSON.parse(r.my_response) : null }))
}

// 回答の選択肢（JSON の文字列の配列）を読む。形が崩れていれば空にする（#554）
export function parseResponseOptions(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []
  } catch { return [] }
}

// ユーザー行（同じ人の各企業の行）ごとの、未読のお知らせの件数（企業切替の未読表示 #203、一覧の未読数）
export async function countUnreadNotices(db: D1Database, userIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!userIds.length) return out
  const rows = (await db.prepare(`
    SELECT us.user_id, COUNT(n.notice_id) AS n
    FROM users us JOIN staff_profiles sp ON sp.user_id = us.user_id JOIN notices n ON n.company_id = us.company_id
    WHERE us.user_id IN ${JSON_IN} AND ${NOTICE_LIVE_SQL} AND NOT ${NOTICE_EXPIRED_SQL} AND ${NOTICE_TARGET_SQL} AND NOT ${NOTICE_IS_READ_SQL}
    GROUP BY us.user_id`).bind(bindJsonArray(userIds)).all()).results as { user_id: number; n: number }[]
  for (const r of rows) out.set(r.user_id, r.n)
  return out
}
