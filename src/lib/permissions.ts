// 権限の表（#9978）。API の確かめ（ミドルウェア・各ハンドラー）と、画面のメニュー・ボタンの出し分けは、すべてこの表を見る。
// - 画面には /api/auth/me の permissions（permissionsFor の結果）で、自分ができる操作の一覧を渡す（public/static/common.js の hasPerm）
// - ロールの役目を変えるとき（11/16 に決める4ロールなど）は、PERMISSIONS の行の roles を足し替えるだけにする。
//   表を変えたら docs/permissions.md と、実測の表（RECORD=1 node scripts/test-w26-perms.mjs → scripts/w26-perms-baseline.json）も直す
// - 表にない操作の名前は、だれにも許さない（書き間違いで通さないように）
// - 画面の見た目（can_edit などの印）も、API と同じ操作の名前で決める

const ADMIN_ROLE_LIST = ['company_admin', 'sales_manager', 'field_manager', 'office_staff'] as const
export type AdminRole = typeof ADMIN_ROLE_LIST[number]
/** 管理画面を使う4ロール（users.role）。通知の宛先（会社の管理者）にも使う。並びは画面の権限の選択欄の順 */
export const ADMIN_ROLES: readonly string[] = ADMIN_ROLE_LIST
/** users.role のすべての値。roster_only はログインのない名簿だけの行（ログインできない）。
 *  最初の DB のコメントにある client_viewer は、使っている行もコードもないので入れない */
export const ALL_ROLES = ['system_admin', ...ADMIN_ROLE_LIST, 'staff', 'roster_only'] as const
export type Role = typeof ALL_ROLES[number]

export const ROLE_LABELS: Record<Role, string> = {
  system_admin: '本部', company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当',
  staff: 'スタッフ', roster_only: 'ログインなし（名簿のみ）',
}

const ALL4: readonly Role[] = ADMIN_ROLE_LIST
const CA: readonly Role[] = ['company_admin']
const HR: readonly Role[] = ['company_admin', 'office_staff']

export type Permission = {
  /** 画面と docs に出す名前 */
  label: string
  /** 許すロール */
  roles: readonly Role[]
  /** 止めている所（docs/permissions.md と同じ。画面だけ・応答の一部だけのものはそう書く） */
  where: string
}

// 行の並びは docs/permissions.md の表と同じ
export const PERMISSIONS = {
  // ---- 入口 ----
  'admin.access': { label: '管理画面（/admin）と /api/admin/* を使う', roles: ALL4, where: 'api.ts の /admin/* のミドルウェア' },
  'staff_app.access': { label: 'スタッフアプリの API（/api/staff/*）を使う', roles: ['staff'], where: 'api.ts の /staff/* のミドルウェア' },
  'hq.access': { label: '本部画面の API（/api/hq/*）を使う', roles: ['system_admin'], where: 'api.ts の /hq/* のミドルウェア' },
  // ---- 4ロールのだれでも（今は絞っていない。11/16 の見直しで行を足し替えやすいように名前を付けておく） ----
  'roster_chat.use': { label: '企業間チャット', roles: ALL4, where: 'roster-chat.ts のミドルウェア・admin-badges.ts' },
  'notification_prefs.edit': { label: '自分の通知の受け取り設定（管理画面）', roles: ALL4, where: 'notifications.ts の PUT /admin/notification-prefs' },
  // ---- 労務（会社管理者・事務担当） ----
  'hr.manage': { label: '労務情報（従業員管理・入社時書類・休暇の申請・自社雇用の最寄駅の変更の承認・ダッシュボードの労務の知らせ）', roles: HR,
    where: 'api.ts の /admin/employees のミドルウェア・ダッシュボード・最寄駅、staff-self-service.ts の休暇・入社時書類、admin-menu.ts の従業員管理' },
  'payout.manage': { label: '振込データ・振込の設定・振込先の口座', roles: HR, where: 'settlement.ts の /settlement/payout/*' },
  'premium_settings.edit': { label: '割増（深夜・時間外・休日）の設定の変更（見るのは4ロール）', roles: HR, where: 'settlement.ts の PUT /settlement/premium-settings' },
  // ---- 勤怠の設定（会社管理者・現場管理者。9004） ----
  'attendance_settings.edit': { label: '勤怠の設定（写真の必須・写真なしの許可・遅刻の猶予・打刻修正の期限・緊急連絡先と位置ずれ・案件ごとの写真の必須）', roles: ['company_admin', 'field_manager'],
    where: 'api.ts の /admin/settings/photo-required・photo-skip・lateness・site-contact・/admin/projects/:id/photo-required、corrections.ts の /admin/settings/corrections' },
  // ---- 会社管理者だけ ----
  'admin_users.manage': { label: '管理者アカウント（追加・ロールの変更・停止・パスワードの再発行）', roles: CA, where: 'accounts.ts の /admin/users のミドルウェア' },
  'security.manage': { label: 'セキュリティの設定・管理者の二段階認証・ログインの履歴（スタッフ詳細のログインの履歴も）', roles: CA,
    where: 'api.ts の /admin/security/settings・/admin/security/users・/admin/login-history のミドルウェア、/admin/staff/:id/sessions の履歴（応答の一部）' },
  'roster_export.pay': { label: '従業員名簿の CSV に口座・給与を含める', roles: CA, where: 'api.ts の従業員名簿の CSV（include_pay）' },
  'closing.reopen': { label: '締めの解除', roles: CA, where: 'settlement.ts の締めの解除' },
  'settings.staff_view': { label: 'スタッフアプリの表示の設定', roles: CA, where: 'api.ts の PUT /admin/settings/staff-view' },
  'settings.shift_notify': { label: 'シフトの通知の既定', roles: CA, where: 'api.ts の PUT /admin/settings/shift-notify' },
  'settings.mail_contact': { label: 'メールの問い合わせ先', roles: CA, where: 'notifications.ts の PUT /admin/settings/mail-contact' },
  'settings.reminders': { label: 'リマインドの設定', roles: CA, where: 'notifications.ts の PUT /admin/settings/reminders' },
  'mail_suppression.release': { label: 'メールの送信の停止の解除', roles: CA, where: 'notifications.ts の POST /admin/email-suppressions/release' },
  'roster.required_fields': { label: 'スタッフ名簿の必須項目の設定', roles: CA, where: 'roster.ts の PUT /admin/roster/field-settings' },
  'hq_view.allow': { label: '本部の閲覧の許可', roles: CA, where: 'hq-support.ts の PUT /admin/hq-access' },
  'staff_pay.visible_setting': { label: 'スタッフへの支払額の表示の設定', roles: CA, where: 'staff-pay.ts の PUT /admin/staff-pay/settings' },
  // ---- 画面だけ（API では絞っていない。今の動きのまま。docs/permissions.md の「画面だけ」） ----
  'admin_push.device': { label: '管理画面の端末のプッシュ通知の登録（画面だけ。API は4ロール）', roles: CA, where: 'public/static/notifications.js の通知の受け取り設定' },
  'tour.setup': { label: 'はじめにやること・操作ガイドの初期設定の案内', roles: CA, where: 'tours.ts の案内、public/static/tour.js' },
} as const satisfies Record<string, Permission>

export type Action = keyof typeof PERMISSIONS

/** ロール（または利用者）が操作を許されているか。表にない操作は false */
export function can(roleOrUser: string | { role?: string | null } | null | undefined, action: Action | string): boolean {
  const role = typeof roleOrUser === 'string' ? roleOrUser : roleOrUser?.role
  const p = (PERMISSIONS as Record<string, Permission>)[action]
  return !!role && !!p && p.roles.includes(role as Role)
}

/** 操作を許すロールの一覧（通知の宛先などに使う） */
export function rolesFor(action: Action): Role[] {
  return [...PERMISSIONS[action].roles]
}

/** ロールが許されている操作の名前の一覧（/api/auth/me の permissions。並びは表の順） */
export function permissionsFor(role: string | null | undefined): Action[] {
  return (Object.keys(PERMISSIONS) as Action[]).filter(a => can(role, a))
}

/** Hono のミドルウェア: 操作を許されていなければ 403（文言・code はこれまでの応答のまま渡す）。
 *  関数の名前を requirePerm:<操作の名前> にする（scripts/gen-docs.mjs が、この名前から API の資料の「通すロール」を表で作る） */
export function requirePerm(action: Action, error = '権限がありません', code?: string) {
  const mw = async (c: any, next: () => Promise<void>) => {
    if (!can(c.get('user'), action)) return c.json(code ? { error, code } : { error }, 403)
    return next()
  }
  Object.defineProperty(mw, 'name', { value: `requirePerm:${action}` })
  return mw
}
