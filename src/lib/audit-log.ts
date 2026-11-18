// 操作の記録（Sprint 31 w31-audit: #9988。表は migrations/0115_audit_logs.sql の audit_logs）。
// 利用者の要望（11/17）「CSV出力や諸々の操作履歴もわかるようにして欲しい」。
//
// - 書き込みは /api/admin/* のミドルウェア（auditMiddleware）だけが行い、1操作1行にする（無料プランの書き込みの枠のため）。
//   1. CSV・ファイルの書き出し: GET の応答が Content-Disposition: attachment なら、だれが・どのファイルを・どの条件で・何行出したかを残す
//      （行数は csvResponse が付ける X-Export-Rows。画面で作る CSV は POST /api/admin/export-logs で画面から知らせる）
//   2. 管理の操作: 下の AUDIT_ROUTES に書いた書き込みの API が成功したら残す。snap のある操作は、前後の値を1行だけ読んで比べ、
//      変わった項目と前後の値を detail_json に入れる（口座などの秘密の値は「変更あり」だけ）
// - 本部の閲覧中（system_admin。読み取りだけ）の書き出しも、その企業の記録に「本部」として残す
// - 記録に失敗しても操作は止めない
// - シフト・精算の操作履歴（operation_logs）とログインの履歴（login_events）は作り直さず、画面で読むときに合わせて出す（src/audit-logs.ts）
import { nowJST } from './time'
import { CHANGE_FIELD_LABELS, MASKED_FIELDS } from './change-log'
import { ROLE_LABELS, ADMIN_ROLES } from './permissions'

/** 保存の期間（login_events と同じ1年。src/lib/auth.ts の purgeExpiredAuthRows で消す） */
export const AUDIT_KEEP_DAYS = 365

/** 種類（画面の絞り込みの選択肢。login・shift は読むときに合わせる表） */
export const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  csv: 'CSV・ファイル', staff: 'スタッフ・従業員', admin: '管理者・ログインの発行', settings: '設定', master: '案件・クライアント', notice: 'お知らせ',
  shift: 'シフト・精算', login: 'ログイン',
}

// ---------- 対象の名前 ----------
// 対象の種類ごとに、その時点の名前を読む文（? は ID と会社）。削除は消す前に、作成は作った後に読む
const TARGET_NAME_SQL: Record<string, string> = {
  staff: 'SELECT us.name AS n FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ? AND sp.company_id = ?',
  user: 'SELECT name AS n FROM users WHERE user_id = ? AND company_id = ?',
  project: 'SELECT project_name AS n FROM projects WHERE project_id = ? AND company_id = ?',
  client: 'SELECT client_name AS n FROM clients WHERE client_id = ? AND company_id = ?',
  notice: 'SELECT title AS n FROM notices WHERE notice_id = ? AND company_id = ?',
  partner: 'SELECT affiliation_name AS n FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?',
  site: 'SELECT site_name AS n FROM sites WHERE site_id = ? AND company_id = ?',
  template: 'SELECT template_name AS n FROM report_templates WHERE template_id = ? AND company_id = ?',
}
export const AUDIT_TARGET_LABELS: Record<string, string> = {
  staff: 'スタッフ', user: '管理者', project: '案件', client: 'クライアント', notice: 'お知らせ', partner: '協力会社', site: '開催場所', template: '日報テンプレート', company: '会社',
}

// ---------- 前後の値（snap） ----------
// 1行を読む文。_n は対象の名前。company: true は会社の行（? は会社だけ）。flatten の列は JSON を開いて項目ごとに比べる
type SnapDef = { sql: string; company?: true; flatten?: string }
const STAFF_COLS = `us.name AS _n, us.name, us.email, us.phone, us.status AS login_status, us.retired_at, sp.kana, sp.gender, sp.date_of_birth, sp.age_entered,
  sp.affiliation, sp.affiliation_contact, sp.nearest_station_line, sp.nearest_station, sp.commute_minutes, sp.available_from, sp.work_area, sp.skills,
  sp.employment_status, sp.follow_flag, sp.retention_risk, sp.memo, sp.attendance_mode, sp.daily_report_mode, sp.availability_exempt, sp.pr_points, sp.remarks,
  sp.site_evaluation, sp.work_memo, sp.reference_pay_unit, sp.reference_pay_amount`
const STAFF_FROM = 'staff_profiles sp JOIN users us ON us.user_id = sp.user_id'
const SNAPS: Record<string, SnapDef> = {
  company: { sql: 'SELECT company_name AS _n, settings_json, emergency_phone, emergency_note, shift_notify_default FROM companies WHERE company_id = ?', company: true, flatten: 'settings_json' },
  premium: { sql: 'SELECT * FROM premium_pay_settings WHERE company_id = ?', company: true },
  payout: { sql: 'SELECT * FROM payout_settings WHERE company_id = ?', company: true },
  staff: { sql: `SELECT ${STAFF_COLS} FROM ${STAFF_FROM} WHERE sp.staff_id = ? AND sp.company_id = ?` },
  employee: { sql: `SELECT ${STAFF_COLS}, er.* FROM ${STAFF_FROM} LEFT JOIN employee_records er ON er.staff_id = sp.staff_id AND er.company_id = sp.company_id
    WHERE sp.staff_id = ? AND sp.company_id = ?` },
  payout_account: { sql: `SELECT (SELECT us.name FROM ${STAFF_FROM} WHERE sp.staff_id = pa.staff_id) AS _n, pa.* FROM payout_accounts pa WHERE pa.staff_id = ? AND pa.company_id = ?` },
  user: { sql: 'SELECT name AS _n, user_code, name, email, role, status FROM users WHERE user_id = ? AND company_id = ?' },
  project: { sql: 'SELECT project_name AS _n, * FROM projects WHERE project_id = ? AND company_id = ?' },
  client: { sql: 'SELECT client_name AS _n, * FROM clients WHERE client_id = ? AND company_id = ?' },
  notice: { sql: 'SELECT title AS _n, * FROM notices WHERE notice_id = ? AND company_id = ?' },
  partner: { sql: 'SELECT affiliation_name AS _n, * FROM staff_affiliations WHERE affiliation_id = ? AND company_id = ?' },
  site: { sql: 'SELECT site_name AS _n, * FROM sites WHERE site_id = ? AND company_id = ?' },
  template: { sql: 'SELECT template_name AS _n, template_name, template_type, status, fields_json FROM report_templates WHERE template_id = ? AND company_id = ?' },
}
// 比べない列（ID・日時・更新した人・ログインの秘密の情報）
const OMIT_COLS = new Set(['_n', 'company_id', 'staff_id', 'user_id', 'project_id', 'client_id', 'notice_id', 'affiliation_id', 'site_id', 'template_id', 'person_id',
  'account_id', 'employee_record_id',
  'created_at', 'updated_at', 'updated_by', 'created_by', 'photo_required_history', 'reads_purged_at', 'final_read_count', 'final_target_count',
  'host_note_updated_at', 'retention_flagged_at', 'retention_attempted_at', 'shift_notify_updated_at', 'shift_notify_updated_by', 'report_defaults_version'])
const OMIT_RE = /password|secret|token|totp|recovery|link_key|relink_code|_hash$|_history$/i
// 値を残さず「変更あり」だけを残す列（口座・保険番号・振込元）
const SECRET_COLS = new Set([...MASKED_FIELDS, 'bank_code', 'bank_name', 'branch_code', 'branch_name', 'account_type', 'account_number', 'holder_kana',
  'requester_code', 'requester_kana'])
const VALUE_MAX = 120

// 項目の表示名（従業員・スタッフ基本情報は変更履歴の表示名を使う）
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  ...CHANGE_FIELD_LABELS,
  email: 'メールアドレス', phone: '電話番号', login_status: 'ログインの状態', user_code: 'ID', role: '権限', status: '状態',
  follow_flag: '要フォロー', retention_risk: '離職リスク', memo: 'メモ', attendance_mode: '打刻の方法', daily_report_mode: '日報の提出',
  availability_exempt: '出勤可能日の提出をしない', pr_points: '経験・スキル・PRポイント', remarks: '備考', site_evaluation: '現場評価', work_memo: '稼働メモ',
  reference_pay_unit: '参考の支払の単位', reference_pay_amount: '参考の支払額', holder_kana: '口座名義（カナ）',
  // 会社の設定（companies と settings_json の項目）
  security_mfa_required: '二段階認証の必須', security_ip_allowlist: 'ログインできる接続元', photo_skip_allowed: '写真なしの打刻の許可',
  photo_required_attendance: '打刻の写真の必須', late_grace_minutes: '遅刻の猶予（分）', check_in_far_meters: '打刻の位置ずれの目安（m）',
  emergency_phone: '緊急連絡先', emergency_note: '緊急連絡先のメモ', correction_deadline_days: '打刻修正の期限（日）', mail_reply_to: 'メールの返信先',
  mail_contact_phone: 'メールの問い合わせ先の電話', reminders: 'リマインドの設定', day_before_check: '前日確認', hq_view_allowed: '本部の閲覧の許可',
  staff_pay_visible: 'スタッフへの支払額の表示', shift_notify_default: 'シフトの通知の既定', ranking_visible: 'ランキングの表示',
  ranking_anonymous: 'ランキングの匿名', show_coworkers: '同じ現場の人の表示',
  // 割増・振込元
  enabled: '割増の計算', night_rate: '深夜の割増率', overtime_rate: '時間外の割増率', holiday_rate: '休日の割増率', holiday_weekdays: '休日の曜日',
  daily_limit_minutes: '1日の所定の時間（分）', requester_code: '依頼人コード', requester_kana: '依頼人名（カナ）',
  // 案件
  project_name: '案件名', project_type: '案件の種類', location: '場所', location_lat: '緯度', location_lng: '経度', unit_price_type: '請求の単位', unit_price: '請求単価',
  required_skills: '必要なスキル', report_template_id: '日報テンプレート', show_performance: '実績の表示', manual_text: 'マニュアル', requirements: '条件',
  photo_required_override: '打刻の写真の必須（案件）', engagement_type: '契約の形', pay_unit_type: '支払の単位', pay_rate: '支払単価',
  bill_transport_type: '交通費の請求の方法', bill_transport_amount: '交通費の請求額', pay_transport_type: '交通費の支払の方法', pay_transport_amount: '交通費の支払額',
  default_break_minutes: '休憩（分）', hours_basis: '時間の数え方', time_round_minutes: '時間の丸め（分）', price_valid_from: '単価の適用開始日',
  pay_time_round: '支払の時間の丸め', closed_at: '終了した日時', closed_by: '終了した人', performance_goals_json: '目標', site_contact_name: '現場の連絡先（名前）',
  site_contact_phone: '現場の連絡先（電話）', past_report_fields_json: '日報の古い項目',
  // クライアント
  client_name: 'クライアント名', client_name_kana: 'クライアント名（フリガナ）', stream_type: '区分', contact_name: '担当者', address: '住所',
  billing_rule: '請求の決まり', ng_staff_ids: 'NGスタッフ', client_rating: '評価', representative_title: '代表者の役職', representative_name: '代表者',
  representative_kana: '代表者（フリガナ）', invoice_number: 'インボイスの登録番号', billing_closing_day: '締め日', client_kind: '種別', department_name: '部署',
  website_url: 'Webサイト',
  // お知らせ
  title: '件名', body: '本文', target_type: '配信先', target_ids: '配信先（個別）', importance: '重要度', read_required: '既読の確認',
  published_at: '配信日時', expires_at: '掲載の期限', send_email: 'メールでも送る', response_options: '回答の選択肢', response_comment: '回答のコメント',
  withdrawn_at: '取り下げた日時', withdrawn_by: '取り下げた人', withdraw_reason: '取り下げの理由', email_nologin: 'ログインのない人にメール',
  reminded_at: '再通知した日時', remind_count: '再通知の回数', created_by_name: '作成した人',
  // 協力会社・開催場所・テンプレート
  affiliation_name: '会社名', affiliation_name_kana: '会社名（フリガナ）', company_phone: '会社の電話', company_email: '会社のメール', payment_rule: '支払の決まり',
  partner_rating: '評価', partner_kind: '種別', internal_contact_name: '社内の担当者', contact_department: '担当者の部署', contact_name_kana: '担当者（フリガナ）',
  merged_into_id: '統合先', site_name: '開催場所', lat: '緯度', lng: '経度', template_name: 'テンプレート名', template_type: 'テンプレートの種類', fields_json: '項目',
}

export type AuditChange = { f: string; l: string; b?: string | null; a?: string | null; s?: 1 }
function asText(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > VALUE_MAX ? s.slice(0, VALUE_MAX) + '…' : s
}
function flat(row: Record<string, unknown> | null, def: SnapDef | undefined): Record<string, unknown> | null {
  if (!row) return null
  if (!def?.flatten) return row
  const out: Record<string, unknown> = { ...row }
  delete out[def.flatten]
  try {
    const o = JSON.parse(String(row[def.flatten] || '{}'))
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) out[k] = v
  } catch { /* 読めない JSON は比べない */ }
  return out
}
/** 前後の行から、変わった項目を作る（秘密の列は「変更あり」の印だけ） */
export function auditDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): AuditChange[] {
  if (!before && !after) return []
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
  const out: AuditChange[] = []
  for (const k of keys) {
    if (OMIT_COLS.has(k) || OMIT_RE.test(k)) continue
    const b = before ? before[k] : undefined, a = after ? after[k] : undefined
    const bs = b === undefined || b === null || b === '' ? null : JSON.stringify(b), as = a === undefined || a === null || a === '' ? null : JSON.stringify(a)
    if (bs === as) continue
    // 数値の 1 と '1'、1.0 と 1 などは同じとみなす
    if (bs !== null && as !== null && Number.isFinite(Number(b)) && Number.isFinite(Number(a)) && typeof b !== 'object' && typeof a !== 'object' && Number(b) === Number(a)) continue
    const label = AUDIT_FIELD_LABELS[k] || k
    out.push(SECRET_COLS.has(k) ? { f: k, l: label, s: 1 } : { f: k, l: label, b: asText(b), a: asText(a) })
  }
  return out
}

// ---------- 記録する操作の一覧 ----------
type AuditCtx = { method: string; path: string; query: Record<string, string>; body: any; json: any; changes: AuditChange[] }
export type AuditRoute = {
  m: string
  /** /api/admin の後ろのパス。:id は数字（1つ目が対象の ID。2つ目以降は使わない） */
  p: string
  cat: string
  action: string
  label: string | ((x: AuditCtx) => string)
  /** 対象の種類（TARGET_NAME_SQL のキー）。company は会社の行 */
  target?: string
  /** 作った行の ID を応答の JSON のこのキーから取る（作成） */
  idKey?: string
  /** 前後の値を比べる（SNAPS のキー） */
  snap?: string
  /** 送られた本文から detail に写す値（[キー, 表示名]。パスワードなどは入れない）。対象の種類を付けると名前にする */
  body?: [string, string, string?][]
  /** 応答の JSON から detail に足す内容 */
  res?: (j: any) => Record<string, unknown> | null
  /** 削除（消す前に名前を読む） */
  del?: true
}
const retiredLabel = (base: string) => (x: AuditCtx) => x.changes.some(ch => ch.f === 'employment_status' && ch.a === 'retired') ? '退職の設定' : base
export const AUDIT_ROUTES: AuditRoute[] = [
  // ---- スタッフ・従業員 ----
  { m: 'POST', p: '/roster', cat: 'staff', action: 'staff_create', label: 'スタッフの登録', target: 'staff', idKey: 'staff_id' },
  { m: 'POST', p: '/staff', cat: 'staff', action: 'staff_create', label: 'スタッフの登録', target: 'staff' },
  { m: 'POST', p: '/staff-quick', cat: 'staff', action: 'staff_quick', label: 'スタッフの仮登録', target: 'staff', idKey: 'staff_id' },
  { m: 'POST', p: '/staff/:id/finalize', cat: 'staff', action: 'staff_finalize', label: 'スタッフの本登録', target: 'staff' },
  { m: 'POST', p: '/roster/import/commit', cat: 'staff', action: 'staff_import', label: 'スタッフの一括登録',
    res: j => Array.isArray(j?.results) ? { count: j.results.filter((r: any) => r?.status === 'created').length, skipped: j.results.filter((r: any) => r?.status !== 'created').length } : null },
  { m: 'PUT', p: '/staff/:id', cat: 'staff', action: 'staff_update', label: retiredLabel('スタッフの情報の変更'), target: 'staff', snap: 'staff' },
  { m: 'PUT', p: '/employees/:id', cat: 'staff', action: 'employee_update', label: retiredLabel('従業員の情報の変更'), target: 'staff', snap: 'employee' },
  { m: 'PUT', p: '/staff/:id/reference-pay', cat: 'staff', action: 'staff_reference_pay', label: 'スタッフの参考単価の変更', target: 'staff', snap: 'staff' },
  { m: 'POST', p: '/staff/:id/affiliation-change', cat: 'staff', action: 'affiliation_change', label: '所属の変更', target: 'staff', body: [['to_type', '変更後の区分'], ['effective_date', '変更する日']] },
  { m: 'DELETE', p: '/staff/:id/affiliation-schedules/:id', cat: 'staff', action: 'affiliation_cancel', label: '所属の変更の予定の取り消し', target: 'staff' },
  { m: 'POST', p: '/staff/:id/login-email-pending/apply', cat: 'staff', action: 'login_email_apply', label: 'ログイン用メールの切り替え', target: 'staff' },
  { m: 'POST', p: '/staff/:id/login-email-pending/cancel', cat: 'staff', action: 'login_email_cancel', label: 'ログイン用メールの切り替えの取り消し', target: 'staff' },
  { m: 'PUT', p: '/availability/targets', cat: 'staff', action: 'availability_targets', label: '出勤可能日の提出の対象の変更',
    body: [['target', '提出する'], ['staff_ids', 'スタッフの人数']] },
  { m: 'POST', p: '/staff/:id/documents', cat: 'staff', action: 'staff_doc_add', label: 'スタッフの書類の追加', target: 'staff' },
  { m: 'DELETE', p: '/staff/documents/:id', cat: 'staff', action: 'staff_doc_delete', label: 'スタッフの書類の削除' },
  { m: 'POST', p: '/employees/:id/documents', cat: 'staff', action: 'employee_doc_add', label: '従業員の書類の追加', target: 'staff' },
  { m: 'DELETE', p: '/employees/documents/:id', cat: 'staff', action: 'employee_doc_delete', label: '従業員の書類の削除' },
  { m: 'PUT', p: '/settlement/payout/accounts/:id', cat: 'staff', action: 'payout_account', label: '振込先の口座の変更', target: 'staff', snap: 'payout_account' },
  { m: 'DELETE', p: '/settlement/payout/accounts/:id', cat: 'staff', action: 'payout_account_delete', label: '振込先の口座の削除', target: 'staff' },
  { m: 'POST', p: '/staff/:id/merge', cat: 'staff', action: 'staff_merge', label: 'スタッフの統合', target: 'staff', body: [['target_staff_id', '統合先', 'staff']] },
  { m: 'POST', p: '/roster/link', cat: 'staff', action: 'roster_link', label: '他社のスタッフとの連携', res: j => (j?.staff_id ? { staff_id: j.staff_id } : null) },
  { m: 'POST', p: '/roster/:id/links/:id/end', cat: 'staff', action: 'link_end', label: '他社との連携の終了', target: 'staff' },
  { m: 'POST', p: '/roster/:id/links/:id/resume', cat: 'staff', action: 'link_resume', label: '他社との連携の再開', target: 'staff' },
  { m: 'POST', p: '/roster/partners', cat: 'staff', action: 'partner_create', label: '協力会社の登録', target: 'partner', idKey: 'affiliation_id' },
  { m: 'PUT', p: '/roster/partners/:id', cat: 'staff', action: 'partner_update', label: '協力会社の変更', target: 'partner', snap: 'partner' },
  { m: 'PUT', p: '/roster/partners/:id/client', cat: 'staff', action: 'partner_client', label: '協力会社とクライアントの紐付け', target: 'partner', snap: 'partner' },
  { m: 'POST', p: '/roster/partners/:id/merge', cat: 'staff', action: 'partner_merge', label: '協力会社の統合', target: 'partner', body: [['into_id', '統合先', 'partner']] },
  { m: 'DELETE', p: '/roster/partners/:id', cat: 'staff', action: 'partner_delete', label: '協力会社の削除', target: 'partner', del: true },
  // ---- 管理者・ログインの発行 ----
  { m: 'POST', p: '/users', cat: 'admin', action: 'admin_create', label: '管理者の追加', target: 'user', idKey: 'user_id', body: [['role', '権限']] },
  { m: 'PUT', p: '/users/:id', cat: 'admin', action: 'admin_update', label: '管理者の変更', target: 'user', snap: 'user' },
  { m: 'POST', p: '/users/:id/reset-password', cat: 'admin', action: 'admin_reset_password', label: '管理者のパスワードの再発行', target: 'user', body: [['mode', '方法']] },
  { m: 'DELETE', p: '/security/users/:id/mfa', cat: 'admin', action: 'admin_mfa_reset', label: '管理者の二段階認証の解除', target: 'user' },
  { m: 'DELETE', p: '/security/users/:id/sessions', cat: 'admin', action: 'admin_logout', label: '管理者のログインの強制終了', target: 'user' },
  { m: 'POST', p: '/staff/:id/issue-login', cat: 'admin', action: 'staff_issue_login', label: 'スタッフのログインの発行', target: 'staff' },
  { m: 'POST', p: '/staff/:id/reset-password', cat: 'admin', action: 'staff_reset_password', label: 'スタッフのパスワードの再発行', target: 'staff' },
  { m: 'DELETE', p: '/staff/:id/sessions', cat: 'admin', action: 'staff_logout', label: 'スタッフのログインの強制終了', target: 'staff' },
  // ---- 設定 ----
  { m: 'PUT', p: '/security/settings', cat: 'settings', action: 'security_settings', label: 'セキュリティの設定', target: 'company', snap: 'company' },
  { m: 'POST', p: '/settings/photo-skip', cat: 'settings', action: 'attendance_photo_skip', label: '勤怠の設定（写真なしの打刻）', target: 'company', snap: 'company' },
  { m: 'POST', p: '/settings/photo-required', cat: 'settings', action: 'attendance_photo_required', label: '勤怠の設定（打刻の写真）', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/lateness', cat: 'settings', action: 'attendance_lateness', label: '勤怠の設定（遅刻の猶予）', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/site-contact', cat: 'settings', action: 'attendance_site_contact', label: '勤怠の設定（緊急連絡先・位置ずれ）', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/corrections', cat: 'settings', action: 'attendance_corrections', label: '勤怠の設定（打刻修正の期限）', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/staff-view', cat: 'settings', action: 'staff_view', label: 'スタッフアプリの表示の設定', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/shift-notify', cat: 'settings', action: 'shift_notify', label: 'シフトの通知の既定', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/mail-contact', cat: 'settings', action: 'mail_contact', label: 'メールの問い合わせ先', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settings/reminders', cat: 'settings', action: 'reminders', label: 'リマインドの設定', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/report-settings/day-before-check', cat: 'settings', action: 'day_before_check', label: '前日確認の設定', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/staff-pay/settings', cat: 'settings', action: 'staff_pay_visible', label: 'スタッフへの支払額の表示の設定', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/hq-access', cat: 'settings', action: 'hq_access', label: '本部の閲覧の許可', target: 'company', snap: 'company' },
  { m: 'PUT', p: '/settlement/premium-settings', cat: 'settings', action: 'premium_settings', label: '割増の設定', target: 'company', snap: 'premium' },
  { m: 'PUT', p: '/settlement/payout/settings', cat: 'settings', action: 'payout_settings', label: '振込元の設定', target: 'company', snap: 'payout' },
  { m: 'PUT', p: '/roster/field-settings', cat: 'settings', action: 'roster_fields', label: 'スタッフ名簿の必須項目の設定' },
  { m: 'PUT', p: '/availability/period', cat: 'settings', action: 'availability_period', label: '出勤可能日の締切', body: [['month', '月'], ['deadline', '締切']] },
  // ---- 案件・クライアント ----
  { m: 'POST', p: '/clients', cat: 'master', action: 'client_create', label: 'クライアントの登録', target: 'client', idKey: 'client_id' },
  { m: 'PUT', p: '/clients/:id', cat: 'master', action: 'client_update', label: 'クライアントの変更', target: 'client', snap: 'client' },
  { m: 'DELETE', p: '/clients/:id', cat: 'master', action: 'client_delete', label: 'クライアントの削除', target: 'client', del: true },
  { m: 'PUT', p: '/clients/:id/ng-staff', cat: 'master', action: 'client_ng_staff', label: 'クライアントの NG スタッフの変更', target: 'client', snap: 'client' },
  { m: 'POST', p: '/clients/:id/contacts', cat: 'master', action: 'client_contact_add', label: 'クライアントの担当者の追加', target: 'client' },
  { m: 'PUT', p: '/clients/contacts/:id', cat: 'master', action: 'client_contact_update', label: 'クライアントの担当者の変更' },
  { m: 'DELETE', p: '/clients/contacts/:id', cat: 'master', action: 'client_contact_delete', label: 'クライアントの担当者の削除' },
  { m: 'POST', p: '/clients/:id/documents', cat: 'master', action: 'client_doc_add', label: 'クライアントの書類の追加', target: 'client' },
  { m: 'DELETE', p: '/clients/documents/:id', cat: 'master', action: 'client_doc_delete', label: 'クライアントの書類の削除' },
  { m: 'PUT', p: '/settlement/clients/:id/closing-day', cat: 'master', action: 'client_closing_day', label: 'クライアントの締め日の変更', target: 'client', snap: 'client' },
  { m: 'POST', p: '/projects', cat: 'master', action: 'project_create', label: '案件の登録', target: 'project', idKey: 'project_id' },
  { m: 'PUT', p: '/projects/:id', cat: 'master', action: 'project_update', label: '案件の変更', target: 'project', snap: 'project' },
  { m: 'DELETE', p: '/projects/:id', cat: 'master', action: 'project_delete', label: '案件の削除', target: 'project', del: true },
  { m: 'PUT', p: '/projects/:id/required-skills', cat: 'master', action: 'project_skills', label: '案件の必要なスキルの変更', target: 'project', snap: 'project' },
  { m: 'PUT', p: '/projects/:id/photo-required', cat: 'master', action: 'project_photo', label: '案件の打刻の写真の設定', target: 'project', snap: 'project' },
  { m: 'PUT', p: '/projects/:id/lateness', cat: 'master', action: 'project_lateness', label: '案件の遅刻の猶予の設定', target: 'project', snap: 'project' },
  { m: 'PUT', p: '/projects/:id/goals', cat: 'master', action: 'project_goals', label: '案件の目標の変更', target: 'project', snap: 'project' },
  { m: 'PUT', p: '/projects/:id/pricing', cat: 'master', action: 'project_pricing', label: '案件の単価の変更', target: 'project', snap: 'project' },
  { m: 'PUT', p: '/projects/:id/report-settings', cat: 'master', action: 'project_report_settings', label: '案件の報告の設定', target: 'project', snap: 'project' },
  { m: 'PUT', p: '/report-settings/projects/:id/default', cat: 'master', action: 'project_report_default', label: '案件の報告の設定（既定）', target: 'project' },
  { m: 'PUT', p: '/settlement/projects/:id/cancel-policy', cat: 'master', action: 'project_cancel_policy', label: '案件のキャンセル規定の変更', target: 'project' },
  { m: 'POST', p: '/sites', cat: 'master', action: 'site_create', label: '開催場所の登録', target: 'site', idKey: 'site_id' },
  { m: 'PUT', p: '/sites/:id', cat: 'master', action: 'site_update', label: '開催場所の変更', target: 'site', snap: 'site' },
  { m: 'DELETE', p: '/sites/:id', cat: 'master', action: 'site_delete', label: '開催場所の削除', target: 'site', del: true },
  { m: 'POST', p: '/rate-rules', cat: 'master', action: 'rate_rule_create', label: '単価ルールの登録', body: [['project_id', '案件', 'project']] },
  { m: 'PUT', p: '/rate-rules/:id', cat: 'master', action: 'rate_rule_update', label: '単価ルールの変更' },
  { m: 'DELETE', p: '/rate-rules/:id', cat: 'master', action: 'rate_rule_delete', label: '単価ルールの削除' },
  { m: 'PUT', p: '/settlement/monthly-rules/:id', cat: 'master', action: 'monthly_rule_update', label: '月額の決まりの変更' },
  { m: 'DELETE', p: '/settlement/monthly-rules/:id', cat: 'master', action: 'monthly_rule_delete', label: '月額の決まりの削除' },
  { m: 'PUT', p: '/transport-defaults', cat: 'master', action: 'transport_default', label: '交通費の標準の変更', body: [['staff_id', 'スタッフ', 'staff'], ['site_id', '開催場所', 'site'], ['amount', '金額']] },
  { m: 'DELETE', p: '/transport-defaults/:id', cat: 'master', action: 'transport_default_delete', label: '交通費の標準の削除' },
  { m: 'POST', p: '/templates', cat: 'master', action: 'template_create', label: '日報テンプレートの登録', target: 'template', idKey: 'template_id' },
  { m: 'PUT', p: '/templates/:id', cat: 'master', action: 'template_update', label: '日報テンプレートの変更', target: 'template', snap: 'template' },
  { m: 'POST', p: '/recruit-pages', cat: 'master', action: 'recruit_page_create', label: '募集ページの作成' },
  { m: 'PUT', p: '/recruit-pages/:id', cat: 'master', action: 'recruit_page_update', label: '募集ページの変更' },
  { m: 'DELETE', p: '/recruit-pages/:id', cat: 'master', action: 'recruit_page_delete', label: '募集ページの削除' },
  // ---- お知らせ ----
  { m: 'POST', p: '/notices', cat: 'notice', action: 'notice_create', target: 'notice', idKey: 'notice_id',
    label: x => x.json?.status === 'draft' ? 'お知らせの下書きの保存' : x.json?.status === 'scheduled' ? 'お知らせの配信の予約' : 'お知らせの配信' },
  { m: 'PUT', p: '/notices/:id', cat: 'notice', action: 'notice_update', label: 'お知らせの変更', target: 'notice', snap: 'notice' },
  { m: 'POST', p: '/notices/:id/publish', cat: 'notice', action: 'notice_publish', label: 'お知らせの配信', target: 'notice' },
  { m: 'POST', p: '/notices/:id/withdraw', cat: 'notice', action: 'notice_withdraw', label: 'お知らせの取り下げ', target: 'notice', body: [['reason', '理由']] },
  { m: 'DELETE', p: '/notices/:id', cat: 'notice', action: 'notice_delete', label: 'お知らせの削除', target: 'notice', del: true },
  { m: 'POST', p: '/notices/:id/remind', cat: 'notice', action: 'notice_remind', label: 'お知らせの未読の人への再通知', target: 'notice' },
  { m: 'POST', p: '/notices/:id/attachments', cat: 'notice', action: 'notice_attach', label: 'お知らせの添付の追加', target: 'notice' },
  { m: 'DELETE', p: '/notices/:id/attachments/:id', cat: 'notice', action: 'notice_attach_delete', label: 'お知らせの添付の削除', target: 'notice' },
  // ---- シフト・精算（シフトの行ごとの前後の値は operation_logs に残る。ここは締めだけ） ----
  { m: 'POST', p: '/settlement/closings', cat: 'shift', action: 'closing', label: '精算の締め', body: [['from', '開始'], ['to', '終了'], ['client_id', 'クライアント', 'client']] },
  { m: 'POST', p: '/settlement/closings/:id/reopen', cat: 'shift', action: 'closing_reopen', label: '精算の締めの解除', body: [['reason', '理由']] },
  // ---- 画面で作る CSV の元を取る API（連携用ID） ----
  { m: 'POST', p: '/roster/share-codes', cat: 'csv', action: 'share_codes', label: '連携用IDの書き出し・印刷', body: [['staff_ids', '人数']] },
]
// 本文の値の表示（権限・再発行の方法・する／しない）
const BODY_VALUE_LABELS: Record<string, Record<string, string>> = {
  role: ROLE_LABELS as Record<string, string>, mode: { email: '再設定の案内をメールで送る', temp: '仮のパスワードを発行' }, target: { true: 'する', false: 'しない' },
}
type CompiledRoute = AuditRoute & { re: RegExp }
const COMPILED: CompiledRoute[] = AUDIT_ROUTES.map(r => ({ ...r, re: new RegExp('^/api/admin' + r.p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '(\\d+)') + '/?$') }))
export function matchAuditRoute(method: string, path: string): { route: AuditRoute; id: number | null } | null {
  for (const r of COMPILED) {
    if (r.m !== method) continue
    const m = r.re.exec(path)
    if (m) return { route: r, id: m[1] ? Number(m[1]) : null }
  }
  return null
}

// ---------- 書き出し（GET の応答がファイル） ----------
// パス → 画面に出す名前。q は絞り込みの条件
const EXPORT_ROUTES: [RegExp, string | ((q: Record<string, string>) => string), string?][] = [
  [/^\/api\/admin\/settlement\/export$/, q => `精算の CSV（${({ billing: '請求', payment: '支払', detail: '明細' } as Record<string, string>)[q.kind || 'detail'] || q.kind}）`],
  [/^\/api\/admin\/settlement\/payout\/export$/, q => (q.format === 'csv' ? '振込一覧（CSV）' : '振込データ（全銀の形式）')],
  [/^\/api\/admin\/employees\/export$/, q => (q.include_pay === '1' ? '従業員名簿（口座・給与あり）' : '従業員名簿')],
  [/^\/api\/admin\/daily-reports-csv$/, '日報の CSV'],
  [/^\/api\/admin\/attendance-punches\/export$/, '打刻データの CSV'],
  [/^\/api\/admin\/analytics\/csv$/, '実績分析の CSV'],
  [/^\/api\/admin\/notices\/(\d+)\/responses\.csv$/, 'お知らせの回答の CSV', 'notice'],
  [/^\/api\/admin\/notice-reports\/[^/]+\/csv$/, 'お知らせの既読率レポートの CSV'],
  [/^\/api\/admin\/corrections\/export$/, '打刻修正の申請の CSV'],
  [/^\/api\/admin\/corrections\/events\/export$/, '打刻修正の操作履歴の CSV'],
  [/^\/api\/admin\/notification-emails\/export$/, '通知メールの送信状況の CSV'],
  [/^\/api\/admin\/report-settings\/off-list\/export$/, '報告 OFF の設定一覧の CSV'],
  [/^\/api\/admin\/report-settings\/logs\/export$/, '報告設定の変更履歴の CSV'],
  [/^\/api\/admin\/shift-board\/export$/, 'シフト表の CSV'],
  [/^\/api\/admin\/roster\/import\/template/, 'スタッフの一括登録のひな形'],
  [/^\/api\/admin\/staff\/documents\/\d+\/download$/, 'スタッフの書類のダウンロード'],
  [/^\/api\/admin\/employees\/documents\/\d+\/download$/, '従業員の書類のダウンロード'],
  [/^\/api\/admin\/clients\/documents\/\d+\/download$/, 'クライアントの書類のダウンロード'],
  [/^\/api\/admin\/notices\/(\d+)\/attachments\//, 'お知らせの添付のダウンロード', 'notice'],
  [/^\/api\/admin\/audit-logs\/export$/, '操作の記録の CSV'],
]
// 画面で作る CSV（POST /api/admin/export-logs で知らせる種類）
export const CLIENT_EXPORT_KINDS: Record<string, string> = {
  billing: '請求前確認の CSV', roster_logins: 'ログイン案内の CSV（初期パスワードつき）',
}
// 絞り込みの条件の表示名（ここにない条件はキーのまま出す）
export const AUDIT_FILTER_LABELS: Record<string, string> = {
  from: '開始', to: '終了', month: '月', project_id: '案件', staff_id: 'スタッフ', client_id: 'クライアント', kind: '種類', status: '状態', format: '形式',
  include_pay: '口座・給与', payee_type: '支払区分', settle: '確定', issues_only: '確認が必要なものだけ', transfer_date: '振込日', types: '支払区分',
  actor: '操作した人', q: '検索', type: '種類', date: '日付', week: '週', fy: '年度', download: 'ダウンロード', staff_ids: 'スタッフ', project_ids: '案件',
}
/** Content-Disposition のファイル名（filename* を優先） */
export function dispositionFileName(v: string | null): string | null {
  if (!v) return null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(v)
  if (star) { try { return decodeURIComponent(star[1].trim()) } catch { /* 下の filename= を使う */ } }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(v)
  return plain ? plain[1] : null
}
function queryFilters(q: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '' || k === '_' || k === 'download') continue
    out[k.slice(0, 40)] = String(v).slice(0, 100)
    if (Object.keys(out).length >= 20) break
  }
  return Object.keys(out).length ? out : null
}

// ---------- 1行を入れる ----------
export type AuditEntry = {
  companyId: number; actorId: number | null; actorRole: string | null; category: string; action: string; label: string
  targetType?: string | null; targetId?: number | null; targetName?: string | null; detail?: Record<string, unknown> | null; ip?: string | null
}
const DETAIL_MAX = 6000
export function auditInsertStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  let detail = e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : null
  // 長すぎる内容は変わった項目を減らして収める（1行を大きくしない）
  if (detail && detail.length > DETAIL_MAX && Array.isArray((e.detail as any).changes)) {
    const d = { ...(e.detail as any) }
    const all = d.changes as AuditChange[]
    while (d.changes.length > 1 && JSON.stringify(d).length > DETAIL_MAX) d.changes = d.changes.slice(0, Math.floor(d.changes.length / 2))
    d.more_changes = all.length - d.changes.length
    detail = JSON.stringify(d)
  }
  if (detail && detail.length > DETAIL_MAX) detail = JSON.stringify({ note: '内容が長いため省略しました' })
  return db.prepare(`INSERT INTO audit_logs (company_id, actor_user_id, actor_role, category, action, label, target_type, target_id, target_name, detail_json, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(e.companyId, e.actorId, e.actorRole, e.category, e.action.slice(0, 60), e.label.slice(0, 200), e.targetType ?? null, e.targetId ?? null,
      e.targetName ? String(e.targetName).slice(0, 200) : null, detail, e.ip ? String(e.ip).slice(0, 64) : null, nowJST())
}
async function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  try { await auditInsertStmt(db, e).run() } catch (err) { console.log(`audit log failed: ${e.action}: ${String((err as any)?.message || err).slice(0, 200)}`) }
}
async function targetName(db: D1Database, type: string | undefined, id: number | null, companyId: number): Promise<string | null> {
  if (!type || !id || !TARGET_NAME_SQL[type]) return null
  try { return ((await db.prepare(TARGET_NAME_SQL[type]).bind(id, companyId).first()) as any)?.n ?? null } catch { return null }
}
async function loadSnap(db: D1Database, key: string | undefined, id: number | null, companyId: number): Promise<Record<string, unknown> | null> {
  const def = key ? SNAPS[key] : undefined
  if (!def || (!def.company && !id)) return null
  try {
    const row = await (def.company ? db.prepare(def.sql).bind(companyId) : db.prepare(def.sql).bind(id, companyId)).first() as Record<string, unknown> | null
    return row ? flat(row, def) : null
  } catch (e) { console.log(`audit snap failed: ${key}: ${e}`); return null }
}

/**
 * /api/admin/* のミドルウェア（api.ts で hqViewAdminGuard より前に登録する。閲覧中は env が読み取りだけに変わるので、DB は先に控える）。
 * 書き込みは成功した（400 未満）ときだけ。記録の失敗で応答は変えない
 */
export async function auditMiddleware(c: any, next: () => Promise<void>) {
  const db = c.env.DB as D1Database
  const method = c.req.method
  if (method === 'GET') {
    await next()
    if (c.res.status >= 400) return
    const disp = c.res.headers.get('Content-Disposition')
    if (!disp || !/^\s*attachment/i.test(disp)) return
    const u = c.get('user')
    if (!u?.company_id) return
    const path = c.req.path
    const q = c.req.query() as Record<string, string>
    const hit = EXPORT_ROUTES.find(([re]) => re.test(path))
    const label = hit ? (typeof hit[1] === 'function' ? hit[1](q) : hit[1]) : 'ファイルの書き出し'
    const tm = hit?.[2] ? hit[0].exec(path) : null
    const tid = tm && tm[1] ? Number(tm[1]) : null
    const rowsHeader = c.res.headers.get('X-Export-Rows') ?? c.res.headers.get('X-Payout-Count')
    const detail: Record<string, unknown> = { file: dispositionFileName(disp) }
    if (rowsHeader !== null && rowsHeader !== '' && Number.isFinite(Number(rowsHeader))) detail.rows = Number(rowsHeader)
    if (c.res.headers.get('X-Csv-Truncated') === '1') detail.truncated = Number(c.res.headers.get('X-Csv-Total')) || true
    const filters = queryFilters(q)
    if (filters) detail.filters = filters
    await writeAudit(db, {
      companyId: Number(u.company_id), actorId: u.user_id ?? null, actorRole: u.hq_view ? 'system_admin' : (u.role ?? null), category: 'csv', action: 'export',
      label, targetType: hit?.[2] ?? null, targetId: tid, targetName: await targetName(db, hit?.[2], tid, Number(u.company_id)), detail, ip: c.req.header('CF-Connecting-IP') || null,
    })
    return
  }
  const hit = method === 'HEAD' || method === 'OPTIONS' ? null : matchAuditRoute(method, c.req.path)
  const u0 = c.get('user')
  // 管理画面の4ロールの書き込みだけ（本部・スタッフは /admin/* の入口で止まるので、前の値も読まない）
  if (!hit || !u0?.company_id || !ADMIN_ROLES.includes(u0.role)) return next()
  const { route, id } = hit
  const companyId = Number(u0.company_id)
  // 前の値・消す前の名前
  const before = route.snap ? await loadSnap(db, route.snap, id, companyId) : null
  const nameBefore = before ? ((before._n as string) ?? null) : (route.del || (route.target && route.target !== 'company' && !route.idKey && id) ? await targetName(db, route.target, id, companyId) : null)
  await next()
  if (c.res.status >= 400) return
  try {
    let json: any = null
    if ((route.idKey || route.res || typeof route.label === 'function') && String(c.res.headers.get('Content-Type') || '').includes('application/json')) {
      json = await c.res.clone().json().catch(() => null)
    }
    let body: any = null
    if (route.body && String(c.req.header('Content-Type') || '').includes('application/json')) body = await c.req.json().catch(() => null)
    const targetId = route.idKey ? (Number(json?.[route.idKey]) || null) : (route.target === 'company' ? null : id)
    const after = route.snap ? await loadSnap(db, route.snap, id, companyId) : null
    const changes = route.snap ? auditDiff(before, after) : []
    const detail: Record<string, unknown> = {}
    if (route.snap) detail.changes = changes
    if (route.body && body && typeof body === 'object') {
      for (const [k, l, ref] of route.body) {
        const v = body[k]
        if (v === undefined || v === null || v === '') continue
        if (Array.isArray(v)) detail[l] = l.includes('人数') ? `${v.length}人` : `${v.length}件`
        else if (ref) detail[l] = (await targetName(db, ref, Number(v), companyId)) || `#${Number(v)}`
        else detail[l] = BODY_VALUE_LABELS[k]?.[String(v)] ?? asText(v)
      }
    }
    if (route.res && json) Object.assign(detail, route.res(json) || {})
    let name = nameBefore
    if (route.target === 'company') name = null
    else if (!route.del) name = (after?._n as string) ?? (route.idKey ? await targetName(db, route.target, targetId, companyId) : nameBefore)
    const ctx: AuditCtx = { method, path: c.req.path, query: c.req.query(), body, json, changes }
    const u = c.get('user') || u0
    await writeAudit(db, {
      companyId, actorId: u.user_id ?? null, actorRole: u.role ?? null, category: route.cat, action: route.action,
      label: typeof route.label === 'function' ? route.label(ctx) : route.label,
      targetType: route.target ?? null, targetId, targetName: name, detail, ip: c.req.header('CF-Connecting-IP') || null,
    })
  } catch (e) { console.log(`audit log failed: ${route.action}: ${String((e as any)?.message || e).slice(0, 200)}`) }
}

/** 1年を過ぎた記録を消す（毎日の cron。src/lib/auth.ts の purgeExpiredAuthRows から呼ぶ文） */
export function purgeAuditLogsStmt(db: D1Database): D1PreparedStatement {
  return db.prepare('DELETE FROM audit_logs WHERE created_at < ?').bind(nowJST(-AUDIT_KEEP_DAYS * 24 * 3600 * 1000))
}
