// =========================================================
// 日報はシフト（shift_id）単位で1件（migrations/0035_daily_report.sql の ux_daily_reports_shift）。
// アプリ（POST /api/staff/daily-report）と報告用URL（POST /api/public/report/:token/daily-report）で共用する。
// shift_id の無い古い日報だけは、同じスタッフ・稼働日・案件で照合する。
// その照合の `+shift_id IS NULL` の + は、shift_id の一意索引で全社の古い日報を走査させず、稼働日などの索引を使わせるため（api.ts の同じ照合も同じ）。
// =========================================================

export type DailyReportShift = { shift_id: number; staff_id: number; work_date: string; project_id: number }

/** シフトの日報（shift_id の一致を優先し、無ければ shift_id の無い古い日報） */
export async function findDailyReport(db: D1Database, s: DailyReportShift): Promise<any | null> {
  return (await db.prepare(`SELECT * FROM daily_reports
    WHERE shift_id = ? OR (+shift_id IS NULL AND staff_id = ? AND work_date = ? AND project_id = ?)
    ORDER BY shift_id IS NULL, submitted_at DESC, daily_report_id DESC LIMIT 1`)
    .bind(s.shift_id, s.staff_id, s.work_date, s.project_id).first()) ?? null
}

/** 画面に返す形（入力欄の初期値に使う） */
export function dailyReportView(r: any | null) {
  if (!r) return null
  let values: Record<string, unknown> = {}
  try { const v = JSON.parse(r.report_values || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) values = v } catch { values = {} }
  return {
    submitted_at: r.submitted_at, values,
    incident_flag: !!r.incident_flag, complaint_flag: !!r.complaint_flag,
    manager_checked: !!r.manager_checked, manager_comment: r.manager_comment ?? null,
  }
}

/**
 * インシデント・クレームの内容（#232）。report_values の incident_note / complaint_note に保存する
 * （管理画面の日報一覧は incident_ / complaint_ で始まるキーを赤枠に出す）。
 * - 本文の incident_note / complaint_note（無ければ values の同じキー）を使う。送られていなければ前回の内容を保つ
 * - 印が付いたままなら内容を残し、requireNote のとき内容が空なら受け付けない。印を外したら内容も消す
 * - raised: 今回新しく付いた印（管理者へ知らせる）。flags_explicit でない送信は一度付いた印を下げない（saveDailyReport と同じ）
 */
export const INCIDENT_NOTE_MAX = 2000
const INCIDENT_NOTE_KINDS = [
  { kind: 'incident', flag: 'incident_flag', key: 'incident_note', label: 'インシデント' },
  { kind: 'complaint', flag: 'complaint_flag', key: 'complaint_note', label: 'クレーム' },
] as const
export function mergeIncidentNotes(values: Record<string, number | string>, body: any, prev: ReturnType<typeof dailyReportView>, opts: { requireNote: boolean }):
  { values: Record<string, number | string>; raised: ('incident' | 'complaint')[] } | { error: string } {
  const out = { ...values }
  const raised: ('incident' | 'complaint')[] = []
  const explicit = !!body && body.flags_explicit === true
  for (const k of INCIDENT_NOTE_KINDS) {
    const newFlag = !!(body && body[k.flag])
    const prevFlag = !!(prev && prev[k.flag])
    const effective = explicit ? newFlag : (newFlag || prevFlag)
    if (newFlag && !prevFlag) raised.push(k.kind)
    let sent: unknown = body ? body[k.key] : undefined
    if (sent === undefined && body && body.values && typeof body.values === 'object') sent = body.values[k.key]
    if (sent !== undefined && sent !== null && typeof sent === 'object') return { error: `${k.label}の内容の形式が正しくありません` }
    const note = (sent !== undefined && sent !== null ? String(sent) : String((prev && prev.values && prev.values[k.key]) ?? '')).trim()
    if (note.length > INCIDENT_NOTE_MAX) return { error: `${k.label}の内容は${INCIDENT_NOTE_MAX}文字以内で入力してください` }
    delete out[k.key]
    if (!effective) continue
    if (note) out[k.key] = note
    else if (opts.requireNote) return { error: `${k.label}の内容（何が・いつ・どう対応したか）を入力してください` }
  }
  return { values: out, raised }
}

/** 日報を受け付けないシフト（欠勤・稼働日の前） */
export function dailyReportBlocked(shift: { work_date: string; status?: string | null }, today: string): string | null {
  if (shift.status === 'absent') return '欠勤のシフトには日報を提出できません'
  if (today < shift.work_date) return '日報は稼働日以降に提出してください'
  return null
}

/**
 * 日報の登録（同じシフトの日報があれば上書き）。1文の UPSERT なので、二度押しでも行は1つ。
 * - 上書きのときは管理者の確認済みを外し、確認済みだった場合は revised_after_check_at に日時を残す。
 * - インシデント・クレームの印は、画面で前回の値を表示して送った（flagsExplicit）ときだけ下げられる。
 *   そうでなければ一度立てた印を保つ。
 */
export async function saveDailyReport(db: D1Database, r: DailyReportShift & {
  company_id: number; values_json: string; incident: boolean; complaint: boolean; flags_explicit: boolean; entry_method: 'app' | 'link' | 'proxy'; now: string
  // 代理入力（#276）で記録した管理者。本人が出し直したときは NULL に戻す
  entered_by?: number | null
}): Promise<{ updated: boolean }> {
  let existed = !!(await db.prepare('SELECT 1 FROM daily_reports WHERE shift_id = ?').bind(r.shift_id).first())
  if (!existed) {
    // shift_id の無い古い日報（マイグレーションで1つのシフトに決められなかったもの）は、このシフトの日報として引き取って上書きする。
    // 新しい行を足すと、古い行と二重に集計されるため
    const claimed = await db.prepare(`UPDATE daily_reports SET shift_id = ?
      WHERE daily_report_id = (SELECT daily_report_id FROM daily_reports
          WHERE +shift_id IS NULL AND company_id = ? AND staff_id = ? AND work_date = ? AND project_id = ?
          ORDER BY submitted_at DESC, daily_report_id DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM daily_reports WHERE shift_id = ?)`)
      .bind(r.shift_id, r.company_id, r.staff_id, r.work_date, r.project_id, r.shift_id).run()
    existed = (claimed.meta?.changes ?? 0) > 0
  }
  const explicit = r.flags_explicit ? 1 : 0
  await db.prepare(`INSERT INTO daily_reports (company_id, staff_id, project_id, shift_id, work_date, report_values, incident_flag, complaint_flag, submitted_at, entry_method, entered_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shift_id) DO UPDATE SET
      project_id = excluded.project_id, work_date = excluded.work_date, report_values = excluded.report_values,
      incident_flag = CASE WHEN ? = 1 THEN excluded.incident_flag ELSE MAX(COALESCE(daily_reports.incident_flag, 0), excluded.incident_flag) END,
      complaint_flag = CASE WHEN ? = 1 THEN excluded.complaint_flag ELSE MAX(COALESCE(daily_reports.complaint_flag, 0), excluded.complaint_flag) END,
      submitted_at = excluded.submitted_at, entry_method = excluded.entry_method, entered_by = excluded.entered_by,
      revised_after_check_at = CASE WHEN daily_reports.manager_checked = 1 THEN excluded.submitted_at ELSE daily_reports.revised_after_check_at END,
      manager_checked = 0`)
    .bind(r.company_id, r.staff_id, r.project_id, r.shift_id, r.work_date, r.values_json, r.incident ? 1 : 0, r.complaint ? 1 : 0, r.now, r.entry_method,
      r.entered_by ?? null, explicit, explicit).run()
  return { updated: existed }
}
