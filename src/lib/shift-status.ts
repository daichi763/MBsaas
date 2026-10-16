// =========================================================
// シフトの状態（shifts.status）の意味
//   confirmed: 確定 / substitute: 代打 … 勤務として扱う（精算の対象。settlement.ts の WORK_STATUSES と同じ）
//   requested: 希望（仮）… 管理者が仮で入れた枠。未確定のため精算に出ない
//   absent: 欠勤
// スタッフ向けの画面・API（ホーム・勤怠報告・打刻履歴・打刻修正申請）は、ここの関数で判定をそろえる
// =========================================================

export const WORKING_SHIFT_STATUSES = ['confirmed', 'substitute'] as const

// 勤務として扱うシフトか（確定・代打）
export function isWorkingShift(status: any): boolean {
  return (WORKING_SHIFT_STATUSES as readonly string[]).includes(String(status))
}

// 未確定（希望（仮））のシフトか。ホームでは『未確定』と表示し、報告の前に確認を出す
export function isTentativeShift(status: any): boolean {
  return status === 'requested'
}
