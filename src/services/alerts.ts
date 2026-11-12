// 障害の通知の送り先（Sprint 25 #9974。作業単位 w25-monitor。docs/monitoring.md の 9 章）
//
// - 送り先は秘密の値 ALERT_DESTINATIONS（JSON の配列。base64 にした JSON でもよい）で持つ。無い・空なら何も送らない（エラーにしない）。
//   各要素: { type, url | token・to, receive, name }
//     type    … slack | discord | google_chat | teams | line | webhook | email
//     url     … slack・discord・google_chat・teams・webhook の Incoming Webhook の URL（https）
//     token・to … line の Messaging API のチャネルのアクセストークンと、送る相手（ユーザー・グループの ID）
//     to      … email の宛先（Resend で送る。MAIL_ENABLED が 'true' で RESEND_API_KEY があるときだけ送り、無ければ「未設定」と残す）
//     receive … all（既定。すべて）| critical（打刻・日報の失敗・エラーの急増など、サービスが止まりかけているものだけ）| digest（毎朝のまとめだけ）
//     name    … 本部画面に出す名前（省略時は「Slack 1」など）
//   以前の決定の ALERT_WEBHOOK_URL（URL 1つ）があれば、type: webhook・receive: all の送り先として足す。
// - 送り方の違いは formatRequest の1か所にまとめる。1つの送り先の失敗（通信できない・4xx など）はほかの送り先に影響させない。
//   送信の失敗は記録（alert_destination_status）だけで、呼び出し元の処理には影響させない（例外は投げない）。
// - 送る中身は件名・場所・参照番号・件数だけ（個人の情報・入力値は入れない）。
//   URL・トークン・宛先は、画面・ログ・error_logs・alert_destination_status に出さない（送り先は種類と短いハッシュ dest_key で見分ける）。
// - 同じ通知を続けて送らないための判定は claimAlert（alert_cooldowns。1文で判定と記録をする）。
import { canSendMail, sendEmail, type MailEnv } from './email'
import { ERROR_ALERT_KIND, maskPath } from '../lib/error-log'
import { nowJST } from '../lib/time'
import { sha256 } from '../lib/hash'
import { appBaseUrl } from '../lib/http'

export type AlertEnv = {
  DB: D1Database
  ALERT_DESTINATIONS?: string
  ALERT_WEBHOOK_URL?: string
  APP_BASE_URL?: string
  MAIL_ENABLED?: string
  RESEND_API_KEY?: string
  MAIL_FROM?: string
  TEST_HOOKS?: string
}
// critical: すぐに知らせるもの / normal: そのほかの通知 / digest: 毎朝のまとめ / test: 本部画面の「テスト送信」
export type AlertSeverity = 'critical' | 'normal' | 'digest' | 'test'
export type AlertEvent = {
  event: string        // 通知の種類（error_threshold・critical_failure・cron_failed・db_size・digest・test）
  severity: AlertSeverity
  title: string
  lines?: string[]
  ref?: string | null
  path?: string | null
  count?: number | null
}
export const DEST_TYPES = ['slack', 'discord', 'google_chat', 'teams', 'line', 'webhook', 'email'] as const
export const DEST_TYPE_LABEL: Record<string, string> = {
  slack: 'Slack', discord: 'Discord', google_chat: 'Google Chat', teams: 'Microsoft Teams', line: 'LINE', webhook: 'Webhook', email: 'メール',
}
const RECEIVES = ['all', 'critical', 'digest'] as const
export type Destination = {
  key: string
  index: number
  type: string
  label: string
  receive: 'all' | 'critical' | 'digest'
  problem: string | null  // 設定の誤り（送らない）。値そのものは入れない
  url?: string
  token?: string
  to?: string
}
export type DestinationResult = { key: string; type: string; label: string; status: 'sent' | 'failed' | 'not_configured' | 'invalid'; http_status: number | null; error: string | null }

const MAX_DESTINATIONS = 10
const SEND_TIMEOUT_MS = 5000
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/

function decodeConfig(raw: string): unknown {
  const s = raw.trim()
  if (s.startsWith('[') || s.startsWith('{')) return JSON.parse(s)
  // シェルで JSON の引用符を書きにくいときのため、base64 にした JSON も受け付ける
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), ch => ch.charCodeAt(0))))
}

/** 送り先の一覧。source: none（登録なし）/ set / invalid（ALERT_DESTINATIONS を読めない）。値は画面に出さない */
export async function loadDestinations(env: Partial<AlertEnv>): Promise<{ source: 'none' | 'set' | 'invalid'; list: Destination[] }> {
  const raw = String(env?.ALERT_DESTINATIONS ?? '').trim()
  const legacy = String(env?.ALERT_WEBHOOK_URL ?? '').trim()
  let items: any[] = []
  let source: 'none' | 'set' | 'invalid' = 'none'
  if (raw) {
    try {
      const v = decodeConfig(raw)
      items = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []
      source = Array.isArray(v) || (v && typeof v === 'object') ? 'set' : 'invalid'
    } catch { source = 'invalid' }
  }
  if (legacy) { items = [...items, { type: 'webhook', url: legacy, name: 'Webhook（ALERT_WEBHOOK_URL）' }]; if (source === 'none') source = 'set' }
  const allowHttp = env?.TEST_HOOKS === 'true'
  const list: Destination[] = []
  for (const [i, it] of items.slice(0, MAX_DESTINATIONS).entries()) {
    const o = it && typeof it === 'object' ? it : {}
    const type = String(o.type ?? '').trim().toLowerCase()
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    const token = typeof o.token === 'string' ? o.token.trim() : ''
    const to = typeof o.to === 'string' ? o.to.trim() : ''
    const receive = (RECEIVES as readonly string[]).includes(String(o.receive ?? 'all')) ? String(o.receive ?? 'all') as Destination['receive'] : null
    let problem: string | null = null
    if (!(DEST_TYPES as readonly string[]).includes(type)) problem = '種類（type）が正しくありません'
    else if (!receive) problem = '受け取る種類（receive）は all・critical・digest のどれかにしてください'
    else if (type === 'line') {
      if (!token || !to) problem = 'LINE はチャネルのアクセストークン（token）と送る相手の ID（to）が必要です'
      else if (url && !allowHttp) problem = 'LINE には url を書きません'
    } else if (type === 'email') {
      if (!to || !to.split(',').every((a: string) => EMAIL_RE.test(a.trim()))) problem = 'メールの宛先（to）が正しくありません'
    } else {
      let ok = false
      try { const u = new URL(url); ok = u.protocol === 'https:' || (allowHttp && u.protocol === 'http:') } catch { }
      if (!ok) problem = 'Webhook の URL（https://…）が正しくありません'
    }
    const key = (await sha256(`${type}|${url}|${token}|${to}`)).slice(0, 12)
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : `${DEST_TYPE_LABEL[type] || '送り先'} ${i + 1}`
    list.push({ key, index: i, type: type || 'unknown', label: name, receive: receive || 'all', problem, url: url || undefined, token: token || undefined, to: to || undefined })
  }
  return { source, list }
}

/** この送り先が、この通知を受け取るか */
export function receives(d: Pick<Destination, 'receive'>, severity: AlertSeverity): boolean {
  if (severity === 'test') return true
  if (d.receive === 'critical') return severity === 'critical'
  if (d.receive === 'digest') return severity === 'digest'
  return true
}

/** 送る文（どの種類でも同じ中身）。本部画面へのリンクを最後に付ける */
export function alertText(env: Partial<AlertEnv>, ev: AlertEvent): string {
  const lines = [...(ev.lines || [])]
  if (ev.path) lines.push(`場所: ${maskPath(ev.path)}`)
  if (ev.ref) lines.push(`参照番号: ${ev.ref}`)
  if (ev.count != null) lines.push(`件数: ${Number(ev.count)}件`)
  const base = appBaseUrl(env)
  if (base) lines.push(`本部画面: ${base}/hq#errors`)
  return `【Field OS】${ev.title}\n${lines.join('\n')}`.slice(0, 3000)
}

/** 送り先の種類ごとの要求（Incoming Webhook の形・LINE の push・汎用の JSON） */
export function formatRequest(env: Partial<AlertEnv>, d: Destination, ev: AlertEvent): { url: string; init: RequestInit } | null {
  const text = alertText(env, ev)
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    ({ url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) } })
  switch (d.type) {
    case 'slack': return json(d.url!, { text })
    case 'google_chat': return json(d.url!, { text })
    case 'discord': return json(d.url!, { content: text.slice(0, 1900) })
    // Teams の Incoming Webhook（Workflows の Webhook も）は Adaptive Card のメッセージで受け取る
    case 'teams': return json(d.url!, { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
      content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text, wrap: true }] } }] })
    // LINE Notify は終わったので、Messaging API の push で送る（テストのときだけ url で送り先を差し替えられる）
    case 'line': return json(env.TEST_HOOKS === 'true' && d.url ? d.url : LINE_PUSH_URL, { to: d.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }, { Authorization: `Bearer ${d.token}` })
    case 'webhook': return json(d.url!, { source: 'fieldos', event: ev.event, severity: ev.severity, title: ev.title, text,
      ref: ev.ref || null, path: ev.path ? maskPath(ev.path) : null, count: ev.count ?? null, at: nowJST() })
    default: return null
  }
}

const shortError = (e: unknown) => {
  const name = String((e as any)?.name || '')
  return name === 'TimeoutError' || name === 'AbortError' ? '時間内に応答がありませんでした' : '通信できませんでした'
}

async function sendOne(env: AlertEnv, d: Destination, ev: AlertEvent): Promise<DestinationResult> {
  const base = { key: d.key, type: d.type, label: d.label }
  if (d.problem) return { ...base, status: 'invalid', http_status: null, error: d.problem }
  try {
    if (d.type === 'email') {
      if (!canSendMail(env)) return { ...base, status: 'not_configured', http_status: null, error: '未設定（MAIL_ENABLED が true で RESEND_API_KEY があるときだけ送ります）' }
      const text = alertText(env, ev)
      const html = `<pre style="font-family:sans-serif;white-space:pre-wrap">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
      let failed: string | null = null
      for (const to of d.to!.split(',').map(s => s.trim()).filter(Boolean)) {
        const r = await sendEmail(env as unknown as MailEnv, { to, subject: `[Field OS] ${ev.title}`.slice(0, 120), html, text, type: 'error_alert' })
        if (!r.ok) failed = String(r.error || 'failed').slice(0, 100)
      }
      return failed ? { ...base, status: 'failed', http_status: null, error: `メールを送れませんでした（${failed}）` } : { ...base, status: 'sent', http_status: null, error: null }
    }
    const req = formatRequest(env, d, ev)
    if (!req) return { ...base, status: 'invalid', http_status: null, error: '種類（type）が正しくありません' }
    const signal = typeof AbortSignal !== 'undefined' && (AbortSignal as any).timeout ? (AbortSignal as any).timeout(SEND_TIMEOUT_MS) : undefined
    const res = await fetch(req.url, { ...req.init, ...(signal ? { signal } : {}) })
    // 応答の本文は読まない（送り先によっては URL・トークンの一部を返すことがあるため、記録にも残さない）
    try { await res.body?.cancel() } catch { }
    return res.ok ? { ...base, status: 'sent', http_status: res.status, error: null } : { ...base, status: 'failed', http_status: res.status, error: `送り先が受け付けませんでした（HTTP ${res.status}）` }
  } catch (e) {
    return { ...base, status: 'failed', http_status: null, error: shortError(e) }
  }
}

/**
 * 送り先へ送る（受け取る種類が合うものだけ。only を渡すとその送り先だけ）。並べて送り、1つの失敗はほかに影響させない。
 * 結果は alert_destination_status に残す。例外は投げない。送り先が無ければ問い合わせもしない
 */
export async function sendAlert(env: AlertEnv, ev: AlertEvent, opts: { only?: string } = {}): Promise<DestinationResult[]> {
  try {
    const { list } = await loadDestinations(env)
    const targets = list.filter(d => (opts.only ? d.key === opts.only : receives(d, ev.severity)))
    if (!targets.length) return []
    const settled = await Promise.allSettled(targets.map(d => sendOne(env, d, ev)))
    const results: DestinationResult[] = settled.map((s, i) => s.status === 'fulfilled' ? s.value
      : { key: targets[i].key, type: targets[i].type, label: targets[i].label, status: 'failed', http_status: null, error: '送信の処理に失敗しました' })
    const now = nowJST()
    try {
      await env.DB.batch(results.map(r => env.DB.prepare(`INSERT INTO alert_destination_status (dest_key, dest_type, last_status, last_http_status, last_error, last_event, last_attempt_at, last_success_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dest_key) DO UPDATE SET dest_type = excluded.dest_type, last_status = excluded.last_status, last_http_status = excluded.last_http_status,
            last_error = excluded.last_error, last_event = excluded.last_event, last_attempt_at = excluded.last_attempt_at,
            last_success_at = COALESCE(excluded.last_success_at, alert_destination_status.last_success_at), updated_at = excluded.updated_at`)
        .bind(r.key, r.type, r.status, r.http_status, r.error, ev.event, now, r.status === 'sent' ? now : null, now)))
    } catch (e) { console.log(`alert status save failed: ${e}`) }
    // Workers Logs には種類と結果だけを残す（URL・トークン・宛先は出さない）
    console.log(JSON.stringify({ level: results.some(r => r.status === 'failed') ? 'warn' : 'info', event: 'alert_sent', alert: ev.event, severity: ev.severity,
      results: results.map(r => ({ key: r.key, type: r.type, status: r.status, http_status: r.http_status })) }))
    return results
  } catch (e) {
    console.log(`alert send failed: ${String((e as any)?.name || 'Error')}`)
    return []
  }
}

/**
 * 同じ通知を続けて出さないための判定（1文で判定と記録をする。同時に来ても通知を出すのは1つだけ）。
 * claimed: 今回は知らせる / pending: 今回の通知と一緒に知らせる、前回の通知の後に知らせなかった件数
 */
export async function claimAlert(db: D1Database, key: string, cooldownMinutes: number): Promise<{ claimed: boolean; pending: number }> {
  const now = nowJST(), since = nowJST(-cooldownMinutes * 60000)
  const token = crypto.randomUUID()
  const row = await db.prepare(`INSERT INTO alert_cooldowns (alert_key, last_sent_at, pending, last_pending, claim_token, updated_at) VALUES (?, ?, 0, 0, ?, ?)
    ON CONFLICT(alert_key) DO UPDATE SET
      last_pending = CASE WHEN alert_cooldowns.last_sent_at <= ? THEN alert_cooldowns.pending ELSE alert_cooldowns.last_pending END,
      pending = CASE WHEN alert_cooldowns.last_sent_at <= ? THEN 0 ELSE alert_cooldowns.pending + 1 END,
      claim_token = CASE WHEN alert_cooldowns.last_sent_at <= ? THEN excluded.claim_token ELSE alert_cooldowns.claim_token END,
      last_sent_at = CASE WHEN alert_cooldowns.last_sent_at <= ? THEN excluded.last_sent_at ELSE alert_cooldowns.last_sent_at END,
      updated_at = excluded.updated_at
    RETURNING claim_token, last_pending`).bind(key, now, token, now, since, since, since, since).first() as any
  return { claimed: row?.claim_token === token, pending: row?.claim_token === token ? Number(row?.last_pending) || 0 : 0 }
}

/**
 * 本部の管理者全員へのアプリ内の通知（プッシュも。kind は障害の通知と同じ error_alert）と、送り先への送信。例外は投げない。
 * notified が 1 以上なら、呼び出し側で flushPushQueue を呼ぶとプッシュがすぐに届く
 */
export async function notifyHq(env: AlertEnv, ev: AlertEvent, body: string): Promise<{ notified: number; results: DestinationResult[] }> {
  let notified = 0
  try {
    // user_notifications にはプッシュのトリガーがあるので、件数は RETURNING で数える
    const rows = (await env.DB.prepare(`INSERT INTO user_notifications (company_id, user_id, kind, title, body, link, related_id, created_at)
      SELECT company_id, user_id, ?, ?, ?, '#errors', NULL, ? FROM users WHERE role = 'system_admin' AND COALESCE(status, 'active') = 'active'
      RETURNING notification_id`).bind(ERROR_ALERT_KIND, ev.title.slice(0, 200), body.slice(0, 1000), nowJST()).all()).results || []
    notified = rows.length
  } catch (e) { console.log(`hq notification failed: ${e}`) }
  const results = await sendAlert(env, ev)
  return { notified, results }
}

/** エラーの急増（直近10分に10件以上など。src/lib/error-log.ts の checkErrorAlert）を送り先へ。アプリ内の通知は checkErrorAlert が作る */
export function sendErrorThresholdAlert(env: AlertEnv, a: { count: number; windowMinutes: number; threshold: number; cooldownMinutes: number; title: string }) {
  return sendAlert(env, { event: 'error_threshold', severity: 'critical', title: a.title, count: a.count,
    lines: [`サーバーの予期しないエラー・定期処理の失敗が、直近${a.windowMinutes}分に${a.count}件ありました（通知の目安: ${a.threshold}件）。`, `次の同じ通知は${a.cooldownMinutes}分後以降です。`] })
}

// ---------- 打刻・日報の送信の失敗（5xx）を1件目から知らせる ----------
export const CRITICAL_PLACES: Record<string, { key: string; label: string }> = {
  '/api/staff/attendance': { key: 'punch', label: '打刻' },
  '/api/staff/attendance-photo': { key: 'punch', label: '打刻' },
  '/api/staff/daily-report': { key: 'daily_report', label: '日報の送信' },
}
/** 打刻・日報の送信が 5xx で失敗したとき。同じ場所の通知は cooldown 分に1回まで（その間の件数は次の通知で知らせる） */
export async function notifyCriticalFailure(env: AlertEnv, f: { path: string; status: number; ref: string | null; cooldownMinutes: number }): Promise<{ notified: number; sent: boolean }> {
  const place = CRITICAL_PLACES[f.path]
  if (!place) return { notified: 0, sent: false }
  try {
    const c = await claimAlert(env.DB, `critical:${place.key}`, f.cooldownMinutes)
    if (!c.claimed) return { notified: 0, sent: false }
    const why = f.status === 503 ? '混雑（D1 の過負荷）で受け付けられませんでした' : 'サーバーの予期しないエラーで失敗しました'
    const title = `${place.label}が失敗しました（応答 ${f.status}）`
    const more = c.pending ? `前回の通知の後に、ほかに${c.pending}件の失敗がありました。` : ''
    const lines = [`${place.label}が${why}。${more}`, `次の同じ通知は${f.cooldownMinutes}分後以降です。`]
    const body = `${lines.join('')}${f.ref ? `参照番号: ${f.ref}。` : ''}本部画面の「障害」で内容を確認してください。`
    const r = await notifyHq(env, { event: 'critical_failure', severity: 'critical', title, lines, ref: f.ref, path: f.path, count: 1 + c.pending }, body)
    return { notified: r.notified, sent: true }
  } catch (e) {
    console.log(`critical alert failed: ${String((e as any)?.name || 'Error')}`)
    return { notified: 0, sent: false }
  }
}

/** 定期処理の失敗。同じ処理の通知は cooldown 分に1回まで */
export async function notifyCronFailure(env: AlertEnv, f: { job: string; label: string; ref: string; cooldownMinutes: number }): Promise<{ notified: number }> {
  try {
    const c = await claimAlert(env.DB, `cron:${f.job}`, f.cooldownMinutes)
    if (!c.claimed) return { notified: 0 }
    const title = `定期処理「${f.label}」が失敗しました`
    const lines = [`定期処理「${f.label}」（${f.job}）が失敗しました。${c.pending ? `前回の通知の後に、ほかに${c.pending}回失敗しています。` : ''}`]
    const r = await notifyHq(env, { event: 'cron_failed', severity: 'normal', title, lines, ref: f.ref, path: `cron/${f.job}`, count: 1 + c.pending },
      `${lines[0]}参照番号: ${f.ref}。本部画面の「障害」と「データ保持・定期処理」で内容を確認してください。`)
    return { notified: r.notified }
  } catch (e) {
    console.log(`cron alert failed: ${String((e as any)?.name || 'Error')}`)
    return { notified: 0 }
  }
}
