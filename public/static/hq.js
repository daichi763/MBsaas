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
        <div><label class="text-xs text-gray-600 block mb-1">パスワード</label><input id="co-admin-pass" class="inp" autocomplete="new-password" placeholder="空欄なら自動で作成"></div>
      </div>
      <div><label class="text-xs text-gray-600 block mb-1">管理者のメールアドレス（承認依頼の通知・パスワード再設定の宛先）</label><input id="co-admin-email" type="email" class="inp"></div>
      <p class="text-[11px] text-gray-400">初回ログインで、管理者本人にパスワードの変更を求めます。</p>
      <button class="btn btn-primary w-full" data-action="addCompany">登録する</button>
    </div>`)
}
delegate('addCompany', (el) => withSubmitLock(el, async () => {
  const code = document.getElementById('co-code').value.trim()
  const adminCode = document.getElementById('co-admin-code').value.trim()
  try {
    const { data } = await axios.post('/api/hq/companies', {
      company_code: document.getElementById('co-code').value.trim(),
      company_name: document.getElementById('co-name').value.trim(),
      plan: document.getElementById('co-plan').value,
      user_limit: Number(document.getElementById('co-limit').value || 3),
      admin_code: document.getElementById('co-admin-code').value.trim(),
      admin_name: document.getElementById('co-admin-name').value.trim(),
      admin_password: document.getElementById('co-admin-pass').value,
      admin_email: document.getElementById('co-admin-email').value.trim()
    })
    closeModal(); toast('企業を登録しました'); renderCompanies()
    if (data.admin_temp_password) showTempPassword('初期管理者を作成しました', data.admin_temp_password, [`会社コード: ${code}`, `管理者ID: ${adminCode}`, `ログイン: ${location.origin}/login`])
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '登録に失敗しました') }
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
async function renderCompanyDetail(cid) {
  loading()
  const { data } = await axios.get('/api/hq/companies/' + cid)
  const c = data.company
  HQ_USERS = new Map(data.users.map(u => [u.user_id, u]))
  const ROLE_LABELS ={ company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', staff: 'スタッフ', system_admin: 'システム管理者' }
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
              <select id="cd-status" data-current="${esc(c.active_status)}" class="inp" style="background:#1e293b;border-color:#334155;color:#fff">
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
        <div class="flex items-center justify-between mb-3 gap-2">
          <h3 class="font-bold"><i class="fas fa-users text-cyan-400 mr-1"></i>ユーザー一覧 (${data.users.length}名)</h3>
          <button class="btn btn-outline text-xs" style="border-color:#334155;color:#67e8f9" data-action="hqAddAdmin" data-cid="${Number(cid)}"><i class="fas fa-plus"></i>管理者を追加</button>
        </div>
        <p class="text-[11px] text-slate-400 mb-2">管理者のメールアドレスは、承認依頼の通知とパスワード再設定の宛先です。スタッフのパスワードは各社の管理画面（スタッフ詳細）で再発行します。</p>
        <div class="max-h-96 overflow-y-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-slate-400 border-b border-slate-700">
              <th class="text-left py-2">ID</th><th class="text-left py-2">氏名</th><th class="text-left py-2">権限</th><th class="text-left py-2">メール</th><th class="text-left py-2">最終ログイン</th><th></th>
            </tr></thead>
            <tbody>
              ${data.users.map(u => `
                <tr class="border-b border-slate-700/40">
                  <td class="py-2 text-slate-400">${esc(u.user_code)}</td>
                  <td class="py-2">${esc(u.name)}${u.status !== 'active' ? ' <span class="badge badge-gray">停止</span>' : ''}${u.must_change_password && HQ_ADMIN_ROLES.includes(u.role) ? ' <span class="badge badge-yellow">仮パスワード</span>' : ''}</td>
                  <td class="py-2"><span class="badge ${u.role === 'staff' ? 'badge-gray' : 'badge-blue'}">${ROLE_LABELS[u.role] || esc(u.role)}</span></td>
                  <td class="py-2 text-slate-400">${HQ_ADMIN_ROLES.includes(u.role) ? (u.email ? esc(u.email) : '<span class="text-amber-400">未登録</span>') : ''}</td>
                  <td class="py-2 text-slate-400">${u.last_login_at ? dayjs(u.last_login_at).format('M/D HH:mm') : '-'}</td>
                  <td class="py-2 text-right whitespace-nowrap">${HQ_ADMIN_ROLES.includes(u.role) ? `<button class="text-cyan-400 hover:underline" data-action="hqManageAdmin" data-cid="${Number(cid)}" data-id="${u.user_id}">管理</button>` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>
    </div>`
}

window.saveCompany = async function (cid) {
  const status = document.getElementById('cd-status')
  // 停止にすると、その企業の利用者は全員ログアウトされ、ログインと報告用URLも使えなくなる
  if (status.value === 'inactive' && status.dataset.current !== 'inactive'
    && !confirm('この企業を「停止」にします。\nこの企業の管理者・スタッフは全員ログアウトされ、ログインも報告用URLも使えなくなります。よろしいですか？')) return
  const { data } = await axios.put('/api/hq/companies/' + cid, {
    plan: document.getElementById('cd-plan').value,
    user_limit: Number(document.getElementById('cd-limit').value),
    active_status: document.getElementById('cd-status').value,
    billing_status: document.getElementById('cd-billing').value,
    maturity_level: Number(document.getElementById('cd-maturity').value),
    support_memo: document.getElementById('cd-memo').value
  })
  status.dataset.current = status.value
  toast(data.revoked_sessions ? `保存しました（${data.revoked_sessions}件のログインを終了しました）` : '保存しました')
}

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

// ============ メール送信（#438 #541） ============
// 直近の期間の会社別・種類別の送信数と、届かなかった割合・理由の上位・最後に成功した日時。宛先は伏せて表示する
const MAIL_TYPE_LABEL = { notice: 'お知らせ', attendance_correction: '打刻修正の通知', incident_report: 'インシデントの通知', password_reset: 'パスワード再設定', account_email: 'メールアドレスの確認' }
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
      <p class="text-[11px] text-slate-400 mb-2">届かなかった割合が${Math.round(stats.alert.rate * 100)}%以上（送信${stats.alert.min}件以上）の会社は、画面の上部に警告を出します。送信無効の環境（MAIL_ENABLED=false）で送らなかったものは割合に含めません。</p>
      <table class="w-full text-sm">
        <thead><tr class="text-slate-400 text-xs border-b border-slate-700"><th class="text-left px-2 py-2">企業</th><th class="text-right px-2">送信</th><th class="text-right px-2">成功</th><th class="text-right px-2">届かなかった</th><th class="text-right px-2">割合</th><th class="text-left px-2">種類別（成功/送信）</th><th class="text-left px-2">最後に成功</th><th></th></tr></thead>
        <tbody>${stats.companies.map(c => `<tr class="border-b border-slate-700/40">
          <td class="px-2 py-2">${esc(c.company_name)}</td><td class="px-2 text-right">${c.total}</td><td class="px-2 text-right">${c.ok}</td>
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
        <td class="px-2 text-xs ${['failed', 'bounced', 'complained'].includes(l.status) ? 'text-red-400' : ''}">${esc(MAIL_STATUS_LABEL[l.status] || l.status)}</td>
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
  box.innerHTML = warnings.length ? `
    <div class="bg-slate-800 border rounded-xl p-3 text-sm" style="border-color:#f59e0b">
      <p class="font-bold text-amber-400"><i class="fas fa-envelope-circle-check mr-1"></i>メールが届いていない会社があります</p>
      <ul class="mt-1 text-xs">${warnings.map(w => `<li>・${esc(w.message)}</li>`).join('')}</ul>
      <a href="#mail" class="text-cyan-400 text-xs hover:underline">メール送信を開く →</a>
    </div>` : ''
  box.style.display = warnings.length ? '' : 'none'
}
async function refreshMailAlert() {
  try { renderMailAlert((await axios.get('/api/hq/email-stats', { params: { days: 7 } })).data) } catch { }
}

// ============ ルーティング ============
const routes = { companies: renderCompanies, templates: renderTemplates, retention: renderRetention, support: renderSupport }
routes.mail = renderHqMail

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
  // メールの届かない会社の警告（#438）。メール送信のタブは自分で描き直す
  if (!/^#mail/.test(location.hash)) refreshMailAlert()
})()
