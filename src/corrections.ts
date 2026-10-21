// =========================================================
// 打刻修正申請（時刻修正・打刻漏れの追加・承認・却下・取り消し・再申請）
// docs/spec_attendance_correction.md 4章
//
// - 1 申請 = 1 報告種類。承認されるまで attendance_reports は変えない
// - 時刻修正（modify）: 報告の順序に矛盾があれば申請・承認とも拒否する
// - 打刻漏れの追加（add）: 矛盾があっても申請でき、矛盾内容を保存する。管理者は例外として承認できる
// - 承認は「申請の状態の更新」と「勤怠データへの反映」を db.batch() の 1 トランザクションで行う
//   （状態の更新は status='pending' かつ対象の報告が申請時のまま、のときだけ成功。反映はその処理の decision_token がある場合だけ効く）
// 管理者 API（/api/admin/corrections*）は api.ts から権限ミドルウェアの後に、スタッフ API（/api/staff/*）は認証の後に登録する。
// =========================================================
import { Hono } from 'hono'
import { REPORT_TYPES, REPORT_LABEL, isReportType, attendanceTypesForShifts, lateness, latenessSettingsFor, canEditAttendanceSettings, ATTENDANCE_SETTING_DENIED, type ReportLateness } from './report-settings'
import { syncActualFromReports, actualFromReports, amountsForActual } from './settlement'
import { isSettled, loadPricingData, shiftTotals, workHours } from './shift-board'
import { personStaffRows } from './roster'
import { notifyCorrection, type NotifyEnv, type CorrectionEvent } from './notifications'
import { toCsv, csvResponse, loadLatestForCsv, csvLimitNote, csvLimitHeaders, roleLabel, CSV_LIMIT } from './csv'
import { isTentativeShift, isWorkingShift, WORKING_SHIFT_STATUSES } from './lib/shift-status'
import { crossesMidnight, toMin, NEXT_DAY_TYPES, reportableWindow } from './lib/shift-time'
import { photoTakenAt, photoSource } from './lib/attendance-photo'

type Bindings = NotifyEnv & { PHOTOS: R2Bucket }
type Variables = { user: any }
type Actor = { user_id: number; name: string; role: string }
export const actorOf = (u: any): Actor => ({ user_id: u.user_id, name: u.name, role: u.role })

export const CORRECTION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const
export const STATUS_LABEL: Record<string, string> = { pending: '承認待ち', approved: '承認済み', rejected: '却下', cancelled: '取り消し済み' }
export const KIND_LABEL: Record<string, string> = { modify: '時刻修正', add: '打刻漏れの追加' }
// 申請者以外の理由で取り消した申請の理由（attendance_corrections.cancel_reason。#70 #101）
export const CANCEL_REASON_LABEL: Record<string, string> = { shift_deleted: 'シフトが削除されたため', staff_changed: 'シフトの担当者が差し替えられたため' }
const WORKING_IN = `(${WORKING_SHIFT_STATUSES.map(s => `'${s}'`).join(',')})`
const REASON_MAX = 500
// スタッフの申請（申請・再申請・まとめて申請の件数）の上限（1時間あたり。#392）。超えたら 429
export const CORRECTION_HOURLY_LIMIT = 20
// まとめて申請できる報告の数（1シフトの報告の種類の数まで。#214）
const BULK_MAX = 8

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function randToken(): string { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join('') }
const isDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
function addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

// 'YYYY-MM-DD HH:MM'（'T' 区切り・秒ありも可）→ 'YYYY-MM-DD HH:MM:00'。存在しない日時は null
export function normalizeDateTime(v: any): string | null {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59) return null
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:00`
}
const fmt = (at: string) => { const m = String(at).match(/^\d{4}-(\d{2})-(\d{2}) (\d{2}:\d{2})/); return m ? `${Number(m[1])}/${Number(m[2])} ${m[3]}` : at }

// 報告の順序（REPORT_TYPES の順に日時が前後していないか）。申請した報告が関わる矛盾だけを返す。日付込みで比較する
// 比較は分の単位（申請は分までしか入力できず、表示も分まで。秒の差だけで矛盾にしない。#133）。同じ分は矛盾にしない
export function orderConflicts(reports: Map<string, string>, type: string, at: string): string[] {
  const idx = REPORT_TYPES.indexOf(type as any)
  const out: string[] = []
  const min = (v: string) => String(v).slice(0, 16)
  for (const t of REPORT_TYPES) {
    if (t === type) continue
    const other = reports.get(t); if (!other) continue
    const j = REPORT_TYPES.indexOf(t)
    if (j < idx && min(other) > min(at)) out.push(`${REPORT_LABEL[type]}（${fmt(at)}）が${REPORT_LABEL[t]}（${fmt(other)}）より前です`)
    if (j > idx && min(other) < min(at)) out.push(`${REPORT_LABEL[t]}（${fmt(other)}）が${REPORT_LABEL[type]}（${fmt(at)}）より前です`)
  }
  return out
}

// ---------- 読み込み ----------
async function loadShift(db: D1Database, shiftId: any) {
  return db.prepare(`SELECT s.shift_id, s.company_id, s.project_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.settle_status, s.settled_at, s.actual_source,
      p.project_name, p.photo_required_override, us.name AS staff_name, co.company_name, co.settings_json
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id
    JOIN users us ON us.user_id = sp.user_id JOIN companies co ON co.company_id = s.company_id WHERE s.shift_id = ?`).bind(shiftId).first() as Promise<any>
}
async function loadReports(db: D1Database, shiftId: number) {
  return (await db.prepare('SELECT attendance_id, report_type, reported_at, entry_method FROM attendance_reports WHERE shift_id = ?').bind(shiftId).all()).results as any[]
}
const reportMap = (rows: any[]) => new Map(rows.map(r => [r.report_type as string, r.reported_at as string]))
// 承認画面の根拠の表示用（管理者のみ）: 元の打刻の方法・入力者・位置・写真の有無・遅刻の判定（#443）
async function loadReportsDetail(db: D1Database, shiftId: number) {
  return (await db.prepare(`SELECT a.attendance_id, a.report_type, a.reported_at, a.entry_method, a.status, a.late_minutes, a.early_leave_minutes,
      a.latitude, a.longitude, a.address, CASE WHEN a.photo_key IS NOT NULL THEN 1 ELSE 0 END AS has_photo, a.entered_by, um.name AS entered_by_name,
      a.original_reported_at, a.corrected_by_correction_id
    FROM attendance_reports a LEFT JOIN users um ON um.user_id = a.entered_by WHERE a.shift_id = ?`).bind(shiftId).all()).results as any[]
}
async function loadCorrection(db: D1Database, id: any) {
  return db.prepare(`SELECT c.*, s.work_date, s.start_time, s.end_time, s.settle_status, p.project_name, p.status AS project_status, us.name AS staff_name
    FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id WHERE c.correction_id = ?`).bind(id).first() as Promise<any>
}
const parseWarnings = (c: any) => { try { return c.order_warnings ? JSON.parse(c.order_warnings) : [] } catch { return [] } }

// ---------- 申請の添付（#485） ----------
// 写真が必須になりうる報告（api.ts の PHOTO_REQUIRED_TYPES と同じ）
const PHOTO_TYPES = ['check_in', 'check_out']
// 案件の photo_required_override（NULL = 会社設定に従う / 1 = 必須 / 0 = 不要）を加味した、入店・退店の写真が必須か（api.ts の resolvePhotoRequired と同じ規則。
// api.ts がこのファイルを読み込むため、ここでは複製する）
export function photoRequiredFor(settingsJson: any, override: any): boolean {
  if (override !== null && override !== undefined) return !!Number(override)
  try { const v = JSON.parse(settingsJson || '{}').photo_required_attendance; return typeof v === 'boolean' ? v : true } catch { return true }
}
// 写真が必須の案件で、写真の添付がない入店・退店の打刻漏れの追加か（承認の前に確かめるよう、まとめて承認の対象から外す）
const needsPhotoReview = (c: { kind: string; report_type: string }, required: boolean, attachments: number) =>
  required && c.kind === 'add' && PHOTO_TYPES.includes(c.report_type) && attachments === 0
// まとめて承認の対象から外す申請（順序の矛盾・確定済み・手入力の実績・写真が必須で添付なし。#280 #485）。外す理由を返す
function bulkBlockReason(c: { kind: string; report_type: string; order_warnings: string[] }, s: { settle_status: any; actual_source: any }, photoRequired: boolean, attachments: number): string | null {
  if (c.order_warnings.length) return '報告の順序に矛盾があります'
  if (s.settle_status === 'confirmed') return '精算が確定済みのシフトです'
  if (s.actual_source === 'manual') return '実績が手入力のシフトです'
  if (needsPhotoReview(c, photoRequired, attachments)) return '写真が必須の案件で、写真の添付がありません'
  return null
}
export const ATTACHMENT_MAX = 3
const ATTACHMENT_MAX_BYTES = 500 * 1024 // 画面で圧縮した後の上限（入店・退店の写真と同じ）
const ATTACHMENT_TYPES = ['image/jpeg', 'image/png']
// 申請の添付。まとめて出した申請（同じシフト・申請者・申請日時。insertCorrections）の添付も、同じ申請の根拠として返す（画面はまとめて申請の先頭の申請に添付する）
async function loadAttachments(db: D1Database, c: any) {
  return (await db.prepare(`SELECT a.attachment_id, a.correction_id, a.content_type, a.size_bytes, a.photo_taken_at, a.photo_source, a.uploaded_by_name, a.created_at
    FROM attendance_correction_attachments a JOIN attendance_corrections x ON x.correction_id = a.correction_id
    WHERE x.correction_id = ? OR (x.shift_id = ? AND x.requested_by = ? AND x.created_at = ? AND x.batch_key IS ?) ORDER BY a.attachment_id`)
    .bind(c.correction_id, c.shift_id, c.requested_by, c.created_at, c.batch_key ?? null).all()).results as any[]
}
async function attachmentResponse(c: any, key: string | undefined) {
  const obj = key ? await c.env.PHOTOS.get(key) : null
  if (!obj) return c.json({ error: '画像が見つかりません' }, 404)
  return c.body(obj.body, 200, { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
}

// シフトの報告・有効な報告・承認待ちの申請（申請画面・タイムライン用）
async function shiftContext(db: D1Database, shift: any) {
  const reports = await loadReports(db, shift.shift_id)
  const enabled = (await attendanceTypesForShifts(db, [shift.shift_id])).get(shift.shift_id)?.types ?? [...REPORT_TYPES]
  const pending = (await db.prepare(`SELECT correction_id, report_type, kind, requested_at FROM attendance_corrections WHERE shift_id = ? AND status = 'pending'`).bind(shift.shift_id).all()).results
  return {
    shift: { shift_id: shift.shift_id, work_date: shift.work_date, start_time: shift.start_time, end_time: shift.end_time, status: shift.status, project_name: shift.project_name, staff_name: shift.staff_name, company_name: shift.company_name, settled: shift.settle_status === 'confirmed' },
    reports, enabled, pending,
  }
}

// ---------- 申請の内容の確認（申請・再申請・確認用の dry_run で共用） ----------
// warnings は報告の順序の矛盾（申請に保存する）。notices は申請者への注意（確定済みのシフトなど。保存しない。#215）
type Prepared = { kind: 'modify' | 'add'; report_type: string; requested_at: string; reason: string; attendance_id: number | null; before_at: string | null; warnings: string[]; notices: string[] }
type Fail = { error: string; status: 400 | 404 | 409 | 429; conflicts?: string[]; report_type?: string }
// staff: スタッフ本人の申請（会社設定の受付期限を当てる）。others: まとめて申請するほかの報告の日時（順序はそれを反映した後の組み合わせで確かめる。#214）
type PrepareOpts = { staff?: boolean; others?: Map<string, string> }

// 会社設定（companies.settings_json.correction_deadline_days）の受付期限（勤務日から何日後まで）。未設定・不正なら期限なし
export function correctionDeadlineDays(settingsJson: any): number | null {
  let v: any
  try { v = JSON.parse(settingsJson || '{}')?.correction_deadline_days } catch { return null }
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n <= 366 ? n : null
}
// 確定済みのシフトへの申請の注意（承認されても実績・金額は変わらない。settlement.ts の syncActualFromReports は確定済みを変えない）
export const SETTLED_NOTICE = '精算が確定済みのシフトです。承認されると勤怠の記録は変わりますが、支払額は自動では変わりません（必要な対応は管理者が行います）'

async function prepareRequest(db: D1Database, shift: any, b: any, opts: PrepareOpts = {}): Promise<Prepared | Fail> {
  if (b.kind !== 'modify' && b.kind !== 'add') return { error: '申請の種類を選択してください', status: 400 }
  if (!isReportType(b.report_type)) return { error: '報告の種類を選択してください', status: 400 }
  const at = normalizeDateTime(b.requested_at)
  if (!at) return { error: '日付と時刻を正しく入力してください', status: 400 }
  const reason = String(b.reason ?? '').trim()
  if (!reason) return { error: '修正理由を入力してください', status: 400 }
  if (reason.length > REASON_MAX) return { error: `修正理由は${REASON_MAX}文字以内で入力してください`, status: 400 }
  if (shift.status === 'absent') return { error: '欠勤のシフトには申請できません', status: 400 }
  // 希望（仮）のシフトは精算に出ないため、打刻を追加・修正しない（#559。lib/shift-status.ts）
  if (!isWorkingShift(shift.status)) return { error: '未確定（希望（仮））のシフトには申請できません。管理者がシフトを確定してから申請してください', status: 400 }
  // 日時は稼働日の前日 0:00 から翌日 23:59 まで（日をまたぐシフトの翌日の退店を含む。年・月の打ち間違いを止める）
  if (at < `${addDays(shift.work_date, -1)} 00:00:00` || at > `${addDays(shift.work_date, 1)} 23:59:59`)
    return { error: `日時は稼働日（${fmtDay(shift.work_date)}）の前日から翌日までの範囲で入力してください`, status: 400 }
  // 報告の種類ごとの受付時間帯の終わり（起床・出発は稼働日のうち、退店などは予定の終了の後まで。lib/shift-time.ts の reportableWindow）より後は受け付けない（#312）
  const win = reportableWindow(shift, b.report_type)
  if (at > win.end) return { error: `${REPORT_LABEL[b.report_type]}の日時は ${fmt(win.end)} までで入力してください`, status: 400 }
  // これから来る日時の打刻は申請できない（当日に本人が報告できなくなるため。#312）
  if (at.slice(0, 16) > nowJST().slice(0, 16)) return { error: 'まだ来ていない日時は申請できません。その時刻になったら、ホームの報告ボタンで報告してください', status: 400 }
  // 会社が受付期限を決めている場合、期限を過ぎたスタッフの申請は受け付けない（管理者の申請は受け付ける。#215）
  const deadline = opts.staff ? correctionDeadlineDays(shift.settings_json) : null
  if (deadline && nowJST().slice(0, 10) > addDays(shift.work_date, deadline))
    return { error: `勤務日から${deadline}日を過ぎたため、アプリからは申請できません。管理者に連絡してください`, status: 400 }
  const notices = shift.settle_status === 'confirmed' ? [SETTLED_NOTICE] : []
  const reports = await loadReports(db, shift.shift_id)
  const existing = reports.find(r => r.report_type === b.report_type)
  const map = reportMap(reports.filter(r => r.report_type !== b.report_type))
  for (const [t, v] of opts.others || []) if (t !== b.report_type) map.set(t, v)
  const conflicts = orderConflicts(map, b.report_type, at)
  // 日をまたぐシフトで、休憩・勤務終了・退店の日付が稼働日のままになっている（翌日の入れ忘れ。#52）
  const hint = nextDayHint(shift, b.report_type, at)
  let prep: Prepared
  if (b.kind === 'modify') {
    if (!existing) return { error: 'この報告はまだ登録されていません。打刻漏れの追加を申請してください', status: 409 }
    if (String(existing.reported_at).slice(0, 16) === at.slice(0, 16)) return { error: '変更前と同じ日時です', status: 400 }
    // 時刻修正は報告の順序に違反してはいけない
    if (conflicts.length) {
      const all = hint ? [...conflicts, hint] : conflicts
      // 隣の報告も一緒に直せば矛盾しない場合があるので、まとめて申請できることを案内する（#214）
      const guide = opts.others ? '' : '（隣の報告も違っている場合は、「ほかの報告も一緒に直す」でまとめて申請してください）'
      return { error: `報告の順序に矛盾があるため申請できません: ${all.join(' / ')}${guide}`, status: 400, conflicts: all }
    }
    prep = { kind: 'modify', report_type: b.report_type, requested_at: at, reason, attendance_id: existing.attendance_id, before_at: existing.reported_at, warnings: [], notices }
  } else {
    if (existing) return { error: 'この報告はすでに登録されています。時刻の修正を申請してください', status: 409 }
    // 打刻漏れの追加は矛盾があっても申請できる（警告として保存し、承認者が例外として承認できる）
    prep = { kind: 'add', report_type: b.report_type, requested_at: at, reason, attendance_id: null, before_at: null, warnings: hint ? [...conflicts, hint] : conflicts, notices }
  }
  const dup = await db.prepare(`SELECT correction_id FROM attendance_corrections WHERE shift_id = ? AND report_type = ? AND status = 'pending'`).bind(shift.shift_id, b.report_type).first()
  if (dup) return { error: 'この報告には承認待ちの申請があります。取り消すか、結果が出てから申請してください', status: 409 }
  return prep
}

const fmtDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
// 日をまたぐシフトの休憩・勤務終了・退店が、稼働日の開始時刻より前の日時になっている場合の案内
function nextDayHint(shift: any, type: string, at: string): string | null {
  if (!NEXT_DAY_TYPES.includes(type) || !crossesMidnight(shift)) return null
  if (at.slice(0, 10) !== shift.work_date || toMin(at.slice(11, 16)) >= toMin(shift.start_time)) return null
  return `日をまたぐシフトです。${REPORT_LABEL[type]}の日付が稼働日（${fmtDay(shift.work_date)}）のままです。翌日（${fmtDay(addDays(shift.work_date, 1))}）ではありませんか？`
}

// 申請の登録（申請と操作履歴を 1 トランザクションで）。まとめて申請（#214）は同じ created_at・batch_key で全件を1つの batch に入れる（全件成功か全件失敗）。
// 同じシフト・申請者・created_at・batch_key の承認待ちを「まとめて出した申請」として扱い、承認依頼のメールを1通にまとめる（notifications.ts。#392）。
// batch_key は申請の操作ごとに作る（同じ秒に別々に出した申請を1つにまとめない。0087 より前の行は NULL で、created_at だけで束ねる）
type NewRequest = { p: Prepared; from: number | null }
const newBatchKey = () => { const x = new Uint8Array(9); crypto.getRandomValues(x); return [...x].map(v => v.toString(16).padStart(2, '0')).join('') }
async function insertCorrections(db: D1Database, shift: any, items: NewRequest[], a: Actor) {
  const at = nowJST()
  const batchKey = newBatchKey()
  try {
    await db.batch(items.flatMap(({ p, from }) => [
      db.prepare(`INSERT INTO attendance_corrections (company_id, project_id, shift_id, staff_id, attendance_id, kind, report_type, before_at, requested_at, reason, order_warnings,
          status, requested_by, requested_by_name, requested_by_role, resubmitted_from, created_at, updated_at, batch_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(shift.company_id, shift.project_id, shift.shift_id, shift.staff_id, p.attendance_id, p.kind, p.report_type, p.before_at, p.requested_at, p.reason,
          p.warnings.length ? JSON.stringify(p.warnings) : null, a.user_id, a.name, a.role, from, at, at, batchKey),
      db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
        SELECT correction_id, company_id, ?, ?, ?, ?, ?, ? FROM attendance_corrections WHERE shift_id = ? AND report_type = ? AND status = 'pending'`)
        .bind(from ? 'resubmitted' : 'submitted', a.user_id, a.name, a.role,
          JSON.stringify({ kind: p.kind, before_at: p.before_at, requested_at: p.requested_at, reason: p.reason, warnings: p.warnings, resubmitted_from: from, ...(items.length > 1 ? { bulk: items.length } : {}) }),
          at, shift.shift_id, p.report_type),
    ]))
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message || e))) return { error: 'この報告には承認待ちの申請があります', status: 409 as const }
    throw e
  }
  const types = items.map(i => i.p.report_type)
  const rows = (await db.prepare(`SELECT correction_id, report_type, resubmitted_from FROM attendance_corrections WHERE shift_id = ? AND status = 'pending' AND report_type IN (${types.map(() => '?').join(',')}) ORDER BY correction_id`)
    .bind(shift.shift_id, ...types).all()).results as any[]
  return { corrections: rows.map(r => ({ correction_id: r.correction_id as number, report_type: r.report_type as string, resubmitted: !!r.resubmitted_from })) }
}
async function insertCorrection(db: D1Database, shift: any, p: Prepared, a: Actor, resubmittedFrom: number | null) {
  const r = await insertCorrections(db, shift, [{ p, from: resubmittedFrom }], a)
  if ('error' in r) return r
  return { correction_id: r.corrections[0]?.correction_id, warnings: p.warnings, notices: p.notices }
}

// 同じ報告の最新の申請が、本人が出して却下され、まだ再申請していないものなら、その申請（新しい申請を再申請としてつなぐ。#399）
async function unresolvedRejection(db: D1Database, shiftId: number, staffId: number, type: string, selfIds: number[]): Promise<number | null> {
  const r = await db.prepare(`SELECT correction_id, status, requested_by FROM attendance_corrections WHERE shift_id = ? AND staff_id = ? AND report_type = ? ORDER BY correction_id DESC LIMIT 1`)
    .bind(shiftId, staffId, type).first() as any
  return r && r.status === 'rejected' && selfIds.includes(r.requested_by) ? r.correction_id : null
}

// まとめて申請（#214）: 1シフトの複数の報告の時刻を、理由1つで申請する。
// 順序は、申請するすべての時刻を反映した後の組み合わせで確かめる。承認は1件ずつなので、
// 上から順に承認すれば途中で矛盾しない順番に並べて登録する（承認待ちの一覧は申請の古い順・ID の小さい順）
async function prepareBulk(db: D1Database, shift: any, b: any, opts: PrepareOpts): Promise<Prepared[] | Fail> {
  const items = Array.isArray(b.items) ? b.items : []
  if (!items.length || items.length > BULK_MAX) return { error: `まとめて申請できる報告は1〜${BULK_MAX}件です`, status: 400 }
  const others = new Map<string, string>()
  for (const it of items) {
    if (!isReportType(it?.report_type)) return { error: '報告の種類を選択してください', status: 400 }
    if (others.has(it.report_type)) return { error: `${REPORT_LABEL[it.report_type]}が2回含まれています`, status: 400 }
    const at = normalizeDateTime(it.requested_at)
    if (!at) return { error: `${REPORT_LABEL[it.report_type]}の日付と時刻を正しく入力してください`, status: 400, report_type: it.report_type }
    others.set(it.report_type, at)
  }
  const reports = await loadReports(db, shift.shift_id)
  const preps: Prepared[] = []
  for (const [type, at] of others) {
    const kind = reports.some(r => r.report_type === type) ? 'modify' : 'add'
    const p = await prepareRequest(db, shift, { kind, report_type: type, requested_at: at, reason: b.reason }, { ...opts, others })
    if ('error' in p) return { ...p, error: items.length > 1 ? `${REPORT_LABEL[type]}: ${p.error}` : p.error, report_type: type }
    preps.push(p)
  }
  // 1件ずつ承認しても矛盾しない順番（矛盾のないものから。打刻漏れの追加は例外として承認できるので最後に回す）
  const now = reportMap(reports)
  const ordered: Prepared[] = []
  const rest = [...preps]
  while (rest.length) {
    const fits = (p: Prepared) => !orderConflicts(new Map([...now].filter(([t]) => t !== p.report_type)), p.report_type, p.requested_at).length
    let i = rest.findIndex(fits)
    if (i < 0) i = rest.findIndex(p => p.kind === 'add')
    if (i < 0) return { error: '1件ずつ承認できる順番がない組み合わせです。管理者に連絡してください', status: 400 }
    const [p] = rest.splice(i, 1)
    now.set(p.report_type, p.requested_at); ordered.push(p)
  }
  return ordered
}

// スタッフの申請の回数の上限（同じ人のユーザーが直近1時間に出した申請の数。取り消した申請も数える。#392）
async function overHourlyLimit(db: D1Database, staffIds: number[], selfIds: number[], adding: number): Promise<Fail | null> {
  const since = new Date(Date.now() + 9 * 3600 * 1000 - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  const q = (ids: number[]) => ids.map(() => '?').join(',')
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id IN (${q(staffIds)}) AND requested_by IN (${q(selfIds)}) AND created_at >= ?`)
    .bind(...staffIds, ...selfIds, since).first() as any
  if (Number(r?.n || 0) + adding <= CORRECTION_HOURLY_LIMIT) return null
  return { error: `短い時間に申請が多すぎます（1時間に${CORRECTION_HOURLY_LIMIT}件まで）。しばらくしてから申請してください`, status: 429 }
}

// ---------- 承認・却下・取り消し ----------
const DONE_MESSAGE: Record<string, string> = { approved: 'この申請はすでに承認されています', rejected: 'この申請はすでに却下されています', cancelled: 'この申請は取り消されています' }

// 承認で反映する報告の status（#69）。遅刻は承認する日時で判定し直す（アプリの報告と同じ report-settings.ts の lateness）。
// 時刻修正で、位置が取れなかった本人の入店（no_location）は、遅刻でなければ no_location のまま（時刻を直しても位置は変わらないため）
function correctedStatus(j: ReportLateness, prev: any | null): 'late' | 'no_location' | 'normal' {
  if (j.late) return 'late'
  if (prev && j.report_type === 'check_in' && prev.latitude == null
    && (prev.status === 'no_location' || (prev.status === 'late' && !['proxy', 'correction'].includes(prev.entry_method || 'app')))) return 'no_location'
  return 'normal'
}
// 承認者が直した日時の範囲（申請と同じ: 稼働日の前日 0:00 から翌日 23:59 まで）
const inShiftRange = (workDate: string, at: string) => at >= `${addDays(workDate, -1)} 00:00:00` && at <= `${addDays(workDate, 1)} 23:59:59`

// 承認する日時での遅刻・早退の判定（#69）と、承認した場合の実績・金額（変更前 → 変更後。#443）。書き込みはしない。
// 実績は syncActualFromReports と同じ規則（確定済み・手入力の実績は変えない）で計算する
async function judgeApproval(db: D1Database, c: any, shift: any, reports: any[], at: string) {
  const co = await db.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(c.company_id).first() as any
  const judged = lateness(shift, [{ report_type: c.report_type, reported_at: at }], await latenessSettingsFor(db, co?.settings_json, shift.project_id))[0]
  const prev = reports.find(r => r.report_type === c.report_type) || null
  const status = prev ? correctedStatus(judged, prev) : (judged.late ? 'late' : 'normal')
  return { judged, status, prev }
}
async function approvalPreview(db: D1Database, c: any, reports: any[], at: string, j: { judged: ReportLateness; status: string; prev: any }) {
  const s = await db.prepare('SELECT * FROM shifts WHERE shift_id = ? AND company_id = ?').bind(c.shift_id, c.company_id).first() as any
  if (!s) return null
  const proj: any = (await loadPricingData(db, c.company_id, [Number(s.project_id)])).projects.get(Number(s.project_id)) || {}
  const view = (x: any) => {
    const w = workHours({ ...x, break_minutes: x.break_minutes ?? proj.default_break_minutes ?? 0 }, proj)
    const t = shiftTotals(x)
    return { actual_start: x.actual_start || null, actual_end: x.actual_end || null, actual_break_minutes: x.actual_break_minutes ?? null,
      hours: w.hours, pay_hours: w.pay_hours, used: w.used, bill_total: t.bill_total, pay_total: t.pay_total }
  }
  const before = view(s)
  const fixed = isSettled(s) ? 'settled' : s.actual_source === 'manual' ? 'manual' : null
  let after = before
  if (!fixed) {
    const a = actualFromReports(t => (t === c.report_type ? at : reports.find(r => r.report_type === t)?.reported_at))
    const ns = { ...s, actual_start: a.start, actual_end: a.end, actual_break_minutes: a.brk }
    after = view({ ...ns, ...(amountsForActual(ns, proj) || {}) })
  }
  return {
    requested_at: at,
    actual: { before, after, fixed },
    lateness: {
      before: j.prev ? { status: j.prev.status, late_minutes: j.prev.late_minutes, early_leave_minutes: j.prev.early_leave_minutes } : null,
      after: { status: j.status, late_minutes: j.judged.late_minutes, early_leave_minutes: j.judged.early_leave_minutes },
    },
  }
}

// 承認。requested_at を渡すと、承認者が日時を直して承認する（#548。直した理由のコメントは必須。申請の日時は操作履歴に残す）。
// 申請の後に打刻が変わった時刻修正は、承認者が今の記録を確かめた（base_at = 今の記録の日時）ときだけ、今の記録をもとに承認する。
// dry_run は書き込まずに、承認した場合の遅刻の判定と実績・金額を返す
// with_request: 管理者が申請と同時に承認した（#174。操作履歴の detail に残す）
type ApproveOpts = { comment?: any; exception?: any; requested_at?: any; base_at?: any; dry_run?: any; with_request?: boolean }
async function approveCorrection(db: D1Database, c: any, a: Actor, opts: ApproveOpts) {
  if (c.status !== 'pending') return { error: DONE_MESSAGE[c.status] || '承認できない状態です', status: 409 }
  const comment = String(opts.comment ?? '').trim().slice(0, REASON_MAX) || null
  const dryRun = opts.dry_run === true
  let at: string = c.requested_at, adjusted = false
  if (opts.requested_at != null && String(opts.requested_at).trim() !== '') {
    const n = normalizeDateTime(opts.requested_at)
    if (!n) return { error: '承認する日時を正しく入力してください', status: 400 }
    if (n.slice(0, 16) !== String(c.requested_at).slice(0, 16)) { at = n; adjusted = true }
  }
  if (adjusted && !comment && !dryRun) return { error: '日時を修正して承認するときは、修正の理由をコメントに入力してください（申請者に知らせます）', status: 400 }
  const shift = await loadShift(db, c.shift_id)
  if (!shift) return { error: '対象のシフトが見つかりません', status: 409 }
  // 申請の後にシフトの担当者が差し替えられた・欠勤になった・希望（仮）に戻された場合は承認しない（#101 #70 #559）
  if (shift.staff_id !== c.staff_id) return { error: 'シフトの担当者が変わったため承認できません。却下してください', status: 409 }
  if (shift.status === 'absent') return { error: '欠勤のシフトです。承認できないため却下してください', status: 409 }
  if (!isWorkingShift(shift.status)) return { error: '未確定（希望（仮））のシフトです。シフトを確定してから承認するか、却下してください', status: 409 }
  if (adjusted && !inShiftRange(shift.work_date, at)) return { error: `日時は稼働日（${fmtDay(shift.work_date)}）の前日から翌日までの範囲で入力してください`, status: 400 }
  const reports = await loadReportsDetail(db, c.shift_id)
  const existing = reports.find(r => r.report_type === c.report_type)
  const conflicts = orderConflicts(reportMap(reports.filter(r => r.report_type !== c.report_type)), c.report_type, at)
  let exception = 0, before: string | null = c.before_at, rebased = false
  if (c.kind === 'modify') {
    if (!existing || existing.attendance_id !== c.attendance_id) {
      return { error: '申請の後に打刻が変更されました。内容を確認し、却下して再申請してもらってください', status: 409 }
    }
    if (existing.reported_at !== c.before_at) {
      if (opts.base_at == null || String(opts.base_at) !== existing.reported_at)
        return { error: `申請の後に打刻が変更されました（今の記録: ${fmt(existing.reported_at)}）。今の記録をもとに日時を確かめて承認するか、却下してください`, status: 409, changed: true, current_at: existing.reported_at }
      before = existing.reported_at; rebased = true
    }
    if (String(before).slice(0, 16) === at.slice(0, 16)) return { error: '変更前と同じ日時です（承認しても記録は変わりません）。日時を直すか、却下してください', status: 400 }
    if (conflicts.length) return { error: `報告の順序に矛盾があるため承認できません: ${conflicts.join(' / ')}`, status: 409, conflicts }
  } else {
    if (existing) return { error: 'この報告はすでに登録されています（二重登録になるため承認できません）', status: 409 }
    if (conflicts.length) {
      if (opts.exception !== true && !dryRun) return { error: '報告の順序に矛盾があります。内容を確認し、例外として承認してください', status: 409, conflicts, need_exception: true }
      exception = 1
    }
  }
  // 遅刻・早退を承認する日時で判定し直す（#69）
  const j = await judgeApproval(db, c, shift, reports, at)
  if (dryRun) {
    return { ok: true, dry_run: true, adjusted, rebased, conflicts, need_exception: c.kind === 'add' && conflicts.length > 0, preview: await approvalPreview(db, c, reports, at, j) }
  }
  const nowAt = nowJST(), token = randToken(), settled = shift.settle_status === 'confirmed' ? 1 : 0
  // 実績が手入力のシフトは、報告を直しても実績・金額は変わらない（syncActualFromReports は手入力を上書きしない）。
  // 操作履歴（applied_while_manual）と応答で知らせ、精算の確認事項「手入力後に打刻修正あり」に出す
  const manual = !settled && shift.actual_source === 'manual'
  const applied = `EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id = ? AND decision_token = ?)`
  // 承認と同時にシフトが差し替え・欠勤にされても反映しない（担当者が申請と同じで、勤務として扱う状態のときだけ承認する）
  const shiftOk = `EXISTS (SELECT 1 FROM shifts WHERE shift_id = ? AND staff_id = ? AND status IN ${WORKING_IN})`
  // 申請の日時・変更前は、承認した内容に書き換える（申請のときの日時は操作履歴の submitted と approved の detail に残る。#548）
  const guard = c.kind === 'modify'
    ? db.prepare(`UPDATE attendance_corrections SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_token = ?, decision_comment = ?,
          is_exception = 0, applied_while_settled = ?, requested_at = ?, before_at = ?, updated_at = ?
        WHERE correction_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM attendance_reports WHERE attendance_id = ? AND shift_id = ? AND report_type = ? AND reported_at = ?) AND ${shiftOk}`)
      .bind(a.user_id, a.name, nowAt, token, comment, settled, at, before, nowAt, c.correction_id, c.attendance_id, c.shift_id, c.report_type, before, c.shift_id, c.staff_id)
    : db.prepare(`UPDATE attendance_corrections SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_token = ?, decision_comment = ?,
          is_exception = ?, order_warnings = ?, applied_while_settled = ?, requested_at = ?, updated_at = ?
        WHERE correction_id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?) AND ${shiftOk}`)
      .bind(a.user_id, a.name, nowAt, token, comment, exception, conflicts.length ? JSON.stringify(conflicts) : c.order_warnings, settled, at, nowAt, c.correction_id, c.shift_id, c.report_type, c.shift_id, c.staff_id)
  // 承認で変わった報告に修正の印を付ける。元の打刻の方法（entry_method）は変えず、最初の修正の前の日時を残す（#252）。
  // 遅刻・早退の判定（status・late_minutes・early_leave_minutes）も承認した日時で入れ直す（#69。ToDo・スタッフ詳細は保存された値を読む）
  const apply = c.kind === 'modify'
    ? db.prepare(`UPDATE attendance_reports SET reported_at = ?, status = ?, late_minutes = ?, early_leave_minutes = ?,
          original_reported_at = COALESCE(original_reported_at, reported_at), corrected_by_correction_id = ?, corrected_at = ?
        WHERE attendance_id = ? AND ${applied}`)
      .bind(at, j.status, j.judged.late_minutes, j.judged.early_leave_minutes, c.correction_id, nowAt, c.attendance_id, c.correction_id, token)
    : db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, late_minutes, early_leave_minutes, device_info, entry_method, entered_by, corrected_by_correction_id, corrected_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'correction', 'correction', ?, ?, ? WHERE ${applied}`)
      .bind(c.company_id, c.staff_id, c.shift_id, c.report_type, at, j.status, j.judged.late_minutes, j.judged.early_leave_minutes, a.user_id, c.correction_id, nowAt, c.correction_id, token)
  // 入店・退店の報告に写真がなければ、申請に添付した1枚目を報告の写真にする（#485。同じ R2 のオブジェクトを指す）
  const photo = PHOTO_TYPES.includes(c.report_type)
    ? [db.prepare(`UPDATE attendance_reports SET photo_key = (SELECT photo_key FROM attendance_correction_attachments WHERE correction_id = ? ORDER BY attachment_id LIMIT 1)
        WHERE shift_id = ? AND report_type = ? AND photo_key IS NULL AND ${applied}`).bind(c.correction_id, c.shift_id, c.report_type, c.correction_id, token)]
    : []
  const event = exception ? 'approved_exception' : 'approved'
  const detail = {
    comment, before_at: before, requested_at: at, exception: !!exception, conflicts, applied_while_settled: !!settled, ...(manual ? { applied_while_manual: true } : {}),
    // 承認者が日時を直した（#548）・申請の後に変わった今の記録をもとに承認した
    ...(adjusted ? { adjusted: true, requested_at_original: c.requested_at } : {}),
    ...(rebased ? { rebased: true, before_at_original: c.before_at } : {}),
    ...(opts.with_request ? { with_request: true } : {}),
    // 遅刻の判定の変化（#69）
    before_status: j.prev ? j.prev.status : null, report_status: j.status, late_minutes: j.judged.late_minutes, early_leave_minutes: j.judged.early_leave_minutes,
  }
  try {
    await db.batch([
      guard, apply, ...photo,
      db.prepare(`UPDATE attendance_corrections SET applied_attendance_id = (SELECT attendance_id FROM attendance_reports WHERE shift_id = ? AND report_type = ?) WHERE correction_id = ? AND decision_token = ?`)
        .bind(c.shift_id, c.report_type, c.correction_id, token),
      db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${applied}`)
        .bind(c.correction_id, c.company_id, event, a.user_id, a.name, a.role, JSON.stringify(detail), nowAt, c.correction_id, token),
    ])
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message || e))) return { error: 'この報告はすでに登録されています（二重登録になるため承認できません）', status: 409 }
    throw e
  }
  const after = await db.prepare('SELECT status, decision_token FROM attendance_corrections WHERE correction_id = ?').bind(c.correction_id).first() as any
  if (!after || after.decision_token !== token) {
    if (after && after.status !== 'pending') return { error: DONE_MESSAGE[after.status] || '処理できませんでした', status: 409 }
    return { error: '申請の後に打刻またはシフトが変更されました。内容を確認してください', status: 409 }
  }
  // 実績・時給の数量に反映（確定済み・手入力の実績は既存の規則どおり変えない）
  await syncActualFromReports(db, c.company_id, c.shift_id).catch(() => {})
  return { ok: true, exception: !!exception, applied_while_settled: !!settled, applied_while_manual: manual, adjusted, requested_at: at, report_status: j.status, late_minutes: j.judged.late_minutes }
}

async function rejectCorrection(db: D1Database, c: any, a: Actor, reasonIn: any, commentIn: any) {
  if (c.status !== 'pending') return { error: DONE_MESSAGE[c.status] || '却下できない状態です', status: 409 }
  const reason = String(reasonIn ?? '').trim()
  if (!reason) return { error: '却下理由を入力してください', status: 400 }
  if (reason.length > REASON_MAX) return { error: `却下理由は${REASON_MAX}文字以内で入力してください`, status: 400 }
  const comment = String(commentIn ?? '').trim().slice(0, REASON_MAX) || null
  const at = nowJST(), token = randToken()
  await db.batch([
    db.prepare(`UPDATE attendance_corrections SET status = 'rejected', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_token = ?, reject_reason = ?, decision_comment = ?, updated_at = ?
      WHERE correction_id = ? AND status = 'pending'`).bind(a.user_id, a.name, at, token, reason, comment, at, c.correction_id),
    db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
      SELECT ?, ?, 'rejected', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id = ? AND decision_token = ?)`)
      .bind(c.correction_id, c.company_id, a.user_id, a.name, a.role, JSON.stringify({ reason, comment }), at, c.correction_id, token),
  ])
  const after = await db.prepare('SELECT status, decision_token FROM attendance_corrections WHERE correction_id = ?').bind(c.correction_id).first() as any
  if (!after || after.decision_token !== token) return { error: DONE_MESSAGE[after?.status] || '処理できませんでした', status: 409 }
  return { ok: true }
}

// 取り消しは申請者本人のみ・承認待ちのみ。
// 本人かどうかは selfIds で判定する（スタッフ = 同じ人のすべてのユーザー。所属企業を切り替えても自分の申請を取り消せる #96。管理者 = 自分のユーザー）
async function cancelCorrection(db: D1Database, c: any, a: Actor, selfIds: number[] = [a.user_id]) {
  if (!selfIds.includes(c.requested_by)) return { error: '取り消せるのは申請者本人のみです', status: 403 }
  if (c.status !== 'pending') return { error: DONE_MESSAGE[c.status] || '取り消せない状態です', status: 409 }
  const at = nowJST(), token = randToken()
  await db.batch([
    db.prepare(`UPDATE attendance_corrections SET status = 'cancelled', cancelled_at = ?, decision_token = ?, updated_at = ? WHERE correction_id = ? AND status = 'pending' AND requested_by = ?`)
      .bind(at, token, at, c.correction_id, c.requested_by),
    db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
      SELECT ?, ?, 'cancelled', ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id = ? AND decision_token = ?)`)
      .bind(c.correction_id, c.company_id, a.user_id, a.name, a.role, at, c.correction_id, token),
  ])
  const after = await db.prepare('SELECT status, decision_token FROM attendance_corrections WHERE correction_id = ?').bind(c.correction_id).first() as any
  if (!after || after.decision_token !== token) return { error: DONE_MESSAGE[after?.status] || '処理できませんでした', status: 409 }
  return { ok: true }
}

// シフトの削除・担当者の差し替えで、承認待ちの申請を自動で取り消す（#70 #101）。
// 戻り値の文は、シフトの削除・更新と同じ db.batch に入れる。exceptStaffId を渡すと、そのスタッフの申請は残す（差し替え後の担当者の申請）。
// token は取り消した申請を後から探すための識別子（decision_token）。batch の後に notifyAutoCancelled(c, shiftId, token) で申請者に知らせる
export function autoCancelStatements(db: D1Database, shiftId: number, reason: 'shift_deleted' | 'staff_changed', a: Actor, token: string, exceptStaffId?: number): D1PreparedStatement[] {
  const at = nowJST()
  const except = exceptStaffId != null ? ' AND staff_id != ?' : ''
  return [
    db.prepare(`UPDATE attendance_corrections SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?, decision_token = ?, updated_at = ?
      WHERE shift_id = ? AND status = 'pending'${except}`).bind(reason, at, token, at, shiftId, ...(exceptStaffId != null ? [exceptStaffId] : [])),
    db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
      SELECT correction_id, company_id, 'cancelled', ?, ?, ?, ?, ? FROM attendance_corrections WHERE shift_id = ? AND decision_token = ? AND status = 'cancelled'`)
      .bind(a.user_id, a.name, a.role, JSON.stringify({ auto: true, reason }), at, shiftId, token),
  ]
}
export async function notifyAutoCancelled(c: any, shiftId: number, token: string): Promise<number> {
  const rows = (await c.env.DB.prepare(`SELECT correction_id FROM attendance_corrections WHERE shift_id = ? AND decision_token = ? AND status = 'cancelled'`).bind(shiftId, token).all()).results as any[]
  for (const r of rows) await notifyCorrection(c, r.correction_id, 'cancelled')
  return rows.length
}
export function newCancelToken(): string { return randToken() }
// シフトの承認待ちの申請の件数（差し替え・欠勤・削除の前の確認に使う）
export async function pendingCorrectionCount(db: D1Database, shiftId: number, exceptStaffId?: number): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE shift_id = ? AND status = 'pending'${exceptStaffId != null ? ' AND staff_id != ?' : ''}`)
    .bind(shiftId, ...(exceptStaffId != null ? [exceptStaffId] : [])).first() as any
  return Number(r?.n || 0)
}

// 再申請: 却下された自分の申請をもとに、新しい申請を作る（元の申請と却下の履歴は残す）
// selfIds は cancelCorrection と同じ。ownStaffIds（スタッフ本人のスタッフID）を渡したときは、今のシフトが本人のものかも確かめる
async function resubmitCorrection(db: D1Database, c: any, a: Actor, b: any, selfIds: number[] = [a.user_id], ownStaffIds?: number[]) {
  if (!selfIds.includes(c.requested_by)) return { error: '再申請できるのは申請者本人のみです', status: 403 }
  if (c.status !== 'rejected') return { error: '再申請できるのは却下された申請のみです', status: 409 }
  // 同じ報告に後から出した申請があるとき（再申請済み・打刻履歴から申請し直した）は、その申請の結果を見て申請し直す（#399）
  const later = await db.prepare('SELECT correction_id FROM attendance_corrections WHERE shift_id = ? AND report_type = ? AND correction_id > ? ORDER BY correction_id DESC LIMIT 1')
    .bind(c.shift_id, c.report_type, c.correction_id).first() as any
  if (later) return { error: `この報告は、後の申請 #${later.correction_id} で申請し直しています。そちらの結果を確認してください`, status: 409 }
  const shift = await loadShift(db, c.shift_id)
  if (!shift) return { error: '対象のシフトが見つかりません', status: 404 }
  // 申請の後にシフトの担当者が差し替えられた場合は、前の担当者の申請から作り直さない（#101）
  if (shift.staff_id !== c.staff_id || (ownStaffIds && !ownStaffIds.includes(shift.staff_id)))
    return { error: 'シフトの担当者が変わったため再申請できません', status: 409 }
  // 報告の種類とシフトは元の申請と同じ。申請の種類は今の登録状況から決める（却下後に報告が登録・変更されている場合があるため）
  const exists = (await loadReports(db, c.shift_id)).some(r => r.report_type === c.report_type)
  const body = { kind: exists ? 'modify' : 'add', report_type: c.report_type, requested_at: b.requested_at ?? c.requested_at, reason: b.reason ?? c.reason }
  const p = await prepareRequest(db, shift, body, { staff: !!ownStaffIds })
  if ('error' in p) return p
  if (b.dry_run) return { ok: true, dry_run: true, ...p }
  return insertCorrection(db, shift, p, a, c.correction_id)
}

// 詳細（操作履歴・再申請の連なり・同じ報告の過去の申請・今の報告・今の矛盾）
async function correctionDetail(db: D1Database, c: any, viewer: 'admin' | 'staff') {
  const events = (await db.prepare('SELECT event, actor_name, actor_role, detail, created_at FROM attendance_correction_events WHERE correction_id = ? ORDER BY event_id').bind(c.correction_id).all()).results as any[]
  const related = (await db.prepare(`SELECT correction_id, kind, status, requested_at, before_at, reason, reject_reason, decision_comment, requested_by_name, decided_by_name, decided_at, created_at, resubmitted_from, is_exception
    FROM attendance_corrections WHERE shift_id = ? AND report_type = ? ${viewer === 'staff' ? 'AND staff_id = ?' : ''} ORDER BY correction_id`)
    .bind(c.shift_id, c.report_type, ...(viewer === 'staff' ? [c.staff_id] : [])).all()).results as any[]
  // 担当者が差し替えられたシフトの今の報告（新しい担当者の打刻）は、前の担当者には返さない（#101）
  const owner = viewer === 'staff' ? await db.prepare('SELECT staff_id FROM shifts WHERE shift_id = ?').bind(c.shift_id).first() as any : null
  // 管理者には、承認の根拠として元の打刻の方法・入力者・位置・写真の有無・遅刻の判定も返す（#443）
  const reports = viewer === 'staff' && owner?.staff_id !== c.staff_id ? [] : viewer === 'admin' ? await loadReportsDetail(db, c.shift_id) : await loadReports(db, c.shift_id)
  const current = c.status === 'pending' ? orderConflicts(reportMap(reports.filter(r => r.report_type !== c.report_type)), c.report_type, c.requested_at) : []
  const out: any = {
    correction: { ...c, decision_token: undefined, order_warnings: parseWarnings(c), status_label: STATUS_LABEL[c.status], kind_label: KIND_LABEL[c.kind], report_label: REPORT_LABEL[c.report_type] },
    events: events.map(e => ({ ...e, detail: (() => { try { return e.detail ? JSON.parse(e.detail) : null } catch { return null } })() })),
    history: related, reports, current_conflicts: current,
    // 添付した写真・画像（#485）。画像は管理者 GET /api/admin/corrections/attachments/:id、本人 GET /api/staff/corrections/attachments/:id で取る
    attachments: await loadAttachments(db, c), attachment_max: ATTACHMENT_MAX,
  }
  if (viewer === 'admin') {
    const s = await db.prepare(`SELECT p.photo_required_override, co.settings_json FROM projects p JOIN companies co ON co.company_id = p.company_id WHERE p.project_id = ?`).bind(c.project_id).first() as any
    // 写真が必須の案件の入店・退店か（承認の前に、添付の有無を確かめてもらう）
    out.photo_required = !!s && PHOTO_TYPES.includes(c.report_type) && photoRequiredFor(s.settings_json, s.photo_required_override)
  }
  if (viewer === 'admin' && c.status === 'pending') {
    // 承認した場合の遅刻の判定と実績・金額（変更前 → 変更後）。計算できなくても詳細は返す
    try {
      const shift = await loadShift(db, c.shift_id)
      if (shift) out.preview = await approvalPreview(db, c, reports, c.requested_at, await judgeApproval(db, c, shift, reports, c.requested_at))
    } catch { out.preview = null }
  }
  if (viewer === 'staff') {
    // スタッフ本人には承認者の識別情報（ロール）と処理の内部情報を返さない
    out.events = out.events.map((e: any) => ({ event: e.event, actor_name: e.actor_name, created_at: e.created_at }))
  }
  return out
}

// =========================================================
// 管理者 API（/api/admin/*。自社のシフトの申請のみ）
// =========================================================
export const correctionsAdminApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// スタッフ本人の申請（打刻修正・交通費や延長の申請）の受付期限（#215）。deadline_days: 勤務日から何日後まで（null は期限なし）。
// 管理者が代わりに出す申請・承認には期限を当てない。確定済みのシフトへの申請は期限内でも受け付け、承認されても支払額は自動では変わらない（SETTLED_NOTICE）
export const CORRECTION_DEADLINE_MAX = 366
correctionsAdminApi.get('/settings/corrections', async (c) => {
  const u = c.get('user')
  const row = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  return c.json({ deadline_days: correctionDeadlineDays(row?.settings_json), max_days: CORRECTION_DEADLINE_MAX, can_edit: canEditAttendanceSettings(u) })
})
correctionsAdminApi.put('/settings/corrections', async (c) => {
  const u = c.get('user')
  if (!canEditAttendanceSettings(u)) return c.json({ error: ATTENDANCE_SETTING_DENIED, code: 'role_forbidden' }, 403)
  const b = await c.req.json().catch(() => ({} as any))
  const d = b.deadline_days
  if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= CORRECTION_DEADLINE_MAX)) {
    return c.json({ error: `受付期限は 1〜${CORRECTION_DEADLINE_MAX} 日の整数で入力してください（空欄なら期限なし）` }, 400)
  }
  // ほかの設定を上書きしないよう、この項目だけを書き換える（null は項目を消す）
  await c.env.DB.prepare(`UPDATE companies SET settings_json = ${d === null ? `json_remove(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.correction_deadline_days')`
    : `json_set(CASE WHEN json_valid(settings_json) THEN settings_json ELSE '{}' END, '$.correction_deadline_days', ?)`} WHERE company_id = ?`)
    .bind(...(d === null ? [] : [d]), u.company_id).run()
  return c.json({ ok: true, deadline_days: d })
})

async function ownCorrection(c: any) {
  const row = await loadCorrection(c.env.DB, c.req.param('id'))
  return row && row.company_id === c.get('user').company_id ? row : null
}
const send = (c: any, r: any) => ('error' in r ? c.json(r, r.status) : c.json(r))
// 成功したら通知（アプリ内・メール）を送ってから応答する。通知の失敗は結果に影響しない
async function sendAndNotify(c: any, r: any, correctionId: number | undefined, event: CorrectionEvent) {
  if (!('error' in r) && correctionId) await notifyCorrection(c, correctionId, event)
  return send(c, r)
}

correctionsAdminApi.get('/corrections/pending-count', async (c) => {
  const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM attendance_corrections WHERE company_id = ? AND status = 'pending'`).bind(c.get('user').company_id).first() as any
  return c.json({ count: r?.n || 0 })
})

// スタッフは氏名の一部か、社員番号（完全一致）で探す（#445。er は employee_records）
function staffNameFilter(name: string | undefined, w: string[], bind: any[]) {
  if (!name) return
  w.push("(us.name LIKE ? ESCAPE '\\' OR er.employee_number = ?)")
  bind.push('%' + String(name).replace(/[\\%_]/g, m => '\\' + m) + '%', String(name))
}
// 一覧・CSV の絞り込み（状態・案件・スタッフ名・申請期間・対象日・報告種類・申請種類）
function correctionFilter(companyId: number, q: (k: string) => string | undefined) {
  const w = ['c.company_id = ?']; const bind: any[] = [companyId]
  if (CORRECTION_STATUSES.includes(q('status') as any)) { w.push('c.status = ?'); bind.push(q('status')) }
  if (q('project_id')) { w.push('c.project_id = ?'); bind.push(Number(q('project_id'))) }
  staffNameFilter(q('staff_name'), w, bind)
  if (isDate(q('from'))) { w.push('c.created_at >= ?'); bind.push(q('from') + ' 00:00:00') }
  if (isDate(q('to'))) { w.push('c.created_at <= ?'); bind.push(q('to') + ' 23:59:59') }
  if (isDate(q('work_from'))) { w.push('s.work_date >= ?'); bind.push(q('work_from')) }
  if (isDate(q('work_to'))) { w.push('s.work_date <= ?'); bind.push(q('work_to')) }
  if (isReportType(q('report_type'))) { w.push('c.report_type = ?'); bind.push(q('report_type')) }
  if (q('kind') === 'modify' || q('kind') === 'add') { w.push('c.kind = ?'); bind.push(q('kind')) }
  return { where: w.join(' AND '), bind }
}
const CORRECTION_FROM = `FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = c.staff_id AND er.company_id = c.company_id`
const LIST_LIMIT = 300
correctionsAdminApi.get('/corrections', async (c) => {
  const u = c.get('user')
  const { where, bind } = correctionFilter(u.company_id, k => c.req.query(k))
  // 承認待ちは待っている時間の長い順（申請の古い順）、それ以外は新しい順。上限を超えたら truncated で知らせる（#226）
  // sort=work_date は、承認待ちを勤務日の古い順にする（締めの前に古い勤務日から処理する。#280）
  const byWorkDate = c.req.query('sort') === 'work_date'
  const rows = (await c.env.DB.prepare(`SELECT c.correction_id, c.kind, c.report_type, c.status, c.before_at, c.requested_at, c.reason, c.order_warnings, c.is_exception,
      c.requested_by_name, c.created_at, c.decided_by_name, c.decided_at, c.resubmitted_from, c.shift_id, s.work_date, p.project_name, p.status AS project_status, us.name AS staff_name,
      s.settle_status, s.actual_source, p.photo_required_override,
      (SELECT COUNT(*) FROM attendance_correction_attachments a JOIN attendance_corrections x ON x.correction_id = a.correction_id
        WHERE x.correction_id = c.correction_id OR (x.shift_id = c.shift_id AND x.requested_by = c.requested_by AND x.created_at = c.created_at AND x.batch_key IS c.batch_key)) AS attachment_count
    ${CORRECTION_FROM}
    WHERE ${where} ORDER BY CASE WHEN c.status = 'pending' THEN 0 ELSE 1 END,
      ${byWorkDate ? "CASE WHEN c.status = 'pending' THEN s.work_date END ASC," : ''}
      CASE WHEN c.status = 'pending' THEN c.created_at END ASC, CASE WHEN c.status = 'pending' THEN c.correction_id END ASC, c.correction_id DESC
    LIMIT ${LIST_LIMIT + 1}`).bind(...bind).all()).results as any[]
  const truncated = rows.length > LIST_LIMIT
  const co = await c.env.DB.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  // タブの件数は、状態以外の絞り込みを反映して数える
  const f = correctionFilter(u.company_id, k => (k === 'status' ? undefined : c.req.query(k)))
  const counts = (await c.env.DB.prepare(`SELECT c.status, COUNT(*) AS n ${CORRECTION_FROM} WHERE ${f.where} GROUP BY c.status`).bind(...f.bind).all()).results as any[]
  return c.json({
    corrections: rows.slice(0, LIST_LIMIT).map(({ settle_status, actual_source, photo_required_override, ...r }) => {
      const x = { ...r, order_warnings: parseWarnings(r) }
      // まとめて承認できない理由（承認待ちのみ。個別に開いて確かめる。#280）
      const block = r.status !== 'pending' ? null : bulkBlockReason(x, { settle_status, actual_source }, photoRequiredFor(co?.settings_json, photo_required_override), Number(r.attachment_count))
      return { ...x, bulk_block: block }
    }),
    counts: Object.fromEntries(counts.map(r => [r.status, r.n])), labels: REPORT_LABEL, truncated, limit: LIST_LIMIT,
  })
})

// CSV（一覧と同じ絞り込み。管理者のみ: /api/admin/* のため管理ロール以外は 403）
// 精算のシフト明細と突き合わせられるよう、シフトID・社員番号・クライアント・予定の時刻も出す（#445。既存の列の位置を変えないよう末尾に足す）。
// 新しい順に上限まで取り、古い順に出す。上限を超えたら先頭に注記を入れる（#102）
const CLIENT_JOIN = 'LEFT JOIN clients cl ON cl.client_id = p.client_id AND cl.company_id = p.company_id'
correctionsAdminApi.get('/corrections/export', async (c) => {
  const u = c.get('user')
  const { where, bind } = correctionFilter(u.company_id, k => c.req.query(k))
  const { rows, total } = await loadLatestForCsv(c.env.DB,
    `SELECT c.*, s.work_date, s.start_time, s.end_time, p.project_name, p.status AS project_status, cl.client_name, us.name AS staff_name, er.employee_number
    ${CORRECTION_FROM} ${CLIENT_JOIN} WHERE ${where} ORDER BY c.correction_id DESC`,
    `SELECT COUNT(*) AS n ${CORRECTION_FROM} WHERE ${where}`, bind)
  const csv = toCsv(['申請ID', '状態', '申請の種類', '案件', '案件の状態', 'スタッフ', '勤務日', '報告', '変更前', '変更後', '修正理由', '順序の矛盾', '例外承認',
    '申請者', '申請者のロール', '申請日時', '承認・却下した人', '承認・却下日時', '承認者コメント', '却下理由', '取り消し日時', '再申請の元の申請ID', '反映時に確定済み',
    'シフトID', '社員番号', 'クライアント', '予定開始', '予定終了'],
    rows.map(r => [r.correction_id, STATUS_LABEL[r.status] || r.status, KIND_LABEL[r.kind] || r.kind, r.project_name, (r.project_status || 'active') === 'active' ? '稼働中' : '終了',
      r.staff_name, r.work_date, REPORT_LABEL[r.report_type] || r.report_type, r.before_at, r.requested_at, r.reason, parseWarnings(r).join(' / '), r.is_exception ? 'あり' : '',
      r.requested_by_name, roleLabel(r.requested_by_role), r.created_at, r.status === 'cancelled' ? '' : r.decided_by_name, r.status === 'cancelled' ? '' : r.decided_at,
      r.decision_comment, r.reject_reason, r.cancelled_at, r.resubmitted_from, r.applied_while_settled ? 'はい' : '',
      r.shift_id, r.employee_number, r.client_name, r.start_time, r.end_time]),
    { textCols: ['社員番号'], note: csvLimitNote(total) })
  return csvResponse(`打刻修正申請_${nowJST().slice(0, 10)}.csv`, csv, csvLimitHeaders(total))
})

// 操作の履歴（申請・再申請・承認・例外承認・却下・取り消し）の検索と CSV
const EVENT_LABEL: Record<string, string> = { submitted: '申請', resubmitted: '再申請', approved: '承認', approved_exception: '例外承認', rejected: '却下', cancelled: '取り消し' }
function eventFilter(companyId: number, q: (k: string) => string | undefined) {
  const w = ['e.company_id = ?']; const bind: any[] = [companyId]
  const events = String(q('event') || '').split(',').filter(e => e in EVENT_LABEL)
  if (events.length) { w.push(`e.event IN (${events.map(() => '?').join(',')})`); bind.push(...events) }
  if (isDate(q('from'))) { w.push('e.created_at >= ?'); bind.push(q('from') + ' 00:00:00') }
  if (isDate(q('to'))) { w.push('e.created_at <= ?'); bind.push(q('to') + ' 23:59:59') }
  if (q('project_id')) { w.push('c.project_id = ?'); bind.push(Number(q('project_id'))) }
  staffNameFilter(q('staff_name'), w, bind)
  if (isReportType(q('report_type'))) { w.push('c.report_type = ?'); bind.push(q('report_type')) }
  return { where: w.join(' AND '), bind }
}
const EVENT_FROM = `FROM attendance_correction_events e JOIN attendance_corrections c ON c.correction_id = e.correction_id
  LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
  LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id
  LEFT JOIN employee_records er ON er.staff_id = c.staff_id AND er.company_id = c.company_id`
const EVENT_SELECT = `SELECT e.event_id, e.correction_id, e.event, e.actor_name, e.actor_role, e.detail, e.created_at, c.kind, c.report_type, c.status, c.resubmitted_from,
    c.shift_id, c.staff_id, s.work_date, s.start_time, s.end_time, p.project_name, cl.client_name, us.name AS staff_name, er.employee_number
  ${EVENT_FROM} ${CLIENT_JOIN}`
const eventSummary = (e: any) => {
  let d: any = null; try { d = e.detail ? JSON.parse(e.detail) : null } catch { }
  if (!d) return ''
  if (e.event === 'submitted' || e.event === 'resubmitted') return `${d.before_at ? d.before_at + ' → ' : ''}${d.requested_at} 理由: ${d.reason || ''}${d.warnings && d.warnings.length ? ' 矛盾: ' + d.warnings.join(' / ') : ''}`
  if (e.event === 'rejected') return `却下理由: ${d.reason || ''}${d.comment ? ' コメント: ' + d.comment : ''}`
  if (e.event === 'approved' || e.event === 'approved_exception') return `${d.before_at ? d.before_at + ' → ' : ''}${d.requested_at}${d.adjusted ? `（申請 ${d.requested_at_original} を修正して承認）` : ''}${d.rebased ? `（申請後に変わった記録 ${d.before_at} をもとに承認）` : ''}${d.with_request ? '（申請と同時に承認）' : ''}${d.report_status === 'late' ? ` 遅刻${d.late_minutes != null ? d.late_minutes + '分' : ''}` : d.before_status === 'late' ? ' 遅刻を解消' : ''}${d.comment ? ' コメント: ' + d.comment : ''}${d.conflicts && d.conflicts.length ? ' 矛盾: ' + d.conflicts.join(' / ') : ''}${d.applied_while_settled ? '（確定済みのシフト）' : ''}${d.applied_while_manual ? '（実績は手入力のまま）' : ''}`
  if (e.event === 'cancelled' && d.auto) return `自動で取り消し（${CANCEL_REASON_LABEL[d.reason] || d.reason}）`
  return ''
}
correctionsAdminApi.get('/corrections/events', async (c) => {
  const u = c.get('user')
  const { where, bind } = eventFilter(u.company_id, k => c.req.query(k))
  const rows = (await c.env.DB.prepare(`${EVENT_SELECT} WHERE ${where} ORDER BY e.event_id DESC LIMIT 300`).bind(...bind).all()).results as any[]
  // 条件に合う全件数（画面で、表示と CSV の上限を超えたかを知らせる #102）
  const total = Number(((await c.env.DB.prepare(`SELECT COUNT(*) AS n ${EVENT_FROM} WHERE ${where}`).bind(...bind).first()) as any)?.n || 0)
  return c.json({ events: rows.map(r => ({ ...r, detail: undefined, summary: eventSummary(r) })), labels: REPORT_LABEL, total, csv_limit: CSV_LIMIT })
})
correctionsAdminApi.get('/corrections/events/export', async (c) => {
  const u = c.get('user')
  const { where, bind } = eventFilter(u.company_id, k => c.req.query(k))
  const { rows, total } = await loadLatestForCsv(c.env.DB, `${EVENT_SELECT} WHERE ${where} ORDER BY e.event_id DESC`, `SELECT COUNT(*) AS n ${EVENT_FROM} WHERE ${where}`, bind)
  const csv = toCsv(['履歴ID', '日時', '操作', '操作した人', 'ロール', '申請ID', '再申請の元の申請ID', '申請の種類', '案件', 'スタッフ', '勤務日', '報告', '内容', '申請の現在の状態',
    'シフトID', '社員番号', 'クライアント', '予定開始', '予定終了'],
    rows.map(r => [r.event_id, r.created_at, EVENT_LABEL[r.event] || r.event, r.actor_name, roleLabel(r.actor_role), r.correction_id, r.resubmitted_from,
      KIND_LABEL[r.kind] || r.kind, r.project_name, r.staff_name, r.work_date, REPORT_LABEL[r.report_type] || r.report_type, eventSummary(r), STATUS_LABEL[r.status] || r.status,
      r.shift_id, r.employee_number, r.client_name, r.start_time, r.end_time]),
    { textCols: ['社員番号'], note: csvLimitNote(total) })
  return csvResponse(`打刻修正の操作履歴_${nowJST().slice(0, 10)}.csv`, csv, csvLimitHeaders(total))
})

correctionsAdminApi.get('/corrections/:id{[0-9]+}', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  // 承認の前に「実績が手入力のシフト」と分かるように、シフトの実績の入力元を添える（管理者のみ）
  const s = await c.env.DB.prepare('SELECT actual_source FROM shifts WHERE shift_id = ? AND company_id = ?').bind(row.shift_id, row.company_id).first() as any
  return c.json({ ...await correctionDetail(c.env.DB, row, 'admin'), shift_actual_source: s?.actual_source ?? null })
})

// 管理者として申請するシフトの候補（#393）。勤務日の範囲（31日まで）・スタッフ・氏名／案件名／社員番号で絞る。
// 欠勤・希望（仮）のシフトには申請できないので返さない
const CANDIDATE_LIMIT = 200
correctionsAdminApi.get('/corrections/shift-candidates', async (c) => {
  const u = c.get('user'), q = (k: string) => c.req.query(k)
  const from = isDate(q('from')) ? q('from')! : nowJST().slice(0, 10)
  const to = isDate(q('to')) ? q('to')! : from
  if (to < from) return c.json({ error: '期間の終わりは始まり以降の日付にしてください' }, 400)
  if (addDays(from, 30) < to) return c.json({ error: '期間は31日以内で指定してください' }, 400)
  const w = ['s.company_id = ?', 's.work_date BETWEEN ? AND ?', `s.status IN ${WORKING_IN}`]; const bind: any[] = [u.company_id, from, to]
  const staffId = Number(q('staff_id'))
  if (Number.isInteger(staffId) && staffId > 0) { w.push('s.staff_id = ?'); bind.push(staffId) }
  const kw = String(q('q') || '').trim().slice(0, 50)
  if (kw) {
    const like = '%' + kw.replace(/[\\%_]/g, m => '\\' + m) + '%'
    w.push("(us.name LIKE ? ESCAPE '\\' OR p.project_name LIKE ? ESCAPE '\\' OR er.employee_number = ?)"); bind.push(like, like, kw)
  }
  const rows = (await c.env.DB.prepare(`SELECT s.shift_id, s.staff_id, s.work_date, s.start_time, s.end_time, s.status, s.settle_status, p.project_name, us.name AS staff_name, er.employee_number,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS report_count,
      (SELECT COUNT(*) FROM attendance_corrections x WHERE x.shift_id = s.shift_id AND x.status = 'pending') AS pending_count
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = s.staff_id AND er.company_id = s.company_id
    WHERE ${w.join(' AND ')} ORDER BY s.work_date DESC, s.start_time, us.name, s.shift_id LIMIT ${CANDIDATE_LIMIT + 1}`).bind(...bind).all()).results as any[]
  return c.json({ from, to, shifts: rows.slice(0, CANDIDATE_LIMIT), truncated: rows.length > CANDIDATE_LIMIT, limit: CANDIDATE_LIMIT })
})

// 管理者による申請（自社のシフト）。dry_run で確認のみ
correctionsAdminApi.get('/corrections/shift/:shiftId', async (c) => {
  const s = await loadShift(c.env.DB, c.req.param('shiftId'))
  if (!s || s.company_id !== c.get('user').company_id) return c.json({ error: 'シフトが見つかりません' }, 404)
  return c.json(await shiftContext(c.env.DB, s))
})
correctionsAdminApi.post('/corrections', async (c) => {
  const u = c.get('user'); const b = await c.req.json().catch(() => ({} as any))
  const s = await loadShift(c.env.DB, b.shift_id)
  if (!s || s.company_id !== u.company_id) return c.json({ error: 'シフトが見つかりません' }, 404)
  const p = await prepareRequest(c.env.DB, s, b)
  if ('error' in p) return c.json(p, p.status)
  if (b.dry_run) return c.json({ ok: true, dry_run: true, ...p })
  // 申請と同時に承認する（#174）。順序の矛盾がある打刻漏れの追加は、例外として承認する確認（exception: true）を必須にする（確認の dry_run で矛盾を見せてから送る）
  const approveNow = b.approve_now === true
  if (approveNow && p.kind === 'add' && p.warnings.length && b.exception !== true)
    return c.json({ error: '報告の順序に矛盾があります。内容を確認し、例外として承認する確認欄にチェックを入れてください', status: 409, conflicts: p.warnings, need_exception: true }, 409)
  const r: any = await insertCorrection(c.env.DB, s, p, actorOf(u), null)
  if (!approveNow || 'error' in r) return sendAndNotify(c, r, r.correction_id, 'submitted')
  // 申請の後に続けて承認する。操作履歴には申請（submitted）と承認（approved）の両方が残る。
  // 承認依頼の通知は出さず、承認の通知（スタッフ本人へ）だけを送る。承認できなかったときは承認待ちのまま残し、ふだんの申請と同じく承認依頼を出す
  const row = await loadCorrection(c.env.DB, r.correction_id)
  const ar: any = row ? await approveCorrection(c.env.DB, row, actorOf(u), { comment: b.comment, exception: b.exception, with_request: true }) : { error: '申請が見つかりません', status: 409 }
  if ('error' in ar) {
    await notifyCorrection(c, r.correction_id, 'submitted')
    return c.json({ ...ar, error: `申請は登録しましたが、承認できませんでした（承認待ちとして残っています）: ${ar.error}`, correction_id: r.correction_id, submitted: true }, ar.status)
  }
  await notifyCorrection(c, r.correction_id, 'approved')
  return c.json({ ...ar, correction_id: r.correction_id, warnings: r.warnings, notices: r.notices, approved: true })
})

// まとめて承認（#280）: { ids: [申請ID]（1〜BULK_APPROVE_MAX件）, comment }。1件ずつ approveCorrection で承認し、成功・対象外・失敗を返す。
// 順序の矛盾・確定済み・手入力の実績・写真が必須で添付なしの申請は承認せず、個別の承認に回す（skipped）。
// 申請の後に打刻が変わった・今の記録と矛盾するなどで承認できなかったものは failed に理由を入れる。日時の修正・例外の承認は個別の画面で行う
// 件数の上限は、承認ごとに送るメール（外部への送信）と D1 の問い合わせの数を、1回のリクエストの上限に収めるため。画面は上限ごとに分けて送る
export const BULK_APPROVE_MAX = 20
correctionsAdminApi.post('/corrections/bulk-approve', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const b = await c.req.json().catch(() => ({} as any))
  if (Array.isArray(b.ids) && b.ids.length > BULK_APPROVE_MAX * 2) return c.json({ error: `まとめて承認できるのは${BULK_APPROVE_MAX}件までです` }, 400)
  // まとめて出した申請は ID の小さい順に承認すれば途中で矛盾しない（insertCorrections）ので、選んだ順ではなく ID の順に処理する
  const ids = Array.isArray(b.ids) ? ([...new Set(b.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]).sort((x, y) => x - y) : []
  if (!ids.length) return c.json({ error: '承認する申請を選択してください' }, 400)
  if (ids.length > BULK_APPROVE_MAX) return c.json({ error: `まとめて承認できるのは${BULK_APPROVE_MAX}件までです` }, 400)
  const co = await db.prepare('SELECT settings_json FROM companies WHERE company_id = ?').bind(u.company_id).first() as any
  const approved: number[] = [], skipped: { correction_id: number; reason: string }[] = [], failed: { correction_id: number; reason: string }[] = []
  for (const id of ids) {
    const row = await loadCorrection(db, id)
    if (!row || row.company_id !== u.company_id) { failed.push({ correction_id: id, reason: '申請が見つかりません' }); continue }
    if (row.status !== 'pending') { failed.push({ correction_id: id, reason: DONE_MESSAGE[row.status] || '承認できない状態です' }); continue }
    const s = await db.prepare(`SELECT s.actual_source, p.photo_required_override FROM shifts s JOIN projects p ON p.project_id = s.project_id WHERE s.shift_id = ?`).bind(row.shift_id).first() as any
    const att = Number(((await db.prepare(`SELECT COUNT(*) AS n FROM attendance_correction_attachments a JOIN attendance_corrections x ON x.correction_id = a.correction_id
      WHERE x.correction_id = ? OR (x.shift_id = ? AND x.requested_by = ? AND x.created_at = ? AND x.batch_key IS ?)`).bind(row.correction_id, row.shift_id, row.requested_by, row.created_at, row.batch_key ?? null).first()) as any)?.n || 0)
    const block = bulkBlockReason({ ...row, order_warnings: parseWarnings(row) }, { settle_status: row.settle_status, actual_source: s?.actual_source }, photoRequiredFor(co?.settings_json, s?.photo_required_override), att)
    if (block) { skipped.push({ correction_id: id, reason: block }); continue }
    const r: any = await approveCorrection(db, row, actorOf(u), { comment: b.comment })
    if ('error' in r) { failed.push({ correction_id: id, reason: r.error }); continue }
    approved.push(id)
    // 承認した管理者の控えは既読・メールなしにする（件数分のメールを自分に送らない。外部への送信を1回のリクエストの上限に収める）
    await notifyCorrection(c, id, 'approved', { quietProcessor: true })
  }
  return c.json({ ok: true, approved, skipped, failed, counts: { approved: approved.length, skipped: skipped.length, failed: failed.length } })
})

// 申請に添付した画像（自社の申請のみ。R2 のキーは画面に出さない。#485）
correctionsAdminApi.get('/corrections/attachments/:aid{[0-9]+}', async (c) => {
  const row = await c.env.DB.prepare('SELECT photo_key FROM attendance_correction_attachments WHERE attachment_id = ? AND company_id = ?')
    .bind(c.req.param('aid'), c.get('user').company_id).first() as any
  return attachmentResponse(c, row?.photo_key)
})
correctionsAdminApi.post('/corrections/:id{[0-9]+}/approve', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const r = await approveCorrection(c.env.DB, row, actorOf(c.get('user')), { comment: b.comment, exception: b.exception, requested_at: b.requested_at, base_at: b.base_at, dry_run: b.dry_run })
  return (r as any).dry_run ? send(c, r) : sendAndNotify(c, r, row.correction_id, 'approved')
})
correctionsAdminApi.post('/corrections/:id{[0-9]+}/reject', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  return sendAndNotify(c, await rejectCorrection(c.env.DB, row, actorOf(c.get('user')), b.reason, b.comment), row.correction_id, 'rejected')
})
correctionsAdminApi.post('/corrections/:id{[0-9]+}/cancel', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  return sendAndNotify(c, await cancelCorrection(c.env.DB, row, actorOf(c.get('user'))), row.correction_id, 'cancelled')
})
correctionsAdminApi.post('/corrections/:id{[0-9]+}/resubmit', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  const r: any = await resubmitCorrection(c.env.DB, row, actorOf(c.get('user')), await c.req.json().catch(() => ({} as any)))
  return sendAndNotify(c, r, r.dry_run ? undefined : r.correction_id, 'resubmitted')
})

// =========================================================
// 打刻データの一覧と CSV（#175）: 勤務日の期間（31日まで）・案件・クライアント・スタッフ・記録方法で絞り、1シフト1行で8種類の報告の日時と記録方法を出す。
// 報告は D1 の側で1シフト1行にまとめて返す（Worker で大量の行を組み立てない）。シフトID を IN 句に積まず、期間と company_id で JOIN する。
// 欠勤のシフトも出す（希望（仮）のシフトは勤務ではないので出さない）。位置は有無だけを出し、座標は出さない
// =========================================================
const PUNCH_METHOD_LABEL: Record<string, string> = { app: 'アプリ', link: '報告用URL', proxy: '代理入力', correction: '打刻修正で追加' }
// 報告ごとの印（f）: 1 = 打刻修正で変更・追加、2 = 写真あり、4 = 位置あり、8 = 写真なしの理由あり、
// 16 = 押した時刻（端末時刻）で記録（#427。電波がない場所で押して後から送った報告。打刻修正で直したものは付けない）
const PUNCH_COLS = REPORT_TYPES.map(t => `
    MAX(CASE WHEN a.report_type = '${t}' THEN a.reported_at END) AS ${t}_at,
    MAX(CASE WHEN a.report_type = '${t}' THEN COALESCE(a.entry_method, 'app') END) AS ${t}_m,
    MAX(CASE WHEN a.report_type = '${t}' THEN (CASE WHEN a.corrected_by_correction_id IS NOT NULL OR a.entry_method = 'correction' THEN 1 ELSE 0 END)
      + (CASE WHEN a.photo_key IS NOT NULL THEN 2 ELSE 0 END) + (CASE WHEN a.latitude IS NOT NULL THEN 4 ELSE 0 END) + (CASE WHEN a.no_photo_reason IS NOT NULL THEN 8 ELSE 0 END)
      + (CASE WHEN a.time_source = 'device' AND a.corrected_by_correction_id IS NULL THEN 16 ELSE 0 END) END) AS ${t}_f`).join(',')
const PUNCH_FROM = `FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN employee_records er ON er.staff_id = s.staff_id AND er.company_id = s.company_id ${CLIENT_JOIN}`
const PUNCH_SELECT = `SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.staff_id, p.project_name, cl.client_name, us.name AS staff_name, er.employee_number,
    ${PUNCH_COLS},
    MAX(CASE WHEN a.report_type IN ('check_in', 'work_start') AND a.status = 'late' THEN a.late_minutes END) AS late_minutes,
    MAX(CASE WHEN a.report_type IN ('work_end', 'check_out') THEN a.early_leave_minutes END) AS early_leave_minutes,
    (SELECT COUNT(*) FROM attendance_corrections x WHERE x.shift_id = s.shift_id AND x.status = 'pending') AS pending_corrections
  ${PUNCH_FROM} LEFT JOIN attendance_reports a ON a.shift_id = s.shift_id`
function punchFilter(companyId: number, q: (k: string) => string | undefined): { where: string; bind: any[]; from: string; to: string } | { error: string } {
  const today = nowJST().slice(0, 10)
  const to = isDate(q('to')) ? q('to')! : today
  const from = isDate(q('from')) ? q('from')! : addDays(to, -6)
  if (to < from) return { error: '期間の終わりは始まり以降の日付にしてください' }
  if (addDays(from, 30) < to) return { error: '期間は31日以内で指定してください' }
  const w = ['s.company_id = ?', 's.work_date BETWEEN ? AND ?', `(s.status IN ${WORKING_IN} OR s.status = 'absent')`]; const bind: any[] = [companyId, from, to]
  if (Number(q('project_id')) > 0) { w.push('s.project_id = ?'); bind.push(Number(q('project_id'))) }
  if (Number(q('client_id')) > 0) { w.push('p.client_id = ?'); bind.push(Number(q('client_id'))) }
  if (Number(q('staff_id')) > 0) { w.push('s.staff_id = ?'); bind.push(Number(q('staff_id'))) }
  staffNameFilter(q('staff_name'), w, bind)
  // 記録方法: 代理入力・報告用URL・打刻修正（変更・追加）を含むシフトだけ
  const m = q('method')
  if (m === 'proxy' || m === 'link') { w.push(`EXISTS (SELECT 1 FROM attendance_reports y WHERE y.shift_id = s.shift_id AND y.entry_method = ?)`); bind.push(m) }
  if (m === 'corrected') w.push(`EXISTS (SELECT 1 FROM attendance_reports y WHERE y.shift_id = s.shift_id AND (y.corrected_by_correction_id IS NOT NULL OR y.entry_method = 'correction'))`)
  return { where: w.join(' AND '), bind, from, to }
}
// 報告1件の記録方法の文言（アプリ・写真・位置・打刻修正で変更 など）
function punchMethodText(r: any, t: string): string {
  if (!r[`${t}_at`]) return ''
  const m = r[`${t}_m`], f = Number(r[`${t}_f`] || 0)
  return [PUNCH_METHOD_LABEL[m] || m, f & 2 ? '写真' : f & 8 ? '写真なし' : '', f & 4 ? '位置' : '', f & 16 ? '端末時刻で記録' : '', f & 1 && m !== 'correction' ? '打刻修正で変更' : ''].filter(Boolean).join('・')
}
const PUNCH_LIST_LIMIT = 500
correctionsAdminApi.get('/attendance-punches', async (c) => {
  const u = c.get('user')
  const f = punchFilter(u.company_id, k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const rows = (await c.env.DB.prepare(`${PUNCH_SELECT} WHERE ${f.where} GROUP BY s.shift_id ORDER BY s.work_date, s.start_time, us.name, s.shift_id LIMIT ${PUNCH_LIST_LIMIT + 1}`)
    .bind(...f.bind).all()).results as any[]
  const list = rows.slice(0, PUNCH_LIST_LIMIT)
  // 記録方法の件数（表示している行のうち。代理入力・報告用URL・打刻修正がどれくらいあるか）
  const counts = { shifts: list.length, proxy: 0, link: 0, corrected: 0, no_photo: 0, device_time: 0 }
  for (const r of list) for (const t of REPORT_TYPES) {
    if (!r[`${t}_at`]) continue
    if (r[`${t}_m`] === 'proxy') counts.proxy++
    if (r[`${t}_m`] === 'link') counts.link++
    if (Number(r[`${t}_f`]) & 1) counts.corrected++
    if (Number(r[`${t}_f`]) & 8) counts.no_photo++
    if (Number(r[`${t}_f`]) & 16) counts.device_time++
  }
  return c.json({ from: f.from, to: f.to, report_types: REPORT_TYPES, labels: REPORT_LABEL, rows: list, counts, truncated: rows.length > PUNCH_LIST_LIMIT, limit: PUNCH_LIST_LIMIT })
})
correctionsAdminApi.get('/attendance-punches/export', async (c) => {
  const u = c.get('user')
  const f = punchFilter(u.company_id, k => c.req.query(k))
  if ('error' in f) return c.json({ error: f.error }, 400)
  const { rows, total } = await loadLatestForCsv(c.env.DB, `${PUNCH_SELECT} WHERE ${f.where} GROUP BY s.shift_id ORDER BY s.work_date DESC, s.start_time DESC, us.name DESC, s.shift_id DESC`,
    `SELECT COUNT(*) AS n ${PUNCH_FROM} WHERE ${f.where}`, f.bind)
  const STATUS: Record<string, string> = { confirmed: '確定', substitute: '代打', absent: '欠勤' }
  const csv = toCsv(['シフトID', '勤務日', '社員番号', 'スタッフ', 'クライアント', '案件', '予定開始', '予定終了', 'シフトの状態',
    ...REPORT_TYPES.flatMap(t => [REPORT_LABEL[t], `${REPORT_LABEL[t]}の記録方法`]), '遅刻（分）', '早退（分）', '承認待ちの打刻修正'],
    rows.map(r => [r.shift_id, r.work_date, r.employee_number, r.staff_name, r.client_name, r.project_name, r.start_time, r.end_time, STATUS[r.status] || r.status,
      ...REPORT_TYPES.flatMap(t => [r[`${t}_at`] ? String(r[`${t}_at`]).slice(0, 16) : '', punchMethodText(r, t)]),
      r.late_minutes || '', r.early_leave_minutes || '', r.pending_corrections || '']),
    { textCols: ['社員番号'], note: csvLimitNote(total) })
  return csvResponse(`打刻データ_${f.from}_${f.to}.csv`, csv, csvLimitHeaders(total))
})

// =========================================================
// スタッフ本人 API（/api/staff/*。自分のシフト・自分の申請のみ。同一人物の他社のシフトを含む）
// =========================================================
export const correctionsStaffApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

async function myStaffIds(c: any): Promise<number[]> {
  return (await personStaffRows(c.env.DB, c.get('user'))).map(r => r.staff_id)
}
// 同じ人のすべてのユーザー（所属企業を切り替えても、自分の出した申請を本人の申請として扱う。#96）
async function myUserIds(c: any): Promise<number[]> {
  const u = c.get('user')
  const ids = (await personStaffRows(c.env.DB, u)).map(r => r.user_id)
  return ids.includes(u.user_id) ? ids : [u.user_id, ...ids]
}
async function myShift(c: any, shiftId: any) {
  const ids = await myStaffIds(c)
  const s = await loadShift(c.env.DB, shiftId)
  return s && ids.includes(s.staff_id) ? s : null
}
async function myCorrection(c: any) {
  const ids = await myStaffIds(c)
  const row = await loadCorrection(c.env.DB, c.req.param('id'))
  return row && ids.includes(row.staff_id) ? row : null
}

// 日付ごとのタイムライン（既定: 直近 14 日。最大 62 日）
correctionsStaffApi.get('/attendance/timeline', async (c) => {
  const ids = await myStaffIds(c)
  if (!ids.length) return c.json({ days: [] })
  const today = nowJST().slice(0, 10)
  const to = isDate(c.req.query('to')) ? c.req.query('to')! : today
  let from = isDate(c.req.query('from')) ? c.req.query('from')! : addDays(to, -13)
  if (from > to) from = to
  if (addDays(from, 61) < to) from = addDays(to, -61)
  const shifts = (await c.env.DB.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.settle_status, s.break_minutes, p.project_name, p.photo_required_override, co.company_name, co.settings_json, s.company_id
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN companies co ON co.company_id = s.company_id
    WHERE s.staff_id IN (${ids.map(() => '?').join(',')}) AND s.work_date BETWEEN ? AND ? ORDER BY s.work_date DESC, s.start_time`).bind(...ids, from, to).all()).results as any[]
  const shiftIds = shifts.map(s => s.shift_id)
  const enabled = await attendanceTypesForShifts(c.env.DB, shiftIds)
  const reports = new Map<number, any[]>(), pending = new Map<number, any[]>(), rejected = new Map<number, any[]>()
  const self = await myUserIds(c)
  for (let i = 0; i < shiftIds.length; i += 90) {
    const chunk = shiftIds.slice(i, i + 90), q = chunk.map(() => '?').join(',')
    for (const r of (await c.env.DB.prepare(`SELECT shift_id, report_type, reported_at, entry_method, corrected_by_correction_id, original_reported_at, time_source, received_at FROM attendance_reports WHERE shift_id IN (${q})`).bind(...chunk).all()).results as any[]) {
      if (!reports.has(r.shift_id)) reports.set(r.shift_id, []); reports.get(r.shift_id)!.push(r)
    }
    // 承認待ちは今の担当者の申請だけ（差し替え前の担当者の申請は出さない。#101）
    for (const r of (await c.env.DB.prepare(`SELECT x.correction_id, x.shift_id, x.report_type, x.kind, x.requested_at FROM attendance_corrections x JOIN shifts s ON s.shift_id = x.shift_id AND s.staff_id = x.staff_id
        WHERE x.shift_id IN (${q}) AND x.status = 'pending'`).bind(...chunk).all()).results as any[]) {
      if (!pending.has(r.shift_id)) pending.set(r.shift_id, []); pending.get(r.shift_id)!.push(r)
    }
    // 報告ごとの最新の申請が、本人が出して却下されたもの（理由と再申請の入口を行に出す。管理者が出した申請の却下は、本人の再申請につながらないので出さない。#399）
    for (const r of (await c.env.DB.prepare(`SELECT x.correction_id, x.shift_id, x.report_type, x.reject_reason, x.requested_at, x.requested_by FROM attendance_corrections x JOIN shifts s ON s.shift_id = x.shift_id AND s.staff_id = x.staff_id
        WHERE x.shift_id IN (${q}) AND x.status = 'rejected'
          AND NOT EXISTS (SELECT 1 FROM attendance_corrections y WHERE y.shift_id = x.shift_id AND y.report_type = x.report_type AND y.correction_id > x.correction_id)`).bind(...chunk).all()).results as any[]) {
      if (!self.includes(r.requested_by)) continue
      const { requested_by, ...x } = r
      if (!rejected.has(r.shift_id)) rejected.set(r.shift_id, []); rejected.get(r.shift_id)!.push(x)
    }
  }
  const own = (await personStaffRows(c.env.DB, c.get('user'))).map(r => r.company_id)
  // 希望（仮）のシフトは勤務ではないので出さない。報告してしまったものだけ『未確定』として出す（申請はできない。#559）
  const shown = shifts.filter(s => !isTentativeShift(s.status) || (reports.get(s.shift_id) || []).length > 0)
  return c.json({
    from, to, report_types: REPORT_TYPES, labels: REPORT_LABEL,
    shifts: shown.map(s => ({
      shift_id: s.shift_id, work_date: s.work_date, start_time: s.start_time, end_time: s.end_time, status: s.status, project_name: s.project_name,
      company_name: own.length > 1 ? s.company_name : null, tentative: isTentativeShift(s.status),
      enabled: enabled.get(s.shift_id)?.types ?? [...REPORT_TYPES], reports: reports.get(s.shift_id) || [], pending: pending.get(s.shift_id) || [],
      // 申請画面の注意（精算が確定済み・会社の受付期限 #215）と、既定の時刻の推定（予定の休憩 #342）に使う
      settled: s.settle_status === 'confirmed', request_until: (d => d ? addDays(s.work_date, d) : null)(correctionDeadlineDays(s.settings_json)),
      break_minutes: s.break_minutes ?? null, rejected: rejected.get(s.shift_id) || [],
      // 入店・退店の写真が必須の案件か（打刻漏れの追加の申請で、写真の添付を案内する。#485）
      photo_required: photoRequiredFor(s.settings_json, s.photo_required_override),
    })),
    settled_notice: SETTLED_NOTICE,
  })
})

correctionsStaffApi.get('/corrections', async (c) => {
  const ids = await myStaffIds(c)
  if (!ids.length) return c.json({ corrections: [] })
  const rows = (await c.env.DB.prepare(`SELECT c.correction_id, c.kind, c.report_type, c.status, c.before_at, c.requested_at, c.reason, c.order_warnings, c.created_at,
      c.decided_by_name, c.decided_at, c.decision_comment, c.reject_reason, c.cancelled_at, c.cancel_reason, c.resubmitted_from, c.requested_by, c.requested_by_name, c.requested_by_role,
      c.applied_while_settled, c.shift_id, s.work_date, s.start_time, s.end_time, CASE WHEN s.settle_status = 'confirmed' THEN 1 ELSE 0 END AS settled, p.project_name,
      (SELECT COUNT(*) FROM attendance_corrections x WHERE x.resubmitted_from = c.correction_id) AS resubmitted_count,
      (SELECT COUNT(*) FROM attendance_correction_attachments a WHERE a.correction_id = c.correction_id) AS attachment_count,
      (SELECT MAX(x.correction_id) FROM attendance_corrections x WHERE x.shift_id = c.shift_id AND x.staff_id = c.staff_id AND x.report_type = c.report_type AND x.correction_id > c.correction_id) AS superseded_by
    FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE c.staff_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.correction_id DESC LIMIT 200`).bind(...ids).all()).results as any[]
  const self = await myUserIds(c)
  // 管理者が代わりに出した申請は by_admin で区別する（申請者の氏名を出す。ロールは返さない。#486）
  return c.json({ corrections: rows.map(({ requested_by_role, ...r }) => ({ ...r, order_warnings: parseWarnings(r), mine: self.includes(r.requested_by), by_admin: !self.includes(r.requested_by) && requested_by_role !== 'staff',
    cancel_reason_label: r.cancel_reason ? CANCEL_REASON_LABEL[r.cancel_reason] || null : null })), labels: REPORT_LABEL })
})
correctionsStaffApi.get('/corrections/:id{[0-9]+}', async (c) => {
  const row = await myCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  return c.json(await correctionDetail(c.env.DB, row, 'staff'))
})
correctionsStaffApi.post('/corrections', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const s = await myShift(c, b.shift_id)
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const p = await prepareRequest(c.env.DB, s, b, { staff: true })
  if ('error' in p) return c.json(p, p.status)
  if (b.dry_run) return c.json({ ok: true, dry_run: true, ...p })
  const self = await myUserIds(c)
  const limited = await overHourlyLimit(c.env.DB, await myStaffIds(c), self, 1)
  if (limited) return c.json(limited, limited.status)
  // 同じ報告の却下された申請があれば、その再申請としてつなぐ（#399）
  const from = await unresolvedRejection(c.env.DB, s.shift_id, s.staff_id, p.report_type, self)
  const r = await insertCorrection(c.env.DB, s, p, actorOf(c.get('user')), from)
  return sendAndNotify(c, r, (r as any).correction_id, from ? 'resubmitted' : 'submitted')
})
// まとめて申請（#214）: { shift_id, reason, items: [{ report_type, requested_at }], dry_run }。申請の種類（時刻修正・打刻漏れの追加）は今の記録から決める
correctionsStaffApi.post('/corrections/bulk', async (c) => {
  const b = await c.req.json().catch(() => ({} as any))
  const s = await myShift(c, b.shift_id)
  if (!s) return c.json({ error: 'シフトが見つかりません' }, 404)
  const preps = await prepareBulk(c.env.DB, s, b, { staff: true })
  if ('error' in preps) return c.json(preps, preps.status)
  const warnings = preps.flatMap(p => p.warnings), notices = [...new Set(preps.flatMap(p => p.notices))]
  if (b.dry_run) return c.json({ ok: true, dry_run: true, items: preps, warnings, notices })
  const self = await myUserIds(c)
  const limited = await overHourlyLimit(c.env.DB, await myStaffIds(c), self, preps.length)
  if (limited) return c.json(limited, limited.status)
  const items: NewRequest[] = []
  for (const p of preps) items.push({ p, from: await unresolvedRejection(c.env.DB, s.shift_id, s.staff_id, p.report_type, self) })
  const r = await insertCorrections(c.env.DB, s, items, actorOf(c.get('user')))
  if ('error' in r) return c.json(r, r.status)
  for (const x of r.corrections) await notifyCorrection(c, x.correction_id, x.resubmitted ? 'resubmitted' : 'submitted')
  return c.json({ ok: true, corrections: r.corrections, warnings, notices })
})
correctionsStaffApi.post('/corrections/:id{[0-9]+}/cancel', async (c) => {
  const row = await myCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  return sendAndNotify(c, await cancelCorrection(c.env.DB, row, actorOf(c.get('user')), await myUserIds(c)), row.correction_id, 'cancelled')
})
correctionsStaffApi.post('/corrections/:id{[0-9]+}/resubmit', async (c) => {
  const row = await myCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  const self = await myUserIds(c), staffIds = await myStaffIds(c)
  if (!b.dry_run) {
    const limited = await overHourlyLimit(c.env.DB, staffIds, self, 1)
    if (limited) return c.json(limited, limited.status)
  }
  const r: any = await resubmitCorrection(c.env.DB, row, actorOf(c.get('user')), b, self, staffIds)
  return sendAndNotify(c, r, r.dry_run ? undefined : r.correction_id, 'resubmitted')
})

// 申請に写真・画像（店舗の入退館記録・画面の写しなど）を添付する（#485）。multipart/form-data: photo（画面で圧縮した JPEG/PNG）、photo_taken_at、photo_source。
// 申請者本人が、承認待ちの申請に1枚ずつ送る（1申請に ATTACHMENT_MAX 枚まで）。画像は入店・退店の写真と同じ R2（PHOTOS）に置く
correctionsStaffApi.post('/corrections/:id{[0-9]+}/attachments', async (c) => {
  const row = await myCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  if (!(await myUserIds(c)).includes(row.requested_by)) return c.json({ error: '添付できるのは申請者本人のみです' }, 403)
  if (row.status !== 'pending') return c.json({ error: '承認待ちの申請にだけ添付できます' }, 409)
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: '送信データの形式が不正です' }, 400) }
  const photo = form.get('photo')
  if (!(photo instanceof File) || photo.size === 0) return c.json({ error: '画像が添付されていません' }, 400)
  if (!ATTACHMENT_TYPES.includes(photo.type)) return c.json({ error: '対応していない画像形式です（JPEG/PNGのみ）' }, 400)
  if (photo.size > ATTACHMENT_MAX_BYTES) return c.json({ error: '画像サイズが大きすぎます。圧縮に失敗している可能性があります' }, 400)
  const db = c.env.DB
  const n = Number(((await db.prepare('SELECT COUNT(*) AS n FROM attendance_correction_attachments WHERE correction_id = ?').bind(row.correction_id).first()) as any)?.n || 0)
  if (n >= ATTACHMENT_MAX) return c.json({ error: `添付できるのは1つの申請に${ATTACHMENT_MAX}枚までです` }, 409)
  const key = `attendance/${row.company_id}/${row.staff_id}/${row.shift_id}/correction_${row.correction_id}_${Date.now()}.${photo.type === 'image/png' ? 'png' : 'jpg'}`
  try { await c.env.PHOTOS.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } }) } catch {
    return c.json({ error: '画像のアップロードに失敗しました。通信環境を確認して再度お試しください' }, 502)
  }
  const u = c.get('user')
  // 同時に送られた分で上限を超えた・その間に承認や取り消しがあった場合は登録しない（画像を消して 409）
  const ins = await db.prepare(`INSERT INTO attendance_correction_attachments (correction_id, company_id, staff_id, shift_id, photo_key, content_type, size_bytes, photo_taken_at, photo_source, uploaded_by, uploaded_by_name, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM attendance_correction_attachments WHERE correction_id = ?) < ?
      AND EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id = ? AND status = 'pending')`)
    .bind(row.correction_id, row.company_id, row.staff_id, row.shift_id, key, photo.type, photo.size, photoTakenAt(form.get('photo_taken_at')), photoSource(form.get('photo_source')),
      u.user_id, u.name, nowJST(), row.correction_id, ATTACHMENT_MAX, row.correction_id).run().catch(() => null)
  if (!ins || !ins.meta.changes) {
    await c.env.PHOTOS.delete(key).catch(() => {})
    return c.json({ error: '添付できませんでした（上限に達したか、申請の状態が変わりました）' }, 409)
  }
  return c.json({ ok: true, attachment_id: ins.meta.last_row_id })
})
// 自分の申請に添付した画像
correctionsStaffApi.get('/corrections/attachments/:aid{[0-9]+}', async (c) => {
  const ids = await myStaffIds(c)
  if (!ids.length) return c.json({ error: '画像が見つかりません' }, 404)
  const row = await c.env.DB.prepare(`SELECT photo_key FROM attendance_correction_attachments WHERE attachment_id = ? AND staff_id IN (${ids.map(() => '?').join(',')})`)
    .bind(c.req.param('aid'), ...ids).first() as any
  return attachmentResponse(c, row?.photo_key)
})
