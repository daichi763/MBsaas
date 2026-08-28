import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import api, { generateFiscalYearReportsForAllCompanies, purgeOldNoticeReads } from './api'

type Bindings = { DB: D1Database }

const app = new Hono<{ Bindings: Bindings }>()

app.route('/api', api)

// ============ 共通レイアウト ============
const head = (title: string) => `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | Field OS</title>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
  <link href="/static/style.css" rel="stylesheet">
`

async function currentUser(c: any) {
  const token = getCookie(c, 'session')
  if (!token) return null
  const row = await c.env.DB.prepare(`
    SELECT u.user_id, u.role, s.expires_at FROM sessions s JOIN users u ON s.user_id = u.user_id WHERE s.token = ?`).bind(token).first()
  if (!row || new Date(row.expires_at) < new Date()) return null
  return row
}

// ルート: ロール別リダイレクト
app.get('/', async (c) => {
  const u = await currentUser(c)
  if (!u) return c.redirect('/login')
  if (u.role === 'staff') return c.redirect('/staff')
  if (u.role === 'system_admin') return c.redirect('/hq')
  return c.redirect('/admin')
})

// ============ ログイン画面 ============
app.get('/login', (c) => c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('ログイン')}</head>
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
      <form id="login-form" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">会社コード</label>
          <input id="company_code" type="text" autocomplete="organization" class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-base" placeholder="例: sample" required>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">スタッフ番号 / ユーザーID</label>
          <input id="user_code" type="text" autocomplete="username" class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-base" placeholder="例: st001" required>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-600 mb-1">パスワード</label>
          <input id="password" type="password" autocomplete="current-password" class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none text-base" required>
        </div>
        <p id="login-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"></p>
        <button type="submit" id="login-btn" class="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-base transition">
          ログイン
        </button>
      </form>
    </section>
    <aside class="mt-6 bg-blue-50 rounded-xl p-4 text-xs text-blue-900 leading-relaxed">
      <p class="font-bold mb-1"><i class="fas fa-circle-info mr-1"></i>デモアカウント（パスワードは全て pass1234）</p>
      <ul class="space-y-0.5">
        <li>スタッフ: 会社コード <b>sample</b> / ID <b>st001</b>（〜st020）</li>
        <li>管理者: 会社コード <b>sample</b> / ID <b>admin</b> または <b>mgr01</b></li>
        <li>SaaS本部: 会社コード <b>sample</b> / ID <b>hq</b></li>
      </ul>
    </aside>
  </main>
  <script>
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = document.getElementById('login-btn')
      const err = document.getElementById('login-error')
      btn.disabled = true; btn.textContent = 'ログイン中...'
      err.classList.add('hidden')
      try {
        const res = await axios.post('/api/auth/login', {
          company_code: document.getElementById('company_code').value.trim(),
          user_code: document.getElementById('user_code').value.trim(),
          password: document.getElementById('password').value
        })
        location.href = res.data.redirect
      } catch (e2) {
        err.textContent = (e2.response && e2.response.data && e2.response.data.error) || 'ログインに失敗しました'
        err.classList.remove('hidden')
        btn.disabled = false; btn.textContent = 'ログイン'
      }
    })
  </script>
</body>
</html>`))

// ============ スタッフ画面 (スマホファースト SPA) ============
app.get('/staff', async (c) => {
  const u = await currentUser(c)
  if (!u) return c.redirect('/login')
  if (u.role !== 'staff') return c.redirect('/')
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('スタッフ')}</head>
<body class="bg-gray-50 min-h-screen pb-20">
  <header id="staff-header" class="bg-white border-b border-gray-100 sticky top-0 z-20">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <h1 class="font-bold text-gray-800 flex items-center gap-2"><i class="fas fa-tower-cell text-blue-600"></i><span id="header-title">ホーム</span></h1>
      <div class="flex items-center gap-3">
        <span id="user-name" class="text-sm text-gray-500"></span>
        <button id="logout-btn" class="text-gray-400 hover:text-gray-600" title="ログアウト"><i class="fas fa-right-from-bracket"></i></button>
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
      <a href="#more" class="nav-item py-2.5" data-tab="more"><i class="fas fa-bars block text-lg mb-0.5"></i>その他</a>
    </div>
  </nav>
  <div id="modal-root"></div>
  <script src="/static/staff.js"></script>
</body>
</html>`)
})

// ============ 管理者画面 (PC向け SPA) ============
app.get('/admin', async (c) => {
  const u = await currentUser(c)
  if (!u) return c.redirect('/login')
  if (u.role === 'staff') return c.redirect('/staff')
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('管理画面')}
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
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
        <a href="#staff" class="side-link" data-tab="staff"><i class="fas fa-users w-5"></i>スタッフ管理</a>
        <a href="#projects" class="side-link" data-tab="projects"><i class="fas fa-briefcase w-5"></i>案件管理</a>
        <a href="#clients" class="side-link" data-tab="clients"><i class="fas fa-building w-5"></i>クライアント</a>
        <a href="#shifts" class="side-link" data-tab="shifts"><i class="fas fa-calendar-days w-5"></i>シフト管理</a>
        <a href="#reports" class="side-link" data-tab="reports"><i class="fas fa-file-lines w-5"></i>日報一覧</a>
        <a href="#analytics" class="side-link" data-tab="analytics"><i class="fas fa-chart-column w-5"></i>実績分析</a>
        <a href="#notices" class="side-link" data-tab="notices"><i class="fas fa-bullhorn w-5"></i>お知らせ配信</a>
        <a href="#notice-reports" class="side-link" data-tab="notice-reports"><i class="fas fa-chart-pie w-5"></i>既読率レポート</a>
        <a href="#follow" class="side-link" data-tab="follow"><i class="fas fa-handshake-angle w-5"></i>フォロー履歴</a>
        <a href="#consult" class="side-link" data-tab="consult"><i class="fas fa-comments w-5"></i>相談対応</a>
        <a href="#billing" class="side-link" data-tab="billing"><i class="fas fa-file-invoice-yen w-5"></i>請求前確認</a>
      </nav>
      <div class="p-3 border-t border-gray-100">
        <button class="w-full text-left px-3 py-2 rounded-lg text-sm text-blue-700 bg-blue-50 hover:bg-blue-100" onclick="alert('伴走支援メニュー:\\n・初期設定代行\\n・日報項目設計\\n・スタッフ研修\\n・管理者教育\\n・月次運営レビュー\\n\\nお問い合わせ: support@dissectra.example.jp')">
          <i class="fas fa-hands-holding-circle mr-1"></i>伴走支援を依頼する
        </button>
        <button id="logout-btn" class="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 mt-1"><i class="fas fa-right-from-bracket mr-1"></i>ログアウト</button>
      </div>
    </aside>
    <div class="flex-1 md:ml-60 min-w-0">
      <header class="md:hidden bg-white border-b border-gray-100 sticky top-0 z-20 px-4 py-3 flex items-center justify-between gap-2">
        <h1 class="font-bold text-gray-800 truncate min-w-0 flex-1"><i class="fas fa-tower-cell text-blue-600 mr-1"></i>Field OS 管理</h1>
        <select id="mobile-nav" class="text-sm border border-gray-200 rounded-lg px-2 py-1.5 w-32 shrink-0">
          <option value="dashboard">ダッシュボード</option><option value="staff">スタッフ</option>
          <option value="projects">案件</option><option value="clients">クライアント</option>
          <option value="shifts">シフト</option><option value="reports">日報</option>
          <option value="analytics">分析</option><option value="notices">お知らせ</option><option value="notice-reports">既読率レポート</option>
          <option value="follow">フォロー</option><option value="consult">相談</option><option value="billing">請求前確認</option>
        </select>
      </header>
      <main id="app" class="p-4 md:p-6 max-w-7xl"></main>
    </div>
  </div>
  <div id="modal-root"></div>
  <script src="/static/admin.js"></script>
</body>
</html>`)
})

// ============ SaaS本部管理画面 ============
app.get('/hq', async (c) => {
  const u = await currentUser(c)
  if (!u) return c.redirect('/login')
  if (u.role !== 'system_admin') return c.redirect('/')
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>${head('SaaS本部')}
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="bg-slate-900 min-h-screen text-gray-100">
  <header class="bg-slate-800 border-b border-slate-700 sticky top-0 z-20">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <h1 class="font-bold flex items-center gap-2"><i class="fas fa-satellite-dish text-cyan-400"></i>Field OS <span class="text-cyan-400">本部管理</span></h1>
      <div class="flex items-center gap-4 text-sm">
        <nav class="flex gap-1">
          <a href="#companies" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="companies">導入企業</a>
          <a href="#templates" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="templates">テンプレート配信</a>
          <a href="#support" class="hq-nav px-3 py-1.5 rounded-lg" data-tab="support">伴走支援</a>
        </nav>
        <button id="logout-btn" class="text-slate-400 hover:text-white"><i class="fas fa-right-from-bracket"></i></button>
      </div>
    </div>
  </header>
  <main id="app" class="max-w-7xl mx-auto p-4 md:p-6"></main>
  <div id="modal-root"></div>
  <script src="/static/hq.js"></script>
</body>
</html>`)
})

export default {
  fetch: app.fetch,
  // Cron Trigger: 毎日3時(UTC) = 日本時間12時 に実行。
  // 3つの処理は互いに独立させ、一方が失敗しても他方の実行を妨げないようにする。
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    try {
      const result = await env.DB.prepare(
        'DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP'
      ).run()
      console.log(`Deleted ${result.meta.changes} expired sessions`)
    } catch (e) {
      console.log(`session cleanup failed: ${e}`)
    }

    try {
      const r = await generateFiscalYearReportsForAllCompanies(env.DB)
      console.log(`notice_read_reports generation completed: companies=${r.companies} ok=${r.ok} failed=${r.failed}`)
    } catch (e) {
      console.log(`notice_read_reports generation failed: ${e}`)
    }

    try {
      const r = await purgeOldNoticeReads(env.DB)
      console.log(`notice_reads cleanup completed: deleted=${r.deleted}${r.error ? ' error=' + r.error : ''}`)
    } catch (e) {
      console.log(`notice_reads cleanup failed: ${e}`)
    }
  },
}
