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
import { REPORT_TYPES, REPORT_LABEL, isReportType, attendanceTypesForShifts } from './report-settings'
import { syncActualFromReports } from './settlement'
import { personStaffRows } from './roster'
import { notifyCorrection, type NotifyEnv, type CorrectionEvent } from './notifications'
import { toCsv, csvResponse } from './csv'
import { isTentativeShift, isWorkingShift, WORKING_SHIFT_STATUSES } from './lib/shift-status'
import { crossesMidnight, toMin, NEXT_DAY_TYPES } from './lib/shift-time'

type Bindings = NotifyEnv
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
      p.project_name, us.name AS staff_name, co.company_name
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN staff_profiles sp ON sp.staff_id = s.staff_id
    JOIN users us ON us.user_id = sp.user_id JOIN companies co ON co.company_id = s.company_id WHERE s.shift_id = ?`).bind(shiftId).first() as Promise<any>
}
async function loadReports(db: D1Database, shiftId: number) {
  return (await db.prepare('SELECT attendance_id, report_type, reported_at, entry_method FROM attendance_reports WHERE shift_id = ?').bind(shiftId).all()).results as any[]
}
const reportMap = (rows: any[]) => new Map(rows.map(r => [r.report_type as string, r.reported_at as string]))
async function loadCorrection(db: D1Database, id: any) {
  return db.prepare(`SELECT c.*, s.work_date, s.start_time, s.end_time, s.settle_status, p.project_name, p.status AS project_status, us.name AS staff_name
    FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id WHERE c.correction_id = ?`).bind(id).first() as Promise<any>
}
const parseWarnings = (c: any) => { try { return c.order_warnings ? JSON.parse(c.order_warnings) : [] } catch { return [] } }

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
type Prepared = { kind: 'modify' | 'add'; report_type: string; requested_at: string; reason: string; attendance_id: number | null; before_at: string | null; warnings: string[] }
type Fail = { error: string; status: 400 | 404 | 409; conflicts?: string[] }
async function prepareRequest(db: D1Database, shift: any, b: any): Promise<Prepared | Fail> {
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
  const reports = await loadReports(db, shift.shift_id)
  const existing = reports.find(r => r.report_type === b.report_type)
  const map = reportMap(reports.filter(r => r.report_type !== b.report_type))
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
      return { error: `報告の順序に矛盾があるため申請できません: ${all.join(' / ')}`, status: 400, conflicts: all }
    }
    prep = { kind: 'modify', report_type: b.report_type, requested_at: at, reason, attendance_id: existing.attendance_id, before_at: existing.reported_at, warnings: [] }
  } else {
    if (existing) return { error: 'この報告はすでに登録されています。時刻の修正を申請してください', status: 409 }
    // 打刻漏れの追加は矛盾があっても申請できる（警告として保存し、承認者が例外として承認できる）
    prep = { kind: 'add', report_type: b.report_type, requested_at: at, reason, attendance_id: null, before_at: null, warnings: hint ? [...conflicts, hint] : conflicts }
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

// 申請の登録（申請と操作履歴を 1 トランザクションで）
async function insertCorrection(db: D1Database, shift: any, p: Prepared, a: Actor, resubmittedFrom: number | null) {
  const at = nowJST()
  try {
    await db.batch([
      db.prepare(`INSERT INTO attendance_corrections (company_id, project_id, shift_id, staff_id, attendance_id, kind, report_type, before_at, requested_at, reason, order_warnings,
          status, requested_by, requested_by_name, requested_by_role, resubmitted_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .bind(shift.company_id, shift.project_id, shift.shift_id, shift.staff_id, p.attendance_id, p.kind, p.report_type, p.before_at, p.requested_at, p.reason,
          p.warnings.length ? JSON.stringify(p.warnings) : null, a.user_id, a.name, a.role, resubmittedFrom, at, at),
      db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
        SELECT correction_id, company_id, ?, ?, ?, ?, ?, ? FROM attendance_corrections WHERE shift_id = ? AND report_type = ? AND status = 'pending'`)
        .bind(resubmittedFrom ? 'resubmitted' : 'submitted', a.user_id, a.name, a.role,
          JSON.stringify({ kind: p.kind, before_at: p.before_at, requested_at: p.requested_at, reason: p.reason, warnings: p.warnings, resubmitted_from: resubmittedFrom }), at, shift.shift_id, p.report_type),
    ])
  } catch (e: any) {
    if (/UNIQUE/i.test(String(e?.message || e))) return { error: 'この報告には承認待ちの申請があります', status: 409 as const }
    throw e
  }
  const row = await db.prepare(`SELECT correction_id FROM attendance_corrections WHERE shift_id = ? AND report_type = ? AND status = 'pending'`).bind(shift.shift_id, p.report_type).first() as any
  return { correction_id: row?.correction_id as number, warnings: p.warnings }
}

// ---------- 承認・却下・取り消し ----------
const DONE_MESSAGE: Record<string, string> = { approved: 'この申請はすでに承認されています', rejected: 'この申請はすでに却下されています', cancelled: 'この申請は取り消されています' }

async function approveCorrection(db: D1Database, c: any, a: Actor, opts: { comment?: any; exception?: any }) {
  if (c.status !== 'pending') return { error: DONE_MESSAGE[c.status] || '承認できない状態です', status: 409 }
  const comment = String(opts.comment ?? '').trim().slice(0, REASON_MAX) || null
  const shift = await loadShift(db, c.shift_id)
  if (!shift) return { error: '対象のシフトが見つかりません', status: 409 }
  // 申請の後にシフトの担当者が差し替えられた・欠勤になった・希望（仮）に戻された場合は承認しない（#101 #70 #559）
  if (shift.staff_id !== c.staff_id) return { error: 'シフトの担当者が変わったため承認できません。却下してください', status: 409 }
  if (shift.status === 'absent') return { error: '欠勤のシフトです。承認できないため却下してください', status: 409 }
  if (!isWorkingShift(shift.status)) return { error: '未確定（希望（仮））のシフトです。シフトを確定してから承認するか、却下してください', status: 409 }
  const reports = await loadReports(db, c.shift_id)
  const existing = reports.find(r => r.report_type === c.report_type)
  const conflicts = orderConflicts(reportMap(reports.filter(r => r.report_type !== c.report_type)), c.report_type, c.requested_at)
  let exception = 0
  if (c.kind === 'modify') {
    if (!existing || existing.attendance_id !== c.attendance_id || existing.reported_at !== c.before_at) {
      return { error: '申請の後に打刻が変更されました。内容を確認し、却下して再申請してもらってください', status: 409 }
    }
    if (conflicts.length) return { error: `報告の順序に矛盾があるため承認できません: ${conflicts.join(' / ')}`, status: 409, conflicts }
  } else {
    if (existing) return { error: 'この報告はすでに登録されています（二重登録になるため承認できません）', status: 409 }
    if (conflicts.length) {
      if (opts.exception !== true) return { error: '報告の順序に矛盾があります。内容を確認し、例外として承認してください', status: 409, conflicts, need_exception: true }
      exception = 1
    }
  }
  const at = nowJST(), token = randToken(), settled = shift.settle_status === 'confirmed' ? 1 : 0
  // 実績が手入力のシフトは、報告を直しても実績・金額は変わらない（syncActualFromReports は手入力を上書きしない）。
  // 操作履歴（applied_while_manual）と応答で知らせ、精算の確認事項「手入力後に打刻修正あり」に出す
  const manual = !settled && shift.actual_source === 'manual'
  const applied = `EXISTS (SELECT 1 FROM attendance_corrections WHERE correction_id = ? AND decision_token = ?)`
  // 承認と同時にシフトが差し替え・欠勤にされても反映しない（担当者が申請と同じで、勤務として扱う状態のときだけ承認する）
  const shiftOk = `EXISTS (SELECT 1 FROM shifts WHERE shift_id = ? AND staff_id = ? AND status IN ${WORKING_IN})`
  const guard = c.kind === 'modify'
    ? db.prepare(`UPDATE attendance_corrections SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_token = ?, decision_comment = ?,
          is_exception = 0, applied_while_settled = ?, updated_at = ?
        WHERE correction_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM attendance_reports WHERE attendance_id = ? AND shift_id = ? AND report_type = ? AND reported_at = ?) AND ${shiftOk}`)
      .bind(a.user_id, a.name, at, token, comment, settled, at, c.correction_id, c.attendance_id, c.shift_id, c.report_type, c.before_at, c.shift_id, c.staff_id)
    : db.prepare(`UPDATE attendance_corrections SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, decision_token = ?, decision_comment = ?,
          is_exception = ?, order_warnings = ?, applied_while_settled = ?, updated_at = ?
        WHERE correction_id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM attendance_reports WHERE shift_id = ? AND report_type = ?) AND ${shiftOk}`)
      .bind(a.user_id, a.name, at, token, comment, exception, conflicts.length ? JSON.stringify(conflicts) : c.order_warnings, settled, at, c.correction_id, c.shift_id, c.report_type, c.shift_id, c.staff_id)
  // 承認で変わった報告に修正の印を付ける。元の打刻の方法（entry_method）は変えず、最初の修正の前の日時を残す（#252）
  const apply = c.kind === 'modify'
    ? db.prepare(`UPDATE attendance_reports SET reported_at = ?, original_reported_at = COALESCE(original_reported_at, reported_at), corrected_by_correction_id = ?, corrected_at = ?
        WHERE attendance_id = ? AND ${applied}`).bind(c.requested_at, c.correction_id, at, c.attendance_id, c.correction_id, token)
    : db.prepare(`INSERT INTO attendance_reports (company_id, staff_id, shift_id, report_type, reported_at, status, device_info, entry_method, entered_by, corrected_by_correction_id, corrected_at)
        SELECT ?, ?, ?, ?, ?, 'normal', 'correction', 'correction', ?, ?, ? WHERE ${applied}`)
      .bind(c.company_id, c.staff_id, c.shift_id, c.report_type, c.requested_at, a.user_id, c.correction_id, at, c.correction_id, token)
  const event = exception ? 'approved_exception' : 'approved'
  try {
    await db.batch([
      guard, apply,
      db.prepare(`UPDATE attendance_corrections SET applied_attendance_id = (SELECT attendance_id FROM attendance_reports WHERE shift_id = ? AND report_type = ?) WHERE correction_id = ? AND decision_token = ?`)
        .bind(c.shift_id, c.report_type, c.correction_id, token),
      db.prepare(`INSERT INTO attendance_correction_events (correction_id, company_id, event, actor_user_id, actor_name, actor_role, detail, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${applied}`)
        .bind(c.correction_id, c.company_id, event, a.user_id, a.name, a.role,
          JSON.stringify({ comment, before_at: c.before_at, requested_at: c.requested_at, exception: !!exception, conflicts, applied_while_settled: !!settled, ...(manual ? { applied_while_manual: true } : {}) }), at, c.correction_id, token),
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
  return { ok: true, exception: !!exception, applied_while_settled: !!settled, applied_while_manual: manual }
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
  const shift = await loadShift(db, c.shift_id)
  if (!shift) return { error: '対象のシフトが見つかりません', status: 404 }
  // 申請の後にシフトの担当者が差し替えられた場合は、前の担当者の申請から作り直さない（#101）
  if (shift.staff_id !== c.staff_id || (ownStaffIds && !ownStaffIds.includes(shift.staff_id)))
    return { error: 'シフトの担当者が変わったため再申請できません', status: 409 }
  // 報告の種類とシフトは元の申請と同じ。申請の種類は今の登録状況から決める（却下後に報告が登録・変更されている場合があるため）
  const exists = (await loadReports(db, c.shift_id)).some(r => r.report_type === c.report_type)
  const body = { kind: exists ? 'modify' : 'add', report_type: c.report_type, requested_at: b.requested_at ?? c.requested_at, reason: b.reason ?? c.reason }
  const p = await prepareRequest(db, shift, body)
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
  const reports = viewer === 'staff' && owner?.staff_id !== c.staff_id ? [] : await loadReports(db, c.shift_id)
  const current = c.status === 'pending' ? orderConflicts(reportMap(reports.filter(r => r.report_type !== c.report_type)), c.report_type, c.requested_at) : []
  const out: any = {
    correction: { ...c, decision_token: undefined, order_warnings: parseWarnings(c), status_label: STATUS_LABEL[c.status], kind_label: KIND_LABEL[c.kind], report_label: REPORT_LABEL[c.report_type] },
    events: events.map(e => ({ ...e, detail: (() => { try { return e.detail ? JSON.parse(e.detail) : null } catch { return null } })() })),
    history: related, reports, current_conflicts: current,
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

// 一覧・CSV の絞り込み（状態・案件・スタッフ名・申請期間・対象日・報告種類・申請種類）
function correctionFilter(companyId: number, q: (k: string) => string | undefined) {
  const w = ['c.company_id = ?']; const bind: any[] = [companyId]
  if (CORRECTION_STATUSES.includes(q('status') as any)) { w.push('c.status = ?'); bind.push(q('status')) }
  if (q('project_id')) { w.push('c.project_id = ?'); bind.push(Number(q('project_id'))) }
  if (q('staff_name')) { w.push("us.name LIKE ? ESCAPE '\\'"); bind.push('%' + String(q('staff_name')).replace(/[\\%_]/g, m => '\\' + m) + '%') }
  if (isDate(q('from'))) { w.push('c.created_at >= ?'); bind.push(q('from') + ' 00:00:00') }
  if (isDate(q('to'))) { w.push('c.created_at <= ?'); bind.push(q('to') + ' 23:59:59') }
  if (isDate(q('work_from'))) { w.push('s.work_date >= ?'); bind.push(q('work_from')) }
  if (isDate(q('work_to'))) { w.push('s.work_date <= ?'); bind.push(q('work_to')) }
  if (isReportType(q('report_type'))) { w.push('c.report_type = ?'); bind.push(q('report_type')) }
  if (q('kind') === 'modify' || q('kind') === 'add') { w.push('c.kind = ?'); bind.push(q('kind')) }
  return { where: w.join(' AND '), bind }
}
const CORRECTION_FROM = `FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id`
correctionsAdminApi.get('/corrections', async (c) => {
  const u = c.get('user')
  const { where, bind } = correctionFilter(u.company_id, k => c.req.query(k))
  const rows = (await c.env.DB.prepare(`SELECT c.correction_id, c.kind, c.report_type, c.status, c.before_at, c.requested_at, c.reason, c.order_warnings, c.is_exception,
      c.requested_by_name, c.created_at, c.decided_by_name, c.decided_at, c.resubmitted_from, c.shift_id, s.work_date, p.project_name, p.status AS project_status, us.name AS staff_name
    ${CORRECTION_FROM}
    WHERE ${where} ORDER BY CASE WHEN c.status = 'pending' THEN 0 ELSE 1 END, c.correction_id DESC LIMIT 300`).bind(...bind).all()).results as any[]
  const counts = (await c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM attendance_corrections WHERE company_id = ? GROUP BY status`).bind(u.company_id).all()).results as any[]
  return c.json({ corrections: rows.map(r => ({ ...r, order_warnings: parseWarnings(r) })), counts: Object.fromEntries(counts.map(r => [r.status, r.n])), labels: REPORT_LABEL })
})

// CSV（一覧と同じ絞り込み。管理者のみ: /api/admin/* のため管理ロール以外は 403）
const ROLE_LABEL: Record<string, string> = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', staff: 'スタッフ', system_admin: '本部' }
const CSV_LIMIT = 10000
correctionsAdminApi.get('/corrections/export', async (c) => {
  const u = c.get('user')
  const { where, bind } = correctionFilter(u.company_id, k => c.req.query(k))
  const rows = (await c.env.DB.prepare(`SELECT c.*, s.work_date, p.project_name, p.status AS project_status, us.name AS staff_name ${CORRECTION_FROM}
    WHERE ${where} ORDER BY c.correction_id LIMIT ${CSV_LIMIT}`).bind(...bind).all()).results as any[]
  const csv = toCsv(['申請ID', '状態', '申請の種類', '案件', '案件の状態', 'スタッフ', '勤務日', '報告', '変更前', '変更後', '修正理由', '順序の矛盾', '例外承認',
    '申請者', '申請者のロール', '申請日時', '承認・却下した人', '承認・却下日時', '承認者コメント', '却下理由', '取り消し日時', '再申請の元の申請ID', '反映時に確定済み'],
    rows.map(r => [r.correction_id, STATUS_LABEL[r.status] || r.status, KIND_LABEL[r.kind] || r.kind, r.project_name, (r.project_status || 'active') === 'active' ? '稼働中' : '終了',
      r.staff_name, r.work_date, REPORT_LABEL[r.report_type] || r.report_type, r.before_at, r.requested_at, r.reason, parseWarnings(r).join(' / '), r.is_exception ? 'あり' : '',
      r.requested_by_name, ROLE_LABEL[r.requested_by_role] || r.requested_by_role, r.created_at, r.status === 'cancelled' ? '' : r.decided_by_name, r.status === 'cancelled' ? '' : r.decided_at,
      r.decision_comment, r.reject_reason, r.cancelled_at, r.resubmitted_from, r.applied_while_settled ? 'はい' : '']))
  return csvResponse(`打刻修正申請_${nowJST().slice(0, 10)}.csv`, csv)
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
  if (q('staff_name')) { w.push("us.name LIKE ? ESCAPE '\\'"); bind.push('%' + String(q('staff_name')).replace(/[\\%_]/g, m => '\\' + m) + '%') }
  if (isReportType(q('report_type'))) { w.push('c.report_type = ?'); bind.push(q('report_type')) }
  return { where: w.join(' AND '), bind }
}
const EVENT_SELECT = `SELECT e.event_id, e.correction_id, e.event, e.actor_name, e.actor_role, e.detail, e.created_at, c.kind, c.report_type, c.status, c.resubmitted_from,
    s.work_date, p.project_name, us.name AS staff_name
  FROM attendance_correction_events e JOIN attendance_corrections c ON c.correction_id = e.correction_id
  LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
  LEFT JOIN staff_profiles sp ON sp.staff_id = c.staff_id LEFT JOIN users us ON us.user_id = sp.user_id`
const eventSummary = (e: any) => {
  let d: any = null; try { d = e.detail ? JSON.parse(e.detail) : null } catch { }
  if (!d) return ''
  if (e.event === 'submitted' || e.event === 'resubmitted') return `${d.before_at ? d.before_at + ' → ' : ''}${d.requested_at} 理由: ${d.reason || ''}${d.warnings && d.warnings.length ? ' 矛盾: ' + d.warnings.join(' / ') : ''}`
  if (e.event === 'rejected') return `却下理由: ${d.reason || ''}${d.comment ? ' コメント: ' + d.comment : ''}`
  if (e.event === 'approved' || e.event === 'approved_exception') return `${d.before_at ? d.before_at + ' → ' : ''}${d.requested_at}${d.comment ? ' コメント: ' + d.comment : ''}${d.conflicts && d.conflicts.length ? ' 矛盾: ' + d.conflicts.join(' / ') : ''}${d.applied_while_settled ? '（確定済みのシフト）' : ''}${d.applied_while_manual ? '（実績は手入力のまま）' : ''}`
  if (e.event === 'cancelled' && d.auto) return `自動で取り消し（${CANCEL_REASON_LABEL[d.reason] || d.reason}）`
  return ''
}
correctionsAdminApi.get('/corrections/events', async (c) => {
  const u = c.get('user')
  const { where, bind } = eventFilter(u.company_id, k => c.req.query(k))
  const rows = (await c.env.DB.prepare(`${EVENT_SELECT} WHERE ${where} ORDER BY e.event_id DESC LIMIT 300`).bind(...bind).all()).results as any[]
  return c.json({ events: rows.map(r => ({ ...r, detail: undefined, summary: eventSummary(r) })), labels: REPORT_LABEL })
})
correctionsAdminApi.get('/corrections/events/export', async (c) => {
  const u = c.get('user')
  const { where, bind } = eventFilter(u.company_id, k => c.req.query(k))
  const rows = (await c.env.DB.prepare(`${EVENT_SELECT} WHERE ${where} ORDER BY e.event_id LIMIT ${CSV_LIMIT}`).bind(...bind).all()).results as any[]
  const csv = toCsv(['履歴ID', '日時', '操作', '操作した人', 'ロール', '申請ID', '再申請の元の申請ID', '申請の種類', '案件', 'スタッフ', '勤務日', '報告', '内容', '申請の現在の状態'],
    rows.map(r => [r.event_id, r.created_at, EVENT_LABEL[r.event] || r.event, r.actor_name, ROLE_LABEL[r.actor_role] || r.actor_role, r.correction_id, r.resubmitted_from,
      KIND_LABEL[r.kind] || r.kind, r.project_name, r.staff_name, r.work_date, REPORT_LABEL[r.report_type] || r.report_type, eventSummary(r), STATUS_LABEL[r.status] || r.status]))
  return csvResponse(`打刻修正の操作履歴_${nowJST().slice(0, 10)}.csv`, csv)
})

correctionsAdminApi.get('/corrections/:id{[0-9]+}', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  // 承認の前に「実績が手入力のシフト」と分かるように、シフトの実績の入力元を添える（管理者のみ）
  const s = await c.env.DB.prepare('SELECT actual_source FROM shifts WHERE shift_id = ? AND company_id = ?').bind(row.shift_id, row.company_id).first() as any
  return c.json({ ...await correctionDetail(c.env.DB, row, 'admin'), shift_actual_source: s?.actual_source ?? null })
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
  const r = await insertCorrection(c.env.DB, s, p, actorOf(u), null)
  return sendAndNotify(c, r, (r as any).correction_id, 'submitted')
})
correctionsAdminApi.post('/corrections/:id{[0-9]+}/approve', async (c) => {
  const row = await ownCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  const b = await c.req.json().catch(() => ({} as any))
  return sendAndNotify(c, await approveCorrection(c.env.DB, row, actorOf(c.get('user')), { comment: b.comment, exception: b.exception }), row.correction_id, 'approved')
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
  const shifts = (await c.env.DB.prepare(`SELECT s.shift_id, s.work_date, s.start_time, s.end_time, s.status, s.settle_status, p.project_name, co.company_name, s.company_id
    FROM shifts s JOIN projects p ON p.project_id = s.project_id JOIN companies co ON co.company_id = s.company_id
    WHERE s.staff_id IN (${ids.map(() => '?').join(',')}) AND s.work_date BETWEEN ? AND ? ORDER BY s.work_date DESC, s.start_time`).bind(...ids, from, to).all()).results as any[]
  const shiftIds = shifts.map(s => s.shift_id)
  const enabled = await attendanceTypesForShifts(c.env.DB, shiftIds)
  const reports = new Map<number, any[]>(), pending = new Map<number, any[]>()
  for (let i = 0; i < shiftIds.length; i += 90) {
    const chunk = shiftIds.slice(i, i + 90), q = chunk.map(() => '?').join(',')
    for (const r of (await c.env.DB.prepare(`SELECT shift_id, report_type, reported_at, entry_method, corrected_by_correction_id, original_reported_at FROM attendance_reports WHERE shift_id IN (${q})`).bind(...chunk).all()).results as any[]) {
      if (!reports.has(r.shift_id)) reports.set(r.shift_id, []); reports.get(r.shift_id)!.push(r)
    }
    // 承認待ちは今の担当者の申請だけ（差し替え前の担当者の申請は出さない。#101）
    for (const r of (await c.env.DB.prepare(`SELECT x.correction_id, x.shift_id, x.report_type, x.kind, x.requested_at FROM attendance_corrections x JOIN shifts s ON s.shift_id = x.shift_id AND s.staff_id = x.staff_id
        WHERE x.shift_id IN (${q}) AND x.status = 'pending'`).bind(...chunk).all()).results as any[]) {
      if (!pending.has(r.shift_id)) pending.set(r.shift_id, []); pending.get(r.shift_id)!.push(r)
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
    })),
  })
})

correctionsStaffApi.get('/corrections', async (c) => {
  const ids = await myStaffIds(c)
  if (!ids.length) return c.json({ corrections: [] })
  const rows = (await c.env.DB.prepare(`SELECT c.correction_id, c.kind, c.report_type, c.status, c.before_at, c.requested_at, c.reason, c.order_warnings, c.created_at,
      c.decided_by_name, c.decided_at, c.decision_comment, c.reject_reason, c.cancelled_at, c.cancel_reason, c.resubmitted_from, c.requested_by, c.shift_id, s.work_date, p.project_name,
      (SELECT COUNT(*) FROM attendance_corrections x WHERE x.resubmitted_from = c.correction_id) AS resubmitted_count
    FROM attendance_corrections c LEFT JOIN shifts s ON s.shift_id = c.shift_id LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE c.staff_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.correction_id DESC LIMIT 200`).bind(...ids).all()).results as any[]
  const self = await myUserIds(c)
  return c.json({ corrections: rows.map(r => ({ ...r, order_warnings: parseWarnings(r), mine: self.includes(r.requested_by), cancel_reason_label: r.cancel_reason ? CANCEL_REASON_LABEL[r.cancel_reason] || null : null })), labels: REPORT_LABEL })
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
  const p = await prepareRequest(c.env.DB, s, b)
  if ('error' in p) return c.json(p, p.status)
  if (b.dry_run) return c.json({ ok: true, dry_run: true, ...p })
  const r = await insertCorrection(c.env.DB, s, p, actorOf(c.get('user')), null)
  return sendAndNotify(c, r, (r as any).correction_id, 'submitted')
})
correctionsStaffApi.post('/corrections/:id{[0-9]+}/cancel', async (c) => {
  const row = await myCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  return sendAndNotify(c, await cancelCorrection(c.env.DB, row, actorOf(c.get('user')), await myUserIds(c)), row.correction_id, 'cancelled')
})
correctionsStaffApi.post('/corrections/:id{[0-9]+}/resubmit', async (c) => {
  const row = await myCorrection(c)
  if (!row) return c.json({ error: '申請が見つかりません' }, 404)
  const r: any = await resubmitCorrection(c.env.DB, row, actorOf(c.get('user')), await c.req.json().catch(() => ({} as any)), await myUserIds(c), await myStaffIds(c))
  return sendAndNotify(c, r, r.dry_run ? undefined : r.correction_id, 'resubmitted')
})
