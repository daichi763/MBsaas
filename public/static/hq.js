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
  } else if (r && r.status === 403 && r.data && r.data.code === 'mfa_setup_required') {
    // 開いている間に二段階認証が必須になった（#544）: 登録の画面へ移す
    if (HQ_ME) HQ_ME.mfa_setup_required = true
    if (location.hash !== '#security') location.hash = 'security'
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
let HQ_RULES = { drop_rate: 0.3, drop_min_base: 10, no_shift_days: 14, due_soon_days: 7 }
let HQ_PLAN_PRICES = []
const HQ_FILTERS = {
  '': 'すべて', over_limit: '契約ユーザー数の超過', needs_attention: '利用が減った・止まっている', usage_drop: '利用が減った', no_recent_shift: 'シフト登録が止まっている',
  due: '期日が過ぎた・近い', trial_no_end: 'トライアル期限の未設定', payment_alert: '未入金・滞納', trial: 'トライアル', inactive: '停止'
}
const hqMatchFilter = (c, f) => !f ? true : f === 'needs_attention' ? !!(c.usage_drop || c.no_recent_shift) : f === 'due' ? !!c.due_state
  : (f === 'trial' || f === 'inactive') ? c.active_status === f : !!c[f]
// 料金の説明（プランごとの料金。#295）
const hqPriceText = p => `${yen(p.base_fee)}（${Number(p.included_users)}ユーザーまで）+ 追加1ユーザーごとに${yen(p.per_user_fee)}/月`
// 期日（YYYY-MM-DD）の表示。過ぎたものは赤、近いものは黄（#296）
const hqDue = (v, state) => !v ? '<span class="text-slate-500">-</span>'
  : `<span class="${state === 'past' ? 'text-red-400 font-bold' : state === 'soon' ? 'text-amber-300 font-bold' : ''}">${esc(dayjs(v).format('YYYY/M/D'))}</span>`
const BILLING_MONTH_LABEL = { issued: '請求済み（入金待ち）', paid: '入金済み', overdue: '滞納', waived: '請求しない' }
const BILLING_MONTH_BADGE = { issued: 'badge-yellow', paid: 'badge-green', overdue: 'badge-red', waived: 'badge-gray' }
// 増減率（前の30日と比べて）。前の期間が0なら出さない
const hqRate = r => r == null ? '' : `<span class="block text-[11px] ${r <= -0.3 ? 'text-red-400' : r < 0 ? 'text-amber-300' : 'text-emerald-400'}">${r > 0 ? '+' : ''}${Math.round(r * 100)}%</span>`
// utc: シフトの登録日時（created_at）は UTC で保存されているので、日本時間に直して出す
const hqDate = (v, utc) => v ? dayjs(String(v).replace(' ', 'T') + (utc ? 'Z' : '')).format('YYYY/M/D') : '<span class="text-slate-500">なし</span>'
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
  { key: 'last_admin_login_at', label: '管理者の最終利用' },
  { key: 'next_due', label: '次の期日' },
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
  HQ_PLAN_PRICES = data.plan_prices || []
  const list = data.companies
  const bill = data.billing
  // 前の月の請求をまだ記録していない企業があれば知らせる（#295）
  const billBanner = bill && bill.billable_companies && bill.prev_month_recorded < bill.billable_companies ? `
    <div class="bg-amber-900/30 border border-amber-700 text-amber-100 rounded-xl p-3 mb-4 text-sm flex flex-wrap items-center gap-2">
      <i class="fas fa-file-invoice-dollar"></i><span class="flex-1">${esc(dayjs(bill.prev_month + '-01').format('YYYY年M月'))}分の請求を記録していない企業があります（記録済み ${Number(bill.prev_month_recorded)}社 / 利用中 ${Number(bill.billable_companies)}社）。</span>
      <button class="btn btn-outline text-xs" style="border-color:#b45309;color:#fde68a" data-action="hqCloseBilling" data-month="${esc(bill.prev_month)}">今の人数で記録する</button>
    </div>` : ''
  const totalMRR = list.filter(c => c.active_status === 'active').reduce((a, c) => a + c.monthly_fee, 0)
  const kpi = (label, value, icon, filter) => `
    <div class="bg-slate-800 border border-slate-700 rounded-xl p-4 ${filter ? 'cursor-pointer hover:border-cyan-700' : ''}" ${filter ? `data-action="hqFilter" data-filter="${filter}"` : ''}>
      <p class="text-xs text-slate-400">${label}</p>
      <p class="text-2xl font-bold mt-0.5 truncate"><i class="fas ${icon} text-cyan-400 mr-2 text-lg"></i>${value}</p>
    </div>`

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold">導入企業管理</h2>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-outline" style="border-color:#334155;color:#67e8f9" data-action="hqAuditLogs"><i class="fas fa-clock-rotate-left"></i>本部の操作の履歴</button>
        <button class="btn btn-outline" style="border-color:#334155;color:#67e8f9" data-action="hqBillingMenu"><i class="fas fa-file-invoice-dollar"></i>請求の記録</button>
        <button class="btn btn-outline" style="border-color:#334155;color:#67e8f9" data-action="hqPlanPrices"><i class="fas fa-tags"></i>プランの料金</button>
        <button class="btn btn-primary" style="background:#0e7490" onclick="showAddCompany()"><i class="fas fa-plus"></i>企業登録</button>
      </div>
    </div>
    ${billBanner}
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${kpi('導入企業数', list.length + '社', 'fa-building')}
      ${kpi('課金対象企業', list.filter(c => c.active_status === 'active').length + '社', 'fa-circle-check')}
      ${kpi('月間収益(MRR)', yen(totalMRR), 'fa-yen-sign')}
      ${kpi('総ユーザー数', list.reduce((a, c) => a + (c.user_count || 0), 0) + '名', 'fa-users')}
      ${kpi('契約ユーザー数の超過', list.filter(c => c.over_limit).length + '社', 'fa-user-plus', 'over_limit')}
      ${kpi('利用が減った・止まっている', list.filter(c => c.usage_drop || c.no_recent_shift).length + '社', 'fa-arrow-trend-down', 'needs_attention')}
      ${kpi('期日が過ぎた・近い', list.filter(c => c.due_state).length + '社', 'fa-calendar-day', 'due')}
      ${kpi('未入金・滞納', list.filter(c => c.payment_alert).length + '社', 'fa-triangle-exclamation', 'payment_alert')}
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
    <p class="text-xs text-slate-500 mt-3"><i class="fas fa-circle-info mr-1"></i>料金: ${HQ_PLAN_PRICES.map(p => `${esc(PLAN_LABELS[p.plan] || p.plan)} ${hqPriceText(p)}`).join('、') || '-'}。ユーザー数は課金対象（利用中で、ログインできる人）の人数です。月額は今の人数で計算した見込みで、確定した額は企業詳細の請求の記録で確かめます</p>
    <p class="text-xs text-slate-500 mt-1"><i class="fas fa-circle-info mr-1"></i>週次アクティブは、課金対象の人のうち今日を含む直近7日にログイン・アプリの操作・アプリからの勤怠の報告があった人数です（他社から連携したスタッフは、報告した稼働先の企業で数えます）。次の期日は、トライアルの終了日（トライアル中のみ）と次回レビュー日の早いほうで、過ぎたものを赤、${Number(HQ_RULES.due_soon_days) || 7}日以内のものを黄で示します</p>
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
      c.due_state === 'past' ? '<span class="badge badge-red">期日超過</span>' : c.due_state === 'soon' ? '<span class="badge badge-yellow">期日が近い</span>' : '',
      c.trial_no_end ? '<span class="badge badge-gray">トライアル期限なし</span>' : '',
      c.overdue_months ? `<span class="badge badge-red">滞納${Number(c.overdue_months)}か月</span>` : c.payment_alert ? `<span class="badge badge-yellow">未入金${Number(c.unpaid_months)}か月</span>` : '',
    ].filter(Boolean).join(' ')
    return `
    <tr class="border-b border-slate-700/50 hover:bg-slate-700/30 cursor-pointer ${c.over_limit ? 'bg-red-900/20' : ''}" data-action="hqOpenCompany" data-cid="${Number(c.company_id)}">
      <td class="px-4 py-3 font-medium">${esc(c.company_name)}</td>
      <td class="px-3 py-3 text-slate-400">${esc(c.company_code)}</td>
      <td class="px-3 py-3">${esc(PLAN_LABELS[c.plan] || c.plan)}</td>
      <td class="px-3 py-3">${STATUS_BADGE[c.active_status] || ''}</td>
      <td class="px-3 py-3">${BILLING_BADGE[c.billing_status] || ''}</td>
      <td class="px-3 py-3 text-right whitespace-nowrap ${c.over_limit ? 'text-red-400 font-bold' : ''}">${Number(c.user_count) || 0}/${hqLimit(c)}</td>
      <td class="px-3 py-3 text-right">${Number(c.active_users) || 0}名</td>
      <td class="px-3 py-3 text-right whitespace-nowrap">${Number(c.reports_30d) || 0}件${hqRate(c.reports_change)}</td>
      <td class="px-3 py-3 text-right whitespace-nowrap">${Number(c.shifts_30d) || 0}件${hqRate(c.shifts_change)}</td>
      <td class="px-3 py-3 whitespace-nowrap">${hqDate(c.last_shift_created_at, true)}</td>
      <td class="px-3 py-3 whitespace-nowrap">${hqDate(c.last_admin_login_at)}</td>
      <td class="px-3 py-3 whitespace-nowrap">${hqDue(c.next_due, c.due_state)}</td>
      <td class="px-3 py-3 text-right font-bold text-cyan-400">${yen(c.monthly_fee)}</td>
      <td class="px-3 py-3 text-center whitespace-nowrap">${'●'.repeat(c.maturity_level || 1)}${'○'.repeat(5 - (c.maturity_level || 1))}</td>
      <td class="px-3 py-3 whitespace-nowrap">${flags}</td>
      <td class="px-3 py-3 text-cyan-400 text-xs whitespace-nowrap">詳細 →</td>
    </tr>`
  }).join('') || `<tr><td colspan="${HQ_COLUMNS.length + 2}" class="px-4 py-8 text-center text-slate-400">条件に合う企業はありません</td></tr>`
  const cnt = document.getElementById('hq-co-count')
  if (cnt) cnt.textContent = `${rows.length}社 / 全${HQ_COMPANIES.length}社`
}
delegate('hqOpenCompany', (el) => { location.hash = 'companies/' + Number(el.dataset.cid) })
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

// ---------- 請求の記録（#295） ----------
// 月を締めると、利用中の企業ごとに、その時点の課金対象の人数・プラン・金額を記録する（記録済みの企業は変えない）
delegate('hqBillingMenu', () => {
  const last = dayjs().subtract(1, 'month').format('YYYY-MM')
  modal(`
    <h3 class="font-bold text-lg mb-2 text-gray-800">請求の記録</h3>
    <p class="text-xs text-gray-500 mb-3">指定した月の請求を、利用中の企業ごとに記録します。人数は記録する時点の課金対象の人数で、金額はプランの料金で計算します。すでに記録のある企業は変えません（金額・入金状態は企業詳細で直します）。トライアル・停止中の企業は記録しません。</p>
    <label class="text-xs text-gray-600 block mb-1">記録する月</label>
    <input id="bill-month" type="month" class="inp mb-3" value="${esc(last)}" max="${esc(dayjs().format('YYYY-MM'))}">
    <div class="flex gap-2">
      <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
      <button class="btn btn-primary flex-1" data-action="hqCloseBilling">記録する</button>
    </div>`)
})
delegate('hqCloseBilling', (el) => {
  const input = document.getElementById('bill-month')
  const month = el.dataset.month || (input && input.value)
  if (!/^\d{4}-\d{2}$/.test(month || '')) { toast('月を選んでください'); return }
  if (!confirm(`${dayjs(month + '-01').format('YYYY年M月')}分の請求を、今の課金対象の人数で記録します。よろしいですか？`)) return
  withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post('/api/hq/billing/close', { month })
      closeModal(); toast(data.created ? `${data.created}社の請求を記録しました` : '新しく記録する企業はありませんでした（すべて記録済み）')
      renderCompanies()
    } catch (e) { hqErr(e, '記録できませんでした') }
  })
})

// ---------- プランの料金（#295） ----------
delegate('hqPlanPrices', async () => {
  let prices = HQ_PLAN_PRICES
  try { prices = (await axios.get('/api/hq/plan-prices')).data.prices } catch { }
  modal(`
    <h3 class="font-bold text-lg mb-2 text-gray-800">プランの料金</h3>
    <p class="text-xs text-gray-500 mb-3">月額 = 基本料金（含む人数まで）+ 超えた1人ごとの料金。変更すると、企業一覧の月額と、これから記録する請求に使います（記録済みの請求は変わりません）。</p>
    <table class="w-full text-sm text-gray-800">
      <thead><tr class="text-xs text-gray-500"><th class="text-left py-1">プラン</th><th class="text-left">基本料金（円）</th><th class="text-left">含む人数</th><th class="text-left">追加1人（円）</th></tr></thead>
      <tbody>${prices.map(p => `
        <tr data-plan="${esc(p.plan)}">
          <td class="py-1 pr-2 whitespace-nowrap">${esc(PLAN_LABELS[p.plan] || p.plan)}</td>
          <td class="pr-2"><input class="inp pp-base" type="number" min="0" step="1" value="${Number(p.base_fee)}"></td>
          <td class="pr-2"><input class="inp pp-inc" type="number" min="0" step="1" value="${Number(p.included_users)}"></td>
          <td><input class="inp pp-per" type="number" min="0" step="1" value="${Number(p.per_user_fee)}"></td>
        </tr>`).join('')}</tbody>
    </table>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
      <button class="btn btn-primary flex-1" data-action="hqSavePlanPrices">保存する</button>
    </div>`)
})
delegate('hqSavePlanPrices', (el) => withSubmitLock(el, async () => {
  const prices = [...document.querySelectorAll('tr[data-plan]')].map(tr => ({
    plan: tr.dataset.plan,
    base_fee: Number(tr.querySelector('.pp-base').value), included_users: Number(tr.querySelector('.pp-inc').value), per_user_fee: Number(tr.querySelector('.pp-per').value),
  }))
  if (prices.some(p => [p.base_fee, p.included_users, p.per_user_fee].some(v => !Number.isInteger(v) || v < 0))) { toast('料金と人数は0以上の整数で入力してください'); return }
  try {
    const { data } = await axios.put('/api/hq/plan-prices', { prices })
    closeModal(); toast(data.changed ? '料金を保存しました' : '変更はありませんでした'); renderCompanies()
  } catch (e) { hqErr(e, '保存できませんでした') }
}))

// ---------- 本部の操作の履歴（#542） ----------
const HQ_AUDIT_ACTION = {
  'company.create': '企業の登録', 'company.update': '企業の変更', 'plan_price.update': 'プランの料金の変更', 'billing.close': '請求の記録（月の締め）',
  'billing.update': '請求の記録の修正', 'support_log.add': '伴走支援の記録', 'security.reset_mfa': '二段階認証の解除', 'security.clear_ip': '接続元の制限の解除',
}
const HQ_AUDIT_FIELD = {
  company_name: '会社名', plan: 'プラン', user_limit: 'ユーザー上限', active_status: '利用状態', billing_status: '請求状態', maturity_level: '運営成熟度',
  support_memo: '伴走支援メモ', trial_ends_at: 'トライアルの終了日', contract_start_at: '契約開始日', next_review_at: '次回レビュー日',
  contact_name: '担当者', contact_phone: '電話', contact_email: 'メール', billing_address: '請求先の住所',
  status: '入金状態', amount: '金額', paid_at: '入金日', note: 'メモ', created: '記録した企業数', mfa_enabled: '二段階認証',
  base_fee: '基本料金', included_users: '含む人数', per_user_fee: '追加1人',
}
const HQ_AUDIT_VALUE = {
  plan: PLAN_LABELS, active_status: { active: '利用中', trial: 'トライアル', inactive: '停止' }, billing_status: { active: '正常', overdue: '滞納', suspended: '停止' },
  status: BILLING_MONTH_LABEL,
}
function hqAuditValue(k, v) {
  if (v == null || v === '') return '（なし）'
  if (typeof v === 'boolean') return v ? 'あり' : 'なし'
  if (typeof v === 'object') return Object.entries(v).map(([kk, vv]) => `${HQ_AUDIT_FIELD[kk] || kk}: ${vv == null ? '（なし）' : vv}`).join('・')
  const s = (HQ_AUDIT_VALUE[k] && HQ_AUDIT_VALUE[k][v]) || String(v)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}
// 変更前 → 変更後 を項目ごとに1行で出す
function hqAuditDiff(l) {
  let before = {}, after = {}
  try { before = JSON.parse(l.before_json || '{}') || {} } catch { }
  try { after = JSON.parse(l.after_json || '{}') || {} } catch { }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys.map(k => `<div><span class="text-gray-500">${esc(HQ_AUDIT_FIELD[k] || PLAN_LABELS[k] || k)}:</span> ${l.before_json ? `${esc(hqAuditValue(k, before[k]))} → ` : ''}${esc(hqAuditValue(k, after[k]))}</div>`).join('')
}
function hqAuditRow(l, withCompany) {
  return `<tr class="border-b border-gray-100 align-top">
    <td class="py-2 pr-2 whitespace-nowrap text-gray-500">${esc(dayjs(String(l.created_at).replace(' ', 'T')).format('YYYY/M/D HH:mm'))}</td>
    <td class="py-2 pr-2 whitespace-nowrap">${esc(l.actor_name || '-')}</td>
    ${withCompany ? `<td class="py-2 pr-2">${esc(l.company_name || '')}</td>` : ''}
    <td class="py-2 pr-2">${esc(HQ_AUDIT_ACTION[l.action] || l.action)}${l.target ? `<div class="text-[11px] text-gray-400">${esc(l.target)}</div>` : ''}</td>
    <td class="py-2">${hqAuditDiff(l)}${l.reason ? `<div class="text-amber-700">理由: ${esc(l.reason)}</div>` : ''}</td>
  </tr>`
}
const HQ_AUDIT = { page: 1, logs: [] }
delegate('hqAuditLogs', async () => {
  HQ_AUDIT.page = 1; HQ_AUDIT.logs = []
  modal(`<h3 class="font-bold text-lg mb-2 text-gray-800">本部の操作の履歴</h3>
    <div class="max-h-[70vh] overflow-y-auto"><table class="w-full text-xs text-gray-800"><thead><tr class="text-gray-500 border-b"><th class="text-left py-1">日時</th><th class="text-left">操作した人</th><th class="text-left">企業</th><th class="text-left">操作</th><th class="text-left">内容</th></tr></thead>
    <tbody id="hq-audit-body"><tr><td colspan="5" class="py-4 text-center text-gray-400">読み込み中…</td></tr></tbody></table>
    <div id="hq-audit-more" class="text-center mt-2"></div></div>
    <button class="btn btn-outline w-full mt-3" onclick="closeModal()">閉じる</button>`)
  await loadHqAuditLogs()
})
delegate('hqAuditMore', (el) => withSubmitLock(el, async () => { HQ_AUDIT.page++; await loadHqAuditLogs() }))
async function loadHqAuditLogs() {
  const body = document.getElementById('hq-audit-body'), more = document.getElementById('hq-audit-more')
  try {
    const { data } = await axios.get('/api/hq/audit-logs', { params: { page: HQ_AUDIT.page } })
    HQ_AUDIT.logs = HQ_AUDIT.logs.concat(data.logs)
    if (!body) return
    body.innerHTML = HQ_AUDIT.logs.map(l => hqAuditRow(l, true)).join('') || '<tr><td colspan="5" class="py-4 text-center text-gray-400">記録はまだありません</td></tr>'
    if (more) more.innerHTML = data.has_more ? '<button class="btn btn-outline text-xs" data-action="hqAuditMore">さらに読み込む</button>' : ''
  } catch (e) {
    if (body) body.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-red-500">読み込めませんでした</td></tr>'
  }
}

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
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-600 block mb-1">トライアルの終了日</label><input id="co-trial-ends" type="date" class="inp"></div>
        <div><label class="text-xs text-gray-600 block mb-1">契約開始日</label><input id="co-contract-start" type="date" class="inp"></div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div><label class="text-xs text-gray-600 block mb-1">企業の担当者</label><input id="co-contact-name" class="inp" maxlength="60"></div>
        <div><label class="text-xs text-gray-600 block mb-1">電話</label><input id="co-contact-phone" type="tel" class="inp" maxlength="30"></div>
        <div><label class="text-xs text-gray-600 block mb-1">メール</label><input id="co-contact-email" type="email" class="inp"></div>
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
const HQ_ADD_FIELDS = { company_code: 'co-code', company_name: 'co-name', plan: 'co-plan', user_limit: 'co-limit', admin_code: 'co-admin-code', admin_password: 'co-admin-pass', admin_email: 'co-admin-email',
  trial_ends_at: 'co-trial-ends', contract_start_at: 'co-contract-start', contact_name: 'co-contact-name', contact_phone: 'co-contact-phone', contact_email: 'co-contact-email' }
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
      trial_ends_at: v('co-trial-ends'), contract_start_at: v('co-contract-start'),
      contact_name: v('co-contact-name'), contact_phone: v('co-contact-phone'), contact_email: v('co-contact-email'),
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
let HQ_BILLING_ROWS = []

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
  HQ_BILLING_ROWS = data.billing || []
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
          <div><label class="text-xs text-slate-400 block mb-1">会社名（掲示板・企業間連携の相手にもこの名前が出ます）</label>
            <input id="cd-name" class="inp" maxlength="100" value="${esc(c.company_name)}" data-current="${esc(c.company_name)}" ${darkInp}></div>
          <div class="grid grid-cols-3 gap-3">
            <div><label class="text-xs text-slate-400 block mb-1">トライアルの終了日</label>
              <input id="cd-trial-ends" type="date" class="inp" value="${esc(c.trial_ends_at || '')}" ${darkInp}></div>
            <div><label class="text-xs text-slate-400 block mb-1">契約開始日</label>
              <input id="cd-contract-start" type="date" class="inp" value="${esc(c.contract_start_at || '')}" ${darkInp}></div>
            <div><label class="text-xs text-slate-400 block mb-1">次回レビュー日</label>
              <input id="cd-next-review" type="date" class="inp" value="${esc(c.next_review_at || '')}" ${darkInp}></div>
          </div>
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
          <p class="text-xs text-slate-400 pt-1">企業の連絡先（請求・契約・障害の連絡用）</p>
          <div class="grid grid-cols-3 gap-3">
            <div><label class="text-xs text-slate-400 block mb-1">担当者</label><input id="cd-contact-name" class="inp" maxlength="60" value="${esc(c.contact_name || '')}" ${darkInp}></div>
            <div><label class="text-xs text-slate-400 block mb-1">電話</label><input id="cd-contact-phone" type="tel" class="inp" maxlength="30" value="${esc(c.contact_phone || '')}" ${darkInp}></div>
            <div><label class="text-xs text-slate-400 block mb-1">メール</label><input id="cd-contact-email" type="email" class="inp" value="${esc(c.contact_email || '')}" ${darkInp}></div>
          </div>
          <div><label class="text-xs text-slate-400 block mb-1">請求先の住所</label><input id="cd-billing-address" class="inp" maxlength="200" value="${esc(c.billing_address || '')}" ${darkInp}></div>
          <div><label class="text-xs text-slate-400 block mb-1">伴走支援メモ（いまの状況のまとめ。経緯は下の「伴走支援の履歴」に追記します）</label>
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
              <th class="text-left py-2">ID</th><th class="text-left py-2">氏名</th><th class="text-left py-2">権限</th><th class="text-left py-2">状態</th><th class="text-left py-2">メール</th><th class="text-left py-2" title="ログインした日時。下の段は最後にアプリを使った日時">最終ログイン</th><th></th>
            </tr></thead>
            <tbody id="hq-user-body">${hqUserRows(data.users, cid)}</tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mt-4">
      ${hqBillingSection(data, cid)}
      ${hqSupportLogSection(data, cid)}
    </div>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mt-4 overflow-x-auto">
      <h3 class="font-bold mb-3"><i class="fas fa-clock-rotate-left text-cyan-400 mr-1"></i>変更履歴（本部の操作）</h3>
      <div class="bg-white rounded-lg p-2 max-h-80 overflow-y-auto">
        <table class="w-full text-xs text-gray-800"><thead><tr class="text-gray-500 border-b"><th class="text-left py-1">日時</th><th class="text-left">操作した人</th><th class="text-left">操作</th><th class="text-left">内容</th></tr></thead>
        <tbody>${(data.audit_logs || []).map(l => hqAuditRow(l, false)).join('') || '<tr><td colspan="4" class="py-4 text-center text-gray-400">記録はまだありません</td></tr>'}</tbody></table>
      </div>
      <p class="text-[11px] text-slate-500 mt-2">新しい順に50件まで表示します。すべての企業の履歴は、企業一覧の「本部の操作の履歴」から見られます。</p>
    </section>`
}
// 月ごとの請求記録（#295）
function hqBillingSection(data, cid) {
  const rows = data.billing || []
  const price = (data.plan_prices || []).find(p => p.plan === data.company.plan)
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-1"><i class="fas fa-file-invoice-dollar text-cyan-400 mr-1"></i>請求の記録</h3>
      <p class="text-[11px] text-slate-400 mb-2">今月の見込み: ${yen(data.usage && data.usage.monthly_fee)}（課金対象 ${Number(data.usage && data.usage.user_count) || 0}名${price ? `・${esc(PLAN_LABELS[price.plan] || price.plan)} ${esc(hqPriceText(price))}` : ''}）。記録は企業一覧の「請求の記録」で月ごとに作ります。</p>
      <div class="max-h-80 overflow-y-auto">
        <table class="w-full text-xs">
          <thead><tr class="text-slate-400 border-b border-slate-700"><th class="text-left py-2">月</th><th class="text-left">プラン</th><th class="text-right">人数</th><th class="text-right">金額</th><th class="text-left pl-3">入金状態</th><th></th></tr></thead>
          <tbody>${rows.map(r => `
            <tr class="border-b border-slate-700/40 ${r.status === 'overdue' ? 'bg-red-900/20' : ''}">
              <td class="py-2 whitespace-nowrap">${esc(String(r.month).replace('-', '/'))}</td>
              <td>${esc(PLAN_LABELS[r.plan] || r.plan || '')}</td>
              <td class="text-right">${Number(r.user_count) || 0}名</td>
              <td class="text-right font-bold">${yen(r.amount)}</td>
              <td class="pl-3 whitespace-nowrap"><span class="badge ${BILLING_MONTH_BADGE[r.status] || 'badge-gray'}">${esc(BILLING_MONTH_LABEL[r.status] || r.status)}</span>${r.paid_at ? `<span class="text-slate-400 ml-1">${esc(dayjs(r.paid_at).format('M/D'))}</span>` : ''}${r.note ? `<div class="text-[11px] text-slate-400">${esc(r.note)}</div>` : ''}</td>
              <td class="text-right"><button class="text-cyan-400 hover:underline" data-action="hqEditBilling" data-cid="${Number(cid)}" data-month="${esc(r.month)}">編集</button></td>
            </tr>`).join('') || '<tr><td colspan="6" class="py-6 text-center text-slate-400">請求の記録はまだありません</td></tr>'}</tbody>
        </table>
      </div>
    </section>`
}
// 伴走支援の履歴（#296）。追記で残す
function hqSupportLogSection(data, cid) {
  const darkInp = 'style="background:#1e293b;border-color:#334155;color:#fff"'
  const logs = data.support_logs || []
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-2"><i class="fas fa-handshake text-cyan-400 mr-1"></i>伴走支援の履歴</h3>
      <div class="space-y-2 mb-3">
        <textarea id="sl-body" rows="2" maxlength="2000" class="inp" placeholder="実施した支援・打ち合わせの内容" ${darkInp}></textarea>
        <div class="flex flex-wrap items-end gap-2">
          <div><label class="text-[11px] text-slate-400 block mb-1">次回の予定日（入れると次回レビュー日も更新します）</label><input id="sl-next" type="date" class="inp" ${darkInp}></div>
          <button class="btn btn-primary" style="background:#0e7490" data-action="hqAddSupportLog" data-cid="${Number(cid)}"><i class="fas fa-plus"></i>記録する</button>
        </div>
      </div>
      <div class="max-h-80 overflow-y-auto space-y-2">
        ${logs.map(l => `
          <div class="border-l-2 border-cyan-700 pl-2 text-xs">
            <div class="text-slate-400">${esc(dayjs(String(l.created_at).replace(' ', 'T')).format('YYYY/M/D HH:mm'))}・${esc(l.actor_name || '（担当者の記録なし）')}${l.next_action_date ? `<span class="ml-2 text-amber-300">次回 ${esc(dayjs(l.next_action_date).format('YYYY/M/D'))}</span>` : ''}</div>
            <div class="whitespace-pre-wrap break-words">${esc(l.body)}</div>
          </div>`).join('') || '<p class="text-xs text-slate-400">記録はまだありません</p>'}
      </div>
    </section>`
}
delegate('hqAddSupportLog', (el) => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid)
  const body = document.getElementById('sl-body').value.trim()
  if (!body) { hqMarkField('sl-body', '支援の内容を入力してください'); return }
  try {
    await axios.post(`/api/hq/companies/${cid}/support-logs`, { body, next_action_date: document.getElementById('sl-next').value || null })
    toast('記録しました'); renderCompanyDetail(cid)
  } catch (e) { hqErr(e, '記録できませんでした') }
}))
delegate('hqEditBilling', (el) => {
  const cid = Number(el.dataset.cid), month = el.dataset.month
  const r = (HQ_BILLING_ROWS || []).find(x => x.month === month)
  if (!r) return
  modal(`
    <h3 class="font-bold text-lg mb-1 text-gray-800">${esc(dayjs(month + '-01').format('YYYY年M月'))}分の請求</h3>
    <p class="text-xs text-gray-500 mb-3">記録した時点: ${esc(PLAN_LABELS[r.plan] || r.plan || '')}・${Number(r.user_count) || 0}名${r.recorded_at ? `（${esc(dayjs(String(r.recorded_at).replace(' ', 'T')).format('YYYY/M/D HH:mm'))}に記録）` : ''}</p>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-600 block mb-1">入金状態</label>
          <select id="bm-status" class="inp">${Object.entries(BILLING_MONTH_LABEL).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label class="text-xs text-gray-600 block mb-1">入金日（入金済みのとき。空欄なら今日）</label><input id="bm-paid" type="date" class="inp" value="${esc(r.paid_at || '')}"></div>
      </div>
      <div><label class="text-xs text-gray-600 block mb-1">金額（円）</label><input id="bm-amount" type="number" min="0" step="1" class="inp" value="${Number(r.amount) || 0}"></div>
      <div><label class="text-xs text-gray-600 block mb-1">メモ（値引き・日割りの理由など）</label><input id="bm-note" class="inp" maxlength="500" value="${esc(r.note || '')}"></div>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-primary flex-1" data-action="hqSaveBilling" data-cid="${cid}" data-month="${esc(month)}">保存する</button>
      </div>
    </div>`)
})
delegate('hqSaveBilling', (el) => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid), month = el.dataset.month
  const amount = Number(document.getElementById('bm-amount').value)
  if (!Number.isInteger(amount) || amount < 0) { toast('金額は0以上の整数で入力してください'); return }
  try {
    await axios.put(`/api/hq/companies/${cid}/billing/${encodeURIComponent(month)}`, {
      status: document.getElementById('bm-status').value, paid_at: document.getElementById('bm-paid').value || null,
      amount, note: document.getElementById('bm-note').value,
    })
    closeModal(); toast('保存しました'); renderCompanyDetail(cid)
  } catch (e) { hqErr(e, '保存できませんでした') }
}))
// 最終ログインと、最後にアプリを使った日時（#286 #491）。ログインできる人で一度もログインしていなければ「未ログイン」。
// 他社から連携したスタッフ（LK-）は所属元のログインで使うので、この企業の行にはログインが残らない
function hqLoginCell(u) {
  const fmt = v => dayjs(String(v).replace(' ', 'T')).format('M/D HH:mm')
  if (u.role === 'roster_only') return '-'
  const seen = u.last_seen_at && u.last_seen_at !== u.last_login_at ? `<div class="text-[11px] text-slate-500">利用 ${esc(fmt(u.last_seen_at))}</div>` : ''
  if (u.last_login_at) return esc(fmt(u.last_login_at)) + seen
  if (u.linked) return (seen || '<span class="text-slate-500">所属元でログイン</span>')
  return '<span class="badge badge-yellow">未ログイン</span>' + seen
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
      <td class="py-2 text-slate-400 whitespace-nowrap">${hqLoginCell(u)}</td>
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
  const nameEl = document.getElementById('cd-name')
  const name = nameEl.value.trim()
  if (!name) { hqMarkField('cd-name', '会社名を入力してください'); return }
  // 会社名を変えると、掲示板・企業間連携の相手の画面の表示も変わる（#558）
  if (name !== nameEl.dataset.current
    && !confirm(`会社名を「${nameEl.dataset.current}」から「${name}」に変えます。\n掲示板や企業間連携の相手の画面にも新しい名前が表示されます。よろしいですか？`)) return
  // 停止にすると、その企業の利用者は全員ログアウトされ、ログインと報告用URLも使えなくなる
  if (status.value === 'inactive' && status.dataset.current !== 'inactive'
    && !confirm('この企業を「停止」にします。\nこの企業の管理者・スタッフは全員ログアウトされ、ログインも報告用URLも使えなくなります。よろしいですか？')) return
  // 停止と再開には理由を残す（#542）
  let reason = ''
  if ((status.value === 'inactive') !== (status.dataset.current === 'inactive')) {
    reason = (prompt(status.value === 'inactive' ? '停止する理由を入力してください（変更履歴に残ります）' : '再開する理由を入力してください（変更履歴に残ります）') || '').trim()
    if (!reason) { toast('理由を入力しなかったため、保存しませんでした'); return }
  }
  const val = id => document.getElementById(id).value
  withSubmitLock(el, async () => {
    try {
      const { data } = await axios.put('/api/hq/companies/' + cid, {
        company_name: name,
        trial_ends_at: val('cd-trial-ends'), contract_start_at: val('cd-contract-start'), next_review_at: val('cd-next-review'),
        contact_name: val('cd-contact-name'), contact_phone: val('cd-contact-phone'), contact_email: val('cd-contact-email'), billing_address: val('cd-billing-address'),
        reason,
        plan: document.getElementById('cd-plan').value,
        // 空欄は上限なし（null）。0 として保存しない（#254）
        user_limit: limitRaw === '' ? null : Number(limitRaw),
        active_status: status.value,
        billing_status: document.getElementById('cd-billing').value,
        maturity_level: Number(document.getElementById('cd-maturity').value),
        support_memo: document.getElementById('cd-memo').value
      })
      toast(data.revoked_sessions ? `保存しました（${data.revoked_sessions}件のログインを終了しました）` : data.changed && !data.changed.length ? '変更はありませんでした' : '保存しました')
      // 保存した内容（上限超過の表示など）を読み直す
      renderCompanyDetail(cid)
    } catch (e) {
      const d = e.response && e.response.data
      const field = d && { company_name: 'cd-name', trial_ends_at: 'cd-trial-ends', contract_start_at: 'cd-contract-start', next_review_at: 'cd-next-review',
        contact_name: 'cd-contact-name', contact_phone: 'cd-contact-phone', contact_email: 'cd-contact-email', billing_address: 'cd-billing-address' }[d.field]
      if (field) hqMarkField(field, d.error)
      else hqErr(e, e.response ? '保存に失敗しました。もう一度お試しください' : '通信できませんでした。保存されていない可能性があります')
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
let HQ_TPLS = []
async function renderTemplates() {
  loading()
  let data
  try { data = (await axios.get('/api/hq/templates')).data; HQ_TPLS = data.templates } catch (e) {
    $app.innerHTML = `<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-sm text-slate-300">テンプレートを読み込めませんでした。<button class="btn btn-outline ml-2" style="border-color:#334155;color:#67e8f9" onclick="renderTemplates()">再試行</button></div>`
    return
  }
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold">テンプレート配信管理</h2>
      <button class="btn btn-primary" style="background:#0e7490" onclick="showAddTemplate()"><i class="fas fa-plus"></i>テンプレート作成</button>
    </div>
    <p class="text-sm text-slate-400 mb-4">本部テンプレートは全導入企業の案件設定で選択可能になります。配信停止にすると、新しい案件では選べなくなります（使っている案件はそのまま使えます）。</p>
    <div class="grid md:grid-cols-2 gap-4">
      ${data.templates.map(t => `
        <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 ${t.status === 'stopped' ? 'opacity-70' : ''}">
          <div class="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <h3 class="font-bold">${esc(t.template_name)}</h3>
            <span class="flex gap-1 items-center">
              ${t.status === 'stopped' ? '<span class="badge badge-gray">配信停止</span>' : ''}
              <span class="badge ${t.template_type === 'hq' ? 'badge-blue' : 'badge-gray'}">${t.template_type === 'hq' ? '本部配信' : '企業独自'}</span>
            </span>
          </div>
          ${t.company_name ? `<p class="text-xs text-slate-400 mb-2">${esc(t.company_name)}</p>` : ''}
          <div class="flex flex-wrap gap-1.5">
            ${t.fields.map(f => `<span class="text-xs px-2 py-0.5 rounded-full ${f.type === 'number' ? 'bg-cyan-900 text-cyan-300' : 'bg-slate-700 text-slate-300'}" title="${esc(f.key)}${f.required ? '（必須）' : ''}">${esc(f.label)}${f.required ? ' <span class="text-amber-300">*</span>' : ''}</span>`).join('')}
          </div>
          <p class="text-xs text-slate-500 mt-2">項目数: ${t.fields.length}（数値 ${t.fields.filter(f => f.type === 'number').length} / テキスト ${t.fields.filter(f => f.type !== 'number').length}${t.fields.some(f => f.required) ? ` / 必須 ${t.fields.filter(f => f.required).length}` : ''}）・使用中の案件 ${Number(t.project_count || 0)}件${t.has_reports ? '・日報あり' : ''}</p>
          <div class="flex gap-2 mt-3">
            <button class="btn btn-outline text-xs" style="border-color:#334155;color:#67e8f9" data-action="editHqTemplate" data-id="${Number(t.template_id)}"><i class="fas fa-pen"></i>修正</button>
            <button class="btn btn-outline text-xs" style="border-color:#334155;color:#cbd5e1" data-action="toggleHqTemplateStatus" data-id="${Number(t.template_id)}" data-status="${t.status === 'stopped' ? 'active' : 'stopped'}">${t.status === 'stopped' ? '配信を再開' : '配信停止'}</button>
          </div>
        </section>`).join('')}
    </div>`
}

// 項目の定義（1行1項目: キー,表示名,タイプ[,必須]）を読み、問題を行ごとに返す。
// サーバー（src/lib/report-template.ts）と同じ規則。保存の前にプレビューで示す（#378）
const TPL_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/
// 修正中のテンプレートにすでにあるキー。規則ができる前のキー（日本語など）でも、そのまま残すなら通す（#165。日報の値はこのキーで保存されているため）
let TPL_KEEP_KEYS = new Set()
const TPL_RESERVED = ['incident_note', 'complaint_note', 'incident_flag', 'complaint_flag', 'constructor', 'prototype', 'toString', 'hasOwnProperty']
function parseTemplateLines(text) {
  const seen = new Set()
  const rows = String(text || '').split('\n').map((l, i) => ({ line: i + 1, raw: l.trim() })).filter(r => r.raw).map(r => {
    const [key = '', label = '', type = '', req = ''] = r.raw.split(',').map(s => s.trim())
    const f = { key, label: label || key, type: type || 'text' }
    if (['必須', 'required', '*'].includes(req)) f.required = true
    const errors = []
    if (!key) errors.push('キーが空欄です')
    else if (!TPL_KEY_RE.test(key) && !TPL_KEEP_KEYS.has(key)) errors.push('キーは半角英字で始まる英数字と _ の40文字以内にしてください')
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
  TPL_KEEP_KEYS = new Set()
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

// テンプレートの修正・配信停止（#165）。値が入った日報がある項目は、削除・キーの変更・
// 数値とテキストの切り替えができない（サーバーで確かめる）。入力例・文字数の上限は、同じキーの項目の元の値を引き継ぐ
const hqTplById = id => HQ_TPLS.find(t => Number(t.template_id) === Number(id))
delegate('editHqTemplate', el => {
  const t = hqTplById(el.dataset.id); if (!t) return
  TPL_KEEP_KEYS = new Set(t.fields.map(f => f.key))
  const lines = t.fields.map(f => [f.key, f.label, f.type || 'text'].concat(f.required ? ['必須'] : []).join(',')).join('\n')
  modal(`
    <h3 class="font-bold text-lg mb-4 text-gray-800">テンプレートの修正</h3>
    <div class="space-y-3">
      ${t.company_name ? `<p class="text-xs text-gray-500">企業独自: ${esc(t.company_name)}</p>` : ''}
      <div><label class="text-sm text-gray-600 block mb-1">テンプレート名 *</label><input id="tp-name" class="inp" maxlength="60" value="${esc(t.template_name)}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">項目定義（1行1項目: キー,表示名,タイプ[,必須]）</label>
        <textarea id="tp-fields" rows="8" class="inp text-xs font-mono">${esc(lines)}</textarea>
        ${t.has_reports ? '<p class="text-xs text-amber-700 mt-1">このテンプレートには日報があります。値が入った日報がある項目は、削除・数値とテキストの切り替えができません（保存のときに確かめます）。表示名・順序・必須の変更と、項目の追加はいつでもできます</p>' : ''}</div>
      <div id="tp-preview" class="border rounded-lg p-2 max-h-56 overflow-y-auto"></div>
      <button class="btn btn-primary w-full" data-action="saveHqTemplate" data-id="${Number(t.template_id)}">保存する</button>
    </div>`)
  document.getElementById('tp-fields').addEventListener('input', renderTemplatePreview)
  renderTemplatePreview()
})
delegate('saveHqTemplate', (el) => withSubmitLock(el, async () => {
  const t = hqTplById(el.dataset.id); if (!t) return
  const name = document.getElementById('tp-name').value.trim()
  if (!name) { hqMarkField('tp-name', 'テンプレート名を入力してください'); return }
  const rows = parseTemplateLines(document.getElementById('tp-fields').value)
  if (!rows.length) { hqMarkField('tp-fields', '項目を1つ以上入力してください'); return }
  const bad = rows.find(r => r.errors.length)
  if (bad) { renderTemplatePreview(); hqMarkField('tp-fields', `${bad.line}行目: ${bad.errors[0]}`); return }
  const prev = new Map(t.fields.map(f => [f.key, f]))
  const fields = rows.map(r => {
    const f = { ...r.field }, o = prev.get(f.key)
    if (o && o.placeholder) f.placeholder = o.placeholder
    if (o && o.maxLength && f.type !== 'number') f.maxLength = o.maxLength
    return f
  })
  try {
    await axios.put('/api/hq/templates/' + Number(t.template_id), { template_name: name, fields })
    closeModal(); toast('テンプレートを修正しました'); renderTemplates()
  } catch (e) {
    hqErr(e, e.response ? '修正に失敗しました' : '通信できませんでした。接続を確かめて、もう一度お試しください')
  }
}))
delegate('toggleHqTemplateStatus', (el) => withSubmitLock(el, async () => {
  const t = hqTplById(el.dataset.id); if (!t) return
  const stop = el.dataset.status === 'stopped'
  if (stop && !confirm(`「${t.template_name}」を配信停止にしますか？\n新しい案件では選べなくなります。使っている案件（${Number(t.project_count || 0)}件）はそのまま使えます。`)) return
  try {
    await axios.put('/api/hq/templates/' + Number(t.template_id), { status: el.dataset.status })
    toast(stop ? '配信停止にしました' : '配信を再開しました'); renderTemplates()
  } catch (e) { hqErr(e, '変更に失敗しました') }
}))

// ============ データ保持（定期削除） ============
const RETENTION_TARGET_LABEL = {
  daily_reports: '日報（3年）', attendance_reports: '出退勤記録（退職後7年）', shifts: 'シフト（退職後7年）',
  evaluations: '人事評価（退職後7年）', follow_logs: 'やり取り履歴（退職後7年）', consultations: '相談内容（退職後7年）',
  r2_photos: 'R2写真（退職後7年）', shift_report_tokens: '報告用URL（退職後7年）', retired_staff: '退職スタッフ（人数・退職後7年）',
  user_notifications: 'アプリ内通知（2年）', email_logs: 'メール送信ログ（1年）',
  attendance_corrections: '打刻修正申請（退職後7年）', attendance_correction_events: '打刻修正の操作履歴（退職後7年）',
  notification_emails: '通知メールの送信状態（退職後7年）', report_setting_logs: '報告設定の変更履歴（退職後7年）', project_staff_report_settings: '報告設定（スタッフ別・退職後7年）',
  notice_read_staff_reports: '既読率（スタッフ別・退職後7年）',
  employee_records: '従業員データ（口座・住所・給与・緊急連絡先。退職後7年）', employment_periods: '過去の雇用期間（退職後7年）',
  staff_documents: '履歴書など（退職後7年）', employee_documents: '入社時書類（退職後7年）', r2_documents: 'R2書類ファイル（退職後7年）',
  roster_comments: '企業間チャット（退職後7年）', roster_comment_reads: '企業間チャットの既読位置（退職後7年）', roster_consents: '連携の同意履歴（退職後7年）',
  anonymized_staff: '本人情報の匿名化（退職後7年）',
  recruit_applications: '応募（スタッフに紐づくもの。退職後7年）', recruit_application_items: '応募した枠（退職後7年）', board_proposals: '人材提案の匿名化（退職後7年）',
  retired_staff_deferred: '上限で翌日に回した退職スタッフ（人数）', r2_pending: '翌日以降に消すR2ファイル（残り）',
  password_reset_tokens: 'パスワード再設定のリンク（期限切れ・使用済み）', expired_report_tokens: '報告用URL（期限から30日・取り消し済み）',
  // 在職中の保存期間（期間は「保存期間の設定」で変えられる。#420 #511 #350 #425）
  attendance_location: '入店などの位置情報・端末情報（在職中）', attendance_photos: '入店などの写真（在職中・R2の削除に回す）',
  consultations_done: '対応済みの相談（在職中）', follow_logs_done: '完了したフォロー記録（在職中）',
  board_proposals_settled: '見送り・取り下げの人材提案の匿名化', ended_employee_records: '雇用終了の従業員データ（雇用終了から7年）',
  ended_employee_documents: '雇用終了の入社時書類（雇用終了から7年・R2の削除に回す）', ended_employment_periods: '過去の雇用期間（終了から7年）',
  orphan_photos: '勤怠に紐づかない写真（本部の手動削除）',
}
// 人ごとの dry-run の内訳で出す列（API の DRY_RUN_STAFF_COUNTS と同じキー）
const RETENTION_STAFF_COLS = [
  ['shifts', 'シフト'], ['attendance_reports', '出退勤'], ['r2_photos', '写真'], ['evaluations', '評価'], ['follow_logs', 'やり取り'],
  ['consultations', '相談'], ['attendance_corrections', '打刻修正'], ['employee_records', '従業員データ'], ['documents', '書類'],
  ['roster_comments', 'チャット'], ['notice_read_staff_reports', '既読率'], ['recruit_applications', '応募'], ['board_proposals', '提案'],
]
const RETENTION_TRIGGER_LABEL = { cron: '定期処理', manual: '手動' }
// トークンの削除（API の RETENTION_TOKEN_TARGETS と同じ）
const RETENTION_TOKEN_TARGETS = ['password_reset_tokens', 'expired_report_tokens']
// dry-run の結果と実行ログの表示状態（dry-run の後に描き直しても結果が消えないよう、ここに残す。#244）
const retentionState = { dryRun: null, logPage: 1, logTrigger: 'all' }

// 今の動作モードと、次の定期削除で削除する人数（#365）
function retentionModeHtml(sch) {
  if (!sch) return ''
  const mode = sch.enabled
    ? '<span class="badge badge-red">実削除</span> <span class="text-xs text-slate-400">毎日の定期処理で実際に削除・匿名化します（RETENTION_ENABLED=true）</span>'
    : '<span class="badge badge-gray">dry-run のみ</span> <span class="text-xs text-slate-400">定期処理は対象件数を記録するだけで、削除しません（RETENTION_ENABLED が true ではありません）</span>'
  const next = sch.enabled
    ? `${esc(sch.next_run_date)} 3:00 の定期処理で <b class="${sch.next_run_count > 0 ? 'text-amber-400' : ''}">${esc(sch.next_run_count)}人</b> の退職者のデータを削除します` +
      (sch.next_run_due > sch.next_run_count ? `（猶予が明けた ${esc(sch.next_run_due)}人のうち、1回の上限 ${esc(sch.staff_batch)}人）` : '')
    : `${esc(sch.next_run_date)} 3:00 の定期処理は dry-run のため削除しません（猶予が明けた退職者: ${esc(sch.next_run_due)}人）`
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <p class="text-sm mb-1">動作モード: ${mode}</p>
      <p class="text-sm">${next}</p>
    </section>`
}
// 次回削除予定・対象外の一覧（退職日の入力誤りに気づけるよう、削除前に本部で確認できるようにする）
function retentionScheduleHtml(sch) {
  const row = (s, note) => `
    <tr>
      <td class="text-xs">${esc(s.company_name || '-')}</td>
      <td>${esc(s.name || '-')} <span class="text-xs text-slate-500">#${esc(s.staff_id)}</span></td>
      <td class="text-xs">${esc(s.retired_at || '-')}</td>
      <td class="text-xs">${esc(s.last_work_date || '-')}</td>
      <td class="text-xs">${note}
        <button class="btn btn-outline text-xs ml-1" data-action="openRetentionHold" data-kind="staff" data-id="${Number(s.staff_id)}" data-name="${esc(s.name || '')}">削除を保留</button></td>
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
// dry-run の会社別・退職者別の内訳（#365）
function retentionDryRunDetailHtml(data) {
  if (data.detailError) return `<p class="text-xs text-red-400 mt-3">会社別・退職者別の内訳の集計に失敗しました: ${esc(data.detailError)}</p>`
  const d = data.detail
  if (!d) return ''
  const num = (n) => n > 0 ? `<span class="text-amber-400">${esc(n)}</span>` : '<span class="text-slate-500">0</span>'
  const head = RETENTION_STAFF_COLS.map(([, l]) => `<th>${esc(l)}</th>`).join('')
  const cells = (counts) => RETENTION_STAFF_COLS.map(([k]) => `<td class="text-xs">${num(counts[k] || 0)}</td>`).join('')
  const companies = d.companies.length ? d.companies.map(c => `
    <tr><td>${esc(c.company_name || '-')}</td><td>${esc(c.staff_count)}人</td>${cells(c.counts)}</tr>`).join('')
    : `<tr><td colspan="${RETENTION_STAFF_COLS.length + 2}" class="text-center text-slate-500 py-4">対象の退職者はいません</td></tr>`
  const flagged = d.staff.filter(s => s.report_after_retired).length
  const staff = d.staff.map(s => `
    <tr>
      <td class="text-xs">${esc(s.company_name || '-')}</td>
      <td>${esc(s.name || '-')} <span class="text-xs text-slate-500">#${esc(s.staff_id)}</span>
        ${s.report_after_retired ? '<br><span class="badge badge-red">退職日より後に勤怠あり</span>' : ''}</td>
      <td class="text-xs">${esc(s.retired_at || '-')}</td>
      <td class="text-xs">${esc(s.last_work_date || '-')}${s.last_report_date ? `<br><span class="text-slate-500">最終報告 ${esc(s.last_report_date)}</span>` : ''}</td>
      <td class="text-xs">${s.delete_on ? esc(s.delete_on) + ' 以降' : '<span class="text-slate-400">猶予前</span>'}</td>
      ${cells(s.counts)}
    </tr>`).join('')
  return `
    <h4 class="font-bold text-sm mt-5 mb-2">会社別</h4>
    <div class="overflow-x-auto">
      <table class="tbl"><thead><tr><th>会社</th><th>退職者</th>${head}</tr></thead><tbody>${companies}</tbody></table>
    </div>
    <h4 class="font-bold text-sm mt-5 mb-1">退職者別（${esc(d.staff_total)}人${d.staff_total > d.staff.length ? `のうち先頭の${esc(d.staff.length)}人` : ''}）</h4>
    ${flagged ? `<p class="text-xs text-red-400 mb-2">退職日より後に勤怠の報告がある人が ${esc(flagged)}人います。退職日の入力誤りでないか、各社に確認してください。</p>` : ''}
    ${d.staff.length ? `
    <details${d.staff.length <= 20 ? ' open' : ''}>
      <summary class="text-xs text-slate-400 cursor-pointer">一覧を開く</summary>
      <div class="overflow-x-auto mt-2">
        <table class="tbl"><thead><tr><th>会社</th><th>スタッフ</th><th>退職日</th><th>最終稼働日</th><th>削除できる日</th>${head}</tr></thead><tbody>${staff}</tbody></table>
      </div>
    </details>` : ''}`
}
function retentionDryRunHtml(data) {
  // 実削除のときだけ意味のある項目（翌日に回した人数）は出さない
  const results = data.results.filter(r => r.target !== 'retired_staff_deferred')
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-1">dry-run結果（削除は実行していません。猶予中のスタッフも含みます）</h3>
      <p class="text-xs text-slate-500 mb-3">${data.finishedAt ? esc(dayjs(data.finishedAt).format('YYYY/M/D HH:mm')) + ' に集計' : ''}</p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        ${results.map(r => `
          <div class="bg-slate-900 rounded-lg p-3">
            <p class="text-xs text-slate-400">${esc(RETENTION_TARGET_LABEL[r.target] || r.target)}</p>
            <p class="text-lg font-bold ${r.targetCount > 0 ? 'text-amber-400' : ''}">${esc(r.targetCount)}件</p>
            ${r.failedCount > 0 ? `<p class="text-xs text-red-400">集計に失敗しました</p>` : ''}
          </div>`).join('')}
      </div>
      ${retentionDryRunDetailHtml(data)}
    </section>`
}
async function renderRetention() {
  loading()
  const [sch, cron] = await Promise.all([
    axios.get('/api/hq/retention/schedule').then(r => r.data).catch(() => null),
    axios.get('/api/hq/cron/status').then(r => r.data).catch(() => null),
  ])
  renderCronAlert(cron)
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h2 class="text-xl font-bold">データ保持・定期処理</h2>
        <p class="text-sm text-slate-400 mt-1">日報は3年、アプリ内通知は2年、メール送信ログは1年で削除します。出退勤記録・シフト・評価・やり取り・相談・R2写真・打刻修正・報告設定・スタッフ別の既読率・従業員データ（口座・住所・給与など）・履歴書や入社時書類・企業間チャット・連携の同意履歴・スタッフに紐づく応募は退職後7年で削除し、氏名・連絡先などの本人情報と人材提案の経歴・氏名は匿名化します（毎日Cronで実行）。期限切れ・使用済みのパスワード再設定のリンクと報告用URLも毎日削除します。</p>
        <p class="text-sm text-slate-400 mt-1">在職中でも、入店などの位置情報・端末情報と写真、対応済みの相談、完了したフォロー記録、見送り・取り下げになった人材提案の経歴・氏名は「保存期間の設定」の期間で消します。区分変更で雇用終了にした人の従業員データと入社時書類は、雇用終了から7年で削除します（毎日 3:30 の Cron）。削除を保留したスタッフ・企業のデータは、どの削除の対象にもなりません。</p>
      </div>
      <button class="btn btn-outline" data-action="runRetentionDryRun"><i class="fas fa-magnifying-glass"></i>dry-run実行（削除せず対象件数を確認）</button>
    </div>
    ${retentionModeHtml(sch)}
    ${cron ? cronStatusHtml(cron) : '<p class="text-sm text-red-400 mb-5">定期処理の実行記録の取得に失敗しました</p>'}
    <div id="retention-dryrun-result" class="mb-5">${retentionState.dryRun ? retentionDryRunHtml(retentionState.dryRun) : ''}</div>
    ${sch ? retentionScheduleHtml(sch) : '<p class="text-sm text-red-400 mb-5">次回削除予定の取得に失敗しました</p>'}
    ${sch ? retentionHoldsHtml(sch.holds, sch.grace_days) : ''}
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5" id="retention-settings"></section>
    ${retentionOrphanHtml()}
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4" id="retention-logs"></section>`
  await Promise.all([loadRetentionLogs(), loadRetentionSettings()])
}

// ---------- 削除の保留（#543） ----------
// 係争中・調査中のスタッフや、解約手続き中などの企業のデータを、どの定期削除の対象からも外す
function retentionHoldsHtml(holds, graceDays) {
  if (!holds) return ''
  const by = (h) => `${esc(h.hold_at || '-')}${h.hold_by_name ? `<br><span class="text-slate-500">${esc(h.hold_by_name)}</span>` : ''}`
  const staffRows = holds.staff.map(h => `
    <tr>
      <td class="text-xs">${esc(h.company_name || '-')}</td>
      <td>${esc(h.name || '-')} <span class="text-xs text-slate-500">#${esc(h.staff_id)}</span>${h.retired_at ? `<br><span class="text-xs text-slate-500">退職日 ${esc(h.retired_at)}</span>` : ''}</td>
      <td class="text-xs" style="white-space:pre-wrap;word-break:break-all">${esc(h.hold_reason || '')}</td>
      <td class="text-xs">${by(h)}</td>
      <td><button class="btn btn-outline text-xs" data-action="releaseRetentionHold" data-kind="staff" data-id="${Number(h.staff_id)}" data-name="${esc(h.name || '')}">解除</button></td>
    </tr>`).join('')
  const companyRows = holds.companies.map(h => `
    <tr>
      <td>${esc(h.company_name || '-')} <span class="text-xs text-slate-500">#${esc(h.company_id)}</span></td>
      <td class="text-xs" style="white-space:pre-wrap;word-break:break-all">${esc(h.hold_reason || '')}</td>
      <td class="text-xs">${by(h)}</td>
      <td><button class="btn btn-outline text-xs" data-action="releaseRetentionHold" data-kind="company" data-id="${Number(h.company_id)}" data-name="${esc(h.company_name || '')}">解除</button></td>
    </tr>`).join('')
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h3 class="font-bold">削除の保留</h3>
        <div class="flex gap-2">
          <button class="btn btn-outline text-xs" data-action="openRetentionHold" data-kind="staff">スタッフを保留</button>
          <button class="btn btn-outline text-xs" data-action="openRetentionHold" data-kind="company">企業を保留</button>
        </div>
      </div>
      <p class="text-xs text-slate-400 mb-3">未払い賃金の請求・労災・調査・請求トラブルなどが続いている間は、保留にすると退職後7年・在職中の保存期間・日報の3年のどの削除でもデータを消しません。解除すると、退職後7年の削除は猶予（${esc(graceDays)}日）からやり直します。</p>
      <h4 class="text-sm font-bold mt-2 mb-1">スタッフ（${esc(holds.staff.length)}人）</h4>
      <div class="overflow-x-auto">
        <table class="tbl"><thead><tr><th>会社</th><th>スタッフ</th><th>理由</th><th>設定</th><th></th></tr></thead>
        <tbody>${staffRows || '<tr><td colspan="5" class="text-center text-slate-500 py-3">保留中のスタッフはいません</td></tr>'}</tbody></table>
      </div>
      <h4 class="text-sm font-bold mt-4 mb-1">企業（${esc(holds.companies.length)}社）</h4>
      <div class="overflow-x-auto">
        <table class="tbl"><thead><tr><th>企業</th><th>理由</th><th>設定</th><th></th></tr></thead>
        <tbody>${companyRows || '<tr><td colspan="4" class="text-center text-slate-500 py-3">保留中の企業はいません</td></tr>'}</tbody></table>
      </div>
    </section>`
}
delegate('openRetentionHold', async (el) => {
  const kind = el.dataset.kind === 'company' ? 'company' : 'staff'
  const id = el.dataset.id ? Number(el.dataset.id) : null
  let companies = []
  if (kind === 'company' && !id) {
    try { companies = (await axios.get('/api/hq/companies')).data.companies || [] } catch (e) { return showApiError(e, '企業の一覧を読み込めませんでした') }
  }
  const target = id
    ? `<p class="text-sm text-gray-700 mb-2">${kind === 'staff' ? 'スタッフ' : '企業'}: <b>${esc(el.dataset.name || '')}</b> <span class="text-xs text-gray-400">#${esc(id)}</span></p><input type="hidden" id="rh-id" value="${esc(id)}">`
    : kind === 'staff'
      ? `<div class="mb-2"><label class="text-xs text-gray-600 block mb-1">スタッフID（staff_id。次回削除予定の一覧の # の番号）</label><input id="rh-id" type="number" min="1" class="inp"></div>`
      : `<div class="mb-2"><label class="text-xs text-gray-600 block mb-1">企業</label><select id="rh-id" class="inp"><option value="">選んでください</option>
          ${companies.map(c => `<option value="${Number(c.company_id)}">${esc(c.company_name)}（${esc(c.company_code || '')}）</option>`).join('')}</select></div>`
  modal(`
    <h3 class="font-bold text-lg mb-2 text-gray-800">削除を保留する</h3>
    ${target}
    <div><label class="text-xs text-gray-600 block mb-1">理由（必須。例: 未払い賃金の請求で係争中・2026年10月 顧問弁護士より依頼）</label>
      <textarea id="rh-reason" class="inp" rows="3" maxlength="500"></textarea></div>
    <p class="text-[11px] text-gray-400 mt-1">保留中は、この${kind === 'staff' ? 'スタッフ' : '企業'}のデータをどの定期削除でも消しません。不要になったら解除してください。</p>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="saveRetentionHold" data-kind="${kind}">保留にする</button>
    </div>`)
})
delegate('saveRetentionHold', (el) => withSubmitLock(el, async () => {
  const kind = el.dataset.kind === 'company' ? 'company' : 'staff'
  const id = Number(document.getElementById('rh-id').value)
  const reason = document.getElementById('rh-reason').value.trim()
  if (!Number.isInteger(id) || id <= 0) return toast(kind === 'staff' ? 'スタッフIDを入力してください' : '企業を選んでください')
  if (!reason) return toast('保留の理由を入力してください')
  try {
    const { data } = await axios.put(`/api/hq/retention/holds/${kind}/${id}`, { reason })
    closeModal(); toast(`${data.name} の削除を保留にしました`); renderRetention()
  } catch (e) { showApiError(e, '保留にできませんでした') }
}))
delegate('releaseRetentionHold', (el) => withSubmitLock(el, async () => {
  const kind = el.dataset.kind === 'company' ? 'company' : 'staff'
  if (!confirm(`${el.dataset.name || ''} の削除の保留を解除します。\n保存期間を過ぎたデータは、猶予の後の定期削除で削除されます。よろしいですか？`)) return
  try {
    await axios.delete(`/api/hq/retention/holds/${kind}/${Number(el.dataset.id)}`)
    toast('保留を解除しました'); renderRetention()
  } catch (e) { showApiError(e, '解除できませんでした') }
}))

// ---------- 在職中の保存期間の設定（#420 #511 #350） ----------
async function loadRetentionSettings() {
  const box = document.getElementById('retention-settings')
  if (!box) return
  let data
  try { data = (await axios.get('/api/hq/retention/settings')).data } catch (e) {
    box.innerHTML = '<p class="text-sm text-red-400">保存期間の設定を読み込めませんでした</p>'; return
  }
  box.innerHTML = `
    <h3 class="font-bold mb-1">保存期間の設定（在職中）</h3>
    <p class="text-xs text-slate-400 mb-3">勤怠の時刻・種別は残し、位置情報・写真などだけを消します。期間を短くすると、次の定期処理（3:30）で新しい期間を過ぎた分が削除されます。</p>
    <div class="grid md:grid-cols-2 gap-3">
      ${Object.entries(data.defs).map(([k, d]) => `
        <label class="text-xs text-slate-300">${esc(d.label)}
          <input type="number" class="inp mt-1" data-retention-key="${esc(k)}" data-orig="${esc(data.settings[k])}" min="${esc(d.min)}" max="${esc(d.max)}" value="${esc(data.settings[k])}">
          <span class="text-[11px] text-slate-500">既定 ${esc(d.def)}・${esc(d.min)}〜${esc(d.max)}</span>
        </label>`).join('')}
    </div>
    <button class="btn btn-primary text-xs mt-3" data-action="saveRetentionSettings">保存する</button>`
}
delegate('saveRetentionSettings', (el) => withSubmitLock(el, async () => {
  const body = {}
  let shorter = false
  document.querySelectorAll('[data-retention-key]').forEach(inp => {
    if (inp.value === inp.dataset.orig) return
    body[inp.dataset.retentionKey] = Number(inp.value)
    if (Number(inp.value) < Number(inp.dataset.orig)) shorter = true
  })
  if (!Object.keys(body).length) return toast('変更がありません')
  if (shorter && !confirm('保存期間を短くします。次の定期処理で、新しい期間を過ぎたデータが元に戻せない形で削除されます。よろしいですか？')) return
  try {
    await axios.put('/api/hq/retention/settings', body)
    toast('保存期間の設定を保存しました'); loadRetentionSettings()
  } catch (e) { showApiError(e, '保存できませんでした') }
}))

// ---------- 勤怠に紐づかない写真（#533 の残り） ----------
// R2 の attendance/ 以下を500件ずつ見て、どの勤怠にも紐づかない写真（報告の登録に失敗したときの残りなど）を数え、確認してから消す
const retentionOrphanState = { cursor: null, last: null }
function retentionOrphanHtml() {
  const r = retentionOrphanState.last
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5" id="retention-orphans">
      <h3 class="font-bold mb-1">勤怠に紐づかない写真</h3>
      <p class="text-xs text-slate-400 mb-3">報告の登録に失敗したときなどに R2 に残った写真を探します（アップロードから1日以内のものは対象外）。まず確認し、件数を見てから削除してください。1回に500件ずつ確認します。</p>
      <div class="flex gap-2 flex-wrap">
        <button class="btn btn-outline text-xs" data-action="scanOrphanPhotos" data-mode="first">最初から確認（削除しない）</button>
        ${r && r.next_cursor ? '<button class="btn btn-outline text-xs" data-action="scanOrphanPhotos" data-mode="next">次の500件を確認</button>' : ''}
        ${r && r.orphans > 0 ? '<button class="btn btn-danger text-xs" data-action="deleteOrphanPhotos">このページの紐づかない写真を削除</button>' : ''}
      </div>
      ${r ? `<p class="text-xs mt-3">確認した写真 ${esc(r.scanned)}件のうち、紐づかないもの <b class="${r.orphans ? 'text-amber-400' : ''}">${esc(r.orphans)}件</b>${r.deleted ? `（${esc(r.deleted)}件を削除しました）` : ''}${r.next_cursor ? '。続きがあります' : '。最後まで確認しました'}</p>
        ${r.samples && r.samples.length ? `<details class="mt-1"><summary class="text-xs text-slate-400 cursor-pointer">例（先頭の${esc(r.samples.length)}件）</summary><pre class="text-[11px] text-slate-400 mt-1" style="white-space:pre-wrap;word-break:break-all">${esc(r.samples.join('\n'))}</pre></details>` : ''}` : ''}
    </section>`
}
function redrawOrphan() {
  const box = document.getElementById('retention-orphans')
  if (box) box.outerHTML = retentionOrphanHtml()
}
delegate('scanOrphanPhotos', (el) => withSubmitLock(el, async () => {
  const cursor = el.dataset.mode === 'next' && retentionOrphanState.last ? retentionOrphanState.last.next_cursor : null
  try {
    const { data } = await axios.post('/api/hq/retention/orphan-photos', { dry_run: true, cursor })
    retentionOrphanState.cursor = cursor
    retentionOrphanState.last = data
    redrawOrphan()
  } catch (e) { showApiError(e, '写真を確認できませんでした') }
}))
delegate('deleteOrphanPhotos', (el) => withSubmitLock(el, async () => {
  const r = retentionOrphanState.last
  if (!r || !confirm(`このページの勤怠に紐づかない写真 ${r.orphans}件を R2 から削除します。元に戻せません。よろしいですか？`)) return
  try {
    // 削除の直前にもう一度、同じページを確かめてから消す
    const { data } = await axios.post('/api/hq/retention/orphan-photos', { dry_run: false, cursor: retentionOrphanState.cursor })
    retentionOrphanState.last = data
    redrawOrphan()
    toast(`${data.deleted}件の写真を削除しました`)
    retentionState.logPage = 1
    await loadRetentionLogs()
  } catch (e) { showApiError(e, '写真を削除できませんでした') }
}))

// 実行ログ（1回の実行を1行にまとめ、開くと対象ごとの内訳。#305）
function retentionRunRow(r) {
  const items = r.items.map(i => `
    <tr>
      <td>${esc(RETENTION_TARGET_LABEL[i.target] || i.target)}</td>
      <td>${esc(i.target_count)}</td><td>${esc(i.deleted_count)}</td>
      <td>${i.failed_count > 0 ? `<span class="text-red-400">${esc(i.failed_count)}</span>` : '0'}</td>
    </tr>${i.error_message ? `
    <tr><td colspan="4" class="text-xs text-red-400" style="white-space:pre-wrap;word-break:break-all">失敗の理由: ${esc(i.error_message)}</td></tr>` : ''}`).join('')
  // トークンの削除は動作モードに関係なく毎日実削除で記録されるので、データ保持の実行と見分けられるようにする
  const isTokenRun = r.items.length > 0 && r.items.every(i => RETENTION_TOKEN_TARGETS.includes(i.target))
  return `
    <tr>
      <td class="text-xs">${r.started_at ? esc(dayjs(r.started_at).format('YYYY/M/D HH:mm')) : '-'}</td>
      <td class="text-xs">${esc(RETENTION_TRIGGER_LABEL[r.trigger_source] || '-')}${r.triggered_by_name ? `<br><span class="text-slate-500">${esc(r.triggered_by_name)}</span>` : ''}</td>
      <td><span class="badge ${r.dry_run ? 'badge-gray' : 'badge-blue'}">${r.dry_run ? 'dry-run' : '実削除'}</span>${isTokenRun ? '<br><span class="text-xs text-slate-500">トークンの削除</span>' : ''}</td>
      <td>${r.staff_count == null ? '-' : esc(r.staff_count) + '人'}</td>
      <td>${esc(r.target_count)}</td>
      <td>${esc(r.deleted_count)}</td>
      <td>${r.failed_count > 0 ? `<span class="badge badge-red">失敗 ${esc(r.failed_count)}</span>` : '<span class="badge badge-green">なし</span>'}</td>
      <td class="text-xs">${r.duration_ms == null ? '-' : esc(formatDuration(r.duration_ms))}</td>
    </tr>
    <tr>
      <td colspan="8" style="padding-top:0">
        <details${r.failed_count > 0 ? ' open' : ''}>
          <summary class="text-xs text-slate-400 cursor-pointer">対象ごとの内訳（${esc(r.items.length)}件）</summary>
          <div class="overflow-x-auto mt-1">
            <table class="tbl"><thead><tr><th>対象</th><th>対象件数</th><th>削除件数</th><th>失敗</th></tr></thead><tbody>${items}</tbody></table>
          </div>
        </details>
      </td>
    </tr>`
}
async function loadRetentionLogs() {
  const box = document.getElementById('retention-logs')
  if (!box) return
  let data
  try {
    data = (await axios.get('/api/hq/retention/logs', { params: { page: retentionState.logPage, trigger: retentionState.logTrigger } })).data
  } catch (e) {
    box.innerHTML = '<p class="text-sm text-red-400">実行ログの取得に失敗しました</p>'
    return
  }
  const pages = Math.max(1, Math.ceil(data.total / data.per_page))
  const fmt = (v) => v ? esc(dayjs(v).format('YYYY/M/D HH:mm')) : 'まだありません'
  const tab = (key, label) => `<button class="btn ${retentionState.logTrigger === key ? 'btn-primary' : 'btn-outline'} text-xs" data-action="retentionLogTrigger" data-trigger="${key}">${label}</button>`
  box.innerHTML = `
    <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
      <h3 class="font-bold">実行ログ</h3>
      <div class="flex gap-1">${tab('all', 'すべて')}${tab('cron', '定期処理')}${tab('manual', '手動の dry-run')}</div>
    </div>
    <p class="text-xs text-slate-400 mb-3">直近の定期処理: ${fmt(data.latest && data.latest.last_cron_run)} ／ 直近の実削除: ${fmt(data.latest && data.latest.last_real_run)}。件数の合計に退職スタッフの人数は含みません。</p>
    <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>実行日時</th><th>実行元</th><th>種別</th><th>退職者</th><th>対象件数</th><th>削除件数</th><th>失敗</th><th>所要時間</th></tr></thead>
        <tbody>${data.runs.length ? data.runs.map(retentionRunRow).join('') : '<tr><td colspan="8" class="text-center text-slate-500 py-4">実行履歴がありません</td></tr>'}</tbody>
      </table>
    </div>
    <div class="flex items-center justify-between mt-3 text-xs text-slate-400">
      <span>全${esc(data.total)}回</span>
      <div class="flex items-center gap-2">
        <button class="btn btn-outline text-xs" data-action="retentionLogPage" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>前へ</button>
        <span>${esc(data.page)} / ${esc(pages)}</span>
        <button class="btn btn-outline text-xs" data-action="retentionLogPage" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>次へ</button>
      </div>
    </div>`
}
delegate('retentionLogTrigger', el => {
  retentionState.logTrigger = el.dataset.trigger || 'all'
  retentionState.logPage = 1
  loadRetentionLogs()
})
delegate('retentionLogPage', el => {
  retentionState.logPage = Math.max(1, Number(el.dataset.page) || 1)
  loadRetentionLogs()
})
// 二重に実行しないよう、実行中はボタンを無効にする。結果は描き直さずに残し、実行ログだけを取り直す（#244）
delegate('runRetentionDryRun', el => withSubmitLock(el, async () => {
  const box = document.getElementById('retention-dryrun-result')
  box.innerHTML = '<div class="flex justify-center py-6"><span class="spin"></span></div>'
  try {
    const { data } = await axios.post('/api/hq/retention/dry-run')
    retentionState.dryRun = data
    box.innerHTML = retentionDryRunHtml(data)
    toast('dry-runが完了しました')
    retentionState.logPage = 1
    await loadRetentionLogs()
  } catch (e) {
    box.innerHTML = retentionState.dryRun ? retentionDryRunHtml(retentionState.dryRun) : ''
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
// #179 管理画面から届いた依頼の受付一覧（未対応・対応中・完了）と、#293 企業の管理画面の閲覧（読み取り専用・期限付き・記録あり）
const HQ_SUPPORT = { status: '' }
const SUPPORT_STATUS_BADGE = { open: '<span class="badge badge-red">未対応</span>', in_progress: '<span class="badge badge-yellow">対応中</span>', done: '<span class="badge badge-green">完了</span>' }
const VIEW_END_LABEL = { hq: '終了', replaced: '別の企業へ', revoked: '企業が取消', logout: 'ログアウト' }
const hqTime = (v, utc) => v ? dayjs(String(v).replace(' ', 'T') + (utc && !/Z$/.test(String(v)) ? 'Z' : '')).format('YYYY/M/D HH:mm') : ''
let HQ_SUPPORT_REQS = new Map()
let HQ_VIEW_DATA = null
async function renderSupport() {
  loading()
  const [{ data }, reqs, views] = await Promise.all([
    axios.get('/api/hq/companies'),
    axios.get('/api/hq/support-requests', { params: { status: HQ_SUPPORT.status } }).then(r => r.data),
    axios.get('/api/hq/view-sessions').then(r => r.data),
  ])
  HQ_SUPPORT_REQS = new Map(reqs.requests.map(r => [r.request_id, r]))
  HQ_VIEW_DATA = views
  updateSupportBadge(reqs.counts)
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
  const counts = reqs.counts || {}
  const tab = (key, label) => `<button class="text-xs px-2 py-1 rounded-lg border ${HQ_SUPPORT.status === key ? 'border-cyan-500 text-cyan-300' : 'border-slate-600 text-slate-400'}" data-action="hqSupportFilter" data-status="${key}">${label}${key ? `（${Number(counts[key]) || 0}）` : ''}</button>`
  const cur = views.current
  $app.innerHTML = `
    <h2 class="text-xl font-bold mb-5">伴走支援管理</h2>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <h3 class="font-bold mr-2"><i class="fas fa-inbox text-cyan-400 mr-1"></i>依頼の受付</h3>
        ${tab('', 'すべて')}${tab('open', '未対応')}${tab('in_progress', '対応中')}${tab('done', '完了')}
      </div>
      <p class="text-[11px] text-slate-400 mb-2">管理画面の「伴走支援を依頼する」から届いた依頼です。届いたときは、メールアドレスのある本部ユーザーにメールでも知らせます。</p>
      <div class="overflow-x-auto"><table class="w-full text-xs">
        <thead><tr class="text-slate-400 border-b border-slate-700">
          <th class="text-left px-2 py-2">No.</th><th class="text-left px-2 py-2">受付</th><th class="text-left px-2 py-2">企業・依頼者</th><th class="text-left px-2 py-2">メニュー</th><th class="text-left px-2 py-2">内容</th><th class="text-left px-2 py-2">希望日時・連絡先</th><th class="text-left px-2 py-2">状況</th><th></th>
        </tr></thead>
        <tbody>${reqs.requests.map(r => `
          <tr class="border-b border-slate-700/40 align-top">
            <td class="px-2 py-2 text-slate-400">${Number(r.request_id)}</td>
            <td class="px-2 py-2 whitespace-nowrap">${esc(hqTime(r.created_at, true))}</td>
            <td class="px-2 py-2"><a href="#companies/${Number(r.company_id)}" class="text-cyan-400 hover:underline">${esc(r.company_name)}</a><span class="block text-slate-400">${esc(r.requester_name || '')}</span></td>
            <td class="px-2 py-2 whitespace-nowrap">${esc((reqs.menus || {})[r.menu] || r.menu)}</td>
            <td class="px-2 py-2 max-w-xs"><p class="whitespace-pre-wrap">${esc(r.detail)}</p>${r.hq_note ? `<p class="text-slate-400 mt-1 whitespace-pre-wrap">対応メモ: ${esc(r.hq_note)}</p>` : ''}</td>
            <td class="px-2 py-2 text-slate-300">${esc(r.preferred_at || '-')}<span class="block text-slate-400">${esc(r.contact || '')}</span></td>
            <td class="px-2 py-2 whitespace-nowrap">${SUPPORT_STATUS_BADGE[r.status] || esc(r.status)}${r.handled_by_name ? `<span class="block text-slate-500 mt-1">${esc(r.handled_by_name)}</span>` : ''}</td>
            <td class="px-2 py-2"><button class="text-cyan-400 hover:underline whitespace-nowrap" data-action="hqEditSupport" data-id="${Number(r.request_id)}">対応</button></td>
          </tr>`).join('') || '<tr><td colspan="8" class="text-center text-slate-500 py-4">依頼はありません</td></tr>'}</tbody>
      </table></div>
    </section>

    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <h3 class="font-bold mb-1"><i class="fas fa-eye text-cyan-400 mr-1"></i>管理画面の閲覧（読み取り専用）</h3>
      <p class="text-[11px] text-slate-400 mb-3">企業が管理画面で許可している場合だけ、期限付きで閲覧できます。登録・変更はできず、従業員管理（労務情報）とセキュリティの画面は開けません。開始・終了と開いた画面は記録され、企業の管理者も確認できます。同時に開けるのは1社だけです。</p>
      ${cur ? `<div class="bg-cyan-900/30 border border-cyan-700 rounded-lg p-3 mb-3 text-sm flex flex-wrap items-center gap-3">
        <span class="flex-1">閲覧中: <b>${esc(cur.company_name)}</b>（${esc(hqTime(cur.expires_at))} まで）</span>
        <a href="/admin" target="_blank" rel="noopener" class="btn btn-outline text-xs" style="border-color:#334155;color:#67e8f9"><i class="fas fa-arrow-up-right-from-square"></i>管理画面を開く</a>
        <button class="btn btn-outline text-xs" style="border-color:#334155;color:#fca5a5" data-action="hqEndView">閲覧を終了</button></div>` : ''}
      <div class="overflow-x-auto max-h-72 overflow-y-auto mb-4"><table class="w-full text-xs">
        <thead><tr class="text-slate-400 border-b border-slate-700"><th class="text-left px-2 py-2">企業</th><th class="text-left px-2 py-2">閲覧の許可</th><th></th></tr></thead>
        <tbody>${views.companies.map(c => `
          <tr class="border-b border-slate-700/40">
            <td class="px-2 py-2">${esc(c.company_name)} <span class="text-slate-500">${esc(c.company_code)}</span>${c.active_status === 'inactive' ? ' <span class="badge badge-gray">停止</span>' : ''}</td>
            <td class="px-2 py-2">${c.allowed ? '<span class="badge badge-green">許可あり</span>' : '<span class="text-slate-500">許可なし</span>'}</td>
            <td class="px-2 py-2 text-right">${c.allowed ? `<button class="text-cyan-400 hover:underline" data-action="hqStartView" data-cid="${Number(c.company_id)}" data-name="${esc(c.company_name)}">閲覧する</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <h4 class="font-bold text-sm mb-2">閲覧の記録（直近50件）</h4>
      <div class="overflow-x-auto"><table class="w-full text-xs">
        <thead><tr class="text-slate-400 border-b border-slate-700"><th class="text-left px-2 py-2">開始</th><th class="text-left px-2 py-2">企業</th><th class="text-left px-2 py-2">本部の担当</th><th class="text-left px-2 py-2">目的</th><th class="text-left px-2 py-2">終了</th><th class="text-right px-2 py-2">画面</th></tr></thead>
        <tbody>${views.sessions.map(v => `
          <tr class="border-b border-slate-700/40">
            <td class="px-2 py-2 whitespace-nowrap">${esc(hqTime(v.started_at))}</td>
            <td class="px-2 py-2">${esc(v.company_name)}</td>
            <td class="px-2 py-2">${esc(v.hq_name || '')}</td>
            <td class="px-2 py-2">${esc(v.reason)}${v.support_request_id ? ` <span class="text-slate-500">（依頼 No.${Number(v.support_request_id)}）</span>` : ''}</td>
            <td class="px-2 py-2 whitespace-nowrap">${v.ended_at ? `${esc(hqTime(v.ended_at))} ${esc(VIEW_END_LABEL[v.end_reason] || '')}` : Date.parse(v.expires_at) > Date.parse(views.now) ? '<span class="badge badge-blue">閲覧中</span>' : `${esc(hqTime(v.expires_at))} 期限`}</td>
            <td class="px-2 py-2 text-right">${Number(v.pages) ? `<button class="text-cyan-400 hover:underline" data-action="hqViewLogs" data-id="${Number(v.view_id)}">${Number(v.pages)}件</button>` : '0件'}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="text-center text-slate-500 py-4">記録はありません</td></tr>'}</tbody>
      </table></div>
    </section>

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
              <td class="px-3 py-3"><a href="#companies/${Number(c.company_id)}" class="text-cyan-400 text-xs hover:underline">編集 →</a></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>`
}
function updateSupportBadge(counts) {
  const b = document.getElementById('hq-support-badge')
  if (!b) return
  const n = Number((counts || {}).open) || 0
  b.textContent = n
  b.classList.toggle('hidden', !n)
}
async function refreshSupportBadge() {
  try { updateSupportBadge((await axios.get('/api/hq/support-requests', { params: { status: 'open' } })).data.counts) } catch { }
}
delegate('hqSupportFilter', (el) => { HQ_SUPPORT.status = el.dataset.status || ''; renderSupport() })
delegate('hqEditSupport', (el) => {
  const r = HQ_SUPPORT_REQS.get(Number(el.dataset.id))
  if (!r) return
  modal(`
    <h3 class="font-bold text-lg mb-1 text-gray-800">依頼 No.${Number(r.request_id)} の対応</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(r.company_name)}・${esc(r.requester_name || '')}</p>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">対応状況</label>
        <select id="sr-status" class="inp">${Object.entries({ open: '未対応', in_progress: '対応中', done: '完了' }).map(([k, v]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div><label class="text-sm text-gray-600 block mb-1">対応メモ（本部のみ）</label>
        <textarea id="sr-note" rows="4" maxlength="2000" class="inp">${esc(r.hq_note || '')}</textarea></div>
      <button class="btn btn-primary w-full" data-action="hqSaveSupport" data-id="${Number(r.request_id)}">保存する</button>
    </div>`)
})
delegate('hqSaveSupport', (el) => withSubmitLock(el, async () => {
  try {
    await axios.put('/api/hq/support-requests/' + Number(el.dataset.id), { status: document.getElementById('sr-status').value, hq_note: document.getElementById('sr-note').value })
    closeModal(); toast('保存しました'); renderSupport()
  } catch (e) { hqErr(e, '保存に失敗しました') }
}))
delegate('hqStartView', (el) => {
  const cid = Number(el.dataset.cid)
  const minutes = (HQ_VIEW_DATA && HQ_VIEW_DATA.minutes) || [15, 30, 60]
  const openReqs = [...HQ_SUPPORT_REQS.values()].filter(r => r.company_id === cid && r.status !== 'done')
  modal(`
    <h3 class="font-bold text-lg mb-1 text-gray-800">管理画面を閲覧する</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(el.dataset.name)} の管理画面を、読み取り専用で開きます。目的は企業の管理者にも表示されます。</p>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">目的 *（問い合わせの内容など）</label><input id="vw-reason" class="inp" maxlength="200" placeholder="例: シフトが表示されないとの問い合わせの確認"></div>
      ${openReqs.length ? `<div><label class="text-sm text-gray-600 block mb-1">対応する依頼</label><select id="vw-request" class="inp"><option value="">なし</option>${openReqs.map(r => `<option value="${Number(r.request_id)}">No.${Number(r.request_id)} ${esc(String(r.detail).slice(0, 30))}</option>`).join('')}</select></div>` : ''}
      <div><label class="text-sm text-gray-600 block mb-1">閲覧の時間</label><select id="vw-minutes" class="inp">${minutes.map(m => `<option value="${Number(m)}" ${m === 30 ? 'selected' : ''}>${Number(m)}分</option>`).join('')}</select></div>
      <p class="text-[11px] text-gray-400">別の企業を閲覧中なら、そちらは終了します。</p>
      <button class="btn btn-primary w-full" data-action="hqDoStartView" data-cid="${cid}">閲覧を開始する（新しいタブで開きます）</button>
    </div>`)
})
delegate('hqDoStartView', (el) => withSubmitLock(el, async () => {
  const reqEl = document.getElementById('vw-request')
  const body = { company_id: Number(el.dataset.cid), reason: document.getElementById('vw-reason').value.trim(), minutes: Number(document.getElementById('vw-minutes').value), support_request_id: reqEl && reqEl.value ? Number(reqEl.value) : null }
  if (!body.reason) { toast('目的を入力してください'); return }
  // ポップアップのブロックを避けるため、クリックの処理の中で先にタブを開いておく
  const w = window.open('', '_blank')
  try {
    const { data } = await axios.post('/api/hq/view-sessions', body)
    if (w) w.location.href = data.redirect || '/admin'
    else location.href = data.redirect || '/admin'
    closeModal(); renderSupport()
  } catch (e) { if (w) w.close(); hqErr(e, '閲覧を開始できませんでした') }
}))
delegate('hqEndView', (el) => withSubmitLock(el, async () => {
  try { await axios.delete('/api/hq/view-sessions/current'); toast('閲覧を終了しました'); renderSupport() } catch (e) { hqErr(e, '終了できませんでした') }
}))
delegate('hqViewLogs', (el) => withSubmitLock(el, async () => {
  try {
    const { data } = await axios.get(`/api/hq/view-sessions/${Number(el.dataset.id)}/logs`)
    modal(`<h3 class="font-bold text-lg mb-3 text-gray-800">開いた画面（API）</h3>
      <div class="max-h-96 overflow-y-auto text-xs text-gray-700 divide-y divide-gray-100">${data.logs.map(l => `<div class="py-1 flex gap-3"><span class="text-gray-400 whitespace-nowrap">${esc(hqTime(l.created_at))}</span><span class="break-all">${esc(l.method)} ${esc(l.path)}</span></div>`).join('')}</div>`)
  } catch (e) { hqErr(e, '読み込めませんでした') }
}))

// ============ 導入企業へのお知らせ（#516） ============
// 本部から導入企業の管理者へ（全企業・選んだ企業・プラン別）。管理画面の上部に出し、管理者が「確認しました」を押すと既読になる
const ANN_IMPORTANCE_LABEL = { normal: '通常', important: '重要', maintenance: 'メンテナンス' }
const ANN_IMPORTANCE_BADGE = { normal: 'badge-blue', important: 'badge-red', maintenance: 'badge-yellow' }
const ANN_STATE_LABEL = { active: '<span class="badge badge-green">掲載中</span>', scheduled: '<span class="badge badge-blue">予約</span>', ended: '<span class="badge badge-gray">掲載終了</span>', withdrawn: '<span class="badge badge-gray">取消</span>' }
let HQ_ANN = { list: [], companies: [] }
const annLocal = v => v ? String(v).replace(' ', 'T') : ''
async function renderAnnouncements() {
  loading()
  const { data } = await axios.get('/api/hq/announcements')
  HQ_ANN = { list: data.announcements, companies: data.companies }
  const target = a => a.target === 'all' ? '全企業' : a.target === 'plan' ? `${esc(PLAN_LABELS[a.target_plan] || a.target_plan)}プラン` : `選んだ企業（${(a.company_ids || []).length}社）`
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold">導入企業へのお知らせ</h2>
      <button class="btn btn-primary" style="background:#0e7490" data-action="hqAnnEdit"><i class="fas fa-plus"></i>お知らせを作る</button>
    </div>
    <p class="text-xs text-slate-400 mb-3">メンテナンス・仕様変更・新機能の案内などを、導入企業の管理画面の上部に出します。管理者が「確認しました」を押すと既読になります。掲載期間を過ぎたものは自動で出なくなります（メンテナンスは掲載終了が必須）。</p>
    <div class="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700">
          <th class="text-left px-3 py-2">状態</th><th class="text-left px-3 py-2">タイトル</th><th class="text-left px-3 py-2">配信先</th><th class="text-left px-3 py-2">掲載期間</th><th class="text-right px-3 py-2">確認した企業</th><th></th>
        </tr></thead>
        <tbody>${data.announcements.map(a => `
          <tr class="border-b border-slate-700/40 align-top">
            <td class="px-3 py-2 whitespace-nowrap">${ANN_STATE_LABEL[a.state] || ''}</td>
            <td class="px-3 py-2"><span class="badge ${ANN_IMPORTANCE_BADGE[a.importance] || 'badge-gray'}">${esc(ANN_IMPORTANCE_LABEL[a.importance] || a.importance)}</span> ${esc(a.title)}<span class="block text-[11px] text-slate-500">${esc(a.created_by_name || '')}</span></td>
            <td class="px-3 py-2 text-xs">${target(a)}</td>
            <td class="px-3 py-2 text-xs whitespace-nowrap">${esc(a.starts_at)} 〜 ${esc(a.ends_at || '期限なし')}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap"><button class="text-cyan-400 hover:underline" data-action="hqAnnReads" data-id="${Number(a.announcement_id)}">${Number(a.read_companies) || 0} / ${Number(a.target_count) || 0}社</button></td>
            <td class="px-3 py-2 text-right whitespace-nowrap">${a.state === 'withdrawn' ? '' : `<button class="text-cyan-400 text-xs hover:underline mr-2" data-action="hqAnnEdit" data-id="${Number(a.announcement_id)}">修正</button><button class="text-red-400 text-xs hover:underline" data-action="hqAnnWithdraw" data-id="${Number(a.announcement_id)}">取消</button>`}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="text-center text-slate-500 py-6">お知らせはまだありません</td></tr>'}</tbody>
      </table>
    </div>`
}
delegate('hqAnnEdit', (el) => {
  const a = el.dataset.id ? HQ_ANN.list.find(x => x.announcement_id === Number(el.dataset.id)) : null
  const sel = new Set(a ? a.company_ids || [] : [])
  const t = a ? a.target : 'all'
  modal(`
    <h3 class="font-bold text-lg mb-3 text-gray-800">${a ? 'お知らせを修正' : 'お知らせを作る'}</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">タイトル *</label><input id="an-title" class="inp" maxlength="100" value="${esc(a ? a.title : '')}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">本文 *</label><textarea id="an-body" rows="5" maxlength="3000" class="inp">${esc(a ? a.body : '')}</textarea></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">重要度</label><select id="an-importance" class="inp">${Object.entries(ANN_IMPORTANCE_LABEL).map(([k, v]) => `<option value="${k}" ${(a ? a.importance : 'normal') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">配信先</label><select id="an-target" class="inp">
          <option value="all" ${t === 'all' ? 'selected' : ''}>全企業</option><option value="plan" ${t === 'plan' ? 'selected' : ''}>プラン別</option><option value="companies" ${t === 'companies' ? 'selected' : ''}>企業を選ぶ</option></select></div>
      </div>
      <div id="an-plan-box" class="${t === 'plan' ? '' : 'hidden'}"><label class="text-sm text-gray-600 block mb-1">プラン</label><select id="an-plan" class="inp">${Object.entries(PLAN_LABELS).map(([k, v]) => `<option value="${k}" ${a && a.target_plan === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div id="an-companies-box" class="${t === 'companies' ? '' : 'hidden'}"><label class="text-sm text-gray-600 block mb-1">企業</label>
        <div class="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 text-sm text-gray-700 space-y-1">${HQ_ANN.companies.map(c => `<label class="flex items-center gap-2"><input type="checkbox" class="an-company" value="${Number(c.company_id)}" ${sel.has(c.company_id) ? 'checked' : ''}>${esc(c.company_name)}${c.active_status === 'inactive' ? '（停止）' : ''}</label>`).join('')}</div></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">掲載開始（空欄なら今から）</label><input id="an-starts" type="datetime-local" class="inp" value="${esc(annLocal(a && a.starts_at))}"></div>
        <div><label class="text-sm text-gray-600 block mb-1">掲載終了</label><input id="an-ends" type="datetime-local" class="inp" value="${esc(annLocal(a && a.ends_at))}"></div>
      </div>
      <p class="text-[11px] text-gray-400">日時は日本時間です。${a ? '修正しても、確認済みの記録はそのまま残ります。' : ''}</p>
      <button class="btn btn-primary w-full" data-action="hqAnnSave" data-id="${a ? Number(a.announcement_id) : ''}">${a ? '保存する' : '配信する'}</button>
    </div>`)
  document.getElementById('an-target').addEventListener('change', e => {
    document.getElementById('an-plan-box').classList.toggle('hidden', e.target.value !== 'plan')
    document.getElementById('an-companies-box').classList.toggle('hidden', e.target.value !== 'companies')
  })
})
delegate('hqAnnSave', (el) => withSubmitLock(el, async () => {
  const body = {
    title: document.getElementById('an-title').value.trim(), body: document.getElementById('an-body').value.trim(),
    importance: document.getElementById('an-importance').value, target: document.getElementById('an-target').value,
    target_plan: document.getElementById('an-plan').value,
    company_ids: [...document.querySelectorAll('.an-company:checked')].map(x => Number(x.value)),
    starts_at: document.getElementById('an-starts').value, ends_at: document.getElementById('an-ends').value,
  }
  try {
    if (el.dataset.id) await axios.put('/api/hq/announcements/' + Number(el.dataset.id), body)
    else await axios.post('/api/hq/announcements', body)
    closeModal(); toast(el.dataset.id ? '保存しました' : '配信しました'); renderAnnouncements()
  } catch (e) { hqErr(e, '保存に失敗しました') }
}))
delegate('hqAnnWithdraw', (el) => withSubmitLock(el, async () => {
  if (!confirm('このお知らせを取り消しますか？管理画面に出なくなります')) return
  try { await axios.post(`/api/hq/announcements/${Number(el.dataset.id)}/withdraw`); toast('取り消しました'); renderAnnouncements() } catch (e) { hqErr(e, '取り消せませんでした') }
}))
delegate('hqAnnReads', (el) => withSubmitLock(el, async () => {
  try {
    const { data } = await axios.get(`/api/hq/announcements/${Number(el.dataset.id)}/reads`)
    const unread = data.companies.filter(c => !Number(c.read_users)).length
    modal(`<h3 class="font-bold text-lg mb-1 text-gray-800">企業別の確認状況</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(data.announcement.title)}｜未確認 ${unread}社 / ${data.companies.length}社</p>
      <div class="max-h-96 overflow-y-auto text-sm text-gray-700 divide-y divide-gray-100">${data.companies.map(c => `<div class="py-1.5 flex items-center gap-2"><span class="flex-1">${esc(c.company_name)}</span>${Number(c.read_users) ? `<span class="badge badge-green">確認済み ${Number(c.read_users)}名</span><span class="text-xs text-gray-400">${esc(hqTime(c.first_read_at, true))}</span>` : '<span class="badge badge-red">未確認</span>'}</div>`).join('') || '<p class="text-gray-400 py-2">配信先の企業がありません</p>'}</div>`)
  } catch (e) { hqErr(e, '読み込めませんでした') }
}))

// ============ メール送信（#438 #541） ============
// 直近の期間の会社別・種類別の送信数と、届かなかった割合・理由の上位・最後に成功した日時。宛先は伏せて表示する
const MAIL_TYPE_LABEL = { notice: 'お知らせ', attendance_correction: '打刻修正の通知', incident_report: 'インシデントの通知', password_reset: 'パスワード再設定', account_email: 'メールアドレスの確認',
  recruit_applied: '新しい応募', board_message: '案件掲示板', roster_chat: '企業間チャット', consultation: '相談・連絡', reminder: '報告の催促',
  shift_change: 'シフトの変更', recruit_result: '応募の結果', recruit_new: '新しい募集', notification_digest: '通知のまとめ' }
const MAIL_STATUS_LABEL = { sent: '送信済み', delivered: '配信済み', failed: '送信失敗', bounced: '不達', bounced_soft: '一時的な不達', complained: '迷惑メール報告', skipped: '送信無効' }
const MAIL_ERR_LABEL = { mail_not_configured: '送信設定なし（RESEND_API_KEY / MAIL_FROM）', resend_error: '送信サービスのエラー', network_error: '通信エラー', invalid_address: 'アドレスの形式の誤り',
  bounced: '不達', bounced_soft: '一時的な不達', complained: '迷惑メール報告', suppressed_bounced: '不達のアドレスのため停止', suppressed_complained: '迷惑メール報告のアドレスのため停止', company_inactive: '契約停止中の企業' }
const HQ_MAIL = { days: 7, company_id: '', status: 'failed', logs: [], hasMore: false }
async function renderHqMail() {
  loading()
  let stats, sup
  try {
    [stats, sup] = await Promise.all([axios.get('/api/hq/email-stats', { params: { days: HQ_MAIL.days } }), axios.get('/api/hq/email-suppressions')]).then(r => r.map(x => x.data))
    await loadHqMailLogs(false)
  } catch (e) { $app.innerHTML = `<p class="text-red-400">${esc((e.response && e.response.data && e.response.data.error) || '読み込めませんでした')}</p>`; return }
  if (HQ_MAIL.days === 7) renderMailAlert(stats)
  const pct = (r) => `${Math.round(r * 1000) / 10}%`
  // 会社ごとの今日の送信数（today_total）と1日の目安（alert.daily_limit）。サーバーが返すときだけ列を出す（#392）
  const hasToday = stats.companies.some(c => c.today_total != null)
  const dailyLimit = Number(stats.alert && stats.alert.daily_limit) || 0
  $app.innerHTML = `
    <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
      <h2 class="text-xl font-bold">メール送信</h2>
      <select id="hm-days" class="bg-slate-800 border border-slate-600 rounded-lg px-2 py-1.5 text-sm">${[7, 30, 90].map(d => `<option value="${d}" ${HQ_MAIL.days === d ? 'selected' : ''}>直近${d}日</option>`).join('')}</select>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      ${[['送信', stats.totals.total, ''], ['送信済み・配信済み', stats.totals.ok, 'text-emerald-400'], ['届かなかった', stats.totals.failed, stats.totals.failed ? 'text-red-400' : ''], ['送信を止めているアドレス', stats.suppressed_count, '']]
        .map(([l, v, c]) => `<div class="bg-slate-800 border border-slate-700 rounded-xl p-3"><p class="text-xs text-slate-400">${l}</p><p class="text-2xl font-bold ${c}">${Number(v)}</p></div>`).join('')}
    </div>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4 overflow-x-auto">
      <h3 class="font-bold mb-2"><i class="fas fa-building text-cyan-400 mr-1"></i>会社別</h3>
      <p class="text-[11px] text-slate-400 mb-2">届かなかった割合が${Math.round(stats.alert.rate * 100)}%以上（送信${stats.alert.min}件以上）の会社は、画面の上部に警告を出します。送信無効の環境（MAIL_ENABLED=false）で送らなかったものは割合に含めません。${dailyLimit ? `今日の送信数が1日の目安（${dailyLimit}件）の8割を超えた会社も警告します。` : ''}</p>
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700"><th class="text-left px-2 py-2">企業</th>${hasToday ? `<th class="text-right px-2" title="今日（日本時間）の送信数${dailyLimit ? `。1日の目安 ${dailyLimit}件` : ''}">今日</th>` : ''}<th class="text-right px-2">送信</th><th class="text-right px-2">成功</th><th class="text-right px-2">届かなかった</th><th class="text-right px-2">割合</th><th class="text-left px-2">種類別（成功/送信）</th><th class="text-left px-2">最後に成功</th><th></th></tr></thead>
        <tbody>${stats.companies.map(c => `<tr class="border-b border-slate-700/40">
          <td class="px-2 py-2">${esc(c.company_name)}</td>${hasToday ? `<td class="px-2 text-right ${dailyLimit && Number(c.today_total) >= dailyLimit * 0.8 ? 'text-amber-400 font-bold' : ''}">${Number(c.today_total) || 0}</td>` : ''}<td class="px-2 text-right">${c.total}</td><td class="px-2 text-right">${c.ok}</td>
          <td class="px-2 text-right ${c.failed ? 'text-red-400' : ''}">${c.failed}</td><td class="px-2 text-right ${c.failure_rate >= stats.alert.rate ? 'text-red-400 font-bold' : ''}">${pct(c.failure_rate)}</td>
          <td class="px-2 text-xs text-slate-400">${c.types.map(t => `${esc(MAIL_TYPE_LABEL[t.type] || t.type)} ${t.ok}/${t.total}`).join('、')}</td>
          <td class="px-2 text-xs">${esc(c.last_success_at || '－')}</td>
          <td class="px-2">${c.company_id ? `<button class="text-cyan-400 text-xs hover:underline" data-action="hqMailCompany" data-id="${Number(c.company_id)}">記録</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="text-center text-slate-500 py-4">この期間の送信はありません</td></tr>'}</tbody>
      </table>
    </section>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4">
      <h3 class="font-bold mb-2"><i class="fas fa-circle-exclamation text-cyan-400 mr-1"></i>届かなかった理由の上位</h3>
      ${stats.reasons.length ? `<ul class="text-sm space-y-1">${stats.reasons.map(r => `<li><span class="font-bold">${esc(MAIL_ERR_LABEL[r.code] || r.code)}</span> ${Number(r.n)}件${r.sample ? `<span class="block text-[11px] text-slate-400 break-all">例: ${esc(r.sample)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="text-sm text-slate-500">ありません</p>'}
    </section>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 class="font-bold"><i class="fas fa-list text-cyan-400 mr-1"></i>送信の記録</h3>
        <div class="flex gap-2 text-sm">
          <select id="hm-company" class="bg-slate-900 border border-slate-600 rounded-lg px-2 py-1"><option value="">すべての企業</option>${stats.companies.filter(c => c.company_id).map(c => `<option value="${Number(c.company_id)}" ${String(HQ_MAIL.company_id) === String(c.company_id) ? 'selected' : ''}>${esc(c.company_name)}</option>`).join('')}</select>
          <select id="hm-status" class="bg-slate-900 border border-slate-600 rounded-lg px-2 py-1">${[['failed', '届かなかったもの'], ['', 'すべて']].map(([v, l]) => `<option value="${v}" ${HQ_MAIL.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div id="hm-logs"></div>
    </section>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-1"><i class="fas fa-ban text-cyan-400 mr-1"></i>送信を止めているアドレス</h3>
      <p class="text-[11px] text-slate-400 mb-2">Resend の Webhook で、宛先に届かなかった（恒久的な不達）か迷惑メールと報告されたアドレスです。以後、このアドレスには送りません。受信できるようになったと確かめた場合は解除します。</p>
      <div class="space-y-1 text-sm">${sup.suppressions.map(x => `<div class="flex items-center gap-2 flex-wrap border-b border-slate-700/40 py-1">
        <span class="font-mono">${esc(x.masked)}</span><span class="text-xs text-slate-400">${esc(x.companies || '')}</span>
        <span class="badge ${x.reason === 'complained' ? 'badge-yellow' : 'badge-red'}">${x.reason === 'complained' ? '迷惑メール報告' : '不達'}</span><span class="text-[11px] text-slate-500">${esc(x.created_at || '')}</span>
        <button class="text-cyan-400 text-xs hover:underline ml-auto" data-action="hqMailRelease" data-email="${esc(x.email)}" data-masked="${esc(x.masked)}">解除</button>
        ${x.detail ? `<p class="w-full text-[11px] text-slate-500 break-all">${esc(x.detail)}</p>` : ''}</div>`).join('') || '<p class="text-slate-500">ありません</p>'}</div>
    </section>`
  drawHqMailLogs()
  document.getElementById('hm-days').addEventListener('change', e => { HQ_MAIL.days = Number(e.target.value); renderHqMail() })
  document.getElementById('hm-company').addEventListener('change', e => { HQ_MAIL.company_id = e.target.value; reloadHqMailLogs() })
  document.getElementById('hm-status').addEventListener('change', e => { HQ_MAIL.status = e.target.value; reloadHqMailLogs() })
}
async function loadHqMailLogs(more) {
  const last = more && HQ_MAIL.logs.length ? HQ_MAIL.logs[HQ_MAIL.logs.length - 1].log_id : null
  const params = { ...(HQ_MAIL.company_id ? { company_id: HQ_MAIL.company_id } : {}), ...(HQ_MAIL.status ? { status: HQ_MAIL.status } : {}), ...(last ? { before: last } : {}) }
  const d = (await axios.get('/api/hq/email-logs', { params })).data
  HQ_MAIL.logs = more ? HQ_MAIL.logs.concat(d.logs) : d.logs
  HQ_MAIL.hasMore = !!d.has_more
}
function drawHqMailLogs() {
  const box = document.getElementById('hm-logs'); if (!box) return
  const errText = (e) => { if (!e) return ''; const k = String(e).split(':')[0]; const rest = String(e).slice(k.length + 1).trim(); return (MAIL_ERR_LABEL[k] || k) + (rest ? `（${rest}）` : '') }
  box.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-slate-400 text-xs border-b border-slate-700"><th class="text-left px-2 py-2">日時</th><th class="text-left px-2">企業</th><th class="text-left px-2">種類</th><th class="text-left px-2">宛先</th><th class="text-left px-2">状態</th><th class="text-left px-2">理由</th></tr></thead>
      <tbody>${HQ_MAIL.logs.map(l => `<tr class="border-b border-slate-700/40">
        <td class="px-2 py-1.5 text-xs whitespace-nowrap">${esc(l.created_at || '')}</td><td class="px-2 text-xs">${esc(l.company_name || '－')}</td>
        <td class="px-2 text-xs">${esc(MAIL_TYPE_LABEL[l.type] || l.type)}</td><td class="px-2 text-xs font-mono">${esc(l.to_email)}</td>
        <td class="px-2 text-xs ${['failed', 'bounced', 'bounced_soft', 'complained'].includes(l.status) ? 'text-red-400' : ''}">${esc(MAIL_STATUS_LABEL[l.status] || l.status)}</td>
        <td class="px-2 text-xs text-slate-400 break-all">${esc(errText(l.error_message))}</td></tr>`).join('') || '<tr><td colspan="6" class="text-center text-slate-500 py-4">該当する記録はありません</td></tr>'}</tbody></table></div>
    ${HQ_MAIL.hasMore ? '<div class="text-center mt-2"><button class="text-cyan-400 text-sm hover:underline" data-action="hqMailMore">さらに読み込む</button></div>' : ''}`
}
async function reloadHqMailLogs() {
  try { await loadHqMailLogs(false) } catch (e) { showApiError(e, '読み込めませんでした'); return }
  drawHqMailLogs()
}
delegate('hqMailMore', (el) => withSubmitLock(el, async () => {
  try { await loadHqMailLogs(true) } catch (e) { showApiError(e, '読み込めませんでした'); return }
  drawHqMailLogs()
}))
delegate('hqMailCompany', (el) => {
  HQ_MAIL.company_id = el.dataset.id
  const sel = document.getElementById('hm-company'); if (sel) sel.value = el.dataset.id
  reloadHqMailLogs()
  const box = document.getElementById('hm-logs'); if (box) box.scrollIntoView({ behavior: 'smooth' })
})
delegate('hqMailRelease', (el) => withSubmitLock(el, async () => {
  if (!confirm(`${el.dataset.masked} への送信の停止を解除します。受信できることを確かめましたか？`)) return
  try { await axios.post('/api/hq/email-suppressions/release', { email: el.dataset.email }); toast('解除しました') } catch (e) { showApiError(e, '解除できませんでした'); return }
  renderHqMail()
}))
// 届かなかった割合が高い会社の警告を、どのタブでも画面の上部に出す（定期処理の警告の下）
function renderMailAlert(stats) {
  let box = document.getElementById('hq-mail-alert')
  if (!box) {
    box = document.createElement('div')
    box.id = 'hq-mail-alert'
    box.className = 'max-w-7xl mx-auto p-4 md:p-6'
    box.style.paddingBottom = '0'
    $app.parentNode.insertBefore(box, $app)
  }
  const warnings = (stats && stats.warnings) || []
  // 送信量の警告（kind: 'volume'。1日の送信数が上限に近い会社。#392）と、届いていない警告を見出しで分ける
  const volumeOnly = warnings.length && warnings.every(w => w.kind === 'volume')
  box.innerHTML = warnings.length ? `
    <div class="bg-slate-800 border rounded-xl p-3 text-sm" style="border-color:#f59e0b">
      <p class="font-bold text-amber-400"><i class="fas fa-envelope-circle-check mr-1"></i>${volumeOnly ? 'メールの送信数が多い会社があります' : 'メールの送信で確認が必要な会社があります'}</p>
      <ul class="mt-1 text-xs">${warnings.map(w => `<li>・${esc(w.message)}</li>`).join('')}</ul>
      <a href="#mail" class="text-cyan-400 text-xs hover:underline">メール送信を開く →</a>
    </div>` : ''
  box.style.display = warnings.length ? '' : 'none'
}
async function refreshMailAlert() {
  try { renderMailAlert((await axios.get('/api/hq/email-stats', { params: { days: 7 } })).data) } catch { }
}

// ============ ルーティング ============
const routes = { companies: renderCompanies, templates: renderTemplates, retention: renderRetention, support: renderSupport, mail: renderHqMail,
  security: () => (window.renderHqSecurity ? renderHqSecurity() : renderCompanies()) }
// 導入企業へのお知らせ（#516）
routes.announcements = renderAnnouncements

function route() {
  const hash = (location.hash || '#companies').slice(1)
  const [tab, id] = hash.split('/')
  // 二段階認証が必須で未登録の間は、登録の画面だけを使える（#544。API でも同じ判定で止める）
  if (HQ_ME && HQ_ME.mfa_setup_required && tab !== 'security') { history.replaceState(null, '', '#security'); return route() }
  document.querySelectorAll('.hq-nav').forEach(el => el.classList.toggle('active', el.dataset.tab === tab))
  if (tab === 'companies' && id) return renderCompanyDetail(id)
  ;(routes[tab] || renderCompanies)()
}
window.addEventListener('hashchange', route)

;(async () => {
  try { HQ_ME = (await axios.get('/api/auth/me')).data } catch (e) { return }
  route()
  // データ保持のタブは自分で警告を描き直すので、それ以外のタブで開いたときに取る
  if (!/^#retention/.test(location.hash) && !HQ_ME.mfa_setup_required) refreshCronAlert()
  // メールの届かない会社の警告（#438）。メール送信のタブは自分で描き直す。二段階認証の登録待ちの間は取らない
  if (!/^#mail/.test(location.hash) && !HQ_ME.mfa_setup_required) refreshMailAlert()
  // 未対応の伴走支援の依頼の件数（#179）。伴走支援のタブは自分で描き直す
  if (!/^#support/.test(location.hash) && !HQ_ME.mfa_setup_required) refreshSupportBadge()
})()

// ============ 解約・データ（解約・停止した企業のデータの書き出しと削除。作業単位 w5-hq-offboarding: #177） ============
// 停止中の企業に契約終了を登録し、猶予（既定90日）のあいだにデータを書き出して渡し、猶予の後に二重の確認のうえで削除する。
const OB_STATUS_BADGE = {
  scheduled: '<span class="badge badge-yellow">猶予中</span>',
  deleting: '<span class="badge badge-red">削除中</span>',
  completed: '<span class="badge badge-gray">削除済み</span>',
  cancelled: '<span class="badge badge-gray">取消</span>',
}
const OB_EVENT_LABEL = { start: '契約終了の登録', cancel: '契約終了の取消', export: 'CSV の書き出し', file: 'ファイルの取得',
  delete_start: '削除の開始', delete_error: '削除の失敗', complete: '削除の完了' }
const OB_FILE_LABEL = { attendance_reports: '出退勤の写真', attendance_reports_duplicates_0036: '出退勤の写真（重複の控え）', staff_documents: 'スタッフの書類', employee_documents: '入社時書類', client_documents: 'クライアントの契約書類' }
const OB_DARK_INP = 'style="background:#1e293b;border-color:#334155;color:#fff"'
let OB_DETAIL = null

// 本部画面のナビ（index.tsx）にタブを足す
;(function addOffboardingNav() {
  const first = document.querySelector('.hq-nav')
  if (!first || document.querySelector('.hq-nav[data-tab="offboarding"]')) return
  const a = document.createElement('a')
  a.href = '#offboarding'; a.className = first.className.replace(/\bactive\b/, '').trim(); a.dataset.tab = 'offboarding'; a.textContent = '解約・データ'
  first.parentNode.appendChild(a)
})()
routes.offboarding = () => {
  const id = (location.hash.slice(1).split('/')[1] || '')
  return id ? renderOffboardingDetail(id) : renderOffboardingList()
}

async function renderOffboardingList() {
  loading()
  let data
  try { data = (await axios.get('/api/hq/offboarding')).data } catch (e) {
    $app.innerHTML = '<p class="text-sm text-red-400">解約・停止した企業の一覧を読み込めませんでした</p>'
    return
  }
  const rows = data.companies.map(c => `
    <tr class="border-b border-slate-700/40">
      <td class="px-3 py-3"><p class="font-medium">${esc(c.company_name)}</p><p class="text-xs text-slate-400">${esc(c.company_code)} ${STATUS_BADGE[c.active_status] || ''}</p></td>
      <td class="px-3 py-3">${c.status ? OB_STATUS_BADGE[c.status] || esc(c.status) : '<span class="text-slate-500 text-xs">未登録</span>'}${c.last_error ? '<span class="block text-xs text-red-400">失敗あり</span>' : ''}</td>
      <td class="px-3 py-3 text-xs">${c.contract_end_date ? esc(c.contract_end_date) : '-'}</td>
      <td class="px-3 py-3 text-xs">${c.status === 'scheduled' ? `${esc(c.delete_after)}${c.delete_after <= data.today ? ' <span class="text-amber-300">削除できます</span>' : ''}` : c.completed_at ? '削除済み ' + hqDate(c.completed_at, false) : '-'}</td>
      <td class="px-3 py-3 text-xs">${c.last_export_at ? hqDate(c.last_export_at, false) : '<span class="text-slate-500">なし</span>'}</td>
      <td class="px-3 py-3"><a href="#offboarding/${Number(c.company_id)}" class="text-cyan-400 text-xs hover:underline">開く →</a></td>
    </tr>`).join('')
  $app.innerHTML = `
    <h2 class="text-xl font-bold">解約・データ</h2>
    <p class="text-sm text-slate-400 mt-1 mb-5">利用状態が「停止」の企業に契約終了を登録すると、猶予期間（既定${Number(data.grace_days)}日）のあいだにデータ（CSV・写真・書類）を書き出して渡せます。猶予の後に、会社コードと確認の入力のうえで、スタッフ・勤怠・写真・書類などを削除し、利用者とスタッフの氏名・連絡先を匿名化します。</p>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700">
          <th class="text-left px-3 py-2">企業</th><th class="text-left px-3 py-2">解約の処理</th><th class="text-left px-3 py-2">契約終了日</th><th class="text-left px-3 py-2">削除できる日</th><th class="text-left px-3 py-2">最後の書き出し</th><th></th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="text-center text-slate-500 py-6">停止中の企業はありません。企業を停止にすると、ここに出ます</td></tr>'}</tbody>
      </table>
    </section>`
}

function obStatusHtml(d) {
  const ob = d.offboarding, c = d.company
  const open = ob && (ob.status === 'scheduled' || ob.status === 'deleting')
  if (!open && c.active_status !== 'inactive') {
    return `<p class="text-sm text-slate-300">この企業は「停止」ではないため、契約終了を登録できません。企業の画面で利用状態を停止にしてから登録してください。</p>`
  }
  if (!open && ob && ob.status === 'completed') {
    return `<p class="text-sm">削除が完了しています（${hqDate(ob.completed_at, false)}）。<a href="/api/hq/offboarding/${Number(c.company_id)}/record.csv" class="text-cyan-400 hover:underline ml-1"><i class="fas fa-file-csv mr-1"></i>削除の記録（CSV）</a></p>`
  }
  if (!open) {
    return `
      <p class="text-sm text-slate-300 mb-3">契約終了日を登録すると、猶予期間の後に削除できるようになります。猶予中は取り消せます。</p>
      <div class="grid md:grid-cols-4 gap-3 text-sm">
        <label class="block"><span class="text-xs text-slate-400">契約終了日</span><input type="date" id="ob-end" class="inp mt-1" ${OB_DARK_INP} value="${esc(d.today)}"></label>
        <label class="block"><span class="text-xs text-slate-400">猶予日数（${Number(d.settings.grace_min)}〜${Number(d.settings.grace_max)}日）</span><input type="number" id="ob-grace" class="inp mt-1" ${OB_DARK_INP} min="${Number(d.settings.grace_min)}" max="${Number(d.settings.grace_max)}" value="${Number(d.settings.grace_days)}"></label>
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">理由・メモ（任意）</span><input type="text" id="ob-reason" class="inp mt-1" ${OB_DARK_INP} maxlength="1000"></label>
        <label class="block md:col-span-2"><span class="text-xs text-slate-400">確認のため会社コード（${esc(c.company_code)}）を入力</span><input type="text" id="ob-start-code" class="inp mt-1" ${OB_DARK_INP} autocomplete="off"></label>
      </div>
      <button class="btn btn-primary mt-3" data-action="obStart" data-cid="${Number(c.company_id)}"><i class="fas fa-flag-checkered"></i>契約終了を登録する</button>`
  }
  const head = `<p class="text-sm mb-3">${OB_STATUS_BADGE[ob.status] || ''} 契約終了日 ${esc(ob.contract_end_date)} ／ 猶予 ${Number(ob.grace_days)}日 ／ <b>${esc(ob.delete_after)}</b> から削除できます${ob.reason ? `<span class="block text-xs text-slate-400 mt-1">理由: ${esc(ob.reason)}</span>` : ''}</p>
    ${ob.last_error ? `<div class="bg-red-900/40 border border-red-700 text-red-200 rounded-xl p-3 mb-3 text-xs break-all">前回の削除で失敗しました: ${esc(ob.last_error)}</div>` : ''}`
  const delForm = `
    <div class="border border-red-700 rounded-xl p-3 mt-2">
      <p class="text-sm text-red-200 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>削除すると元に戻せません。下の件数（dry-run）を確かめてから実行してください。</p>
      <div class="grid md:grid-cols-3 gap-3 text-sm">
        <label class="block"><span class="text-xs text-slate-400">会社コード（${esc(c.company_code)}）を入力</span><input type="text" id="ob-del-code" class="inp mt-1" ${OB_DARK_INP} autocomplete="off"></label>
        ${ob.status === 'scheduled' ? `
        <label class="block"><span class="text-xs text-slate-400">「${esc(d.settings.confirm_text)}」と入力</span><input type="text" id="ob-del-text" class="inp mt-1" ${OB_DARK_INP} autocomplete="off"></label>
        ${d.exported ? '' : `<label class="block"><span class="text-xs text-slate-400">書き出しをしない理由（まだ書き出していません）</span><input type="text" id="ob-del-skip" class="inp mt-1" ${OB_DARK_INP} maxlength="500" placeholder="例: 企業から不要と回答があった"></label>`}` : ''}
      </div>
      <button class="btn btn-danger mt-3" data-action="obDelete" data-cid="${Number(c.company_id)}"><i class="fas fa-trash"></i>${ob.status === 'deleting' ? '削除を続ける' : 'データを削除する'}</button>
      <div id="ob-progress" class="text-xs text-slate-300 mt-2"></div>
    </div>`
  if (ob.status === 'deleting') return head + delForm
  return head + `
    <div class="flex flex-wrap gap-2 items-end">
      <label class="block text-sm"><span class="text-xs text-slate-400">取消の理由（任意）</span><input type="text" id="ob-cancel-reason" class="inp mt-1" ${OB_DARK_INP} maxlength="1000"></label>
      <button class="btn btn-outline" style="border-color:#334155;color:#cbd5e1" data-action="obCancel" data-cid="${Number(c.company_id)}">契約終了を取り消す</button>
    </div>
    ${d.can_delete ? delForm : `<p class="text-xs text-slate-400 mt-2">猶予期間中のため、まだ削除できません。${c.active_status !== 'inactive' ? '企業の利用状態が「停止」ではないため削除できません。' : ''}</p>`}`
}

function obTablesHtml(d) {
  const canExport = d.company.active_status === 'inactive' && !(d.offboarding && (d.offboarding.status === 'deleting' || d.offboarding.status === 'completed'))
  const cid = Number(d.company.company_id)
  const rows = d.tables.map(t => `
    <tr class="border-b border-slate-700/40">
      <td class="px-3 py-2">${esc(t.label)}<span class="block text-[11px] text-slate-500">${esc(t.target)}</span></td>
      <td class="px-3 py-2 text-right">${Number(t.count).toLocaleString()}</td>
      <td class="px-3 py-2 text-xs">${t.delete ? '削除' : t.target === 'companies' ? '<span class="text-slate-400">残す（解約の記録）</span>' : '<span class="text-amber-300">匿名化</span>'}</td>
      <td class="px-3 py-2">${canExport && t.export && t.count > 0 ? `<button class="text-cyan-400 text-xs hover:underline" data-action="obExport" data-cid="${cid}" data-target="${esc(t.target)}"><i class="fas fa-file-csv mr-1"></i>CSV</button>` : ''}</td>
    </tr>`).join('')
  const files = Object.entries(d.files).map(([k, n]) => `${esc(OB_FILE_LABEL[k] || k)} ${Number(n).toLocaleString()}件`).join(' ／ ')
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 class="font-bold"><i class="fas fa-database text-cyan-400 mr-1"></i>データの件数と書き出し（削除の dry-run）</h3>
        ${canExport ? `<button class="btn btn-outline text-xs" style="border-color:#334155;color:#cbd5e1" data-action="obExportAll" data-cid="${cid}"><i class="fas fa-download"></i>すべての表を CSV で書き出す</button>` : ''}
      </div>
      <p class="text-xs text-slate-400 mb-3">CSV は表ごとに ${Number(d.settings.export_page)} 行ずつ取得して1つのファイルにまとめます。パスワード・二段階認証・トークンの列は出しません。掲示板の投稿とやり取り・企業間チャット・連携の同意の記録は相手の企業と共有する記録のため、ログインの履歴は1年で自動で消えるため、削除の対象にしていません。</p>
      ${d.unknown_tables === null ? `<p class="text-xs text-amber-300 mb-3">削除の対象に入っていない表があるかを確かめられませんでした</p>` : ''}
      ${d.unknown_tables && d.unknown_tables.length ? `<div class="bg-red-900/40 border border-red-700 text-red-200 rounded-xl p-3 mb-3 text-xs">削除の対象に入っていない、企業の行を持つ表があります（開発者に確認してください）: ${d.unknown_tables.map(esc).join(', ')}</div>` : ''}
      <div class="overflow-x-auto max-h-96 overflow-y-auto"><table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700"><th class="text-left px-3 py-2">表</th><th class="text-right px-3 py-2">件数</th><th class="text-left px-3 py-2">削除の扱い</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="mt-4 text-sm">
        <p><i class="fas fa-images text-cyan-400 mr-1"></i>写真・書類（R2）: ${files}</p>
        ${canExport ? `<button class="text-cyan-400 text-xs hover:underline mt-1" data-action="obFiles" data-cid="${cid}" data-offset="0">ファイルの一覧を表示して取得する</button>` : ''}
        <div id="ob-files" class="mt-2"></div>
      </div>
    </section>`
}

function obEventsHtml(d) {
  const rows = d.events.map(e => {
    let detail = ''
    try { const o = JSON.parse(e.detail || 'null'); detail = o ? Object.entries(o).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' ／ ') : '' } catch { detail = '' }
    return `<tr class="border-b border-slate-700/40"><td class="px-3 py-2 text-xs whitespace-nowrap">${esc(dayjs(e.created_at).format('YYYY/M/D HH:mm'))}</td>
      <td class="px-3 py-2 text-xs">${esc(OB_EVENT_LABEL[e.action] || e.action)}</td><td class="px-3 py-2 text-xs">${esc(e.actor_name || '')}</td>
      <td class="px-3 py-2 text-xs text-slate-400 break-all">${esc(detail)}</td></tr>`
  }).join('')
  return `
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-bold"><i class="fas fa-clock-rotate-left text-cyan-400 mr-1"></i>操作の記録</h3>
        ${d.offboarding ? `<a href="/api/hq/offboarding/${Number(d.company.company_id)}/record.csv" class="text-cyan-400 text-xs hover:underline"><i class="fas fa-file-csv mr-1"></i>解約の記録（CSV）</a>` : ''}
      </div>
      <div class="overflow-x-auto"><table class="w-full text-sm"><tbody>${rows || '<tr><td class="text-center text-slate-500 py-4 text-xs">記録はありません</td></tr>'}</tbody></table></div>
    </section>`
}

async function renderOffboardingDetail(cid) {
  loading()
  try { OB_DETAIL = (await axios.get('/api/hq/offboarding/' + Number(cid))).data } catch (e) {
    $app.innerHTML = `<div class="bg-slate-800 border border-slate-700 rounded-xl p-6 text-center text-sm text-slate-300">${e.response && e.response.status === 404 ? '企業が見つかりません。' : '読み込めませんでした。'}<a href="#offboarding" class="text-cyan-400 ml-2 hover:underline">一覧へ戻る</a></div>`
    return
  }
  const d = OB_DETAIL, c = d.company
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <a href="#offboarding" class="btn btn-outline" style="border-color:#334155;color:#94a3b8"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold">${esc(c.company_name)}</h2>
        <p class="text-sm text-slate-400">コード: ${esc(c.company_code)} ｜ ${STATUS_BADGE[c.active_status] || ''} <a href="#companies/${Number(c.company_id)}" class="text-cyan-400 text-xs hover:underline ml-2">企業の画面へ</a></p>
      </div>
    </div>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-5">
      <h3 class="font-bold mb-3"><i class="fas fa-file-contract text-cyan-400 mr-1"></i>契約終了と削除</h3>
      ${obStatusHtml(d)}
    </section>
    ${obTablesHtml(d)}
    ${obEventsHtml(d)}`
}

const obVal = id => { const el = document.getElementById(id); return el ? el.value.trim() : '' }

delegate('obStart', el => {
  const cid = Number(el.dataset.cid)
  if (!obVal('ob-end')) { toast('契約終了日を入力してください'); return }
  if (!confirm(`契約終了を登録します。猶予の ${obVal('ob-grace') || OB_DETAIL.settings.grace_days} 日を過ぎると、この企業のデータを削除できるようになります。よろしいですか？`)) return
  withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post(`/api/hq/offboarding/${cid}/start`, { contract_end_date: obVal('ob-end'), grace_days: obVal('ob-grace'), reason: obVal('ob-reason'), confirm_company_code: obVal('ob-start-code') })
      toast(`登録しました。${data.delete_after} から削除できます`)
      renderOffboardingDetail(cid)
    } catch (e) { showApiError(e, '登録に失敗しました') }
  })
})

delegate('obCancel', el => {
  const cid = Number(el.dataset.cid)
  if (!confirm('契約終了の登録を取り消します。よろしいですか？')) return
  withSubmitLock(el, async () => {
    try {
      await axios.post(`/api/hq/offboarding/${cid}/cancel`, { reason: obVal('ob-cancel-reason') })
      toast('取り消しました')
      renderOffboardingDetail(cid)
    } catch (e) { showApiError(e, '取り消せませんでした') }
  })
})

// 削除は1回の要求で処理できる量ずつ進むので、終わるか失敗するまで続けて呼ぶ
delegate('obDelete', el => {
  const cid = Number(el.dataset.cid)
  const body = { confirm_company_code: obVal('ob-del-code'), confirm_text: obVal('ob-del-text'), export_skip_reason: obVal('ob-del-skip') }
  if (!body.confirm_company_code) { toast('会社コードを入力してください'); return }
  if (!confirm(`「${OB_DETAIL.company.company_name}」のデータを削除します。\nスタッフ・勤怠・日報・写真・書類・従業員データなどは元に戻せません。利用者とスタッフの氏名・連絡先は匿名化します。\n本当に実行しますか？`)) return
  withSubmitLock(el, async () => {
    const box = document.getElementById('ob-progress')
    let p = null
    try {
      for (let i = 0; i < 1000; i++) {
        p = (await axios.post(`/api/hq/offboarding/${cid}/delete`, body)).data
        if (box) box.textContent = `処理中… 段階 ${p.step} / ${p.total_steps}${p.r2_left ? `（残りのファイル ${p.r2_left}件）` : ''}`
        if (p.done || p.error) break
      }
      if (p && p.error) toast('削除の途中で失敗しました。内容を確かめて「削除を続ける」で再開してください')
      else if (p && p.done) toast('削除が完了しました')
    } catch (e) { showApiError(e, '削除に失敗しました') }
    renderOffboardingDetail(cid)
  })
})

// 表の CSV を区切って取得し、1つのファイルにまとめる（2つ目以降の見出しの行は除く）
async function obFetchTableCsv(cid, target) {
  let offset = 0, out = ''
  for (let i = 0; i < 100000; i++) {
    const r = await axios.get(`/api/hq/offboarding/${cid}/export/${encodeURIComponent(target)}`, { params: { offset }, responseType: 'text', transformResponse: x => x })
    let text = String(r.data).replace(/^﻿/, '')
    if (offset > 0) text = text.slice(text.indexOf('\r\n') + 2)
    out += text
    const next = r.headers['x-export-next']
    if (!next) break
    offset = Number(next)
  }
  return '﻿' + out
}
function obSaveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
delegate('obExport', el => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid), target = el.dataset.target
  try {
    obSaveFile(`${OB_DETAIL.company.company_code}_${target}.csv`, await obFetchTableCsv(cid, target))
  } catch (e) { showApiError(e, '書き出しに失敗しました') }
}))
delegate('obExportAll', el => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid)
  const targets = OB_DETAIL.tables.filter(t => t.export && t.count > 0)
  try {
    for (const [i, t] of targets.entries()) {
      el.textContent = `書き出し中… ${i + 1} / ${targets.length}`
      obSaveFile(`${OB_DETAIL.company.company_code}_${t.target}.csv`, await obFetchTableCsv(cid, t.target))
    }
    toast(`${targets.length}個の CSV を書き出しました`)
  } catch (e) { showApiError(e, '書き出しに失敗しました') }
  renderOffboardingDetail(cid)
}))

// 写真・書類の一覧（100件ずつ）。ファイルは1件ずつ取得する
delegate('obFiles', el => withSubmitLock(el, async () => {
  const cid = Number(el.dataset.cid), offset = Number(el.dataset.offset) || 0
  const box = document.getElementById('ob-files')
  try {
    const { data } = await axios.get(`/api/hq/offboarding/${cid}/files`, { params: { offset } })
    box.innerHTML = `
      <div class="overflow-x-auto"><table class="w-full text-xs">
        <thead><tr class="text-slate-400 border-b border-slate-700"><th class="text-left px-2 py-1">種類</th><th class="text-left px-2 py-1">ファイル</th><th class="text-left px-2 py-1">日時</th><th></th></tr></thead>
        <tbody>${data.files.map(f => `<tr class="border-b border-slate-700/40">
          <td class="px-2 py-1">${esc(OB_FILE_LABEL[f.source] || f.source)}</td>
          <td class="px-2 py-1 break-all">${esc(f.file_name || f.r2_key)}</td>
          <td class="px-2 py-1 whitespace-nowrap">${esc(f.created_at || '')}</td>
          <td class="px-2 py-1"><a class="text-cyan-400 hover:underline" href="/api/hq/offboarding/${cid}/files/${encodeURIComponent(f.source)}/${Number(f.id)}">取得</a></td></tr>`).join('') || '<tr><td colspan="4" class="text-center text-slate-500 py-3">ファイルはありません</td></tr>'}</tbody>
      </table></div>
      <div class="flex gap-2 mt-2">
        ${offset > 0 ? `<button class="text-cyan-400 text-xs hover:underline" data-action="obFiles" data-cid="${cid}" data-offset="${Math.max(0, offset - 100)}">← 前へ</button>` : ''}
        ${data.next != null ? `<button class="text-cyan-400 text-xs hover:underline" data-action="obFiles" data-cid="${cid}" data-offset="${Number(data.next)}">次へ →</button>` : ''}
      </div>`
  } catch (e) { showApiError(e, 'ファイルの一覧を読み込めませんでした') }
}))
