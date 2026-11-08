// 本部画面「障害」の API（利用者の決定 Sprint 13。#9622。/api/hq/errors。system_admin だけ）
//   GET  /errors              … 件数の推移（日別）・よく起きているエラー・記録の一覧（参照番号・種類・会社で絞る）・未読の障害の通知
//   POST /errors/alerts/read  … 自分あての障害の通知（error_alert）を既読にする
// 記録と通知の仕組みは src/lib/error-log.ts、表は migrations/0093_error_logs.sql
// GET /errors は、秘密の値（Turnstile・RATE_LIMIT_SALT）が登録されているかも返す（値そのものは返さない）。
// 会社の募集・応募の画面には出さず、本部だけが見る（#9921）
import { Hono } from 'hono'
import { ERROR_ALERT_KIND, ERROR_LOG_KEEP_DAYS, errorAlertSettings, jstAt, recentErrorCount, type ErrorAlertEnv } from './lib/error-log'
import { ipSaltState, turnstileState } from './recruit'

type Env = { Bindings: ErrorAlertEnv & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string; RATE_LIMIT_SALT?: string }; Variables: { user: any; hqAudited?: boolean } }
export const hqErrorsApi = new Hono<Env>()

const PAGE = 50
const TREND_DAYS = 14
const GROUP_LIMIT = 10
const SOURCES = ['request', 'cron']

// 日本時間の日付（days 日前）
const jstDate = (daysAgo: number) => new Date(Date.now() + 9 * 3600 * 1000 - daysAgo * 86400000).toISOString().slice(0, 10)

hqErrorsApi.get('/errors', async (c) => {
  const db = c.env.DB
  const q = String(c.req.query('q') || '').trim().toLowerCase()
  const source = SOURCES.includes(String(c.req.query('source'))) ? String(c.req.query('source')) : ''
  const cid = String(c.req.query('company_id') || '')
  const before = /^\d{1,12}$/.test(String(c.req.query('before') || '')) ? Number(c.req.query('before')) : null
  // 参照番号は 8 桁の16進。途中まででも探せるようにする（前方一致）
  if (q && !/^[0-9a-f]{1,8}$/.test(q)) return c.json({ error: '参照番号は、画面に出た8桁の英数字（0〜9・a〜f）で入力してください' }, 400)

  const where: string[] = []
  const binds: unknown[] = []
  if (q) { where.push("e.ref LIKE ? || '%'"); binds.push(q) }
  if (source) { where.push('e.source = ?'); binds.push(source) }
  if (/^\d{1,9}$/.test(cid)) { where.push('e.company_id = ?'); binds.push(Number(cid)) }
  else if (cid === 'none') where.push('e.company_id IS NULL')
  const listWhere = [...where, ...(before ? ['e.error_id < ?'] : [])]
  const listBinds = [...binds, ...(before ? [before] : [])]
  const wsql = (w: string[]) => (w.length ? `WHERE ${w.join(' AND ')}` : '')

  const since = jstDate(TREND_DAYS - 1)
  const u = c.get('user')
  const [logs, daily, groups, totals, alerts, lastAlert] = await db.batch([
    db.prepare(`SELECT e.error_id, e.ref, e.source, e.method, e.path, e.company_id, co.company_name, e.role, e.error_name, e.message, e.location,
        e.repeat_count, e.last_repeat_at, e.created_at
      FROM error_logs e LEFT JOIN companies co ON co.company_id = e.company_id ${wsql(listWhere)} ORDER BY e.error_id DESC LIMIT ?`).bind(...listBinds, PAGE + 1),
    // 日別の件数（行の数 + まとめた回数。まとめた回数は最初の行の日に数える）
    db.prepare(`SELECT substr(e.created_at, 1, 10) AS day, SUM(1 + e.repeat_count) AS n, SUM(CASE WHEN e.source = 'cron' THEN 1 + e.repeat_count ELSE 0 END) AS cron
      FROM error_logs e ${wsql([...where, 'e.created_at >= ?'])} GROUP BY day ORDER BY day`).bind(...binds, since),
    // 直近7日でよく起きているエラー（同じ fingerprint をまとめる）
    db.prepare(`SELECT e.fingerprint, MAX(e.source) AS source, MAX(e.method) AS method, MAX(e.path) AS path, MAX(e.error_name) AS error_name, MAX(e.message) AS message,
        SUM(1 + e.repeat_count) AS n, COUNT(DISTINCT e.company_id) AS companies, MAX(COALESCE(e.last_repeat_at, e.created_at)) AS last_at, MAX(e.ref) AS sample_ref
      FROM error_logs e ${wsql([...where, 'e.created_at >= ?'])} GROUP BY e.fingerprint ORDER BY n DESC, last_at DESC LIMIT ?`).bind(...binds, jstAt(7 * 24 * 60), GROUP_LIMIT),
    db.prepare(`SELECT COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 + repeat_count ELSE 0 END), 0) AS last_24h,
        COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 + repeat_count ELSE 0 END), 0) AS last_7d, COUNT(*) AS rows_total
      FROM error_logs`).bind(jstAt(24 * 60), jstAt(7 * 24 * 60)),
    db.prepare(`SELECT notification_id, title, body, created_at FROM user_notifications WHERE user_id = ? AND kind = ? AND read_at IS NULL ORDER BY notification_id DESC LIMIT 5`)
      .bind(u.user_id, ERROR_ALERT_KIND),
    db.prepare('SELECT alert_id, window_minutes, error_count, threshold, notified, created_at FROM error_alerts ORDER BY alert_id DESC LIMIT 1'),
  ])
  const rows = (logs.results || []) as any[]
  const settings = errorAlertSettings(c.env)
  const t = ((totals.results || [])[0] || {}) as any
  // 日別の件数は、記録のない日を 0 で埋めて返す
  const byDay = new Map(((daily.results || []) as any[]).map(r => [r.day, r]))
  const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
    const day = jstDate(TREND_DAYS - 1 - i)
    const r = byDay.get(day) as any
    return { day, count: Number(r?.n) || 0, cron: Number(r?.cron) || 0 }
  })
  return c.json({
    logs: rows.slice(0, PAGE), has_more: rows.length > PAGE,
    trend, groups: groups.results || [],
    totals: { last_window: await recentErrorCount(db, settings.window_minutes), last_24h: Number(t.last_24h) || 0, last_7d: Number(t.last_7d) || 0 },
    settings, keep_days: ERROR_LOG_KEEP_DAYS,
    alerts_unread: alerts.results || [], last_alert: (lastAlert.results || [])[0] || null,
    secrets: { turnstile: turnstileState(c.env), rate_limit_salt: ipSaltState(c.env) },
  })
})

// 自分あての未読の障害の通知（本部画面のタブの件数に使う。軽い問い合わせ1回）
hqErrorsApi.get('/errors/alerts', async (c) => {
  const u = c.get('user')
  const rows = (await c.env.DB.prepare(`SELECT notification_id, title, body, created_at FROM user_notifications WHERE user_id = ? AND kind = ? AND read_at IS NULL ORDER BY notification_id DESC LIMIT 5`)
    .bind(u.user_id, ERROR_ALERT_KIND).all()).results || []
  return c.json({ alerts_unread: rows })
})

// 自分あての障害の通知を既読にする（画面を開いて「確認しました」を押したとき）。操作の履歴（hq_audit_logs）には残さない
hqErrorsApi.post('/errors/alerts/read', async (c) => {
  const u = c.get('user')
  c.set('hqAudited', true)
  const r = await c.env.DB.prepare(`UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND kind = ? AND read_at IS NULL RETURNING notification_id`)
    .bind(jstAt(), u.user_id, ERROR_ALERT_KIND).all()
  return c.json({ ok: true, read: (r.results || []).length })
})
