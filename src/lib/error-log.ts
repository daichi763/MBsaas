// 障害の記録と通知（利用者の決定 Sprint 13。#9622。表は migrations/0093_error_logs.sql）
//
// - recordError: サーバーの予期しないエラー（index.tsx の app.onError）と定期処理の失敗を error_logs に1件残す。
//   応答の後（ctx.waitUntil）に呼ぶ。記録に失敗しても例外は投げない（本来の処理を壊さない）。
//   残すのは参照番号・時刻・パス・メソッド・会社・ロール・エラーの要約だけ。利用者の ID・入力値は残さない。
// - 同じエラーが続くとき: 直近 RECORD_WINDOW_MINUTES 分に同じ fingerprint の行が RECORD_MAX_PER_FINGERPRINT 行あるか、
//   全体で RECORD_MAX_TOTAL 行あれば、新しい行を作らず、同じ fingerprint の最後の行の repeat_count に数える（書き込みは1行の更新だけ）。
//   まとめた分の参照番号は残らない（Workers Logs には1件ずつ残る。docs/monitoring.md）。
// - 通知: 記録のたびに直近 window 分の件数を数え、閾値以上なら本部の管理者（system_admin）全員にアプリ内の通知（kind: error_alert）を作る。
//   最後の通知から cooldown 分は送らない（error_alerts で判定。1文で判定と記録をするので、同時に起きても1回だけ）。
//   プッシュは user_notifications のトリガーで push_queue に積まれる（migrations/0081_push.sql）。送るのは呼び出し側（index.tsx）の flushPushQueue。
//   閾値などは環境変数（wrangler.jsonc の vars）で変えられる: ERROR_ALERT_THRESHOLD・ERROR_ALERT_WINDOW_MINUTES・ERROR_ALERT_COOLDOWN_MINUTES
import { nowJST } from './time'

export const ERROR_ALERT_KIND = 'error_alert'
export const ERROR_LOG_KEEP_DAYS = 90
const RECORD_WINDOW_MINUTES = 10
const RECORD_MAX_PER_FINGERPRINT = 20
const RECORD_MAX_TOTAL = 100
const MESSAGE_MAX = 300
const LOCATION_MAX = 200
const DEFAULTS = { threshold: 10, window: 10, cooldown: 60 }

export type ErrorAlertEnv = { DB: D1Database; ERROR_ALERT_THRESHOLD?: string; ERROR_ALERT_WINDOW_MINUTES?: string; ERROR_ALERT_COOLDOWN_MINUTES?: string }
export type ErrorAlertSettings = { threshold: number; window_minutes: number; cooldown_minutes: number }
export type ErrorEvent = {
  ref: string
  source: 'request' | 'cron'
  method?: string | null
  path?: string | null
  companyId?: number | null
  role?: string | null
  error: unknown
}

const intVar = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : def
}
export function errorAlertSettings(env: ErrorAlertEnv): ErrorAlertSettings {
  return {
    threshold: intVar(env.ERROR_ALERT_THRESHOLD, DEFAULTS.threshold, 1, 10000),
    window_minutes: intVar(env.ERROR_ALERT_WINDOW_MINUTES, DEFAULTS.window, 1, 1440),
    cooldown_minutes: intVar(env.ERROR_ALERT_COOLDOWN_MINUTES, DEFAULTS.cooldown, 1, 10080),
  }
}

/** 日本時間の YYYY-MM-DD HH:MM:SS（minutesAgo 分前） */
export function jstAt(minutesAgo = 0): string {
  return nowJST(-minutesAgo * 60000)
}

/** 参照番号（8桁の16進）。onError と同じ形 */
export function newErrorRef(): string {
  return crypto.randomUUID().slice(0, 8)
}

// 20文字以上で、数字か大文字を含む英数字（トークン・鍵など）。小文字と - _ だけの長い語（attendance-corrections などのルート名）は伏せない
const SECRET_LIKE = /[A-Za-z0-9_-]{20,}/g
const maskSecretLike = (s: string) => s.replace(SECRET_LIKE, m => (/[0-9A-Z]/.test(m) ? '***' : m))

/** パスに入る報告用URL・募集ページ・再設定のトークンを伏せる（#230） */
export function maskPath(p: string): string {
  return String(p || '').split('/').map(maskSecretLike).join('/')
}

/**
 * エラーの要約から、入力値や個人情報になりうる部分を伏せる。
 * 引用符で囲まれた値（JSON.parse の入力の抜粋・SQL の値など）、メールアドレス、6桁以上の数字（電話番号など）、トークンのような長い英数字
 */
export function sanitizeErrorText(s: string, max = MESSAGE_MAX): string {
  return maskSecretLike(String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+/g, '***@***'))
    .replace(/\d{6,}/g, '***')
    .trim()
    .slice(0, max)
}

export function summarizeError(err: unknown): { name: string; message: string; location: string | null } {
  const e = err as any
  const name = String((e && typeof e === 'object' && e.name) || (typeof err === 'string' ? 'Error' : typeof err)).slice(0, 60)
  const message = sanitizeErrorText(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(err))
  const frame = String((e && e.stack) || '').split('\n').map(l => l.trim()).find(l => l.startsWith('at ')) || null
  return { name, message, location: frame ? sanitizeErrorText(frame, LOCATION_MAX) : null }
}

// 同じエラーをまとめるための値（FNV-1a 32bit。数字を除いたパスと要約から作る）
function fingerprintOf(parts: (string | null | undefined)[]): string {
  const s = parts.map(p => String(p ?? '').replace(/\d+/g, '#')).join('|')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/**
 * error_logs に1件残し、閾値を超えていれば本部の管理者へ通知を作る。例外は投げない。
 * 戻り値の alerted が true なら、呼び出し側で flushPushQueue を呼ぶとプッシュがすぐに届く
 */
export async function recordError(env: ErrorAlertEnv, ev: ErrorEvent): Promise<{ recorded: boolean; alerted: boolean }> {
  const out = { recorded: false, alerted: false }
  const db = env?.DB
  if (!db) return out
  try {
    const s = summarizeError(ev.error)
    const method = ev.method ? String(ev.method).slice(0, 10) : null
    const path = ev.path ? maskPath(String(ev.path)).slice(0, 200) : null
    const fp = fingerprintOf([ev.source, method, path, s.name, s.message])
    const now = jstAt(), since = jstAt(RECORD_WINDOW_MINUTES)
    await db.batch([
      db.prepare(`INSERT INTO error_logs (ref, source, method, path, company_id, role, error_name, message, location, fingerprint, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM error_logs WHERE fingerprint = ? AND created_at >= ?) < ?
          AND (SELECT COUNT(*) FROM error_logs WHERE created_at >= ?) < ?`)
        .bind(ev.ref, ev.source, method, path, Number.isInteger(Number(ev.companyId)) && ev.companyId != null ? Number(ev.companyId) : null,
          ev.role ? String(ev.role).slice(0, 40) : null, s.name, s.message, s.location, fp, now,
          fp, since, RECORD_MAX_PER_FINGERPRINT, since, RECORD_MAX_TOTAL),
      // 上の行が作られなかった（上限に達した）ときだけ、同じエラーの最後の行に数える
      db.prepare(`UPDATE error_logs SET repeat_count = repeat_count + 1, last_repeat_at = ?
        WHERE error_id = (SELECT MAX(error_id) FROM error_logs WHERE fingerprint = ?) AND NOT EXISTS (SELECT 1 FROM error_logs WHERE ref = ? AND created_at = ?)`)
        .bind(now, fp, ev.ref, now),
    ])
    out.recorded = true
  } catch (e) {
    console.log(`error_logs insert failed: ${e}`)
    return out
  }
  try {
    out.alerted = await checkErrorAlert(env)
  } catch (e) {
    console.log(`error alert check failed: ${e}`)
  }
  return out
}

/** 直近 window 分の件数（行の数 + まとめた回数）。まとめた回数は最後の日時が window 内の行の分を数える（目安） */
export async function recentErrorCount(db: D1Database, windowMinutes: number): Promise<number> {
  const since = jstAt(windowMinutes)
  const row = await db.prepare(`SELECT (SELECT COUNT(*) FROM error_logs WHERE created_at >= ?)
      + (SELECT COALESCE(SUM(repeat_count), 0) FROM error_logs WHERE last_repeat_at >= ?) AS n`).bind(since, since).first() as any
  return Number(row?.n) || 0
}

/** 閾値を超えていて、最後の通知から cooldown 分たっていれば、通知を記録して本部の管理者にアプリ内の通知を作る */
export async function checkErrorAlert(env: ErrorAlertEnv): Promise<boolean> {
  const db = env.DB
  const st = errorAlertSettings(env)
  const n = await recentErrorCount(db, st.window_minutes)
  if (n < st.threshold) return false
  // 判定と記録を1文で行う（同時に別の要求が通っても、通知は1回だけ）
  const claimed = await db.prepare(`INSERT INTO error_alerts (window_minutes, error_count, threshold, created_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM error_alerts WHERE created_at >= ?) RETURNING alert_id`)
    .bind(st.window_minutes, n, st.threshold, jstAt(), jstAt(st.cooldown_minutes)).first() as any
  if (!claimed) return false
  const alertId = Number(claimed.alert_id)
  const title = `エラーが増えています（直近${st.window_minutes}分に${n}件）`
  const body = `サーバーの予期しないエラー・定期処理の失敗が、直近${st.window_minutes}分に${n}件ありました（通知の目安: ${st.threshold}件）。` +
    `本部画面の「障害」で内容を確認してください。次の通知は${st.cooldown_minutes}分後以降です。`
  // user_notifications にはプッシュのトリガーがあるので、件数は meta.changes ではなく RETURNING で数える
  const rows = (await db.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
    SELECT company_id, user_id, ?, ?, ?, '#errors', ?, ? FROM users WHERE role = 'system_admin' AND COALESCE(status, 'active') = 'active'
    RETURNING notification_id`).bind(ERROR_ALERT_KIND, title, body, alertId, jstAt()).all()).results || []
  const notified = rows.length
  await db.prepare('UPDATE error_alerts SET notified = ? WHERE alert_id = ?').bind(notified, alertId).run()
  console.error(JSON.stringify({ level: 'error', event: 'error_alert', alert_id: alertId, count: n, window_minutes: st.window_minutes, notified }))
  return true
}
