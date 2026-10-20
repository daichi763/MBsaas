import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import api, { generateFiscalYearReportsForAllCompanies, purgeOldNoticeReads, publishDueNotices } from './api'
import { runRetentionCleanup, applyDueRetirements, purgeExpiredTokens, runInServiceRetentionJob } from './services/retention'
import { purgeOldApplications } from './recruit'
import { applyDueAffiliationSchedules } from './staff-lifecycle'
import { loadSessionUser, homePathFor, purgeExpiredAuthRows, SESSION_COOKIE } from './lib/auth'
import { runCronJobs, defineCronJobs } from './services/cron'
import { handleResendWebhook, type MailEnv } from './services/email'
import { runReminders } from './services/reminders'
import { loadHqView, HQ_VIEW_COOKIE } from './hq-support'
import { flushPushQueue, runPushQueueJob, runNotificationDigests } from './notifications'

type Bindings = { DB: D1Database; PHOTOS: R2Bucket; DOCUMENTS: R2Bucket; RETENTION_ENABLED?: string; DEMO_MODE?: string }

const app = new Hono<{ Bindings: Bindings }>()

// ============ 画面の応答に付けるセキュリティヘッダー（#202） ============
// 外部のスクリプト・スタイルは jsDelivr（バージョン固定・SRI 付き）と、募集ページの Turnstile だけを許す。
// 画面に onclick などのイベント属性とインラインの script が残っているため、script-src の 'unsafe-inline' は外せない
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  'frame-src https://challenges.cloudflare.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')
app.use('*', async (c, next) => {
  await next()
  try {
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    if ((c.res.headers.get('Content-Type') || '').startsWith('text/html')) c.res.headers.set('Content-Security-Policy', CSP)
  } catch { /* 変更できない応答（外部から取得したものなど）はそのまま返す */ }
})

// ============ 予期しないエラーの記録（#230） ============
// Workers Logs（wrangler.jsonc の observability）に、どの API で・誰の操作で起きたかを1行の JSON で残す。
// 利用者には参照番号を返し、問い合わせのときにログと突き合わせられるようにする。
// パスに入る報告用URL・募集ページ・再設定のトークンは記録しない
const maskPath = (p: string) => p.replace(/[A-Za-z0-9_-]{20,}/g, '***')
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  const ref = crypto.randomUUID().slice(0, 8)
  const u = (c as any).get('user')
  console.error(JSON.stringify({
    level: 'error', event: 'unhandled_error', ref, method: c.req.method, path: maskPath(c.req.path),
    company_id: u?.company_id ?? null, user_id: u?.user_id ?? null, role: u?.role ?? null,
    message: String((err as any)?.message || err), stack: String((err as any)?.stack || '').split('\n').slice(0, 6).join('\n'),
  }))
  const at = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const msg = `処理に失敗しました。時間をおいてもう一度お試しください（${at} 参照番号: ${ref}）`
  if (c.req.path.startsWith('/api/')) return c.json({ error: msg, ref }, 500)
  return c.html(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>エラー | Field OS</title></head>
<body style="font-family:sans-serif;padding:24px"><p>${msg}</p><p><a href="/">トップへ戻る</a></p></body></html>`, 500)
})

// ============ プッシュ通知の送信（#178） ============
// API の書き込み（GET 以外）の応答の後に、積まれたプッシュ（push_queue。アプリ内の通知が入るとトリガーで積まれる）を送る。
// 積まれていなければ問い合わせ1回で終わる。送れなかった分は15分おきの cron（push_queue）で送る
app.use('/api/*', async (c, next) => {
  await next()
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return
  try { c.executionCtx.waitUntil(flushPushQueue(c.env as any).catch(e => console.log(`push flush failed: ${e}`))) } catch { /* waitUntil が使えないとき（テストなど）は cron に任せる */ }
})

app.route('/api', api)

// ============ Service Worker（スタッフ画面のプッシュ通知の表示。#178） ============
// プッシュには本文を載せないので、受けたら /api/staff/push/latest から最新の未読を取りに来て表示する。
// 取れないとき（ログインの期限切れ・別の人のログインなど）は、中身を出さない決まった文面にする。画面やデータの保存（オフライン）はしない
const SERVICE_WORKER_JS = `'use strict'
self.addEventListener('install', function () { self.skipWaiting() })
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()) })
self.addEventListener('push', function (e) { e.waitUntil(showLatest()) })
async function showLatest() {
  var n = { title: 'Field OS', body: '新しい通知があります。アプリを開いて確認してください', link: '/staff#notifications', tag: 'fieldos' }
  try {
    var sub = await self.registration.pushManager.getSubscription()
    var r = await fetch('/api/staff/push/latest?endpoint=' + encodeURIComponent(sub ? sub.endpoint : ''), { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Background': '1' } })
    if (r.ok) { var d = await r.json(); if (d && d.title) n = { title: String(d.title), body: String(d.body || ''), link: String(d.link || n.link), tag: String(d.tag || n.tag) } }
  } catch (err) { }
  if (!/^\\/staff(#[^\\s]*)?$/.test(n.link)) n.link = '/staff#notifications'
  return self.registration.showNotification(n.title, { body: n.body, tag: n.tag, renotify: true, icon: '/static/icon-192.png', badge: '/static/icon-192.png', data: { link: n.link } })
}
self.addEventListener('notificationclick', function (e) {
  e.notification.close()
  var link = (e.notification.data && e.notification.data.link) || '/staff#notifications'
  e.waitUntil((async function () {
    var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (var i = 0; i < list.length; i++) {
      var c = list[i]
      if (new URL(c.url).pathname === '/staff') { c.postMessage({ type: 'fos-open', hash: link.slice(6) }); return c.focus() }
    }
    return self.clients.openWindow(link)
  })())
})
`
app.get('/sw.js', (c) => c.body(SERVICE_WORKER_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }))

// ============ Resend の Webhook（不達・迷惑メールの報告・配信済み。#541） ============
// ログイン不要。署名（RESEND_WEBHOOK_SECRET。wrangler secret で登録する）を確かめてから送信の記録を更新する（src/services/email.ts）
app.post('/webhooks/resend', (c) => handleResendWebhook(c.env as unknown as MailEnv, c.req.raw))

// ============ 共通レイアウト ============
// CDN のファイルはバージョンを固定し、integrity（SRI）を付ける。版を上げるときはハッシュも計算し直す
//   計算: curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A
const CDN = 'https://cdn.jsdelivr.net/npm/'
const SRI: Record<string, string> = {
  '@fortawesome/fontawesome-free@6.4.0/css/all.min.css': 'sha384-iw3OoTErCYJJB9mCa8LNS2hbsQ7M3C0EpIsO/H5+EGAkPGc6rk+V8i04oW/K5xq0',
  'axios@1.6.0/dist/axios.min.js': 'sha384-VekiXfVDZuqx75T/YaGfn7/p6+e+D0f/G8UoZ5GBOCMZ89kMW4wTo8PSn6GSzOEl',
  'dayjs@1.11.10/dayjs.min.js': 'sha384-DpVxUeeBWjUvUV1czyIHJAjh+jYUZFu2lLakbdua5vbwOrBGi1UgaKCHjTC+x3Ky',
  'chart.js@4.5.1/dist/chart.umd.min.js': 'sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ',
  'flatpickr@4.6.13/dist/flatpickr.min.css': 'sha384-RkASv+6KfBMW9eknReJIJ6b3UnjKOKC5bOUaNgIY778NFbQ8MtWq9Lr/khUgqtTt',
  'flatpickr@4.6.13/dist/plugins/monthSelect/style.css': 'sha384-iENKmnGeeAGTWfH/ajxq1dMSwLjASdk1v+taA112fikKow0tdV9cbUJcAiBEfHhG',
  'flatpickr@4.6.13/dist/flatpickr.min.js': 'sha384-5JqMv4L/Xa0hfvtF06qboNdhvuYXUku9ZrhZh3bSk8VXF0A/RuSLHpLsSV9Zqhl6',
  'flatpickr@4.6.13/dist/l10n/ja.js': 'sha384-mKor8U8jwukUkfxaFPCsxKF9S62PXq4gG7zcZ5yQ2x3KL1msprJZeFlKFEDeeb5V',
  'flatpickr@4.6.13/dist/plugins/monthSelect/index.js': 'sha384-6p33UqcS/7ZxiJzlAi3gfOsrVSlBlFNr/6gfN12AC0ETbTmPgMGSfHuN+H0QcWoO',
  'qrcode-generator@1.4.4/qrcode.min.js': 'sha384-lQXOAyZwHXE55JFyrOMB7nY2Wv+m5ZWNtJcHrd1rceRQXAYNLak8ukN5TjBTcIwz',
  'jsqr@1.4.0/dist/jsQR.min.js': 'sha384-hStSInNIZ8ljtOVrmrgf7zdHMapaLBWoSnPTtF0nzsybp4+LuhDz6sHuEVpWIX8o',
  'sortablejs@1.15.2/Sortable.min.js': 'sha384-BSxuMLxX+FCbTdYec3TbXlnMGEEM2QXTFdtDaveen71o+jswm2J36+xFqp8k4VHM',
}
const cdnJs = (p: string) => `<script src="${CDN}${p}" integrity="${SRI[p]}" crossorigin="anonymous"></script>`
const cdnCss = (p: string) => `<link href="${CDN}${p}" rel="stylesheet" integrity="${SRI[p]}" crossorigin="anonymous">`
// CDN の axios・dayjs を読み込めなかったとき（店舗の Wi-Fi のフィルタ・CDN の障害など）は、白い画面のままにせず理由を出す（#409）
const LIB_FALLBACK = `<script>if(!window.axios||!window.dayjs){window.__LIB_MISSING=true;document.addEventListener('DOMContentLoaded',function(){var d=document.createElement('div');d.setAttribute('role','alert');d.style.cssText='margin:16px;padding:16px;border:1px solid #fca5a5;background:#fef2f2;color:#991b1b;border-radius:12px;font-size:14px;line-height:1.6';d.textContent='画面の部品を読み込めませんでした。電波の良い場所で、ページを再読み込みしてください。店舗のWi-Fiでは開けない場合があります（モバイルデータ通信でお試しください）。';document.body.insertBefore(d,document.body.firstChild)})}</script>`
const head = (title: string) => `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Field OS</title>
  ${cdnCss('@fortawesome/fontawesome-free@6.4.0/css/all.min.css')}
  ${cdnJs('axios@1.6.0/dist/axios.min.js')}
  ${cdnJs('dayjs@1.11.10/dayjs.min.js')}
  ${LIB_FALLBACK}
  <script src="/static/common.js"></script>
  <link href="/static/style.css" rel="stylesheet">
`

// API の認証ミドルウェアと同じ判定（期限・退職・停止中の企業）で、ログイン中の利用者を返す
async function currentUser(c: any) {
  const r = await loadSessionUser(c.env.DB, getCookie(c, SESSION_COOKIE))
  return r.ok ? r.user : null
}

// ルート: ロール別リダイレクト
app.get('/', async (c) => {
  const u = await currentUser(c)
  if (!u) return c.redirect('/login')
  return c.redirect(homePathFor(u.role))
})

// ============ ログイン画面 ============
// ホーム画面に追加したときのアイコン・名前（public/manifest.webmanifest。#308）。報告用URL・募集ページには付けない（追加すると起動先がログインになるため）
const APP_META = `
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#2563eb">
  <meta name="apple-mobile-web-app-title" content="Field OS">
  <link rel="apple-touch-icon" href="/static/icon-180.png">`
// 未ログインで開いたときは、ログインの後に元の画面へ戻れるよう、元のパスを next に付ける。
// ハッシュ（#attendance など）はサーバーに届かないが、ブラウザがリダイレクト先に引き継ぐのでログイン画面の JS で付け直す（#206）
const toLogin = (c: any) => c.redirect('/login?next=' + encodeURIComponent(new URL(c.req.url).pathname))
// 入力欄の共通のクラス
const LOGIN_INPUT = 'w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-base'

// ログイン済みならホームへ移す（入力し直しと、不要なセッションの増加を防ぐ）
app.get('/login', async (c) => {
  const u = await currentUser(c)
  if (u) return c.redirect(homePathFor(u.role))
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('ログイン')}${APP_META}</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
  <main class="w-full max-w-sm">
    <header class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white text-2xl mb-3 shadow-lg shadow-blue-200">
        <i class="fas fa-tower-cell"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">Field OS</h1>
      <p class="text-sm text-gray-500 mt-1">通信人材会社向け 運営標準化SaaS</p>
    </header>
    <section id="login-card" class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <form id="login-form" class="space-y-4" novalidate>
        <div>
          <label for="company_code" class="block text-sm font-medium text-gray-600 mb-1">会社コード</label>
          <!-- 会社名の自動入力・先頭の大文字化・自動修正をさせない（#201） -->
          <input id="company_code" type="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" class="${LOGIN_INPUT}" placeholder="所属の会社から案内されたコード">
          <p class="text-[11px] text-gray-400 mt-1">本部の方は空欄のままログインできます</p>
        </div>
        <div>
          <label for="user_code" class="block text-sm font-medium text-gray-600 mb-1">スタッフ番号 / ユーザーID</label>
          <input id="user_code" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" class="${LOGIN_INPUT}" placeholder="スタッフ番号またはID" required>
        </div>
        <div>
          <label for="password" class="block text-sm font-medium text-gray-600 mb-1">パスワード</label>
          <div class="relative">
            <input id="password" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" class="${LOGIN_INPUT} pr-12" required>
            <button type="button" id="pw-toggle" class="absolute inset-y-0 right-0 px-4 text-gray-400 hover:text-gray-600" aria-label="パスワードを表示" aria-pressed="false"><i class="fas fa-eye"></i></button>
          </div>
        </div>
        <label class="flex items-center gap-2 text-xs text-gray-500"><input type="checkbox" id="remember" checked>この端末に会社コードとIDを記憶する（共用の端末では外してください）</label>
        <p id="login-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" role="alert"></p>
        <button type="submit" id="login-btn" class="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">
          ログイン
        </button>
        <p class="text-center"><button type="button" id="forgot-link" class="text-sm text-blue-600 hover:underline">パスワードを忘れた方はこちら</button></p>
        <p class="text-xs text-gray-400 text-center">ログインできない場合やメールが届かない場合は、所属の会社の担当者にお問い合わせください。</p>
      </form>

      <!-- 二段階認証（#544）: パスワードの後で、認証アプリの6桁（または予備コード）を確かめる -->
      <form id="mfa-form" class="space-y-4 hidden" novalidate>
        <p class="text-sm text-gray-600"><i class="fas fa-shield-halved text-blue-600 mr-1"></i>認証アプリ（Google Authenticator など）に表示されている6桁の確認コードを入力してください。</p>
        <div>
          <label for="mfa-code" class="block text-sm font-medium text-gray-600 mb-1">確認コード</label>
          <input id="mfa-code" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="20" class="${LOGIN_INPUT} tracking-widest" placeholder="123456">
          <p class="text-[11px] text-gray-400 mt-1">スマホを失くしたなどで認証アプリを使えないときは、登録のときに控えた予備コード（xxxxx-xxxxx）を入力できます。</p>
        </div>
        <p id="mfa-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" role="alert"></p>
        <button type="submit" id="mfa-btn" class="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">確認してログイン</button>
        <p class="text-center"><button type="button" id="mfa-back" class="text-sm text-gray-500 hover:underline">最初からやり直す</button></p>
      </form>

      <form id="forgot-form" class="space-y-4 hidden">
        <p class="text-sm text-gray-500">登録済みのメールアドレスを入力してください。パスワード再設定用のリンクと、ログインに使う会社コード・IDをお送りします。</p>
        <p class="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">メールアドレスを登録していない方は、所属の会社の担当者にパスワードの再発行を依頼してください（仮パスワードが発行されます）。</p>
        <div>
          <label for="forgot-email" class="block text-sm font-medium text-gray-600 mb-1">メールアドレス</label>
          <input id="forgot-email" type="email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" class="${LOGIN_INPUT}" required>
        </div>
        <p id="forgot-message" class="hidden text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2"></p>
        <button type="submit" id="forgot-btn" class="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">
          送信する
        </button>
        <p class="text-center"><button type="button" id="back-to-login-link" class="text-sm text-gray-500 hover:underline">ログインに戻る</button></p>
      </form>
    </section>
    ${c.env.DEMO_MODE === 'true' ? `<aside id="demo-account-aside" class="mt-6 bg-blue-50 rounded-xl p-4 text-xs text-blue-900 leading-relaxed">
      <p class="font-bold mb-1"><i class="fas fa-circle-info mr-1"></i>デモアカウント（パスワードは全て pass1234）</p>
      <ul class="space-y-0.5">
        <li>スタッフ: 会社コード <b>sample</b> / ID <b>st001</b>（〜st020）</li>
        <li>管理者: 会社コード <b>sample</b> / ID <b>admin</b> または <b>mgr01</b></li>
        <li>SaaS本部: 会社コード <b>空欄</b> / ID <b>hq</b></li>
      </ul>
    </aside>` : ''}
  </main>
  <script>
    // 会社コード・ID の全角は、サーバーが半角にそろえて照合する（#387）
    const norm = (v) => String(v || '').normalize('NFKC').trim()
    const params = new URLSearchParams(location.search)
    const cc = document.getElementById('company_code'), uc = document.getElementById('user_code'), pw = document.getElementById('password')
    const remember = document.getElementById('remember')
    // 前回ログインした会社コードと ID（この端末だけに保存。#308）。/login?c=会社コード&u=ID の指定があればそちらを使う
    const STORE_KEY = 'fieldos.login'
    let saved = {}
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {} } catch (e) { saved = {} }
    const qc = params.get('c'), qu = params.get('u')
    cc.value = qc !== null ? qc : (saved.c || '')
    uc.value = qu !== null ? qu : (qc === null || qc === saved.c ? (saved.u || '') : '')
    ;(cc.value && uc.value ? pw : cc.value ? uc : cc).focus()

    // ログインの後に戻る先（#206）。ログインした人のホームと同じ画面のときだけ使う（別のサイトや別のロールの画面へは移らない）
    function nextUrl(home) {
      const n = params.get('next')
      if (!n || n.charAt(0) !== '/' || n.charAt(1) === '/' || n.charAt(1) === '\\\\') return home
      try {
        const url = new URL(n, location.origin)
        if (url.origin !== location.origin || url.pathname !== home) return home
        return url.pathname + url.search + (url.hash || location.hash || '')
      } catch (e) { return home }
    }

    document.getElementById('pw-toggle').addEventListener('click', (e) => {
      const show = pw.type === 'password'
      pw.type = show ? 'text' : 'password'
      const btn = e.currentTarget
      btn.setAttribute('aria-pressed', show ? 'true' : 'false')
      btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示')
      btn.innerHTML = show ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>'
    })

    // 通信の失敗・時間切れと、ID・パスワードの誤りを分けて伝える（#561）
    const TIMEOUT_MS = 15000
    const OFFLINE_MSG = '通信できませんでした。電波の良い場所で、もう一度お試しください'
    function loginErrorMessage(e2) {
      if (!e2.response) {
        if (e2.code === 'ECONNABORTED' || e2.code === 'ETIMEDOUT') return '通信に時間がかかっています。電波の良い場所で、もう一度お試しください'
        return OFFLINE_MSG
      }
      if (e2.response.status >= 500) return 'サーバーで問題が起きました。少し時間をおいて、もう一度お試しください'
      return (e2.response.data && e2.response.data.error) || 'ログインに失敗しました'
    }
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = document.getElementById('login-btn')
      const err = document.getElementById('login-error')
      const showErr = (msg) => { err.textContent = msg; err.classList.remove('hidden') }
      err.classList.add('hidden')
      // 送るのは入力どおり（trim のみ）。サーバーが全角・大文字小文字をそろえて照合し、以前に全角のまま登録した ID も入力どおりで照合する
      cc.value = cc.value.trim(); uc.value = uc.value.trim()
      if (!norm(uc.value) || !pw.value) return showErr('スタッフ番号（ID）とパスワードを入力してください')
      if (navigator.onLine === false) return showErr(OFFLINE_MSG)
      btn.disabled = true; btn.textContent = 'ログイン中...'
      const body = { company_code: cc.value, user_code: uc.value, password: pw.value }
      try {
        let res
        try { res = await axios.post('/api/auth/login', body, { timeout: TIMEOUT_MS }) }
        catch (e4) {
          // このブラウザで別の人がログイン中なら、切り替えてよいかを確かめる（#346）
          const d = e4.response && e4.response.data
          if (!(e4.response && e4.response.status === 409 && d && d.code === 'already_logged_in')) throw e4
          if (!confirm(d.error)) { btn.disabled = false; btn.textContent = 'ログイン'; return }
          res = await axios.post('/api/auth/login', Object.assign({ confirm_switch: true }, body), { timeout: TIMEOUT_MS })
        }
        if (res.data.mfa_required) { showMfa(res.data.mfa_token); btn.disabled = false; btn.textContent = 'ログイン'; return }
        finishLogin(res.data)
      } catch (e2) {
        showErr(loginErrorMessage(e2))
        btn.disabled = false; btn.textContent = 'ログイン'
      }
    })
    function finishLogin(data) {
      try {
        if (remember.checked) localStorage.setItem(STORE_KEY, JSON.stringify({ c: data.company_code || '', u: data.user_code || uc.value }))
        else localStorage.removeItem(STORE_KEY)
      } catch (e3) { /* 保存できない端末（プライベートブラウズなど）でもログインは続ける */ }
      location.href = nextUrl(data.redirect)
    }
    // 二段階認証（#544）。一時トークンはこの画面の変数だけに持つ（5分で期限切れ）
    let mfaToken = null
    const mfaForm = document.getElementById('mfa-form'), mfaCode = document.getElementById('mfa-code'), mfaErr = document.getElementById('mfa-error')
    function showMfa(token) {
      mfaToken = token
      document.getElementById('login-form').classList.add('hidden')
      document.getElementById('demo-account-aside')?.classList.add('hidden')
      mfaForm.classList.remove('hidden'); mfaErr.classList.add('hidden'); mfaCode.value = ''; mfaCode.focus()
    }
    function backToLogin(msg) {
      mfaToken = null; pw.value = ''
      mfaForm.classList.add('hidden')
      document.getElementById('login-form').classList.remove('hidden')
      document.getElementById('demo-account-aside')?.classList.remove('hidden')
      const err = document.getElementById('login-error')
      if (msg) { err.textContent = msg; err.classList.remove('hidden') } else err.classList.add('hidden')
      pw.focus()
    }
    document.getElementById('mfa-back').addEventListener('click', () => backToLogin(''))
    mfaForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = document.getElementById('mfa-btn')
      mfaErr.classList.add('hidden')
      const code = norm(mfaCode.value)
      if (!code) { mfaErr.textContent = '確認コードを入力してください'; mfaErr.classList.remove('hidden'); return }
      btn.disabled = true; btn.textContent = '確認中...'
      try {
        const res = await axios.post('/api/auth/login/mfa', { mfa_token: mfaToken, code }, { timeout: TIMEOUT_MS })
        finishLogin(res.data)
      } catch (e2) {
        const d = e2.response && e2.response.data
        if (d && d.code === 'mfa_expired') backToLogin(d.error)
        else { mfaErr.textContent = loginErrorMessage(e2); mfaErr.classList.remove('hidden'); mfaCode.select() }
        btn.disabled = false; btn.textContent = '確認してログイン'
      }
    })
    document.getElementById('forgot-link').addEventListener('click', () => {
      document.getElementById('login-form').classList.add('hidden')
      document.getElementById('forgot-form').classList.remove('hidden')
      document.getElementById('demo-account-aside')?.classList.add('hidden')
    })
    document.getElementById('back-to-login-link').addEventListener('click', () => {
      document.getElementById('forgot-form').classList.add('hidden')
      document.getElementById('login-form').classList.remove('hidden')
      document.getElementById('demo-account-aside')?.classList.remove('hidden')
    })
    document.getElementById('forgot-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = document.getElementById('forgot-btn')
      const msg = document.getElementById('forgot-message')
      btn.disabled = true; btn.textContent = '送信中...'
      try {
        const res = await axios.post('/api/auth/forgot-password', { email: document.getElementById('forgot-email').value.trim() }, { timeout: TIMEOUT_MS })
        msg.textContent = res.data.message
        msg.className = 'text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2'
      } catch (e2) {
        // 通信できなかったときは送れていないので、そのことを伝える（受け付けた場合の応答は、アカウントの有無によらず同じ文言）
        msg.textContent = !e2.response ? OFFLINE_MSG : '登録されているメールアドレスの場合は、パスワード再設定メールを送信しました。数分たっても届かない場合は、所属の会社の担当者にお問い合わせください。'
        msg.className = !e2.response ? 'text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2' : 'text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2'
      }
      btn.disabled = false; btn.textContent = '送信する'
    })
  </script>
</body>
</html>`)
})

// パスワード再設定ページ（メール内リンクからアクセス。トークンはクエリパラメータで受け取る）
app.get('/reset-password', (c) => c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('パスワード再設定')}<meta name="referrer" content="no-referrer"></head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
  <main class="w-full max-w-sm">
    <header class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white text-2xl mb-3 shadow-lg shadow-blue-200">
        <i class="fas fa-key"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">パスワード再設定</h1>
    </header>
    <section id="reset-card" class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
      <form id="reset-form" class="space-y-4">
        <div>
          <label for="new-password" class="block text-sm font-medium text-gray-600 mb-1">新しいパスワード</label>
          <input id="new-password" type="password" autocomplete="new-password" minlength="8" class="${LOGIN_INPUT}" required>
          <p class="text-xs text-gray-400 mt-1">8文字以上で入力してください</p>
        </div>
        <div>
          <label for="new-password-confirm" class="block text-sm font-medium text-gray-600 mb-1">新しいパスワード（確認）</label>
          <input id="new-password-confirm" type="password" autocomplete="new-password" minlength="8" class="${LOGIN_INPUT}" required>
        </div>
        <label class="flex items-center gap-2 text-xs text-gray-500"><input type="checkbox" id="reset-show">パスワードを表示する</label>
        <p id="reset-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" role="alert"></p>
        <button type="submit" id="reset-btn" class="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">
          パスワードを再設定する
        </button>
      </form>
      <div id="reset-success" class="hidden text-center">
        <p class="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-3 mb-3"><i class="fas fa-check-circle mr-1"></i>パスワードを再設定しました。</p>
        <!-- ログインに使う会社コードと ID（#208）。ログイン画面には入力した状態で移る -->
        <dl id="reset-account" class="hidden text-sm text-left bg-gray-50 rounded-lg px-3 py-2 mb-4 space-y-1">
          <div id="reset-company-row" class="flex gap-2"><dt class="w-24 text-gray-500">会社コード</dt><dd id="reset-company" class="font-bold font-mono"></dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-500">ID</dt><dd id="reset-user" class="font-bold font-mono"></dd></div>
        </dl>
        <a id="reset-login-link" href="/login" class="inline-block w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base">ログイン画面へ</a>
      </div>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.search)
    const token = params.get('token')
    document.getElementById('reset-show').addEventListener('change', (e) => {
      for (const id of ['new-password', 'new-password-confirm']) document.getElementById(id).type = e.target.checked ? 'text' : 'password'
    })
    document.getElementById('reset-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const err = document.getElementById('reset-error')
      err.classList.add('hidden')
      const p1 = document.getElementById('new-password').value
      const p2 = document.getElementById('new-password-confirm').value
      if (p1 !== p2) { err.textContent = '入力したパスワードが一致しません'; err.classList.remove('hidden'); return }
      if (!token) { err.textContent = 'リンクが正しくありません。メールのリンクから再度アクセスしてください。'; err.classList.remove('hidden'); return }
      const btn = document.getElementById('reset-btn')
      btn.disabled = true; btn.textContent = '処理中...'
      try {
        const res = await axios.post('/api/auth/reset-password', { token, password: p1 }, { timeout: 15000 })
        const d = res.data || {}
        document.getElementById('reset-form').classList.add('hidden')
        document.getElementById('reset-success').classList.remove('hidden')
        if (d.user_code) {
          document.getElementById('reset-account').classList.remove('hidden')
          document.getElementById('reset-user').textContent = d.user_code
          if (d.company_code) document.getElementById('reset-company').textContent = d.company_code
          else document.getElementById('reset-company-row').classList.add('hidden')
          const q = new URLSearchParams({ c: d.company_code || '', u: d.user_code })
          document.getElementById('reset-login-link').href = '/login?' + q.toString()
        }
      } catch (e2) {
        err.textContent = !e2.response ? '通信できませんでした。電波の良い場所で、もう一度お試しください'
          : (e2.response.data && e2.response.data.error) || '処理に失敗しました'
        err.classList.remove('hidden')
        btn.disabled = false; btn.textContent = 'パスワードを再設定する'
      }
    })
  </script>
</body>
</html>`))

// ログイン用メールアドレスの確認ページ（#207。管理者が登録したアドレスに届いたリンクから開く）。
// メールソフトのリンクの事前読み込みで確認済みにならないよう、ボタンを押したときに確認する
app.get('/verify-email', (c) => c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('メールアドレスの確認')}<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"></head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
  <main class="w-full max-w-sm">
    <header class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white text-2xl mb-3 shadow-lg shadow-blue-200">
        <i class="fas fa-envelope-circle-check"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">メールアドレスの確認</h1>
    </header>
    <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
      <div id="verify-form">
        <p class="text-sm text-gray-600 mb-4">このメールアドレスを、Field OS のログイン用（パスワード再設定・お知らせなどの宛先）として登録します。</p>
        <p id="verify-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3" role="alert"></p>
        <button type="button" id="verify-btn" class="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">確認して登録する</button>
      </div>
      <div id="verify-success" class="hidden text-center">
        <p class="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-3 mb-3"><i class="fas fa-check-circle mr-1"></i><span id="verify-email"></span> を登録しました。</p>
        <a id="verify-login-link" href="/login" class="inline-block w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base">ログイン画面へ</a>
      </div>
    </section>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get('token')
    document.getElementById('verify-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget, err = document.getElementById('verify-error')
      err.classList.add('hidden')
      if (!token) { err.textContent = 'リンクが正しくありません。メールのリンクから開いてください。'; err.classList.remove('hidden'); return }
      btn.disabled = true; btn.textContent = '処理中...'
      try {
        const d = (await axios.post('/api/auth/verify-email', { token }, { timeout: 15000 })).data
        document.getElementById('verify-form').classList.add('hidden')
        document.getElementById('verify-success').classList.remove('hidden')
        document.getElementById('verify-email').textContent = d.email || ''
        document.getElementById('verify-login-link').href = '/login?' + new URLSearchParams({ c: d.company_code || '', u: d.user_code || '' }).toString()
      } catch (e2) {
        err.textContent = !e2.response ? '通信できませんでした。電波の良い場所で、もう一度お試しください' : (e2.response.data && e2.response.data.error) || '確認できませんでした'
        err.classList.remove('hidden')
        btn.disabled = false; btn.textContent = '確認して登録する'
      }
    })
  </script>
</body>
</html>`))

// お知らせメールの「確認しました」（#454。メールのリンクから開く）。
// メールソフトのリンクの事前読み込みで既読にならないよう、ボタンを押したときに既読にする（/api/public/notice-ack）
app.get('/notice-ack', (c) => c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('お知らせの確認')}<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"></head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
  <main class="w-full max-w-sm">
    <header class="text-center mb-6">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white text-2xl mb-3 shadow-lg shadow-blue-200">
        <i class="fas fa-bullhorn"></i>
      </div>
      <h1 class="text-2xl font-bold text-gray-800">お知らせの確認</h1>
    </header>
    <section class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
      <div id="ack-info" class="text-sm text-gray-600">読み込んでいます…</div>
      <p id="ack-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" role="alert"></p>
      <button type="button" id="ack-btn" class="hidden w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">確認しました</button>
      <p id="ack-done" class="hidden text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-3"><i class="fas fa-check-circle mr-1"></i>確認済みにしました。</p>
      <a href="/staff#notices" class="block text-center text-sm text-blue-600 hover:underline">アプリでお知らせを開く</a>
    </section>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get('token') || ''
    const $ = (id) => document.getElementById(id)
    const showError = (msg) => { $('ack-error').textContent = msg; $('ack-error').classList.remove('hidden') }
    const OFFLINE = '通信できませんでした。電波の良い場所で、もう一度お試しください'
    ;(async () => {
      if (!token) { $('ack-info').textContent = ''; showError('リンクが正しくありません。メールのリンクから開いてください。'); return }
      try {
        const d = (await axios.get('/api/public/notice-ack', { params: { token }, timeout: 15000 })).data
        $('ack-info').textContent = ''
        const p1 = document.createElement('p'); p1.className = 'text-xs text-gray-500'; p1.textContent = d.company_name
        const p2 = document.createElement('p'); p2.className = 'font-bold text-gray-800 mt-1'; p2.textContent = d.title
        $('ack-info').append(p1, p2)
        if (d.used) { $('ack-done').classList.remove('hidden'); return }
        if (d.expired) { showError('リンクの有効期限が切れています。アプリでお知らせを開き、「確認しました」を押してください'); return }
        $('ack-btn').classList.remove('hidden')
      } catch (e) {
        $('ack-info').textContent = ''
        showError(!e.response ? OFFLINE : (e.response.data && e.response.data.error) || '読み込めませんでした')
      }
    })()
    $('ack-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      $('ack-error').classList.add('hidden')
      btn.disabled = true; btn.textContent = '処理中...'
      try {
        await axios.post('/api/public/notice-ack', { token }, { timeout: 15000 })
        btn.classList.add('hidden')
        $('ack-done').classList.remove('hidden')
      } catch (e2) {
        showError(!e2.response ? OFFLINE : (e2.response.data && e2.response.data.error) || '確認できませんでした')
        btn.disabled = false; btn.textContent = '確認しました'
      }
    })
  </script>
</body>
</html>`))

// ============ シフト専用の報告用URL（ログイン不要。public/static/report-link.js） ============
app.get('/r/:token', (c) => c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('勤怠・日報の報告')}<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"></head>
<body class="bg-gray-50 min-h-screen">
  <header class="bg-white border-b border-gray-100 sticky top-0 z-20">
    <div class="max-w-lg mx-auto px-4 py-3"><h1 class="font-bold text-gray-800 flex items-center gap-2"><i class="fas fa-tower-cell text-blue-600"></i>勤怠・日報の報告</h1></div>
  </header>
  <main id="app" class="max-w-lg mx-auto px-4 py-4"></main>
  <div id="modal-root"></div>
  <script src="/static/report-link.js"></script>
</body>
</html>`))

// ============ 公開の募集ページ（ログイン不要。/api/public/recruit/:token） ============
app.get('/apply/:token', (c) => c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('スタッフ募集')}<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"></head>
<body class="bg-gray-50 min-h-screen">
  <header class="bg-white border-b border-gray-100 sticky top-0 z-20">
    <div class="max-w-lg mx-auto px-4 py-3"><h1 class="font-bold text-gray-800 flex items-center gap-2" id="apply-header"><i class="fas fa-bullhorn text-blue-600"></i>スタッフ募集</h1></div>
  </header>
  <main id="app" class="max-w-lg mx-auto px-4 py-4 pb-28"></main>
  <div id="modal-root"></div>
  <script src="/static/apply.js"></script>
</body>
</html>`))

// ============ スタッフ画面 (スマホファースト SPA) ============
app.get('/staff', async (c) => {
  const u = await currentUser(c)
  if (!u) return toLogin(c)
  if (u.role !== 'staff') return c.redirect('/')
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('スタッフ')}${APP_META}</head>
<body class="bg-gray-50 min-h-screen pb-20">
  <header id="staff-header" class="bg-white border-b border-gray-100 sticky top-0 z-20">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <h1 class="font-bold text-gray-800 flex items-center gap-2"><i class="fas fa-tower-cell text-blue-600"></i><span id="header-title">ホーム</span></h1>
      <div class="flex items-center gap-3">
        <span id="user-name" class="text-sm text-gray-500"></span>
      </div>
    </div>
  </header>
  <main id="app" class="max-w-lg mx-auto px-4 py-4"></main>
  <nav id="bottom-nav" class="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 z-20">
    <div class="max-w-lg mx-auto grid grid-cols-5 text-center text-xs">
      <a href="#home" class="nav-item py-2.5" data-tab="home"><i class="fas fa-house block text-lg mb-0.5"></i>ホーム</a>
      <a href="#shift" class="nav-item py-2.5" data-tab="shift"><i class="fas fa-calendar-days block text-lg mb-0.5"></i>シフト</a>
      <a href="#report" class="nav-item py-2.5" data-tab="report"><i class="fas fa-pen-to-square block text-lg mb-0.5"></i>日報</a>
      <a href="#perf" class="nav-item py-2.5" data-tab="perf"><i class="fas fa-chart-line block text-lg mb-0.5"></i>実績</a>
      <a href="#more" class="nav-item py-2.5 relative" data-tab="more"><i class="fas fa-bars block text-lg mb-0.5"></i>その他<span id="nav-more-badge" class="hidden absolute top-1 left-1/2 ml-2 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-500 text-white text-[10px] leading-[1.1rem] font-bold" aria-live="polite"></span></a>
    </div>
  </nav>
  <div id="modal-root"></div>
  <script src="/static/staff.js"></script>
  <script src="/static/staff-attendance.js"></script>
  ${cdnJs('qrcode-generator@1.4.4/qrcode.min.js')}
  <script src="/static/staff-profile.js"></script>
</body>
</html>`)
})

// ============ 管理者画面 (PC向け SPA) ============
app.get('/admin', async (c) => {
  const u = await currentUser(c)
  if (!u) return toLogin(c)
  if (u.role === 'staff') return c.redirect('/staff')
  // 本部ユーザーは、企業が許可した期限付きの閲覧（読み取り専用。#293）のときだけ、その企業の管理画面を開ける
  let hqView: any = null
  if (u.role === 'system_admin') {
    const v = await loadHqView(c.env.DB, getCookie(c, HQ_VIEW_COOKIE), u.user_id)
    if (!v) return c.redirect('/hq#support')
    hqView = { company_name: v.company_name, expires_at: v.expires_at }
  }
  // script の中に置くので、< を逃がして </script> で閉じられないようにする
  const hqViewJson = JSON.stringify(hqView).replace(/</g, '\\u003c')
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('管理画面')}
  ${cdnJs('chart.js@4.5.1/dist/chart.umd.min.js')}
  ${cdnCss('flatpickr@4.6.13/dist/flatpickr.min.css')}
  ${cdnCss('flatpickr@4.6.13/dist/plugins/monthSelect/style.css')}
  ${cdnJs('flatpickr@4.6.13/dist/flatpickr.min.js')}
  ${cdnJs('flatpickr@4.6.13/dist/l10n/ja.js')}
  ${cdnJs('flatpickr@4.6.13/dist/plugins/monthSelect/index.js')}
</head>
<body class="bg-gray-50 min-h-screen">
  <div class="flex min-h-screen">
    <aside id="sidebar" class="hidden md:flex flex-col w-60 bg-white border-r border-gray-100 fixed inset-y-0 z-30">
      <div class="px-5 py-5 border-b border-gray-100">
        <h1 class="font-bold text-gray-800 flex items-center gap-2 text-lg"><i class="fas fa-tower-cell text-blue-600"></i>Field OS</h1>
        <p id="company-name" class="text-xs text-gray-400 mt-1 truncate"></p>
      </div>
      <nav class="flex-1 overflow-y-auto py-3 px-3 space-y-0.5 text-sm" id="side-nav">
        <a href="#dashboard" class="side-link" data-tab="dashboard"><i class="fas fa-gauge-high w-5"></i>ダッシュボード</a>
        <a href="#notifications" class="side-link flex items-center" data-tab="notifications"><i class="fas fa-bell w-5"></i>通知<span id="notif-badge" class="hidden ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5"></span></a>
        <a href="#staff" class="side-link" data-tab="staff"><i class="fas fa-users w-5"></i>スタッフマスタ</a>
        <a href="#employees" class="side-link" data-tab="employees"><i class="fas fa-id-card w-5"></i>従業員管理</a>
        <a href="#projects" class="side-link" data-tab="projects"><i class="fas fa-briefcase w-5"></i>案件管理</a>
        <a href="#clients" class="side-link" data-tab="clients"><i class="fas fa-building w-5"></i>クライアント</a>
        <a href="#shifts" class="side-link" data-tab="shifts"><i class="fas fa-calendar-days w-5"></i>シフト管理</a>
        <a href="#reports" class="side-link" data-tab="reports"><i class="fas fa-file-lines w-5"></i>日報一覧</a>
        <p class="px-3 pt-3 pb-1 text-[11px] font-bold text-gray-400">勤怠管理</p>
        <a href="#report-settings" class="side-link" data-tab="report-settings"><i class="fas fa-list-check w-5"></i>案件報告管理</a>
        <a href="#corrections" class="side-link flex items-center" data-tab="corrections"><i class="fas fa-user-clock w-5"></i>打刻修正承認<span id="corrections-badge" class="hidden ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5"></span></a>
        <a href="#attendance-history" class="side-link" data-tab="attendance-history"><i class="fas fa-clock-rotate-left w-5"></i>履歴・CSV</a>
        <div class="border-t border-gray-100 my-2"></div>
        <a href="#analytics" class="side-link" data-tab="analytics"><i class="fas fa-chart-column w-5"></i>実績分析</a>
        <a href="#notices" class="side-link" data-tab="notices"><i class="fas fa-bullhorn w-5"></i>お知らせ配信</a>
        <a href="#notice-reports" class="side-link" data-tab="notice-reports"><i class="fas fa-chart-pie w-5"></i>既読率レポート</a>
        <a href="#follow" class="side-link" data-tab="follow"><i class="fas fa-handshake-angle w-5"></i>フォロー履歴</a>
        <a href="#consult" class="side-link" data-tab="consult"><i class="fas fa-comments w-5"></i>相談対応</a>
        <a href="#board" class="side-link flex items-center" data-tab="board"><i class="fas fa-clipboard-list w-5"></i>案件掲示板<span id="board-badge" class="hidden ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5"></span></a>
        <a href="#roster-chat" class="side-link flex items-center" data-tab="roster-chat"><i class="fas fa-people-arrows w-5"></i>企業間チャット</a>
        <a href="#recruit" class="side-link flex items-center" data-tab="recruit"><i class="fas fa-bullhorn w-5"></i>募集・応募<span id="recruit-badge" class="hidden ml-auto text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5"></span></a>
        <a href="#settlement" class="side-link" data-tab="settlement"><i class="fas fa-scale-balanced w-5"></i>精算（請求・支払）</a>
        <a href="#billing" class="side-link" data-tab="billing"><i class="fas fa-file-invoice-yen w-5"></i>請求前確認</a>
      </nav>
      <div class="p-3 border-t border-gray-100">
        <button type="button" class="w-full text-left px-3 py-2 rounded-lg text-sm text-blue-700 bg-blue-50 hover:bg-blue-100" data-action="hqsOpenSupport">
          <i class="fas fa-hands-holding-circle mr-1"></i>伴走支援を依頼する
        </button>
        <a href="#account" class="side-link mt-1" data-tab="account"><i class="fas fa-user-gear w-5"></i>アカウント設定</a>
        <a href="#security" class="side-link" data-tab="security"><i class="fas fa-shield-halved w-5"></i>セキュリティ</a>
        <button id="logout-btn" class="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 mt-1"><i class="fas fa-right-from-bracket mr-1"></i>ログアウト</button>
      </div>
    </aside>
    <div class="flex-1 md:ml-60 min-w-0">
      <!-- スマホ用のヘッダー（#236）: 会社名・氏名、未対応の件数の合計（メニューの各項目にも件数を出す）、ログアウト -->
      <header class="md:hidden bg-white border-b border-gray-100 sticky top-0 z-20 px-4 py-2 flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <h1 class="font-bold text-gray-800 truncate"><i class="fas fa-tower-cell text-blue-600 mr-1"></i>Field OS 管理<span id="mobile-todo-badge" class="hidden ml-1 align-middle text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5" title="未対応の件数（打刻修正・応募・掲示板・チャット）"></span></h1>
          <p id="mobile-company-name" class="text-[11px] text-gray-400 truncate"></p>
        </div>
        <select id="mobile-nav" class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 w-32 shrink-0" aria-label="メニュー">
          <option value="dashboard">ダッシュボード</option><option value="notifications">通知</option><option value="staff">スタッフマスタ</option><option value="employees">従業員管理</option>
          <option value="projects">案件</option><option value="clients">クライアント</option>
          <option value="shifts">シフト</option><option value="reports">日報</option><option value="report-settings">案件報告管理</option><option value="corrections">打刻修正承認</option><option value="attendance-history">履歴・CSV</option>
          <option value="analytics">分析</option><option value="notices">お知らせ</option><option value="notice-reports">既読率レポート</option>
          <option value="follow">フォロー</option><option value="consult">相談</option><option value="board">案件掲示板</option><option value="roster-chat">企業間チャット</option><option value="recruit">募集・応募</option><option value="settlement">精算</option><option value="billing">請求前確認</option><option value="account">アカウント設定</option>
        </select>
        <button type="button" class="text-blue-600 shrink-0 px-1 py-1" data-action="hqsOpenSupport" title="伴走支援を依頼する" aria-label="伴走支援を依頼する"><i class="fas fa-hands-holding-circle"></i></button>
        <button id="mobile-logout-btn" type="button" class="text-gray-400 hover:text-gray-600 shrink-0 px-1 py-1" title="ログアウト" aria-label="ログアウト"><i class="fas fa-right-from-bracket"></i></button>
      </header>
      <!-- 本部の閲覧中の表示・本部からのお知らせ（#293 #516。public/static/hq-support.js が描く） -->
      <div id="hq-support-bar" class="px-4 md:px-6 pt-4 max-w-7xl space-y-2 hidden"></div>
      <main id="app" class="p-4 md:p-6 max-w-7xl"></main>
    </div>
  </div>
  <div id="modal-root"></div>
  ${cdnJs('qrcode-generator@1.4.4/qrcode.min.js')}
  ${cdnJs('jsqr@1.4.0/dist/jsQR.min.js')}
  <script>window.HQ_VIEW = ${hqViewJson}</script>
  <script src="/static/hq-support.js"></script>
  <script src="/static/admin.js"></script>
  <script src="/static/roster.js"></script>
  <script src="/static/roster-chat.js"></script>
  ${cdnJs('sortablejs@1.15.2/Sortable.min.js')}
  <script src="/static/shift-board.js"></script>
  <script src="/static/staff-lifecycle.js"></script>
  <script src="/static/settlement.js"></script>
  <script src="/static/report-settings.js"></script>
  <script src="/static/corrections.js"></script>
  <script src="/static/notifications.js"></script>
  <script src="/static/attendance-history.js"></script>
  <script src="/static/recruit.js"></script>
  <script src="/static/board.js"></script>
  <script src="/static/security.js"></script>
</body>
</html>`)
})

// ============ SaaS本部管理画面 ============
app.get('/hq', async (c) => {
  const u = await currentUser(c)
  if (!u) return toLogin(c)
  if (u.role !== 'system_admin') return c.redirect('/')
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('SaaS本部')}
  ${cdnJs('chart.js@4.5.1/dist/chart.umd.min.js')}
</head>
<body class="bg-slate-900 min-h-screen text-gray-100">
  <header class="bg-slate-800 border-b border-slate-700 sticky top-0 z-20">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <h1 class="font-bold flex items-center gap-2"><i class="fas fa-satellite-dish text-cyan-400"></i>Field OS <span class="text-cyan-400">本部管理</span></h1>
      <div class="flex items-center gap-4 text-sm">
        <nav class="flex gap-1">
          <a href="#companies" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="companies">導入企業</a>
          <a href="#templates" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="templates">テンプレート配信</a>
          <a href="#retention" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="retention">データ保持・定期処理</a>
          <a href="#mail" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="mail">メール送信</a>
          <a href="#support" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="support">伴走支援<span id="hq-support-badge" class="hidden ml-1 text-[10px] bg-red-500 text-white rounded-full px-1.5 py-0.5"></span></a>
          <a href="#announcements" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="announcements">企業へのお知らせ</a>
          <a href="#security" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="security">セキュリティ</a>
        </nav>
        <button id="logout-btn" class="text-slate-400 hover:text-white"><i class="fas fa-right-from-bracket"></i></button>
      </div>
    </div>
  </header>
  <main id="app" class="max-w-7xl mx-auto p-4 md:p-6"></main>
  <div id="modal-root"></div>
  <script src="/static/hq.js"></script>
  ${cdnJs('qrcode-generator@1.4.4/qrcode.min.js')}
  <script src="/static/security.js"></script>
</body>
</html>`)
})

// ============ 定期処理（Cron Trigger） ============
// wrangler.jsonc の triggers.crons と同じ式にする（時刻は UTC）
const CRON_DAILY = '0 18 * * *'    // 日本時間 3:00: 認証の後片付け・個人情報の削除・退職と区分変更の適用
const CRON_REPORTS = '30 18 * * *' // 日本時間 3:30: 既読率レポートの集計（問い合わせが多いので別の起動に分ける。#198）
const CRON_REMINDERS = '*/15 * * * *' // 15分おき: 本人あての自動リマインド（#160）

// 定期処理の一覧。上から順に実行し、処理ごとの結果を cron_runs に記録して本部画面に出す（#192）。
// 処理を足すときは、ここに1行足す。結果に failed（1以上）か error を返すと「失敗」として記録される。
// 個人情報の削除（応募・データ保持）は、問い合わせの上限に当たって止まらないよう先に実行する（#198）
const CRON_JOBS = defineCronJobs<Bindings>([
  // 起床・出発・入店の未報告と日報の未提出を本人に知らせる（会社の設定で ON にした会社だけ。#160）。メールの設定は wrangler.jsonc の vars と Secret
  { name: 'reminders', label: '本人あての自動リマインド（未報告・日報未提出）', cron: CRON_REMINDERS, run: env => runReminders(env as any) },
  // アプリ内の通知のプッシュ（#178）のうち、応答の後に送れなかった分を送る。リマインドの通知もここで送る
  { name: 'push_queue', label: 'プッシュ通知の送信（残り）', cron: CRON_REMINDERS, run: env => runPushQueueJob(env as any) },
  // 打刻修正の承認依頼を「1日1回まとめて」受け取る管理者へのまとめメール（#284。毎朝8時以降の最初の起動で1回）
  { name: 'notification_digest', label: '承認依頼のまとめメール', cron: CRON_REMINDERS, run: env => runNotificationDigests(env as any) },
  // expires_at は ISO 8601 で保存しているため、同じ書式の現在時刻と比べる（CURRENT_TIMESTAMP とは比べない）
  { name: 'auth_purge', label: '期限切れのセッション・ログイン試行の削除', cron: CRON_DAILY, run: env => purgeExpiredAuthRows(env.DB) },
  // 期限切れ・使用済みのパスワード再設定トークンと報告用URLのトークンの削除（RETENTION_ENABLED に関係なく実行。#397）
  { name: 'token_purge', label: '期限切れ・使用済みのトークンの削除', cron: CRON_DAILY, run: env => purgeExpiredTokens(env.DB) },
  // 募集の応募（スタッフに紐づかないもの）は180日で削除する（個人情報の保存期間）
  { name: 'recruit_applications_purge', label: '応募の削除（180日）', cron: CRON_DAILY, run: async env => ({ deleted: await purgeOldApplications(env.DB) }) },
  // データ保持ポリシー(日報3年 / 退職後7年)の定期削除。
  // RETENTION_ENABLED が 'true' になるまでは dry-run（削除せず対象件数のみログ・記録）で動作する。
  // 本番投入時は、dry-runの結果を確認してから RETENTION_ENABLED=true に切り替えること。
  { name: 'retention', label: 'データ保持の定期削除', cron: CRON_DAILY, run: async env => {
    const dryRun = env.RETENTION_ENABLED !== 'true'
    const r = await runRetentionCleanup(env.DB, env, { dryRun, trigger: 'cron' })
    const failedTargets = r.results.filter(x => x.failedCount > 0)
    return {
      dry_run: dryRun,
      target: r.results.reduce((a, x) => a + x.targetCount, 0),
      deleted: r.results.reduce((a, x) => a + x.deletedCount, 0),
      failed: failedTargets.reduce((a, x) => a + x.failedCount, 0),
      error: failedTargets.map(x => `${x.target}: ${x.error || '失敗'}`).join(' / ').slice(0, 1000) || null,
    }
  } },
  // 退職予定日を過ぎたスタッフを退職（ログイン停止）に切り替える（退職日の当日までは在籍。#34）
  { name: 'retirements', label: '退職予定日を過ぎたスタッフの退職への切り替え', cron: CRON_DAILY, run: async env => ({ applied: await applyDueRetirements(env.DB) }) },
  // 適用日になった所属区分の変更の予約を適用する（#82）。退職の切り替えの後に行い、退職した人の予約は適用しない
  { name: 'affiliation_schedules', label: '所属区分の変更の予約の適用', cron: CRON_DAILY, run: async env => {
    // 状況が変わって適用できなかった予約は、理由をスタッフの画面に出すので定期処理の失敗にはしない
    const r = await applyDueAffiliationSchedules(env.DB)
    return { due: r.due, applied: r.applied, not_applied: r.failed }
  } },
  { name: 'notice_reads_purge', label: 'お知らせの既読の記録の削除（2年）', cron: CRON_DAILY, run: env => purgeOldNoticeReads(env.DB) },
  // 在職中の保存期間（位置情報と写真・相談・フォロー記録・決着した人材提案・雇用終了の従業員データ）の削除。D1 の問い合わせの数を分けるため 3:30 の起動で行う（#420 #511 #350 #425）
  { name: 'retention_in_service', label: 'データ保持の定期削除（在職中の位置情報・写真・相談など）', cron: CRON_REPORTS, run: env => runInServiceRetentionJob(env.DB, env, env.RETENTION_ENABLED === 'true') },
  { name: 'notice_read_reports', label: '既読率レポートの集計', cron: CRON_REPORTS, run: env => generateFiscalYearReportsForAllCompanies(env.DB) },
  // 予約配信のお知らせのメール（#291。画面には時刻どおりに出る。管理者・スタッフがお知らせを開いたときにもその会社の分を送る）
  { name: 'notice_scheduled_publish', label: 'お知らせの予約配信（メール）', cron: CRON_DAILY, run: env => publishDueNotices(env as any) },
])

export default {
  fetch: app.fetch,
  // Cron Trigger: 起動した式（event.cron）に合う処理を CRON_JOBS の順に実行する。
  // 起動は毎日 UTC 18:00（日本時間 3:00）と UTC 18:30（日本時間 3:30）の2回と、15分おき（リマインド）（wrangler.jsonc の triggers.crons）。
  // 処理は互いに独立させ、1つが失敗しても他の実行を妨げない（結果は cron_runs に記録する）。
  // 処理を足したら README の「定期処理（Cron Trigger）」の表にも足す（#332）
  async scheduled(event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    await runCronJobs(env, CRON_JOBS, event.cron)
  },
}
