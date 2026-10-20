import { REPORT_TYPES } from '../report-settings'

// データ保存期間ポリシーに基づく定期削除サービス。
//
// 対象と基準:
//   daily_reports              : work_date から3年
//   user_notifications         : created_at から2年（既存の notice_reads の保持期間に合わせる）
//   email_logs                 : created_at から1年（宛先のメールアドレスを含む送信記録。#240）
//   operation_logs             : created_at から7年（シフト・精算の操作履歴。#159）。担当スタッフの退職後7年でも、その人の分を消す
//   打刻修正申請・その操作履歴・通知メールの送信状態・報告設定（スタッフ別）とその変更履歴
//                              : 勤怠と同じく、スタッフの退職日から7年（docs/spec_attendance_correction.md 8章）
//   notice_read_staff_reports  : スタッフ別の既読率（人事評価の参考資料）も退職後7年（#437）
//   attendance_reports / shifts
//   evaluations / follow_logs
//   consultations / R2写真
//   報告用URLのトークン       : スタッフの退職日(users.retired_at)から7年
//   従業員データ（employee_records: 口座・住所・扶養・緊急連絡先・給与・保険番号）と過去の雇用期間
//   履歴書など（staff_documents）・入社時書類（employee_documents）と R2 のファイル
//   企業間チャット（roster_comments・既読位置）と連携の同意履歴（roster_consents）
//                              : 同じく退職後7年（#193 #228）。チャットのスレッドは稼働先の連携行の単位なので、
//                                連携行と所属元の行（source_staff_id / root_staff_id）のどちらかが対象になったら消す。
//                                同意履歴は連携行の単位で、連携行が対象になったら消す
//   本人情報（users・staff_profiles）: 退職後7年で匿名化する（#480）。請求の集計などから参照されるため行は残し、
//                                氏名を「退職者#staff_id」にして連絡先・生年月日・経歴・メモなどを消す。
//                                済んだ人は anonymized_at を付け、次の対象に選び直さない
//   スタッフに紐づく応募（recruit_applications と応募した枠）: 退職後7年で削除する（#350）
//   人材提案（board_proposals）  : 提案したスタッフ・取り込んだスタッフが退職後7年になったら、スナップショット（経歴など）・
//                                開示した氏名・コメント・上流の経路を消す（行は件数のために残す。#350）
//
// 在職中でも保存期間で消すもの（runRetentionCleanup の stages に 'in_service' を渡したとき。期間は本部画面で変えられる）:
//   入店などの位置情報・端末情報と写真（attendance_reports の緯度経度・住所・端末・photo_key と R2）
//                              : 報告から1年（#420）。勤怠の時刻・種別の行は残す。写真は retention_pending_r2 に控え、
//                                退職後7年の処理の再試行（毎日）で R2 から消す
//   相談（consultations）       : 対応済み（done）のものを相談の日から3年（#511）
//   フォロー記録（follow_logs）  : 完了（done）したものを完了日（なければ作成日）から3年（#511）
//   決着した人材提案            : 見送り・取り下げから180日でスナップショットなどを消す（採用に至らなかった応募と同じ。#350）
//   雇用終了の従業員データ      : 区分変更で雇用終了にした人（自社雇用に戻っていない人）の employee_records・入社時書類（R2 も）を、
//                                雇用終了日から7年で削除する。過去の雇用期間（employment_periods）も終了日から7年で消す（#425）
//
// 削除の保留（#543）: staff_profiles.retention_hold_at・companies.retention_hold_at が入っているスタッフ・企業のデータは、
//   上のどの削除（日報の3年を含む）でも消さない。本部画面で設定・解除し、解除すると退職後7年の猶予をやり直す
//
// 退職者の安全策（#5 #50 #51）:
//   - 退職日が NULL（未設定・不明）のスタッフのデータは絶対に削除しない。
//   - 「退職日と最終稼働日の遅い方から7年」で判定する。退職日より後にシフトがある人は、
//     退職日の入力誤りの可能性があるため対象から外す（本部画面に「対象外」として出す）。
//   - 初めて対象になった人には猶予日数（RETENTION_GRACE_DAYS）を置き、その間は本部画面に
//     「次回削除予定」として出すだけにする。退職日を変えると猶予をやり直す。
//   - 1回のCronで処理する人数には上限があり、まだデータが残っている人だけを、
//     最後に処理を試みた日時の古い順に選ぶ（毎回同じ人ばかりにならないようにする）。
//   - R2 の写真・書類は D1 の削除が成功してから消す。キーは D1 の削除と同じ batch で retention_pending_r2 に
//     控えておき、R2 の削除に失敗したものは次回のCronで再試行する。
//   - 失敗したときは、どのスタッフで何が起きたかを retention_logs.error_message に残す（#234）。
//   - R2 は最大1000キーずつまとめて消し、1回のCronで消すファイル数に上限を置く。超えた分は retention_pending_r2 に
//     残して翌日に回し、上限に達したらそれ以降の人も次回に回す（#419）。
//
// 期限切れ・使用済みのトークン（パスワード再設定・報告用URL）は、データ保持とは別の定期処理（purgeExpiredTokens）で消す（#397）。

const DAILY_REPORTS_YEARS = 3
const RETIRED_YEARS = 7
const DAILY_REPORTS_BATCH = 500
const DAILY_REPORTS_MAX_BATCHES = 20
const STAFF_BATCH = 20 // 1回のCronで処理する退職スタッフの上限人数
const NOTIFICATIONS_YEARS = 2
const NOTIFICATIONS_BATCH = 500
const NOTIFICATIONS_MAX_BATCHES = 20
const EMAIL_LOGS_YEARS = 1
const OPERATION_LOGS_YEARS = 7
const R2_DELETE_CHUNK = 1000 // R2 の delete に1回で渡すキーの数（R2 の上限）
const R2_DELETE_BUDGET = 5000 // 1回のCronで消す R2 の写真・書類の上限（超えた分は翌日に回す。#419）
const DRY_RUN_STAFF_LIMIT = 300 // dry-run で一覧に出す対象スタッフの上限
/** 初めて削除対象になってから実際に削除するまでの猶予日数 */
export const RETENTION_GRACE_DAYS = 7
// 退職スタッフに紐づく打刻修正・報告設定のデータ（勤怠と同じ「退職後7年」）
const RETIRED_EXTRA_TARGETS = ['attendance_corrections', 'attendance_correction_events', 'notification_emails', 'report_setting_logs', 'project_staff_report_settings',
  'notice_read_staff_reports']
// 退職スタッフの人事データ・書類・企業間チャット・同意履歴と、本人情報の匿名化（#193 #228 #480）
const RETIRED_PERSONAL_TARGETS = ['employee_records', 'employment_periods', 'staff_documents', 'employee_documents', 'r2_documents',
  'roster_comments', 'roster_comment_reads', 'roster_consents', 'recruit_applications', 'recruit_application_items', 'board_proposals', 'anonymized_staff']
// retired_staff は人数（対象の人・処理できた人・失敗した人）。スタッフ単位の失敗の理由はここに残す（#234）
// retired_staff_deferred・r2_pending は、上限に達して翌日に回した人数と R2 のファイル数（#419）
const RETIRED_TARGETS = ['retired_staff', 'attendance_reports', 'shifts', 'evaluations', 'follow_logs', 'consultations', 'shift_report_tokens', 'r2_photos',
  ...RETIRED_EXTRA_TARGETS, ...RETIRED_PERSONAL_TARGETS, 'retired_staff_deferred', 'r2_pending']
// 件数の単位が行数でない対象（実行ログの合計に含めない）
export const RETENTION_NON_ROW_TARGETS = ['retired_staff', 'retired_staff_deferred', 'r2_pending']
// トークンの削除（purgeExpiredTokens）が retention_logs に残す対象。RETENTION_ENABLED に関係なく実削除で記録する
export const RETENTION_TOKEN_TARGETS = ['password_reset_tokens', 'expired_report_tokens'] as const
// 本部画面の保守（紐づかない写真の削除。#533）が retention_logs に残す対象。データ保持の直近の実行には数えない
export const RETENTION_MAINTENANCE_TARGETS = ['orphan_photos'] as const
const MAX_ERRORS_PER_TARGET = 3 // error_message に残す失敗の理由の件数（それ以上は件数だけ）
// 匿名化で消す staff_profiles の個人情報の列（所属区分・連携の情報・評価の点数は集計に使うので残す）
const ANONYMIZE_PROFILE_COLUMNS = ['career', 'skills', 'work_area', 'age_group', 'memo', 'affiliation_contact', 'kana', 'gender', 'date_of_birth',
  'nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from', 'site_evaluation', 'work_memo', 'career_rows', 'pr_points',
  'remarks', 'unverified_email']

// 人材提案の匿名化で消す列（#350）。snapshot は NOT NULL なので空の JSON にする
const ANONYMIZE_PROPOSAL_SET = `snapshot = '{}', disclosed = NULL, comment = NULL, upstream_chain = NULL, consent_note = NULL, upstream_consent_note = NULL`

// ============ 削除の保留（#543） ============
// 保留中のスタッフ・企業。どの定期削除でも、この人・企業のデータは消さない
const HELD_STAFF_SQL = 'SELECT staff_id FROM staff_profiles WHERE retention_hold_at IS NOT NULL'
const HELD_COMPANY_SQL = 'SELECT company_id FROM companies WHERE retention_hold_at IS NOT NULL'
/** 保留中でない行の条件（staffCol・companyCol はその表の列。どちらも NULL にならない列を渡す） */
function notHeldSql(staffCol: string, companyCol: string): string {
  return `${staffCol} NOT IN (${HELD_STAFF_SQL}) AND ${companyCol} NOT IN (${HELD_COMPANY_SQL})`
}

// ============ 在職中の保存期間の設定（#420 #511 #350） ============
// retention_settings に行がなければ既定値を使う。範囲外の値は保存させない（本部画面の PUT で確かめる）
export const RETENTION_SETTING_DEFS = {
  location_photo_days: { label: '入店などの位置情報・端末情報と写真（報告から・日）', def: 365, min: 90, max: 2555 },
  consultation_years: { label: '対応済みの相談（相談の日から・年）', def: 3, min: 1, max: 7 },
  follow_log_years: { label: '完了したフォロー記録（完了日から・年）', def: 3, min: 1, max: 7 },
  proposal_days: { label: '見送り・取り下げになった人材提案の経歴・氏名（決着から・日）', def: 180, min: 30, max: 2555 },
} as const
export type RetentionSettingKey = keyof typeof RETENTION_SETTING_DEFS
export type RetentionSettings = Record<RetentionSettingKey, number>

export async function getRetentionSettings(db: D1Database): Promise<RetentionSettings> {
  const out = Object.fromEntries(Object.entries(RETENTION_SETTING_DEFS).map(([k, d]) => [k, d.def])) as RetentionSettings
  const rows = (await db.prepare('SELECT key, value FROM retention_settings').all()).results as { key: string; value: number }[]
  for (const r of rows) {
    const d = (RETENTION_SETTING_DEFS as Record<string, { min: number; max: number }>)[r.key]
    const v = Number(r.value)
    if (d && Number.isInteger(v) && v >= d.min && v <= d.max) out[r.key as RetentionSettingKey] = v
  }
  return out
}

function nowJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}
function todayJST(): string {
  return nowJST().slice(0, 10)
}
function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
function isValidYmd(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

// ============ 退職日の検証（#5 #34） ============
/**
 * 退職日が効力を持つか（退職扱いにしてログインを止めるか）。
 * 退職日の当日までは在籍（ログイン可）とし、翌日から退職とする。今日以降の日付は「退職予定」。
 */
export function isRetirementEffective(retiredAt: string, today: string = todayJST()): boolean {
  return retiredAt < today
}

export type RetiredAtCheck =
  | { ok: true; value: string | null; scheduled: boolean }
  | { ok: false; error: string; confirm?: boolean }

/**
 * 退職日の入力を確認する。
 *  - 空なら null（退職日を消す）
 *  - YYYY-MM-DD の実在する日付であること
 *  - 次の場合は誤入力のおそれがあるので確認（confirmed=true で送り直し）を求める:
 *      7年以上前（保存すると定期削除の対象になる）／1年以上前／入社日より前／退職日より後にシフトがある
 *  - 今日以降の日付は退職予定（scheduled=true）
 */
export function validateRetiredAt(
  v: unknown,
  opts: { today?: string; confirmed?: boolean; hireDate?: string | null; lastWorkDate?: string | null } = {},
): RetiredAtCheck {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null, scheduled: false }
  const value = typeof v === 'string' ? v.trim() : ''
  if (!isValidYmd(value)) return { ok: false, error: '退職日は YYYY-MM-DD 形式の正しい日付で入力してください' }
  const today = opts.today || todayJST()
  if (!opts.confirmed) {
    const [y, m, d] = today.split('-')
    const yearsAgo = (n: number) => `${Number(y) - n}-${m}-${d}`
    if (value <= yearsAgo(RETIRED_YEARS)) {
      return { ok: false, confirm: true, error: `退職日 ${value} は${RETIRED_YEARS}年以上前の日付です。保存すると定期削除の対象になり、猶予期間（${RETENTION_GRACE_DAYS}日）の後に、このスタッフの出退勤記録・シフト・写真・評価・相談・従業員データ・書類などが元に戻せない形で削除され、氏名・連絡先などの本人情報は匿名化されます。日付に誤りがないか確認してください。` }
    }
    if (value < yearsAgo(1)) return { ok: false, confirm: true, error: `退職日 ${value} は1年以上前の日付です。日付に誤りがないか確認してください。` }
    if (opts.hireDate && value < String(opts.hireDate).slice(0, 10)) {
      return { ok: false, confirm: true, error: `退職日 ${value} が入社日 ${String(opts.hireDate).slice(0, 10)} より前です。日付に誤りがないか確認してください。` }
    }
    if (opts.lastWorkDate && value < String(opts.lastWorkDate).slice(0, 10)) {
      return { ok: false, confirm: true, error: `退職日 ${value} より後の ${String(opts.lastWorkDate).slice(0, 10)} にシフトがあります。日付に誤りがないか、シフトが残っていないか確認してください。` }
    }
  }
  return { ok: true, value, scheduled: !isRetirementEffective(value, today) }
}

/**
 * 退職予定日を過ぎたスタッフを退職（ログイン停止）に切り替える（毎日の cron から呼ぶ。#34）。
 * 退職日の当日までは在籍とし、翌日に切り替える。あわせてその人のセッションを削除する。
 */
export async function applyDueRetirements(db: D1Database): Promise<number> {
  const due = `SELECT user_id FROM users WHERE retired_at IS NOT NULL AND length(retired_at) >= 10 AND retired_at < ? AND status = 'active'
    AND user_id IN (SELECT user_id FROM staff_profiles)`
  const today = todayJST()
  const r = await db.batch([
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${due})`).bind(today),
    db.prepare(`UPDATE staff_profiles SET employment_status = 'retired' WHERE user_id IN (${due})`).bind(today),
    db.prepare(`UPDATE users SET status = 'suspended' WHERE user_id IN (${due})`).bind(today),
  ])
  return r[2].meta.changes || 0
}

// ============ 定期削除の対象（退職後7年） ============
// 対象の退職スタッフを選ぶサブクエリ（バインド: cutoff 1個）。
// 退職日より後のシフトがある人は外すので、残る人の最終稼働日は退職日以前になり、
// 「退職日と最終稼働日の遅い方から7年」＝「退職日から7年」になる。
// 退職日（sp・u を参照する）。他社連携の行（linked_external）で自分の行に退職日がなければ、雇用元の行の退職日を使う（#127）。
// 連携行には所属元の退職日を伝えている（roster.ts の propagateRetirementStmts・0041 の移行）が、伝わっていない行も対象にする
const STAFF_RETIRED_AT_SQL = `COALESCE(u.retired_at, CASE WHEN sp.affiliation_type = 'linked_external' THEN (SELECT ru.retired_at FROM staff_profiles r
    JOIN users ru ON ru.user_id = r.user_id WHERE r.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)) END)`
// 削除の保留中（本人か会社。#543）の人は対象にしない（猶予の印も外れ、解除後に猶予をやり直す）
const ELIGIBLE_STAFF_SQL = `SELECT x.staff_id FROM (SELECT sp.staff_id, sp.company_id, sp.retention_hold_at AS hold_at, ${STAFF_RETIRED_AT_SQL} AS retired_at
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id) x
  WHERE x.retired_at IS NOT NULL AND length(x.retired_at) >= 10 AND x.retired_at <= ?
    AND x.hold_at IS NULL AND NOT EXISTS (SELECT 1 FROM companies hc WHERE hc.company_id = x.company_id AND hc.retention_hold_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = x.staff_id AND s.work_date > x.retired_at)`
// その人を所属元とする連携行（企業間チャットのスレッドの単位）。多段連携の先の行も root_staff_id で含める
function linkedRowsOf(staffIdExpr: string): string {
  return `SELECT l.staff_id FROM staff_profiles l WHERE l.affiliation_type = 'linked_external'
    AND (l.source_staff_id = ${staffIdExpr} OR l.root_staff_id = ${staffIdExpr})`
}
// まだ削除・匿名化すべきデータが残っているか（sp.staff_id を参照する）。匿名化が済むまでは残っているものとして扱う
const HAS_DATA_SQL = `(sp.anonymized_at IS NULL
    OR EXISTS (SELECT 1 FROM shifts WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM attendance_reports WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM evaluations WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM follow_logs WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM consultations WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM shift_report_tokens WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM attendance_corrections WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM report_setting_logs WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM project_staff_report_settings WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM notice_read_staff_reports WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM employee_records WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM employment_periods WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM staff_documents WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM employee_documents WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM roster_comments WHERE thread_staff_id = sp.staff_id OR thread_staff_id IN (${linkedRowsOf('sp.staff_id')}))
    OR EXISTS (SELECT 1 FROM roster_consents WHERE staff_id = sp.staff_id OR (source_staff_id = sp.staff_id AND staff_id IS NULL))
    OR EXISTS (SELECT 1 FROM recruit_applications WHERE staff_id = sp.staff_id)
    OR EXISTS (SELECT 1 FROM board_proposals WHERE (staff_id = sp.staff_id OR imported_staff_id = sp.staff_id) AND anonymized_at IS NULL))`

export type RetentionHolds = {
  staff: { staff_id: number; name: string; company_id: number; company_name: string | null; retired_at: string | null
    hold_at: string; hold_reason: string | null; hold_by_name: string | null }[]
  companies: { company_id: number; company_name: string; hold_at: string; hold_reason: string | null; hold_by_name: string | null }[]
}
/** 削除の保留中のスタッフと企業の一覧（本部画面。#543） */
export async function listRetentionHolds(db: D1Database): Promise<RetentionHolds> {
  const [st, co] = await db.batch([
    db.prepare(`SELECT sp.staff_id, u.name, sp.company_id, c.company_name, ${STAFF_RETIRED_AT_SQL} AS retired_at,
        sp.retention_hold_at AS hold_at, sp.retention_hold_reason AS hold_reason, hb.name AS hold_by_name
      FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id LEFT JOIN companies c ON c.company_id = sp.company_id
      LEFT JOIN users hb ON hb.user_id = sp.retention_hold_by
      WHERE sp.retention_hold_at IS NOT NULL ORDER BY sp.retention_hold_at DESC, sp.staff_id LIMIT 500`),
    db.prepare(`SELECT c.company_id, c.company_name, c.retention_hold_at AS hold_at, c.retention_hold_reason AS hold_reason, hb.name AS hold_by_name
      FROM companies c LEFT JOIN users hb ON hb.user_id = c.retention_hold_by
      WHERE c.retention_hold_at IS NOT NULL ORDER BY c.retention_hold_at DESC, c.company_id`),
  ])
  return { staff: st.results as RetentionHolds['staff'], companies: co.results as RetentionHolds['companies'] }
}

/**
 * 削除の保留を設定・解除する（本部画面。#543）。reason は設定のときに必須。
 * 設定・解除のどちらでも、退職後7年の猶予の印（retention_flagged_at）を外す（解除の後は猶予をやり直してから削除する）。
 * 対象が見つからなければ null を返す
 */
export async function setRetentionHold(db: D1Database, kind: 'staff' | 'company', id: number, hold: { reason: string; by: number } | null): Promise<{ name: string } | null> {
  const now = nowJST()
  if (kind === 'staff') {
    const row = await db.prepare('SELECT u.name FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id WHERE sp.staff_id = ?').bind(id).first() as { name: string } | null
    if (!row) return null
    await db.prepare(`UPDATE staff_profiles SET retention_hold_at = ?, retention_hold_reason = ?, retention_hold_by = ?, retention_flagged_at = NULL WHERE staff_id = ?`)
      .bind(hold ? now : null, hold ? hold.reason : null, hold ? hold.by : null, id).run()
    return row
  }
  const row = await db.prepare('SELECT company_name AS name FROM companies WHERE company_id = ?').bind(id).first() as { name: string } | null
  if (!row) return null
  await db.batch([
    db.prepare('UPDATE companies SET retention_hold_at = ?, retention_hold_reason = ?, retention_hold_by = ? WHERE company_id = ?')
      .bind(hold ? now : null, hold ? hold.reason : null, hold ? hold.by : null, id),
    db.prepare('UPDATE staff_profiles SET retention_flagged_at = NULL WHERE company_id = ? AND retention_flagged_at IS NOT NULL').bind(id),
  ])
  return row
}

export type RetentionScheduleRow = {
  staff_id: number; name: string; company_name: string; retired_at: string
  last_work_date: string | null; flagged_at: string | null; delete_on: string | null
}
/**
 * 本部画面の「次回削除予定」と「対象外（退職日より後にシフトあり）」の一覧。
 * delete_on は猶予が明けて削除できるようになる日（まだ猶予が始まっていなければ null）。
 */
export async function listRetentionSchedule(db: D1Database): Promise<{ scheduled: RetentionScheduleRow[]; excluded: RetentionScheduleRow[]; grace_days: number
  next_run_date: string; next_run_count: number; next_run_due: number; staff_batch: number; holds: RetentionHolds }> {
  const cutoff = cutoffDate(RETIRED_YEARS)
  const cols = `sp.staff_id, u.name, c.company_name, ${STAFF_RETIRED_AT_SQL} AS retired_at, sp.retention_flagged_at AS flagged_at,
    (SELECT MAX(work_date) FROM shifts WHERE staff_id = sp.staff_id) AS last_work_date
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id LEFT JOIN companies c ON c.company_id = sp.company_id`
  const scheduled = (await db.prepare(`SELECT ${cols}
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL}
    ORDER BY sp.retention_flagged_at IS NULL, sp.retention_flagged_at, retired_at, sp.staff_id LIMIT 200`).bind(cutoff).all()).results as any[]
  const excluded = (await db.prepare(`SELECT * FROM (SELECT ${cols}) x
    WHERE x.retired_at IS NOT NULL AND length(x.retired_at) >= 10 AND x.retired_at <= ?
      AND EXISTS (SELECT 1 FROM shifts s WHERE s.staff_id = x.staff_id AND s.work_date > x.retired_at)
    ORDER BY x.retired_at, x.staff_id LIMIT 100`).bind(cutoff).all()).results as any[]
  // 次の定期削除（毎日 日本時間3:00）で削除する人数（猶予が明けている人。1回の上限は STAFF_BATCH 人。#365）
  const nowJ = nowJST()
  const nextRunDate = nowJ.slice(11, 13) < '03' ? nowJ.slice(0, 10) : addDays(nowJ.slice(0, 10), 1)
  const due = await db.prepare(`SELECT COUNT(*) AS n FROM staff_profiles sp
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND sp.retention_flagged_at IS NOT NULL AND sp.retention_flagged_at <= ? AND ${HAS_DATA_SQL}`)
    .bind(cutoff, addDays(nextRunDate, -RETENTION_GRACE_DAYS)).first() as { n: number } | null
  const nextRunDue = Number(due?.n) || 0
  return {
    scheduled: scheduled.map(r => ({ ...r, delete_on: r.flagged_at ? addDays(r.flagged_at, RETENTION_GRACE_DAYS) : null })),
    excluded: excluded.map(r => ({ ...r, delete_on: null })),
    holds: await listRetentionHolds(db),
    grace_days: RETENTION_GRACE_DAYS,
    next_run_date: nextRunDate,
    next_run_due: nextRunDue,
    next_run_count: Math.min(nextRunDue, STAFF_BATCH),
    staff_batch: STAFF_BATCH,
  }
}

export type RetentionTargetResult = {
  target: string
  targetCount: number
  deletedCount: number
  failedCount: number
  error?: string
  errorCount?: number // 失敗の理由の件数（集計中だけ使う）
}
export type RetentionRunResult = {
  dryRun: boolean
  results: RetentionTargetResult[]
  startedAt: string
  finishedAt: string
  detail?: Awaited<ReturnType<typeof dryRunRetiredStaffDetail>> // 本部画面の dry-run の内訳（#365）
  detailError?: string
}

function cutoffDate(years: number): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - years)
  return d.toISOString().slice(0, 10)
}

// 日報の3年: 削除の保留中のスタッフ・企業の日報は消さない（#543）
const DR_NOT_HELD = notHeldSql('staff_id', 'company_id')

/**
 * 導入企業向けの日報の保存期間の案内（#417）。今後 days 日のうちに3年を過ぎて定期削除される日報の件数と、
 * その稼働日の範囲を返す（すでに期限を過ぎて次の定期削除を待っている分も含む。削除の保留中の分は数えない）
 */
export async function dailyReportRetentionInfo(db: D1Database, companyId: number, days = 30): Promise<{ years: number; cutoff: string
  due_count: number; due_from: string | null; due_to: string | null; days: number }> {
  const cutoff = cutoffDate(DAILY_REPORTS_YEARS)
  const until = addDays(cutoff, days)
  const row = await db.prepare(`SELECT COUNT(*) AS n, MIN(work_date) AS f, MAX(work_date) AS t FROM daily_reports
    WHERE company_id = ? AND work_date < ? AND ${DR_NOT_HELD}`).bind(companyId, until).first() as { n: number; f: string | null; t: string | null } | null
  return { years: DAILY_REPORTS_YEARS, cutoff, days, due_count: Number(row?.n) || 0, due_from: row?.f || null, due_to: row?.t || null }
}

async function cleanupDailyReports(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  const cutoff = cutoffDate(DAILY_REPORTS_YEARS)

  if (dryRun) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM daily_reports WHERE work_date < ? AND ${DR_NOT_HELD}`).bind(cutoff).first()
    return { target: 'daily_reports', targetCount: (row?.n as number) || 0, deletedCount: 0, failedCount: 0 }
  }

  let deleted = 0
  try {
    for (let i = 0; i < DAILY_REPORTS_MAX_BATCHES; i++) {
      const result = await db.prepare(
        `DELETE FROM daily_reports WHERE daily_report_id IN (SELECT daily_report_id FROM daily_reports WHERE work_date < ? AND ${DR_NOT_HELD} LIMIT ?)`
      ).bind(cutoff, DAILY_REPORTS_BATCH).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes < DAILY_REPORTS_BATCH) break
    }
    return { target: 'daily_reports', targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: daily_reports cleanup failed after deleting ${deleted}: ${e}`)
    return { target: 'daily_reports', targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e) }
  }
}

// 作成日時から一定年数たった行を、件数を区切って消す（user_notifications・email_logs で共用）。
// created_at は CURRENT_TIMESTAMP（YYYY-MM-DD HH:MM:SS）か ISO 8601 で、どちらも YYYY-MM-DD との文字列比較で判定できる
// where は追加の条件（削除の保留中の企業を除くときなど）
async function cleanupByCreatedAt(db: D1Database, dryRun: boolean, t: { target: string; table: string; idCol: string; years: number; where?: string }): Promise<RetentionTargetResult> {
  const cutoff = cutoffDate(t.years)
  const extra = t.where ? ` AND ${t.where}` : ''
  if (dryRun) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE created_at < ?${extra}`).bind(cutoff).first()
    return { target: t.target, targetCount: (row?.n as number) || 0, deletedCount: 0, failedCount: 0 }
  }
  let deleted = 0
  try {
    for (let i = 0; i < NOTIFICATIONS_MAX_BATCHES; i++) {
      const result = await db.prepare(
        `DELETE FROM ${t.table} WHERE ${t.idCol} IN (SELECT ${t.idCol} FROM ${t.table} WHERE created_at < ?${extra} LIMIT ?)`
      ).bind(cutoff, NOTIFICATIONS_BATCH).run()
      const changes = result.meta.changes || 0
      deleted += changes
      if (changes < NOTIFICATIONS_BATCH) break
    }
    return { target: t.target, targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: ${t.target} cleanup failed after deleting ${deleted}: ${e}`)
    return { target: t.target, targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e) }
  }
}
function cleanupUserNotifications(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  return cleanupByCreatedAt(db, dryRun, { target: 'user_notifications', table: 'user_notifications', idCol: 'notification_id', years: NOTIFICATIONS_YEARS })
}
// メールの送信記録（宛先のメールアドレスを含む）は1年で消す（#240）
function cleanupEmailLogs(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  return cleanupByCreatedAt(db, dryRun, { target: 'email_logs', table: 'email_logs', idCol: 'log_id', years: EMAIL_LOGS_YEARS })
}
// シフト・精算の操作履歴（#159）は操作から7年で消す（精算・請求の帳簿と同じ期間）。削除の保留中の企業の分は消さない
function cleanupOperationLogs(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult> {
  return cleanupByCreatedAt(db, dryRun, { target: 'operation_logs', table: 'operation_logs', idCol: 'log_id', years: OPERATION_LOGS_YEARS,
    where: `company_id NOT IN (${HELD_COMPANY_SQL})` })
}

function emptyRetiredAcc(): Record<string, RetentionTargetResult> {
  const acc: Record<string, RetentionTargetResult> = {}
  for (const t of RETIRED_TARGETS) acc[t] = { target: t, targetCount: 0, deletedCount: 0, failedCount: 0 }
  return acc
}

// 失敗の理由を残す（最初の数件だけ文言を残し、それ以上は件数だけ数える。#234）
function noteError(r: RetentionTargetResult, msg: string): void {
  const m = msg.slice(0, 300)
  const n = (r.errorCount || 0) + 1
  r.errorCount = n
  if (n <= MAX_ERRORS_PER_TARGET) r.error = r.error ? `${r.error} / ${m}` : m
}
function errorMessageOf(r: RetentionTargetResult): string | null {
  if (!r.error) return null
  const more = (r.errorCount || 0) - MAX_ERRORS_PER_TARGET
  return (more > 0 ? `${r.error} / ほか${more}件` : r.error).slice(0, 1000)
}

// 削除の候補になった人に猶予の開始日を付け、対象から外れた人（退職日の変更など）の印を外す
async function markRetentionCandidates(db: D1Database, cutoff: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE staff_profiles SET retention_flagged_at = NULL
      WHERE retention_flagged_at IS NOT NULL AND staff_id NOT IN (${ELIGIBLE_STAFF_SQL})`).bind(cutoff),
    db.prepare(`UPDATE staff_profiles SET retention_flagged_at = ?
      WHERE retention_flagged_at IS NULL AND staff_id IN (SELECT sp.staff_id FROM staff_profiles sp WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL})`).bind(todayJST(), cutoff),
  ])
}

// 猶予が明け、まだデータが残っている（または匿名化が済んでいない）人を、最後に処理を試みた日時の古い順に選ぶ
async function getEligibleRetiredStaffIds(db: D1Database, cutoff: string, limit: number): Promise<number[]> {
  const graceCutoff = addDays(todayJST(), -RETENTION_GRACE_DAYS)
  const rows = await db.prepare(
    `SELECT sp.staff_id FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id
     WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND sp.retention_flagged_at IS NOT NULL AND sp.retention_flagged_at <= ?
       AND ${HAS_DATA_SQL}
     ORDER BY sp.retention_attempted_at IS NOT NULL, sp.retention_attempted_at, u.retired_at, sp.staff_id LIMIT ?`
  ).bind(cutoff, graceCutoff, limit).all()
  return (rows.results as { staff_id: number }[]).map(r => r.staff_id)
}

// 対象件数の確認（削除はしない）。対象者の ID を IN 句に並べず、サブクエリで数える（D1 のバインド上限を避ける。#436）
async function dryRunRetiredStaffData(db: D1Database): Promise<Record<string, RetentionTargetResult>> {
  const acc = emptyRetiredAcc()
  const cutoff = cutoffDate(RETIRED_YEARS)
  const retired = ELIGIBLE_STAFF_SQL
  // バインドは cutoff の1個だけにするため、対象者を WITH で1回だけ書く
  const withRetired = `WITH r AS (${retired})`
  const linkedOfRetired = `SELECT l.staff_id FROM staff_profiles l WHERE l.affiliation_type = 'linked_external'
    AND (l.source_staff_id IN (SELECT staff_id FROM r) OR l.root_staff_id IN (SELECT staff_id FROM r))`
  const threadsOfRetired = `(thread_staff_id IN (SELECT staff_id FROM r) OR thread_staff_id IN (${linkedOfRetired}))`
  const counts: Record<string, string> = {
    retired_staff: `SELECT COUNT(*) AS n FROM staff_profiles sp WHERE sp.staff_id IN (${retired}) AND ${HAS_DATA_SQL}`,
    attendance_reports: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${retired})`,
    shifts: `SELECT COUNT(*) AS n FROM shifts WHERE staff_id IN (${retired})`,
    evaluations: `SELECT COUNT(*) AS n FROM evaluations WHERE staff_id IN (${retired})`,
    follow_logs: `SELECT COUNT(*) AS n FROM follow_logs WHERE staff_id IN (${retired})`,
    consultations: `SELECT COUNT(*) AS n FROM consultations WHERE staff_id IN (${retired})`,
    shift_report_tokens: `SELECT COUNT(*) AS n FROM shift_report_tokens WHERE staff_id IN (${retired})`,
    r2_photos: `SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id IN (${retired}) AND photo_key IS NOT NULL`,
    attendance_corrections: `SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id IN (${retired})`,
    attendance_correction_events: `SELECT COUNT(*) AS n FROM attendance_correction_events WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id IN (${retired}))`,
    notification_emails: `SELECT COUNT(*) AS n FROM notification_emails WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id IN (${retired}))`,
    report_setting_logs: `SELECT COUNT(*) AS n FROM report_setting_logs WHERE staff_id IN (${retired})`,
    project_staff_report_settings: `SELECT COUNT(*) AS n FROM project_staff_report_settings WHERE staff_id IN (${retired})`,
    notice_read_staff_reports: `SELECT COUNT(*) AS n FROM notice_read_staff_reports WHERE staff_id IN (${retired})`,
    employee_records: `SELECT COUNT(*) AS n FROM employee_records WHERE staff_id IN (${retired})`,
    employment_periods: `SELECT COUNT(*) AS n FROM employment_periods WHERE staff_id IN (${retired})`,
    staff_documents: `SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id IN (${retired})`,
    employee_documents: `SELECT COUNT(*) AS n FROM employee_documents WHERE staff_id IN (${retired})`,
    r2_documents: `${withRetired} SELECT (SELECT COUNT(*) FROM staff_documents WHERE staff_id IN (SELECT staff_id FROM r))
      + (SELECT COUNT(*) FROM employee_documents WHERE staff_id IN (SELECT staff_id FROM r)) AS n`,
    roster_comments: `${withRetired} SELECT COUNT(*) AS n FROM roster_comments WHERE ${threadsOfRetired}`,
    roster_comment_reads: `${withRetired} SELECT COUNT(*) AS n FROM roster_comment_reads WHERE ${threadsOfRetired}`,
    roster_consents: `${withRetired} SELECT COUNT(*) AS n FROM roster_consents WHERE staff_id IN (SELECT staff_id FROM r) OR (source_staff_id IN (SELECT staff_id FROM r) AND staff_id IS NULL)`,
    recruit_applications: `SELECT COUNT(*) AS n FROM recruit_applications WHERE staff_id IN (${retired})`,
    recruit_application_items: `SELECT COUNT(*) AS n FROM recruit_application_items WHERE application_id IN (SELECT application_id FROM recruit_applications WHERE staff_id IN (${retired}))`,
    board_proposals: `${withRetired} SELECT COUNT(*) AS n FROM board_proposals WHERE (staff_id IN (SELECT staff_id FROM r) OR imported_staff_id IN (SELECT staff_id FROM r)) AND anonymized_at IS NULL`,
    anonymized_staff: `SELECT COUNT(*) AS n FROM staff_profiles WHERE staff_id IN (${retired}) AND anonymized_at IS NULL`,
    // 前回までに消せず、次回に消す R2 のファイル（バインドの数をそろえるため ? を置く）
    r2_pending: `SELECT COUNT(*) AS n FROM retention_pending_r2 WHERE ? IS NOT NULL`,
  }
  for (const [t, sql] of Object.entries(counts)) {
    try {
      const row = await db.prepare(sql).bind(cutoff).first()
      acc[t].targetCount = (row?.n as number) || 0
    } catch (e) {
      acc[t].failedCount = 1; noteError(acc[t], `集計に失敗: ${e}`)
    }
  }
  return acc
}

export type RetentionDryRunStaff = {
  staff_id: number; name: string; company_id: number | null; company_name: string | null; retired_at: string
  last_work_date: string | null; last_report_date: string | null; flagged_at: string | null; delete_on: string | null
  report_after_retired: boolean; counts: Record<string, number>
}
export type RetentionDryRunCompany = { company_id: number | null; company_name: string | null; staff_count: number; counts: Record<string, number> }
// 退職者ごとに数える対象（列名 → 数える SQL。sp.staff_id を参照する）
const DRY_RUN_STAFF_COUNTS: Record<string, string> = {
  shifts: 'SELECT COUNT(*) FROM shifts WHERE staff_id = sp.staff_id',
  attendance_reports: 'SELECT COUNT(*) FROM attendance_reports WHERE staff_id = sp.staff_id',
  r2_photos: 'SELECT COUNT(*) FROM attendance_reports WHERE staff_id = sp.staff_id AND photo_key IS NOT NULL',
  evaluations: 'SELECT COUNT(*) FROM evaluations WHERE staff_id = sp.staff_id',
  follow_logs: 'SELECT COUNT(*) FROM follow_logs WHERE staff_id = sp.staff_id',
  consultations: 'SELECT COUNT(*) FROM consultations WHERE staff_id = sp.staff_id',
  attendance_corrections: 'SELECT COUNT(*) FROM attendance_corrections WHERE staff_id = sp.staff_id',
  employee_records: 'SELECT COUNT(*) FROM employee_records WHERE staff_id = sp.staff_id',
  documents: '(SELECT COUNT(*) FROM staff_documents WHERE staff_id = sp.staff_id) + (SELECT COUNT(*) FROM employee_documents WHERE staff_id = sp.staff_id)',
  roster_comments: `SELECT COUNT(*) FROM roster_comments WHERE thread_staff_id = sp.staff_id OR thread_staff_id IN (${linkedRowsOf('sp.staff_id')})`,
  notice_read_staff_reports: 'SELECT COUNT(*) FROM notice_read_staff_reports WHERE staff_id = sp.staff_id',
  recruit_applications: 'SELECT COUNT(*) FROM recruit_applications WHERE staff_id = sp.staff_id',
  board_proposals: 'SELECT COUNT(*) FROM board_proposals WHERE (staff_id = sp.staff_id OR imported_staff_id = sp.staff_id) AND anonymized_at IS NULL',
}

/**
 * dry-run の内訳: 次の定期削除の対象になる退職者を、会社別の件数と、人ごとの一覧（会社・氏名・退職日・最終稼働日・
 * テーブルごとの件数）で返す（#365）。猶予中の人も含む。退職日より後に勤怠の報告がある人には印を付ける
 * （退職日より後にシフトがある人は、元から対象外）。対象者は IN 句に並べず、サブクエリで選ぶ（バインドは cutoff の1個）
 */
export async function dryRunRetiredStaffDetail(db: D1Database): Promise<{ staff: RetentionDryRunStaff[]; staff_total: number; companies: RetentionDryRunCompany[] }> {
  const cutoff = cutoffDate(RETIRED_YEARS)
  const countCols = Object.entries(DRY_RUN_STAFF_COUNTS).map(([k, sql]) => `(${sql}) AS c_${k}`).join(',\n      ')
  const base = `SELECT sp.staff_id, u.name, sp.company_id, c.company_name, ${STAFF_RETIRED_AT_SQL} AS retired_at, sp.retention_flagged_at AS flagged_at,
      (SELECT MAX(work_date) FROM shifts WHERE staff_id = sp.staff_id) AS last_work_date,
      (SELECT MAX(substr(reported_at, 1, 10)) FROM attendance_reports WHERE staff_id = sp.staff_id) AS last_report_date,
      ${countCols}
    FROM staff_profiles sp JOIN users u ON u.user_id = sp.user_id LEFT JOIN companies c ON c.company_id = sp.company_id
    WHERE sp.staff_id IN (${ELIGIBLE_STAFF_SQL}) AND ${HAS_DATA_SQL}`
  const rows = (await db.prepare(`SELECT * FROM (${base}) x ORDER BY x.company_id, x.retired_at, x.staff_id LIMIT ?`)
    .bind(cutoff, DRY_RUN_STAFF_LIMIT).all()).results as any[]
  const sums = Object.keys(DRY_RUN_STAFF_COUNTS).map(k => `SUM(x.c_${k}) AS c_${k}`).join(', ')
  const companyRows = (await db.prepare(`SELECT x.company_id, MAX(x.company_name) AS company_name, COUNT(*) AS staff_count, ${sums}
    FROM (${base}) x GROUP BY x.company_id ORDER BY staff_count DESC, x.company_id`).bind(cutoff).all()).results as any[]
  const countsOf = (r: any) => Object.fromEntries(Object.keys(DRY_RUN_STAFF_COUNTS).map(k => [k, Number(r[`c_${k}`]) || 0]))
  return {
    staff: rows.map(r => ({
      staff_id: r.staff_id, name: r.name, company_id: r.company_id, company_name: r.company_name, retired_at: r.retired_at,
      last_work_date: r.last_work_date, last_report_date: r.last_report_date, flagged_at: r.flagged_at,
      delete_on: r.flagged_at ? addDays(r.flagged_at, RETENTION_GRACE_DAYS) : null,
      report_after_retired: !!(r.last_report_date && r.retired_at && r.last_report_date > String(r.retired_at).slice(0, 10)),
      counts: countsOf(r),
    })),
    staff_total: companyRows.reduce((a, r) => a + (Number(r.staff_count) || 0), 0),
    companies: companyRows.map(r => ({ company_id: r.company_id, company_name: r.company_name, staff_count: Number(r.staff_count) || 0, counts: countsOf(r) })),
  }
}

export type RetentionBuckets = { PHOTOS: R2Bucket; DOCUMENTS?: R2Bucket }
type PendingBucket = 'photos' | 'documents'

// 1回のCronで R2 から消せる残りのファイル数（#419）
type R2Budget = { left: number }

// R2 のファイルを消し、消せたキーを retention_pending_r2 から外す（消せなかったキー・上限を超えたキーは
// retention_pending_r2 に残り、次回に再試行する）。R2 の delete は1回で最大1000キーをまとめて消せるので、
// 1件ずつ呼ばずに配列で渡す（呼び出し回数の上限に当たらないようにする。#419）
async function deleteR2Files(db: D1Database, buckets: RetentionBuckets, kind: PendingBucket, keys: string[], acc: Record<string, RetentionTargetResult>, budget: R2Budget): Promise<void> {
  const r = acc[kind === 'documents' ? 'r2_documents' : 'r2_photos']
  const bucket = kind === 'documents' ? buckets.DOCUMENTS : buckets.PHOTOS
  const take = keys.slice(0, Math.max(0, budget.left))
  if (!take.length) return
  budget.left -= take.length
  r.targetCount += take.length
  if (!bucket) {
    r.failedCount += take.length
    noteError(r, `R2 のバケット（${kind === 'documents' ? 'DOCUMENTS' : 'PHOTOS'}）が設定されていないため ${take.length}件を消せませんでした（次回再試行）`)
    return
  }
  for (let i = 0; i < take.length; i += R2_DELETE_CHUNK) {
    const chunk = take.slice(i, i + R2_DELETE_CHUNK)
    try {
      await bucket.delete(chunk)
    } catch (e) {
      r.failedCount += chunk.length
      noteError(r, `R2 の削除に失敗 ${chunk.length}件（次回再試行）: ${e}`)
      continue
    }
    r.deletedCount += chunk.length
    // 消せたキーは json_each で1文にまとめて控えから外す（バインドは1個）
    await db.prepare('DELETE FROM retention_pending_r2 WHERE photo_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(chunk)).run()
  }
}

async function cleanupRetiredStaffData(db: D1Database, buckets: RetentionBuckets): Promise<Record<string, RetentionTargetResult>> {
  const acc = emptyRetiredAcc()
  const cutoff = cutoffDate(RETIRED_YEARS)

  const budget: R2Budget = { left: R2_DELETE_BUDGET }
  // 前回までに消せなかった（上限で翌日に回した）R2 の写真・書類を消し直す
  try {
    const rows = (await db.prepare('SELECT photo_key, bucket FROM retention_pending_r2 ORDER BY created_at LIMIT ?').bind(budget.left).all()).results as { photo_key: string; bucket: string | null }[]
    const docs = rows.filter(r => r.bucket === 'documents').map(r => r.photo_key)
    const photos = rows.filter(r => r.bucket !== 'documents').map(r => r.photo_key)
    if (photos.length) await deleteR2Files(db, buckets, 'photos', photos, acc, budget)
    if (docs.length) await deleteR2Files(db, buckets, 'documents', docs, acc, budget)
  } catch (e) {
    console.log(`retention: R2 retry failed: ${e}`)
    acc.r2_photos.failedCount++; noteError(acc.r2_photos, `R2 の再試行に失敗: ${e}`)
  }

  await markRetentionCandidates(db, cutoff)
  const staffIds = await getEligibleRetiredStaffIds(db, cutoff, STAFF_BATCH)
  acc.retired_staff.targetCount = staffIds.length

  // そのスタッフのシフトに付いた行も対象にする（shifts を消すときの外部キー違反を防ぐ。#51）
  const ofShifts = 'shift_id IN (SELECT shift_id FROM shifts WHERE staff_id = ?)'
  // 企業間チャットのスレッド: その人の行（連携行ならそれ自体がスレッド）と、その人を所属元とする連携行（#228）
  const ofThreads = `(thread_staff_id = ? OR thread_staff_id IN (${linkedRowsOf('?')}))`
  const userOf = '(SELECT user_id FROM staff_profiles WHERE staff_id = ?)'
  const anonymizeCols = ANONYMIZE_PROFILE_COLUMNS.map(col => `${col} = NULL`).join(', ')
  for (const [idx, staffId] of staffIds.entries()) {
    // R2 の上限を使い切ったら、残りの人は処理を試みずに次回へ回す（retention_attempted_at を付けないので次回の先頭に来る）
    if (budget.left <= 0) {
      acc.retired_staff_deferred.targetCount = staffIds.length - idx
      break
    }
    try {
      await db.prepare('UPDATE staff_profiles SET retention_attempted_at = ? WHERE staff_id = ?').bind(nowJST(), staffId).run()
      const fileRows = (await db.prepare(
        `SELECT photo_key AS k, 'photos' AS b FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts}) AND photo_key IS NOT NULL
         UNION ALL SELECT storage_key, 'documents' FROM staff_documents WHERE staff_id = ?
         UNION ALL SELECT storage_key, 'documents' FROM employee_documents WHERE staff_id = ?`
      ).bind(staffId, staffId, staffId, staffId).all()).results as { k: string; b: PendingBucket }[]
      const photoKeys = fileRows.filter(r => r.b === 'photos').map(r => r.k)
      const docKeys = fileRows.filter(r => r.b === 'documents').map(r => r.k)

      // 1. D1 側を1つの batch（トランザクション）で削除・匿名化する。写真・書類のキーは同じ batch で控えておく。
      //    attendance_reports・shift_report_tokens は shifts を参照しているため先に削除する
      const steps: [string | null, D1PreparedStatement][] = [
        [null, db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
          SELECT photo_key, ?, 'photos' FROM attendance_reports WHERE (staff_id = ? OR ${ofShifts}) AND photo_key IS NOT NULL`).bind(staffId, staffId, staffId)],
        [null, db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
          SELECT storage_key, ?, 'documents' FROM staff_documents WHERE staff_id = ?
          UNION ALL SELECT storage_key, ?, 'documents' FROM employee_documents WHERE staff_id = ?`).bind(staffId, staffId, staffId, staffId)],
        ['shift_report_tokens', db.prepare(`DELETE FROM shift_report_tokens WHERE staff_id = ? OR ${ofShifts}`).bind(staffId, staffId)],
        ['attendance_reports', db.prepare(`DELETE FROM attendance_reports WHERE staff_id = ? OR ${ofShifts}`).bind(staffId, staffId)],
        // Sprint 5 で足した、シフトを参照する表（リマインドの送信記録・交通費や延長の申請）。shifts より先に消す
        [null, db.prepare(`DELETE FROM reminder_sends WHERE staff_id = ? OR ${ofShifts}`).bind(staffId, staffId)],
        [null, db.prepare(`DELETE FROM staff_pay_requests WHERE staff_id = ? OR ${ofShifts}`).bind(staffId, staffId)],
        // シフト・精算の操作履歴（#159）。その人が担当していたシフトの履歴（削除したシフトの分を含む）も消す。shifts より先に消す
        [null, db.prepare(`DELETE FROM operation_logs WHERE staff_id = ? OR (entity = 'shift' AND entity_id IN (SELECT shift_id FROM shifts WHERE staff_id = ?))`).bind(staffId, staffId)],
        ['shifts', db.prepare('DELETE FROM shifts WHERE staff_id = ?').bind(staffId)],
        ['evaluations', db.prepare('DELETE FROM evaluations WHERE staff_id = ?').bind(staffId)],
        ['follow_logs', db.prepare('DELETE FROM follow_logs WHERE staff_id = ?').bind(staffId)],
        ['consultations', db.prepare('DELETE FROM consultations WHERE staff_id = ?').bind(staffId)],
        // 打刻修正の操作履歴・通知メールは申請より先に消す（申請 ID で対象を特定するため）
        ['attendance_correction_events', db.prepare('DELETE FROM attendance_correction_events WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId)],
        ['notification_emails', db.prepare('DELETE FROM notification_emails WHERE correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId)],
        // 打刻修正の添付写真（Sprint 5 の w5-corrections-features）。写真のキーは控えて、R2 の再試行の処理で消す
        [null, db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
          SELECT photo_key, ?, 'photos' FROM attendance_correction_attachments WHERE staff_id = ? OR correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)`).bind(staffId, staffId, staffId)],
        [null, db.prepare('DELETE FROM attendance_correction_attachments WHERE staff_id = ? OR correction_id IN (SELECT correction_id FROM attendance_corrections WHERE staff_id = ?)').bind(staffId, staffId)],
        ['attendance_corrections', db.prepare('DELETE FROM attendance_corrections WHERE staff_id = ?').bind(staffId)],
        ['report_setting_logs', db.prepare('DELETE FROM report_setting_logs WHERE staff_id = ?').bind(staffId)],
        ['project_staff_report_settings', db.prepare('DELETE FROM project_staff_report_settings WHERE staff_id = ?').bind(staffId)],
        // スタッフ別の既読率（人事評価の参考資料。会社全体の notice_read_reports は個人を含まない集計なので残す。#437）
        ['notice_read_staff_reports', db.prepare('DELETE FROM notice_read_staff_reports WHERE staff_id = ?').bind(staffId)],
        // 従業員データ（口座・住所・給与・緊急連絡先など）・過去の雇用期間・書類（#193）
        ['employee_records', db.prepare('DELETE FROM employee_records WHERE staff_id = ?').bind(staffId)],
        ['employment_periods', db.prepare('DELETE FROM employment_periods WHERE staff_id = ?').bind(staffId)],
        ['staff_documents', db.prepare('DELETE FROM staff_documents WHERE staff_id = ?').bind(staffId)],
        ['employee_documents', db.prepare('DELETE FROM employee_documents WHERE staff_id = ?').bind(staffId)],
        // Sprint 5 で足した本人の記録（振込先の口座・変更申請・休暇・出勤可能日・従業員データの変更履歴・予定確認やカレンダーのトークン）
        [null, db.prepare('DELETE FROM payout_accounts WHERE staff_id = ?').bind(staffId)],
        // Sprint 6（w6-premium-pay）: スタッフの交通費の標準
        [null, db.prepare('DELETE FROM staff_transport_defaults WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare('DELETE FROM profile_change_requests WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare('DELETE FROM leave_requests WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare('DELETE FROM staff_availability WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare('DELETE FROM availability_submissions WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare('DELETE FROM employee_change_logs WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare('DELETE FROM staff_schedule_tokens WHERE staff_id = ?').bind(staffId)],
        [null, db.prepare(`DELETE FROM staff_calendar_tokens WHERE user_id = ${userOf}`).bind(staffId)],
        // Sprint 6 で足した、本人の端末のプッシュの購読・送信待ちと通知の受け取り設定（w6-push）
        [null, db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ${userOf}`).bind(staffId)],
        [null, db.prepare(`DELETE FROM push_queue WHERE user_id = ${userOf}`).bind(staffId)],
        [null, db.prepare(`DELETE FROM user_notification_prefs WHERE user_id = ${userOf}`).bind(staffId)],
        // 企業間チャットと連携の同意履歴（#228）
        ['roster_comment_reads', db.prepare(`DELETE FROM roster_comment_reads WHERE ${ofThreads}`).bind(staffId, staffId, staffId)],
        ['roster_comments', db.prepare(`DELETE FROM roster_comments WHERE ${ofThreads}`).bind(staffId, staffId, staffId)],
        // 同意履歴は連携行（staff_id）の単位で消す。所属元の行が対象になっても、連携先の行が残っている間は連携の根拠として残す
        ['roster_consents', db.prepare('DELETE FROM roster_consents WHERE staff_id = ? OR (source_staff_id = ? AND staff_id IS NULL)').bind(staffId, staffId)],
        // スタッフに紐づく応募（氏名・電話・メール・メモ）と応募した枠、人材提案のスナップショット・開示した氏名（#350）
        [null, db.prepare('DELETE FROM recruit_application_notes WHERE application_id IN (SELECT application_id FROM recruit_applications WHERE staff_id = ?)').bind(staffId)],
        ['recruit_application_items', db.prepare('DELETE FROM recruit_application_items WHERE application_id IN (SELECT application_id FROM recruit_applications WHERE staff_id = ?)').bind(staffId)],
        ['recruit_applications', db.prepare('DELETE FROM recruit_applications WHERE staff_id = ?').bind(staffId)],
        ['board_proposals', db.prepare(`UPDATE board_proposals SET ${ANONYMIZE_PROPOSAL_SET}, anonymized_at = ?
          WHERE (staff_id = ? OR imported_staff_id = ?) AND anonymized_at IS NULL`).bind(nowJST(), staffId, staffId)],
        // 本人情報の匿名化（#480）。ログインに使えないようにし、セッションと再設定のリンクも消す。
        // users はスタッフ本人の行（staff / roster_only）だけを匿名化する（管理者の行は変えない）
        [null, db.prepare(`DELETE FROM sessions WHERE user_id = ${userOf}`).bind(staffId)],
        [null, db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = ${userOf}`).bind(staffId)],
        [null, db.prepare(`UPDATE users SET name = ?, email = NULL, phone = NULL, password_hash = '!anonymized', status = 'suspended'
          WHERE user_id = ${userOf} AND role IN ('staff', 'roster_only')`).bind(`退職者#${staffId}`, staffId)],
        ['anonymized_staff', db.prepare(`UPDATE staff_profiles SET ${anonymizeCols}, anonymized_at = ? WHERE staff_id = ? AND anonymized_at IS NULL`).bind(nowJST(), staffId)],
      ]
      const del = await db.batch(steps.map(s => s[1]))
      steps.forEach(([t], i) => {
        if (!t) return
        const n = del[i].meta.changes || 0
        acc[t].targetCount += n; acc[t].deletedCount += n
      })
      acc.retired_staff.deletedCount++

      // 2. D1 の削除が成功してから R2 の写真・書類を消す
      //    上限を超えた分は retention_pending_r2 に残り、翌日以降の再試行で消す
      if (photoKeys.length) await deleteR2Files(db, buckets, 'photos', photoKeys, acc, budget)
      if (docKeys.length) await deleteR2Files(db, buckets, 'documents', docKeys, acc, budget)
    } catch (e) {
      console.log(`retention: cleanup failed for staff_id=${staffId}: ${e}`)
      acc.retired_staff.failedCount++
      noteError(acc.retired_staff, `staff_id=${staffId}: ${e}`)
    }
  }
  // 翌日に回した R2 のファイル（上限を超えた分と、消せなかった分）
  try {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM retention_pending_r2').first()
    acc.r2_pending.targetCount = (row?.n as number) || 0
  } catch (e) { console.log(`retention: pending count failed: ${e}`) }
  return acc
}

// ============ 在職中の保存期間（#420 #511 #350 #425） ============
// 1回の Cron で処理する行数を区切る（D1 の問い合わせの数と CPU 時間を抑える。残りは翌日に回す）
const IN_SERVICE_BATCH = 500
const IN_SERVICE_MAX_BATCHES = 4
const ENDED_EMPLOYMENT_BATCH = 50 // 雇用終了の従業員データを1回で消す人数
// 位置情報・写真が残っている勤怠の行。migrations/0063 の部分索引 idx_attendance_location_photo と同じ式にする
const LOCATION_PHOTO_SQL = '(latitude IS NOT NULL OR longitude IS NOT NULL OR address IS NOT NULL OR device_info IS NOT NULL OR device_id IS NOT NULL OR photo_key IS NOT NULL)'
// 在職中の削除の対象（dry-run・実行ログの対象名）
export const IN_SERVICE_TARGETS = ['attendance_location', 'attendance_photos', 'consultations_done', 'follow_logs_done', 'board_proposals_settled',
  'ended_employee_records', 'ended_employee_documents', 'ended_employment_periods'] as const

function daysAgo(days: number): string { return addDays(todayJST(), -days) }

// 選んだ ID の行に対して、件数を区切って処理を繰り返す（dry-run は件数を数えるだけ）。
// select は「binds＋LIMIT ?」で ID を返す SQL、apply は選んだ ID（JSON 配列の文字列）を受けて実行する文の一覧、
// changesAt はその中で件数に数える文の位置。extra は同じ処理で一緒に消すもの（写真・書類の R2 の控えなど）の件数
type ExtraCount = { r: RetentionTargetResult; count: string; changesAt: number }
async function inBatches(db: D1Database, dryRun: boolean, r: RetentionTargetResult, o: {
  count: string; select: string; binds: unknown[]; apply: (ids: string) => D1PreparedStatement[]; changesAt: number; batch?: number; extra?: ExtraCount
}): Promise<void> {
  if (dryRun) {
    const counts = [o.count, ...(o.extra ? [o.extra.count] : [])]
    const rows = await db.batch(counts.map(sql => db.prepare(sql).bind(...o.binds)))
    const n = (i: number) => Number((rows[i].results[0] as { n: number } | undefined)?.n) || 0
    r.targetCount += n(0)
    if (o.extra) o.extra.r.targetCount += n(1)
    return
  }
  const size = o.batch || IN_SERVICE_BATCH
  for (let i = 0; i < IN_SERVICE_MAX_BATCHES; i++) {
    const ids = ((await db.prepare(o.select).bind(...o.binds, size).all()).results as { id: number }[]).map(x => x.id)
    if (!ids.length) break
    const res = await db.batch(o.apply(JSON.stringify(ids)))
    const n = res[o.changesAt].meta.changes || 0
    r.targetCount += n; r.deletedCount += n
    if (o.extra) {
      const m = res[o.extra.changesAt].meta.changes || 0
      o.extra.r.targetCount += m; o.extra.r.deletedCount += m
    }
    if (ids.length < size) break
  }
}

async function runInServiceStage(target: string, fn: (r: RetentionTargetResult) => Promise<void>): Promise<RetentionTargetResult> {
  const r: RetentionTargetResult = { target, targetCount: 0, deletedCount: 0, failedCount: 0 }
  try {
    await fn(r)
  } catch (e) {
    console.log(`retention: ${target} failed: ${e}`)
    r.failedCount++; noteError(r, String(e))
  }
  return r
}

/**
 * 在職中でも保存期間で消すもの（#420 #511 #350 #425）。削除の保留中のスタッフ・企業の分は消さない（#543）。
 * R2 の写真・書類は retention_pending_r2 に控え、退職後7年の処理の再試行（毎日の cron の最初）で消す
 */
async function cleanupInService(db: D1Database, dryRun: boolean): Promise<RetentionTargetResult[]> {
  const s = await getRetentionSettings(db)
  const notHeld = notHeldSql('staff_id', 'company_id')
  const out: RetentionTargetResult[] = []

  // #420 入店などの位置情報・端末情報と写真。勤怠の時刻・種別は残し、位置・端末・写真のキーを消す
  const locCutoff = daysAgo(s.location_photo_days)
  // 写真の件数は、実行時は R2 の削除の控え（retention_pending_r2）に入れた数
  const photos: RetentionTargetResult = { target: 'attendance_photos', targetCount: 0, deletedCount: 0, failedCount: 0 }
  out.push(await runInServiceStage('attendance_location', r => inBatches(db, dryRun, r, {
    count: `SELECT COUNT(*) AS n FROM attendance_reports WHERE ${LOCATION_PHOTO_SQL} AND reported_at < ? AND ${notHeld}`,
    select: `SELECT attendance_id AS id FROM attendance_reports WHERE ${LOCATION_PHOTO_SQL} AND reported_at < ? AND ${notHeld} LIMIT ?`,
    binds: [locCutoff],
    apply: ids => [
      // 打刻修正の承認で添付の1枚目を報告の写真にしたもの（#485）は、同じ R2 のオブジェクトを添付からも見るので消さない（キーだけ外す。
      // オブジェクトは打刻修正の申請と一緒に、退職後7年の削除で消す）
      db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
        SELECT photo_key, staff_id, 'photos' FROM attendance_reports WHERE attendance_id IN (SELECT value FROM json_each(?)) AND photo_key IS NOT NULL
          AND photo_key NOT IN (SELECT photo_key FROM attendance_correction_attachments)`).bind(ids),
      db.prepare(`UPDATE attendance_reports SET latitude = NULL, longitude = NULL, address = NULL, device_info = NULL, device_id = NULL, photo_key = NULL
        WHERE attendance_id IN (SELECT value FROM json_each(?))`).bind(ids),
    ],
    changesAt: 1,
    extra: { r: photos, changesAt: 0,
      count: `SELECT COUNT(*) AS n FROM attendance_reports WHERE ${LOCATION_PHOTO_SQL} AND reported_at < ? AND ${notHeld} AND photo_key IS NOT NULL` },
  })))
  out.push(photos)

  // #511 対応済みの相談と、完了したフォロー記録
  out.push(await runInServiceStage('consultations_done', r => inBatches(db, dryRun, r, {
    count: `SELECT COUNT(*) AS n FROM consultations WHERE status = 'done' AND created_at < ? AND ${notHeld}`,
    select: `SELECT consultation_id AS id FROM consultations WHERE status = 'done' AND created_at < ? AND ${notHeld} LIMIT ?`,
    binds: [cutoffDate(s.consultation_years)],
    apply: ids => [db.prepare('DELETE FROM consultations WHERE consultation_id IN (SELECT value FROM json_each(?))').bind(ids)],
    changesAt: 0,
  })))
  out.push(await runInServiceStage('follow_logs_done', r => inBatches(db, dryRun, r, {
    count: `SELECT COUNT(*) AS n FROM follow_logs WHERE status = 'done' AND COALESCE(done_at, created_at) < ? AND ${notHeld}`,
    select: `SELECT follow_id AS id FROM follow_logs WHERE status = 'done' AND COALESCE(done_at, created_at) < ? AND ${notHeld} LIMIT ?`,
    binds: [cutoffDate(s.follow_log_years)],
    apply: ids => [db.prepare('DELETE FROM follow_logs WHERE follow_id IN (SELECT value FROM json_each(?))').bind(ids)],
    changesAt: 0,
  })))

  // #350 見送り・取り下げになった人材提案のスナップショット（経歴など）・開示した氏名・コメント・上流の経路
  const propNotHeld = `staff_id NOT IN (${HELD_STAFF_SQL}) AND COALESCE(imported_staff_id, 0) NOT IN (${HELD_STAFF_SQL})
    AND proposer_company_id NOT IN (${HELD_COMPANY_SQL}) AND receiver_company_id NOT IN (${HELD_COMPANY_SQL})`
  const propWhere = `status IN ('declined', 'withdrawn') AND anonymized_at IS NULL AND COALESCE(decided_at, updated_at, created_at) < ? AND ${propNotHeld}`
  out.push(await runInServiceStage('board_proposals_settled', r => inBatches(db, dryRun, r, {
    count: `SELECT COUNT(*) AS n FROM board_proposals WHERE ${propWhere}`,
    select: `SELECT proposal_id AS id FROM board_proposals WHERE ${propWhere} LIMIT ?`,
    binds: [daysAgo(s.proposal_days)],
    apply: ids => [db.prepare(`UPDATE board_proposals SET ${ANONYMIZE_PROPOSAL_SET}, anonymized_at = ? WHERE proposal_id IN (SELECT value FROM json_each(?)) AND anonymized_at IS NULL`).bind(nowJST(), ids)],
    changesAt: 0,
  })))

  // #425 区分変更で雇用終了にした人（自社雇用に戻っていない人・統合済みの行）の従業員データと入社時書類（雇用終了日から7年）
  const empCutoff = cutoffDate(RETIRED_YEARS)
  const endedWhere = `er.employment_ended_at IS NOT NULL AND er.employment_ended_at <= ?
    AND (COALESCE(sp.affiliation_type, 'own_employee') != 'own_employee' OR sp.merged_into_staff_id IS NOT NULL)
    AND ${notHeldSql('er.staff_id', 'er.company_id')}`
  const docs: RetentionTargetResult = { target: 'ended_employee_documents', targetCount: 0, deletedCount: 0, failedCount: 0 }
  out.push(await runInServiceStage('ended_employee_records', r => inBatches(db, dryRun, r, {
    count: `SELECT COUNT(*) AS n FROM employee_records er JOIN staff_profiles sp ON sp.staff_id = er.staff_id WHERE ${endedWhere}`,
    select: `SELECT er.staff_id AS id FROM employee_records er JOIN staff_profiles sp ON sp.staff_id = er.staff_id WHERE ${endedWhere} LIMIT ?`,
    binds: [empCutoff],
    batch: ENDED_EMPLOYMENT_BATCH,
    apply: ids => [
      db.prepare(`INSERT OR IGNORE INTO retention_pending_r2 (photo_key, staff_id, bucket)
        SELECT storage_key, staff_id, 'documents' FROM employee_documents WHERE staff_id IN (SELECT value FROM json_each(?))`).bind(ids),
      db.prepare('DELETE FROM employee_records WHERE staff_id IN (SELECT value FROM json_each(?))').bind(ids),
      db.prepare('DELETE FROM employee_documents WHERE staff_id IN (SELECT value FROM json_each(?))').bind(ids),
    ],
    changesAt: 1,
    extra: { r: docs, changesAt: 2, count: `SELECT COUNT(*) AS n FROM employee_documents WHERE staff_id IN (
      SELECT er.staff_id FROM employee_records er JOIN staff_profiles sp ON sp.staff_id = er.staff_id WHERE ${endedWhere})` },
  })))
  out.push(docs)
  out.push(await runInServiceStage('ended_employment_periods', r => inBatches(db, dryRun, r, {
    count: `SELECT COUNT(*) AS n FROM employment_periods WHERE employment_ended_at IS NOT NULL AND employment_ended_at <= ? AND ${notHeld}`,
    select: `SELECT period_id AS id FROM employment_periods WHERE employment_ended_at IS NOT NULL AND employment_ended_at <= ? AND ${notHeld} LIMIT ?`,
    binds: [empCutoff],
    apply: ids => [db.prepare('DELETE FROM employment_periods WHERE period_id IN (SELECT value FROM json_each(?))').bind(ids)],
    changesAt: 0,
  })))
  return out
}

export type RetentionTrigger = 'cron' | 'manual'

// dryRun=true の場合は一切DELETEを実行せず、対象件数のみを返す（本番投入前の確認用）。
// 各段階の失敗は捕まえて結果（retention_logs）に残し、他の段階は続ける（#436）。
// trigger・triggeredBy は実行元（毎日の cron か、本部画面の dry-run か）と実行した本部ユーザー（#234）
// stages: 'main'（日報3年・通知2年・メール送信ログ1年・退職後7年。既定）と 'in_service'（在職中の保存期間。#420 #511 #350 #425）。
// 毎日の cron はこの2つを別の起動で実行し（D1 の問い合わせの数を分ける）、本部画面の dry-run は両方をまとめて数える
export type RetentionStage = 'main' | 'in_service'
export async function runRetentionCleanup(db: D1Database, buckets: RetentionBuckets,
  opts: { dryRun: boolean; trigger: RetentionTrigger; triggeredBy?: number | null; detail?: boolean; stages?: RetentionStage[] }): Promise<RetentionRunResult> {
  const startedAt = new Date().toISOString()

  const stage = async (target: string, fn: () => Promise<RetentionTargetResult[]>): Promise<RetentionTargetResult[]> => {
    try {
      return await fn()
    } catch (e) {
      console.log(`retention: ${target} failed: ${e}`)
      return [{ target, targetCount: 0, deletedCount: 0, failedCount: 1, error: String(e).slice(0, 1000) }]
    }
  }
  const stages = opts.stages || ['main']
  const results = [
    ...(stages.includes('main') ? [
      ...await stage('daily_reports', async () => [await cleanupDailyReports(db, opts.dryRun)]),
      ...await stage('user_notifications', async () => [await cleanupUserNotifications(db, opts.dryRun)]),
      ...await stage('email_logs', async () => [await cleanupEmailLogs(db, opts.dryRun)]),
      ...await stage('operation_logs', async () => [await cleanupOperationLogs(db, opts.dryRun)]),
      ...await stage('retired_staff', async () => Object.values(opts.dryRun ? await dryRunRetiredStaffData(db) : await cleanupRetiredStaffData(db, buckets))),
    ] : []),
    ...(stages.includes('in_service') ? await stage('in_service', () => cleanupInService(db, opts.dryRun)) : []),
  ]
  const finishedAt = new Date().toISOString()
  for (const r of results) {
    r.error = errorMessageOf(r) || undefined
    delete r.errorCount
  }

  await writeRetentionLogs(db, results, { ...opts, startedAt, finishedAt })
  const run: RetentionRunResult = { dryRun: opts.dryRun, results, startedAt, finishedAt }
  // 本部画面の dry-run では、会社別・退職者別の内訳も返す（#365）
  if (opts.dryRun && opts.detail) {
    try { run.detail = await dryRunRetiredStaffDetail(db) }
    catch (e) { console.log(`retention: dry-run detail failed: ${e}`); run.detailError = String(e).slice(0, 300) }
  }
  return run
}

/**
 * 毎日の cron から呼ぶ在職中の保存期間の削除（#420 #511 #350 #425）。RETENTION_ENABLED が 'true' でなければ dry-run。
 * 戻り値は定期処理の実行記録（cron_runs）の形
 */
export async function runInServiceRetentionJob(db: D1Database, buckets: RetentionBuckets, enabled: boolean) {
  const dryRun = !enabled
  const r = await runRetentionCleanup(db, buckets, { dryRun, trigger: 'cron', stages: ['in_service'] })
  const failed = r.results.filter(x => x.failedCount > 0)
  return {
    dry_run: dryRun,
    target: r.results.reduce((a, x) => a + x.targetCount, 0),
    deleted: r.results.reduce((a, x) => a + x.deletedCount, 0),
    failed: failed.reduce((a, x) => a + x.failedCount, 0),
    error: failed.map(x => `${x.target}: ${x.error || '失敗'}`).join(' / ').slice(0, 1000) || null,
  }
}

// ============ R2 に残った、どの勤怠にも紐づかない写真（#533 の残り） ============
// 報告の登録に失敗したときに消し損ねた写真など。本部画面から dry-run で数え、確認してから消す。
// attendance/ 以下だけを対象にし、アップロードから1日以内のもの（登録の途中かもしれない）は数えない
const ORPHAN_PREFIX = 'attendance/'
const ORPHAN_PAGE = 500
const ORPHAN_MIN_AGE_MS = 24 * 3600 * 1000
// 勤怠の報告の写真のキーの形（attendance/会社/スタッフ/シフト/報告の種類_時刻.拡張子。api.ts・staff-lifecycle.ts と同じ）。
// 同じ attendance/ 以下でも、この形でないキー（打刻修正の添付など、別の表から参照される写真）は紐づかない写真として扱わない
const ORPHAN_KEY_RE = new RegExp(`^attendance/\\d+/\\d+/\\d+/(?:${REPORT_TYPES.join('|')})_\\d+\\.(?:jpg|png)$`)
export async function scanOrphanPhotos(db: D1Database, bucket: R2Bucket | undefined,
  o: { dryRun: boolean; cursor?: string | null; triggeredBy?: number | null }): Promise<{ scanned: number; orphans: number; deleted: number
    samples: string[]; next_cursor: string | null }> {
  if (!bucket) throw new Error('R2 のバケット（PHOTOS）が設定されていません')
  const startedAt = new Date().toISOString()
  const page = await bucket.list({ prefix: ORPHAN_PREFIX, limit: ORPHAN_PAGE, ...(o.cursor ? { cursor: o.cursor } : {}) })
  const old = page.objects.filter(x => ORPHAN_KEY_RE.test(x.key) && Date.now() - new Date(x.uploaded).getTime() >= ORPHAN_MIN_AGE_MS).map(x => x.key)
  let orphans: string[] = []
  if (old.length) {
    // 勤怠の行・削除の控え・0036 で外した重複の控えのどれにもないキー
    orphans = ((await db.prepare(`SELECT j.value AS k FROM json_each(?) j
      WHERE NOT EXISTS (SELECT 1 FROM attendance_reports a WHERE a.photo_key = j.value)
        AND NOT EXISTS (SELECT 1 FROM retention_pending_r2 p WHERE p.photo_key = j.value)
        AND NOT EXISTS (SELECT 1 FROM attendance_reports_duplicates_0036 d WHERE d.photo_key = j.value)`).bind(JSON.stringify(old)).all()).results as { k: string }[]).map(x => x.k)
  }
  let deleted = 0
  if (!o.dryRun && orphans.length) {
    const r: RetentionTargetResult = { target: 'orphan_photos', targetCount: orphans.length, deletedCount: 0, failedCount: 0 }
    try { await bucket.delete(orphans); deleted = r.deletedCount = orphans.length }
    catch (e) { r.failedCount = orphans.length; r.error = `R2 の削除に失敗: ${e}`.slice(0, 1000) }
    await writeRetentionLogs(db, [r], { dryRun: false, trigger: 'manual', triggeredBy: o.triggeredBy ?? null, startedAt, finishedAt: new Date().toISOString() })
    if (r.failedCount) throw new Error(r.error)
  }
  return { scanned: page.objects.length, orphans: orphans.length, deleted, samples: orphans.slice(0, 20), next_cursor: page.truncated ? page.cursor : null }
}

// 1回の実行の行はまとめて書く（対象ごとに1文ずつ書くとクエリ数が増えるため）。
// 同じ実行の行は started_at が同じになり、本部画面ではこれで1回の実行にまとめて表示する（#305）
async function writeRetentionLogs(db: D1Database, results: RetentionTargetResult[],
  o: { dryRun: boolean; trigger: RetentionTrigger; triggeredBy?: number | null; startedAt: string; finishedAt: string }): Promise<void> {
  try {
    const duration = new Date(o.finishedAt).getTime() - new Date(o.startedAt).getTime()
    await db.batch(results.map(r => db.prepare(`
        INSERT INTO retention_logs (target, dry_run, target_count, deleted_count, failed_count, error_message, duration_ms, started_at, finished_at, trigger_source, triggered_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        r.target, o.dryRun ? 1 : 0, r.targetCount, r.deletedCount, r.failedCount, r.error || null,
        duration, o.startedAt, o.finishedAt, o.trigger, o.triggeredBy ?? null
      )))
  } catch (e) {
    // ログ保存の失敗は削除結果の返却を優先して続ける（cron の実行記録には結果が残る）
    console.log(`retention: log insert failed: ${e}`)
  }
}

// ============ 期限切れ・使用済みのトークンの削除（毎日の cron。#397） ============
// データ保持（RETENTION_ENABLED）とは別に、常に実際に削除する（使えなくなったトークンを消すだけで、記録としての価値はない）
const PASSWORD_RESET_KEEP_DAYS = 7 // 期限（1時間）が切れてから残す日数（問い合わせの調査用）
const REPORT_TOKEN_KEEP_DAYS = 30 // 報告用URLの期限（稼働日の翌日 23:59）が切れてから残す日数
const TOKEN_PURGE_BATCH = 500
const TOKEN_PURGE_MAX_BATCHES = 20

async function purgeInBatches(db: D1Database, target: string, sql: string, binds: unknown[]): Promise<RetentionTargetResult> {
  let deleted = 0
  try {
    for (let i = 0; i < TOKEN_PURGE_MAX_BATCHES; i++) {
      const r = await db.prepare(sql).bind(...binds, TOKEN_PURGE_BATCH).run()
      const n = r.meta.changes || 0
      deleted += n
      if (n < TOKEN_PURGE_BATCH) break
    }
    return { target, targetCount: deleted, deletedCount: deleted, failedCount: 0 }
  } catch (e) {
    console.log(`retention: ${target} purge failed after deleting ${deleted}: ${e}`)
    return { target, targetCount: deleted, deletedCount: deleted, failedCount: 1, error: String(e).slice(0, 1000) }
  }
}

/**
 * 期限切れ・使用済みのパスワード再設定トークンと、期限切れ・取り消し済みの報告用URLのトークンを消し、
 * 結果を retention_logs に残す。
 *  - password_reset_tokens: expires_at（ISO 8601）から7日たった行。使用済みの行は作成から1日たったら消す
 *    （再設定の回数制限が直近1時間の行を数えるため、すぐには消さない）
 *  - shift_report_tokens: 有効期限は今のシフトの稼働日から決まる（staff-lifecycle.ts の reportTokenExpiry）ので、
 *    稼働日から 1+30 日たった行を消す。取り消し済み（revoked=1）の行は作成から30日たったら消す
 */
export async function purgeExpiredTokens(db: D1Database): Promise<{ deleted: number; failed: number; error: string | null }> {
  const startedAt = new Date().toISOString()
  const resetCutoff = new Date(Date.now() - PASSWORD_RESET_KEEP_DAYS * 86400 * 1000).toISOString()
  const reportCutoff = addDays(todayJST(), -(1 + REPORT_TOKEN_KEEP_DAYS))
  const results = [
    await purgeInBatches(db, RETENTION_TOKEN_TARGETS[0],
      `DELETE FROM password_reset_tokens WHERE token_id IN (SELECT token_id FROM password_reset_tokens
        WHERE expires_at < ? OR (used_at IS NOT NULL AND created_at < datetime('now', '-1 day')) LIMIT ?)`, [resetCutoff]),
    await purgeInBatches(db, RETENTION_TOKEN_TARGETS[1],
      `DELETE FROM shift_report_tokens WHERE token IN (SELECT t.token FROM shift_report_tokens t LEFT JOIN shifts s ON s.shift_id = t.shift_id
        WHERE s.work_date < ? OR s.shift_id IS NULL OR (t.revoked = 1 AND t.created_at < datetime('now', '-${REPORT_TOKEN_KEEP_DAYS} days')) LIMIT ?)`, [reportCutoff]),
  ]
  for (const r of results) {
    r.error = errorMessageOf(r) || r.error
    delete r.errorCount
  }
  await writeRetentionLogs(db, results, { dryRun: false, trigger: 'cron', startedAt, finishedAt: new Date().toISOString() })
  const failed = results.filter(r => r.failedCount > 0)
  return {
    deleted: results.reduce((a, r) => a + r.deletedCount, 0),
    failed: failed.reduce((a, r) => a + r.failedCount, 0),
    error: failed.map(r => `${r.target}: ${r.error || '失敗'}`).join(' / ').slice(0, 1000) || null,
  }
}

// ============ 解約・停止した企業のデータの書き出しと削除（#177） ============
// 本部が「契約終了」を登録した企業（停止中のものに限る）について、
//   - 書き出し: 企業の表ごとの CSV（区切って取得し、画面でつなぐ）と、R2 の写真・書類の一覧と取得
//   - 削除: 契約終了日＋猶予日数を過ぎてから、本部の二重の確認のうえで、1回の要求で処理できる量ずつ進める。
//       1. R2 のキーを offboarding_pending_r2 に控える
//       2. 企業の行を、参照される側より先に参照する側から消す（OFFBOARDING_TABLES の順）
//       3. 利用者（users）とスタッフ（staff_profiles）の行は、他社の連携行・企業間チャット・掲示板などから参照されるため残し、
//          退職後7年の匿名化（#480）と同じく氏名・連絡先・ログイン情報などを消す
//       4. D1 の削除が済んでから R2 のファイルを消す（消せたものから控えを消し、失敗したものは次の要求で再試行）
// 他社と共有する記録（掲示板の投稿・やり取り・提案、企業間チャット、連携の同意の記録、本人の共通 ID（persons））と、
// ログインの履歴（login_events。1年で自動削除）は残す。companies の行も解約の記録として残す。
// 企業の行を持つ表を足したときは OFFBOARDING_TABLES にも足す（足していない表は、確認の画面に「未対応の表」として出る）。
export const OFFBOARDING_GRACE_DAYS = 90 // 猶予日数の既定
export const OFFBOARDING_GRACE_MIN = 30
export const OFFBOARDING_GRACE_MAX = 365
export const OFFBOARDING_EXPORT_PAGE = 500 // CSV の1回の取得の行数（Free プランの CPU 時間に収める）
const OFFBOARDING_DELETE_LIMIT = 500       // 1文で消す行数
const OFFBOARDING_QUERY_BUDGET = 25        // 1回の要求で実行する削除の問い合わせ・R2 の削除の上限
const OFFBOARDING_R2_CHUNK = 1000          // R2 の delete に1回で渡すキーの数
const OFFBOARDING_COUNT_COLS = 90          // 件数を数える1文の列の数（D1 の結果の列の上限 100 の内側）

export type OffboardingBuckets = { PHOTOS?: R2Bucket; DOCUMENTS?: R2Bucket; CONTRACTS?: R2Bucket }
export type OffboardingTable = {
  target: string; label: string
  table: string
  where: string        // $C を企業 ID に置き換える
  noExport?: boolean   // 書き出さない（トークン・セッション・既読の印など）
  noDelete?: boolean   // 削除しない（companies の行と、匿名化する users・staff_profiles）
}
const OB_USERS = `(SELECT user_id FROM users WHERE company_id = $C AND role != 'system_admin')`
const OB_STAFF = '(SELECT staff_id FROM staff_profiles WHERE company_id = $C)'
const OB_CO = 'company_id = $C'
const OB_NOTICES = 'notice_id IN (SELECT notice_id FROM notices WHERE company_id = $C)'
// 削除の順（参照する側が先）。書き出しにもこの一覧を使う
export const OFFBOARDING_TABLES: OffboardingTable[] = [
  { target: 'companies', label: '企業', table: 'companies', where: OB_CO, noDelete: true },
  { target: 'users', label: '利用者（パスワード・二段階認証の情報を除く）', table: 'users', where: `${OB_CO} AND role != 'system_admin'`, noDelete: true },
  { target: 'staff_profiles', label: 'スタッフ', table: 'staff_profiles', where: OB_CO, noDelete: true },
  { target: 'shift_report_tokens', label: '報告用URLのトークン', table: 'shift_report_tokens', where: OB_CO, noExport: true },
  // Sprint 5 で足した表（統合のときに追加）。参照する側を先に消す
  { target: 'attendance_correction_attachments', label: '打刻修正の添付写真', table: 'attendance_correction_attachments', where: OB_CO },
  { target: 'reminder_sends', label: '報告のリマインドの送信記録', table: 'reminder_sends', where: OB_CO, noExport: true },
  { target: 'staff_pay_requests', label: 'スタッフからの交通費・延長の申請', table: 'staff_pay_requests', where: OB_CO },
  { target: 'attendance_correction_events', label: '打刻修正の操作履歴', table: 'attendance_correction_events', where: OB_CO },
  { target: 'notification_emails', label: '打刻修正の通知メール', table: 'notification_emails', where: OB_CO },
  { target: 'attendance_corrections', label: '打刻修正の申請', table: 'attendance_corrections', where: OB_CO },
  { target: 'attendance_reports_duplicates_0036', label: '出退勤記録（重複の控え）', table: 'attendance_reports_duplicates_0036', where: OB_CO },
  { target: 'attendance_reports', label: '出退勤記録', table: 'attendance_reports', where: OB_CO },
  { target: 'daily_report_duplicates', label: '日報（重複の控え）', table: 'daily_report_duplicates', where: OB_CO },
  { target: 'daily_reports', label: '日報', table: 'daily_reports', where: OB_CO },
  { target: 'affiliation_excluded_shifts', label: '所属区分の対象外シフト', table: 'affiliation_excluded_shifts', where: OB_CO },
  { target: 'settlement_issue_acks', label: '精算の確認済みの印', table: 'settlement_issue_acks', where: OB_CO },
  { target: 'shift_cancellations', label: 'シフトの取消', table: 'shift_cancellations', where: OB_CO },
  { target: 'operation_logs', label: 'シフト・精算の操作履歴', table: 'operation_logs', where: OB_CO },
  { target: 'recruit_application_notes', label: '応募の対応メモ', table: 'recruit_application_notes', where: OB_CO },
  { target: 'recruit_application_items', label: '応募の明細', table: 'recruit_application_items',
    where: 'application_id IN (SELECT application_id FROM recruit_applications WHERE company_id = $C)' },
  { target: 'recruit_applications', label: '応募', table: 'recruit_applications', where: OB_CO },
  { target: 'recruit_pages', label: '募集ページ', table: 'recruit_pages', where: OB_CO },
  { target: 'shift_requests', label: 'シフト希望', table: 'shift_requests', where: OB_CO },
  { target: 'report_setting_logs', label: '報告設定の変更履歴', table: 'report_setting_logs', where: OB_CO },
  { target: 'project_staff_report_settings', label: '報告設定（スタッフ別）', table: 'project_staff_report_settings', where: OB_CO },
  { target: 'project_report_defaults', label: '報告設定（案件）', table: 'project_report_defaults', where: OB_CO },
  { target: 'project_cancel_policies', label: '案件のキャンセル規定', table: 'project_cancel_policies', where: OB_CO },
  { target: 'project_price_history', label: '案件の単価の履歴', table: 'project_price_history', where: OB_CO },
  { target: 'rate_rules', label: '単価ルール', table: 'rate_rules', where: OB_CO },
  { target: 'slot_patterns', label: '募集枠のパターン', table: 'slot_patterns', where: OB_CO },
  { target: 'shifts', label: 'シフト', table: 'shifts', where: OB_CO },
  { target: 'shift_slot_roles', label: '募集枠の役割', table: 'shift_slot_roles', where: 'slot_id IN (SELECT slot_id FROM shift_slots WHERE company_id = $C)' },
  { target: 'shift_slots', label: '募集枠', table: 'shift_slots', where: OB_CO },
  { target: 'evaluations', label: '評価', table: 'evaluations', where: OB_CO },
  { target: 'follow_logs', label: 'フォロー記録', table: 'follow_logs', where: OB_CO },
  { target: 'consultation_attachments', label: '相談の添付', table: 'consultation_attachments', where: OB_CO },
  { target: 'consultation_messages', label: '相談のやり取り', table: 'consultation_messages', where: OB_CO },
  { target: 'consultations', label: '相談', table: 'consultations', where: OB_CO },
  { target: 'employee_change_logs', label: '従業員データの変更履歴', table: 'employee_change_logs', where: OB_CO },
  { target: 'payout_accounts', label: '振込先の口座', table: 'payout_accounts', where: OB_CO },
  { target: 'payout_settings', label: '振込元（依頼人）の設定', table: 'payout_settings', where: OB_CO },
  // Sprint 6（w6-premium-pay）: 交通費の標準・割増の設定
  { target: 'staff_transport_defaults', label: '交通費の標準（スタッフ・開催場所）', table: 'staff_transport_defaults', where: OB_CO },
  { target: 'premium_pay_settings', label: '深夜・時間外・休日の割増の設定', table: 'premium_pay_settings', where: OB_CO },
  { target: 'profile_change_requests', label: '登録情報の変更申請', table: 'profile_change_requests', where: OB_CO },
  { target: 'leave_requests', label: '休暇の申請', table: 'leave_requests', where: OB_CO },
  { target: 'staff_availability', label: '出勤可能日', table: 'staff_availability', where: OB_CO },
  { target: 'availability_submissions', label: '出勤可能日の提出', table: 'availability_submissions', where: OB_CO },
  { target: 'availability_periods', label: '出勤可能日の締切', table: 'availability_periods', where: OB_CO },
  { target: 'staff_calendar_tokens', label: 'カレンダー購読のトークン', table: 'staff_calendar_tokens', where: OB_CO, noExport: true },
  { target: 'staff_schedule_tokens', label: 'シフト確認用URLのトークン', table: 'staff_schedule_tokens', where: OB_CO, noExport: true },
  { target: 'roster_link_events', label: '連携の成立・終了の記録（稼働先）', table: 'roster_link_events', where: OB_CO },
  { target: 'employee_records', label: '従業員データ（口座・住所・給与・保険番号など）', table: 'employee_records', where: OB_CO },
  { target: 'employment_periods', label: '雇用期間', table: 'employment_periods', where: OB_CO },
  { target: 'staff_documents', label: 'スタッフの書類', table: 'staff_documents', where: OB_CO },
  { target: 'employee_documents', label: '入社時書類', table: 'employee_documents', where: OB_CO },
  { target: 'staff_affiliation_history', label: '所属区分の変更履歴', table: 'staff_affiliation_history', where: OB_CO },
  { target: 'staff_affiliation_schedules', label: '所属区分の変更の予約', table: 'staff_affiliation_schedules', where: OB_CO },
  { target: 'staff_quick_locks', label: 'スタッフ登録の重複防止', table: 'staff_quick_locks', where: OB_CO, noExport: true },
  { target: 'staff_merges', label: 'スタッフの統合の記録', table: 'staff_merges', where: OB_CO },
  { target: 'roster_value_fixes', label: '名簿の値の補正', table: 'roster_value_fixes', where: `staff_id IN ${OB_STAFF}` },
  { target: 'notice_read_staff_reports', label: '既読率（スタッフ別）', table: 'notice_read_staff_reports', where: OB_CO },
  { target: 'notice_read_reports', label: '既読率レポート', table: 'notice_read_reports', where: OB_CO },
  { target: 'notice_responses', label: 'お知らせへの回答', table: 'notice_responses', where: OB_CO },
  { target: 'notice_attachments', label: 'お知らせの添付', table: 'notice_attachments', where: OB_CO },
  { target: 'notice_revisions', label: 'お知らせの変更履歴', table: 'notice_revisions', where: OB_CO },
  { target: 'notice_reads', label: 'お知らせの既読', table: 'notice_reads', where: OB_NOTICES },
  { target: 'notice_targets', label: 'お知らせの配信対象', table: 'notice_targets', where: OB_NOTICES },
  { target: 'notice_ack_tokens', label: 'お知らせの確認用トークン', table: 'notice_ack_tokens', where: OB_CO, noExport: true },
  { target: 'notice_email_deliveries', label: 'お知らせのメール送信', table: 'notice_email_deliveries', where: OB_CO },
  { target: 'notices', label: 'お知らせ', table: 'notices', where: OB_CO },
  // Sprint 6 で足した表（w6-push）。購読の宛先（endpoint）は端末に送るための鍵なので書き出さない
  { target: 'push_queue', label: 'プッシュ通知の送信待ち', table: 'push_queue', where: OB_CO, noExport: true },
  { target: 'push_subscriptions', label: 'プッシュ通知の購読（端末）', table: 'push_subscriptions', where: OB_CO, noExport: true },
  { target: 'user_notification_prefs', label: '通知の受け取り設定', table: 'user_notification_prefs', where: OB_CO },
  { target: 'user_notifications', label: 'アプリ内の通知', table: 'user_notifications', where: OB_CO },
  { target: 'todo_dismissals', label: 'ToDo の非表示', table: 'todo_dismissals', where: OB_CO, noExport: true },
  { target: 'client_ng_staff', label: 'クライアントの NG スタッフ', table: 'client_ng_staff', where: OB_CO },
  { target: 'client_contacts', label: 'クライアントの担当者', table: 'client_contacts', where: OB_CO },
  { target: 'client_documents', label: 'クライアントの契約書類', table: 'client_documents', where: OB_CO },
  { target: 'sites', label: '開催場所', table: 'sites', where: OB_CO },
  { target: 'projects', label: '案件', table: 'projects', where: OB_CO },
  { target: 'clients', label: 'クライアント', table: 'clients', where: OB_CO },
  { target: 'settlement_closings', label: '精算の締め', table: 'settlement_closings', where: OB_CO },
  { target: 'settlement_export_logs', label: '精算の出力の記録', table: 'settlement_export_logs', where: OB_CO },
  { target: 'staff_affiliations', label: '所属先（取引先）', table: 'staff_affiliations', where: OB_CO },
  { target: 'roster_field_requirements', label: '名簿の必須項目', table: 'roster_field_requirements', where: OB_CO },
  { target: 'report_templates', label: '日報テンプレート（企業）', table: 'report_templates', where: OB_CO },
  { target: 'roster_host_note_history', label: '稼働先メモの履歴', table: 'roster_host_note_history', where: OB_CO },
  { target: 'roster_comment_reads', label: '企業間チャットの既読（会社）', table: 'roster_comment_reads', where: OB_CO, noExport: true },
  { target: 'roster_comment_user_reads', label: '企業間チャットの既読（利用者）', table: 'roster_comment_user_reads', where: OB_CO, noExport: true },
  { target: 'roster_host_note_seen', label: '稼働先メモの既読', table: 'roster_host_note_seen', where: `user_id IN ${OB_USERS}`, noExport: true },
  { target: 'board_thread_reads', label: '掲示板の既読（会社）', table: 'board_thread_reads', where: OB_CO, noExport: true },
  { target: 'board_saved_searches', label: '掲示板の保存した検索条件', table: 'board_saved_searches', where: OB_CO },
  { target: 'board_thread_user_reads', label: '掲示板の既読（利用者）', table: 'board_thread_user_reads', where: `user_id IN ${OB_USERS}`, noExport: true },
  { target: 'support_requests', label: '本部への支援の依頼', table: 'support_requests', where: OB_CO },
  { target: 'hq_announcement_reads', label: '本部のお知らせの既読', table: 'hq_announcement_reads', where: OB_CO, noExport: true },
  { target: 'email_logs', label: 'メールの送信記録', table: 'email_logs', where: OB_CO },
  { target: 'sessions', label: 'ログイン中のセッション', table: 'sessions', where: `${OB_CO} OR user_id IN ${OB_USERS}`, noExport: true },
  { target: 'password_reset_tokens', label: 'パスワード再設定のトークン', table: 'password_reset_tokens', where: `user_id IN ${OB_USERS}`, noExport: true },
  { target: 'login_email_verifications', label: 'メールアドレスの確認', table: 'login_email_verifications', where: OB_CO, noExport: true },
  { target: 'mfa_challenges', label: '二段階認証の確認中', table: 'mfa_challenges', where: `user_id IN ${OB_USERS}`, noExport: true },
]
// 企業の行を持つが削除しない表（他社と共有する記録・ログインの履歴・解約の記録）。「未対応の表」の判定から外す
// 本部の記録（請求・対応の記録・操作の監査・閲覧の記録・お知らせの配信先）も、解約の後の確認のために残す（Sprint 5 の統合で追加）
const OFFBOARDING_KEPT_TABLES = ['login_events', 'roster_consents', 'board_posts', 'company_offboardings', 'company_offboarding_events',
  'company_billing_months', 'company_support_logs', 'hq_audit_logs', 'hq_view_sessions', 'hq_announcement_companies']
// 書き出しで出さない列（ログインの秘密の情報と、他社との連携に使う鍵）
const OFFBOARDING_SECRET_COL_RE = /password|secret|token|recovery|totp|link_key|relink_code/i

// R2 のファイル（写真・書類）。source は元の表（ファイルの取得は表と行の ID で行う）
type ObFileSource = { source: string; bucket: 'photos' | 'documents' | 'contracts'; idCol: string; keyCol: string; nameCol: string | null; whenCol: string; refCol: string }
export const OFFBOARDING_FILE_SOURCES: ObFileSource[] = [
  { source: 'attendance_reports', bucket: 'photos', idCol: 'attendance_id', keyCol: 'photo_key', nameCol: null, whenCol: 'reported_at', refCol: 'staff_id' },
  // 0036 で重複として退避した出退勤の行にも写真のキーが残っている
  { source: 'attendance_reports_duplicates_0036', bucket: 'photos', idCol: 'attendance_id', keyCol: 'photo_key', nameCol: null, whenCol: 'reported_at', refCol: 'staff_id' },
  { source: 'staff_documents', bucket: 'documents', idCol: 'document_id', keyCol: 'storage_key', nameCol: 'original_file_name', whenCol: 'uploaded_at', refCol: 'staff_id' },
  { source: 'employee_documents', bucket: 'documents', idCol: 'document_id', keyCol: 'storage_key', nameCol: 'original_file_name', whenCol: 'uploaded_at', refCol: 'staff_id' },
  { source: 'attendance_correction_attachments', bucket: 'photos', idCol: 'attachment_id', keyCol: 'photo_key', nameCol: null, whenCol: 'created_at', refCol: 'staff_id' },
  { source: 'consultation_attachments', bucket: 'photos', idCol: 'attachment_id', keyCol: 'storage_key', nameCol: null, whenCol: 'created_at', refCol: 'consultation_id' },
  { source: 'notice_attachments', bucket: 'documents', idCol: 'attachment_id', keyCol: 'storage_key', nameCol: 'file_name', whenCol: 'created_at', refCol: 'notice_id' },
  { source: 'client_documents', bucket: 'contracts', idCol: 'document_id', keyCol: 'storage_key', nameCol: 'original_file_name', whenCol: 'uploaded_at', refCol: 'client_id' },
]
export function offboardingBucket(buckets: OffboardingBuckets, bucket: string): R2Bucket | undefined {
  return bucket === 'documents' ? buckets.DOCUMENTS : bucket === 'contracts' ? buckets.CONTRACTS : buckets.PHOTOS
}

// $C を ? にした条件（括弧で囲む）と、バインドする値（企業 ID を $C の数だけ）
function obWhere(where: string, companyId: number): { sql: string; binds: number[] } {
  const parts = where.split('$C')
  return { sql: `(${parts.join('?')})`, binds: Array(parts.length - 1).fill(companyId) }
}

/**
 * 企業のデータの件数（表ごと・R2 のファイルの元の表ごと）。問い合わせの回数を抑えるため1文で数える（企業 ID は WITH で1回だけ渡す）。
 * あわせて、企業の行（company_id 列）を持つのに OFFBOARDING_TABLES にない表（未対応の表）を返す
 */
export async function countOffboardingData(db: D1Database, companyId: number): Promise<{ counts: Record<string, number>; files: Record<string, number>; unknown_tables: string[] | null }> {
  const cid = '(SELECT cid FROM k)'
  const cols = [
    ...OFFBOARDING_TABLES.map((t, i) => `(SELECT COUNT(*) FROM ${t.table} WHERE (${t.where.split('$C').join(cid)})) AS t${i}`),
    ...OFFBOARDING_FILE_SOURCES.map((f, i) => `(SELECT COUNT(*) FROM ${f.source} WHERE company_id = ${cid} AND ${f.keyCol} IS NOT NULL) AS f${i}`),
  ]
  // D1 は1つの結果の列を 100 までしか返せないので、OFFBOARDING_COUNT_COLS 列ずつの文に分けて1回の batch で数える（表を足して 100 を超えたため。w6-push）
  const parts: string[][] = []
  for (let i = 0; i < cols.length; i += OFFBOARDING_COUNT_COLS) parts.push(cols.slice(i, i + OFFBOARDING_COUNT_COLS))
  const got = await db.batch(parts.map(part => db.prepare(`WITH k(cid) AS (SELECT ?) SELECT ${part.join(', ')}`).bind(companyId)))
  const row = Object.assign({}, ...got.map(r => ((r.results || [])[0] || {}) as Record<string, number>)) as Record<string, number>
  const counts: Record<string, number> = {}
  OFFBOARDING_TABLES.forEach((t, i) => { counts[t.target] = Number(row?.[`t${i}`]) || 0 })
  const files: Record<string, number> = {}
  OFFBOARDING_FILE_SOURCES.forEach((f, i) => { files[f.source] = Number(row?.[`f${i}`]) || 0 })
  return { counts, files, unknown_tables: await findUnknownOffboardingTables(db) }
}

/** 企業の行（company_id 列）を持つのに OFFBOARDING_TABLES にない表（未対応の表）。確かめられなかったときは null */
export async function findUnknownOffboardingTables(db: D1Database): Promise<string[] | null> {
  try {
    const known = new Set([...OFFBOARDING_TABLES.map(t => t.table), ...OFFBOARDING_KEPT_TABLES])
    // D1 では pragma_table_info を問い合わせの中で使えないため、表の定義（ALTER TABLE で足した列も含む）の文字列で判定する。
    // 列の定義（company_id INTEGER など）だけを見て、外部キーの参照（REFERENCES companies(company_id)）は数えない
    const rows = (await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`).all()).results as { name: string; sql: string | null }[]
    return rows.filter(r => /(?:^|[(,])\s*"?company_id"?\s+\w/m.test(r.sql || ''))
      .map(r => r.name).filter(n => !known.has(n) && !/^(sqlite_|_cf_|d1_)/.test(n))
  } catch (e) {
    console.log(`offboarding: table check failed: ${e}`)
    return null
  }
}

/** 書き出し: 表の行を rowid の順に offset から OFFBOARDING_EXPORT_PAGE 行まで返す（秘密の列は除く）。書き出さない表は null */
export async function exportOffboardingTablePage(db: D1Database, companyId: number, target: string, offset: number): Promise<{ header: string[]; rows: unknown[][]; label: string } | null> {
  const t = OFFBOARDING_TABLES.find(x => x.target === target && !x.noExport)
  if (!t) return null
  const w = obWhere(t.where, companyId)
  const got = (await db.prepare(`SELECT * FROM ${t.table} WHERE ${w.sql} ORDER BY rowid LIMIT ? OFFSET ?`)
    .bind(...w.binds, OFFBOARDING_EXPORT_PAGE, offset).all()).results as Record<string, unknown>[]
  const header = got.length ? Object.keys(got[0]).filter(k => !OFFBOARDING_SECRET_COL_RE.test(k)) : []
  return { header, rows: got.map(r => header.map(h => r[h])), label: t.label }
}

export type OffboardingFile = { source: string; bucket: string; id: number; r2_key: string; file_name: string | null; created_at: string | null; ref_id: number | null }
/** R2 のファイルの一覧（offset から limit 件） */
export async function listOffboardingFiles(db: D1Database, companyId: number, offset: number, limit: number): Promise<OffboardingFile[]> {
  // 元の表ごとの件数を1文で数え、ページにかかる表だけを、表の名前・ID の順に取る。
  // 元の表が増えて UNION ALL でまとめると D1 の上限（too many terms in compound SELECT）に当たるため、表ごとに問い合わせる
  const sources = [...OFFBOARDING_FILE_SOURCES].sort((x, y) => x.source < y.source ? -1 : x.source > y.source ? 1 : 0)
  const cnt = await db.prepare(`WITH k(cid) AS (SELECT ?) SELECT ${sources.map((f, i) =>
    `(SELECT COUNT(*) FROM ${f.source} WHERE company_id = (SELECT cid FROM k) AND ${f.keyCol} IS NOT NULL) AS c${i}`).join(', ')}`).bind(companyId).first() as Record<string, number> | null
  const out: OffboardingFile[] = []
  let skip = Math.max(0, offset), want = Math.max(0, limit)
  for (let i = 0; i < sources.length && want > 0; i++) {
    const n = Number(cnt?.[`c${i}`]) || 0
    if (skip >= n) { skip -= n; continue }
    const f = sources[i]
    const rows = (await db.prepare(`SELECT '${f.source}' AS source, '${f.bucket}' AS bucket, ${f.idCol} AS id, ${f.keyCol} AS r2_key,
        ${f.nameCol || 'NULL'} AS file_name, ${f.whenCol} AS created_at, ${f.refCol} AS ref_id
      FROM ${f.source} WHERE company_id = ? AND ${f.keyCol} IS NOT NULL ORDER BY ${f.idCol} LIMIT ? OFFSET ?`).bind(companyId, want, skip).all()).results as OffboardingFile[]
    out.push(...rows); want -= rows.length; skip = 0
  }
  return out
}

/** R2 のファイル1件（元の表と行の ID で、その企業のものだけ） */
export async function findOffboardingFile(db: D1Database, companyId: number, source: string, id: number): Promise<OffboardingFile | null> {
  const f = OFFBOARDING_FILE_SOURCES.find(x => x.source === source)
  if (!f) return null
  return await db.prepare(`SELECT '${f.source}' AS source, '${f.bucket}' AS bucket, ${f.idCol} AS id, ${f.keyCol} AS r2_key,
      ${f.nameCol || 'NULL'} AS file_name, ${f.whenCol} AS created_at, ${f.refCol} AS ref_id
    FROM ${f.source} WHERE company_id = ? AND ${f.idCol} = ? AND ${f.keyCol} IS NOT NULL`).bind(companyId, id).first() as OffboardingFile | null
}

// 削除の段階: 0 = R2 のキーを控える、1..N = 表の削除（noDelete を除く）、N+1 = 匿名化、N+2 = R2 の削除、N+3 = 完了
const OB_DELETE_TABLES = OFFBOARDING_TABLES.filter(t => !t.noDelete)
export const OFFBOARDING_TOTAL_STEPS = OB_DELETE_TABLES.length + 3

export type OffboardingProgress = { done: boolean; step: number; total_steps: number; deleted: Record<string, number>; r2_left: number; error: string | null }

/**
 * 企業のデータの削除を1回の要求で処理できる量だけ進め、進み具合を company_offboardings に保存する。
 * 呼び出し側で、状態（deleting）・猶予・企業の停止・二重の確認を確かめてから呼ぶ。
 * 同時に呼ばれても段階を二重に進めないよう、保存は読んだときの段階のままのときだけ行う。
 */
export async function runOffboardingDeletion(db: D1Database, buckets: OffboardingBuckets,
  ob: { offboarding_id: number; company_id: number; delete_step: number; deleted_json: string | null }): Promise<OffboardingProgress> {
  const cid = Number(ob.company_id)
  const oid = Number(ob.offboarding_id)
  const startStep = Number(ob.delete_step) || 0
  let step = startStep
  let deleted: Record<string, number> = {}
  try { deleted = JSON.parse(ob.deleted_json || '{}') || {} } catch { deleted = {} }
  const add = (k: string, n: number) => { deleted[k] = (deleted[k] || 0) + n }
  const N = OB_DELETE_TABLES.length
  let used = 0
  let error: string | null = null
  try {
    while (used < OFFBOARDING_QUERY_BUDGET && step < N + 3) {
      if (step === 0) {
        // R2 のキーを控える（D1 の行を消すとキーが分からなくなるため、最初にまとめて控える）
        await db.batch(OFFBOARDING_FILE_SOURCES.map(f => db.prepare(`INSERT OR IGNORE INTO offboarding_pending_r2 (bucket, r2_key, offboarding_id)
          SELECT '${f.bucket}', ${f.keyCol}, ? FROM ${f.source} WHERE company_id = ? AND ${f.keyCol} IS NOT NULL`).bind(oid, cid)))
        used++; step++
      } else if (step <= N) {
        const t = OB_DELETE_TABLES[step - 1]
        const w = obWhere(t.where, cid)
        const r = await db.prepare(`DELETE FROM ${t.table} WHERE rowid IN (SELECT rowid FROM ${t.table} WHERE ${w.sql} LIMIT ${OFFBOARDING_DELETE_LIMIT})`)
          .bind(...w.binds).run()
        used++
        const n = r.meta.changes || 0
        add(t.target, n)
        if (n < OFFBOARDING_DELETE_LIMIT) step++
      } else if (step === N + 1) {
        // 利用者とスタッフの匿名化（行は他社の連携行・企業間チャット・掲示板などから参照されるため残す）
        const anonymizeCols = ANONYMIZE_PROFILE_COLUMNS.map(col => `${col} = NULL`).join(', ')
        const r = await db.batch([
          db.prepare(`UPDATE users SET name = '解約企業の利用者#' || user_id, email = NULL, phone = NULL, password_hash = '!anonymized', status = 'suspended',
              totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, mfa_recovery_codes = NULL
            WHERE company_id = ? AND role != 'system_admin' AND password_hash != '!anonymized'`).bind(cid),
          db.prepare(`UPDATE staff_profiles SET ${anonymizeCols}, anonymized_at = COALESCE(anonymized_at, ?) WHERE company_id = ?`).bind(nowJST(), cid),
        ])
        used++
        add('anonymized_users', r[0].meta.changes || 0)
        add('anonymized_staff', r[1].meta.changes || 0)
        step++
      } else {
        // D1 の削除が済んでから R2 のファイルを消す。消せたものから控えを消す
        const rows = (await db.prepare('SELECT bucket, r2_key FROM offboarding_pending_r2 WHERE offboarding_id = ? ORDER BY bucket, r2_key LIMIT ?')
          .bind(oid, OFFBOARDING_R2_CHUNK).all()).results as { bucket: string; r2_key: string }[]
        used++
        if (!rows.length) { step++; break }
        for (const b of ['photos', 'documents', 'contracts']) {
          const keys = rows.filter(r => r.bucket === b).map(r => r.r2_key)
          if (!keys.length) continue
          const bucket = offboardingBucket(buckets, b)
          if (!bucket) throw new Error(`R2 のバケット（${b}）が設定されていません`)
          await bucket.delete(keys)
          await db.prepare('DELETE FROM offboarding_pending_r2 WHERE bucket = ? AND r2_key IN (SELECT value FROM json_each(?))').bind(b, JSON.stringify(keys)).run()
          used += 2
          add(`r2_${b}`, keys.length)
        }
      }
    }
  } catch (e) {
    error = `段階 ${step}: ${String(e)}`.slice(0, 1000)
    console.log(`offboarding: company_id=${cid} failed at step ${step}: ${e}`)
  }
  const done = step >= N + 3
  const left = await db.prepare('SELECT COUNT(*) AS n FROM offboarding_pending_r2 WHERE offboarding_id = ?').bind(oid).first() as { n: number } | null
  await db.prepare(`UPDATE company_offboardings SET delete_step = ?, deleted_json = ?, last_error = ?,
      status = CASE WHEN ? = 1 THEN 'completed' ELSE status END, completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
    WHERE offboarding_id = ? AND delete_step = ? AND status = 'deleting'`)
    .bind(step, JSON.stringify(deleted), error, done ? 1 : 0, done ? 1 : 0, new Date().toISOString(), oid, startStep).run()
  return { done, step, total_steps: OFFBOARDING_TOTAL_STEPS, deleted, r2_left: Number(left?.n) || 0, error }
}
