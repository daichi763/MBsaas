// =========================================================
// 交通費・延長の申請と、管理者の実績の入力のアプリ内通知（w5-staff-pay-features: #172 #273 #274）
// user_notifications に1行ずつ入れる。メールは送らない。通知の失敗で元の操作は取り消さない。
// kind: pay_request_submitted（管理者への承認依頼）/ pay_request_approved・pay_request_rejected（本人への結果）/
//       actual_entered（管理者が実績を入力したことの本人への通知）
// =========================================================
const ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']

export function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
export const mdText = (d: string | null | undefined) => { const m = String(d || '').match(/^\d{4}-(\d{2})-(\d{2})/); return m ? `${Number(m[1])}/${Number(m[2])}` : '' }

// シフトの担当スタッフ本人（ログインできるスタッフのユーザー）に知らせる
export async function notifyShiftStaff(db: D1Database, shift: { company_id: number; staff_id: number }, kind: string, title: string, body: string, link: string, relatedId: number | null) {
  try {
    const owner = await db.prepare(`SELECT us.user_id FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
      WHERE sp.staff_id = ? AND us.role = 'staff' AND us.status = 'active'`).bind(shift.staff_id).first() as any
    if (!owner) return
    await db.prepare('INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(shift.company_id, owner.user_id, kind, title, body, link, relatedId, nowJST()).run()
  } catch (e) {
    console.log(`staff pay notify failed: kind=${kind}`)
  }
}

// シフトの所有企業の管理者全員に知らせる
export async function notifyCompanyAdmins(db: D1Database, companyId: number, kind: string, title: string, body: string, link: string, relatedId: number | null) {
  try {
    const admins = (await db.prepare(`SELECT user_id FROM users WHERE company_id = ? AND status = 'active' AND role IN (${ADMIN_ROLES.map(() => '?').join(',')})`)
      .bind(companyId, ...ADMIN_ROLES).all()).results as any[]
    if (!admins.length) return
    const at = nowJST()
    const stmts: D1PreparedStatement[] = []
    // 1 文 100 バインドまで（1 行 8 個 → 10 行ずつ）
    for (let i = 0; i < admins.length; i += 10) {
      const part = admins.slice(i, i + 10)
      stmts.push(db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
        .bind(...part.flatMap(a => [companyId, a.user_id, kind, title, body, link, relatedId, at])))
    }
    await db.batch(stmts)
  } catch (e) {
    console.log(`admin pay notify failed: kind=${kind}`)
  }
}
