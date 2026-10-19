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
  user_notifications: 'アプリ内通知（2年）', email_logs: 'メール送信ログ（1年）',
  attendance_corrections: '打刻修正申請（退職後7年）', attendance_correction_events: '打刻修正の操作履歴（退職後7年）',
  notification_emails: '通知メールの送信状態（退職後7年）', report_setting_logs: '報告設定の変更履歴（退職後7年）', project_staff_report_settings: '報告設定（スタッフ別・退職後7年）',
  notice_read_staff_reports: '既読率（スタッフ別・退職後7年）',
  employee_records: '従業員データ（口座・住所・給与・緊急連絡先。退職後7年）', employment_periods: '過去の雇用期間（退職後7年）',
  staff_documents: '履歴書など（退職後7年）', employee_documents: '入社時書類（退職後7年）', r2_documents: 'R2書類ファイル（退職後7年）',
  roster_comments: '企業間チャット（退職後7年）', roster_comment_reads: '企業間チャットの既読位置（退職後7年）', roster_consents: '連携の同意履歴（退職後7年）',
  anonymized_staff: '本人情報の匿名化（退職後7年）',
  retired_staff_deferred: '上限で翌日に回した退職スタッフ（人数）', r2_pending: '翌日以降に消すR2ファイル（残り）',
  password_reset_tokens: 'パスワード再設定のリンク（期限切れ・使用済み）', expired_report_tokens: '報告用URL（期限から30日・取り消し済み）',
}
// 人ごとの dry-run の内訳で出す列（API の DRY_RUN_STAFF_COUNTS と同じキー）
const RETENTION_STAFF_COLS = [
  ['shifts', 'シフト'], ['attendance_reports', '出退勤'], ['r2_photos', '写真'], ['evaluations', '評価'], ['follow_logs', 'やり取り'],
  ['consultations', '相談'], ['attendance_corrections', '打刻修正'], ['employee_records', '従業員データ'], ['documents', '書類'],
  ['roster_comments', 'チャット'], ['notice_read_staff_reports', '既読率'],
]
const RETENTION_TRIGGER_LABEL = { cron: '定期処理', manual: '手動' }
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
        <p class="text-sm text-slate-400 mt-1">日報は3年、アプリ内通知は2年、メール送信ログは1年で削除します。出退勤記録・シフト・評価・やり取り・相談・R2写真・打刻修正・報告設定・スタッフ別の既読率・従業員データ（口座・住所・給与など）・履歴書や入社時書類・企業間チャット・連携の同意履歴は退職後7年で削除し、氏名・連絡先などの本人情報は匿名化します（毎日Cronで実行）。期限切れ・使用済みのパスワード再設定のリンクと報告用URLも毎日削除します。</p>
      </div>
      <button class="btn btn-outline" data-action="runRetentionDryRun"><i class="fas fa-magnifying-glass"></i>dry-run実行（削除せず対象件数を確認）</button>
    </div>
    ${retentionModeHtml(sch)}
    ${cron ? cronStatusHtml(cron) : '<p class="text-sm text-red-400 mb-5">定期処理の実行記録の取得に失敗しました</p>'}
    <div id="retention-dryrun-result" class="mb-5">${retentionState.dryRun ? retentionDryRunHtml(retentionState.dryRun) : ''}</div>
    ${sch ? retentionScheduleHtml(sch) : '<p class="text-sm text-red-400 mb-5">次回削除予定の取得に失敗しました</p>'}
    <section class="bg-slate-800 border border-slate-700 rounded-xl p-4" id="retention-logs"></section>`
  await loadRetentionLogs()
}

// 実行ログ（1回の実行を1行にまとめ、開くと対象ごとの内訳。#305）
function retentionRunRow(r) {
  const items = r.items.map(i => `
    <tr>
      <td>${esc(RETENTION_TARGET_LABEL[i.target] || i.target)}</td>
      <td>${esc(i.target_count)}</td><td>${esc(i.deleted_count)}</td>
      <td>${i.failed_count > 0 ? `<span class="text-red-400">${esc(i.failed_count)}</span>` : '0'}</td>
    </tr>${i.error_message ? `
    <tr><td colspan="4" class="text-xs text-red-400" style="white-space:pre-wrap;word-break:break-all">失敗の理由: ${esc(i.error_message)}</td></tr>` : ''}`).join('')
  return `
    <tr>
      <td class="text-xs">${r.started_at ? esc(dayjs(r.started_at).format('YYYY/M/D HH:mm')) : '-'}</td>
      <td class="text-xs">${esc(RETENTION_TRIGGER_LABEL[r.trigger_source] || '-')}${r.triggered_by_name ? `<br><span class="text-slate-500">${esc(r.triggered_by_name)}</span>` : ''}</td>
      <td><span class="badge ${r.dry_run ? 'badge-gray' : 'badge-blue'}">${r.dry_run ? 'dry-run' : '実削除'}</span></td>
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
