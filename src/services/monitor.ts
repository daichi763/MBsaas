// D1 の DB の大きさの見張りと、毎朝のまとめの通知（Sprint 25 #9971 #9974。作業単位 w25-monitor。docs/monitoring.md の 10 章）
//
// - 大きさは D1 の結果の meta.size_after（その文の後の DB の大きさ。バイト）で取る。取れないときは PRAGMA page_count × page_size。
// - 上限は vars の DB_SIZE_LIMIT_MB（既定 500 = 無料プラン。有料に切り替えたら 10240 に変える）。段階はこの上限に対して決める:
//     prepare   … 50% か、上限まで残り12か月 … 準備（本部画面に出し、通知は1回）
//     start     … 60% か、残り6か月          … 移す仕組みに着手（通知は1回）
//     warning   … 80%                        … 警告（毎日通知）
//     emergency … 90%                        … 緊急（毎日通知・すぐに知らせる種類。本部画面の上部に赤い帯）
//   残り月数は、直近3か月（記録が7日分以上あるとき）の増え方から計算する。
// - 記録は毎日1回（15分おきの定期処理の、日本時間 8:00 以降の最初の起動。db_size_logs に1日1行）。
//   同じ起動で、送り先（ALERT_DESTINATIONS）のうち毎朝のまとめを受け取るものへ、前日からの障害の件数などを送る。
import { notifyHq, sendAlert, loadDestinations, receives, type AlertEnv } from './alerts'
import { nowJST, todayJST, addDays, dayDiff } from '../lib/time'

export type MonitorEnv = AlertEnv & { DB_SIZE_LIMIT_MB?: string }
export type DbStage = 'ok' | 'prepare' | 'start' | 'warning' | 'emergency'
export const DB_STAGE_RANK: Record<DbStage, number> = { ok: 0, prepare: 1, start: 2, warning: 3, emergency: 4 }
export const DB_STAGE_LABEL: Record<DbStage, string> = { ok: '余裕あり', prepare: '準備', start: '着手', warning: '警告', emergency: '緊急' }
const DEFAULT_LIMIT_MB = 500
const GROWTH_DAYS = 90       // 増え方を見る期間（直近3か月）
const GROWTH_MIN_DAYS = 7    // これより記録が短いときは増え方を出さない
const DAYS_PER_MONTH = 30.44
const MB = 1024 * 1024
const DAILY_HOUR = 8         // 毎朝のまとめを送る時刻（日本時間）
const COUNT_CHUNK = 50       // 表ごとの行数を数えるとき、1つの文にまとめる表の数（D1 の1つの文の列の数の上限より少なく）

export function dbSizeLimitMb(env: { DB_SIZE_LIMIT_MB?: string }): number {
  const n = Number(env?.DB_SIZE_LIMIT_MB)
  return Number.isInteger(n) && n >= 1 && n <= 1024 * 1024 ? n : DEFAULT_LIMIT_MB
}

/** 今の DB の大きさ（バイト）と、取れた方法。取れなければ null */
export async function measureDbSize(db: D1Database): Promise<{ bytes: number; method: string } | null> {
  try {
    const r = await db.prepare('SELECT 1 AS one').run()
    const s = Number((r as any)?.meta?.size_after)
    if (Number.isFinite(s) && s > 0) return { bytes: s, method: 'meta.size_after' }
  } catch { }
  try {
    const [a, b] = await db.batch([db.prepare('PRAGMA page_count'), db.prepare('PRAGMA page_size')])
    const pc = Number(Object.values(((a.results || [])[0] || {}) as any)[0]), ps = Number(Object.values(((b.results || [])[0] || {}) as any)[0])
    if (pc > 0 && ps > 0) return { bytes: pc * ps, method: 'pragma' }
  } catch { }
  return null
}

export type DbSizeSummary = {
  day: string | null; size_bytes: number | null; limit_mb: number; pct: number | null; stage: DbStage; stage_label: string
  growth_bytes_per_month: number | null; months_left: number | null; date_80: string | null; date_100: string | null
  reached_80: boolean; reached_100: boolean; growth_days: number
}

/** 段階を決める（割合と残り月数から） */
export function dbStageOf(pct: number, monthsLeft: number | null): DbStage {
  if (pct >= 90) return 'emergency'
  if (pct >= 80) return 'warning'
  if (pct >= 60 || (monthsLeft != null && monthsLeft <= 6)) return 'start'
  if (pct >= 50 || (monthsLeft != null && monthsLeft <= 12)) return 'prepare'
  return 'ok'
}

/** 記録（日付の古い順。直近 GROWTH_DAYS 日分）から、割合・1か月の増え方・残り月数・80% と 100% に届く見込みの日を出す */
export function summarizeDbSize(rows: { day: string; size_bytes: number }[], limitMb: number, today = todayJST()): DbSizeSummary {
  const last = rows[rows.length - 1]
  const limit = limitMb * MB
  const empty: DbSizeSummary = { day: null, size_bytes: null, limit_mb: limitMb, pct: null, stage: 'ok', stage_label: DB_STAGE_LABEL.ok,
    growth_bytes_per_month: null, months_left: null, date_80: null, date_100: null, reached_80: false, reached_100: false, growth_days: 0 }
  if (!last) return empty
  const size = Number(last.size_bytes) || 0
  const pct = Math.round(size / limit * 1000) / 10
  const from = addDays(last.day, -GROWTH_DAYS)
  const first = rows.find(r => r.day >= from) || last
  const span = dayDiff(first.day, last.day)
  let perDay: number | null = null
  if (span >= GROWTH_MIN_DAYS) perDay = (size - (Number(first.size_bytes) || 0)) / span
  const growth = perDay == null ? null : Math.round(perDay * DAYS_PER_MONTH)
  const monthsLeft = perDay != null && perDay > 0 ? Math.max(0, Math.round((limit - size) / (perDay * DAYS_PER_MONTH) * 10) / 10) : null
  const dateAt = (target: number) => perDay != null && perDay > 0 && size < target ? addDays(today, Math.ceil((target - size) / perDay)) : null
  const stage = dbStageOf(pct, monthsLeft)
  return { day: last.day, size_bytes: size, limit_mb: limitMb, pct, stage, stage_label: DB_STAGE_LABEL[stage],
    growth_bytes_per_month: growth, months_left: monthsLeft, date_80: dateAt(limit * 0.8), date_100: dateAt(limit),
    reached_80: size >= limit * 0.8, reached_100: size >= limit, growth_days: span }
}

/** 段階を知らせるか: 「警告」「緊急」は毎日、「準備」「着手」は前の記録（highestPrevStage）より段階が上がった日だけ */
export function shouldNotifyDbStage(prevStage: string | null, stage: DbStage): boolean {
  const rank = DB_STAGE_RANK[stage]
  const prevRank = prevStage ? DB_STAGE_RANK[prevStage as DbStage] ?? 0 : 0
  return rank >= DB_STAGE_RANK.warning || (rank > 0 && rank > prevRank)
}

/** 今日より前の記録（直近 GROWTH_DAYS 日）のうち一番上の段階。残り月数・割合が目安の前後で上下しても、「準備」「着手」を何度も知らせないため */
export function highestPrevStage(history: { day: string; stage: string }[], today: string): DbStage | null {
  let best: DbStage | null = null
  for (const r of history) {
    if (r.day < today && r.stage in DB_STAGE_RANK && (!best || DB_STAGE_RANK[r.stage as DbStage] > DB_STAGE_RANK[best])) best = r.stage as DbStage
  }
  return best
}

/** 直近 GROWTH_DAYS 日の記録（古い順） */
export async function dbSizeHistory(db: D1Database, today = todayJST()): Promise<{ day: string; size_bytes: number; stage: string }[]> {
  return ((await db.prepare('SELECT day, size_bytes, stage FROM db_size_logs WHERE day >= ? ORDER BY day')
    .bind(addDays(today, -GROWTH_DAYS)).all()).results || []) as any[]
}

const mbText = (b: number) => `${(b / MB).toFixed(1)}MB`
function dbSizeLines(s: DbSizeSummary): string[] {
  const lines = [`今の大きさ: ${mbText(s.size_bytes || 0)}（上限 ${s.limit_mb}MB の ${s.pct}%）`]
  if (s.growth_bytes_per_month != null) lines.push(`1か月の増え方: ${mbText(s.growth_bytes_per_month)}${s.months_left != null ? `（上限まで残り約${s.months_left}か月）` : ''}`)
  if (s.date_80) lines.push(`80% に届く見込み: ${s.date_80}`)
  if (s.date_100) lines.push(`上限に届く見込み: ${s.date_100}`)
  return lines
}
const STAGE_ADVICE: Record<DbStage, string> = {
  ok: '',
  prepare: '有料プランへの切り替え・データを移す仕組みの準備を始める目安です。',
  start: 'データを移す仕組み（有料プランへの切り替えなど）に着手する目安です。',
  warning: '上限の80%を超えました。有料プランへの切り替えなどを急いでください（毎日通知します）。',
  emergency: '上限の90%を超えました。上限に届くと書き込みができなくなります。すぐに対応してください（毎日通知します）。',
}

/**
 * 毎日1回の記録と通知（15分おきの定期処理から呼ぶ。8:00 より前と、今日の分を済ませた後は何もしない＝問い合わせ1回）。
 * 段階が「準備」「着手」に上がった日に1回、「警告」「緊急」は毎日、本部の管理者と送り先に知らせる。続けて毎朝のまとめを送る
 */
export async function runMonitorDaily(env: MonitorEnv): Promise<Record<string, unknown>> {
  // テスト（TEST_HOOKS='true' のローカル）では時刻を待たない
  if (Number(nowJST().slice(11, 13)) < DAILY_HOUR && env.TEST_HOOKS !== 'true') return { idle: true, skipped: 'before_8am' }
  const db = env.DB
  const today = todayJST()
  const done = await db.prepare('SELECT checked_at FROM db_size_logs WHERE day = ?').bind(today).first() as any
  if (done?.checked_at) return { idle: true }
  const m = await measureDbSize(db)
  if (!m) return { error: 'D1 の大きさを取れませんでした（meta.size_after・PRAGMA page_count のどちらも使えない）' }
  const limitMb = dbSizeLimitMb(env)
  const history = await dbSizeHistory(db, today)
  const rows = [...history.filter(r => r.day < today), { day: today, size_bytes: m.bytes }]
  const s = summarizeDbSize(rows, limitMb, today)
  const notify = shouldNotifyDbStage(highestPrevStage(history, today), s.stage)
  const now = nowJST()
  // 先に記録して（今日の分を済ませた印）、通知に失敗しても同じ日に何度も送らない
  await db.prepare(`INSERT INTO db_size_logs (day, size_bytes, limit_mb, method, stage, notified, checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET size_bytes = excluded.size_bytes, limit_mb = excluded.limit_mb, method = excluded.method, stage = excluded.stage,
      notified = excluded.notified, checked_at = excluded.checked_at, updated_at = excluded.updated_at`)
    .bind(today, m.bytes, limitMb, m.method, s.stage, notify ? 1 : 0, now, now, now).run()
  let notified = 0
  if (notify) {
    const title = `DB の大きさが「${s.stage_label}」の段階です（上限の${s.pct}%）`
    const lines = [STAGE_ADVICE[s.stage], ...dbSizeLines(s)].filter(Boolean)
    const r = await notifyHq(env, { event: 'db_size', severity: s.stage === 'emergency' ? 'critical' : 'normal', title, lines },
      `${lines.join('。')}。本部画面の「障害」の「DB の大きさ」で確認してください。`)
    notified = r.notified
  }
  const digest = await sendDailyDigest(env, s)
  return { size_bytes: m.bytes, method: m.method, pct: s.pct, stage: s.stage, notified_stage: notify, notified, digest_sent: digest }
}

/** 毎朝のまとめ（受け取る送り先があるときだけ。前日からの障害の件数・定期処理の失敗・DB の大きさ） */
async function sendDailyDigest(env: MonitorEnv, s: DbSizeSummary): Promise<number> {
  const { list } = await loadDestinations(env)
  if (!list.some(d => !d.problem && receives(d, 'digest'))) return 0
  const since = nowJST(-24 * 3600000)
  const sinceIso = new Date(Date.now() - 24 * 3600000).toISOString()
  const [e, c] = await env.DB.batch([
    env.DB.prepare(`SELECT COALESCE(SUM(1 + repeat_count), 0) AS n, COALESCE(SUM(CASE WHEN source = 'cron' THEN 1 + repeat_count ELSE 0 END), 0) AS cron FROM error_logs WHERE created_at >= ?`).bind(since),
    env.DB.prepare(`SELECT job, COUNT(*) AS n FROM cron_runs WHERE status = 'failed' AND started_at >= ? GROUP BY job ORDER BY job LIMIT 10`).bind(sinceIso),
  ])
  const er = ((e.results || [])[0] || {}) as any
  const failedJobs = (c.results || []) as any[]
  const lines = [
    `直近24時間のエラー: ${Number(er.n) || 0}件（うち定期処理 ${Number(er.cron) || 0}件）`,
    failedJobs.length ? `失敗した定期処理: ${failedJobs.map(j => `${j.job}（${Number(j.n)}回）`).join('、')}` : '失敗した定期処理: なし',
    ...dbSizeLines(s).map(l => `DB の${l}`),
    `DB の段階: ${s.stage_label}`,
  ]
  const r = await sendAlert(env, { event: 'digest', severity: 'digest', title: `毎朝のまとめ（${todayJST()}）`, lines })
  return r.filter(x => x.status === 'sent').length
}

/**
 * 表ごとの行数（本部画面のボタンで数える。すべての行を読むので、定期処理では数えない）。
 * 表を50個ずつ1つの文にまとめて（batch で1回に）数え、今日の記録の行に残す。読んだ行数（meta.rows_read）も返す
 */
export async function countTableRows(env: MonitorEnv): Promise<{ tables: { table: string; rows: number }[]; rows_read: number; at: string }> {
  const db = env.DB
  const names = ((await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`).all()).results || [])
    .map((r: any) => String(r.name)).filter(n => /^[A-Za-z0-9_]+$/.test(n))
  if (!names.length) return { tables: [], rows_read: 0, at: nowJST() }
  // D1 は UNION ALL を5つまでしか重ねられないので、1つの文に表を COUNT_CHUNK 個ずつ（列にして）まとめ、batch で1回に送る
  const chunks: string[][] = []
  for (let i = 0; i < names.length; i += COUNT_CHUNK) chunks.push(names.slice(i, i + COUNT_CHUNK))
  const res = await db.batch(chunks.map(ch => db.prepare(`SELECT ${ch.map((n, i) => `(SELECT COUNT(*) FROM "${n}") AS c${i}`).join(', ')}`)))
  const tables = chunks.flatMap((ch, k) => { const row = ((res[k]?.results || [])[0] || {}) as any; return ch.map((n, i) => ({ table: n, rows: Number(row[`c${i}`]) || 0 })) })
    .sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table))
  const rowsRead = res.reduce((a, r) => a + (Number((r as any)?.meta?.rows_read) || 0), 0)
  const now = nowJST(), today = todayJST()
  const m = await measureDbSize(db)
  const limitMb = dbSizeLimitMb(env)
  // 今日の記録がなければ作る（段階の判定・通知は毎朝の定期処理に任せるので、checked_at は入れない）。大きさを取れないときは、ある行だけを直す
  if (!m) {
    await db.prepare('UPDATE db_size_logs SET table_counts_json = ?, table_counts_at = ?, table_counts_rows_read = ?, updated_at = ? WHERE day = ?')
      .bind(JSON.stringify(tables), now, rowsRead, now, today).run()
    return { tables, rows_read: rowsRead, at: now }
  }
  await db.prepare(`INSERT INTO db_size_logs (day, size_bytes, limit_mb, method, stage, table_counts_json, table_counts_at, table_counts_rows_read, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET table_counts_json = excluded.table_counts_json, table_counts_at = excluded.table_counts_at,
      table_counts_rows_read = excluded.table_counts_rows_read, updated_at = excluded.updated_at`)
    .bind(today, m.bytes, limitMb, m.method, 'ok', JSON.stringify(tables), now, rowsRead, now, now).run()
  return { tables, rows_read: rowsRead, at: now }
}
