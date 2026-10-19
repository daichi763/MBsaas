// Field OS SaaS本部管理SPA
const $app = document.getElementById('app')

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) }
function yen(n) { return '¥' + Number(n || 0).toLocaleString() }
function toast(msg) {
  let root = document.getElementById('toast')
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
  const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg
  root.appendChild(el); setTimeout(() => el.remove(), 2500)
}
function loading() { $app.innerHTML = '<div class="flex justify-center py-20"><span class="spin"></span></div>' }
function modal(html) {
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-box p-5">${html}</div></div>`
}
window.closeModal = () => { document.getElementById('modal-root').innerHTML = '' }

// ---------- API 呼び出しの共通処理（#230 #346） ----------
let HQ_ME = null
let SESSION_ENDED = false
axios.interceptors.request.use(cfg => {
  // 起動時に読んだ自分と違う人のセッションで操作が記録されないよう、サーバーで照合する
  if (HQ_ME) cfg.headers['X-Expected-User-Id'] = String(HQ_ME.user_id)
  return cfg
})
axios.interceptors.response.use(r => r, e => {
  const r = e.response
  if (r && !SESSION_ENDED && r.status === 409 && r.data && r.data.code === 'account_switched') {
    SESSION_ENDED = true
    alert('このブラウザで別のアカウントにログインされました。画面を読み直します。')
    location.reload()
  } else if (r && !SESSION_ENDED && r.status === 401) {
    SESSION_ENDED = true
    location.href = '/login'
  }
  return Promise.reject(e)
})
// 画面の処理で受け止められなかった API のエラー（500 など）を表示する。サーバーの文言には参照番号が入る
window.addEventListener('unhandledrejection', ev => {
  const e = ev.reason
  if (!e || !e.isAxiosError || SESSION_ENDED) return
  showApiError(e, e.response ? '処理に失敗しました' : '通信できませんでした。接続を確かめて、もう一度お試しください')
})
document.getElementById('logout-btn').addEventListener('click', async () => {
  await axios.post('/api/auth/logout'); location.href = '/login'
})

const PLAN_LABELS = { basic: 'ベーシック', standard: 'スタンダード', premium: 'プレミアム' }
const STATUS_BADGE = {
  active: '<span class="badge badge-green">利用中</span>',
  trial: '<span class="badge badge-yellow">トライアル</span>',
  inactive: '<span class="badge badge-gray">停止</span>'
}
const BILLING_BADGE = {
  active: '<span class="badge badge-green">正常</span>',
  overdue: '<span class="badge badge-red">滞納</span>',
  suspended: '<span class="badge badge-gray">停止</span>'
}

// ============ 導入企業一覧 ============
// 並べ替え・絞り込み・検索の状態（企業詳細から戻っても保つ。#517）
const HQ_LIST = { sort: 'company_id', dir: 'asc', q: '', filter: '' }
let HQ_COMPANIES = []
let HQ_RULES = { drop_rate: 0.3, drop_min_base: 10, no_shift_days: 14 }
const HQ_FILTERS = {
  '': 'すべて', over_limit: '契約ユーザー数の超過', needs_attention: '利用が減った・止まっている', usage_drop: '利用が減った', no_recent_shift: 'シフト登録が止まっている',
  trial: 'トライアル', inactive: '停止'
}
const hqMatchFilter = (c, f) => !f ? true : f === 'needs_attention' ? !!(c.usage_drop || c.no_recent_shift) : (f === 'trial' || f === 'inactive') ? c.active_status === f : !!c[f]
// 増減率（前の30日と比べて）。前の期間が0なら出さない
const hqRate = r => r == null ? '' : `<span class="block text-[11px] ${r <= -0.3 ? 'text-red-400' : r < 0 ? 'text-amber-300' : 'text-emerald-400'}">${r > 0 ? '+' : ''}${Math.round(r * 100)}%</span>`
const hqDate = v => v ? dayjs(String(v).replace(' ', 'T')).format('YYYY/M/D') : '<span class="text-slate-500">なし</span>'
const hqLimit = c => c.user_limit == null ? '上限なし' : c.user_limit
// 並べ替えの列（key: 並べ替えに使う値の名前）
const HQ_COLUMNS = [
  { key: 'company_name', label: '企業', cls: 'text-left px-4' },
  { key: 'company_code', label: 'コード' },
  { key: 'plan', label: 'プラン' },
  { key: 'active_status', label: '状態' },
  { key: 'billing_status', label: '請求' },
  { key: 'user_count', label: 'ユーザー', num: true },
  { key: 'active_users', label: '週次アクティブ', num: true },
  { key: 'reports_30d', label: '日報(30日)', num: true },
  { key: 'shifts_30d', label: 'シフト(30日)', num: true },
  { key: 'last_shift_created_at', label: '最終シフト登録' },
  { key: 'last_admin_login_at', label: '管理者の最終ログイン' },
  { key: 'monthly_fee', label: '月額', num: true },
  { key: 'maturity_level', label: '成熟度', num: true },
]

async function renderCompanies() {
  loading()
  let data
  try { data = (await axios.get('/api/hq/companies')).data } catch (e) {
    $app.innerHTML = `<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-sm text-slate-300">企業の一覧を読み込めませんでした。<button class="btn btn-outline ml-2" style="border-color:#334155;color:#67e8f9" onclick="renderCompanies()">再試行</button></div>`
    return
  }
  HQ_COMPANIES = data.companies
  if (data.rules) HQ_RULES = data.rules
  const list = data.companies
  const totalMRR = list.filter(c => c.active_status === 'active').reduce((a, c) => a + c.monthly_fee, 0)
  const kpi = (label, value, icon, filter) => `
    <div class="bg-slate-800 border border-slate-700 rounded-xl p-4 ${filter ? 'cursor-pointer hover:border-cyan-700' : ''}" ${filter ? `data-action="hqFilter" data-filter="${filter}"` : ''}>
      <p class="text-xs text-slate-400">${label}</p>
      <p class="text-2xl font-bold mt-0.5 truncate"><i class="fas ${icon} text-cyan-400 mr-2 text-lg"></i>${value}</p>
    </div>`

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold">導入企業管理</h2>
      <button class="btn btn-primary" style="background:#0e7490" onclick="showAddCompany()"><i class="fas fa-plus"></i>企業登録</button>
    </div>
    <section class="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-6">
      ${kpi('導入企業数', list.length + '社', 'fa-building')}
      ${kpi('課金対象企業', list.filter(c => c.active_status === 'active').length + '社', 'fa-circle-check')}
      ${kpi('月間収益(MRR)', yen(totalMRR), 'fa-yen-sign')}
      ${kpi('総ユーザー数', list.reduce((a, c) => a + (c.user_count || 0), 0) + '名', 'fa-users')}
      ${kpi('契約ユーザー数の超過', list.filter(c => c.over_limit).length + '社', 'fa-user-plus', 'over_limit')}
      ${kpi('利用が減った・止まっている', list.filter(c => c.usage_drop || c.no_recent_shift).length + '社', 'fa-arrow-trend-down', 'needs_attention')}
    </section>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="hq-co-q" class="inp" style="max-width:16rem;background:#1e293b;border-color:#334155;color:#fff" placeholder="企業名・会社コードで検索" value="${esc(HQ_LIST.q)}">
      <select id="hq-co-filter" class="inp" style="max-width:14rem;background:#1e293b;border-color:#334155;color:#fff">
        ${Object.entries(HQ_FILTERS).map(([k, v]) => `<option value="${k}" ${HQ_LIST.filter === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <span id="hq-co-count" class="text-xs text-slate-400"></span>
    </div>
    <section class="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
      <table class="w-full text-sm">
        <thead id="hq-co-head"></thead>
        <tbody id="hq-co-body"></tbody>
      </table>
    </section>
    <p class="text-xs text-slate-500 mt-3"><i class="fas fa-circle-info mr-1"></i>料金 = 基本990円（3ユーザーまで）+ 追加1ユーザーごとに300円/月。ユーザー数は課金対象（利用中で、ログインできる人）の人数です</p>
    <p class="text-xs text-slate-500 mt-1"><i class="fas fa-circle-info mr-1"></i>増減率は直近30日と、その前の30日の比較です。「利用減」は日報かシフトが前の30日（${HQ_RULES.drop_min_base}件以上）から${Math.round(HQ_RULES.drop_rate * 100)}%以上減った企業、「シフト登録なし」は${HQ_RULES.no_shift_days}日以上シフトを登録していない企業です</p>`
  document.getElementById('hq-co-q').addEventListener('input', ev => { HQ_LIST.q = ev.target.value; drawCompanyTable() })
  document.getElementById('hq-co-filter').addEventListener('change', ev => { HQ_LIST.filter = ev.target.value; drawCompanyTable() })
  drawCompanyTable()
}

function drawCompanyTable() {
  const head = document.getElementById('hq-co-head'), body = document.getElementById('hq-co-body')
  if (!head || !body) return
  const q = HQ_LIST.q.trim().toLowerCase()
  const rows = HQ_COMPANIES.filter(c => hqMatchFilter(c, HQ_LIST.filter)
    && (!q || String(c.company_name || '').toLowerCase().includes(q) || String(c.company_code || '').toLowerCase().includes(q)))
  const col = HQ_COLUMNS.find(x => x.key === HQ_LIST.sort)
  const dir = HQ_LIST.dir === 'desc' ? -1 : 1
  rows.sort((a, b) => {
    const va = a[HQ_LIST.sort], vb = b[HQ_LIST.sort]
    // 値のないもの（最終ログインなし など）は、並べ替えの向きによらず最後にする
    if (va == null || va === '') return vb == null || vb === '' ? a.company_id - b.company_id : 1
    if (vb == null || vb === '') return -1
    const d = col && col.num ? Number(va) - Number(vb) : String(va).localeCompare(String(vb), 'ja')
    return d ? d * dir : a.company_id - b.company_id
  })
  head.innerHTML = `<tr class="text-slate-400 text-xs border-b border-slate-700">
    ${HQ_COLUMNS.map(c => `<th class="${c.cls || (c.num ? 'text-right px-3' : 'text-left px-3')} py-3 cursor-pointer select-none whitespace-nowrap hover:text-cyan-300" data-action="hqSort" data-key="${c.key}">${c.label}${HQ_LIST.sort === c.key ? (HQ_LIST.dir === 'desc' ? ' ▼' : ' ▲') : ''}</th>`).join('')}
    <th class="text-left px-3 py-3">注意</th><th></th>
  </tr>`
  body.innerHTML = rows.map(c => {
    const flags = [
      c.over_limit ? '<span class="badge badge-red">上限超過</span>' : '',
      c.usage_drop ? '<span class="badge badge-yellow">利用減</span>' : '',
      c.no_recent_shift ? '<span class="badge badge-gray">シフト登録なし</span>' : '',
    ].filter(Boolean).join(' ')
    return `
    <tr class="border-b border-slate-700/50 hover:bg-slate-700/30 cursor-pointer ${c.over_limit ? 'bg-red-900/20' : ''}" onclick="location.hash='companies/${Number(c.company_id)}'">
      <td class="px-4 py-3 font-medium">${esc(c.company_name)}</td>
      <td class="px-3 py-3 text-slate-400">${esc(c.company_code)}</td>
      <td class="px-3 py-3">${esc(PLAN_LABELS[c.plan] || c.plan)}</td>
      <td class="px-3 py-3">${STATUS_BADGE[c.active_status] || ''}</td>
      <td class="px-3 py-3">${BILLING_BADGE[c.billing_status] || ''}</td>
      <td class="px-3 py-3 text-right whitespace-nowrap ${c.over_limit ? 'text-red-400 font-bold' : ''}">${Number(c.user_count) || 0}/${hqLimit(c)}</td>
      <td class="px-3 py-3 text-right">${Number(c.active_users) || 0}名</td>
      <td class="px-3 py-3 text-right whitespace-nowrap">${Number(c.reports_30d) || 0}件${hqRate(c.reports_change)}</td>
      <td class="px-3 py-3 text-right whitespace-nowrap">${Number(c.shifts_30d) || 0}件${hqRate(c.shifts_change)}</td>
      <td class="px-3 py-3 whitespace-nowrap">${hqDate(c.last_shift_created_at)}</td>
      <td class="px-3 py-3 whitespace-nowrap">${hqDate(c.last_admin_login_at)}</td>
      <td class="px-3 py-3 text-right font-bold text-cyan-400">${yen(c.monthly_fee)}</td>
      <td class="px-3 py-3 text-center whitespace-nowrap">${'●'.repeat(c.maturity_level || 1)}${'○'.repeat(5 - (c.maturity_level || 1))}</td>
      <td class="px-3 py-3 whitespace-nowrap">${flags}</td>
      <td class="px-3 py-3 text-cyan-400 text-xs whitespace-nowrap">詳細 →</td>
    </tr>`
  }).join('') || `<tr><td colspan="${HQ_COLUMNS.length + 2}" class="px-4 py-8 text-center text-slate-400">条件に合う企業はありません</td></tr>`
  const cnt = document.getElementById('hq-co-count')
  if (cnt) cnt.textContent = `${rows.length}社 / 全${HQ_COMPANIES.length}社`
}
delegate('hqSort', (el) => {
  const key = el.dataset.key
  // 同じ列をもう一度押すと向きを変える。数値の列は多い順から始める
  if (HQ_LIST.sort === key) HQ_LIST.dir = HQ_LIST.dir === 'asc' ? 'desc' : 'asc'
  else { HQ_LIST.sort = key; HQ_LIST.dir = (HQ_COLUMNS.find(c => c.key === key) || {}).num ? 'desc' : 'asc' }
  drawCompanyTable()
})
delegate('hqFilter', (el) => {
  HQ_LIST.filter = el.dataset.filter || ''
  const sel = document.getElementById('hq-co-filter'); if (sel) sel.value = HQ_LIST.filter
  drawCompanyTable()
})

// 会社コード: ログインの照合に合わせて全角を半角に、大文字を小文字にそろえる（サーバーでも同じ確認をする。#398）
const HQ_COMPANY_CODE_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
const hqNormCode = v => String(v || '').normalize('NFKC').trim().toLowerCase()
// 入力ミスの欄に印を付けて、そこへ移動する
function hqMarkField(id, msg) {
  document.querySelectorAll('.hq-field-error').forEach(el => el.classList.remove('hq-field-error', 'border-red-500'))
  const el = id && document.getElementById(id)
  if (el) { el.classList.add('hq-field-error', 'border-red-500'); el.focus() }
  toast(msg)
}

window.showAddCompany = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4 text-gray-800">導入企業登録</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">会社コード *</label><input id="co-code" class="inp" placeholder="newcompany" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="40">
          <p class="text-[11px] text-gray-400 mt-1">半角の英小文字・数字・ハイフン（2〜40文字）。利用者がログインで入力します</p></div>
        <div><label class="text-sm text-gray-600 block mb-1">会社名 *</label><input id="co-name" class="inp" maxlength="100"></div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">プラン</label>
          <select id="co-plan" class="inp"><option value="basic">ベーシック</option><option value="standard">スタンダード</option><option value="premium">プレミアム</option></select></div>
        <div><label class="text-sm text-gray-600 block mb-1">ユーザー上限</label><input id="co-limit" type="number" min="1" step="1" value="3" class="inp" placeholder="空欄 = 上限なし"></div>
      </div>
      <hr>
      <p class="text-xs text-gray-500">初期管理者アカウント（必須）</p>
      <div class="grid grid-cols-3 gap-3">
        <div><label class="text-xs text-gray-600 block mb-1">管理者ID *</label><input id="co-admin-code" class="inp" placeholder="admin" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="40"></div>
        <div><label class="text-xs text-gray-600 block mb-1">氏名</label><input id="co-admin-name" class="inp" maxlength="60"></div>
        <div><label class="text-xs text-gray-600 block mb-1">パスワード</label><input id="co-admin-pass" class="inp" autocomplete="new-password" placeholder="空欄なら自動で作成"></div>
      </div>
      <div><label class="text-xs text-gray-600 block mb-1">管理者のメールアドレス（承認依頼の通知・パスワード再設定の宛先）</label><input id="co-admin-email" type="email" class="inp"></div>
      <p class="text-[11px] text-gray-400">初回ログインで、管理者本人にパスワードの変更を求めます。</p>
      <button class="btn btn-primary w-full" data-action="addCompany">登録する</button>
    </div>`)
}
// API が返す入力欄の名前 → 画面の入力欄
const HQ_ADD_FIELDS = { company_code: 'co-code', company_name: 'co-name', plan: 'co-plan', user_limit: 'co-limit', admin_code: 'co-admin-code', admin_password: 'co-admin-pass', admin_email: 'co-admin-email' }
delegate('addCompany', (el) => withSubmitLock(el, async () => {
  const v = id => document.getElementById(id).value.trim()
  const code = hqNormCode(v('co-code'))
  const adminCode = v('co-admin-code').normalize('NFKC')
  const limitRaw = v('co-limit')
  if (!code) return hqMarkField('co-code', '会社コードを入力してください')
  if (!HQ_COMPANY_CODE_RE.test(code)) return hqMarkField('co-code', '会社コードは半角の英小文字・数字・ハイフンで2〜40文字にしてください（先頭は英数字）')
  if (!v('co-name')) return hqMarkField('co-name', '会社名を入力してください')
  if (limitRaw && !(Number.isInteger(Number(limitRaw)) && Number(limitRaw) >= 1)) return hqMarkField('co-limit', 'ユーザー上限は1以上の整数で入力してください（空欄にすると上限なし）')
  if (!adminCode) return hqMarkField('co-admin-code', '初期管理者のIDを入力してください')
  document.getElementById('co-code').value = code
  try {
    const { data } = await axios.post('/api/hq/companies', {
      company_code: code,
      company_name: v('co-name'),
      plan: v('co-plan'),
      user_limit: limitRaw === '' ? null : Number(limitRaw),
      admin_code: adminCode,
      admin_name: v('co-admin-name'),
      admin_password: document.getElementById('co-admin-pass').value,
      admin_email: v('co-admin-email')
    })
    closeModal(); toast('企業を登録しました'); renderCompanies()
    if (data.admin_temp_password) showTempPassword('初期管理者を作成しました', data.admin_temp_password, [`会社コード: ${data.company_code || code}`, `管理者ID: ${adminCode}`, `ログイン: ${location.origin}/login`])
  } catch (e) {
    const d = e.response && e.response.data
    hqMarkField(d && HQ_ADD_FIELDS[d.field], (d && d.error) || (e.response ? '登録に失敗しました' : '通信できませんでした。接続を確かめて、もう一度お試しください'))
  }
}))

// 仮パスワードを一度だけ表示する（閉じると二度と表示できない）
function showTempPassword(title, password, lines) {
  modal(`
    <h3 class="font-bold text-lg mb-2 text-gray-800"><i class="fas fa-key text-cyan-600 mr-1"></i>${esc(title)}</h3>
    <p class="text-xs text-red-600 mb-2">この画面を閉じると、仮パスワードは二度と表示できません。管理者本人に伝えてから閉じてください。次回ログインで、本人にパスワードの変更を求めます。</p>
    <textarea id="temp-pw-text" class="inp font-mono text-sm text-gray-800" rows="${lines.length + 1}" readonly>${esc([...lines, '仮パスワード: ' + password].join('\n'))}</textarea>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-outline flex-1" data-action="copyTempPassword"><i class="fas fa-copy"></i>コピー</button>
      <button class="btn btn-primary flex-1" onclick="closeModal()">閉じる</button>
    </div>`)
}
delegate('copyTempPassword', async () => {
  const el = document.getElementById('temp-pw-text'); if (!el) return
  try { await navigator.clipboard.writeText(el.value) } catch { el.select(); document.execCommand && document.execCommand('copy') }
  toast('コピーしました')
})

// ============ 企業詳細 ============
const ROLE_LABELS = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', staff: 'スタッフ', roster_only: 'ログインなし（名簿のみ）', system_admin: 'システム管理者' }
// 利用者の状態（課金対象かどうかの見分けに使う。#366）
function hqUserState(u) {
  if (u.role === 'roster_only') return { key: 'no_login', label: 'ログインなし', cls: 'badge-gray' }
  if (u.status !== 'active') return { key: 'stopped', label: '退職・停止', cls: 'badge-gray' }
  if (u.employment_status === 'leave') return { key: 'billable', label: '休職中', cls: 'badge-yellow' }
  return { key: 'billable', label: '在籍', cls: 'badge-green' }
}
const HQ_USER_FILTERS = { '': 'すべて', billable: '課金対象', stopped: '退職・停止', no_login: 'ログインなし' }
let HQ_USER_FILTER = ''

async function renderCompanyDetail(cid) {
  loading()
  let data
  try { data = (await axios.get('/api/hq/companies/' + cid)).data } catch (e) {
    $app.innerHTML = `<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-sm text-slate-300">${e.response && e.response.status === 404 ? '企業が見つかりません。' : '企業の情報を読み込めませんでした。'}<a href="#companies" class="text-cyan-400 ml-2 hover:underline">一覧へ戻る</a></div>`
    return
  }
  const c = data.company
  const usage = data.usage || { user_count: data.users.filter(u => u.billable).length, user_limit: c.user_limit, linked_count: 0, over_limit: false }
  HQ_USERS = new Map(data.users.map(u => [u.user_id, u]))
  const darkInp = 'style="background:#1e293b;border-color:#334155;color:#fff"'
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <a href="#companies" class="btn btn-outline" style="border-color:#334155;color:#94a3b8"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold">${esc(c.company_name)}</h2>
        <p class="text-sm text-slate-400">コード: ${esc(c.company_code)} ｜ ${STATUS_BADGE[c.active_status] || ''} ${BILLING_BADGE[c.billing_status] || ''}</p>
      </div>
    </div>
    ${usage.over_limit ? `<div class="bg-red-900/40 border border-red-700 text-red-200 rounded-xl p-3 mb-4 text-sm"><i class="fas fa-triangle-exclamation mr-1"></i>契約ユーザー数を超えています（課金対象 ${Number(usage.user_count)}名 / 上限 ${Number(usage.user_limit)}名）。プランの見直しか、上限の変更をご案内してください。</div>` : ''}

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${[['総日報数', data.stats.total_reports + '件'], ['総シフト数', data.stats.total_shifts + '件'], ['総勤怠報告', data.stats.total_attendance + '件'], ['稼働案件', data.stats.active_projects + '件']].map(([l, v]) => `
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-4"><p class="text-xs text-slate-400">${l}</p><p class="text-xl font-bold mt-0.5">${v}</p></div>`).join('')}
    </div>

    ${data.monthly ? `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5 overflow-x-auto">
      <h3 class="font-bold mb-3"><i class="fas fa-chart-line text-cyan-400 mr-1"></i>直近6か月の推移</h3>
      <table class="w-full text-xs">
        <thead><tr class="text-slate-400 border-b border-slate-700"><th class="text-left py-2">月</th>${data.monthly.map(m => `<th class="text-right py-2 px-2">${esc(m.month.replace('-', '/'))}</th>`).join('')}</tr></thead>
        <tbody>
          ${[['日報数', 'reports', '件'], ['シフト数', 'shifts', '件'], ['稼働した人数', 'working_staff', '名']].map(([label, k, unit]) => `
            <tr class="border-b border-slate-700/40"><td class="py-2 text-slate-400 whitespace-nowrap">${label}</td>${data.monthly.map((m, i) => {
              const prev = i > 0 ? data.monthly[i - 1][k] : null
              const down = prev != null && prev >= 10 && m[k] <= prev * 0.7
              return `<td class="py-2 px-2 text-right ${down ? 'text-red-400 font-bold' : ''}">${Number(m[k]) || 0}${unit}</td>`
            }).join('')}</tr>`).join('')}
        </tbody>
      </table>
      <p class="text-[11px] text-slate-500 mt-2">今月は途中までの件数です。前の月から3割以上減った月を赤で示します（前の月が10件・10名以上のとき）。稼働した人数は、確定・代打のシフトがあるスタッフの人数です。</p>
    </section>` : ''}

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <h3 class="font-bold mb-3"><i class="fas fa-gear text-cyan-400 mr-1"></i>契約・設定</h3>
        <div class="space-y-3 text-sm">
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-xs text-slate-400 block mb-1">プラン</label>
              <select id="cd-plan" class="inp" ${darkInp}>
                ${['basic', 'standard', 'premium'].map(p => `<option value="${p}" ${c.plan === p ? 'selected' : ''}>${PLAN_LABELS[p]}</option>`).join('')}
              </select></div>
            <div><label class="text-xs text-slate-400 block mb-1">ユーザー上限（課金対象 ${Number(usage.user_count)}名）</label>
              <input id="cd-limit" type="number" min="1" step="1" value="${c.user_limit == null ? '' : Number(c.user_limit)}" placeholder="空欄 = 上限なし" class="inp" ${darkInp}></div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-xs text-slate-400 block mb-1">利用状態</label>
              <select id="cd-status" data-current="${esc(c.active_status)}" class="inp" ${darkInp}>
                ${['active', 'trial', 'inactive'].map(s => `<option value="${s}" ${c.active_status === s ? 'selected' : ''}>${s === 'active' ? '利用中' : s === 'trial' ? 'トライアル' : '停止'}</option>`).join('')}
              </select></div>
            <div><label class="text-xs text-slate-400 block mb-1">請求状態</label>
              <select id="cd-billing" class="inp" ${darkInp}>
                ${['active', 'overdue', 'suspended'].map(s => `<option value="${s}" ${c.billing_status === s ? 'selected' : ''}>${s === 'active' ? '正常' : s === 'overdue' ? '滞納' : '停止'}</option>`).join('')}
              </select></div>
          </div>
          <div><label class="text-xs text-slate-400 block mb-1">運営成熟度 (1-5)</label>
            <input id="cd-maturity" type="range" min="1" max="5" value="${Number(c.maturity_level) || 1}" class="w-full"></div>
          <div><label class="text-xs text-slate-400 block mb-1">伴走支援メモ</label>
            <textarea id="cd-memo" rows="3" maxlength="5000" class="inp" ${darkInp}>${esc(c.support_memo || '')}</textarea></div>
          <button class="btn btn-primary w-full" style="background:#0e7490" data-action="hqSaveCompany" data-cid="${Number(cid)}">保存する</button>
        </div>
      </section>

      <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <div class="flex items-center justify-between mb-3 gap-2">
          <h3 class="font-bold"><i class="fas fa-users text-cyan-400 mr-1"></i>ユーザー一覧 <span class="text-sm font-normal text-slate-300">課金対象 ${Number(usage.user_count)}名／全 ${data.users.length}行</span></h3>
          <button class="btn btn-outline text-xs" style="border-color:#334155;color:#67e8f9" data-action="hqAddAdmin" data-cid="${Number(cid)}"><i class="fas fa-plus"></i>管理者を追加</button>
        </div>
        <p class="text-[11px] text-slate-400 mb-2">課金対象は、利用中でログインできる人（退職・停止とログインなしの行を除く）です。${usage.linked_count ? `うち${Number(usage.linked_count)}名は他社から連携したスタッフです。` : ''}管理者のメールアドレスは、承認依頼の通知とパスワード再設定の宛先です。スタッフのパスワードは各社の管理画面（スタッフ詳細）で再発行します。</p>
        <div class="flex flex-wrap gap-1 mb-2">
          ${Object.entries(HQ_USER_FILTERS).map(([k, v]) => `<button class="text-xs px-2 py-1 rounded-lg border ${HQ_USER_FILTER === k ? 'border-cyan-500 text-cyan-300' : 'border-slate-600 text-slate-400'}" data-action="hqUserFilter" data-filter="${k}" data-cid="${Number(cid)}">${v}（${k ? data.users.filter(u => hqUserState(u).key === k).length : data.users.length}）</button>`).join('')}
        </div>
        <div class="max-h-96 overflow-y-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-slate-400 border-b border-slate-700">
              <th class="text-left py-2">ID</th><th class="text-left py-2">氏名</th><th class="text-left py-2">権限</th><th class="text-left py-2">状態</th><th class="text-left py-2">メール</th><th class="text-left py-2">最終ログイン</th><th></th>
            </tr></thead>
            <tbody id="hq-user-body">${hqUserRows(data.users, cid)}</tbody>
          </table>
        </div>
      </section>
    </div>`
}
function hqUserRows(users, cid) {
  const rows = users.filter(u => !HQ_USER_FILTER || hqUserState(u).key === HQ_USER_FILTER)
  return rows.map(u => {
    const st = hqUserState(u)
    return `
    <tr class="border-b border-slate-700/40">
      <td class="py-2 text-slate-400">${esc(u.user_code)}</td>
      <td class="py-2">${esc(u.name)}${u.must_change_password && HQ_ADMIN_ROLES.includes(u.role) ? ' <span class="badge badge-yellow">仮パスワード</span>' : ''}</td>
      <td class="py-2"><span class="badge ${u.role === 'staff' || u.role === 'roster_only' ? 'badge-gray' : 'badge-blue'}">${esc(ROLE_LABELS[u.role] || u.role)}</span></td>
      <td class="py-2 whitespace-nowrap"><span class="badge ${st.cls}">${st.label}</span>${u.linked ? ' <span class="badge badge-blue">他社連携</span>' : ''}</td>
      <td class="py-2 text-slate-400">${HQ_ADMIN_ROLES.includes(u.role) ? (u.email ? esc(u.email) : '<span class="text-amber-400">未登録</span>') : ''}</td>
      <td class="py-2 text-slate-400">${u.last_login_at ? dayjs(String(u.last_login_at).replace(' ', 'T')).format('M/D HH:mm') : '-'}</td>
      <td class="py-2 text-right whitespace-nowrap">${HQ_ADMIN_ROLES.includes(u.role) ? `<button class="text-cyan-400 hover:underline" data-action="hqManageAdmin" data-cid="${Number(cid)}" data-id="${Number(u.user_id)}">管理</button>` : ''}</td>
    </tr>`
  }).join('') || '<tr><td colspan="7" class="py-6 text-center text-slate-400">該当する利用者はいません</td></tr>'
}
delegate('hqUserFilter', (el) => {
  HQ_USER_FILTER = el.dataset.filter || ''
  document.querySelectorAll('[data-action="hqUserFilter"]').forEach(b => {
    const on = b.dataset.filter === HQ_USER_FILTER
    b.classList.toggle('border-cyan-500', on); b.classList.toggle('text-cyan-300', on)
    b.classList.toggle('border-slate-600', !on); b.classList.toggle('text-slate-400', !on)
  })
  const body = document.getElementById('hq-user-body')
  if (body) body.innerHTML = hqUserRows([...HQ_USERS.values()], Number(el.dataset.cid))
})

delegate('hqSaveCompany', (el) => {
  const cid = Number(el.dataset.cid)
  const status = document.getElementById('cd-status')
  const limitRaw = document.getElementById('cd-limit').value.trim()
  if (limitRaw && !(Number.isInteger(Number(limitRaw)) && Number(limitRaw) >= 1)) { hqMarkField('cd-limit', 'ユーザー上限は1以上の整数で入力してください（空欄にすると上限なし）'); return }
  // 停止にすると、その企業の利用者は全員ログアウトされ、ログインと報告用URLも使えなくなる
  if (status.value === 'inactive' && status.dataset.current !== 'inactive'
    && !confirm('この企業を「停止」にします。\nこの企業の管理者・スタッフは全員ログアウトされ、ログインも報告用URLも使えなくなります。よろしいですか？')) return
  withSubmitLock(el, async () => {
    try {
      const { data } = await axios.put('/api/hq/companies/' + cid, {
        plan: document.getElementById('cd-plan').value,
        // 空欄は上限なし（null）。0 として保存しない（#254）
        user_limit: limitRaw === '' ? null : Number(limitRaw),
        active_status: status.value,
        billing_status: document.getElementById('cd-billing').value,
        maturity_level: Number(document.getElementById('cd-maturity').value),
        support_memo: document.getElementById('cd-memo').value
      })
      toast(data.revoked_sessions ? `保存しました（${data.revoked_sessions}件のログインを終了しました）` : '保存しました')
      // 保存した内容（上限超過の表示など）を読み直す
      renderCompanyDetail(cid)
    } catch (e) {
      hqErr(e, e.response ? '保存に失敗しました。もう一度お試しください' : '通信できませんでした。保存されていない可能性があります')
    }
  })
})

// ============ 導入企業の管理者アカウント（#44 #25） ============
const HQ_ADMIN_ROLES = ['company_admin', 'sales_manager', 'field_manager', 'office_staff']
const HQ_ADMIN_ROLE_LABEL = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当' }
let HQ_USERS = new Map()
const hqErr = (e, fallback) => toast((e.response && e.response.data && e.response.data.error) || fallback)

delegate('hqAddAdmin', (el) => {
  const cid = Number(el.dataset.cid)
  modal(`
    <h3 class="font-bold text-lg mb-4 text-gray-800">管理者を追加</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-600 block mb-1">管理者ID *</label><input id="ha-code" class="inp"></div>
        <div><label class="text-xs text-gray-600 block mb-1">氏名 *</label><input id="ha-name" class="inp" maxlength="60"></div>
      </div>
      <div><label class="text-xs text-gray-600 block mb-1">メールアドレス</label><input id="ha-email" type="email" class="inp"></div>
      <div><label class="text-xs text-gray-600 block mb-1">権限</label><select id="ha-role" class="inp">${Object.entries(HQ_ADMIN_ROLE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <p class="text-[11px] text-gray-400">仮パスワードを自動で作ります。初回ログインで本人に変更を求めます。</p>
      <button class="btn btn-primary w-full" data-action="hqDoAddAdmin" data-cid="${cid}">追加する</button>
    </div>`)
})
delegate('hqDoAddAdmin', (el) => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid)
  const v = id => document.getElementById(id).value.trim()
  try {
    const { data } = await axios.post(`/api/hq/companies/${cid}/users`, { user_code: v('ha-code'), name: v('ha-name'), email: v('ha-email'), role: v('ha-role') })
    const code = v('ha-code'), name = v('ha-name')
    closeModal(); toast('管理者を追加しました'); renderCompanyDetail(cid)
    if (data.temp_password) showTempPassword('管理者を追加しました', data.temp_password, [`氏名: ${name}`, `管理者ID: ${code}`, `ログイン: ${location.origin}/login`])
  } catch (e) { hqErr(e, '追加に失敗しました') }
}))
delegate('hqManageAdmin', (el) => {
  const cid = Number(el.dataset.cid)
  const u = HQ_USERS.get(Number(el.dataset.id)); if (!u) return
  const active = u.status === 'active'
  modal(`
    <h3 class="font-bold text-lg mb-1 text-gray-800">${esc(u.name)}（${esc(u.user_code)}）</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(HQ_ADMIN_ROLE_LABEL[u.role] || u.role)} ・ ${active ? '利用中' : '停止中'}</p>
    <div class="space-y-3">
      <div><label class="text-xs text-gray-600 block mb-1">メールアドレス（通知・パスワード再設定の宛先）</label>
        <div class="flex gap-2"><input id="hm-email" type="email" class="inp flex-1" value="${esc(u.email || '')}">
          <button class="btn btn-outline text-xs" data-action="hqSaveAdminEmail" data-cid="${cid}" data-id="${u.user_id}">保存</button></div></div>
      ${active ? `
        <p class="text-xs font-bold text-gray-600 pt-1">パスワードの再発行（今のパスワードは使えなくなり、ログイン中の画面もログアウトされます）</p>
        ${u.email ? `<button class="btn btn-outline w-full" data-action="hqResetAdmin" data-cid="${cid}" data-id="${u.user_id}" data-mode="email"><i class="fas fa-envelope"></i>再設定メールを送る</button>` : ''}
        <button class="btn btn-outline w-full" data-action="hqResetAdmin" data-cid="${cid}" data-id="${u.user_id}" data-mode="temp"><i class="fas fa-key"></i>仮パスワードを発行する</button>` : ''}
      <button class="btn ${active ? 'btn-outline text-red-600' : 'btn-primary'} w-full" data-action="hqToggleAdmin" data-cid="${cid}" data-id="${u.user_id}">${active ? 'このアカウントを停止する' : '利用を再開する'}</button>
      <button class="btn btn-outline w-full" onclick="closeModal()">閉じる</button>
    </div>`)
})
delegate('hqSaveAdminEmail', (el) => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid)
  try {
    await axios.put(`/api/hq/companies/${cid}/users/${Number(el.dataset.id)}`, { email: document.getElementById('hm-email').value.trim() })
    closeModal(); toast('メールアドレスを保存しました'); renderCompanyDetail(cid)
  } catch (e) { hqErr(e, '保存に失敗しました') }
}))
delegate('hqResetAdmin', (el) => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid)
  const u = HQ_USERS.get(Number(el.dataset.id)); if (!u) return
  try {
    const { data } = await axios.post(`/api/hq/companies/${cid}/users/${u.user_id}/reset-password`, { mode: el.dataset.mode })
    closeModal(); renderCompanyDetail(cid)
    if (data.mode === 'email') toast(data.skipped ? 'メール送信が無効の環境のため、送信を省略しました' : 'パスワード再設定メールを送りました')
    else showTempPassword('仮パスワードを発行しました', data.temp_password, [`氏名: ${u.name}`, `管理者ID: ${u.user_code}`, `ログイン: ${location.origin}/login`])
  } catch (e) { hqErr(e, '再発行に失敗しました') }
}))
delegate('hqToggleAdmin', (el) => {
  const cid = Number(el.dataset.cid)
  const u = HQ_USERS.get(Number(el.dataset.id)); if (!u) return
  const next = u.status === 'active' ? 'suspended' : 'active'
  if (next === 'suspended' && !confirm(`${u.name}（${u.user_code}）のアカウントを停止します。ログイン中の画面もすぐに使えなくなります。よろしいですか？`)) return
  withSubmitLock(el, async () => {
    try {
      await axios.put(`/api/hq/companies/${cid}/users/${u.user_id}`, { status: next })
      closeModal(); toast(next === 'suspended' ? '停止しました' : '利用を再開しました'); renderCompanyDetail(cid)
    } catch (e) { hqErr(e, '変更に失敗しました') }
  })
})

// ============ テンプレート配信 ============
const TPL_TYPE_LABEL = { number: '数値（件数の集計に使う）', text: '1行のテキスト', textarea: '複数行のテキスト' }
async function renderTemplates() {
  loading()
  let data
  try { data = (await axios.get('/api/hq/templates')).data } catch (e) {
    $app.innerHTML = `<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-sm text-slate-300">テンプレートを読み込めませんでした。<button class="btn btn-outline ml-2" style="border-color:#334155;color:#67e8f9" onclick="renderTemplates()">再試行</button></div>`
    return
  }
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold">テンプレート配信管理</h2>
      <button class="btn btn-primary" style="background:#0e7490" onclick="showAddTemplate()"><i class="fas fa-plus"></i>テンプレート作成</button>
    </div>
    <p class="text-sm text-slate-400 mb-4">本部テンプレートは全導入企業の案件設定で選択可能になります。</p>
    <div class="grid md:grid-cols-2 gap-4">
      ${data.templates.map(t => `
        <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-bold">${esc(t.template_name)}</h3>
            <span class="badge ${t.template_type === 'hq' ? 'badge-blue' : 'badge-gray'}">${t.template_type === 'hq' ? '本部配信' : '企業独自'}</span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${t.fields.map(f => `<span class="text-xs px-2 py-0.5 rounded-full ${f.type === 'number' ? 'bg-cyan-900 text-cyan-300' : 'bg-slate-700 text-slate-300'}" title="${esc(f.key)}">${esc(f.label)}</span>`).join('')}
          </div>
          <p class="text-xs text-slate-500 mt-2">項目数: ${t.fields.length}（数値 ${t.fields.filter(f => f.type === 'number').length} / テキスト ${t.fields.filter(f => f.type !== 'number').length}）</p>
        </section>`).join('')}
    </div>`
}

// 項目の定義（1行1項目: キー,表示名,タイプ[,必須]）を読み、問題を行ごとに返す。
// サーバー（src/lib/report-template.ts）と同じ規則。保存の前にプレビューで示す（#378）
const TPL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
const TPL_RESERVED = ['incident_note', 'complaint_note', 'incident_flag', 'complaint_flag', 'constructor', 'prototype', 'toString', 'hasOwnProperty']
function parseTemplateLines(text) {
  const seen = new Set()
  const rows = String(text || '').split('\n').map((l, i) => ({ line: i + 1, raw: l.trim() })).filter(r => r.raw).map(r => {
    const [key = '', label = '', type = '', req = ''] = r.raw.split(',').map(s => s.trim())
    const f = { key, label: label || key, type: type || 'text' }
    if (['必須', 'required', '*'].includes(req)) f.required = true
    const errors = []
    if (!key) errors.push('キーが空欄です')
    else if (!TPL_KEY_RE.test(key)) errors.push('キーは半角英字で始まる英数字と _ の40文字以内にしてください')
    else if (TPL_RESERVED.includes(key)) errors.push('このキーは日報の別の用途で使っているため使えません')
    else if (seen.has(key.toLowerCase())) errors.push('キーが重複しています')
    if (key) seen.add(key.toLowerCase())
    if (!TPL_TYPE_LABEL[f.type]) errors.push(`タイプ「${f.type}」は使えません（number / text / textarea）`)
    if (f.label.length > 40) errors.push('表示名は40文字以内にしてください')
    if (req && !f.required) errors.push('4つ目の欄は「必須」と書くか、空けてください')
    return { line: r.line, field: f, errors }
  })
  return rows
}
function renderTemplatePreview() {
  const box = document.getElementById('tp-preview'); if (!box) return
  const rows = parseTemplateLines(document.getElementById('tp-fields').value)
  const bad = rows.filter(r => r.errors.length).length
  box.innerHTML = !rows.length ? '<p class="text-xs text-red-600">項目を1つ以上入力してください</p>' : `
    <table class="w-full text-xs text-gray-700">
      <thead><tr class="text-gray-400 border-b"><th class="text-left py-1">行</th><th class="text-left py-1">キー</th><th class="text-left py-1">表示名</th><th class="text-left py-1">入力欄</th><th class="text-left py-1">必須</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr class="border-b ${r.errors.length ? 'bg-red-50' : ''}">
          <td class="py-1">${r.line}</td><td class="py-1 font-mono">${esc(r.field.key)}</td><td class="py-1">${esc(r.field.label)}</td>
          <td class="py-1">${esc(TPL_TYPE_LABEL[r.field.type] || r.field.type)}</td><td class="py-1">${r.field.required ? '必須' : ''}</td>
        </tr>${r.errors.length ? `<tr class="bg-red-50"><td></td><td colspan="4" class="pb-1 text-red-600">${r.errors.map(esc).join(' / ')}</td></tr>` : ''}`).join('')}
      </tbody>
    </table>
    <p class="text-[11px] mt-1 ${bad ? 'text-red-600' : 'text-gray-500'}">${bad ? `${bad}行に問題があります。直してから配信してください` : `${rows.length}項目（数値 ${rows.filter(r => r.field.type === 'number').length}）。この内容で全導入企業に配信します`}</p>`
}

window.showAddTemplate = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4 text-gray-800">テンプレート作成</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">テンプレート名 *</label><input id="tp-name" class="inp" maxlength="60" placeholder="コールセンター稼働テンプレート"></div>
      <div><label class="text-sm text-gray-600 block mb-1">項目定義（1行1項目: キー,表示名,タイプ[,必須]）</label>
        <textarea id="tp-fields" rows="8" class="inp text-xs font-mono">calls,架電数,number
connects,接続数,number
seiyaku,成約数,number
free,自由記述,textarea</textarea>
        <p class="text-xs text-gray-400 mt-1">キー: 半角英字で始まる英数字と _（日報の値の保存に使うので、配信後は変えないでください）。タイプ: number（数値・件数の集計に使う）/ text / textarea。必須にする項目は4つ目に「必須」と書きます</p></div>
      <div id="tp-preview" class="border rounded-lg p-2 max-h-56 overflow-y-auto"></div>
      <button class="btn btn-primary w-full" data-action="addTemplate">作成して配信する</button>
    </div>`)
  document.getElementById('tp-fields').addEventListener('input', renderTemplatePreview)
  renderTemplatePreview()
}
delegate('addTemplate', (el) => withSubmitLock(el, async () => {
  const name = document.getElementById('tp-name').value.trim()
  if (!name) { hqMarkField('tp-name', 'テンプレート名を入力してください'); return }
  const rows = parseTemplateLines(document.getElementById('tp-fields').value)
  if (!rows.length) { hqMarkField('tp-fields', '項目を1つ以上入力してください'); return }
  const bad = rows.find(r => r.errors.length)
  if (bad) { renderTemplatePreview(); hqMarkField('tp-fields', `${bad.line}行目: ${bad.errors[0]}`); return }
  try {
    await axios.post('/api/hq/templates', { template_name: name, fields: rows.map(r => r.field) })
    closeModal(); toast('テンプレートを配信しました'); renderTemplates()
  } catch (e) {
    hqErr(e, e.response ? '配信に失敗しました' : '通信できませんでした。接続を確かめて、もう一度お試しください')
  }
}))

// ============ データ保持（定期削除） ============
const RETENTION_TARGET_LABEL = {
  daily_reports: '日報（3年）', attendance_reports: '出退勤記録（退職後7年）', shifts: 'シフト（退職後7年）',
  evaluations: '人事評価（退職後7年）', follow_logs: 'やり取り履歴（退職後7年）', consultations: '相談内容（退職後7年）',
  r2_photos: 'R2写真（退職後7年）', shift_report_tokens: '報告用URL（退職後7年）', retired_staff: '退職スタッフ（人数・退職後7年）',
  user_notifications: 'アプリ内通知（2年）', attendance_corrections: '打刻修正申請（退職後7年）', attendance_correction_events: '打刻修正の操作履歴（退職後7年）',
  notification_emails: '通知メールの送信状態（退職後7年）', report_setting_logs: '報告設定の変更履歴（退職後7年）', project_staff_report_settings: '報告設定（スタッフ別・退職後7年）',
  employee_records: '従業員データ（口座・住所・給与・緊急連絡先。退職後7年）', employment_periods: '過去の雇用期間（退職後7年）',
  staff_documents: '履歴書など（退職後7年）', employee_documents: '入社時書類（退職後7年）', r2_documents: 'R2書類ファイル（退職後7年）',
  roster_comments: '企業間チャット（退職後7年）', roster_comment_reads: '企業間チャットの既読位置（退職後7年）', roster_consents: '連携の同意履歴（退職後7年）',
  anonymized_staff: '本人情報の匿名化（退職後7年）',
}
const RETENTION_TRIGGER_LABEL = { cron: '定期処理', manual: '手動' }
// 次回削除予定・対象外の一覧（退職日の入力誤りに気づけるよう、削除前に本部で確認できるようにする）
function retentionScheduleHtml(sch) {
  const row = (s, note) => `
    <tr>
      <td class="text-xs">${esc(s.company_name || '-')}</td>
      <td>${esc(s.name || '-')} <span class="text-xs text-slate-500">#${esc(s.staff_id)}</span></td>
      <td class="text-xs">${esc(s.retired_at || '-')}</td>
      <td class="text-xs">${esc(s.last_work_date || '-')}</td>
      <td class="text-xs">${note}</td>
    </tr>`
  const table = (rows, empty) => `
    <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>会社</th><th>スタッフ</th><th>退職日</th><th>最終稼働日</th><th>状況</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="text-center text-slate-500 py-4">${empty}</td></tr>`}</tbody>
      </table>
    </div>`
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <h3 class="font-bold mb-1">次回削除予定</h3>
      <p class="text-xs text-slate-400 mb-3">初めて対象になったスタッフは${esc(sch.grace_days)}日間削除せずに猶予します。退職日に誤りがあれば、猶予中に各社で退職日を直してください（直すと猶予をやり直します）。</p>
      ${table(sch.scheduled.map(s => row(s, s.delete_on
        ? `<span class="text-amber-400">${esc(s.delete_on)} 以降の定期削除で削除</span>`
        : '<span class="text-slate-400">次回の定期削除で猶予を開始</span>')).join(''), '削除予定のスタッフはいません')}
    </section>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <h3 class="font-bold mb-1">対象外（退職日より後にシフトあり）</h3>
      <p class="text-xs text-slate-400 mb-3">退職日の入力誤りの可能性があるため削除しません。各社に退職日の確認を依頼してください。</p>
      ${table(sch.excluded.map(s => row(s, '<span class="text-red-400">退職日より後にシフトあり</span>')).join(''), '該当するスタッフはいません')}
    </section>`
}
function retentionDryRunHtml(data) {
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-3">dry-run結果（削除は実行していません。猶予中のスタッフも含みます）</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${data.results.map(r => `
          <div class="bg-slate-900 rounded-lg p-3">
            <p class="text-xs text-slate-400">${RETENTION_TARGET_LABEL[r.target] || esc(r.target)}</p>
            <p class="text-lg font-bold ${r.targetCount > 0 ? 'text-amber-400' : ''}">${esc(r.targetCount)}件</p>
            ${r.failedCount > 0 ? `<p class="text-xs text-red-400">集計に失敗しました</p>` : ''}
          </div>`).join('')}
      </div>
    </section>`
}
async function renderRetention(dryRunResult) {
  loading()
  const [{ data }, sch, cron] = await Promise.all([
    axios.get('/api/hq/retention/logs'),
    axios.get('/api/hq/retention/schedule').then(r => r.data).catch(() => null),
    axios.get('/api/hq/cron/status').then(r => r.data).catch(() => null),
  ])
  renderCronAlert(cron)
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h2 class="text-xl font-bold">データ保持・定期処理</h2>
        <p class="text-sm text-slate-400 mt-1">日報は3年、出退勤記録・シフト・評価・やり取り・相談・R2写真・従業員データ（口座・住所・給与など）・履歴書や入社時書類・企業間チャット・連携の同意履歴は退職後7年で自動削除し、氏名・連絡先などの本人情報は匿名化します（毎日Cronで実行）。</p>
      </div>
      <button class="btn btn-outline" data-action="runRetentionDryRun"><i class="fas fa-magnifying-glass"></i>dry-run実行（削除せず対象件数を確認）</button>
    </div>
    ${cron ? cronStatusHtml(cron) : '<p class="text-sm text-red-400 mb-5">定期処理の実行記録の取得に失敗しました</p>'}
    <div id="retention-dryrun-result" class="mb-5">${dryRunResult ? retentionDryRunHtml(dryRunResult) : ''}</div>
    ${sch ? retentionScheduleHtml(sch) : '<p class="text-sm text-red-400 mb-5">次回削除予定の取得に失敗しました</p>'}
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-3">直近の実行ログ</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>実行日時</th><th>実行元</th><th>対象</th><th>種別</th><th>対象件数</th><th>削除件数</th><th>失敗</th><th>所要時間</th></tr></thead>
          <tbody>
            ${data.logs.length === 0 ? '<tr><td colspan="8" class="text-center text-slate-500 py-4">実行履歴がありません</td></tr>' : data.logs.map(l => `
              <tr>
                <td class="text-xs">${l.finished_at ? dayjs(l.finished_at).format('YYYY/M/D HH:mm') : '-'}</td>
                <td class="text-xs">${esc(RETENTION_TRIGGER_LABEL[l.trigger_source] || '-')}${l.triggered_by_name ? `<br><span class="text-slate-500">${esc(l.triggered_by_name)}</span>` : ''}</td>
                <td>${esc(RETENTION_TARGET_LABEL[l.target] || l.target)}</td>
                <td><span class="badge ${l.dry_run ? 'badge-gray' : 'badge-blue'}">${l.dry_run ? 'dry-run' : '実削除'}</span></td>
                <td>${esc(l.target_count)}</td>
                <td>${esc(l.deleted_count)}</td>
                <td>${l.failed_count > 0 ? `<span class="text-red-400">${esc(l.failed_count)}</span>` : '0'}</td>
                <td class="text-xs">${l.duration_ms == null ? '-' : esc(formatDuration(l.duration_ms))}</td>
              </tr>${l.error_message ? `
              <tr><td colspan="8" class="text-xs text-red-400" style="white-space:pre-wrap;word-break:break-all">失敗の理由: ${esc(l.error_message)}</td></tr>` : ''}`).join('')}
          </tbody>
        </table>
      </div>
    </section>`
}
// 二重に実行しないよう、実行中はボタンを無効にする
delegate('runRetentionDryRun', el => withSubmitLock(el, async () => {
  const box = document.getElementById('retention-dryrun-result')
  box.innerHTML = '<div class="flex justify-center py-6"><span class="spin"></span></div>'
  try {
    const { data } = await axios.post('/api/hq/retention/dry-run')
    toast('dry-runが完了しました')
    // 実行ログも新しくするため描き直す（結果は消さずに残す）
    await renderRetention(data)
  } catch (e) {
    box.innerHTML = ''
    showApiError(e, 'dry-runの実行に失敗しました')
  }
}))

// ============ 定期処理（cron）の実行記録（#192） ============
function formatDuration(ms) {
  const n = Number(ms) || 0
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}秒`
}
// 処理の結果（result_json）の項目名
const CRON_RESULT_LABEL = {
  deleted: '削除', target: '対象', failed: '失敗', dry_run: 'dry-run', sessions: 'セッション', attempts: 'ログイン試行',
  applied: '適用', due: '予約', not_applied: '適用できず', notices: 'お知らせ', batches: '回数',
  companies: '集計した会社', remaining: '残りの会社', ok: '成功', finalized: '確定',
}
function cronResultText(json) {
  let r = null
  try { r = JSON.parse(json || 'null') } catch { return '' }
  if (!r || typeof r !== 'object') return ''
  return Object.entries(r).filter(([k, v]) => k !== 'error' && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${CRON_RESULT_LABEL[k] || k}: ${v === true ? 'はい' : v === false ? 'いいえ' : v}`).join(' / ')
}
function cronStatusBadge(status) {
  return status === 'ok' ? '<span class="badge badge-green">成功</span>' : '<span class="badge badge-red">失敗</span>'
}
function cronRunRow(r) {
  return `
    <tr>
      <td class="text-xs">${r.started_at ? esc(dayjs(r.started_at).format('YYYY/M/D HH:mm')) : '-'}</td>
      <td>${esc(r.label || r.job)}</td>
      <td>${cronStatusBadge(r.status)}</td>
      <td class="text-xs">${r.duration_ms == null ? '-' : esc(formatDuration(r.duration_ms))}</td>
      <td class="text-xs">${esc(cronResultText(r.result_json))}${r.error_message ? `<div class="text-red-400" style="white-space:pre-wrap;word-break:break-all">${esc(r.error_message)}</div>` : ''}</td>
    </tr>`
}
function cronStatusHtml(cron) {
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <h3 class="font-bold mb-1">定期処理の実行状況</h3>
      <p class="text-xs text-slate-400 mb-3">毎日 日本時間3:00（削除・退職の適用など）と3:30（既読率レポートの集計）に実行します。処理ごとの最後の実行です。</p>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>最終実行</th><th>処理</th><th>結果</th><th>所要時間</th><th>内容</th></tr></thead>
          <tbody>${cron.latest.length ? cron.latest.map(cronRunRow).join('') : '<tr><td colspan="5" class="text-center text-slate-500 py-4">実行記録がありません</td></tr>'}</tbody>
        </table>
      </div>
      <details class="mt-3">
        <summary class="text-xs text-slate-400 cursor-pointer">直近の実行記録（${esc(cron.recent.length)}件）</summary>
        <div class="overflow-x-auto mt-2">
          <table class="tbl">
            <thead><tr><th>実行日時</th><th>処理</th><th>結果</th><th>所要時間</th><th>内容</th></tr></thead>
            <tbody>${cron.recent.map(cronRunRow).join('')}</tbody>
          </table>
        </div>
      </details>
    </section>`
}
// 定期処理の失敗・停止の警告を、どのタブでも画面の上部に出す
function renderCronAlert(cron) {
  let box = document.getElementById('hq-cron-alert')
  if (!box) {
    box = document.createElement('div')
    box.id = 'hq-cron-alert'
    box.className = 'max-w-7xl mx-auto p-4 md:p-6'
    box.style.paddingBottom = '0'
    $app.parentNode.insertBefore(box, $app)
  }
  const warnings = (cron && cron.warnings) || []
  box.innerHTML = warnings.length ? `
    <div class="bg-slate-800 border rounded-xl p-3 text-sm" style="border-color:#ef4444">
      <p class="font-bold text-red-400"><i class="fas fa-triangle-exclamation mr-1"></i>定期処理の確認が必要です</p>
      <ul class="mt-1 text-xs">${warnings.map(w => `<li>・${esc(w.message)}</li>`).join('')}</ul>
      <a href="#retention" class="text-cyan-400 text-xs hover:underline">データ保持・定期処理を開く →</a>
    </div>` : ''
  box.style.display = warnings.length ? '' : 'none'
}
async function refreshCronAlert() {
  try { renderCronAlert((await axios.get('/api/hq/cron/status')).data) } catch { }
}

// ============ 伴走支援 ============
async function renderSupport() {
  loading()
  const { data } = await axios.get('/api/hq/companies')
  const MENU = [
    ['初期設定代行', 'fa-wrench', '導入時の各種マスタ・テンプレート設定を代行'],
    ['日報項目設計', 'fa-list-check', '案件特性に合わせた日報・実績項目の設計'],
    ['スタッフ研修', 'fa-chalkboard-user', '現場スタッフ向けの販売・接客研修'],
    ['管理者教育', 'fa-user-tie', '現場管理者の運営スキル向上支援'],
    ['月次運営レビュー', 'fa-magnifying-glass-chart', 'データに基づく月次の運営改善レビュー'],
    ['採用支援', 'fa-user-plus', '通信人材の採用ノウハウ提供'],
    ['スタッフ定着支援', 'fa-heart', '離職防止・定着率向上の仕組みづくり'],
    ['KPI設計', 'fa-bullseye', '案件・スタッフ別のKPI設計支援'],
  ]
  $app.innerHTML = `
    <h2 class="text-xl font-bold mb-5">伴走支援管理</h2>
    <div class="grid md:grid-cols-4 gap-3 mb-6">
      ${MENU.map(([t, i, d]) => `
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <i class="fas ${i} text-cyan-400 text-lg mb-2"></i>
          <p class="font-bold text-sm">${t}</p>
          <p class="text-xs text-slate-400 mt-1">${d}</p>
        </div>`).join('')}
    </div>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-3"><i class="fas fa-notes-medical text-cyan-400 mr-1"></i>企業別 伴走支援状況</h3>
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700">
          <th class="text-left px-3 py-2">企業</th><th class="text-center px-3 py-2">運営成熟度</th><th class="text-left px-3 py-2">伴走支援メモ</th><th></th>
        </tr></thead>
        <tbody>
          ${data.companies.map(c => `
            <tr class="border-b border-slate-700/40">
              <td class="px-3 py-3 font-medium">${esc(c.company_name)}</td>
              <td class="px-3 py-3 text-center">${'●'.repeat(c.maturity_level || 1)}${'○'.repeat(5 - (c.maturity_level || 1))}</td>
              <td class="px-3 py-3 text-slate-400 text-xs">${esc(c.support_memo || '-')}</td>
              <td class="px-3 py-3"><a href="#companies/${c.company_id}" class="text-cyan-400 text-xs hover:underline">編集 →</a></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>`
}

// ============ ルーティング ============
const routes = { companies: renderCompanies, templates: renderTemplates, retention: renderRetention, support: renderSupport }

function route() {
  const hash = (location.hash || '#companies').slice(1)
  const [tab, id] = hash.split('/')
  document.querySelectorAll('.hq-nav').forEach(el => el.classList.toggle('active', el.dataset.tab === tab))
  if (tab === 'companies' && id) return renderCompanyDetail(id)
  ;(routes[tab] || renderCompanies)()
}
window.addEventListener('hashchange', route)

;(async () => {
  try { HQ_ME = (await axios.get('/api/auth/me')).data } catch (e) { return }
  route()
  // データ保持のタブは自分で警告を描き直すので、それ以外のタブで開いたときに取る
  if (!/^#retention/.test(location.hash)) refreshCronAlert()
})()
