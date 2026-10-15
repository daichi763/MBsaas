// =========================================================
// 所属会社の確認（テナント越えの防止）
// 画面やAPIから受け取った ID は、必ず自社（company_id）の行かを確かめてから使う。
// 見つからなければ null を返すので、呼び出し側で 404（または 400）にする。
// =========================================================

const blank = (id: any) => id === undefined || id === null || id === ''

async function ownRow(db: D1Database, table: string, key: string, companyId: number, id: any): Promise<any | null> {
  if (blank(id) || companyId == null) return null
  return (await db.prepare(`SELECT * FROM ${table} WHERE ${key} = ? AND company_id = ?`).bind(id, companyId).first()) ?? null
}

/** 自社の案件 */
export function ownProject(db: D1Database, companyId: number, projectId: any) {
  return ownRow(db, 'projects', 'project_id', companyId, projectId)
}
/** 自社のクライアント（取引先） */
export function ownClient(db: D1Database, companyId: number, clientId: any) {
  return ownRow(db, 'clients', 'client_id', companyId, clientId)
}
/** 自社のスタッフマスタ行（統合済み・スキルシートのみも含む。割当の可否は呼び出し側で確認する） */
export function ownStaff(db: D1Database, companyId: number, staffId: any) {
  return ownRow(db, 'staff_profiles', 'staff_id', companyId, staffId)
}
/** 自社のお知らせ */
export function ownNotice(db: D1Database, companyId: number, noticeId: any) {
  return ownRow(db, 'notices', 'notice_id', companyId, noticeId)
}
/** 自社のシフト */
export function ownShift(db: D1Database, companyId: number, shiftId: any) {
  return ownRow(db, 'shifts', 'shift_id', companyId, shiftId)
}
/** 自社の開催場所 */
export function ownSite(db: D1Database, companyId: number, siteId: any) {
  return ownRow(db, 'sites', 'site_id', companyId, siteId)
}

// ---------- 他社へ返す項目の絞り込み ----------
// 企業間連携の同意では「連絡先（電話・メール）」を共有しない（roster.ts の NOT_SHARED_SCOPE）。
// 他社に所属するユーザーのメールアドレスは、見る側の会社には伏せて返す。
export const HIDDEN_EMAIL_LABEL = 'スタッフ本人（所属元に登録のアドレス）'
export function shareableEmail(email: string | null | undefined, ownerCompanyId: number | null | undefined, viewerCompanyId: number): string | null {
  if (!email) return email ?? null
  return ownerCompanyId === viewerCompanyId ? email : HIDDEN_EMAIL_LABEL
}
