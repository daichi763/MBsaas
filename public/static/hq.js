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

axios.interceptors.response.use(r => r, e => {
  if (e.response && e.response.status === 401) location.href = '/login'
  return Promise.reject(e)
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
async function renderCompanies() {
  loading()
  const { data } = await axios.get('/api/hq/companies')
  const totalMRR = data.companies.filter(c => c.active_status === 'active').reduce((a, c) => a + c.monthly_fee, 0)
  const kpi = (label, value, icon) => `
    <div class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <p class="text-xs text-slate-400">${label}</p>
      <p class="text-2xl font-bold mt-0.5 truncate"><i class="fas ${icon} text-cyan-400 mr-2 text-lg"></i>${value}</p>
    </div>`

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold">導入企業管理</h2>
      <button class="btn btn-primary" style="background:#0e7490" onclick="showAddCompany()"><i class="fas fa-plus"></i>企業登録</button>
    </div>
    <section class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${kpi('導入企業数', data.companies.length + '社', 'fa-building')}
      ${kpi('課金対象企業', data.companies.filter(c => c.active_status === 'active').length + '社', 'fa-circle-check')}
      ${kpi('月間収益(MRR)', yen(totalMRR), 'fa-yen-sign')}
      ${kpi('総ユーザー数', data.companies.reduce((a, c) => a + (c.user_count || 0), 0) + '名', 'fa-users')}
    </section>
    <section class="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700">
          <th class="text-left px-4 py-3">企業</th><th class="text-left px-3 py-3">コード</th><th class="text-left px-3 py-3">プラン</th>
          <th class="text-left px-3 py-3">状態</th><th class="text-left px-3 py-3">請求</th><th class="text-right px-3 py-3">ユーザー</th>
          <th class="text-right px-3 py-3">週次アクティブ</th><th class="text-right px-3 py-3">30日日報数</th><th class="text-right px-3 py-3">月額</th>
          <th class="text-center px-3 py-3">成熟度</th><th></th>
        </tr></thead>
        <tbody>
          ${data.companies.map(c => `
            <tr class="border-b border-slate-700/50 hover:bg-slate-700/30 cursor-pointer" onclick="location.hash='companies/${c.company_id}'">
              <td class="px-4 py-3 font-medium">${esc(c.company_name)}</td>
              <td class="px-3 py-3 text-slate-400">${esc(c.company_code)}</td>
              <td class="px-3 py-3">${PLAN_LABELS[c.plan] || c.plan}</td>
              <td class="px-3 py-3">${STATUS_BADGE[c.active_status] || ''}</td>
              <td class="px-3 py-3">${BILLING_BADGE[c.billing_status] || ''}</td>
              <td class="px-3 py-3 text-right">${c.user_count}/${c.user_limit}</td>
              <td class="px-3 py-3 text-right">${c.active_users || 0}名</td>
              <td class="px-3 py-3 text-right">${c.reports_30d || 0}件</td>
              <td class="px-3 py-3 text-right font-bold text-cyan-400">${yen(c.monthly_fee)}</td>
              <td class="px-3 py-3 text-center">${'●'.repeat(c.maturity_level || 1)}${'○'.repeat(5 - (c.maturity_level || 1))}</td>
              <td class="px-3 py-3 text-cyan-400 text-xs">詳細 →</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>
    <p class="text-xs text-slate-500 mt-3"><i class="fas fa-circle-info mr-1"></i>料金 = 基本990円（3ユーザーまで）+ 追加1ユーザーごとに300円/月</p>`
}

window.showAddCompany = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4">導入企業登録</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">会社コード *</label><input id="co-code" class="inp" placeholder="newcompany"></div>
        <div><label class="text-sm text-gray-600 block mb-1">会社名 *</label><input id="co-name" class="inp"></div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">プラン</label>
          <select id="co-plan" class="inp"><option value="basic">ベーシック</option><option value="standard">スタンダード</option><option value="premium">プレミアム</option></select></div>
        <div><label class="text-sm text-gray-600 block mb-1">ユーザー上限</label><input id="co-limit" type="number" value="3" class="inp"></div>
      </div>
      <hr>
      <p class="text-xs text-gray-500">初期管理者アカウント（任意）</p>
      <div class="grid grid-cols-3 gap-3">
        <div><label class="text-xs text-gray-600 block mb-1">管理者ID</label><input id="co-admin-code" class="inp" placeholder="admin"></div>
        <div><label class="text-xs text-gray-600 block mb-1">氏名</label><input id="co-admin-name" class="inp"></div>
        <div><label class="text-xs text-gray-600 block mb-1">パスワード</label><input id="co-admin-pass" class="inp" value="pass1234"></div>
      </div>
      <button class="btn btn-primary w-full" onclick="addCompany()">登録する</button>
    </div>`)
}
window.addCompany = async function () {
  try {
    await axios.post('/api/hq/companies', {
      company_code: document.getElementById('co-code').value.trim(),
      company_name: document.getElementById('co-name').value.trim(),
      plan: document.getElementById('co-plan').value,
      user_limit: Number(document.getElementById('co-limit').value || 3),
      admin_code: document.getElementById('co-admin-code').value.trim(),
      admin_name: document.getElementById('co-admin-name').value.trim(),
      admin_password: document.getElementById('co-admin-pass').value
    })
    closeModal(); toast('企業を登録しました'); renderCompanies()
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '登録に失敗しました') }
}

// ============ 企業詳細 ============
async function renderCompanyDetail(cid) {
  loading()
  const { data } = await axios.get('/api/hq/companies/' + cid)
  const c = data.company
  const ROLE_LABELS = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', staff: 'スタッフ', system_admin: 'システム管理者' }
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5">
      <a href="#companies" class="btn btn-outline" style="border-color:#334155;color:#94a3b8"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold">${esc(c.company_name)}</h2>
        <p class="text-sm text-slate-400">コード: ${esc(c.company_code)} ｜ ${STATUS_BADGE[c.active_status]} ${BILLING_BADGE[c.billing_status]}</p>
      </div>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      ${[['総日報数', data.stats.total_reports + '件'], ['総シフト数', data.stats.total_shifts + '件'], ['総勤怠報告', data.stats.total_attendance + '件'], ['稼働案件', data.stats.active_projects + '件']].map(([l, v]) => `
        <div class="bg-slate-800 border border-slate-700 rounded-xl p-4"><p class="text-xs text-slate-400">${l}</p><p class="text-xl font-bold mt-0.5">${v}</p></div>`).join('')}
    </div>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <h3 class="font-bold mb-3"><i class="fas fa-gear text-cyan-400 mr-1"></i>契約・設定</h3>
        <div class="space-y-3 text-sm">
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-xs text-slate-400 block mb-1">プラン</label>
              <select id="cd-plan" class="inp" style="background:#1e293b;border-color:#334155;color:#fff">
                ${['basic', 'standard', 'premium'].map(p => `<option value="${p}" ${c.plan === p ? 'selected' : ''}>${PLAN_LABELS[p]}</option>`).join('')}
              </select></div>
            <div><label class="text-xs text-slate-400 block mb-1">ユーザー上限</label>
              <input id="cd-limit" type="number" value="${c.user_limit}" class="inp" style="background:#1e293b;border-color:#334155;color:#fff"></div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="text-xs text-slate-400 block mb-1">利用状態</label>
              <select id="cd-status" class="inp" style="background:#1e293b;border-color:#334155;color:#fff">
                ${['active', 'trial', 'inactive'].map(s => `<option value="${s}" ${c.active_status === s ? 'selected' : ''}>${s === 'active' ? '利用中' : s === 'trial' ? 'トライアル' : '停止'}</option>`).join('')}
              </select></div>
            <div><label class="text-xs text-slate-400 block mb-1">請求状態</label>
              <select id="cd-billing" class="inp" style="background:#1e293b;border-color:#334155;color:#fff">
                ${['active', 'overdue', 'suspended'].map(s => `<option value="${s}" ${c.billing_status === s ? 'selected' : ''}>${s === 'active' ? '正常' : s === 'overdue' ? '滞納' : '停止'}</option>`).join('')}
              </select></div>
          </div>
          <div><label class="text-xs text-slate-400 block mb-1">運営成熟度 (1-5)</label>
            <input id="cd-maturity" type="range" min="1" max="5" value="${c.maturity_level || 1}" class="w-full"></div>
          <div><label class="text-xs text-slate-400 block mb-1">伴走支援メモ</label>
            <textarea id="cd-memo" rows="3" class="inp" style="background:#1e293b;border-color:#334155;color:#fff">${esc(c.support_memo || '')}</textarea></div>
          <button class="btn btn-primary w-full" style="background:#0e7490" onclick="saveCompany(${cid})">保存する</button>
        </div>
      </section>

      <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <h3 class="font-bold mb-3"><i class="fas fa-users text-cyan-400 mr-1"></i>ユーザー一覧 (${data.users.length}名)</h3>
        <div class="max-h-96 overflow-y-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-slate-400 border-b border-slate-700">
              <th class="text-left py-2">ID</th><th class="text-left py-2">氏名</th><th class="text-left py-2">権限</th><th class="text-left py-2">最終ログイン</th>
            </tr></thead>
            <tbody>
              ${data.users.map(u => `
                <tr class="border-b border-slate-700/40">
                  <td class="py-2 text-slate-400">${esc(u.user_code)}</td>
                  <td class="py-2">${esc(u.name)}</td>
                  <td class="py-2"><span class="badge ${u.role === 'staff' ? 'badge-gray' : 'badge-blue'}">${ROLE_LABELS[u.role] || u.role}</span></td>
                  <td class="py-2 text-slate-400">${u.last_login_at ? dayjs(u.last_login_at).format('M/D HH:mm') : '-'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>`
}

window.saveCompany = async function (cid) {
  await axios.put('/api/hq/companies/' + cid, {
    plan: document.getElementById('cd-plan').value,
    user_limit: Number(document.getElementById('cd-limit').value),
    active_status: document.getElementById('cd-status').value,
    billing_status: document.getElementById('cd-billing').value,
    maturity_level: Number(document.getElementById('cd-maturity').value),
    support_memo: document.getElementById('cd-memo').value
  })
  toast('保存しました')
}

// ============ テンプレート配信 ============
async function renderTemplates() {
  loading()
  const { data } = await axios.get('/api/hq/templates')
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
            ${t.fields.map(f => `<span class="text-xs px-2 py-0.5 rounded-full ${f.type === 'number' ? 'bg-cyan-900 text-cyan-300' : 'bg-slate-700 text-slate-300'}">${esc(f.label)}</span>`).join('')}
          </div>
          <p class="text-xs text-slate-500 mt-2">項目数: ${t.fields.length}（数値 ${t.fields.filter(f => f.type === 'number').length} / テキスト ${t.fields.filter(f => f.type !== 'number').length}）</p>
        </section>`).join('')}
    </div>`
}

window.showAddTemplate = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4">テンプレート作成</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">テンプレート名 *</label><input id="tp-name" class="inp" placeholder="コールセンター稼働テンプレート"></div>
      <div><label class="text-sm text-gray-600 block mb-1">項目定義（1行1項目: キー,ラベル,タイプ）</label>
        <textarea id="tp-fields" rows="8" class="inp text-xs font-mono">calls,架電数,number
connects,接続数,number
seiyaku,成約数,number
free,自由記述,textarea</textarea>
        <p class="text-xs text-gray-400 mt-1">タイプ: number / text / textarea</p></div>
      <button class="btn btn-primary w-full" onclick="addTemplate()">作成して配信する</button>
    </div>`)
}
window.addTemplate = async function () {
  const name = document.getElementById('tp-name').value.trim()
  if (!name) { toast('テンプレート名を入力してください'); return }
  const fields = document.getElementById('tp-fields').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [key, label, type] = l.split(',').map(s => s.trim())
    return { key, label: label || key, type: type || 'text' }
  })
  await axios.post('/api/hq/templates', { template_name: name, fields })
  closeModal(); toast('テンプレートを配信しました'); renderTemplates()
}

// ============ データ保持（定期削除） ============
const RETENTION_TARGET_LABEL = {
  daily_reports: '日報（3年）', attendance_reports: '出退勤記録（退職後7年）', shifts: 'シフト（退職後7年）',
  evaluations: '人事評価（退職後7年）', follow_logs: 'やり取り履歴（退職後7年）', consultations: '相談内容（退職後7年）',
  r2_photos: 'R2写真（退職後7年）',
}
async function renderRetention() {
  loading()
  const { data } = await axios.get('/api/hq/retention/logs')
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h2 class="text-xl font-bold">データ保持（定期削除）</h2>
        <p class="text-sm text-slate-400 mt-1">日報は3年、出退勤記録・シフト・評価・やり取り・相談・R2写真は退職後7年で自動削除されます（毎日Cronで実行）。</p>
      </div>
      <button class="btn btn-outline" onclick="runRetentionDryRun()"><i class="fas fa-magnifying-glass"></i>dry-run実行（削除せず対象件数を確認）</button>
    </div>
    <div id="retention-dryrun-result" class="mb-5"></div>
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 class="font-bold mb-3">直近の実行ログ</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>実行日時</th><th>対象</th><th>種別</th><th>対象件数</th><th>削除件数</th><th>失敗</th></tr></thead>
          <tbody>
            ${data.logs.length === 0 ? '<tr><td colspan="6" class="text-center text-slate-500 py-4">実行履歴がありません</td></tr>' : data.logs.map(l => `
              <tr>
                <td class="text-xs">${l.finished_at ? dayjs(l.finished_at).format('YYYY/M/D HH:mm') : '-'}</td>
                <td>${RETENTION_TARGET_LABEL[l.target] || esc(l.target)}</td>
                <td><span class="badge ${l.dry_run ? 'badge-gray' : 'badge-blue'}">${l.dry_run ? 'dry-run' : '実削除'}</span></td>
                <td>${l.target_count}</td>
                <td>${l.deleted_count}</td>
                <td>${l.failed_count > 0 ? `<span class="text-red-400">${l.failed_count}</span>` : '0'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`
}
window.runRetentionDryRun = async function () {
  const box = document.getElementById('retention-dryrun-result')
  box.innerHTML = '<div class="flex justify-center py-6"><span class="spin"></span></div>'
  try {
    const { data } = await axios.post('/api/hq/retention/dry-run')
    box.innerHTML = `
      <section class="bg-slate-800 border border-slate-700 rounded-xl p-4">
        <h3 class="font-bold mb-3">dry-run結果（削除は実行していません）</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          ${data.results.map(r => `
            <div class="bg-slate-900 rounded-lg p-3">
              <p class="text-xs text-slate-400">${RETENTION_TARGET_LABEL[r.target] || esc(r.target)}</p>
              <p class="text-lg font-bold ${r.targetCount > 0 ? 'text-amber-400' : ''}">${r.targetCount}件</p>
            </div>`).join('')}
        </div>
      </section>`
    toast('dry-runが完了しました')
    renderRetention()
  } catch {
    box.innerHTML = ''
    toast('dry-runの実行に失敗しました')
  }
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
  try { await axios.get('/api/auth/me') } catch (e) { return }
  route()
})()
