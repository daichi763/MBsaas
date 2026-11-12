// 本部画面「障害」の通知の送り先・DB の大きさの API（Sprint 25 #9971 #9974。/api/hq/monitor。system_admin だけ）
//   GET  /monitor                         … 送り先ごとの最後の送信の結果（URL・トークンは返さない）と、DB の大きさ・増え方・表ごとの行数
//   GET  /monitor/banner                  … 本部画面の上部の帯に使う DB の段階（問い合わせ1回）
//   POST /monitor/destinations/:key/test  … その送り先だけにテストの通知を送る（同じ送り先は1分に1回まで）
//   POST /monitor/db-size/count-tables    … 表ごとの行数を数える（すべての行を読むので、10分に1回まで）
// 仕組みは src/services/alerts.ts・src/services/monitor.ts、手順は docs/monitoring.md
import { Hono } from 'hono'
import { loadDestinations, sendAlert, claimAlert, DEST_TYPE_LABEL, type AlertEnv } from './services/alerts'
import { dbSizeHistory, summarizeDbSize, dbSizeLimitMb, countTableRows, type MonitorEnv } from './services/monitor'
import { todayJST, addDays } from './lib/time'
import { errorAlertSettings, type ErrorAlertEnv } from './lib/error-log'

type Env = { Bindings: MonitorEnv & ErrorAlertEnv; Variables: { user: any; hqAudited?: boolean } }
export const hqMonitorApi = new Hono<Env>()

const TABLES_TOP = 15
const TEST_COOLDOWN_MINUTES = 1
const COUNT_COOLDOWN_MINUTES = 10

hqMonitorApi.get('/monitor', async (c) => {
  const db = c.env.DB
  const { source, list } = await loadDestinations(c.env)
  const today = todayJST()
  const [statusRows, history, latestCounts] = await db.batch([
    db.prepare('SELECT dest_key, last_status, last_http_status, last_error, last_event, last_attempt_at, last_success_at FROM alert_destination_status WHERE dest_key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(list.map(d => d.key))),
    db.prepare('SELECT day, size_bytes FROM db_size_logs WHERE day >= ? ORDER BY day').bind(addDays(today, -90)),
    db.prepare('SELECT table_counts_json, table_counts_at, table_counts_rows_read FROM db_size_logs WHERE table_counts_at IS NOT NULL ORDER BY day DESC LIMIT 1'),
  ])
  const st = new Map(((statusRows.results || []) as any[]).map(r => [r.dest_key, r]))
  const destinations = list.map(d => {
    const s = st.get(d.key) as any
    return { key: d.key, type: d.type, type_label: DEST_TYPE_LABEL[d.type] || d.type, label: d.label, receive: d.receive, problem: d.problem,
      last_status: s?.last_status || null, last_http_status: s?.last_http_status ?? null, last_error: s?.last_error || null,
      last_event: s?.last_event || null, last_attempt_at: s?.last_attempt_at || null, last_success_at: s?.last_success_at || null }
  })
  const rows = (history.results || []) as any[]
  const summary = summarizeDbSize(rows, dbSizeLimitMb(c.env), today)
  const lc = ((latestCounts.results || [])[0] || null) as any
  let tables: { table: string; rows: number }[] = []
  try { tables = lc?.table_counts_json ? JSON.parse(lc.table_counts_json) : [] } catch { tables = [] }
  return c.json({
    destinations, destinations_source: source, cooldown_minutes: errorAlertSettings(c.env).cooldown_minutes,
    db_size: { ...summary, history: rows.slice(-30).map(r => ({ day: r.day, size_bytes: Number(r.size_bytes) || 0 })),
      tables: tables.slice(0, TABLES_TOP), tables_total: tables.length, tables_at: lc?.table_counts_at || null, tables_rows_read: lc?.table_counts_rows_read ?? null },
  })
})

hqMonitorApi.get('/monitor/banner', async (c) => {
  const r = await c.env.DB.prepare('SELECT day, size_bytes, limit_mb, stage FROM db_size_logs WHERE checked_at IS NOT NULL ORDER BY day DESC LIMIT 1').first() as any
  if (!r) return c.json({ db_stage: 'ok' })
  const limitMb = dbSizeLimitMb(c.env)
  const pct = Math.round((Number(r.size_bytes) || 0) / (limitMb * 1024 * 1024) * 1000) / 10
  return c.json({ db_stage: r.stage, db_pct: pct, day: r.day })
})

hqMonitorApi.post('/monitor/destinations/:key/test', async (c) => {
  const key = String(c.req.param('key') || '')
  if (!/^[0-9a-f]{12}$/.test(key)) return c.json({ error: '送り先が見つかりません' }, 404)
  const env = c.env as AlertEnv
  const { list } = await loadDestinations(env)
  const d = list.find(x => x.key === key)
  if (!d) return c.json({ error: '送り先が見つかりません。設定が変わった場合は、画面を読み直してください' }, 404)
  if (!(await claimAlert(env.DB, `test:${key}`, TEST_COOLDOWN_MINUTES)).claimed) return c.json({ error: '同じ送り先へのテスト送信は1分に1回までです。少し待ってからお試しください' }, 429)
  const [r] = await sendAlert(env, { event: 'test', severity: 'test', title: 'テストの通知です', lines: ['本部画面の「テスト送信」から送りました。障害が起きたときは、この送り先に知らせます。'] }, { only: key })
  return c.json({ ok: r?.status === 'sent', result: r ? { status: r.status, http_status: r.http_status, error: r.error } : null })
})

hqMonitorApi.post('/monitor/db-size/count-tables', async (c) => {
  if (!(await claimAlert(c.env.DB, 'count_tables', COUNT_COOLDOWN_MINUTES)).claimed) return c.json({ error: `表ごとの行数は${COUNT_COOLDOWN_MINUTES}分に1回まで数えられます（すべての行を読むため）` }, 429)
  const r = await countTableRows(c.env)
  return c.json({ tables: r.tables.slice(0, TABLES_TOP), tables_total: r.tables.length, tables_at: r.at, tables_rows_read: r.rows_read })
})
