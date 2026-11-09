// =========================================================
// 管理画面のバッジ（左のメニュー・スマホのメニューの件数）をまとめて返す（#9935）
//   GET /api/admin/badges → { roster_chat: { unread }, notifications: { count }, board: { unread }, corrections: { count },
//                             recruit: { pending, pending_public, pending_inactive } }
// 中身はそれぞれ今までの5本（roster-chat/unread-count・notifications/unread-count・board/unread-count・
// corrections/pending-count・recruit-applications/summary）と同じ値で、同じ関数で数える。
// 画面（public/static/admin.js の refreshBadges）は、開いたときと60秒ごとの更新をこの1本で行う。
// /api/admin/* の権限のミドルウェア（api.ts）を通ってから呼ばれる。ロールで見られない数（今の API が 403 を返すもの）は返さない。
// 1つが失敗しても、ほかの数は返す（失敗したものは入れない。画面はそのバッジを前のままにする）
// =========================================================
import { Hono } from 'hono'
import { chatUnreadCount, CHAT_ROLES } from './roster-chat'
import { unreadNotificationCount } from './notifications'
import { boardUnreadCount } from './board'
import { companyPendingCorrectionCount } from './corrections'
import { recruitApplicationCounts } from './recruit'

type Bindings = { DB: D1Database }
type Variables = { user: any }

export const adminBadgesApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminBadgesApi.get('/badges', async (c) => {
  const u = c.get('user')
  const db = c.env.DB
  const parts: [string, () => Promise<unknown>][] = []
  if (CHAT_ROLES.includes(u.role)) parts.push(['roster_chat', async () => ({ unread: await chatUnreadCount(db, u) })])
  parts.push(
    ['notifications', async () => ({ count: await unreadNotificationCount(db, [u.user_id]) })],
    ['board', async () => ({ unread: await boardUnreadCount(c) })],
    ['corrections', async () => ({ count: await companyPendingCorrectionCount(db, u.company_id) })],
    ['recruit', () => recruitApplicationCounts(db, u.company_id)],
  )
  const settled = await Promise.allSettled(parts.map(([, f]) => f()))
  const out: Record<string, unknown> = {}
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out[parts[i][0]] = r.value
    else console.log(`badges: ${parts[i][0]} failed: ${r.reason}`)
  })
  return c.json(out)
})
