// Field OS 管理者用SPA
const $app = document.getElementById('app')
let ME = null

const LABELS = { mnp: 'MNP', pi: 'PI', shinki: '新規', kishuhen: '機変', hikari: '光回線', wifi: 'Wi-Fi', denki: 'でんき', card: 'クレカ', koekake: '声かけ', shodan: '商談', seiyaku: '成約' }
const CAT_LABELS = { health: '体調不良', absence: '遅刻・欠勤相談', store_trouble: '店舗トラブル', claim: 'クレーム', relationship: '人間関係', shift: 'シフト相談', question: '業務質問', other: 'その他' }
const FOLLOW_LABELS = { interview: '面談', phone: '電話', line: 'LINE連絡', warning: '注意', praise: '称賛', training: '研修案内', claim: 'クレーム対応', health: '体調確認', shift: '稼働相談', career: 'キャリア相談', round: 'ラウンド' }
const PTYPE_LABELS = { mobile_shop: '携帯ショップ', electronics: '家電量販店', event: '催事・イベント', fiber: '光回線', fixed_line: '固定回線', callcenter: 'コールセンター', other: 'その他' }
const RISK_BADGE = { low: '<span class="badge badge-green">低</span>', mid: '<span class="badge badge-yellow">中</span>', high: '<span class="badge badge-red">高</span>' }

// スタッフマスタの所属区分（作成ルート）
const AFF_TYPE_LABEL = { own_employee: '自社雇用', daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属', linked_external: '他社連携', skillsheet_only: 'スキルシートのみ' }
const AFF_TYPE_BADGE = { own_employee: 'badge-green', daily_worker: 'badge-yellow', freelance: 'badge-yellow', linked_external: 'badge-blue', partner_manual: 'badge-purple', skillsheet_only: 'badge-gray' }
function affTypeBadge(t) { t = t || 'own_employee'; return `<span class="badge ${AFF_TYPE_BADGE[t] || 'badge-gray'}">${esc(AFF_TYPE_LABEL[t] || t)}</span>` }

function yen(n) { return '¥' + Number(n || 0).toLocaleString() }
function toast(msg) {
  let root = document.getElementById('toast')
  if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
  const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg
  root.appendChild(el); setTimeout(() => el.remove(), 2500)
}
function loading() { $app.innerHTML = '<div class="flex justify-center py-20"><span class="spin"></span></div>' }
// opts.onClose: 閉じたとき（ボタン・背景のタップ・画面の移動のどれでも）に1回だけ呼ぶ。別のモーダルに置き換えたときは呼ばない（#266）
let MODAL_ON_CLOSE = null
function modal(html, opts = {}) {
  MODAL_ON_CLOSE = typeof opts.onClose === 'function' ? opts.onClose : null
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal-box p-5">${html}</div></div>`
}
window.closeModal = () => {
  document.getElementById('modal-root').innerHTML = ''
  const fn = MODAL_ON_CLOSE; MODAL_ON_CLOSE = null
  if (fn) { try { fn() } catch (e) { } }
}

// ============ API 呼び出しの共通処理: ログインの期限切れ・アカウントの切り替え（#346 #526）・エラーの表示（#230） ============
// バッジ更新・やり取りの新着確認など、利用者の操作によらない定期の取得（config に background: true を付けたものも含む）。
// これらはセッションを延長せず（X-Background）、期限が切れても画面を移動しない
const BACKGROUND_API = /^\/api\/admin\/(notifications\/unread-count|corrections\/pending-count|board\/unread-count|roster-chat\/unread-count|recruit-applications\/summary)(\?|$)/
const SESSION_WARN_MINUTES = 30
let SESSION_STATE = 'active' // active: 利用中 / expired: 期限切れ（再ログイン待ち） / switched: 別のアカウントでログインされた
let SESSION_EXPIRES = null   // サーバーが返したセッションの期限（ミリ秒。端末の時計とのずれを補正済み）
let RELOGIN_WAITERS = []     // 期限切れで止まった利用者の操作（再ログインの後に送り直す）
// 定期の取得を止めるかどうか（notifications.js・board.js・roster-chat.js のポーリングで使う）
window.sessionUsable = () => SESSION_STATE === 'active'
// ログインの後に今の画面へ戻れるよう、パスとハッシュを next に付ける（#206）
const loginNextUrl = () => '/login?next=' + encodeURIComponent(location.pathname + location.hash)

axios.interceptors.request.use(cfg => {
  if (cfg.background || BACKGROUND_API.test(cfg.url || '')) { cfg.background = true; cfg.headers['X-Background'] = '1' }
  // 起動時に読んだ自分と違う人のセッションで処理されないよう、サーバーで照合する
  if (ME) cfg.headers['X-Expected-User-Id'] = String(ME.user_id)
  return cfg
})
function noteSessionExpires(res) {
  const exp = res && res.headers && res.headers['x-session-expires']
  if (!exp) return
  const skew = res.headers.date ? Date.parse(res.headers.date) - Date.now() : 0
  SESSION_EXPIRES = Date.parse(exp) - (Number.isFinite(skew) ? skew : 0)
}
axios.interceptors.response.use(r => { noteSessionExpires(r); return r }, e => {
  const r = e.response
  if (r) noteSessionExpires(r)
  if (e.config && e.config.skipSessionCheck) return Promise.reject(e)
  if (r && r.status === 409 && r.data && r.data.code === 'account_switched') { showAccountSwitched(); return Promise.reject(e) }
  // 開いている間に二段階認証が必須になった（#544）: 登録の画面へ移す
  if (r && r.status === 403 && r.data && r.data.code === 'mfa_setup_required' && !(e.config && e.config.background)) {
    if (ME) ME.mfa_setup_required = true
    if (location.hash !== '#security') location.hash = 'security'
    return Promise.reject(e)
  }
  if (r && r.status === 401) {
    if (!ME) { location.href = loginNextUrl(); return Promise.reject(e) }
    showSessionExpired()
    if (e.config && e.config.background) return Promise.reject(e)
    // 利用者の操作: 入力中の画面を残したまま再ログインしてもらい、ログインできたら同じ操作を送り直す
    return new Promise((resolve, reject) => RELOGIN_WAITERS.push({ resolve, reject, config: e.config }))
  }
  return Promise.reject(e)
})
// 画面の処理で受け止められなかった API のエラー（500 など）を表示する。サーバーの文言には参照番号が入る
window.addEventListener('unhandledrejection', ev => {
  const e = ev.reason
  if (!e || !e.isAxiosError || (e.config && (e.config.background || e.config.skipSessionCheck))) return
  const st = e.response && e.response.status
  if (st === 401 || (st === 409 && e.response.data && e.response.data.code === 'account_switched')) return
  showApiError(e, st ? '処理に失敗しました' : '通信できませんでした。接続を確かめて、もう一度お試しください')
})

function sessionRoot() {
  let el = document.getElementById('session-root')
  if (!el) { el = document.createElement('div'); el.id = 'session-root'; document.body.appendChild(el) }
  return el
}
function showSessionExpired() {
  if (SESSION_STATE !== 'active') return
  SESSION_STATE = 'expired'
  RELOGIN_MFA_TOKEN = null
  hideSessionWarning()
  // 入力中のモーダル（#modal-root）は消さずに、その上に重ねて出す
  sessionRoot().innerHTML = `<div class="modal-bg" style="z-index:70"><div class="modal-box p-5" role="dialog" aria-modal="true">
    <h3 class="font-bold text-gray-800 mb-2"><i class="fas fa-lock text-amber-500 mr-1"></i>ログインの期限が切れました</h3>
    <p class="text-sm text-gray-600 mb-3">入力中の内容は残っています。パスワードを入力してログインし直すと、そのまま続けられます。保存などの操作は、ログインし直した後にもう一度送ります。</p>
    <form id="relogin-form">
      <p class="text-xs text-gray-500 mb-1">${ME.company_code ? '会社コード ' + esc(ME.company_code) + ' / ' : ''}ID ${esc(ME.user_code)}（${esc(ME.name)}）</p>
      <input type="password" id="relogin-pw" class="inp" autocomplete="current-password" placeholder="パスワード" required>
      <div id="relogin-mfa" class="hidden mt-2">
        <p class="text-xs text-gray-500 mb-1">認証アプリに表示されている6桁を入力してください（使えないときは予備コード）。</p>
        <input id="relogin-code" class="inp" inputmode="numeric" autocomplete="one-time-code" maxlength="20" placeholder="確認コード">
      </div>
      <p id="relogin-error" class="hidden text-sm text-red-600 mt-2"></p>
      <div class="flex flex-wrap gap-2 justify-end mt-4">
        <button type="button" class="btn btn-outline" data-action="sessionGoLogin">ログイン画面へ（入力中の内容は消えます）</button>
        <button type="submit" class="btn btn-primary" id="relogin-btn">ログインし直す</button>
      </div>
    </form></div></div>`
  document.getElementById('relogin-form').addEventListener('submit', ev => { ev.preventDefault(); relogin(document.getElementById('relogin-btn')) })
  setTimeout(() => { const pw = document.getElementById('relogin-pw'); if (pw) pw.focus() }, 0)
}
// 二段階認証を登録している人は、パスワードの後で確認コードを入力する（#544）
let RELOGIN_MFA_TOKEN = null
function relogin(btn) {
  return withSubmitLock(btn, async () => {
    const err = document.getElementById('relogin-error')
    err.classList.add('hidden')
    try {
      const { data } = RELOGIN_MFA_TOKEN
        ? await axios.post('/api/auth/login/mfa', { mfa_token: RELOGIN_MFA_TOKEN, code: document.getElementById('relogin-code').value.trim() }, { skipSessionCheck: true })
        : await axios.post('/api/auth/login', { company_code: ME.company_code || '', user_code: ME.user_code, password: document.getElementById('relogin-pw').value },
          { skipSessionCheck: true })
      if (data.mfa_required) {
        RELOGIN_MFA_TOKEN = data.mfa_token
        document.getElementById('relogin-mfa').classList.remove('hidden')
        document.getElementById('relogin-pw').disabled = true
        document.getElementById('relogin-code').focus()
        return
      }
      RELOGIN_MFA_TOKEN = null
      if (!data.user || data.user.user_id !== ME.user_id) { SESSION_STATE = 'active'; showAccountSwitched(); return }
    } catch (e) {
      // 確認コードの時間切れ・失敗の上限なら、パスワードから入力し直してもらう
      if (e.response && e.response.data && e.response.data.code === 'mfa_expired') {
        RELOGIN_MFA_TOKEN = null
        document.getElementById('relogin-mfa').classList.add('hidden')
        const pw = document.getElementById('relogin-pw'); pw.disabled = false; pw.value = ''
      }
      err.textContent = (e.response && e.response.data && e.response.data.error) || 'ログインに失敗しました。通信の状況を確かめてください'
      err.classList.remove('hidden')
      return
    }
    SESSION_STATE = 'active'
    sessionRoot().innerHTML = ''
    const waiters = RELOGIN_WAITERS; RELOGIN_WAITERS = []
    waiters.forEach(w => axios(w.config).then(w.resolve, w.reject))
    toast('ログインし直しました')
    if (window.refreshNotifBadge) refreshNotifBadge()
    if (window.refreshBoardBadge) refreshBoardBadge()
    if (window.refreshChatBadge) refreshChatBadge()
  })
}
delegate('sessionGoLogin', () => { location.href = loginNextUrl() })
function showAccountSwitched() {
  if (SESSION_STATE === 'switched') return
  SESSION_STATE = 'switched'
  hideSessionWarning()
  const waiters = RELOGIN_WAITERS; RELOGIN_WAITERS = []
  waiters.forEach(w => w.reject(new Error('account_switched')))
  sessionRoot().innerHTML = `<div class="modal-bg" style="z-index:70"><div class="modal-box p-5" role="dialog" aria-modal="true">
    <h3 class="font-bold text-gray-800 mb-2"><i class="fas fa-user-group text-amber-500 mr-1"></i>別のアカウントでログインされました</h3>
    <p class="text-sm text-gray-600 mb-4">このブラウザで別のアカウントにログインされたため、この画面（${esc(ME ? ME.name : '')}）からの操作を止めました。操作した人と違う名前で記録されるのを防ぐためです。画面を読み直すと、今ログインしているアカウントで開き直します。</p>
    <div class="flex justify-end"><button type="button" class="btn btn-primary" data-action="sessionReload">画面を読み直す</button></div>
  </div></div>`
}
delegate('sessionReload', () => location.reload())

// 期限の30分前から、画面の下に予告を出す（操作すれば延びる。ログインからの最長期間に達したら延ばせない）
function showSessionWarning(left) {
  let el = document.getElementById('session-warning')
  if (!el) {
    el = document.createElement('div'); el.id = 'session-warning'
    el.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl px-4 py-2 text-sm shadow flex flex-wrap items-center gap-3 max-w-[95vw]'
    document.body.appendChild(el)
  }
  const at = dayjs(SESSION_EXPIRES).format('HH:mm')
  el.innerHTML = el.dataset.capped === '1'
    ? `<span><i class="fas fa-clock mr-1"></i>ログインからの最長期間に達するため、${at} にログインの期限が切れます。それまでに保存して、ログインし直してください。</span>`
    : `<span><i class="fas fa-clock mr-1"></i>あと${Math.max(1, Math.ceil(left / 60000))}分（${at}）でログインの期限が切れます。</span><button type="button" class="btn btn-outline text-xs" data-action="sessionExtend">延長する</button>`
}
function hideSessionWarning() { const el = document.getElementById('session-warning'); if (el) el.remove() }
delegate('sessionExtend', (btn) => withSubmitLock(btn, async () => {
  try { await axios.get('/api/auth/me') } catch (e) { return }
  const left = SESSION_EXPIRES - Date.now()
  if (left > SESSION_WARN_MINUTES * 60000) { hideSessionWarning(); toast('ログインの期限を延長しました'); return }
  const el = document.getElementById('session-warning'); if (el) el.dataset.capped = '1'
  showSessionWarning(left)
}))
setInterval(() => {
  if (SESSION_STATE !== 'active' || !SESSION_EXPIRES) return
  const left = SESSION_EXPIRES - Date.now()
  // 期限を過ぎたら、画面を移動せずにサーバーへ確かめる（切れていれば再ログインのダイアログを出す）
  if (left <= 0) { axios.get('/api/auth/me', { background: true }).catch(() => {}); return }
  if (left <= SESSION_WARN_MINUTES * 60000) showSessionWarning(left)
  else hideSessionWarning()
}, 60 * 1000)

async function logout() {
  await axios.post('/api/auth/logout'); location.href = '/login'
}
document.getElementById('logout-btn').addEventListener('click', logout)
// スマホ用ヘッダーのログアウト（#236）。押し間違えやすい位置なので確認する
const mobileLogout = document.getElementById('mobile-logout-btn')
if (mobileLogout) mobileLogout.addEventListener('click', () => { if (confirm('ログアウトしますか？')) logout() })
// ログイン中の会社名・氏名（サイドバーとスマホ用ヘッダー）
function showCompanyName(text) {
  for (const id of ['company-name', 'mobile-company-name']) { const el = document.getElementById(id); if (el) el.textContent = text }
}
// メニューの件数（#236）。スマホではサイドバーが隠れるので、メニューの選択欄の項目名に「（n）」を付け、ヘッダーに合計を出す。
// 合計は打刻修正・応募・掲示板・チャット（通知は承認依頼が打刻修正と重なるため、選択欄の項目名にだけ出す）
const NAV_COUNTS = {}
const NAV_TOTAL_TABS = ['corrections', 'recruit', 'board', 'roster-chat']
window.setNavCount = function (tab, n) {
  n = Number(n) || 0
  NAV_COUNTS[tab] = n
  const opt = document.querySelector(`#mobile-nav option[value="${tab}"]`)
  if (opt) {
    if (!opt.dataset.label) opt.dataset.label = opt.textContent.replace(/（\d+）$/, '')
    opt.textContent = opt.dataset.label + (n ? `（${n}）` : '')
  }
  const total = NAV_TOTAL_TABS.reduce((a, k) => a + (NAV_COUNTS[k] || 0), 0)
  const b = document.getElementById('mobile-todo-badge')
  if (b) { b.textContent = total; b.classList.toggle('hidden', !total) }
}

// ============ ダッシュボード ============
// 入店/退店報告の写真添付（会社全体の設定）。ダッシュボードには現在の状態だけを出し、
// 変更は影響する案件の数と変更の記録を見てから、確認して行う（#405）
const dashDateTime = v => dayjs(String(v || '').replace(' ', 'T')).format('YYYY/M/D HH:mm')
delegate('photoRequiredSetting', async () => {
  let d
  try { d = (await axios.get('/api/admin/settings/photo-required')).data } catch (e) { showApiError(e, '設定を読み込めませんでした'); return }
  const p = d.projects || {}
  const next = !d.enabled
  modal(`<h3 class="font-bold text-lg mb-2">入店/退店報告の写真添付（会社全体）</h3>
    <p class="text-sm mb-2">現在: <span class="badge ${d.enabled ? 'badge-green' : 'badge-gray'}">${d.enabled ? '必須' : '無効'}</span></p>
    <p class="text-xs text-gray-600 mb-3">変更すると、写真の設定を案件ごとに決めていない進行中の案件 <b>${Number(p.follow) || 0}件</b> のすべてのスタッフに、次の報告から反映されます。
      案件ごとに「必須」（${Number(p.required) || 0}件）・「不要」（${Number(p.not_required) || 0}件）にしている案件は変わりません。無効にすると、写真での入店確認ができなくなります。</p>
    <div class="mb-4">
      <p class="text-xs font-bold text-gray-600 mb-1">変更の記録</p>
      ${(d.history || []).length ? `<ul class="text-xs text-gray-500 space-y-0.5">${d.history.map(h => `<li>${esc(dashDateTime(h.at))} ${esc(h.name || '-')}: ${h.enabled ? '必須に変更' : '無効に変更'}</li>`).join('')}</ul>`
        : '<p class="text-xs text-gray-400">記録はありません</p>'}
    </div>
    <div class="flex gap-2"><button type="button" class="btn btn-outline flex-1" onclick="closeModal()">閉じる</button>
      <button type="button" class="btn ${next ? 'btn-primary' : 'btn-danger'} flex-1" data-action="savePhotoRequired" data-enabled="${next ? '1' : '0'}" data-follow="${Number(p.follow) || 0}">${next ? '必須にする' : '無効にする'}</button></div>`)
})
delegate('savePhotoRequired', el => withSubmitLock(el, async () => {
  const enabled = el.dataset.enabled === '1'
  if (!confirm(`会社全体の写真添付を「${enabled ? '必須' : '無効'}」に変更します。\n会社の設定に従う進行中の案件 ${Number(el.dataset.follow) || 0}件に反映されます。よろしいですか？`)) return
  try { await axios.post('/api/admin/settings/photo-required', { enabled }) } catch (e) { showApiError(e, '設定の更新に失敗しました'); return }
  closeModal(); toast(enabled ? '写真添付を必須にしました' : '写真添付を無効にしました'); renderDashboard()
}))

window.updateProjectPhotoRequired = async function (pid, override) {
  try {
    await axios.put(`/api/admin/projects/${pid}/photo-required`, { override })
    toast('設定を更新しました')
    renderProjectDetail(pid)
  } catch {
    toast('設定の更新に失敗しました')
  }
}

// ダッシュボードの最後の取得結果（シフトID → シフト）。欠勤・代わりの手配・報告状況のモーダルで使う
const DASH_SHIFTS = new Map()
const DASH_RS = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '開始', break_start: '休入', break_end: '休出', work_end: '終了', check_out: '退店' }
// 電話の記録（フォロー履歴）に書く、何の未報告で電話したか（#343）
const DASH_CALL_LABEL = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_end: '勤務終了・退店の報告', daily_report: '日報' }
// 本日のシフトの表の絞り込み（案件・状態）。再読み込みしても保つ（#488 #348）
const DASH_FILTER = { project: '', only: '' }
let DASH_DATA = null
// 経過時間（分）を「n分」「n時間m分」に
function dashElapsed(min) { min = Math.max(0, Number(min) || 0); return min < 60 ? `${min}分` : `${Math.floor(min / 60)}時間${min % 60 ? (min % 60) + '分' : ''}` }
// 届いている遅刻・欠勤・体調不良の相談（種類・時刻・本文の先頭）と、相談対応で開くリンク（#498）
function dashContactLine(co) {
  return `<a href="#consult/${Number(co.consultation_id)}" class="block px-2 pb-1 text-[11px] text-blue-800 hover:underline">
    <i class="fas fa-comment-dots mr-1"></i>${esc(co.category_label || '')} ${esc(String(co.created_at || '').slice(11, 16))}${co.urgency === 'high' ? '・緊急' : ''}: ${esc(co.excerpt || '')}</a>`
}
// 電話の発信リンク（スマホではそのまま発信できる）と、電話したことをフォロー履歴に残すボタン（#343）
function dashPhoneLine(shiftId, phone, kind) {
  const tel = String(phone || '').replace(/[^0-9+]/g, '')
  return `<div class="flex items-center gap-3 px-2 pb-1 text-[11px]">
    ${tel ? `<a href="tel:${esc(tel)}" class="text-blue-700 hover:underline whitespace-nowrap"><i class="fas fa-phone mr-0.5"></i>${esc(phone)}</a>` : '<span class="text-gray-400">電話番号なし</span>'}
    <button type="button" class="text-gray-600 hover:underline whitespace-nowrap" data-action="dashCallLog" data-id="${Number(shiftId)}" data-kind="${esc(kind)}" title="フォロー履歴に『電話』として記録します"><i class="fas fa-pen mr-0.5"></i>電話したと記録</button>
  </div>`
}
// ログインのない人（報告用URLか代理入力で報告する人）と、報告用URLを発行していないことの印（#355）
function dashLoginBadges(s) {
  if (s.has_login !== false || s.status === 'absent') return ''
  return '<span class="badge badge-gray text-[10px]" title="アプリのログインがありません。報告用URLか代理入力で報告します">ログインなし</span>'
    + (s.has_report_link ? '' : ' <span class="badge badge-yellow text-[10px]" title="このシフトの報告用URLをまだ発行していません">URL未発行</span>')
}

async function renderDashboard() {
  loading()
  const { data } = await axios.get('/api/admin/dashboard')
  DASH_DATA = data
  const un = data.unreported
  DASH_SHIFTS.clear()
  for (const s of [...data.shifts, ...(data.absent_shifts || [])]) DASH_SHIFTS.set(s.shift_id, s)
  // 未報告の一覧・日報未提出の一覧には、本日の一覧にないシフトも入る
  for (const u of Object.values(un).flat()) if (!DASH_SHIFTS.has(u.shift_id)) DASH_SHIFTS.set(u.shift_id, { shift_id: u.shift_id, staff_id: u.staff_id, staff_name: u.name, project_id: u.project_id, project_name: u.project, work_date: u.work_date, start_time: u.start_time, end_time: u.end_time })
  for (const r of data.missing_daily_reports || []) if (!DASH_SHIFTS.has(r.shift_id)) DASH_SHIFTS.set(r.shift_id, { shift_id: r.shift_id, staff_id: r.staff_id, staff_name: r.staff_name, project_id: r.project_id, project_name: r.project_name, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time })
  if (DASH_FILTER.project && !data.shifts.some(s => String(s.project_id) === DASH_FILTER.project)) DASH_FILTER.project = ''
  const kpi = (label, value, icon, color, sub) => `
    <div class="card p-4 min-w-0">
      <div class="flex items-center justify-between">
        <div class="min-w-0">
          <p class="text-xs text-gray-500">${label}</p>
          <p class="text-2xl font-bold text-gray-900 mt-0.5 truncate">${value}</p>
          ${sub ? `<p class="text-xs text-gray-400 mt-0.5">${sub}</p>` : ''}
        </div>
        <span class="w-10 h-10 rounded-xl ${color} flex items-center justify-center"><i class="fas ${icon}"></i></span>
      </div>
    </div>`
  const md = d => esc(dayjs(d).format('M/D')) + `（${'日月火水木金土'[dayjs(d).day()]}）`

  // 未報告の一覧: 予定の時刻を過ぎた人だけ（人ごとに1行。#449）。押すとそのシフトの報告状況（代理入力・報告用URL）を開く。
  // 遅刻・欠勤・体調不良の相談が届いている人は『連絡あり』と本文の先頭を出し、相談を開けるようにする（連絡のない人が上。#498）。
  // 電話番号（すぐ発信）と、ログインのない人・報告用URLを発行していない人の印を出す（#343 #355）
  const alertList = (title, list, color, kind) => {
    const contacted = list.filter(s => s.contact).length
    const isEnd = kind === 'work_end'
    return `
    <div class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">${title}
        <span class="badge ${list.length ? 'badge-' + color : 'badge-green'} ml-1">${list.length ? list.length + '名' : 'なし'}</span>
        ${contacted ? `<span class="badge badge-blue ml-1">うち連絡あり${contacted}名</span>` : ''}</h3>
      ${list.length ? `<div class="space-y-1 max-h-60 overflow-y-auto">${list.map(s => `
        <div class="rounded-lg ${s.contact ? 'bg-blue-50' : color === 'red' ? 'bg-red-50' : 'bg-amber-50'} text-xs">
          <button type="button" class="w-full text-left px-2 py-1 hover:opacity-80" data-action="dashShiftReport" data-id="${Number(s.shift_id)}">
            <span class="font-bold text-gray-800">${esc(s.name)}</span>${s.work_date !== data.today ? ' <span class="badge badge-gray text-[10px]">前日</span>' : ''}
            ${s.other_shifts ? `<span class="badge badge-gray text-[10px]">ほか${Number(s.other_shifts)}シフト</span>` : ''}
            ${s.contact ? '<span class="badge badge-blue text-[10px]">連絡あり</span>' : ''}
            ${dashLoginBadges(s)}
            <span class="block text-gray-500">${isEnd ? `${esc(s.end_time)}終了予定・未: ${esc((s.missing || []).map(t => DASH_RS[t] || t).join('・'))}` : `${esc(s.start_time)}開始`}・${dashElapsed(s.overdue_minutes)}経過 ${esc(s.project || '')}</span>
          </button>
          ${dashPhoneLine(s.shift_id, s.phone, kind)}
          ${s.contact ? dashContactLine(s.contact) : ''}
        </div>`).join('')}</div>`
      : '<p class="text-xs text-gray-400">予定の時刻を過ぎた未報告はありません <i class="fas fa-check text-emerald-500"></i></p>'}
    </div>`
  }

  // 日報未提出（直近3日）の一覧: 日付・スタッフ・案件・電話。押すとそのシフトの報告状況（日報の代理入力を含む）を開く（#344）
  const missing = data.missing_daily_reports || []
  const missingHtml = missing.length ? `<div class="space-y-1 max-h-72 overflow-y-auto">${missing.map(r => `
    <div class="rounded-lg bg-red-50 text-xs">
      <button type="button" class="w-full text-left px-2 py-1 hover:opacity-80" data-action="dashShiftReport" data-id="${Number(r.shift_id)}">
        <span class="text-gray-500">${md(r.work_date)} ${esc(formatShiftTime(r.start_time, r.end_time))}</span>
        <span class="font-bold text-gray-800 ml-1">${esc(r.staff_name)}</span>
        ${r.has_login ? '' : '<span class="badge badge-gray text-[10px]">ログインなし</span>'}
        <span class="block text-gray-500">${esc(r.project_name)}</span>
      </button>
      ${dashPhoneLine(r.shift_id, r.staff_phone, 'daily_report')}
    </div>`).join('')}</div>`
    : '<p class="text-xs text-gray-400">直近3日の日報はすべて提出されています <i class="fas fa-check text-emerald-500"></i></p>'

  // 今日から数日先までの人員不足の枠と、希望（仮）のままのシフト。押すとシフトボードのその週・その案件を開く（#299）
  const ahead = data.staffing_ahead || { short_roles: [], requested_shifts: [] }
  const aheadHtml = `
    <h4 class="text-xs font-bold text-gray-600 mb-1">人員不足の枠 <span class="badge ${ahead.short_role_count ? 'badge-red' : 'badge-green'}">${ahead.short_role_count ? `${Number(ahead.short_role_count)}件・${Number(ahead.short_headcount)}名分` : 'なし'}</span></h4>
    ${ahead.short_roles.length ? `<div class="space-y-1 max-h-48 overflow-y-auto mb-3">${ahead.short_roles.map(r => `
      <button type="button" class="w-full text-left rounded-lg bg-red-50 px-2 py-1 text-xs hover:opacity-80" data-action="openBoardAt" data-date="${esc(r.work_date)}" data-project-id="${Number(r.project_id)}" data-short="1">
        <span class="text-gray-500">${md(r.work_date)} ${esc(formatShiftTime(r.start_time, r.end_time))}</span>
        <span class="font-bold text-gray-800 ml-1">${esc(r.project_name)}</span> ${esc(r.role_name)}
        <span class="block text-gray-600">確定 ${Number(r.filled)}/${Number(r.headcount)}名（<span class="text-red-600 font-bold">${Number(r.shortage)}名不足</span>）${r.requested ? `・希望（仮）${Number(r.requested)}名` : ''}${r.applicants ? `・<span class="text-blue-700">未対応の応募 ${Number(r.applicants)}件</span>` : ''}</span>
      </button>`).join('')}</div>` : '<p class="text-xs text-gray-400 mb-3">必要人数に足りない枠はありません</p>'}
    <h4 class="text-xs font-bold text-gray-600 mb-1">希望（仮）のままのシフト <span class="badge ${ahead.requested_shifts.length ? 'badge-yellow' : 'badge-green'}">${ahead.requested_shifts.length ? ahead.requested_shifts.length + (ahead.requested_more ? '件以上' : '件') : 'なし'}</span></h4>
    ${ahead.requested_shifts.length ? `<div class="space-y-1 max-h-40 overflow-y-auto">${ahead.requested_shifts.map(s => `
      <button type="button" class="w-full text-left rounded-lg bg-amber-50 px-2 py-1 text-xs hover:opacity-80" data-action="openBoardAt" data-date="${esc(s.work_date)}" data-project-id="${Number(s.project_id)}">
        <span class="text-gray-500">${md(s.work_date)} ${esc(formatShiftTime(s.start_time, s.end_time))}</span>
        <span class="font-bold text-gray-800 ml-1">${esc(s.staff_name)}</span> <span class="text-gray-500">${esc(s.project_name)}</span>
      </button>`).join('')}</div>` : '<p class="text-xs text-gray-400">確定を待っているシフトはありません</p>'}`

  const photoChanged = data.photo_required_changed
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5 flex-wrap gap-2">
      <div>
        <h2 class="text-xl font-bold text-gray-900">管理者ダッシュボード</h2>
        <p class="text-sm text-gray-500">${dayjs(data.today).format('YYYY年M月D日')} — 今日見るべきこと・対応すべきこと</p>
      </div>
      <button class="btn btn-outline" onclick="renderDashboard()"><i class="fas fa-rotate"></i>更新</button>
    </div>

    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5" id="kpi-cards">
      ${kpi('本日の稼働予定', data.working_count + '名', 'fa-users', 'bg-blue-100 text-blue-600', data.working_shift_count !== data.working_count ? `シフト${Number(data.working_shift_count) || 0}件` : '')}
      ${kpi('本日の売上予定', yen(data.revenue_forecast), 'fa-yen-sign', 'bg-emerald-100 text-emerald-600', '請求の交通費・調整額を含む（精算と同じ計算）')}
      ${kpi('日報未提出（直近3日）', data.missing_daily_reports.length + '件', 'fa-file-circle-exclamation', data.missing_daily_reports.length ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-400',
        (data.missing_daily_reports.length ? '<button type="button" class="text-blue-600 hover:underline mr-2" data-action="dashScrollTo" data-target="dash-missing-reports">一覧を見る ↓</button>' : '')
        + (data.unchecked_daily_reports ? `<a href="#reports/unchecked=1" class="text-blue-600 hover:underline">未確認の日報 ${Number(data.unchecked_daily_reports)}件 →</a>` : ''))}
      ${kpi('要フォロースタッフ', data.follow_staff.length + '名', 'fa-hand-holding-heart', data.follow_staff.length ? 'bg-amber-100 text-amber-600' : 'bg-gray-100 text-gray-400')}
    </section>

    <section class="grid md:grid-cols-2 xl:grid-cols-4 gap-4 mb-1" id="unreported-section">
      ${alertList('<i class="fas fa-sun text-amber-500 mr-1"></i>未起床報告', un.wake_up, 'red', 'wake_up')}
      ${alertList('<i class="fas fa-person-walking-luggage text-blue-500 mr-1"></i>未出発報告', un.departure, 'yellow', 'departure')}
      ${alertList('<i class="fas fa-store text-purple-500 mr-1"></i>未入店報告', un.check_in, 'red', 'check_in')}
      ${alertList('<i class="fas fa-door-open text-gray-500 mr-1"></i>勤務終了・退店の未報告', un.work_end || [], 'yellow', 'work_end')}
    </section>
    <p class="text-[11px] text-gray-400 mb-5">予定の時刻を過ぎた人だけを出します（起床は開始の2時間前、出発は1時間前、入店は開始時刻、勤務終了・退店は終了の30分後。前日分を含む）。名前を押すと代理入力・報告用URLの発行ができます</p>

    <div class="grid lg:grid-cols-2 gap-4 mb-5">
      <section class="card p-4" id="todo-section">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-list-check text-blue-600 mr-1"></i>管理者ToDo（運営支援）</h3>
        <div id="dash-todos"></div>
      </section>

      <section class="card p-4" id="incident-section">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-bolt text-red-500 mr-1"></i>インシデント・クレーム（直近7日）</h3>
        <div class="space-y-2 max-h-80 overflow-y-auto">
          ${data.incidents.map(i => `
            <div class="p-2.5 rounded-lg bg-gray-50 border border-gray-100">
              <div class="flex items-center gap-2 text-xs mb-1">
                ${i.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
                ${i.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
                <span class="text-gray-500">${dayjs(i.work_date).format('M/D')}</span>
                <a href="#staff/${Number(i.staff_id)}" class="text-blue-600 hover:underline">${esc(i.staff_name)}</a>
                <span class="text-gray-400">${esc(i.project_name)}</span>
                <a href="#reports/date=${esc(i.work_date)}&project=${Number(i.project_id)}&staff=${Number(i.staff_id)}" class="text-blue-600 hover:underline ml-auto whitespace-nowrap">日報→</a>
              </div>
              <p class="text-xs text-gray-600">${esc((i.values && i.values.free) || '')}</p>
            </div>`).join('') || '<p class="text-sm text-gray-400 py-4 text-center">直近のインシデントはありません</p>'}
        </div>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-5">
      <section class="card p-4" id="dash-missing-reports">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-file-circle-exclamation text-red-500 mr-1"></i>日報未提出（直近3日）
          <span class="badge ${missing.length ? 'badge-red' : 'badge-green'} ml-1">${missing.length ? missing.length + '件' : 'なし'}</span></h3>
        ${missingHtml}
        <p class="text-[11px] text-gray-400 mt-2">名前を押すと、そのシフトの報告状況（日報の代理入力・報告用URL）を開きます</p>
      </section>
      <section class="card p-4" id="dash-ahead">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-calendar-week text-blue-600 mr-1"></i>今後の人員不足・未確定（${esc(dayjs(ahead.from || data.today).format('M/D'))}〜${esc(dayjs(ahead.to || data.today).format('M/D'))}）</h3>
        ${aheadHtml}
        <p class="text-[11px] text-gray-400 mt-2">押すとシフトボードでその週・その案件を開きます</p>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-5">
      <section class="card p-4">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-hand-holding-heart text-amber-500 mr-1"></i>要フォロースタッフ</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>氏名</th><th>離職リスク</th><th>評価</th><th>メモ</th><th></th></tr></thead>
          <tbody>
            ${data.follow_staff.map(s => `
              <tr>
                <td class="font-medium">${esc(s.name)}</td>
                <td>${RISK_BADGE[s.retention_risk] || ''}</td>
                <td>${Number(s.evaluation_score).toFixed(1)}</td>
                <td class="text-xs text-gray-500 max-w-[180px] truncate">${esc(s.memo || '')}</td>
                <td><a href="#staff/${s.staff_id}" class="text-blue-600 text-xs hover:underline">詳細</a></td>
              </tr>`).join('') || '<tr><td colspan="5" class="text-center text-gray-400 py-4">要フォロースタッフはいません</td></tr>'}
          </tbody>
        </table>
        </div>
      </section>

      <section class="card p-4">
        <h3 class="font-bold text-gray-800 mb-3"><i class="fas fa-briefcase text-blue-600 mr-1"></i>今月の案件別実績</h3>
        <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>案件</th><th>日報</th>${(data.performance_fields || []).map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead>
          <tbody>
            ${data.project_performance.map(p => `
              <tr>
                <td><a href="#projects/${Number(p.project_id)}" class="text-blue-600 hover:underline font-medium">${esc(p.project_name)}</a></td>
                <td>${p.report_count ? `<a href="#reports/from=${esc(data.month)}-01&to=${esc(data.today)}&project=${Number(p.project_id)}" class="text-blue-600 hover:underline">${Number(p.report_count)}</a>` : 0}</td>
                ${(data.performance_fields || []).map(f => `<td>${Number((p.values || {})[f.key]) || 0}</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
        ${data.performance_field_count > (data.performance_fields || []).length ? `<p class="text-[11px] text-gray-400 mt-2">日報の項目は先頭の${(data.performance_fields || []).length}件だけを出しています。すべての項目は<a href="#analytics" class="text-blue-600 hover:underline">実績分析</a>で見られます</p>` : ''}
      </section>
    </div>

    <section class="card p-4 mb-5" id="today-shifts">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 class="font-bold text-gray-800"><i class="fas fa-calendar-day text-blue-600 mr-1"></i>本日のシフト・報告状況</h3>
        <select id="dash-shift-project" class="inp w-auto text-xs" aria-label="案件で絞り込む"></select>
      </div>
      <div id="dash-shift-filters" class="flex flex-wrap gap-1.5 mb-3"></div>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>スタッフ</th><th>案件</th><th>時間</th><th>報告状況</th><th>操作</th></tr></thead>
          <tbody id="dash-shift-rows"></tbody>
        </table>
      </div>
      <p class="text-[11px] text-gray-400 mt-2">開始時刻・案件・氏名の順。報告の時刻を出し、遅刻は赤、位置情報のない入店は橙、予定の時刻を過ぎた未報告は赤枠で示します</p>
      ${(data.absent_shifts || []).length ? `
      <div class="mt-4" id="today-absent">
        <h4 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-user-xmark text-red-500 mr-1"></i>本日の欠勤（${data.absent_shifts.length}件）</h4>
        <div class="space-y-1.5">${data.absent_shifts.map(s => `
          <div class="flex items-center gap-2 flex-wrap p-2 rounded-lg bg-red-50 text-xs">
            <a href="#staff/${Number(s.staff_id)}" class="font-bold text-gray-800 hover:underline">${esc(s.staff_name)}</a>
            <span class="text-gray-500">${esc(s.project_name)}・${esc(s.start_time)}〜${esc(s.end_time)}</span>
            <button type="button" class="btn btn-outline text-xs ml-auto" data-action="findSubstitute" data-id="${Number(s.shift_id)}"><i class="fas fa-user-plus"></i>代わりを探す</button>
          </div>`).join('')}</div>
      </div>` : ''}
    </section>

    <section class="card p-3 flex items-center justify-between flex-wrap gap-2" id="dash-photo-setting">
      <p class="text-sm text-gray-700"><i class="fas fa-camera text-blue-600 mr-1"></i>入店/退店報告の写真添付（会社全体）:
        <span class="badge ${data.photo_required_attendance ? 'badge-green' : 'badge-gray'}">${data.photo_required_attendance ? '必須' : '無効'}</span>
        ${photoChanged ? `<span class="text-[11px] text-gray-400 ml-1">最終変更 ${esc(dashDateTime(photoChanged.at))} ${esc(photoChanged.name || '')}</span>` : ''}</p>
      <div class="flex gap-3 text-xs">
        <button type="button" class="text-blue-600 underline" data-action="photoSkipSetting">写真を送れないときの扱い</button>
        <button type="button" class="text-blue-600 underline" data-action="photoRequiredSetting">設定を変更…</button>
      </div>
    </section>`
  drawDashShifts()
  DASH_TODOS.todos = data.todos || []
  DASH_TODOS.hidden = data.hidden_todos || []
  drawDashTodos()
  if (window.renderChatDashboardNotice) renderChatDashboardNotice()
}

// ---------- ダッシュボード: 本日のシフトの表（#348 #355 #488）----------
// 状態の絞り込み: 予定の時刻を過ぎた未報告あり・遅刻・位置不明・休憩中・ログインなし
const DASH_ONLY = {
  unreported: { label: '未報告あり', test: s => (s.overdue_types || []).length > 0 },
  late: { label: '遅刻', test: s => s.late_minutes > 0 || ['check_in', 'work_start'].some(t => (s.reports || {})[t]?.status === 'late') },
  no_location: { label: '位置不明', test: s => !!s.no_location },
  on_break: { label: '休憩中', test: s => !!s.on_break },
  no_login: { label: 'ログインなし', test: s => s.has_login === false },
}
// 報告ごとのチップ: 報告の時刻（日をまたいだら『翌』）と、遅刻・早退・位置不明・修正の申請中・予定を過ぎた未報告
function dashReportChip(s, t) {
  const r = (s.reports || {})[t]
  const label = esc(DASH_RS[t] || t)
  if (r) {
    const time = String(r.at || '').slice(11, 16)
    const nextDay = String(r.at || '').slice(0, 10) > String(s.work_date) ? '翌' : ''
    let cls = 'badge-green', note = ''
    if (r.status === 'late') { cls = 'badge-red'; note = r.late_minutes ? ` 遅刻${Number(r.late_minutes)}分` : ' 遅刻' }
    else if (r.status === 'no_location') { cls = 'bg-orange-100 text-orange-700'; note = ' 位置なし' }
    else if (Number(r.early_leave_minutes) > 0) { cls = 'badge-yellow'; note = ` 早退${Number(r.early_leave_minutes)}分` }
    return `<span class="badge ${cls} text-[10px]">${label} ${esc(nextDay + time)}${esc(note)}</span>`
  }
  if ((s.pending_types || []).includes(t)) return `<span class="badge badge-yellow text-[10px]" title="打刻修正の申請中">${label} 申請中</span>`
  if ((s.overdue_types || []).includes(t)) return `<span class="badge bg-white text-red-600 border border-red-300 text-[10px]" title="予定の時刻を過ぎても報告がありません">${label} 未報告</span>`
  return `<span class="badge badge-gray text-[10px]">${label}</span>`
}
function drawDashShifts() {
  const data = DASH_DATA; if (!data) return
  const body = document.getElementById('dash-shift-rows'); if (!body) return
  const all = data.shifts || []
  // 案件の選択肢（名前順）
  const projects = [...new Map(all.map(s => [String(s.project_id), s.project_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ja'))
  const sel = document.getElementById('dash-shift-project')
  sel.innerHTML = `<option value="">すべての案件（${all.length}件）</option>` + projects.map(([id, name]) => `<option value="${esc(id)}" ${DASH_FILTER.project === id ? 'selected' : ''}>${esc(name)}</option>`).join('')
  sel.onchange = () => { DASH_FILTER.project = sel.value; drawDashShifts() }
  const byProject = all.filter(s => !DASH_FILTER.project || String(s.project_id) === DASH_FILTER.project)
  const chip = (key, label, n) => `<button type="button" class="badge ${DASH_FILTER.only === key ? 'badge-blue ring-1 ring-blue-400' : 'badge-gray'} text-xs" data-action="dashShiftFilter" data-only="${esc(key)}">${esc(label)} ${Number(n)}</button>`
  document.getElementById('dash-shift-filters').innerHTML = chip('', 'すべて', byProject.length)
    + Object.entries(DASH_ONLY).map(([k, v]) => chip(k, v.label, byProject.filter(v.test).length)).join('')
  const only = DASH_ONLY[DASH_FILTER.only]
  const list = only ? byProject.filter(only.test) : byProject
  body.innerHTML = list.map(s => {
    const chips = (s.required_types || []).map(t => dashReportChip(s, t)).join(' ') || '<span class="text-xs text-gray-400">報告なし</span>'
    // 入店以降の報告があるシフト・確定済みのシフトは、ここから欠勤にしない（#221）
    const absentBtn = s.started ? '<span class="text-[11px] text-gray-400" title="入店以降の報告があるため、欠勤にできません">勤務の報告あり</span>'
      : s.settle_status === 'confirmed' ? '<span class="text-[11px] text-gray-400">確定済み</span>'
      : `<button type="button" class="text-xs text-red-600 hover:underline" data-action="markAbsent" data-id="${Number(s.shift_id)}">欠勤にする</button>`
    const tel = String(s.staff_phone || '').replace(/[^0-9+]/g, '')
    return `<tr>
      <td><a href="#staff/${Number(s.staff_id)}" class="text-blue-600 hover:underline font-medium">${esc(s.staff_name)}</a>
        ${tel ? `<a href="tel:${esc(tel)}" class="text-gray-400 hover:text-blue-600 ml-0.5" title="${esc(s.staff_phone)} に電話"><i class="fas fa-phone text-[11px]"></i></a>` : ''}
        ${s.staff_unavailable ? '<span class="badge badge-red text-[10px]" title="退職・停止・取引終了などで、今は割り当てられないスタッフです">退職など</span>' : ''}
        ${s.contact ? `<a href="#consult/${Number(s.contact.consultation_id)}" class="badge badge-blue text-[10px]" title="${esc(s.contact.category_label + ': ' + (s.contact.excerpt || ''))}">連絡あり</a>` : ''}
        ${s.late_minutes > 0 ? `<span class="badge badge-red text-[10px]">遅刻 ${Number(s.late_minutes)}分</span>` : ''}
        ${s.early_leave_minutes > 0 ? `<span class="badge badge-yellow text-[10px]">早退 ${Number(s.early_leave_minutes)}分</span>` : ''}
        ${s.on_break ? '<span class="badge badge-purple text-[10px]">休憩中</span>' : ''}
        ${dashLoginBadges(s)}</td>
      <td class="text-xs">${esc(s.project_name)}</td>
      <td class="text-xs whitespace-nowrap">${s.carried_over ? `<span class="badge badge-purple text-[10px]">前日から継続</span><br>${esc(dayjs(s.work_date).format('M/D'))} ` : ''}${esc(formatShiftTime(s.start_time, s.end_time))}</td>
      <td><div class="flex flex-wrap gap-1 min-w-[12rem]">${chips}</div></td>
      <td class="whitespace-nowrap">
        <button type="button" class="text-xs text-blue-600 hover:underline mr-2" data-action="dashShiftReport" data-id="${Number(s.shift_id)}">${s.has_login === false ? '代理入力・URL' : '報告状況'}</button>
        ${absentBtn}
      </td>
    </tr>`
  }).join('') || `<tr><td colspan="5" class="text-center text-gray-400 py-4">${all.length ? '条件に合うシフトはありません' : '本日のシフトはありません'}</td></tr>`
}
delegate('dashShiftFilter', el => { DASH_FILTER.only = el.dataset.only || ''; drawDashShifts() })
// KPI カードなどから、ダッシュボードの中の一覧へ移る
delegate('dashScrollTo', el => {
  const t = document.getElementById(el.dataset.target || '')
  if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' })
})
// 電話したことをフォロー履歴（種別: 電話・完了）に残す（#343）
delegate('dashCallLog', el => {
  const s = DASH_SHIFTS.get(Number(el.dataset.id)); if (!s || !s.staff_id) return
  const what = DASH_CALL_LABEL[el.dataset.kind] || '報告'
  withSubmitLock(el, async () => {
    try {
      await axios.post('/api/admin/follow-logs', { staff_id: s.staff_id, follow_type: 'phone', status: 'done', related_project_id: s.project_id || null,
        content: `${what}がないため電話（${dayjs(s.work_date).format('M/D')} ${formatShiftTime(s.start_time, s.end_time)} ${s.project_name || ''}）` })
    } catch (e) { showApiError(e, '記録できませんでした'); return }
    el.removeAttribute('data-action')
    el.innerHTML = '<i class="fas fa-check mr-0.5"></i>記録しました'
    toast('フォロー履歴に電話の記録を追加しました')
  })
})

// ---------- ダッシュボード: 管理者ToDo（#487）----------
// 『対応済み』『あとで（明日まで）』で ToDo を隠す。隠した ToDo は下にたたんで出し、だれがいつ隠したかを示して元に戻せる。
// サーバーは件数・最新の ID（mark）が増えたら、隠した ToDo をもう一度出す
const DASH_TODOS = { todos: [], hidden: [] }
function dashTodoLink(t) {
  const href = t.href || (t.staff_id ? '#staff/' + Number(t.staff_id) : '')
  // #dash-〜 はダッシュボードの中の一覧（人員不足など）。画面を移らずにそこへ移る
  if (/^#dash-[a-z-]+$/.test(href)) return `<button type="button" class="text-xs text-blue-600 whitespace-nowrap hover:underline" data-action="dashScrollTo" data-target="${esc(href.slice(1))}">${esc(t.link_label || '詳細→')}</button>`
  return href ? `<a href="${esc(href)}" class="text-xs text-blue-600 whitespace-nowrap hover:underline">${esc(t.link_label || '詳細→')}</a>` : ''
}
function drawDashTodos() {
  const box = document.getElementById('dash-todos'); if (!box) return
  const fmt = v => esc(dayjs(String(v || '').replace(' ', 'T')).format('M/D HH:mm'))
  box.innerHTML = `
    <div class="space-y-2 max-h-80 overflow-y-auto">
      ${DASH_TODOS.todos.map(t => `
        <div class="flex items-start gap-2.5 p-2.5 rounded-lg ${t.level === 'high' ? 'bg-red-50' : 'bg-amber-50'}">
          <i class="fas ${t.level === 'high' ? 'fa-circle-exclamation text-red-500' : 'fa-triangle-exclamation text-amber-500'} mt-0.5"></i>
          <div class="flex-1 min-w-0">
            <p class="text-sm ${t.level === 'high' ? 'text-red-800' : 'text-amber-800'}">${esc(t.text)}</p>
            <div class="flex gap-3 mt-1">
              ${(t.actions || []).includes('done') ? `<button type="button" class="text-[11px] text-gray-600 hover:underline" data-action="dashTodoDone" data-key="${esc(t.key)}"><i class="fas fa-check mr-0.5"></i>${t.follow_id ? 'フォローを完了にする' : '対応済み'}</button>` : ''}
              ${(t.actions || []).includes('snooze') ? `<button type="button" class="text-[11px] text-gray-600 hover:underline" data-action="dashTodoSnooze" data-key="${esc(t.key)}"><i class="fas fa-clock mr-0.5"></i>あとで（明日まで）</button>` : ''}
            </div>
          </div>
          ${dashTodoLink(t)}
        </div>`).join('') || '<p class="text-sm text-gray-400 py-4 text-center">対応すべきタスクはありません <i class="fas fa-check text-emerald-500"></i></p>'}
    </div>
    ${DASH_TODOS.hidden.length ? `<details class="mt-3">
      <summary class="text-xs text-gray-500 cursor-pointer">対応済み・あとでにした ToDo（${DASH_TODOS.hidden.length}件）</summary>
      <div class="space-y-1.5 mt-2 max-h-60 overflow-y-auto">
        ${DASH_TODOS.hidden.map(t => {
          const d = t.dismissed || {}
          return `<div class="flex items-start gap-2 p-2 rounded-lg bg-gray-50 text-xs">
            <div class="flex-1 min-w-0">
              <p class="text-gray-600">${esc(t.text)}</p>
              <p class="text-[11px] text-gray-400 mt-0.5">${d.action === 'done' ? '対応済み' : `あとで（${fmt(d.until_at)}まで）`}・${esc(d.user_name || '-')}・${fmt(d.created_at)}</p>
            </div>
            ${dashTodoLink(t)}
            <button type="button" class="text-[11px] text-blue-600 hover:underline whitespace-nowrap" data-action="dashTodoRestore" data-key="${esc(t.key)}">元に戻す</button>
          </div>`
        }).join('')}
      </div>
    </details>` : ''}`
}
// 隠す（action: done / snooze）。フォロー記録の ToDo の『対応済み』は、そのフォロー記録を完了にする（期日の ToDo は記録が完了になれば出なくなる）
async function dashTodoDismiss(el, action) {
  const t = DASH_TODOS.todos.find(x => x.key === el.dataset.key); if (!t) return
  await withSubmitLock(el, async () => {
    let res
    try {
      if (action === 'done' && t.follow_id) {
        await axios.put('/api/admin/follow-logs/' + Number(t.follow_id), { status: 'done' })
        DASH_TODOS.todos = DASH_TODOS.todos.filter(x => x !== t)
        toast('フォロー記録を完了にしました'); drawDashTodos(); return
      }
      res = (await axios.post('/api/admin/dashboard/todos', { key: t.key, mark: t.mark, action })).data
    } catch (e) { showApiError(e, 'ToDo を更新できませんでした'); return }
    DASH_TODOS.todos = DASH_TODOS.todos.filter(x => x !== t)
    DASH_TODOS.hidden.unshift({ ...t, dismissed: { action, until_at: res.until_at, user_name: res.user_name, created_at: res.created_at } })
    toast(action === 'done' ? '対応済みにしました' : '明日まで表示しません')
    drawDashTodos()
  })
}
delegate('dashTodoDone', el => dashTodoDismiss(el, 'done'))
delegate('dashTodoSnooze', el => dashTodoDismiss(el, 'snooze'))
delegate('dashTodoRestore', el => {
  const t = DASH_TODOS.hidden.find(x => x.key === el.dataset.key); if (!t) return
  withSubmitLock(el, async () => {
    try { await axios.delete('/api/admin/dashboard/todos?' + new URLSearchParams({ key: t.key })) } catch (e) { showApiError(e, '元に戻せませんでした'); return }
    DASH_TODOS.hidden = DASH_TODOS.hidden.filter(x => x !== t)
    const { dismissed, ...rest } = t
    DASH_TODOS.todos.push(rest)
    DASH_TODOS.todos.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1))
    toast('ToDo に戻しました'); drawDashTodos()
  })
})

// ---------- ダッシュボード: 欠勤・代わりの手配・報告状況 ----------
// シフトの状態を変える。入店以降の報告があるシフトを欠勤にするときは、サーバーが確認を求める（need_force）ので、
// 理由を示して確認できたら force を付けて送り直す（#221）。成功したらサーバーの応答、取りやめたら false。エラーは呼び出し元へ投げる
async function putShiftStatus(shiftId, status, force) {
  try {
    const res = await axios.put('/api/admin/shifts/' + shiftId, force ? { status, force: true } : { status })
    return res.data || {}
  } catch (e) {
    const d = e.response && e.response.status === 409 ? e.response.data : null
    if (d && d.need_force && !force) {
      if (!confirm(`${(d.warnings || []).join('\n')}\nこのまま変更しますか？`)) return false
      return putShiftStatus(shiftId, status, true)
    }
    throw e
  }
}
// 欠勤にする。押す前に最新の報告を確かめ、入店以降の報告があれば時刻を示して確認する（#221）。成功したら代わりの候補を出す（#216）
async function markAbsent(shiftId, button) {
  const s = DASH_SHIFTS.get(shiftId); if (!s) return
  // 報告の確認中も含めてボタンを止める（二度押しで確認が2回出ないように）
  await withSubmitLock(button, async () => {
    let started = null
    try {
      const { data } = await axios.get(`/api/admin/shifts/${shiftId}/report-status`)
      started = (data.reports || []).filter(r => ['check_in', 'work_start', 'break_start', 'break_end', 'work_end', 'check_out'].includes(r.report_type))
        .sort((a, b) => String(a.reported_at).localeCompare(String(b.reported_at)))[0] || null
    } catch (e) { /* 確かめられなくても、通常の確認で続ける */ }
    const head = `${s.staff_name}さん（${s.project_name} ${s.start_time}〜${s.end_time}）を欠勤にしますか？\n欠勤のシフトは精算（支払・請求）の対象から外れます。`
    const msg = started ? `${DASH_RS[started.report_type] || started.report_type}の報告が ${String(started.reported_at).slice(11, 16)} にあります（勤務した記録があります）。\n${head}` : head
    if (!confirm(msg)) return
    // 報告の時刻を示して確認したときは、そのまま確認済み（force）で送る
    let res
    try {
      res = await putShiftStatus(shiftId, 'absent', !!started)
      if (!res) return
    } catch (e) { showApiError(e, '欠勤にできませんでした'); return }
    toast('欠勤として登録しました')
    // 欠勤のシフトの承認待ちの打刻修正は承認できないので、却下が必要なことを知らせる（#70）
    if (res && res.pending_corrections) alert(`このシフトには承認待ちの打刻修正が${Number(res.pending_corrections)}件あります。\n欠勤のシフトの申請は承認できないため、打刻修正の画面で却下してください。`)
    await renderDashboard()
    // 前日から継続のシフトは再取得後の「本日の欠勤」に入らないので、手元の情報で候補を開く
    if (!DASH_SHIFTS.has(shiftId)) DASH_SHIFTS.set(shiftId, { ...s, status: 'absent' })
    openSubstitute(shiftId)
  })
}
delegate('markAbsent', el => markAbsent(Number(el.dataset.id), el))

// 欠勤にしたシフトの代わりの候補（枠のあるシフト: シフトボードの候補 API。枠のないシフト: シフトボードの該当日へ）
async function openSubstitute(shiftId) {
  const s = DASH_SHIFTS.get(shiftId); if (!s) return
  const head = `<h3 class="font-bold text-lg mb-1">代わりのスタッフを探す</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(dayjs(s.work_date).format('M/D'))} ${esc(s.start_time)}〜${esc(s.end_time)}・${esc(s.project_name)}（欠勤: ${esc(s.staff_name)}）</p>`
  const boardBtn = `<button type="button" class="btn btn-outline w-full mt-2 text-sm" data-action="openBoardAt" data-date="${esc(s.work_date)}" data-project-id="${Number(s.project_id)}"><i class="fas fa-table-cells"></i>シフトボードでこの日を開く</button>`
  if (!s.slot_role_id) {
    modal(`${head}<p class="text-sm text-gray-600">このシフトは募集枠に入っていないため、候補の一覧を出せません。シフトボードで代わりのシフトを登録してください。</p>${boardBtn}
      <button type="button" class="btn btn-outline w-full mt-2 text-sm" onclick="closeModal()">閉じる</button>`)
    return
  }
  let data
  try { data = (await axios.get('/api/admin/shift-board/candidates?slot_role_id=' + Number(s.slot_role_id))).data } catch (e) { showApiError(e, '候補を読み込めませんでした'); return }
  const list = (data.candidates || []).filter(c => c.staff_id !== s.staff_id)
  modal(`${head}
    <p class="text-[11px] text-gray-400 mb-2">空きのある人・同じ開催場所や案件の経験がある人から順に並べています</p>
    <div class="max-h-80 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
      ${list.map(c => `<label class="flex items-center gap-2 px-2 py-1.5 text-sm ${c.busy || c.ng ? 'bg-red-50' : ''}">
        <input type="radio" name="sub-staff" value="${Number(c.staff_id)}">
        <span class="flex-1 min-w-0"><span class="font-bold">${esc(c.name)}</span>
          <span class="block text-[11px] text-gray-500">${c.busy ? `<span class="text-red-600">${esc((c.busy_detail || []).join('、'))}</span>` : '<span class="text-emerald-600">空き</span>'}${c.ng ? '<span class="text-red-600 ml-1">NG</span>' : ''}${c.on_leave ? '<span class="text-amber-600 ml-1">休職中</span>' : ''}
            ・この場所 ${Number(c.site_count) || 0}回・この案件 ${Number(c.project_count) || 0}回</span></span>
      </label>`).join('') || '<p class="p-3 text-sm text-gray-400">候補がいません</p>'}
    </div>
    <button type="button" class="btn btn-primary w-full mt-3" data-action="assignSubstitute" data-id="${Number(shiftId)}">代打として割り当てる</button>
    ${boardBtn}
    <button type="button" class="btn btn-outline w-full mt-2 text-sm" onclick="closeModal()">あとで探す</button>`)
}
delegate('findSubstitute', el => openSubstitute(Number(el.dataset.id)))

// 選んだスタッフを、欠勤のシフトと同じ枠の役割に代打（substitute）で割り当てる。重複・NG などは確認のうえ続ける
async function assignSubstitute(shiftId, button) {
  const s = DASH_SHIFTS.get(shiftId); if (!s) return
  const picked = document.querySelector('input[name="sub-staff"]:checked')
  if (!picked) { toast('スタッフを選択してください'); return }
  const send = (force) => axios.post(`/api/admin/shift-slots/roles/${Number(s.slot_role_id)}/assign`, { staff_ids: [Number(picked.value)], status: 'substitute', ...(force ? { force: true } : {}) })
  await withSubmitLock(button, async () => {
    let data
    try {
      data = (await send(false)).data
    } catch (e) {
      const d = e.response && e.response.data
      if (!(d && d.need_force)) { showApiError(e, '割り当てに失敗しました'); return }
      if (!confirm((d.warnings || []).join('\n') + '\n\nこのまま割り当てますか？')) return
      try { data = (await send(true)).data } catch (e2) { showApiError(e2, '割り当てに失敗しました'); return }
    }
    if (!(data.shift_ids || []).length) { toast((data.warnings || []).join('\n') || '割り当てられませんでした'); return }
    closeModal(); toast('代打として割り当てました'); renderDashboard()
  })
}
delegate('assignSubstitute', el => assignSubstitute(Number(el.dataset.id), el))

// シフトボードを、その日の週・その案件の絞り込みで開く
delegate('openBoardAt', el => {
  const d = dayjs(el.dataset.date)
  if (window.__boardState) {
    window.__boardState.from = d.subtract((d.day() + 6) % 7, 'day').format('YYYY-MM-DD')
    window.__boardState.projectIds = [Number(el.dataset.projectId)]
    window.__boardState.clientId = ''
    // 人員不足の枠から開いたときは『不足のみ』で開く。それ以外（希望（仮）のシフトなど）は絞り込みを外す（#299）
    window.__boardState.onlyShort = el.dataset.short === '1'
  }
  closeModal()
  if (location.hash === '#shifts') route(); else location.hash = 'shifts'
})

// シフトの報告状況（代理入力・報告用URLの発行）をモーダルで開く（public/static/staff-lifecycle.js の renderShiftReportPanel）
delegate('dashShiftReport', el => {
  const id = Number(el.dataset.id)
  const s = DASH_SHIFTS.get(id) || {}
  modal(`<h3 class="font-bold text-lg mb-1">${esc(s.staff_name || '')}</h3>
    <p class="text-xs text-gray-500 mb-3">${s.work_date ? esc(dayjs(s.work_date).format('M/D')) + ' ' : ''}${esc(s.start_time || '')}〜${esc(s.end_time || '')}・${esc(s.project_name || '')}</p>
    <div id="shift-report-panel" class="mb-3"><p class="text-xs text-gray-400">読み込み中…</p></div>
    <div class="flex gap-2">
      ${s.staff_id ? `<a class="btn btn-outline flex-1 text-xs" href="#staff/${Number(s.staff_id)}" onclick="closeModal()">スタッフ詳細</a>` : ''}
      ${s.status !== 'absent' ? `<button type="button" class="btn btn-outline flex-1 text-xs" data-action="corrNew" data-shift-id="${id}" title="このシフトの打刻の修正・打刻漏れの追加を、管理者として申請します">打刻を修正</button>` : ''}
      <button type="button" class="btn btn-outline flex-1 text-xs" onclick="closeModal(); renderDashboard()">閉じて更新</button>
    </div>`)
  if (window.renderShiftReportPanel) renderShiftReportPanel(id)
})

// ============ スタッフ一覧 ============
// 一覧の検索・絞り込み・並べ替え（#197 #433 #537）。
// 状態の絞り込み（仮登録・要フォローなど）はすべてを満たす人、区分は選んだどれかに当たる人を出す。
// 選んだ条件は STAFF_LIST に持ち、詳細から戻っても同じ条件・同じスクロール位置で出す（タブを閉じるまで保つ）
let staffCache = []
const STAFF_LIST_KEY = 'admin.staffList'
const STAFF_CACHE_MS = 60 * 1000
const STAFF_LIST = Object.assign({ q: '', states: [], types: [], merged: false, retired: false, dormant: '', sort: 'staff_id', dir: 1 }, (() => {
  try { return JSON.parse(sessionStorage.getItem(STAFF_LIST_KEY) || '{}') || {} } catch { return {} }
})())
if (!Array.isArray(STAFF_LIST.states)) STAFF_LIST.states = []
if (!Array.isArray(STAFF_LIST.types)) STAFF_LIST.types = []
let staffCacheAt = 0, staffListScroll = null, staffListIds = []
// 何かを保存・変更したら、次に一覧を開くときに読み直す（一覧の値が古いままにならないように）
axios.interceptors.response.use(r => {
  if (r && r.config && r.config.method && r.config.method.toLowerCase() !== 'get') staffCacheAt = 0
  return r
})
function saveStaffListState() {
  const { q, states, types, merged, retired, dormant, sort, dir } = STAFF_LIST
  try { sessionStorage.setItem(STAFF_LIST_KEY, JSON.stringify({ q, states, types, merged, retired, dormant, sort, dir })) } catch { }
}
// 検索用に文字をそろえる（全角英数→半角、大文字→小文字、ひらがな→カタカナ）
function searchNorm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
}
// 空白で区切った語をすべて含むか。電話番号は、ハイフンの有無にかかわらず数字だけでも探せる
function matchesKeyword(q, values) {
  const words = searchNorm(q).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = searchNorm(values.filter(v => v != null).join(' '))
  const digits = text.replace(/[^0-9]/g, '')
  return words.every(w => text.includes(w) || (/^[0-9-]+$/.test(w) && w.replace(/-/g, '').length >= 3 && digits.includes(w.replace(/-/g, ''))))
}
const STAFF_STATE_FILTERS = [['provisional', '仮登録'], ['follow', '要フォロー'], ['risk', '離職リスク'], ['noreport', '本日未入店'], ['lowscore', '評価3未満']]
const STAFF_STATE_TEST = {
  provisional: s => s.is_provisional, follow: s => s.follow_flag, risk: s => s.retention_risk && s.retention_risk !== 'low',
  noreport: s => s.today_shift && !s.today_checkin, lowscore: s => Number(s.evaluation_score) > 0 && Number(s.evaluation_score) < 3,
}
// 最終稼働からの日数で休眠の人を探す（#433。最終稼働は、確定・代打のシフトの今日までの日付）
const STAFF_DORMANT = [['', '最終稼働: すべて'], ['30', '30日以上稼働なし'], ['60', '60日以上稼働なし'], ['90', '90日以上稼働なし'], ['never', '稼働したことがない']]
const RISK_ORDER = { low: 0, mid: 1, high: 2 }
const STAFF_SORT = {
  staff_id: s => Number(s.staff_id), code: s => staffCodeLabel(s) || null, name: s => searchNorm(s.kana || s.name),
  month_days: s => Number(s.month_days || 0), month_seiyaku: s => Number(s.month_seiyaku || 0), evaluation_score: s => Number(s.evaluation_score || 0),
  retention_risk: s => RISK_ORDER[s.retention_risk] ?? 0, last_work_date: s => s.last_work_date || null, last_report_date: s => s.last_report_date || null,
}
const isRetiredStaff = s => s.employment_status === 'retired'
function staffEmpBadge(s) {
  const st = s.employment_status || 'working'
  const cls = st === 'retired' ? 'badge-gray' : st === 'leave' ? 'badge-yellow' : st === 'preboarding' ? 'badge-purple' : 'badge-green'
  return `<span class="badge ${cls}">${esc(STAFF_EMP_STATUS_LABEL[st] || '在職中')}</span>${s.status === 'suspended' && st !== 'retired' ? ' <span class="badge badge-gray" title="ログインを停止中">停止</span>' : ''}`
}
function filteredStaff() {
  const L = STAFF_LIST
  let list = L.merged ? staffCache.filter(s => s.merged_into_staff_id) : staffCache.filter(s => !s.merged_into_staff_id)
  if (!L.merged && !L.retired) list = list.filter(s => !isRetiredStaff(s))
  for (const k of L.states) if (STAFF_STATE_TEST[k]) list = list.filter(STAFF_STATE_TEST[k])
  if (L.types.length) list = list.filter(s => L.types.includes(s.affiliation_type))
  if (L.dormant === 'never') list = list.filter(s => !s.last_work_date)
  else if (L.dormant) {
    const limit = dayjs(todayJSTStr()).subtract(Number(L.dormant), 'day').format('YYYY-MM-DD')
    list = list.filter(s => !s.last_work_date || s.last_work_date <= limit)
  }
  if (L.q.trim()) list = list.filter(s => matchesKeyword(L.q, [s.name, s.kana, s.phone, staffCodeLabel(s), s.global_staff_code, s.skills, s.work_area, s.affiliation, s.owner_company_name]))
  const key = STAFF_SORT[L.sort] || STAFF_SORT.staff_id
  const blank = v => v == null || v === ''
  // 値の無い行（最終稼働なし等）は、並べる向きにかかわらず後ろに出す
  return list.map(s => [key(s), s]).sort((a, b) => {
    if (blank(a[0]) || blank(b[0])) return (blank(a[0]) ? 1 : 0) - (blank(b[0]) ? 1 : 0) || (a[1].staff_id - b[1].staff_id)
    return (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * L.dir || (a[1].staff_id - b[1].staff_id)
  }).map(x => x[1])
}

async function renderStaff(opts = {}) {
  const fresh = staffCache.length && staffCacheAt && Date.now() - staffCacheAt < STAFF_CACHE_MS && !opts.reload
  if (!fresh) {
    loading()
    const { data } = await axios.get('/api/admin/staff')
    staffCache = data.staff; staffCacheAt = Date.now()
  }
  drawStaffTable()
  // 詳細から戻ったときは、開いたときのスクロール位置に戻す
  if (staffListScroll != null) { const y = staffListScroll; staffListScroll = null; requestAnimationFrame(() => window.scrollTo(0, y)) }
}
delegate('reloadStaffList', () => renderStaff({ reload: true }))

// filter を渡すと（以前の呼び出し方）、その1つの条件だけで表示する
function drawStaffTable(filter) {
  if (typeof filter === 'string') {
    Object.assign(STAFF_LIST, { states: STAFF_STATE_TEST[filter] ? [filter] : [], types: AFF_TYPE_LABEL[filter] ? [filter] : [], merged: filter === 'merged', dormant: '' })
    saveStaffListState()
  }
  const L = STAFF_LIST
  const chip = (on, attrs, label) => `<button type="button" class="btn ${on ? 'btn-primary' : 'btn-outline'} text-xs" ${attrs}>${label}</button>`
  const th = (k, label) => `<th class="cursor-pointer select-none whitespace-nowrap" data-action="sortStaff" data-key="${k}" title="クリックで並べ替え">${label}${L.sort === k ? `<i class="fas fa-caret-${L.dir > 0 ? 'up' : 'down'} ml-1 text-blue-600"></i>` : ''}</th>`
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">スタッフマスタ <span class="text-sm font-normal text-gray-400" id="staff-count"></span></h2>
      <div class="flex gap-2 flex-wrap">
        <button class="btn btn-outline" data-action="reloadStaffList" title="最新の情報に読み直す" aria-label="読み直す"><i class="fas fa-rotate"></i></button>
        <button class="btn btn-outline" onclick="showRosterFieldSettings()"><i class="fas fa-sliders"></i>必須項目の設定</button>
        <button class="btn btn-outline" onclick="showQuickRegister && showQuickRegister()"><i class="fas fa-bolt"></i>仮登録（氏名・電話のみ）</button>
        <button class="btn btn-primary" onclick="showAddRoster()"><i class="fas fa-user-plus"></i>新規追加</button>
      </div>
    </div>
    <div class="card p-3 mb-4 space-y-2" id="staff-filters">
      <div class="flex gap-2 flex-wrap items-center">
        <input id="staff-q" class="inp text-sm flex-1 min-w-[220px]" placeholder="氏名・フリガナ・電話・番号・スキル・エリア・所属で検索" value="${esc(L.q)}">
        <select id="staff-dormant" class="inp text-sm w-auto">${STAFF_DORMANT.map(([k, v]) => `<option value="${k}" ${L.dormant === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" id="staff-retired" ${L.retired ? 'checked' : ''} ${L.merged ? 'disabled' : ''}>退職者を含む</label>
        ${staffCache.some(s => s.merged_into_staff_id) ? `<label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" id="staff-merged" ${L.merged ? 'checked' : ''}>統合済みだけを表示</label>` : ''}
        ${L.q || L.states.length || L.types.length || L.dormant || L.merged ? '<button type="button" class="text-xs text-blue-600 hover:underline" data-action="clearStaffFilter">条件をクリア</button>' : ''}
      </div>
      <div class="flex gap-1.5 flex-wrap items-center">
        <span class="text-[11px] text-gray-400 w-10">状態</span>
        ${STAFF_STATE_FILTERS.map(([k, v]) => chip(L.states.includes(k), `data-action="toggleStaffFilter" data-group="states" data-key="${k}"`, v)).join('')}
        <span class="text-[11px] text-gray-400">（選んだ条件をすべて満たす人）</span>
      </div>
      <div class="flex gap-1.5 flex-wrap items-center">
        <span class="text-[11px] text-gray-400 w-10">区分</span>
        ${Object.entries(AFF_TYPE_LABEL).map(([k, v]) => chip(L.types.includes(k), `data-action="toggleStaffFilter" data-group="types" data-key="${k}"`, esc(v))).join('')}
        <span class="text-[11px] text-gray-400">（選んだどれかに当たる人）</span>
      </div>
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr>${th('code', '番号')}${th('name', '氏名')}<th>在籍</th><th>所属区分</th><th>所属案件</th>${th('month_days', '今月稼働')}${th('month_seiyaku', '今月成約')}${th('evaluation_score', '評価')}${th('retention_risk', '離職リスク')}<th>要フォロー</th>${th('last_work_date', '最終稼働')}${th('last_report_date', '最終日報')}</tr></thead>
        <tbody id="staff-rows"></tbody>
      </table>
    </div>`
  let timer = null
  document.getElementById('staff-q').addEventListener('input', ev => {
    clearTimeout(timer)
    timer = setTimeout(() => { STAFF_LIST.q = ev.target.value; saveStaffListState(); drawStaffRows() }, 200)
  })
  document.getElementById('staff-dormant').addEventListener('change', ev => { STAFF_LIST.dormant = ev.target.value; saveStaffListState(); drawStaffTable() })
  document.getElementById('staff-retired').addEventListener('change', ev => { STAFF_LIST.retired = ev.target.checked; saveStaffListState(); drawStaffRows() })
  const merged = document.getElementById('staff-merged')
  if (merged) merged.addEventListener('change', ev => { STAFF_LIST.merged = ev.target.checked; saveStaffListState(); drawStaffTable() })
  drawStaffRows()
}
window.drawStaffTable = drawStaffTable
function drawStaffRows() {
  const list = filteredStaff()
  staffListIds = list.map(s => Number(s.staff_id))
  const total = staffCache.filter(s => !s.merged_into_staff_id && !isRetiredStaff(s)).length
  document.getElementById('staff-count').textContent = `${list.length}名${list.length !== total ? `（在籍 ${total}名）` : ''}`
  document.getElementById('staff-rows').innerHTML = list.map(s => `
            <tr class="cursor-pointer${isRetiredStaff(s) ? ' opacity-60' : ''}" data-action="openStaffDetail" data-id="${Number(s.staff_id)}">
              <td class="text-gray-400">${esc(staffCodeLabel(s))}</td>
              <td class="font-medium text-blue-700">${esc(s.name)}${s.merged_into_staff_id ? ' <span class="badge badge-gray" title="別のスタッフに統合済み">統合済み</span>' : s.is_provisional ? ' <span class="badge badge-red" title="仮登録（氏名・電話のみ）。本登録で必須項目を入力してください">仮</span>' : ''}${s.kana ? `<div class="text-[11px] text-gray-400 font-normal">${esc(s.kana)}</div>` : ''}</td>
              <td class="whitespace-nowrap">${staffEmpBadge(s)}</td>
              <td>${affTypeBadge(s.affiliation_type)}${s.board_proposal_id ? ' <span class="badge badge-purple" title="案件掲示板の提案から取り込んだスタッフ"><i class="fas fa-clipboard-list"></i>掲示板経由</span>' : ''}<div class="text-[11px] text-gray-400 max-w-[160px] truncate">${esc(s.affiliation_type === 'linked_external' ? s.owner_company_name : (s.affiliation || ''))}</div></td>
              <td class="text-xs max-w-[200px] truncate">${esc(s.projects || '-')}</td>
              <td>${Number(s.month_days || 0)}日</td>
              <td class="font-bold">${Number(s.month_seiyaku || 0)}</td>
              <td>${Number(s.evaluation_score).toFixed(1)}</td>
              <td>${RISK_BADGE[s.retention_risk] || ''}</td>
              <td>${s.follow_flag ? '<span class="badge badge-red">要フォロー</span>' : '<span class="text-gray-300">-</span>'}</td>
              <td class="text-xs text-gray-500 whitespace-nowrap">${s.last_work_date ? esc(dayjs(s.last_work_date).format('YY/M/D')) : '-'}</td>
              <td class="text-xs text-gray-500 whitespace-nowrap">${s.last_report_date ? esc(dayjs(s.last_report_date).format('YY/M/D')) : '-'}</td>
            </tr>`).join('') || '<tr><td colspan="12" class="text-center text-gray-400 py-6">条件に合うスタッフはいません</td></tr>'
}
delegate('toggleStaffFilter', el => {
  const arr = STAFF_LIST[el.dataset.group]; const k = el.dataset.key
  if (!Array.isArray(arr)) return
  const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); else arr.push(k)
  STAFF_LIST.merged = false
  saveStaffListState(); drawStaffTable()
})
delegate('clearStaffFilter', () => {
  Object.assign(STAFF_LIST, { q: '', states: [], types: [], merged: false, dormant: '' })
  saveStaffListState(); drawStaffTable()
})
delegate('sortStaff', el => {
  const k = el.dataset.key
  // 数の列・日付の列は、初めに押したとき多い順・新しい順にする
  if (STAFF_LIST.sort === k) STAFF_LIST.dir = -STAFF_LIST.dir
  else { STAFF_LIST.sort = k; STAFF_LIST.dir = ['code', 'name'].includes(k) ? 1 : -1 }
  saveStaffListState(); drawStaffRows()
  document.querySelectorAll('[data-action="sortStaff"]').forEach(h => {
    const ic = h.querySelector('i'); if (ic) ic.remove()
    if (h.dataset.key === STAFF_LIST.sort) h.insertAdjacentHTML('beforeend', `<i class="fas fa-caret-${STAFF_LIST.dir > 0 ? 'up' : 'down'} ml-1 text-blue-600"></i>`)
  })
})
delegate('openStaffDetail', el => { staffListScroll = window.scrollY; location.hash = 'staff/' + Number(el.dataset.id) })
// スタッフ詳細の『前の人・次の人』（一覧で絞り込んだ順。#537）
function staffNeighbors(sid) {
  const i = staffListIds.indexOf(Number(sid))
  return i < 0 ? null : { prev: staffListIds[i - 1] || null, next: staffListIds[i + 1] || null, pos: i + 1, total: staffListIds.length }
}

// スタッフ番号には空いている番号（#424）を入れておく（手で変えることもできる）
window.showAddStaff = async function () {
  let next = null
  try { next = (await axios.get('/api/admin/roster/next-code')).data } catch { next = null }
  modal(`
    <h3 class="font-bold text-lg mb-4">スタッフ登録</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">スタッフ番号 *</label><input id="ns-code" class="inp" placeholder="st021" value="${esc(next ? next.code : '')}">
          ${next && next.last_code ? `<p class="text-[11px] text-gray-400 mt-1">空いている番号です（最後の番号: ${esc(next.last_code)}）</p>` : ''}</div>
        <div><label class="text-sm text-gray-600 block mb-1">氏名 *</label><input id="ns-name" class="inp" placeholder="山田 太郎"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">初期パスワード *</label><input id="ns-pass" class="inp" autocomplete="new-password" placeholder="8文字以上"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">メール</label><input id="ns-email" class="inp"></div>
        <div><label class="text-sm text-gray-600 block mb-1">電話</label><input id="ns-phone" class="inp"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">スキル（カンマ区切り）</label><input id="ns-skills" class="inp" placeholder="MNP,接客"></div>
      <div><label class="text-sm text-gray-600 block mb-1">経歴</label><input id="ns-career" class="inp"></div>
      <div><label class="text-sm text-gray-600 block mb-1">稼働可能エリア</label><input id="ns-area" class="inp" placeholder="東京23区"></div>
      <div id="ns-dup"></div>
      <button class="btn btn-primary w-full" data-action="addStaff">登録する</button>
    </div>`)
}
// 送信中はボタンを無効にする（二度押しで同じ人が2人登録されないように。#223）
delegate('addStaff', (el) => withSubmitLock(el, () => addStaff(false)))
delegate('addStaffForce', (el) => withSubmitLock(el, () => addStaff(true)))

window.addStaff = async function (force) {
  try {
    await axios.post('/api/admin/staff', {
      user_code: document.getElementById('ns-code').value.trim(),
      name: document.getElementById('ns-name').value.trim(),
      password: document.getElementById('ns-pass').value,
      email: document.getElementById('ns-email').value, phone: document.getElementById('ns-phone').value,
      skills: document.getElementById('ns-skills').value, career: document.getElementById('ns-career').value,
      work_area: document.getElementById('ns-area').value, force: !!force,
    })
    closeModal(); toast('スタッフを登録しました'); renderStaff()
  } catch (e) {
    const d = e.response && e.response.data
    // 同じ人と思われるスタッフがいる（#223）: 一覧を出し、別の人なら登録を続けられるようにする
    const box = document.getElementById('ns-dup')
    if (d && d.need_force && d.matches && box && window.samePersonListHtml) {
      box.innerHTML = `<div class="p-3 rounded-lg bg-amber-50 text-xs text-amber-800"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>同じ人と思われるスタッフが登録済みです</p>
        <ul class="space-y-1 mb-2">${samePersonListHtml(d.matches)}</ul>
        <button class="btn btn-outline text-xs" data-action="addStaffForce">別の人として登録する</button></div>`
      return
    }
    if (d && d.suggested_code) { document.getElementById('ns-code').value = d.suggested_code; toast(`スタッフ番号が使われています。空いている番号（${d.suggested_code}）を入れました`); return }
    toast((d && d.error) || '登録に失敗しました')
  }
}

// ============ スタッフ詳細 ============
const GENDER_LABEL_ADMIN = { male: '男性', female: '女性', other: 'その他', unspecified: '回答しない' }
function genderOptions(v) {
  return `<option value="">-</option>` + Object.entries(GENDER_LABEL_ADMIN).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')
}
// 基本情報欄の上部に出す「どこで編集できるか」の案内
function basicInfoNotice(p) {
  if (p.merged_into_staff_id) return `<div class="text-xs bg-gray-100 text-gray-700 rounded-lg p-2 mb-3" id="staff-merged-notice"><i class="fas fa-code-merge mr-1"></i>このスタッフは別のスタッフに統合済みです（シフト・勤怠・日報などは統合先に移しました）。<a class="text-blue-600 underline" href="#staff/${p.merged_into_staff_id}">統合先を開く</a></div>`
  if (p.affiliation_type === 'own_employee') return `<div class="text-xs bg-emerald-50 text-emerald-700 rounded-lg p-2 mb-3"><i class="fas fa-id-card mr-1"></i>自社雇用スタッフです。通勤可能時間・稼働開始可能日・稼働可能エリア・スキル・経歴・PRポイント・備考（業務側の情報）はこの画面の「編集」から編集できます。氏名・生年月日・最寄駅・在籍状況などの労務側の情報は従業員管理から編集してください。</div>`
  if (p.affiliation_type === 'linked_external') return `<div class="text-xs bg-blue-50 text-blue-700 rounded-lg p-2 mb-3"><i class="fas fa-lock mr-1"></i>基本情報は所属元「${esc(p.owner_company_name || '')}」が管理しています（閲覧のみ）。管理者メモ（「編集」から）・稼働先追記項目は記入できます。</div>`
  if (!p.can_edit_in_master) return `<div class="text-xs bg-gray-50 text-gray-600 rounded-lg p-2 mb-3"><i class="fas fa-lock mr-1"></i>このスタッフの基本情報は編集できません。</div>`
  if (p.is_provisional) return `<div class="text-xs bg-red-50 text-red-700 rounded-lg p-2 mb-3"><i class="fas fa-bolt mr-1"></i>仮登録のスタッフです（氏名・電話のみで稼働できます）。すでに登録のある人（他社連携など）と同じ人なら「区分・登録状態」の「既存のスタッフに統合」を、別の人なら「本登録」を使ってください。</div>`
  return ''
}

// ---------- スタッフマスタ: 業務側項目（経歴テーブル・PRポイント・備考） ----------
// 備考列は廃止。以前入力した備考は業務内容の末尾に引き継いで編集する
function careerRowHtml(r = {}) {
  return `<tr class="career-row align-top">
    <td class="p-1"><input type="text" class="inp text-xs cr-from cr-month w-full bg-white" value="${esc(r.from || '')}" placeholder="選択" readonly></td>
    <td class="p-1"><input type="text" class="inp text-xs cr-to cr-month w-full bg-white" value="${esc(r.to || '')}" placeholder="選択" readonly></td>
    <td class="p-1"><input class="inp text-xs cr-company w-full" value="${esc(r.company || '')}" placeholder="勤務先・店舗など"></td>
    <td class="p-1"><textarea rows="3" class="inp text-xs cr-work w-full" style="resize:vertical" placeholder="業務内容">${esc([r.work, r.note].filter(Boolean).join('\n'))}</textarea></td>
    <td class="p-1 text-center"><button type="button" class="btn btn-outline text-xs px-2" title="この行を削除" onclick="removeCareerRow(this)"><i class="fas fa-trash text-red-500"></i></button></td>
  </tr>`
}
// 開始・終了はカレンダー（年月選択）から選ぶ。flatpickr が読めない環境では type=month にフォールバック
function initCareerPickers(root) {
  const els = (root || document).querySelectorAll('input.cr-month:not([data-fp])')
  els.forEach(el => {
    el.dataset.fp = '1'
    if (!window.flatpickr || !window.monthSelectPlugin) { el.type = 'month'; el.readOnly = false; return }
    flatpickr(el, {
      locale: (flatpickr.l10ns && flatpickr.l10ns.ja) || 'default', disableMobile: true, allowInput: false,
      plugins: [new monthSelectPlugin({ shorthand: false, dateFormat: 'Y-m', altFormat: 'Y年n月' })],
      altInput: true, altInputClass: 'inp text-xs w-full bg-white cursor-pointer',
      onReady: (_, __, fp) => {
        // 選択を取り消せるよう「クリア」ボタンを付ける
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'クリア'
        btn.className = 'text-xs text-gray-500 hover:text-red-500 w-full py-1 border-t border-gray-100'
        btn.onclick = () => { fp.clear(); fp.close() }
        fp.calendarContainer.appendChild(btn)
      },
    })
  })
}
window.addCareerRow = function () {
  const tb = document.getElementById('staff-career-rows')
  tb.insertAdjacentHTML('beforeend', careerRowHtml())
  initCareerPickers(tb.lastElementChild)
}
window.removeCareerRow = function (btn) {
  const tb = document.getElementById('staff-career-rows')
  btn.closest('tr').remove()
  if (!tb.children.length) { tb.insertAdjacentHTML('beforeend', careerRowHtml()); initCareerPickers(tb) }
}
function collectCareerRows() {
  return [...document.querySelectorAll('#staff-career-rows .career-row')].map(tr => ({
    from: tr.querySelector('.cr-from').value.trim(), to: tr.querySelector('.cr-to').value.trim(),
    company: tr.querySelector('.cr-company').value.trim(), work: tr.querySelector('.cr-work').value.trim(), note: '',
  })).filter(r => r.from || r.to || r.company || r.work)
}
const fmtYm = v => v ? String(v).replace(/^(\d{4})-(\d{2})$/, (_, y, m) => `${y}年${Number(m)}月`) : ''
// 経歴テーブル（閲覧用）。テーブル未入力で旧形式の経歴テキストがあればそれを表示する
function careerTableReadonly(p) {
  const rows = Array.isArray(p.career_rows) ? p.career_rows : []
  if (!rows.length) return `<p class="text-xs text-gray-600 whitespace-pre-wrap">${esc(p.career || '-')}</p>`
  return `<div class="overflow-x-auto"><table class="tbl text-xs" id="staff-career-table">
    <thead><tr><th class="whitespace-nowrap">開始</th><th class="whitespace-nowrap">終了</th><th>勤務</th><th>業務内容</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="whitespace-nowrap">${esc(fmtYm(r.from)) || '-'}</td><td class="whitespace-nowrap">${esc(fmtYm(r.to)) || '-'}</td>
      <td>${esc(r.company || '')}</td><td class="whitespace-pre-wrap">${esc(r.work || '')}${r.note ? `<span class="text-gray-400">（${esc(r.note)}）</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
}
function staffBusinessSectionHtml(p, edBiz) {
  const rows = Array.isArray(p.career_rows) ? p.career_rows : []
  // 旧形式（テキスト）の経歴しか無い場合は、1行目の業務内容に引き継いで表示する（保存するとテーブル形式になる）
  const initRows = rows.length ? rows : (p.career ? [{ work: p.career }] : [{}])
  const label = (icon, text, extra = '') => `<p class="text-xs text-gray-500 mb-1"><i class="fas ${icon} text-gray-400 mr-1"></i>${text}${extra}</p>`
  return `
    <div class="mt-4 pt-3 border-t border-gray-100 space-y-4" id="staff-business-info">
      <div id="staff-career-block">
        <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
          ${label('fa-briefcase', '経歴')}
          ${edBiz ? `<button type="button" class="btn btn-outline text-xs" id="staff-career-add" onclick="addCareerRow()"><i class="fas fa-plus"></i>行を追加</button>` : ''}
        </div>
        ${edBiz ? `
        ${!rows.length && p.career ? '<p class="text-xs text-amber-600 mb-1"><i class="fas fa-circle-info mr-1"></i>以前のテキスト形式の経歴を1行目に表示しています。開始・終了・勤務などに分けて入力し直してください。</p>' : ''}
        <div class="overflow-x-auto"><table class="w-full text-xs min-w-[640px]" style="table-layout:fixed" id="staff-career-table">
          <colgroup><col style="width:120px"><col style="width:120px"><col style="width:24%"><col><col style="width:44px"></colgroup>
          <thead><tr class="text-gray-500 text-left">
            <th class="p-1 font-normal">開始</th><th class="p-1 font-normal">終了</th>
            <th class="p-1 font-normal">勤務</th><th class="p-1 font-normal">業務内容</th><th class="p-1"></th>
          </tr></thead>
          <tbody id="staff-career-rows">${initRows.map(careerRowHtml).join('')}</tbody>
        </table></div>
        <p class="text-xs text-gray-400 mt-1">開始・終了はクリックしてカレンダーから選択します。終了が空欄の場合は「現在まで」として扱います。</p>` : careerTableReadonly(p)}
      </div>
      <div>
        ${label('fa-star', '経験・スキル・人柄・PRポイント等')}
        ${edBiz ? `<textarea id="staff-pr-points" rows="4" class="inp text-xs w-full">${esc(p.pr_points || '')}</textarea>`
          : `<p class="text-xs text-gray-600 whitespace-pre-wrap">${esc(p.pr_points || '-')}</p>`}
      </div>
      <div>
        ${label('fa-comment-dots', '備考')}
        ${edBiz ? `<textarea id="staff-remarks" rows="3" class="inp text-xs w-full">${esc(p.remarks || '')}</textarea>`
          : `<p class="text-xs text-gray-600 whitespace-pre-wrap">${esc(p.remarks || '-')}</p>`}
      </div>
    </div>`
}

// 他社連携の行の LK- コードは、連携のために作った内部のコードで、自社ではログインに使えないためスタッフ番号として出さない（#569）
function staffCodeLabel(s) { return String(s.user_code || '').startsWith('LK-') ? '' : (s.user_code || '') }
// ---------- スタッフ詳細: ヘッダー・基本情報カード（編集/保存時はここだけ差し替えて、画面全体を再読み込みしない） ----------
const STAFF_EMP_STATUS_LABEL = { working: '在職中', leave: '休職中', retired: '退職', preboarding: '入社予定' }
function staffDetailHeaderHtml(sid, p) {
  const EMP_STATUS_LABEL = STAFF_EMP_STATUS_LABEL
  const nb = staffNeighbors(sid)
  return `
    ${nb && nb.total > 1 ? `<div class="flex items-center gap-2 mb-2 text-xs text-gray-500">
      <span>一覧の ${nb.pos} / ${nb.total} 人目</span>
      ${nb.prev ? `<a href="#staff/${nb.prev}" class="btn btn-outline text-xs"><i class="fas fa-chevron-left"></i>前の人</a>` : ''}
      ${nb.next ? `<a href="#staff/${nb.next}" class="btn btn-outline text-xs">次の人<i class="fas fa-chevron-right"></i></a>` : ''}
    </div>` : ''}
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <a href="#staff" class="btn btn-outline" title="スタッフ一覧に戻る（絞り込みはそのまま）"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold text-gray-900">${esc(p.name)} <span class="text-sm text-gray-400 font-normal">${esc(p.user_role === 'roster_only' ? '' : staffCodeLabel(p))}</span></h2>
        <div class="flex gap-2 mt-1 flex-wrap">
          ${affTypeBadge(p.affiliation_type)}
          ${p.board_source ? `<a href="#board/t${p.board_source.thread_id}" class="badge badge-purple" title="案件掲示板のやり取りを開く"><i class="fas fa-clipboard-list mr-1"></i>掲示板経由（提案: ${esc(p.board_source.proposer_company_name)}）</a>` : ''}
          ${p.merged_into_staff_id ? '<span class="badge badge-gray"><i class="fas fa-code-merge mr-1"></i>統合済み</span>' : p.is_provisional ? '<span class="badge badge-red"><i class="fas fa-bolt mr-1"></i>仮登録</span>' : ''}
          ${p.global_staff_code ? `<span class="badge badge-gray" title="企業間連携用のスタッフID（恒久固定）"><i class="fas fa-fingerprint mr-1"></i>${esc(p.global_staff_code)}</span>` : ''}
          <span class="badge ${p.employment_status === 'retired' ? 'badge-gray' : p.employment_status === 'leave' ? 'badge-yellow' : p.employment_status === 'preboarding' ? 'badge-purple' : 'badge-green'}">${EMP_STATUS_LABEL[p.employment_status] || '在職中'}</span>
          ${RISK_BADGE[p.retention_risk]}
          ${p.follow_flag ? '<span class="badge badge-red">要フォロー</span>' : ''}
          <span class="badge ${Number(p.evaluation_score) > 0 ? 'badge-blue' : 'badge-gray'}">${Number(p.evaluation_score) > 0 ? '評価 ' + Number(p.evaluation_score).toFixed(1) : '未評価'}</span>
        </div>
      </div>
      ${p.affiliation_type === 'own_employee' ? `<a class="btn btn-outline" href="#employees/${sid}"><i class="fas fa-id-card"></i>従業員管理</a>` : ''}
      ${p.link_shareable ? `<button class="btn btn-outline" onclick="showShareQr(${sid})"><i class="fas fa-qrcode"></i>連携用QR</button>` : ''}
      <button class="btn btn-outline" onclick="showSkillSheet(${sid})"><i class="fas fa-file-export"></i>スキルシート作成</button>
      <button class="btn btn-primary" data-action="showFollowModal" data-id="${sid}" data-name="${esc(p.name)}"><i class="fas fa-plus"></i>フォロー記録</button>
    </div>
`
}
function staffBasicCardHtml(sid, p, affData, editing) {
  const EMP_STATUS_LABEL = STAFF_EMP_STATUS_LABEL
  // 編集できる範囲（APIでも同じ判定で制御している）
  //  canBase: 基本情報（氏名・所属・最寄駅・在籍状況等）… 取引先所属・スキルシートのみ・日雇い・個人事業主
  //  canBiz : 業務側項目（通勤・稼働開始・エリア・スキル・経歴・PR・備考）… 他社連携以外の全区分
  //  管理者メモは統合済み以外の全スタッフで編集できる
  const canBase = !!p.can_edit_in_master, canBiz = !!p.can_edit_business, canEdit = !p.merged_into_staff_id
  const ed = editing && canBase
  const edBiz = editing && canBiz
  const bi = (label, html) => `<div class="flex items-start gap-2 min-w-0"><dt class="w-28 text-gray-400 shrink-0 pt-1">${label}</dt><dd class="flex-1 min-w-0 pt-1">${html}</dd></div>`
  return `
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 class="text-sm font-bold text-gray-700">基本情報 <span class="text-xs font-normal text-gray-400">（スタッフマスタ共有項目）</span></h3>
          <div class="flex gap-2 flex-wrap">
            ${p.affiliation_type === 'own_employee' && !p.merged_into_staff_id ? `<a class="btn btn-outline text-xs" href="#employees/${sid}"><i class="fas fa-id-card"></i>労務情報は従業員管理で編集</a>` : ''}
            ${!canEdit ? '' : editing
              ? `<button class="btn btn-outline text-xs" id="staff-edit-cancel" onclick="cancelStaffEdit(${sid})">キャンセル</button>
                 <button class="btn btn-primary text-xs" id="staff-basic-save" onclick="saveStaffBasicInfo(${sid})"><i class="fas fa-floppy-disk"></i>保存</button>`
              : `<button class="btn btn-primary text-xs" id="staff-edit" onclick="startStaffEdit(${sid})"><i class="fas fa-pen"></i>編集</button>`}
          </div>
        </div>
        ${basicInfoNotice(p)}
        ${editing ? `<div class="text-xs bg-blue-50 text-blue-700 rounded-lg p-2 mb-3" id="staff-editing-notice"><i class="fas fa-pen mr-1"></i>編集中です。${canBase ? '' : canBiz ? '入力欄になっている業務側の項目と管理者メモを編集できます。' : '管理者メモを編集できます。'}変更後は「保存」を押してください。</div>` : ''}
        <dl class="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          ${bi('氏名', ed ? `<input id="staff-name" class="inp text-xs" value="${esc(p.name || '')}">` : esc(p.name))}
          ${bi('フリガナ', ed ? `<input id="staff-kana" class="inp text-xs" value="${esc(p.kana || '')}">` : esc(p.kana || '-'))}
          ${bi('性別', ed ? `<select id="staff-gender" class="inp text-xs">${genderOptions(p.gender)}</select>` : esc(GENDER_LABEL_ADMIN[p.gender] || '-'))}
          ${bi('生年月日', ed ? `<input type="date" id="staff-dob" class="inp text-xs" value="${esc(p.date_of_birth || '')}">` : esc(p.date_of_birth || '-'))}
          ${bi('年齢', p.age != null ? p.age + '歳' : '-')}
          ${bi('在籍状況', `<span class="badge ${p.employment_status === 'retired' ? 'badge-gray' : p.employment_status === 'leave' ? 'badge-yellow' : p.employment_status === 'preboarding' ? 'badge-purple' : 'badge-green'}">${EMP_STATUS_LABEL[p.employment_status] || '在職中'}</span>${p.retired_at ? ` <span class="text-xs ${p.employment_status === 'retired' ? 'text-gray-500' : 'text-amber-600'}">${p.employment_status === 'retired' ? '退職日' : '退職予定日'} ${esc(p.retired_at)}</span>` : ''}`)}
          ${bi('所属会社名', ed && p.affiliation_type === 'partner_manual' ? `<input list="affiliation-list" id="staff-affiliation" class="inp text-xs" value="${esc(p.affiliation || '')}">`
              : ed ? `<input id="staff-affiliation" class="inp text-xs" value="${esc(p.affiliation || '')}">` : esc(p.affiliation || '-'))}
          ${bi('所属先担当者名', ed ? `<input id="staff-affiliation-contact" class="inp text-xs" value="${esc(p.affiliation_contact || '')}">` : esc(p.affiliation_contact || '-'))}
          ${p.affiliation_type === 'own_employee' ? bi('社員番号 / 所属', esc([p.employee_number, p.department, p.job_title].filter(Boolean).join(' / ') || '-')) : ''}
          ${bi('電話番号', ed ? `<input id="staff-phone" class="inp text-xs" type="tel" inputmode="tel" maxlength="20" value="${esc(p.phone || '')}" data-orig="${esc(p.phone || '')}" placeholder="09012345678">`
              : `<span class="text-xs">${esc(p.affiliation_type === 'own_employee' ? (p.emp_phone || p.phone || '-') : (p.phone || '-'))}</span>${p.affiliation_type === 'own_employee' && editing ? '<span class="block text-[11px] text-gray-400">従業員管理の電話番号から変更します</span>' : ''}`)}
          ${p.affiliation_type === 'own_employee' ? bi('個人メール', `<span class="text-xs">${esc(p.emp_email || '-')}</span> <span class="text-[11px] text-gray-400">（従業員管理。通知には使いません）</span>`) : ''}
          ${staffLoginEmailHtml(p, editing)}
          ${bi('最寄駅', ed ? `<div class="flex gap-1"><input id="staff-station-line" placeholder="路線" class="inp text-xs" value="${esc(p.nearest_station_line || '')}"><input id="staff-station" placeholder="駅" class="inp text-xs" value="${esc(p.nearest_station || '')}"></div>`
              : esc([p.nearest_station_line, p.nearest_station].filter(Boolean).join(' ') || '-'))}
          ${bi('通勤可能時間', edBiz ? `<input type="number" min="0" max="1440" id="staff-commute" class="inp text-xs" value="${esc(p.commute_minutes ?? '')}" placeholder="分">` : (p.commute_minutes != null ? esc(p.commute_minutes) + '分' : '-'))}
          ${bi('稼働開始可能日', edBiz ? `<input type="date" id="staff-available-from" class="inp text-xs" value="${esc(p.available_from || '')}">` : esc(p.available_from || '-'))}
          ${bi('稼働可能エリア', edBiz ? `<input id="staff-work-area" class="inp text-xs" value="${esc(p.work_area || '')}">` : esc(p.work_area || '-'))}
          <div class="md:col-span-2">${bi('スキル', edBiz ? `<input id="staff-skills" class="inp text-xs" value="${esc(p.skills || '')}" placeholder="カンマ区切り（例: MNP,接客,クロージング）">`
              : `<span class="flex flex-wrap gap-1">${(p.skills || '').split(',').filter(Boolean).map(x => `<span class="badge badge-blue">${esc(x)}</span>`).join('') || '-'}</span>`)}</div>
        </dl>
        <datalist id="affiliation-list">${affData.affiliations.map(a => `<option value="${esc(a.affiliation_name)}">`).join('')}</datalist>

        ${staffBusinessSectionHtml(p, edBiz)}

        <div class="mt-4 pt-3 border-t border-gray-100 space-y-4" id="staff-memo-block">
          <div>
            <p class="text-xs text-gray-500 mb-1"><i class="fas fa-note-sticky text-gray-400 mr-1"></i>管理者メモ <span class="text-gray-400">（自社内のみ・連携先には共有されません）</span></p>
            ${editing ? `<textarea id="staff-memo" rows="3" class="inp text-xs w-full">${esc(p.memo || '')}</textarea>`
              : `<p class="text-xs text-gray-600 whitespace-pre-wrap" id="staff-memo-view">${esc(p.memo || '-')}</p>`}
            ${editing || !canEdit ? '' : `<div class="flex gap-2 mt-2 flex-wrap items-center">
              <button class="btn ${p.follow_flag ? 'btn-danger' : 'btn-outline'} text-xs" onclick="toggleFollow(${sid}, ${p.follow_flag ? 0 : 1})">
                ${p.follow_flag ? 'フォロー解除' : '要フォロー登録'}</button>
              <label class="text-xs text-gray-500 flex items-center gap-1" title="中・高にすると、ダッシュボードの要フォロースタッフと一覧の『離職リスク』に出ます">離職リスク
                <select class="inp text-xs w-auto" data-staff-risk="${sid}" data-orig="${esc(p.retention_risk || 'low')}">
                  ${[['low', '低'], ['mid', '中'], ['high', '高']].map(([k, v]) => `<option value="${k}" ${(p.retention_risk || 'low') === k ? 'selected' : ''}>${v}</option>`).join('')}
                </select></label>
            </div>`}
          </div>
          ${ed ? `
          <div class="pt-3 border-t border-gray-100">
            <p class="text-xs text-gray-500 mb-1"><i class="fas fa-person-walking-arrow-right text-gray-400 mr-1"></i>在籍状況</p>
            <div class="flex gap-2 flex-wrap items-center">
              <select id="staff-emp-status" class="inp text-sm w-40" data-orig="${esc(p.employment_status || 'working')}"
                onchange="document.getElementById('staff-retired-wrap').classList.toggle('hidden', this.value !== 'retired' && !document.getElementById('staff-retired-date').value)">
                ${Object.entries(EMP_STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${(p.employment_status || 'working') === k ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
              <span id="staff-retired-wrap" class="flex items-center gap-2 ${p.employment_status === 'retired' || p.retired_at ? '' : 'hidden'}">
                <span class="text-xs text-gray-500">退職日</span>
                <input type="date" id="staff-retired-date" class="inp text-sm w-44" value="${esc(p.retired_at || '')}" data-orig="${esc(p.retired_at || '')}">
              </span>
            </div>
            <p class="text-xs text-gray-400 mt-1">退職日に今日以降の日付を入れると「退職予定」になり、退職日の当日まではログインできます（翌日に退職へ切り替わります）。退職日から7年経過すると、出退勤記録・シフト・評価・やり取り履歴等が定期削除の対象になります</p>
          </div>` : ''}
        </div>
`
}
// ログイン用メール（users.email。パスワード再設定・通知の宛先。#207）。変更は確認メールを送り、本人が確認したときに切り替わる
function staffLoginEmailHtml(p, editing) {
  if (p.affiliation_type === 'linked_external' || p.affiliation_type === 'skillsheet_only') return ''
  const row = (html) => `<div class="flex items-start gap-2 min-w-0"><dt class="w-28 text-gray-400 shrink-0 pt-1">ログイン用メール</dt><dd class="flex-1 min-w-0 pt-1" id="staff-login-email-row">${html}</dd></div>`
  if (!p.has_own_login) return row('<span class="text-xs text-gray-400">ログインなし</span>')
  const pend = p.login_email_pending
  const pendHtml = pend ? `<span class="block text-xs mt-0.5"><span class="badge badge-yellow">確認待ち</span> ${esc(pend.email)} <span class="text-[11px] text-gray-400">（本人が確認メールのリンクを開くと切り替わります。期限 ${esc(dayjs(pend.expires_at).format('M/D HH:mm'))}）</span></span>` : ''
  if (editing && !p.merged_into_staff_id) {
    return row(`<input id="staff-login-email" class="inp text-xs" type="email" maxlength="254" autocomplete="off" value="${esc(p.email || '')}" data-orig="${esc(p.email || '')}" placeholder="例: taro@example.com">
      <span class="block text-[11px] text-gray-400">変更すると新しいアドレスに確認メールを送り、本人が確認したときに切り替わります。空欄で保存すると削除します</span>${pendHtml}`)
  }
  return row((p.email ? `<span class="text-xs">${esc(p.email)}</span>` : '<span class="text-xs text-red-600"><i class="fas fa-triangle-exclamation mr-1"></i>未登録（通知メール・パスワード再設定が使えません）</span>') + pendHtml)
}
// 直近に表示したスタッフ詳細のデータ（編集切替・保存後の部分再描画に使う）
let staffDetailState = null
function redrawStaffCard(editing) {
  const st = staffDetailState; if (!st) return
  const card = document.getElementById('staff-basic-info'); if (!card) return
  card.innerHTML = staffBasicCardHtml(st.sid, st.p, st.affData, editing)
  const hd = document.getElementById('staff-detail-header'); if (hd) hd.innerHTML = staffDetailHeaderHtml(st.sid, st.p)
  if (editing && st.p.can_edit_business) initCareerPickers(document.getElementById('staff-career-rows'))
}
// 保存後などに、画面をローディング表示にせずプロフィールだけ取り直して差し替える
async function refreshStaffProfile(sid) {
  const { data } = await axios.get('/api/admin/staff/' + sid)
  if (!staffDetailState || String(staffDetailState.sid) !== String(sid)) return
  staffDetailState.p = data.profile
  redrawStaffCard(false)
}
// スタッフ詳細は閲覧モードで開き、「編集」ボタンで区分に応じた項目だけ入力欄に切り替える
let staffEditingSid = null
window.startStaffEdit = function (sid) { staffEditingSid = String(sid); redrawStaffCard(true) }
window.cancelStaffEdit = function (sid) { staffEditingSid = null; redrawStaffCard(false) }
async function renderStaffDetail(sid, opts = {}) {
  if (!opts.keepEdit) staffEditingSid = null
  const editing = staffEditingSid === String(sid)
  loading()
  const [{ data }, { data: docData }, { data: affData }] = await Promise.all([
    axios.get('/api/admin/staff/' + sid),
    axios.get('/api/admin/staff/' + sid + '/documents'),
    axios.get('/api/admin/staff-affiliations'),
  ])
  const p = data.profile
  const evalRadar = data.evaluations[0]
  STAFF_EVALS = data.evaluations || []
  staffDetailState = { sid, p, affData }
  const edBiz = editing && !!p.can_edit_business
  $app.innerHTML = `
    <div id="staff-detail-header">${staffDetailHeaderHtml(sid, p)}</div>

    <div class="grid lg:grid-cols-3 gap-4 mb-4">
      <section class="card p-4 lg:col-span-2" id="staff-basic-info">
        ${staffBasicCardHtml(sid, p, affData, editing)}
      </section>

      <div class="space-y-4">
        <section class="card p-4" id="staff-files">
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-folder-open text-blue-500 mr-1"></i>ファイル</h3>
            <button class="btn btn-outline text-xs" onclick="openDocumentUpload('staff', ${sid})"><i class="fas fa-upload"></i>アップロード</button>
          </div>
          <div id="staff-documents-list">${documentListHtml(docData.documents, 'staff', sid)}</div>
        </section>

        <section class="card p-4" id="staff-evaluation">
          <div class="flex items-center gap-2 mb-3">
            <h3 class="text-sm font-bold text-gray-700">評価（${evalRadar ? esc(evalRadar.evaluation_period) : '-'}）</h3>
            <button class="btn btn-outline text-xs ml-auto" data-action="showEvaluationModal" data-id="${Number(sid)}"><i class="fas fa-plus"></i>評価を登録</button>
          </div>
          ${evalRadar ? `<canvas id="eval-chart" height="220"></canvas>${evalRadar.comment ? `<p class="text-xs text-gray-600 mt-2 whitespace-pre-wrap">${esc(evalRadar.comment)}</p>` : ''}` : '<p class="text-sm text-gray-400">評価データがありません</p>'}
          ${evaluationHistoryHtml(sid, data.evaluations)}
        </section>
      </div>
    </div>

    <div id="staff-shift-panel" class="mb-4"></div>

    <section class="card p-4 mb-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">月次実績推移 <span class="text-xs font-normal text-gray-400">（今月と前の2か月。日報のない月は0）</span></h3>
      <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>月</th><th>日数</th><th>MNP</th><th>PI</th><th>新規</th><th>光</th><th>成約</th></tr></thead>
        <tbody>${data.performance.map(m => `
          <tr class="${m.days ? '' : 'text-gray-400'}"><td>${esc(dayjs(m.ym + '-01').format('YYYY年M月'))}</td><td>${m.days}</td><td>${m.mnp}</td><td>${m.pi}</td><td>${m.shinki}</td><td>${m.hikari}</td><td class="font-bold">${m.seiyaku}</td></tr>`).join('') || '<tr><td colspan="7" class="text-gray-400 text-center py-3">データなし</td></tr>'}
        </tbody>
      </table>
      </div>
    </section>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-handshake-angle text-amber-500 mr-1"></i>フォロー履歴</h3>
        <div class="space-y-2 max-h-72 overflow-y-auto">
          ${data.follow_logs.map(f => `
            <div class="p-2.5 rounded-lg bg-gray-50">
              <div class="flex items-center gap-2 text-xs mb-1">
                <span class="badge badge-purple">${esc(FOLLOW_LABELS[f.follow_type] || f.follow_type)}</span>
                <span class="text-gray-400">${dayjs(f.created_at).format('M/D HH:mm')}</span>
                <span class="text-gray-500">${esc(f.manager_name || '')}</span>
                ${f.status === 'open' ? '<span class="badge badge-yellow">対応中</span>' : '<span class="badge badge-green">完了</span>'}
              </div>
              <p class="text-xs text-gray-700 whitespace-pre-wrap">${esc(f.content)}</p>
              ${f.next_action ? `<p class="text-xs text-blue-700 mt-1 whitespace-pre-wrap"><i class="fas fa-arrow-right mr-1"></i>${esc(f.next_action)}</p>` : ''}
            </div>`).join('') || '<p class="text-sm text-gray-400">フォロー履歴はありません</p>'}
        </div>
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3 flex items-center"><i class="fas fa-file-lines text-blue-500 mr-1"></i>日報履歴<a href="#reports/staff=${Number(sid)}" class="ml-auto text-xs font-normal text-blue-600 hover:underline">日報一覧で見る</a></h3>
        <div class="space-y-2 max-h-72 overflow-y-auto">
          ${data.reports.map(r => `
            <div class="p-2.5 rounded-lg bg-gray-50">
              <div class="flex items-center gap-2 text-xs mb-1">
                <span class="font-bold text-gray-700">${dayjs(r.work_date).format('M/D')}</span>
                <span class="text-gray-400">${esc(r.project_name)}</span>
                ${r.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
                ${r.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
              </div>
              <div class="flex flex-wrap gap-1">
                ${Object.entries(r.values).filter(([k, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `<span class="badge badge-gray">${esc(LABELS[k] || k)} ${esc(v)}</span>`).join('')}
              </div>
              ${r.values.free ? `<p class="text-xs text-gray-500 mt-1 whitespace-pre-wrap">${esc(r.values.free)}</p>` : ''}
            </div>`).join('') || '<p class="text-sm text-gray-400">日報履歴はありません</p>'}
        </div>
      </section>
    </div>

    <div id="roster-panels" class="grid lg:grid-cols-2 gap-4 mt-4 hidden"></div>
    <div id="roster-chat-panel" class="mt-4 hidden"></div>
    <div id="staff-lifecycle-panel" class="mt-4"></div>
    <div id="staff-rate-panel" class="mt-4"></div>

    <section class="card p-4 mt-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-clock text-gray-400 mr-1"></i>勤怠報告履歴（直近）</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>稼働日</th><th>種別</th><th>報告時刻</th><th>状態</th><th>位置情報</th></tr></thead>
          <tbody>${data.attendance.slice(0, 20).map(a => {
            const RL = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店' }
            return `<tr>
              <td>${dayjs(a.work_date).format('M/D')}</td>
              <td>${esc(RL[a.report_type] || a.report_type)}</td>
              <td>${dayjs(a.reported_at).format('HH:mm')}</td>
              <td>${a.status === 'late' ? '<span class="badge badge-red">遅延</span>' : a.status === 'no_location' ? '<span class="badge badge-yellow">位置不明</span>' : '<span class="badge badge-green">正常</span>'}</td>
              <td class="text-xs text-gray-400">${a.latitude ? Number(a.latitude).toFixed(4) + ', ' + Number(a.longitude).toFixed(4) : '-'}</td>
            </tr>`}).join('')}
          </tbody>
        </table>
      </div>
    </section>`

  // 今後のシフト・過去の稼働・NG指定（public/static/shift-board.js。#224 #204）
  if (window.renderStaffShiftPanel) renderStaffShiftPanel(sid, data)
  if (window.renderRosterPanels) renderRosterPanels(sid, p)
  if (window.renderRosterChatPanel) renderRosterChatPanel(sid, p)
  // スタッフ別の単価ルール（public/static/shift-board.js）
  if (window.renderStaffRatePanel) renderStaffRatePanel(sid, p)
  // 区分・登録状態・提出設定（public/static/staff-lifecycle.js）
  if (window.renderStaffLifecyclePanel) renderStaffLifecyclePanel(sid, p)
  if (edBiz) initCareerPickers(document.getElementById('staff-career-rows'))
  if (evalRadar) {
    new Chart(document.getElementById('eval-chart'), {
      type: 'radar',
      data: {
        labels: ['勤怠安定性', '報告正確性', '実績', 'クライアント評価', '成長意欲', '継続見込み'],
        datasets: [{
          data: [evalRadar.attendance_score, evalRadar.report_score, evalRadar.performance_score, evalRadar.client_score, evalRadar.growth_score, evalRadar.retention_score],
          backgroundColor: 'rgba(37,99,235,.15)', borderColor: '#2563eb', pointBackgroundColor: '#2563eb'
        }]
      },
      options: { scales: { r: { min: 0, max: 5, ticks: { stepSize: 1 } } }, plugins: { legend: { display: false } } }
    })
  }
}

// ---------- スタッフ評価（#164）: 期間（年月）ごとに6項目（1〜5）とコメント。同じ期間は上書き ----------
const EVAL_ITEMS = [['attendance_score', '勤怠安定性'], ['report_score', '報告正確性'], ['performance_score', '実績'], ['client_score', 'クライアント評価'], ['growth_score', '成長意欲'], ['retention_score', '継続見込み']]
let STAFF_EVALS = []
const evalAvg = e => Math.round(EVAL_ITEMS.reduce((s, [k]) => s + Number(e[k] || 0), 0) / EVAL_ITEMS.length * 10) / 10
function evaluationHistoryHtml(sid, list) {
  if (!list || !list.length) return ''
  return `<div class="mt-3 pt-3 border-t border-gray-100">
    <p class="text-xs font-bold text-gray-500 mb-1">推移（直近${list.length}件）</p>
    <table class="w-full text-xs">${list.map(e => `
      <tr class="border-b border-gray-50">
        <td class="py-1">${esc(e.evaluation_period || '-')}</td>
        <td class="py-1 font-bold">${evalAvg(e).toFixed(1)}</td>
        <td class="py-1 text-gray-400 truncate max-w-[80px]" title="${esc(e.evaluator_name || '')}">${esc(e.evaluator_name || '')}</td>
        <td class="py-1 text-right whitespace-nowrap">
          <button class="text-blue-600 hover:underline" data-action="showEvaluationModal" data-id="${Number(sid)}" data-eid="${Number(e.evaluation_id)}">編集</button>
          <button class="text-red-500 hover:underline ml-1" data-action="deleteEvaluation" data-id="${Number(sid)}" data-eid="${Number(e.evaluation_id)}" data-period="${esc(e.evaluation_period || '')}">削除</button></td>
      </tr>`).join('')}</table>
    <p class="text-[11px] text-gray-400 mt-1">総合評価は最新の期間の6項目の平均です</p>
  </div>`
}
delegate('showEvaluationModal', el => {
  const sid = Number(el.dataset.id)
  const cur = el.dataset.eid ? STAFF_EVALS.find(e => Number(e.evaluation_id) === Number(el.dataset.eid)) : null
  const period = cur ? cur.evaluation_period : dayjs().format('YYYY-MM')
  modal(`
    <h3 class="font-bold text-lg mb-3">${cur ? '評価の編集' : '評価を登録'}</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">評価の期間（年月） *</label><input type="month" id="ev-period" class="inp" value="${esc(period)}" ${cur ? 'readonly' : ''}></div>
      <div class="grid grid-cols-2 gap-2">${EVAL_ITEMS.map(([k, label]) => `
        <label class="text-sm text-gray-600">${label}
          <select id="ev-${k}" class="inp">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${Number(cur ? cur[k] : 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`).join('')}</div>
      <p class="text-[11px] text-gray-400">5: とても良い 〜 1: 課題が大きい。同じ期間の評価は上書きします</p>
      <div><label class="text-sm text-gray-600 block mb-1">コメント</label><textarea id="ev-comment" rows="3" class="inp" maxlength="1000">${esc(cur ? cur.comment || '' : '')}</textarea></div>
      <button class="btn btn-primary w-full" data-action="saveEvaluation" data-id="${sid}" data-edit="${cur ? '1' : ''}">保存する</button>
    </div>`)
})
delegate('saveEvaluation', el => withSubmitLock(el, async () => {
  const sid = Number(el.dataset.id)
  const period = document.getElementById('ev-period').value
  if (!/^\d{4}-\d{2}$/.test(period)) { toast('評価の期間（年月）を選んでください'); return }
  if (!el.dataset.edit && STAFF_EVALS.some(e => e.evaluation_period === period) && !confirm(`${period} の評価はすでにあります。上書きしますか？`)) return
  const body = { evaluation_period: period, comment: document.getElementById('ev-comment').value }
  for (const [k] of EVAL_ITEMS) body[k] = Number(document.getElementById('ev-' + k).value)
  try {
    await axios.post(`/api/admin/staff/${sid}/evaluations`, body)
    closeModal(); toast('評価を保存しました'); renderStaffDetail(sid)
  } catch (e) { showApiError(e, '評価を保存できませんでした') }
}))
delegate('deleteEvaluation', el => withSubmitLock(el, async () => {
  const sid = Number(el.dataset.id)
  if (!confirm(`${el.dataset.period} の評価を削除しますか？`)) return
  try {
    await axios.delete(`/api/admin/staff/${sid}/evaluations/${Number(el.dataset.eid)}`)
    toast('評価を削除しました'); renderStaffDetail(sid)
  } catch (e) { showApiError(e, '評価を削除できませんでした') }
}))

window.saveStaffMemo = async function (sid) {
  await axios.put('/api/admin/staff/' + sid, { memo: document.getElementById('staff-memo').value })
  toast('メモを保存しました')
}
// 離職リスク（低・中・高）の変更（#381）。失敗したら選択を元に戻す
document.addEventListener('change', async (ev) => {
  const sel = ev.target && ev.target.closest ? ev.target.closest('select[data-staff-risk]') : null
  if (!sel) return
  const sid = Number(sel.dataset.staffRisk)
  sel.disabled = true
  try {
    await axios.put('/api/admin/staff/' + sid, { retention_risk: sel.value })
    sel.dataset.orig = sel.value
    toast('離職リスクを「' + ({ low: '低', mid: '中', high: '高' }[sel.value]) + '」にしました')
    if (staffDetailState && String(staffDetailState.sid) === String(sid)) await refreshStaffProfile(sid)
  } catch (e) {
    sel.value = sel.dataset.orig
    showApiError(e, '離職リスクを変更できませんでした')
  } finally { sel.disabled = false }
})
window.toggleFollow = async function (sid, flag) {
  await axios.put('/api/admin/staff/' + sid, { follow_flag: flag })
  toast(flag ? '要フォローに登録しました' : 'フォローを解除しました')
  if (staffDetailState && String(staffDetailState.sid) === String(sid)) await refreshStaffProfile(sid)
  else renderStaffDetail(sid)
}
// ============ 退職日・在籍状況の保存（スタッフ詳細・従業員管理で共通。#5 #34 #139） ============
function todayJSTStr() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) }
// 在籍状況と退職日の入力から、送る内容と確認の文言を決める。
//  - 退職日が今日以降なら「退職予定」: 退職日だけを登録し、当日まではログインできる（翌日に退職へ切り替わる）
//  - 在籍状況が退職以外で過去の退職日が残っているときは、退職日を消して在籍状況を戻す
function retirementBody(status, date, origDate) {
  const today = todayJSTStr()
  if (status === 'retired' && !date) return { error: '退職にする場合は退職日を入力してください' }
  if (date && date >= today) {
    return { body: { retired_at: date, employment_status: status === 'retired' ? 'retired' : status },
      confirm: date === origDate ? null : `退職予定日を ${date} で登録しますか？\n${date} まではログインでき、翌日に退職（ログイン停止）へ切り替わります。` }
  }
  if (status === 'retired') {
    return { body: { retired_at: date, employment_status: 'retired' },
      confirm: date === origDate ? null : `退職日を ${date} に設定しますか？\n本人はすぐにログインできなくなります。退職日から7年経過すると、出退勤記録・シフト・写真等が定期削除の対象になります。` }
  }
  if (date) {
    return { body: { retired_at: null, employment_status: status },
      confirm: `在籍状況を「${EMP_STATUS_LABEL[status] || status}」に戻すと、退職日 ${date} は消去されます。よろしいですか？` }
  }
  return { body: { retired_at: null, employment_status: status }, confirm: null }
}
// 保存する。退職日に確認が必要なとき（サーバーが confirm_required を返す: 7年以上前・1年以上前・入社日より前・
// 退職日より後にシフトがある）は、内容を見せて確認できたら確認済みとして送り直す。取りやめたら null を返す
// 退職日を設定するときは、退職日より後の今後のシフトを確認画面に出し、選べば保存の後にまとめて外す（#500）
async function putConfirmingRetiredAt(url, body, target) {
  const plan = await retireFutureShiftsPlan(url, target || body)
  if (plan === false) return null
  const res = await putRetiredAtOnce(url, body, target)
  if (res && plan && plan.release) {
    try {
      const { data } = await axios.post(`/api/admin/staff/${plan.sid}/release-future-shifts`, { from: plan.from, shift_ids: plan.shift_ids })
      toast(`今後のシフトを外しました（枠を空きに戻した ${data.removed}件・欠勤にした ${data.absent}件）`)
    } catch (e) { showApiError(e, '今後のシフトを外せませんでした。シフト管理から外してください') }
  }
  return res
}
// 確認の結果: null = 確認不要（退職日なし・今後のシフトなし）、false = 取りやめ、{ release } = 外すかどうか
async function retireFutureShiftsPlan(url, p) {
  const m = /\/api\/admin\/(?:staff|employees)\/(\d+)$/.exec(url)
  if (!m || !p || !p.retired_at) return null
  const d = new Date(p.retired_at + 'T00:00:00Z'); if (isNaN(d)) return null
  d.setUTCDate(d.getUTCDate() + 1)
  const from = d.toISOString().slice(0, 10) // 退職日の当日は稼働できるので、翌日以降を対象にする
  let data
  try { data = (await axios.get(`/api/admin/staff/${m[1]}/future-shifts`, { params: { from } })).data } catch { return null }
  if (!data.count && !data.linked_count) return null
  const ST = { confirmed: '確定', substitute: '代打', requested: '希望' }
  const list = data.shifts.slice(0, 5).map(s => `・${s.work_date} ${s.start_time}〜${s.end_time} ${s.project_name || ''}（${ST[s.status] || s.status}）`).join('\n')
  const linked = data.linked_count ? `\n連携先の企業にも、退職日より後のシフトが ${data.linked_count}件あります（連携先では割当の候補から外れます。企業間チャットで連絡してください）。` : ''
  if (!data.count) { alert(`退職日より後のシフトの確認${linked}`); return null }
  const msg = `退職日（${p.retired_at}）より後に、シフトが ${data.count}件あります。\n${list}${data.count > 5 ? `\nほか ${data.count - 5}件` : ''}${linked}\n\n`
    + 'OK: 保存して、これらのシフトを外す（枠は空きに戻します。勤怠などの記録があるシフトは欠勤にします）\nキャンセル: シフトをどうするか選び直す'
  if (confirm(msg)) return { release: true, sid: m[1], from: data.from, shift_ids: data.shifts.map(s => s.shift_id) }
  if (confirm('シフトはそのまま残して保存しますか？\n（残したシフトは、シフト管理・シフトボードから個別に外せます）')) return { release: false }
  return false
}
async function putRetiredAtOnce(url, body, target) {
  try {
    return await axios.put(url, body)
  } catch (e) {
    const d = e.response && e.response.data
    if (!(e.response && e.response.status === 409 && d && d.confirm_required)) throw e
    if (!confirm(d.error + '\n\nこの日付で保存しますか？')) return null
    ;(target || body).retired_at_confirmed = true
    return axios.put(url, body)
  }
}
window.setStaffRetiredAt = async function (sid, date) {
  const r = retirementBody(date ? 'retired' : 'working', date || '', null)
  if (r.error) { toast(r.error); return }
  if (date && r.confirm && !confirm(r.confirm)) return
  try {
    if (!(await putConfirmingRetiredAt('/api/admin/staff/' + sid, r.body))) return
    toast(date ? '退職日を設定しました' : '現役に戻しました')
    renderStaffDetail(sid)
  } catch (e) {
    toast((e.response && e.response.data && e.response.data.error) || '更新に失敗しました')
  }
}
window.setStaffEmploymentStatus = async function (sid, status) {
  try {
    await axios.put('/api/admin/staff/' + sid, { employment_status: status })
    toast('在籍状況を更新しました')
    renderStaffDetail(sid)
  } catch (e) {
    toast((e.response && e.response.data && e.response.data.error) || '更新に失敗しました')
  }
}
window.saveStaffBasicInfo = async function (sid) {
  // 編集モードの「保存」。画面に出ている入力欄（=区分ごとに編集できる項目）だけを送る
  //  - 基本項目（氏名・所属・最寄駅・在籍状況等）: 取引先所属・スキルシートのみ・日雇い・個人事業主のみ（自社雇用は従業員管理から）
  //  - 業務側項目（通勤・稼働開始・エリア・スキル・経歴・PR・備考）: 他社連携以外の全区分
  //  - 管理者メモ: 全スタッフ
  try {
    const val = id => { const el = document.getElementById(id); return el ? el.value : undefined }
    const body = { memo: val('staff-memo') }
    if (document.getElementById('staff-name')) Object.assign(body, {
      name: (val('staff-name') || '').trim(),
      kana: val('staff-kana'), gender: val('staff-gender'), date_of_birth: val('staff-dob') || null,
      affiliation: val('staff-affiliation'), affiliation_contact: val('staff-affiliation-contact'),
      nearest_station_line: val('staff-station-line'), nearest_station: val('staff-station'),
    })
    const st = document.getElementById('staff-emp-status')
    if (st) {
      const rd = document.getElementById('staff-retired-date')
      const status = st.value, retired = rd ? rd.value : '', origRetired = rd ? rd.dataset.orig : ''
      if (status !== st.dataset.orig || retired !== origRetired) {
        const r = retirementBody(status, retired, origRetired)
        if (r.error) { toast(r.error); return }
        if (r.confirm && !confirm(r.confirm)) return
        Object.assign(body, r.body)
      }
    }
    // 電話番号・ログイン用メールは、変えたときだけ送る（#123 #207）
    const ph = document.getElementById('staff-phone')
    if (ph && ph.value.trim() !== (ph.dataset.orig || '')) {
      body.phone = ph.value.trim()
      // ほかのスタッフと同じ番号なら、同じ人ではないか確かめてから保存する
      if (body.phone.replace(/\D/g, '').length >= 10) {
        const { data } = await axios.get('/api/admin/staff-lookup', { params: { phone: body.phone } })
        const others = (data.matches || []).filter(m => String(m.staff_id) !== String(sid))
        if (others.length) {
          if (!confirm(`この電話番号のスタッフが登録済みです（${others.map(m => m.name).join('、')}）。\n同じ人の場合は統合を検討してください。このまま保存しますか？`)) return
          body.phone_confirmed = true
        }
      }
    }
    const le = document.getElementById('staff-login-email')
    if (le && le.value.trim() !== (le.dataset.orig || '')) {
      body.login_email = le.value.trim()
      if (!body.login_email && !confirm('ログイン用メールアドレスを削除します。打刻修正の結果・お知らせのメールと、パスワード再設定のメールが届かなくなります。よろしいですか？')) return
    }
    if (document.getElementById('staff-career-rows')) {
      const commute = val('staff-commute')
      Object.assign(body, {
        commute_minutes: commute ? Number(commute) : null, available_from: val('staff-available-from') || null,
        work_area: val('staff-work-area'), skills: val('staff-skills'),
        career_rows: collectCareerRows(), pr_points: val('staff-pr-points'), remarks: val('staff-remarks'),
      })
    }
    const res = await putConfirmingRetiredAt('/api/admin/staff/' + sid, body)
    if (!res) return
    // 所属会社名が新規入力なら候補にも追加しておく（表記ゆれ防止の候補リストを育てる）。
    // 取引先マスタに入るため、取引先所属のスタッフだけにする（屋号・自社名・スキルシートの所属を取引先にしない。#262）
    const aff = (val('staff-affiliation') || '').trim()
    const isPartner = staffDetailState && staffDetailState.p && staffDetailState.p.affiliation_type === 'partner_manual'
    if (aff && isPartner) await axios.post('/api/admin/staff-affiliations', { affiliation_name: aff }).catch(() => {})
    const le2 = res.data && res.data.login_email
    if (le2 && le2.pending) toast(le2.mail_sent && !le2.mail_skipped ? '保存しました。新しいメールアドレスに確認メールを送りました' : '保存しました。確認メールを送れませんでした（メールの設定を確認してください）')
    else toast('保存しました')
    staffEditingSid = null
    await refreshStaffProfile(sid)
  } catch (e) {
    toast((e.response && e.response.data && e.response.data.error) || '保存に失敗しました')
  }
}

// ============ 汎用ファイル管理（スタッフのファイル・入社時書類・契約書で共通利用） ============
const DOC_ICON = { pdf: 'fa-file-pdf text-red-500', doc: 'fa-file-word text-blue-500', docx: 'fa-file-word text-blue-500',
  xls: 'fa-file-excel text-emerald-600', xlsx: 'fa-file-excel text-emerald-600', csv: 'fa-file-csv text-emerald-600',
  ppt: 'fa-file-powerpoint text-orange-500', pptx: 'fa-file-powerpoint text-orange-500', txt: 'fa-file-lines text-gray-500',
  odt: 'fa-file-word text-blue-500', ods: 'fa-file-excel text-emerald-600', odp: 'fa-file-powerpoint text-orange-500',
  jpg: 'fa-file-image text-purple-500', jpeg: 'fa-file-image text-purple-500', png: 'fa-file-image text-purple-500',
  gif: 'fa-file-image text-purple-500', webp: 'fa-file-image text-purple-500' }
function docIconClass(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  return DOC_ICON[ext] || 'fa-file text-gray-400'
}
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
// kind: 'staff'（スタッフのファイル） | 'client'（契約書） で、APIパスと再描画先を切り替える
const DOC_ENTITY = {
  staff: { collectionUrl: id => `/api/admin/staff/${id}/documents`, itemUrl: docId => `/api/admin/staff/documents/${docId}`, containerId: 'staff-documents-list', emptyText: 'ファイルはありません', title: 'ファイルアップロード' },
  client: { collectionUrl: id => `/api/admin/clients/${id}/documents`, itemUrl: docId => `/api/admin/clients/documents/${docId}`, containerId: 'client-documents-list', emptyText: '契約書ファイルはありません', title: '契約書アップロード' },
  employee: { collectionUrl: id => `/api/admin/employees/${id}/documents`, itemUrl: docId => `/api/admin/employees/documents/${docId}`, containerId: 'employee-documents-list', emptyText: '入社時書類はありません', title: '入社時書類アップロード' },
}
function documentListHtml(docs, kind, id) {
  const cfg = DOC_ENTITY[kind]
  if (!docs || docs.length === 0) return `<p class="text-sm text-gray-400">${cfg.emptyText}</p>`
  return `<div class="space-y-1.5">${docs.map(d => `
    <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-50">
      <i class="fas ${docIconClass(d.original_file_name)}"></i>
      <div class="flex-1 min-w-0">
        <p class="text-sm text-gray-800 truncate">${esc(d.original_file_name)}</p>
        <p class="text-xs text-gray-400">${dayjs(d.uploaded_at).format('YYYY/M/D HH:mm')} ・ ${formatFileSize(d.file_size)}</p>
      </div>
      <a class="btn btn-outline text-xs" href="${cfg.itemUrl(d.document_id)}/download" target="_blank" rel="noopener"><i class="fas fa-download"></i></a>
      <button class="btn btn-danger text-xs" data-action="deleteDocument" data-kind="${esc(kind)}" data-id="${esc(id)}" data-doc-id="${d.document_id}" data-name="${esc(d.original_file_name)}"><i class="fas fa-trash"></i></button>
    </div>`).join('')}</div>`
}

window.openDocumentUpload = function (kind, id) {
  const cfg = DOC_ENTITY[kind]
  modal(`
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-bold text-gray-800"><i class="fas fa-file-lines text-blue-600 mr-1"></i>${cfg.title}</h3>
      <button class="text-gray-400" onclick="closeModal()"><i class="fas fa-xmark"></i></button>
    </div>
    <div id="doc-dropzone" class="border-2 border-dashed border-gray-300 rounded-xl p-6 text-center text-gray-500 cursor-pointer"
         ondragover="event.preventDefault(); this.classList.add('border-blue-400','bg-blue-50')"
         ondragleave="this.classList.remove('border-blue-400','bg-blue-50')"
         ondrop="onDocDrop(event, '${kind}', ${id})"
         onclick="document.getElementById('doc-file-input').click()">
      <i class="fas fa-paperclip text-2xl mb-2"></i>
      <p class="text-sm">ファイルをここにドラッグ＆ドロップ</p>
      <p class="text-xs text-gray-400 my-1">または</p>
      <span class="btn btn-outline text-xs inline-flex"><i class="fas fa-folder-open"></i>ファイルを選択</span>
      <p class="text-xs text-gray-400 mt-2">PDF/Word/Excel/PowerPoint/CSV/テキスト/画像・1ファイル20MBまで・複数選択可</p>
    </div>
    <input type="file" id="doc-file-input" class="hidden" multiple onchange="onDocFilesSelected(this.files, '${kind}', ${id})">
    <div id="doc-upload-progress" class="mt-3 space-y-1.5"></div>
  `)
}

window.onDocDrop = function (e, kind, id) {
  e.preventDefault()
  document.getElementById('doc-dropzone').classList.remove('border-blue-400', 'bg-blue-50')
  onDocFilesSelected(e.dataTransfer.files, kind, id)
}

window.onDocFilesSelected = async function (fileList, kind, id) {
  const cfg = DOC_ENTITY[kind]
  const files = Array.from(fileList)
  if (files.length === 0) return
  const progress = document.getElementById('doc-upload-progress')
  progress.innerHTML = files.map(f => `<div class="text-xs flex items-center gap-2"><span class="spin" style="width:.9rem;height:.9rem;border-width:2px"></span>${esc(f.name)} アップロード中...</div>`).join('')

  const form = new FormData()
  files.forEach(f => form.append('files', f))

  try {
    const { data } = await axios.post(cfg.collectionUrl(id), form)
    progress.innerHTML = data.results.map(r => r.ok
      ? `<div class="text-xs text-emerald-600"><i class="fas fa-check"></i> ${esc(r.filename)} アップロード完了</div>`
      : `<div class="text-xs text-red-600"><i class="fas fa-xmark"></i> ${esc(r.filename)}：${esc(r.error)}</div>`
    ).join('')
    const successCount = data.results.filter(r => r.ok).length
    if (successCount > 0) toast(`${successCount}件のファイルをアップロードしました`)
    const { data: docData } = await axios.get(cfg.collectionUrl(id))
    document.getElementById(cfg.containerId).innerHTML = documentListHtml(docData.documents, kind, id)
  } catch {
    progress.innerHTML = '<div class="text-xs text-red-600">ファイルのアップロードに失敗しました。</div>'
  }
}

window.deleteDocument = async function (kind, id, docId, filename) {
  if (!confirm(`${filename} を削除しますか？`)) return
  const cfg = DOC_ENTITY[kind]
  try {
    await axios.delete(cfg.itemUrl(docId))
    toast('ファイルを削除しました')
    const { data: docData } = await axios.get(cfg.collectionUrl(id))
    document.getElementById(cfg.containerId).innerHTML = documentListHtml(docData.documents, kind, id)
  } catch {
    toast('ファイルの削除に失敗しました')
  }
}
// ファイル名は onclick に埋め込まず、ボタンの data-* から読む（documentListHtml）
delegate('deleteDocument', el => deleteDocument(el.dataset.kind, Number(el.dataset.id), Number(el.dataset.docId), el.dataset.name))

window.showSkillSheet = async function (sid) {
  const { data } = await axios.get('/api/admin/staff/' + sid + '/skill-sheet')
  const p = data.profile, perf = data.performance, ev = data.evaluation
  modal(`
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h3 class="font-bold text-lg"><i class="fas fa-file-lines text-blue-600 mr-1"></i>スキルシート</h3>
      <button class="btn btn-outline text-xs" onclick="window.print()"><i class="fas fa-print"></i>印刷</button>
    </div>
    <div class="border border-gray-200 rounded-xl p-4 text-sm space-y-3">
      <div class="border-b pb-2"><p class="text-lg font-bold">${esc(p.name)}</p><p class="text-xs text-gray-500">${esc(p.age_group || '')} ｜ 稼働可能エリア: ${esc(p.work_area || '-')}</p></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">経歴</p>${careerTableReadonly(p)}</div>
      ${p.pr_points ? `<div><p class="text-xs font-bold text-gray-400 mb-1">経験・スキル・人柄・PRポイント等</p><p class="text-xs whitespace-pre-wrap">${esc(p.pr_points)}</p></div>` : ''}
      <div><p class="text-xs font-bold text-gray-400 mb-1">経験案件</p>
        <div class="flex flex-wrap gap-1">${data.experienced_projects.map(pr => `<span class="badge badge-blue">${esc(pr.project_name)}</span>`).join('') || '-'}</div></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">保有スキル</p>
        <div class="flex flex-wrap gap-1">${(p.skills || '').split(',').filter(Boolean).map(s => `<span class="badge badge-purple">${esc(s)}</span>`).join('') || '-'}</div></div>
      <div><p class="text-xs font-bold text-gray-400 mb-1">通算実績（${perf.total_days || 0}稼働日）</p>
        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
          ${[['MNP', perf.mnp], ['PI', perf.pi], ['新規', perf.shinki], ['光回線', perf.hikari], ['成約', perf.seiyaku]].map(([l, v]) =>
            `<div class="bg-gray-50 rounded-lg py-2"><p class="font-bold text-blue-600">${v || 0}</p><p class="text-xs text-gray-500">${l}</p></div>`).join('')}
        </div></div>
      ${ev ? `<div><p class="text-xs font-bold text-gray-400 mb-1">評価（${esc(ev.evaluation_period)}）</p>
        <p class="text-xs">勤怠 ${ev.attendance_score}/5 ・報告 ${ev.report_score}/5 ・実績 ${ev.performance_score}/5 ・クライアント ${ev.client_score}/5</p></div>` : ''}
      <div id="ss-comment-box"><p class="text-xs font-bold text-gray-400 mb-1">推薦コメント</p>
        <textarea id="ss-comment" rows="3" class="inp text-xs ss-no-print" placeholder="推薦コメントを入力してから印刷してください（任意）"></textarea>
        <p class="text-[11px] text-gray-400 mt-1 ss-no-print">入力した内容は、この端末にだけ下書きとして残ります（空欄なら印刷に出しません）</p>
        <p id="ss-comment-print" class="ss-print-only text-xs whitespace-pre-wrap"></p></div>
    </div>
    <style>.ss-print-only{display:none}@media print{.ss-no-print{display:none!important}.ss-print-only{display:block!important}#ss-comment-box.ss-empty{display:none!important}}</style>`)
  // 推薦コメントは印刷用の段落に写し、長文でも途中で切れないようにする（#447）。下書きはこの端末に残す
  const key = 'admin.skillSheetComment.' + Number(sid)
  const ta = document.getElementById('ss-comment'), out = document.getElementById('ss-comment-print'), box = document.getElementById('ss-comment-box')
  const sync = () => {
    out.textContent = ta.value
    box.classList.toggle('ss-empty', !ta.value.trim())
    ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'
  }
  try { ta.value = localStorage.getItem(key) || '' } catch { }
  sync()
  ta.addEventListener('input', () => {
    sync()
    try { if (ta.value.trim()) localStorage.setItem(key, ta.value); else localStorage.removeItem(key) } catch { }
  })
}

window.showFollowModal = function (sid, name) {
  modal(`
    <h3 class="font-bold text-lg mb-4">フォロー記録 — ${esc(name)}</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">対応種別</label>
        <select id="fl-type" class="inp">${Object.entries(FOLLOW_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div><label class="text-sm text-gray-600 block mb-1">内容</label><textarea id="fl-content" rows="3" class="inp" maxlength="2000"></textarea></div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div class="sm:col-span-2"><label class="text-sm text-gray-600 block mb-1">次回対応予定</label><input id="fl-next" class="inp" maxlength="200" placeholder="例: 来週電話で体調を確認"></div>
        <div><label class="text-sm text-gray-600 block mb-1">次回対応日</label><input id="fl-next-date" type="date" class="inp"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">対応状況</label>
        <select id="fl-status" class="inp"><option value="done">完了（次の対応なし）</option><option value="open">対応中（次の対応あり）</option></select>
        <p class="text-[11px] text-gray-400 mt-1">対応中で次回対応日を入れると、その日からダッシュボードの ToDo に出ます</p></div>
      <button class="btn btn-primary w-full" data-action="addFollowLog" data-id="${Number(sid)}">記録する</button>
    </div>`)
  // 次回対応を入れたら対応中にする（自分で状態を選んだ後は変えない。#385）
  const st = document.getElementById('fl-status')
  st.addEventListener('change', () => { st.dataset.touched = '1' })
  const syncStatus = () => {
    if (st.dataset.touched) return
    st.value = (document.getElementById('fl-next').value.trim() || document.getElementById('fl-next-date').value) ? 'open' : 'done'
  }
  document.getElementById('fl-next').addEventListener('input', syncStatus)
  document.getElementById('fl-next-date').addEventListener('change', syncStatus)
}
delegate('showFollowModal', el => showFollowModal(Number(el.dataset.id), el.dataset.name))
window.addFollowLog = async function (sid, button) {
  const val = id => (document.getElementById(id) || {}).value || ''
  await withSubmitLock(button, async () => {
    try {
      await axios.post('/api/admin/follow-logs', {
        staff_id: sid, follow_type: val('fl-type'), content: val('fl-content'),
        next_action: val('fl-next'), next_action_date: val('fl-next-date') || null, status: val('fl-status') || undefined,
      })
    } catch (e) { showApiError(e, 'フォロー履歴を記録できませんでした'); return }
    closeModal(); toast('フォロー履歴を記録しました'); renderStaffDetail(sid)
  })
}
delegate('addFollowLog', el => addFollowLog(Number(el.dataset.id), el))

// ============ 案件 ============
// 請求の標準単価の単位（時給の案件を日単価に見せない #91。日額・時給以外の古い値は日額として計算している）
function priceUnitLabel(t) { return t === 'hourly' ? '/時' : '/日' }
// 月の切り替え（案件一覧・案件詳細・クライアント詳細で共通。#450）
function monthNavHtml(action, month) {
  const m0 = dayjs(month + '-01')
  return `<div class="flex gap-2 items-center">
    <button class="btn btn-outline" data-action="${action}" data-month="${esc(m0.subtract(1, 'month').format('YYYY-MM'))}" aria-label="前の月"><i class="fas fa-chevron-left"></i></button>
    <span class="font-bold whitespace-nowrap">${esc(m0.format('YYYY年M月'))}</span>
    <button class="btn btn-outline" data-action="${action}" data-month="${esc(m0.add(1, 'month').format('YYYY-MM'))}" aria-label="次の月"><i class="fas fa-chevron-right"></i></button>
  </div>`
}
const monthLabel = month => dayjs(month + '-01').format('YYYY年M月')
// 日報一覧の絞り込みのリンク（#404。日報一覧の reportFilterFromHash と同じ形）
function reportsLink(f) { return reportsHash(f) }
function monthRangeOf(month) { const m0 = dayjs(month + '-01'); return { from: m0.format('YYYY-MM-DD'), to: m0.endOf('month').format('YYYY-MM-DD') } }

// 案件一覧の検索・絞り込み・並べ替え（#490）。月は詳細と共通（#450）
const PROJ_LIST = { month: '', q: '', client: '', status: '', worked: false, incident: false, sort: 'project_id', dir: 1, data: null }
const PROJ_SORT = {
  project_id: p => Number(p.project_id), name: p => searchNorm(p.project_name), client: p => p.client_name ? searchNorm(p.client_name) : null,
  unit_price: p => Number(p.unit_price || 0), month_shifts: p => Number(p.month_shifts || 0), month_seiyaku: p => Number(p.month_seiyaku || 0), incidents: p => Number(p.incidents || 0),
}
async function renderProjects() {
  loading()
  PROJ_LIST.month = PROJ_LIST.month || dayjs().format('YYYY-MM')
  try { PROJ_LIST.data = (await axios.get('/api/admin/projects', { params: { month: PROJ_LIST.month } })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(showApiError(e, '案件を読み込めませんでした'))}</p>`; return }
  const L = PROJ_LIST; const projects = L.data.projects
  const clients = [...new Map(projects.filter(p => p.client_id).map(p => [Number(p.client_id), p.client_name])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ja'))
  const th = (k, label) => `<th class="cursor-pointer select-none whitespace-nowrap" data-action="sortProjects" data-key="${k}" title="クリックで並べ替え">${label}${L.sort === k ? `<i class="fas fa-caret-${L.dir > 0 ? 'up' : 'down'} ml-1 text-blue-600"></i>` : ''}</th>`
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">案件管理 <span class="text-sm font-normal text-gray-400" id="proj-count"></span></h2>
      <div class="flex gap-2 items-center flex-wrap">
        ${monthNavHtml('projectsMonth', L.month)}
        <button class="btn btn-outline" data-action="showLatenessSetting" title="入店・勤務開始を何分まで遅刻にしないか（会社全体の設定）"><i class="fas fa-stopwatch"></i>遅刻の猶予</button>
        <a class="btn btn-outline" href="#projects/templates" title="日報の入力項目を自社で作成・編集する"><i class="fas fa-list-check"></i>日報テンプレート</a>
        <button class="btn btn-primary" onclick="showAddProject()"><i class="fas fa-plus"></i>案件登録</button>
      </div>
    </div>
    <div class="card p-3 mb-4 flex gap-2 flex-wrap items-center">
      <input id="proj-q" class="inp text-sm flex-1 min-w-[200px]" placeholder="案件名・稼働場所・クライアント名で検索" value="${esc(L.q)}">
      <select id="proj-client" class="inp text-sm w-auto"><option value="">クライアント: すべて</option><option value="none" ${L.client === 'none' ? 'selected' : ''}>（クライアントなし）</option>
        ${clients.map(([id, name]) => `<option value="${id}" ${String(L.client) === String(id) ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select>
      <select id="proj-status" class="inp text-sm w-auto">${[['', '状態: すべて'], ['active', '稼働中のみ'], ['ended', '終了のみ']].map(([k, v]) => `<option value="${k}" ${L.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" id="proj-worked" ${L.worked ? 'checked' : ''}>この月に稼働あり</label>
      <label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" id="proj-incident" ${L.incident ? 'checked' : ''}>インシデントあり</label>
    </div>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr>${th('name', '案件名')}${th('client', 'クライアント')}<th>種別</th><th>稼働場所</th>${th('unit_price', '単価')}${th('month_shifts', '稼働')}${th('month_seiyaku', '成約')}${th('incidents', 'インシデント')}<th>状態</th></tr></thead>
        <tbody id="proj-rows"></tbody>
      </table>
    </div>
    <p class="text-xs text-gray-400 mt-2">稼働・成約・インシデントは ${esc(monthLabel(L.month))} の集計です。</p>`
  let timer = null
  document.getElementById('proj-q').addEventListener('input', ev => { clearTimeout(timer); timer = setTimeout(() => { L.q = ev.target.value; drawProjectRows() }, 200) })
  for (const [id, k] of [['proj-client', 'client'], ['proj-status', 'status']]) document.getElementById(id).addEventListener('change', ev => { L[k] = ev.target.value; drawProjectRows() })
  for (const [id, k] of [['proj-worked', 'worked'], ['proj-incident', 'incident']]) document.getElementById(id).addEventListener('change', ev => { L[k] = ev.target.checked; drawProjectRows() })
  drawProjectRows()
}
function drawProjectRows() {
  const L = PROJ_LIST; const all = L.data.projects
  let list = all
  if (L.client === 'none') list = list.filter(p => !p.client_id)
  else if (L.client) list = list.filter(p => String(p.client_id) === String(L.client))
  if (L.status === 'active') list = list.filter(p => p.status === 'active')
  if (L.status === 'ended') list = list.filter(p => p.status !== 'active')
  if (L.worked) list = list.filter(p => Number(p.month_shifts) > 0)
  if (L.incident) list = list.filter(p => Number(p.incidents) > 0)
  if (L.q.trim()) list = list.filter(p => matchesKeyword(L.q, [p.project_name, p.location, p.client_name]))
  const key = PROJ_SORT[L.sort] || PROJ_SORT.project_id
  list = list.map(p => [key(p), p]).sort((a, b) => {
    if (a[0] == null || b[0] == null) return (a[0] == null ? 1 : 0) - (b[0] == null ? 1 : 0)
    return (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * L.dir || (a[1].project_id - b[1].project_id)
  }).map(x => x[1])
  document.getElementById('proj-count').textContent = list.length === all.length ? `${all.length}件` : `${list.length}件（全${all.length}件）`
  document.getElementById('proj-rows').innerHTML = list.map(p => `
            <tr class="cursor-pointer" data-action="openProject" data-id="${Number(p.project_id)}">
              <td class="font-medium text-blue-700">${esc(p.project_name)}</td>
              <td class="text-xs">${esc(p.client_name || '-')}</td>
              <td><span class="badge badge-gray">${esc(PTYPE_LABELS[p.project_type] || p.project_type)}</span></td>
              <td class="text-xs">${esc(p.location || '-')}</td>
              <td class="whitespace-nowrap">${yen(p.unit_price)}${priceUnitLabel(p.unit_price_type)}</td>
              <td class="whitespace-nowrap">${Number(p.month_shifts || 0)}件 (${Number(p.staff_count || 0)}名)</td>
              <td class="font-bold">${Number(p.month_seiyaku || 0)}</td>
              <td>${p.incidents ? `<span class="badge badge-red">${Number(p.incidents)}件</span>` : '<span class="text-gray-300">0</span>'}</td>
              <td>${p.status === 'active' ? '<span class="badge badge-green">稼働中</span>' : '<span class="badge badge-gray">終了</span>'}</td>
            </tr>`).join('') || '<tr><td colspan="9" class="text-center text-gray-400 py-6">条件に合う案件はありません</td></tr>'
}
delegate('openProject', el => { location.hash = 'projects/' + Number(el.dataset.id) })
delegate('openEmployee', el => { location.hash = 'employees/' + Number(el.dataset.id) })
delegate('projectsMonth', el => { PROJ_LIST.month = el.dataset.month; renderProjects() })
delegate('sortProjects', el => {
  const k = el.dataset.key
  if (PROJ_LIST.sort === k) PROJ_LIST.dir = -PROJ_LIST.dir
  else { PROJ_LIST.sort = k; PROJ_LIST.dir = ['name', 'client'].includes(k) ? 1 : -1 }
  drawProjectRows()
  document.querySelectorAll('[data-action="sortProjects"]').forEach(h => {
    const ic = h.querySelector('i'); if (ic) ic.remove()
    if (h.dataset.key === PROJ_LIST.sort) h.insertAdjacentHTML('beforeend', `<i class="fas fa-caret-${PROJ_LIST.dir > 0 ? 'up' : 'down'} ml-1 text-blue-600"></i>`)
  })
})

// 遅刻の猶予（分）。会社全体の設定で、これから記録する入店・勤務開始の報告に効く（#497。API は GET/PUT /admin/settings/lateness）
delegate('showLatenessSetting', async () => {
  let s
  try { s = (await axios.get('/api/admin/settings/lateness')).data } catch (e) { showApiError(e, '設定を読み込めませんでした'); return }
  modal(`
    <h3 class="font-bold text-lg mb-2"><i class="fas fa-stopwatch text-blue-600 mr-1"></i>遅刻の猶予</h3>
    <p class="text-xs text-gray-500 mb-3">入店・勤務開始の報告が、シフトの開始時刻から何分以内なら遅刻にしないかを決めます（会社全体）。変更は、これから記録する報告に効きます（記録済みの報告は判定し直しません）。</p>
    <label class="text-sm text-gray-600 block mb-1">猶予（分）</label>
    <input id="late-grace" type="number" min="0" max="${Number(s.max_grace_minutes) || 0}" step="1" class="inp" value="${Number(s.grace_minutes) || 0}">
    <p class="text-[11px] text-gray-400 mt-1">0〜${Number(s.max_grace_minutes) || 0}分。0 にすると、開始時刻を1分でも過ぎたら遅刻になります</p>
    <button class="btn btn-primary w-full mt-4" data-action="saveLatenessSetting">保存する</button>`)
})
delegate('saveLatenessSetting', el => withSubmitLock(el, async () => {
  const v = document.getElementById('late-grace').value.trim()
  if (!/^\d+$/.test(v)) { toast('猶予は0以上の整数で入力してください'); return }
  try {
    await axios.put('/api/admin/settings/lateness', { grace_minutes: Number(v) })
    closeModal(); toast(`遅刻の猶予を${Number(v)}分にしました`)
  } catch (e) { showApiError(e, '保存できませんでした') }
}))

window.showAddProject = async function () {
  const [{ data: cl }, { data: tp0 }] = await Promise.all([axios.get('/api/admin/clients'), axios.get('/api/admin/templates')])
  // 配信停止のテンプレートは選べない（#165）
  const tp = { templates: tp0.templates.filter(t => t.status !== 'stopped') }
  // 既定は先頭の有効なテンプレート（項目が1つ以上あるもの）。固定のIDは前提にしない
  const usable = tp.templates.find(t => { try { const f = JSON.parse(t.fields_json || '[]'); return Array.isArray(f) && f.length > 0 } catch { return false } })
  const defaultTpl = usable ? usable.template_id : null
  modal(`
    <h3 class="font-bold text-lg mb-4">案件登録</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">案件名 *</label><input id="np-name" class="inp"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">クライアント</label>
          <select id="np-client" class="inp"><option value="">（クライアントなし）</option>${cl.clients.map(c => `<option value="${Number(c.client_id)}">${esc(c.client_name)}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">業務種別</label>
          <select id="np-type" class="inp">${Object.entries(PTYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">稼働場所</label><input id="np-loc" class="inp"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">請求単価（円）</label>
          <div class="flex gap-2"><select id="np-price-unit" class="inp w-24 shrink-0"><option value="daily">日額</option><option value="hourly">時給</option></select>
            <input id="np-price" type="number" min="0" class="inp" value="16000"></div>
          <p class="text-[11px] text-gray-400 mt-1">支払単価・交通費は、登録後に案件詳細の「区分・標準単価」で設定します</p></div>
        <div><label class="text-sm text-gray-600 block mb-1">日報テンプレート</label>
          <select id="np-tpl" class="inp">${tp.templates.map(t => `<option value="${Number(t.template_id)}" ${t.template_id === defaultTpl ? 'selected' : ''}>${esc(t.template_name)}</option>`).join('')}</select>
          ${tp.templates.length ? '' : '<p class="text-xs text-red-600 mt-1">本部の日報テンプレートが未登録です。本部に登録を依頼してください</p>'}</div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">必要スキル</label><input id="np-skills" class="inp" maxlength="500" placeholder="カンマ・読点区切り（例: MNP、光回線、クロージング）">
        <p class="text-[11px] text-gray-400 mt-1">シフトボードの候補一覧で、スタッフのスキルと照らし合わせて『スキル n/m』を出します</p></div>
      <div><label class="text-sm text-gray-600 block mb-1">求められる内容</label><textarea id="np-req" rows="2" class="inp" maxlength="2000"></textarea></div>
      <div><label class="text-sm text-gray-600 block mb-1">案件マニュアル・注意事項</label><textarea id="np-manual" rows="3" class="inp" maxlength="5000" placeholder="集合場所・服装・持ち物・現場のルールなど"></textarea></div>
      <button class="btn btn-primary w-full" data-action="addProject">登録する</button>
    </div>`)
}
// 登録する。同名の登録があるとき（サーバーが confirm_duplicate を返す）は、確認できたら確認済みとして送り直す。取りやめたら null を返す
async function postConfirmingDuplicate(url, body) {
  try {
    return await axios.post(url, body)
  } catch (e) {
    const d = e.response && e.response.data
    if (!(e.response && e.response.status === 409 && d && d.confirm_duplicate)) throw e
    if (!confirm(d.error + '\n\nそれでも登録しますか？')) return null
    return axios.post(url, { ...body, allow_duplicate: true })
  }
}
delegate('addProject', el => withSubmitLock(el, addProject))
window.addProject = async function () {
  const name = document.getElementById('np-name').value.trim()
  if (!name) { toast('案件名を入力してください'); return }
  try {
    const res = await postConfirmingDuplicate('/api/admin/projects', {
      project_name: name, client_id: document.getElementById('np-client').value || null,
      project_type: document.getElementById('np-type').value, location: document.getElementById('np-loc').value,
      unit_price: Number(document.getElementById('np-price').value || 0), unit_price_type: document.getElementById('np-price-unit').value,
      report_template_id: document.getElementById('np-tpl').value || null, requirements: document.getElementById('np-req').value,
      manual_text: document.getElementById('np-manual').value, required_skills: document.getElementById('np-skills').value
    })
    if (!res) return
    closeModal(); toast('案件を登録しました'); renderProjects()
  } catch (e) { showApiError(e, '案件の登録に失敗しました') }
}

// スタッフ別ランキングの並べ方（#489）: 合計 / 1日あたり / 成約率（成約÷商談）。日数の少ない人で順位がぶれないよう、最低日数で絞れる
const RANK_MODES = [['total', '合計'], ['per_day', '1日あたり'], ['rate', '成約率']]
const RANK_STATE = { mode: 'total', minDays: 0 }
function rankControlsHtml(action, hasRate) {
  return `<span class="flex items-center gap-1 flex-wrap text-xs font-normal">
    ${RANK_MODES.filter(([k]) => k !== 'rate' || hasRate).map(([k, v]) => `<button type="button" class="btn ${RANK_STATE.mode === k ? 'btn-primary' : 'btn-outline'} text-xs" data-action="${action}" data-mode="${k}">${v}</button>`).join('')}
    <select class="inp text-xs w-auto" data-rank-min="${action}">${[0, 3, 5, 10].map(n => `<option value="${n}" ${RANK_STATE.minDays === n ? 'selected' : ''}>${n ? n + '日以上' : '日数: すべて'}</option>`).join('')}</select>
  </span>`
}
// rows: { days, val, num, den } の配列（val: 合計、num/den: 成約・商談）。並べた結果を返す
function rankRows(rows, hasRate) {
  const mode = RANK_STATE.mode === 'rate' && !hasRate ? 'total' : RANK_STATE.mode
  const score = r => mode === 'per_day' ? (r.days ? r.val / r.days : 0) : mode === 'rate' ? (r.den ? r.num / r.den : -1) : r.val
  return rows.filter(r => r.days >= RANK_STATE.minDays).sort((a, b) => (score(b) - score(a)) || (b.val - a.val) || (b.days - a.days))
}
const perDay = (v, d) => d ? (Math.round((v / d) * 10) / 10).toLocaleString() : '-'
const ratePct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '-'
document.addEventListener('change', ev => {
  const sel = ev.target && ev.target.closest ? ev.target.closest('select[data-rank-min]') : null
  if (!sel) return
  RANK_STATE.minDays = Number(sel.value) || 0
  if (sel.dataset.rankMin === 'rankAnalytics') drawAnalytics(); else drawProjectStaffPerf()
})

let PROJECT_DETAIL = null
async function renderProjectDetail(pid) {
  loading()
  PROJ_LIST.month = PROJ_LIST.month || dayjs().format('YYYY-MM')
  const { data } = await axios.get('/api/admin/projects/' + pid, { params: { month: PROJ_LIST.month } })
  const p = data.project; const month = data.month
  PROJECT_DETAIL = { pid: Number(p.project_id), data }
  const range = monthRangeOf(month); const ml = monthLabel(month)
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <a href="#projects" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold text-gray-900">${esc(p.project_name)}</h2>
        <p class="text-sm text-gray-500">${p.client_id ? `<a href="#clients/${Number(p.client_id)}" class="hover:underline">${esc(p.client_name || '')}</a>` : ''} ｜ ${PTYPE_LABELS[p.project_type] || ''} ｜ ${esc(p.location || '')}</p>
      </div>
      ${monthNavHtml('projectDetailMonth', month)}
      <span class="badge ${p.status === 'active' ? 'badge-green' : 'badge-gray'}">${p.status === 'active' ? '稼働中' : '終了'}</span>
      <button class="btn btn-outline" data-action="editProject" data-id="${Number(p.project_id)}"><i class="fas fa-pen"></i>編集</button>
      ${p.status === 'active'
        ? `<button class="btn btn-outline" data-action="setProjectStatus" data-id="${Number(p.project_id)}" data-status="closed" data-name="${esc(p.project_name)}"><i class="fas fa-flag-checkered"></i>案件を終了する</button>`
        : `<button class="btn btn-outline" data-action="setProjectStatus" data-id="${Number(p.project_id)}" data-status="active" data-name="${esc(p.project_name)}"><i class="fas fa-rotate-left"></i>稼働中に戻す</button>`}
    </div>
    ${p.status === 'active' ? '' : `<div class="card p-3 mb-4 bg-gray-50 text-sm text-gray-600"><i class="fas fa-circle-info mr-1"></i>この案件は終了しています${p.closed_at ? `（${esc(dayjs(p.closed_at).format('YYYY/M/D'))}）` : ''}。シフト登録・シフトボードの選択肢に出ず、新しいシフトは登録できません。</div>`}

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      <div class="card p-4"><p class="text-xs text-gray-500">請求単価</p><p class="text-xl font-bold">${yen(p.unit_price)}<span class="text-xs font-normal text-gray-400">${priceUnitLabel(p.unit_price_type)}</span></p></div>
      <div class="card p-4"><p class="text-xs text-gray-500">${esc(ml)}の稼働</p><p class="text-xl font-bold">${Number(data.month_summary.n || 0)}<span class="text-xs font-normal text-gray-400">件</span></p></div>
      <div class="card p-4"><p class="text-xs text-gray-500">${esc(ml)}の売上（概算）</p><p class="text-xl font-bold">${yen(data.month_summary.revenue)}</p></div>
      <div class="card p-4"><p class="text-xs text-gray-500">日報テンプレート</p><p class="text-sm font-bold mt-1">${esc(p.template_name || '-')}</p>
        <a href="${esc(reportsLink({ project: p.project_id, ...range }))}" class="text-xs text-blue-600 hover:underline">${esc(ml)}の日報を見る</a>
        <a href="#projects/templates" class="text-xs text-blue-600 hover:underline ml-2">テンプレートの管理</a></div>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-4">
      <section class="card p-4">
        <div class="flex items-center gap-2 mb-3 flex-wrap">
          <h3 class="text-sm font-bold text-gray-700">スタッフ別実績（${esc(ml)}）</h3>
          <span class="ml-auto">${rankControlsHtml('rankProject', true)}</span>
        </div>
        <div class="overflow-x-auto" id="project-staff-perf"></div>
      </section>
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3 flex items-center"><i class="fas fa-bolt text-red-500 mr-1"></i>インシデント・クレーム<span class="text-xs font-normal text-gray-400 ml-1">（直近10件）</span>
          <a href="${esc(reportsLink({ project: p.project_id, flagged: 1 }))}" class="ml-auto text-xs font-normal text-blue-600 hover:underline">日報一覧で見る</a></h3>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          ${data.incidents.map(i => `
            <a href="${esc(reportsLink({ project: p.project_id, from: i.work_date, to: i.work_date }))}" class="block p-2.5 rounded-lg bg-red-50 text-xs hover:bg-red-100" title="この日の日報を開く">
              <div class="flex gap-2 mb-1">
                ${i.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
                ${i.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
                <span class="text-gray-500">${esc(dayjs(i.work_date).format('YYYY/M/D'))} ${esc(i.staff_name)}</span>
              </div>
              <p class="text-gray-700 whitespace-pre-wrap">${esc((i.values && i.values.free) || '')}</p>
            </a>`).join('') || '<p class="text-sm text-gray-400">インシデントはありません</p>'}
        </div>
      </section>
    </div>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-2">求められる内容</h3>
        <p class="text-sm text-gray-600 whitespace-pre-wrap">${esc(p.requirements || '-')}</p>
        <h3 class="text-sm font-bold text-gray-700 mt-4 mb-2">案件マニュアル・注意事項</h3>
        <p class="text-sm text-gray-600 whitespace-pre-wrap">${esc(p.manual_text || '-')}</p>
        <h3 class="text-sm font-bold text-gray-700 mt-4 mb-2 flex items-center">必要スキル
          <button type="button" class="ml-auto text-xs font-normal text-blue-600 hover:underline" data-action="editProjectSkills" data-id="${Number(p.project_id)}" data-skills="${esc(p.required_skills || '')}"><i class="fas fa-pen mr-0.5"></i>編集</button></h3>
        <div class="flex flex-wrap gap-1" id="project-skills">${projectSkillBadges(p.required_skills)}</div>
        <p class="text-[11px] text-gray-400 mt-1">シフトボードの候補一覧で、スタッフのスキルと照らし合わせて『スキル n/m』を出します</p>
      </section>
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-2">日報テンプレート項目</h3>
        <div class="flex flex-wrap gap-1.5">
          ${(p.template_fields || []).map(f => `<span class="badge ${f.type === 'number' ? 'badge-blue' : 'badge-gray'}">${esc(f.label)}</span>`).join('')}
        </div>
        <p class="text-xs text-gray-400 mt-3">スタッフへの実績表示: ${p.show_performance ? '表示する' : '表示しない'}</p>
        <div class="mt-4 pt-3 border-t border-gray-100">
          <p class="text-xs text-gray-500 mb-1"><i class="fas fa-camera text-blue-600 mr-1"></i>入店/退店報告の写真添付</p>
          <select class="inp text-sm" data-project-photo="${Number(p.project_id)}">
            <option value="inherit" ${p.photo_required_override == null ? 'selected' : ''}>会社設定に従う（現在: ${data.company_photo_default ? '必須' : '不要'}）</option>
            <option value="on" ${p.photo_required_override === 1 ? 'selected' : ''}>この案件は必須にする</option>
            <option value="off" ${p.photo_required_override === 0 ? 'selected' : ''}>この案件は不要にする</option>
          </select>
        </div>
      </section>
    </div>
    <div id="project-pricing-panel" class="mt-4"></div>`
  drawProjectStaffPerf()
  // 常勤/スポット・単価（請求/支払）・単価ルール・繰り返し登録（public/static/shift-board.js）
  if (window.renderProjectPricingPanel) renderProjectPricingPanel(p)
}
// 写真添付の設定（イベント属性に値を埋め込まない）
document.addEventListener('change', ev => {
  const sel = ev.target && ev.target.closest ? ev.target.closest('select[data-project-photo]') : null
  if (sel) updateProjectPhotoRequired(Number(sel.dataset.projectPhoto), sel.value)
})
// 案件の更新。確認が要る変更（サーバーが 409 で confirm_* を返す）は、確認できたら印を付けて送り直す。取りやめたら null を返す
const PROJECT_CONFIRM_FLAGS = [['confirm_duplicate', 'allow_duplicate'], ['confirm_close', 'confirm_close'], ['confirm_template_change', 'confirm_template_change']]
async function putProjectConfirming(pid, body) {
  let b = { ...body }
  for (let i = 0; i <= PROJECT_CONFIRM_FLAGS.length; i++) {
    try { return await axios.put('/api/admin/projects/' + pid, b) } catch (e) {
      const d = e.response && e.response.data
      const hit = e.response && e.response.status === 409 && d && PROJECT_CONFIRM_FLAGS.find(([k]) => d[k])
      if (!hit) throw e
      if (!confirm(d.error + '\n\nこのまま保存しますか？')) return null
      b = { ...b, [hit[1]]: true }
    }
  }
  return null
}
// 案件の編集（#153）。単価・区分は下の「区分・標準単価」で変える
delegate('editProject', el => withSubmitLock(el, async () => {
  const pid = Number(el.dataset.id)
  if (!PROJECT_DETAIL || PROJECT_DETAIL.pid !== pid) return
  const p = PROJECT_DETAIL.data.project
  let cl, tp
  try {
    [{ data: cl }, { data: tp }] = await Promise.all([axios.get('/api/admin/clients'), axios.get('/api/admin/templates')])
  } catch (e) { showApiError(e, '読み込めませんでした'); return }
  // 配信停止・項目のないテンプレートは選べない（いま使っているものは残す）
  const tpls = tp.templates.filter(t => Number(t.template_id) === Number(p.report_template_id) || (t.status !== 'stopped' && (t.fields || []).length > 0))
  modal(`
    <h3 class="font-bold text-lg mb-4">案件の編集</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">案件名 *</label><input id="ep-name" class="inp" maxlength="100" value="${esc(p.project_name)}"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">クライアント</label>
          <select id="ep-client" class="inp"><option value="">（クライアントなし）</option>${cl.clients.map(c => `<option value="${Number(c.client_id)}" ${Number(c.client_id) === Number(p.client_id) ? 'selected' : ''}>${esc(c.client_name)}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">業務種別</label>
          <select id="ep-type" class="inp">${Object.entries(PTYPE_LABELS).map(([k, v]) => `<option value="${k}" ${p.project_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">稼働場所</label><input id="ep-loc" class="inp" maxlength="200" value="${esc(p.location || '')}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">日報テンプレート</label>
        <select id="ep-tpl" class="inp">${tpls.map(t => `<option value="${Number(t.template_id)}" ${Number(t.template_id) === Number(p.report_template_id) ? 'selected' : ''}>${esc(t.template_name)}${t.editable ? '（自社）' : ''}${t.status === 'stopped' ? '（配信停止）' : ''}</option>`).join('')}</select>
        <p class="text-[11px] text-gray-400 mt-1">日報がある案件のテンプレートを変えると、新しいテンプレートにない項目は過去の日報に表示されなくなります</p></div>
      <div><label class="text-sm text-gray-600 block mb-1">必要スキル</label><input id="ep-skills" class="inp" maxlength="500" value="${esc(p.required_skills || '')}" placeholder="カンマ・読点区切り（例: MNP、光回線、クロージング）"></div>
      <div><label class="text-sm text-gray-600 block mb-1">求められる内容</label><textarea id="ep-req" rows="2" class="inp" maxlength="2000">${esc(p.requirements || '')}</textarea></div>
      <div><label class="text-sm text-gray-600 block mb-1">案件マニュアル・注意事項</label><textarea id="ep-manual" rows="4" class="inp" maxlength="5000">${esc(p.manual_text || '')}</textarea></div>
      <div><label class="text-sm text-gray-600 block mb-1">メモ（管理者のみ）</label><textarea id="ep-memo" rows="2" class="inp" maxlength="2000">${esc(p.memo || '')}</textarea></div>
      <label class="text-sm text-gray-600 flex items-center gap-2"><input type="checkbox" id="ep-perf" ${p.show_performance ? 'checked' : ''}>スタッフに実績を表示する</label>
      <button class="btn btn-primary w-full" data-action="saveProject" data-id="${pid}">保存する</button>
    </div>`)
}))
delegate('saveProject', el => withSubmitLock(el, async () => {
  const pid = Number(el.dataset.id)
  const v = id => document.getElementById(id).value
  if (!v('ep-name').trim()) { toast('案件名を入力してください'); return }
  try {
    const res = await putProjectConfirming(pid, {
      project_name: v('ep-name'), client_id: v('ep-client') || null, project_type: v('ep-type'), location: v('ep-loc'),
      report_template_id: Number(v('ep-tpl')), required_skills: v('ep-skills'), requirements: v('ep-req'), manual_text: v('ep-manual'),
      memo: v('ep-memo'), show_performance: document.getElementById('ep-perf').checked,
    })
    if (!res) return
    closeModal(); toast('案件を保存しました'); renderProjectDetail(pid)
  } catch (e) { showApiError(e, '案件を保存できませんでした') }
}))
// 案件の終了・稼働中に戻す（#153）
delegate('setProjectStatus', el => withSubmitLock(el, async () => {
  const pid = Number(el.dataset.id); const closing = el.dataset.status === 'closed'
  if (closing && !confirm(`案件「${el.dataset.name}」を終了しますか？\n終了すると、シフト登録・シフトボードの選択肢に出なくなり、新しいシフトを登録できなくなります（あとで稼働中に戻せます）。`)) return
  try {
    const res = await putProjectConfirming(pid, { status: closing ? 'closed' : 'active' })
    if (!res) return
    toast(closing ? '案件を終了しました' : '案件を稼働中に戻しました'); renderProjectDetail(pid)
  } catch (e) { showApiError(e, '案件の状態を変更できませんでした') }
}))

// ============ 日報テンプレート（自社で作成・編集。#165） ============
// 本部のテンプレートは編集できないため、複製して自社のテンプレートとして編集する。
// 値が入った日報がある項目は、削除・数値とテキストの切り替えができない（サーバーで確かめる）。日報がある既存の項目のキーは画面でも変えさせない
const TPL_TYPES = [['number', '数値（件数の集計に使う）'], ['text', '1行のテキスト'], ['textarea', '複数行のテキスト']]
let ADMIN_TPLS = []
let TPL_EDIT = null
async function renderAdminTemplates() {
  loading()
  try { ADMIN_TPLS = (await axios.get('/api/admin/templates')).data.templates } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(showApiError(e, 'テンプレートを読み込めませんでした'))}</p>`; return }
  const card = t => `
    <section class="card p-4 ${t.status === 'stopped' ? 'opacity-70' : ''}">
      <div class="flex items-center gap-2 mb-2 flex-wrap">
        <h3 class="font-bold text-gray-800">${esc(t.template_name)}</h3>
        <span class="badge ${t.editable ? 'badge-purple' : 'badge-blue'}">${t.editable ? '自社' : '本部配信'}</span>
        ${t.status === 'stopped' ? '<span class="badge badge-gray">配信停止</span>' : ''}
        <span class="text-xs text-gray-400 ml-auto">使用中の案件 ${Number(t.project_count || 0)}件</span>
      </div>
      <div class="flex flex-wrap gap-1.5 mb-3">${(t.fields || []).map(f => `<span class="badge ${f.type === 'number' ? 'badge-blue' : 'badge-gray'}" title="${esc(f.key)}">${esc(f.label)}${f.required ? ' *' : ''}</span>`).join('') || '<span class="text-xs text-gray-400">項目がありません</span>'}</div>
      <div class="flex gap-2 flex-wrap">
        ${t.editable ? `<button class="btn btn-outline text-xs" data-action="editAdminTemplate" data-id="${Number(t.template_id)}"><i class="fas fa-pen"></i>編集</button>
          <button class="btn btn-outline text-xs" data-action="toggleAdminTemplateStatus" data-id="${Number(t.template_id)}" data-status="${t.status === 'stopped' ? 'active' : 'stopped'}">${t.status === 'stopped' ? '使用を再開' : '配信停止'}</button>` : ''}
        <button class="btn btn-outline text-xs" data-action="copyAdminTemplate" data-id="${Number(t.template_id)}"><i class="fas fa-copy"></i>複製して作成</button>
      </div>
    </section>`
  const own = ADMIN_TPLS.filter(t => t.editable), hq = ADMIN_TPLS.filter(t => !t.editable)
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <a href="#projects" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
      <h2 class="text-xl font-bold text-gray-900 flex-1">日報テンプレート</h2>
      <button class="btn btn-primary" data-action="newAdminTemplate"><i class="fas fa-plus"></i>テンプレートを作成</button>
    </div>
    <p class="text-sm text-gray-500 mb-4">案件ごとにスタッフが日報で入力する項目です。案件の登録・編集で選びます。配信停止にしたテンプレートは新しい案件では選べません（使っている案件はそのまま使えます）。</p>
    <h3 class="text-sm font-bold text-gray-700 mb-2">自社のテンプレート</h3>
    <div class="grid md:grid-cols-2 gap-4 mb-6">${own.map(card).join('') || '<p class="text-sm text-gray-400">自社のテンプレートはまだありません。「テンプレートを作成」か、本部のテンプレートの「複製して作成」から作れます</p>'}</div>
    <h3 class="text-sm font-bold text-gray-700 mb-2">本部配信のテンプレート</h3>
    <div class="grid md:grid-cols-2 gap-4">${hq.map(card).join('') || '<p class="text-sm text-gray-400">本部のテンプレートはありません</p>'}</div>`
}
const tplById = id => ADMIN_TPLS.find(t => Number(t.template_id) === Number(id))
delegate('newAdminTemplate', () => openTemplateEditor(null, { name: '', fields: [{ key: 'item1', label: '', type: 'number' }, { key: 'free', label: '自由記述', type: 'textarea' }] }))
delegate('editAdminTemplate', el => { const t = tplById(el.dataset.id); if (t) openTemplateEditor(t, { name: t.template_name, fields: t.fields }) })
delegate('copyAdminTemplate', el => { const t = tplById(el.dataset.id); if (t) openTemplateEditor(null, { name: (t.template_name + '（自社）').slice(0, 60), fields: t.fields }) })
delegate('toggleAdminTemplateStatus', el => withSubmitLock(el, async () => {
  const t = tplById(el.dataset.id); if (!t) return
  const stop = el.dataset.status === 'stopped'
  if (stop && !confirm(`「${t.template_name}」を配信停止にしますか？\n新しい案件では選べなくなります。使っている案件（${Number(t.project_count || 0)}件）はそのまま使えます。`)) return
  try {
    await axios.put('/api/admin/templates/' + Number(t.template_id), { status: el.dataset.status })
    toast(stop ? '配信停止にしました' : '使用を再開しました'); renderAdminTemplates()
  } catch (e) { showApiError(e, '変更できませんでした') }
}))
// t: 編集するテンプレート（新規・複製は null）。init: 名前と項目の初期値
function openTemplateEditor(t, init) {
  const locked = new Set(t && t.has_reports ? (t.fields || []).map(f => f.key) : [])
  TPL_EDIT = { id: t ? Number(t.template_id) : null, locked, rows: (init.fields || []).map(f => ({ ...f, origKey: f.key })) }
  modal(`
    <h3 class="font-bold text-lg mb-3">${t ? 'テンプレートの編集' : 'テンプレートの作成'}</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">テンプレート名 *</label><input id="tpl-name" class="inp" maxlength="60" value="${esc(init.name || '')}"></div>
      ${locked.size ? '<p class="text-xs text-amber-700 bg-amber-50 rounded p-2">このテンプレートには日報があります。値が入った日報がある項目は、削除・数値とテキストの切り替えができません（保存のときに確かめます）。表示名・順序・必須の変更と、項目の追加はいつでもできます。</p>' : ''}
      <div>
        <div class="text-[11px] text-gray-400 grid grid-cols-12 gap-1 mb-1"><span class="col-span-3">キー（半角英数字）</span><span class="col-span-4">表示名</span><span class="col-span-3">入力欄</span><span class="col-span-2"></span></div>
        <div id="tpl-rows" class="space-y-1.5"></div>
        <button type="button" class="btn btn-outline text-xs mt-2" data-action="tplAddRow"><i class="fas fa-plus"></i>項目を追加</button>
        <p class="text-[11px] text-gray-400 mt-1">キーは日報の値の保存に使います。日報が出た後は変えられません。数値の項目は、日報一覧・分析の件数の集計に使います</p>
      </div>
      <button class="btn btn-primary w-full" data-action="saveAdminTemplate">保存する</button>
    </div>`)
  drawTplRows()
}
function drawTplRows() {
  const box = document.getElementById('tpl-rows'); if (!box || !TPL_EDIT) return
  const n = TPL_EDIT.rows.length
  box.innerHTML = TPL_EDIT.rows.map((f, i) => {
    const lk = !!f.origKey && TPL_EDIT.locked.has(f.origKey)
    const types = TPL_TYPES
    return `<div class="grid grid-cols-12 gap-1 items-center">
      <input class="inp text-xs font-mono col-span-3" data-tpl-field="key" data-i="${i}" value="${esc(f.key || '')}" maxlength="40" ${lk ? 'readonly title="日報があるテンプレートの既存の項目のキーは変えられません"' : ''}>
      <input class="inp text-xs col-span-4" data-tpl-field="label" data-i="${i}" value="${esc(f.label || '')}" maxlength="40" placeholder="表示名">
      <select class="inp text-xs col-span-3" data-tpl-field="type" data-i="${i}">${types.map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="col-span-2 flex items-center gap-0.5 text-[11px] text-gray-500">
        <label class="flex items-center gap-0.5" title="必須"><input type="checkbox" data-tpl-field="required" data-i="${i}" ${f.required ? 'checked' : ''}>必須</label>
        <button type="button" class="px-1 text-gray-500 disabled:opacity-30" data-action="tplMoveRow" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="上へ"><i class="fas fa-arrow-up"></i></button>
        <button type="button" class="px-1 text-gray-500 disabled:opacity-30" data-action="tplMoveRow" data-i="${i}" data-dir="1" ${i === n - 1 ? 'disabled' : ''} title="下へ"><i class="fas fa-arrow-down"></i></button>
        <button type="button" class="px-1 text-red-500 disabled:opacity-30" data-action="tplRemoveRow" data-i="${i}" title="削除"><i class="fas fa-xmark"></i></button>
      </span>
    </div>`
  }).join('') || '<p class="text-xs text-red-600">項目を1つ以上追加してください</p>'
}
// 入力のたびに TPL_EDIT に写す（並べ替え・削除で描き直しても入力が消えないように）
function syncTplField(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-tpl-field]') : null
  if (!el || !TPL_EDIT) return
  const row = TPL_EDIT.rows[Number(el.dataset.i)]; if (!row) return
  const k = el.dataset.tplField
  if (k === 'required') { if (el.checked) row.required = true; else delete row.required }
  else row[k] = el.value
  // 数値の項目には文字数の上限を付けない（サーバーの検証と同じ）
  if (k === 'type' && row.type === 'number') delete row.maxLength
}
document.addEventListener('input', syncTplField)
document.addEventListener('change', syncTplField)
delegate('tplAddRow', () => {
  if (!TPL_EDIT) return
  const used = new Set(TPL_EDIT.rows.map(r => String(r.key || '').toLowerCase()))
  let n = TPL_EDIT.rows.length + 1; while (used.has('item' + n)) n++
  TPL_EDIT.rows.push({ key: 'item' + n, label: '', type: 'number' })
  drawTplRows()
})
delegate('tplMoveRow', el => {
  const i = Number(el.dataset.i), j = i + Number(el.dataset.dir); const r = TPL_EDIT && TPL_EDIT.rows
  if (!r || j < 0 || j >= r.length) return
  ;[r[i], r[j]] = [r[j], r[i]]; drawTplRows()
})
delegate('tplRemoveRow', el => { if (TPL_EDIT) { TPL_EDIT.rows.splice(Number(el.dataset.i), 1); drawTplRows() } })
delegate('saveAdminTemplate', el => withSubmitLock(el, async () => {
  if (!TPL_EDIT) return
  const name = document.getElementById('tpl-name').value.trim()
  if (!name) { toast('テンプレート名を入力してください'); return }
  if (!TPL_EDIT.rows.length) { toast('項目を1つ以上追加してください'); return }
  const fields = TPL_EDIT.rows.map(r => {
    const f = { key: String(r.key || '').trim(), label: String(r.label || '').trim() || String(r.key || '').trim(), type: r.type || 'text' }
    if (r.required) f.required = true
    if (r.placeholder) f.placeholder = r.placeholder
    if (r.maxLength && f.type !== 'number') f.maxLength = r.maxLength
    return f
  })
  try {
    if (TPL_EDIT.id) await axios.put('/api/admin/templates/' + TPL_EDIT.id, { template_name: name, fields })
    else await axios.post('/api/admin/templates', { template_name: name, fields })
    closeModal(); toast('テンプレートを保存しました'); TPL_EDIT = null; renderAdminTemplates()
  } catch (e) { showApiError(e, 'テンプレートを保存できませんでした') }
}))

function projectSkillBadges(v) {
  return String(v || '').split(/[,、，]/).map(s => s.trim()).filter(Boolean).map(s => `<span class="badge badge-blue">${esc(s)}</span>`).join('') || '<span class="text-sm text-gray-400">-</span>'
}
// 案件詳細のスタッフ別実績。成約/日・成約率も出し、並べ方を切り替えられる（#489）
function drawProjectStaffPerf() {
  const host = document.getElementById('project-staff-perf'); if (!host || !PROJECT_DETAIL) return
  const { data } = PROJECT_DETAIL; const range = monthRangeOf(data.month)
  const rows = rankRows(data.staff_performance.map(s => ({ ...s, days: Number(s.days || 0), val: Number(s.seiyaku || 0), num: Number(s.seiyaku || 0), den: Number(s.shodan || 0) })), true)
  host.innerHTML = `<table class="tbl">
    <thead><tr><th>スタッフ</th><th>日数</th><th>MNP</th><th>PI</th><th>新規</th><th>光</th><th>成約</th><th class="whitespace-nowrap">成約/日</th><th>成約率</th></tr></thead>
    <tbody>${rows.map(s => `
      <tr><td class="whitespace-nowrap"><a href="#staff/${Number(s.staff_id)}" class="text-blue-600 hover:underline">${esc(s.name)}</a>
        <a href="${esc(reportsLink({ project: data.project.project_id, staff: s.staff_id, ...range }))}" class="text-[11px] text-gray-400 hover:underline ml-1" title="この人の日報を見る"><i class="fas fa-file-lines"></i></a></td>
      <td>${s.days}</td><td>${Number(s.mnp || 0)}</td><td>${Number(s.pi || 0)}</td><td>${Number(s.shinki || 0)}</td><td>${Number(s.hikari || 0)}</td><td class="font-bold">${s.val}</td>
      <td>${perDay(s.val, s.days)}</td><td>${ratePct(s.num, s.den)}</td></tr>`).join('') || '<tr><td colspan="9" class="text-center text-gray-400 py-3">データなし</td></tr>'}
    </tbody></table>
    <p class="text-[11px] text-gray-400 mt-1">日数は日報の数。成約率は成約÷商談（商談の入力がない人は -）</p>`
}
delegate('rankProject', el => { RANK_STATE.mode = el.dataset.mode; renderProjectDetailRankButtons(); drawProjectStaffPerf() })
function renderProjectDetailRankButtons() {
  document.querySelectorAll('[data-action="rankProject"]').forEach(b => { b.classList.toggle('btn-primary', b.dataset.mode === RANK_STATE.mode); b.classList.toggle('btn-outline', b.dataset.mode !== RANK_STATE.mode) })
}
delegate('projectDetailMonth', el => { PROJ_LIST.month = el.dataset.month; if (PROJECT_DETAIL) renderProjectDetail(PROJECT_DETAIL.pid) })
delegate('editProjectSkills', el => {
  modal(`
    <h3 class="font-bold text-lg mb-2">必要スキル</h3>
    <p class="text-xs text-gray-500 mb-3">カンマ・読点で区切って入力します。空欄にすると消えます。</p>
    <input id="pj-skills" class="inp" maxlength="500" value="${esc(el.dataset.skills || '')}" placeholder="例: MNP、光回線、クロージング">
    <button class="btn btn-primary w-full mt-4" data-action="saveProjectSkills" data-id="${Number(el.dataset.id)}">保存する</button>`)
})
delegate('saveProjectSkills', el => withSubmitLock(el, async () => {
  const pid = Number(el.dataset.id)
  try {
    const { data } = await axios.put(`/api/admin/projects/${pid}/required-skills`, { required_skills: document.getElementById('pj-skills').value })
    closeModal(); toast('必要スキルを保存しました')
    const box = document.getElementById('project-skills'); if (box) box.innerHTML = projectSkillBadges(data.required_skills)
    const btn = document.querySelector('[data-action="editProjectSkills"]'); if (btn) btn.dataset.skills = data.required_skills || ''
  } catch (e) { showApiError(e, '必要スキルを保存できませんでした') }
}))

// ============ クライアント ============
// 評価の星。範囲外・数値でない値でも描画が止まらないよう 0〜5 に丸める
function ratingStars(v) {
  const n = Math.max(0, Math.min(5, Math.round(Number(v) || 0)))
  return '★'.repeat(n) + '☆'.repeat(5 - n)
}
// クライアント一覧の検索・並べ替え（#490）
const CLIENT_LIST = { q: '', stream: '', sort: 'client_id', data: null }
async function renderClients() {
  loading()
  try { CLIENT_LIST.data = (await axios.get('/api/admin/clients')).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(showApiError(e, 'クライアントを読み込めませんでした'))}</p>`; return }
  const L = CLIENT_LIST
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">クライアント管理 <span class="text-sm font-normal text-gray-400" id="client-count"></span></h2>
      <button class="btn btn-primary" onclick="showAddClient()"><i class="fas fa-plus"></i>クライアント登録</button>
    </div>
    <div class="card p-3 mb-4 flex gap-2 flex-wrap items-center">
      <input id="client-q" class="inp text-sm flex-1 min-w-[200px]" placeholder="クライアント名・担当者・稼働案件で検索" value="${esc(L.q)}">
      <select id="client-stream" class="inp text-sm w-auto">${[['', '上流・下流: すべて'], ['upstream', '上流'], ['downstream', '下流']].map(([k, v]) => `<option value="${k}" ${L.stream === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="client-sort" class="inp text-sm w-auto">${[['client_id', '登録順'], ['name', '名前順'], ['active', '稼働案件の多い順'], ['rating', '評価の高い順']].map(([k, v]) => `<option value="${k}" ${L.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div>
    <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-4" id="client-cards"></div>`
  let timer = null
  document.getElementById('client-q').addEventListener('input', ev => { clearTimeout(timer); timer = setTimeout(() => { L.q = ev.target.value; drawClientCards() }, 200) })
  document.getElementById('client-stream').addEventListener('change', ev => { L.stream = ev.target.value; drawClientCards() })
  document.getElementById('client-sort').addEventListener('change', ev => { L.sort = ev.target.value; drawClientCards() })
  drawClientCards()
}
function drawClientCards() {
  const L = CLIENT_LIST; const all = L.data.clients
  let list = all.filter(c => (!L.stream || c.stream_type === L.stream) && matchesKeyword(L.q, [c.client_name, c.contact_name, c.active_projects, c.phone, c.email]))
  const by = {
    client_id: (a, b) => a.client_id - b.client_id,
    name: (a, b) => String(a.client_name).localeCompare(String(b.client_name), 'ja'),
    active: (a, b) => (Number(b.active_project_count || 0) - Number(a.active_project_count || 0)) || (a.client_id - b.client_id),
    rating: (a, b) => (Number(b.client_rating || 0) - Number(a.client_rating || 0)) || (a.client_id - b.client_id),
  }[L.sort] || ((a, b) => a.client_id - b.client_id)
  list = list.slice().sort(by)
  document.getElementById('client-count').textContent = list.length === all.length ? `${all.length}社` : `${list.length}社（全${all.length}社）`
  document.getElementById('client-cards').innerHTML = list.map(c => `
        <section class="card p-4">
          <div class="flex items-start justify-between mb-2">
            <h3 class="font-bold text-gray-800"><a href="#clients/${Number(c.client_id)}" class="hover:underline">${esc(c.client_name)}</a></h3>
            <span class="badge ${c.stream_type === 'upstream' ? 'badge-blue' : 'badge-purple'}">${c.stream_type === 'upstream' ? '上流' : '下流'}</span>
          </div>
          <dl class="text-xs text-gray-600 space-y-1.5">
            <div class="flex"><dt class="w-20 text-gray-400">担当者</dt><dd>${esc(c.contact_name || '-')}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">契約形態</dt><dd>${esc(c.contract_type || '-')}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">請求条件</dt><dd>${esc(c.billing_rule || '-')}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400">評価</dt><dd>${ratingStars(c.client_rating)}</dd></div>
            <div class="flex"><dt class="w-20 text-gray-400 shrink-0">稼働案件</dt><dd>${Number(c.active_project_count || 0)}件${c.project_count > c.active_project_count ? `<span class="text-gray-400">（終了 ${Number(c.project_count) - Number(c.active_project_count || 0)}件）</span>` : ''}
              ${c.active_projects ? `<span class="block text-gray-500 truncate max-w-[220px]">${esc(c.active_projects)}</span>` : ''}</dd></div>
          </dl>
          ${c.ng_staff_ids ? '<p class="text-xs text-red-600 mt-2"><i class="fas fa-ban mr-1"></i>NGスタッフ登録あり</p>' : ''}
          ${c.memo ? `<p class="text-xs bg-gray-50 rounded-lg px-2.5 py-1.5 mt-2 text-gray-500 whitespace-pre-wrap">${esc(c.memo)}</p>` : ''}
        </section>`).join('') || '<p class="text-sm text-gray-400">条件に合うクライアントはありません</p>'
}

// クライアント（発注元企業）詳細画面。会社情報 + 取引の実績 + 契約書ファイル管理を表示する
// 会社基本情報は「編集」で入力欄に切り替え、表示中の項目をすべて保存できる（#307）
let CLIENT_DETAIL = { cid: null, month: '' }
const CLIENT_CONTRACT_TYPES = ['業務委託', '派遣', '請負', '紹介']
function clientBasicHtml(c, editing) {
  const cid = Number(c.client_id)
  if (!editing) return `
        <h3 class="text-sm font-bold text-gray-700 mb-3 flex items-center">会社基本情報
          <button type="button" class="ml-auto btn btn-outline text-xs" data-action="editClientBasic"><i class="fas fa-pen"></i>編集</button></h3>
        <dl class="text-sm space-y-2">
          <div class="flex"><dt class="w-24 text-gray-400 shrink-0">担当者</dt><dd>${esc(c.contact_name || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400 shrink-0">連絡先</dt><dd class="text-xs">${esc(c.phone || '-')}<br>${esc(c.email || '')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400 shrink-0">住所</dt><dd class="whitespace-pre-wrap">${esc(c.address || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400 shrink-0">契約形態</dt><dd>${esc(c.contract_type || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400 shrink-0">請求条件</dt><dd class="whitespace-pre-wrap">${esc(c.billing_rule || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-gray-400 shrink-0">評価</dt><dd>${ratingStars(c.client_rating)}</dd></div>
          <div><dt class="text-gray-400 mb-1">備考</dt><dd class="text-xs text-gray-600 whitespace-pre-wrap">${esc(c.memo || '-')}</dd></div>
        </dl>
        <div class="mt-3 pt-3 border-t border-gray-100">
          <p class="text-xs text-gray-500 mb-1"><i class="fas fa-building text-gray-400 mr-1"></i>代表者・インボイス情報</p>
          <dl class="text-xs space-y-1.5">
            <div class="flex"><dt class="w-28 text-gray-400 shrink-0">代表者</dt><dd>${esc([c.representative_title, c.representative_name].filter(Boolean).join(' ') || '-')}${c.representative_kana ? `<span class="text-gray-400 ml-1">（${esc(c.representative_kana)}）</span>` : ''}</dd></div>
            <div class="flex"><dt class="w-28 text-gray-400 shrink-0">インボイス番号</dt><dd>${esc(c.invoice_number || '-')}</dd></div>
          </dl>
        </div>`
  const inp = (id, label, v, extra = '') => `<div class="flex items-center gap-2"><label for="${id}" class="w-28 text-xs text-gray-400 shrink-0">${label}</label><input id="${id}" class="inp text-xs flex-1" value="${esc(v || '')}" ${extra}></div>`
  const contractOpts = CLIENT_CONTRACT_TYPES.includes(c.contract_type || '') || !c.contract_type ? CLIENT_CONTRACT_TYPES : [c.contract_type, ...CLIENT_CONTRACT_TYPES]
  return `
        <h3 class="text-sm font-bold text-gray-700 mb-3">会社基本情報の編集</h3>
        <div class="space-y-2">
          ${inp('cl-name', 'クライアント名 *', c.client_name, 'maxlength="200"')}
          <div class="flex items-center gap-2"><label for="cl-stream" class="w-28 text-xs text-gray-400 shrink-0">上流/下流</label>
            <select id="cl-stream" class="inp text-xs flex-1"><option value="upstream" ${c.stream_type === 'upstream' ? 'selected' : ''}>上流</option><option value="downstream" ${c.stream_type === 'downstream' ? 'selected' : ''}>下流</option></select></div>
          ${inp('cl-contact', '担当者', c.contact_name)}
          ${inp('cl-phone', '電話', c.phone, 'type="tel"')}
          ${inp('cl-email', 'メール', c.email, 'type="email"')}
          ${inp('cl-address', '住所', c.address)}
          <div class="flex items-center gap-2"><label for="cl-contract" class="w-28 text-xs text-gray-400 shrink-0">契約形態</label>
            <select id="cl-contract" class="inp text-xs flex-1"><option value="">（未設定）</option>${contractOpts.map(v => `<option ${c.contract_type === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
          ${inp('cl-billing', '請求条件', c.billing_rule, 'placeholder="月末締め・翌月末払い"')}
          <div class="flex items-center gap-2"><label for="cl-rating" class="w-28 text-xs text-gray-400 shrink-0">評価</label>
            <select id="cl-rating" class="inp text-xs flex-1">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${Math.round(Number(c.client_rating) || 3) === n ? 'selected' : ''}>${ratingStars(n)}</option>`).join('')}</select></div>
          <div><label for="cl-memo" class="text-xs text-gray-400 block mb-1">備考</label><textarea id="cl-memo" rows="3" class="inp text-xs">${esc(c.memo || '')}</textarea></div>
          <p class="text-xs text-gray-500 pt-2 border-t border-gray-100"><i class="fas fa-building text-gray-400 mr-1"></i>代表者・インボイス情報</p>
          ${inp('cl-rep-title', '代表者役職', c.representative_title)}
          ${inp('cl-rep-name', '代表者氏名', c.representative_name)}
          ${inp('cl-rep-kana', '代表者フリガナ', c.representative_kana)}
          ${inp('cl-invoice', 'インボイス番号', c.invoice_number, 'placeholder="T1234567890123"')}
          <p id="cl-basic-error" class="hidden text-xs text-red-600"></p>
          <div class="flex gap-2">
            <button type="button" class="btn btn-outline text-xs flex-1" data-action="cancelClientBasic">取り消す</button>
            <button type="button" class="btn btn-primary text-xs flex-1" data-action="saveClientBasic" data-id="${cid}">保存</button>
          </div>
        </div>`
}
// 取引の実績（#345）: 案件ごとの稼働・売上・日報・インシデントと、6か月の月別推移。終了した案件は折りたたむ
function clientDealsHtml(data) {
  const ml = monthLabel(data.month); const range = monthRangeOf(data.month)
  const projects = data.projects || []
  const active = projects.filter(p => p.status === 'active'), ended = projects.filter(p => p.status !== 'active')
  const row = p => `<tr>
      <td><a href="#projects/${Number(p.project_id)}" class="text-blue-600 hover:underline">${esc(p.project_name)}</a>${p.location ? `<span class="block text-[11px] text-gray-400">${esc(p.location)}</span>` : ''}</td>
      <td>${p.status === 'active' ? '<span class="badge badge-green">稼働中</span>' : '<span class="badge badge-gray">終了</span>'}</td>
      <td class="whitespace-nowrap">${Number(p.shifts)}件（${Number(p.staff_count)}名）</td>
      <td class="whitespace-nowrap">${yen(p.bill_total)}</td>
      <td>${p.reports ? `<a href="${esc(reportsLink({ project: p.project_id, ...range }))}" class="text-blue-600 hover:underline">${Number(p.reports)}</a>` : '0'}</td>
      <td>${p.incidents ? `<a href="${esc(reportsLink({ project: p.project_id, ...range, flagged: 1 }))}" class="badge badge-red">${Number(p.incidents)}件</a>` : '<span class="text-gray-300">0</span>'}</td></tr>`
  const head = '<thead><tr><th>案件</th><th>状態</th><th>稼働</th><th>売上（概算）</th><th>日報</th><th>インシデント</th></tr></thead>'
  const sum = projects.reduce((a, p) => ({ shifts: a.shifts + Number(p.shifts), bill: a.bill + Number(p.bill_total), incidents: a.incidents + Number(p.incidents) }), { shifts: 0, bill: 0, incidents: 0 })
  const maxBill = Math.max(1, ...(data.trend || []).map(t => Number(t.bill_total)))
  return `
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-chart-column text-blue-500 mr-1"></i>取引の実績</h3>
        <span class="ml-auto">${monthNavHtml('clientDetailMonth', data.month)}</span>
      </div>
      <div class="grid grid-cols-3 gap-3 mb-3 text-center">
        <div class="bg-gray-50 rounded-lg py-2"><p class="font-bold text-blue-600">${sum.shifts}件</p><p class="text-xs text-gray-500">${esc(ml)}の稼働</p></div>
        <div class="bg-gray-50 rounded-lg py-2"><p class="font-bold text-blue-600">${yen(sum.bill)}</p><p class="text-xs text-gray-500">${esc(ml)}の売上（概算）</p></div>
        <div class="bg-gray-50 rounded-lg py-2"><p class="font-bold ${sum.incidents ? 'text-red-600' : 'text-blue-600'}">${sum.incidents}件</p><p class="text-xs text-gray-500">インシデント</p></div>
      </div>
      <div class="overflow-x-auto"><table class="tbl">${head}<tbody>${active.map(row).join('') || '<tr><td colspan="6" class="text-center text-gray-400 py-3">稼働中の案件はありません</td></tr>'}</tbody></table></div>
      ${ended.length ? `<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">終了した案件（${ended.length}件）</summary>
        <div class="overflow-x-auto mt-1"><table class="tbl">${head}<tbody>${ended.map(row).join('')}</tbody></table></div></details>` : ''}
      <p class="text-xs font-bold text-gray-500 mt-4 mb-1">月別の推移（${esc(monthLabel((data.trend || [])[0] ? data.trend[0].ym : data.month))}〜${esc(ml)}）</p>
      <div class="space-y-1">${(data.trend || []).map(t => `
        <div class="flex items-center gap-2 text-xs">
          <span class="w-16 text-gray-500 shrink-0">${esc(dayjs(t.ym + '-01').format('YY年M月'))}</span>
          <span class="flex-1 bg-gray-100 rounded h-3 overflow-hidden"><span class="block h-3 bg-blue-500" style="width:${Math.round((Number(t.bill_total) / maxBill) * 100)}%"></span></span>
          <span class="w-28 text-right whitespace-nowrap">${yen(t.bill_total)}</span>
          <span class="w-14 text-right text-gray-500">${Number(t.shifts)}件</span>
        </div>`).join('')}</div>
      <p class="text-[11px] text-gray-400 mt-2">売上は、今日までの確定・代打のシフトの請求額（単価・交通費・調整）の合計です。精算の確定前の概算を含みます</p>`
}
async function renderClientDetail(cid) {
  loading()
  if (String(CLIENT_DETAIL.cid) !== String(cid)) CLIENT_DETAIL = { cid: Number(cid), month: CLIENT_DETAIL.month }
  CLIENT_DETAIL.month = CLIENT_DETAIL.month || dayjs().format('YYYY-MM')
  const [{ data }, { data: docData }] = await Promise.all([
    axios.get('/api/admin/clients/' + cid, { params: { month: CLIENT_DETAIL.month } }),
    axios.get('/api/admin/clients/' + cid + '/documents'),
  ])
  const c = data.client; const contacts = data.contacts || []
  CLIENT_DETAIL.client = c
  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <a href="#clients" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold text-gray-900">${esc(c.client_name)}</h2>
        <div class="flex gap-2 mt-1">
          <span class="badge ${c.stream_type === 'upstream' ? 'badge-blue' : 'badge-purple'}">${c.stream_type === 'upstream' ? '上流' : '下流'}</span>
          ${c.ng_staff_ids ? '<span class="badge badge-red"><i class="fas fa-ban mr-1"></i>NGスタッフ登録あり</span>' : ''}
        </div>
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4" id="client-basic-info">${clientBasicHtml(c, false)}</section>

      <section class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-address-book text-blue-500 mr-1"></i>顧客担当者</h3>
          <button class="btn btn-outline text-xs" onclick="showClientContactForm(${Number(cid)})"><i class="fas fa-plus"></i>担当者を追加</button>
        </div>
        <div id="client-contacts-list">${clientContactsHtml(contacts, cid)}</div>
      </section>

      <section class="card p-4 lg:col-span-2" id="client-deals">${clientDealsHtml(data)}</section>

      <section class="card p-4 lg:col-span-2">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-file-signature text-blue-500 mr-1"></i>契約書</h3>
          <button class="btn btn-outline text-xs" onclick="openDocumentUpload('client', ${Number(cid)})"><i class="fas fa-upload"></i>契約書をアップロード</button>
        </div>
        <div id="client-documents-list">${documentListHtml(docData.documents, 'client', cid)}</div>
      </section>
    </div>
    <div id="client-ng-panel" class="mt-4"></div>
    <div id="client-sites-panel" class="mt-4"></div>`
  renderClientNgPanel(cid)
  // 開催場所（public/static/shift-board.js）
  if (window.renderClientSitesPanel) renderClientSitesPanel(cid)
}
// 月を切り替えたら、取引の実績の欄だけを取り直す（編集中の入力を消さない）
delegate('clientDetailMonth', async el => {
  const cid = CLIENT_DETAIL.cid; if (!cid) return
  CLIENT_DETAIL.month = el.dataset.month
  const box = document.getElementById('client-deals'); if (!box) return
  try { box.innerHTML = clientDealsHtml((await axios.get('/api/admin/clients/' + cid, { params: { month: CLIENT_DETAIL.month } })).data) }
  catch (e) { showApiError(e, '実績を読み込めませんでした') }
})
delegate('editClientBasic', () => { const box = document.getElementById('client-basic-info'); if (box && CLIENT_DETAIL.client) box.innerHTML = clientBasicHtml(CLIENT_DETAIL.client, true) })
delegate('cancelClientBasic', () => { const box = document.getElementById('client-basic-info'); if (box && CLIENT_DETAIL.client) box.innerHTML = clientBasicHtml(CLIENT_DETAIL.client, false) })
delegate('saveClientBasic', el => withSubmitLock(el, () => saveClientBasicInfo(Number(el.dataset.id))))

// クライアントのNGスタッフ（#204）。シフトボードの候補・割当、応募の承認で警告する
let CLIENT_NG = { cid: null, list: [] }
async function renderClientNgPanel(cid) {
  const host = document.getElementById('client-ng-panel'); if (!host) return
  let list, staff
  try {
    const [{ data: ng }, { data: st }] = await Promise.all([axios.get(`/api/admin/clients/${Number(cid)}/ng-staff`), axios.get('/api/admin/staff/options', { params: { include: 'all' } })])
    list = ng.staff; staff = st.staff
  } catch (e) { host.innerHTML = '<section class="card p-4 text-sm text-red-600">NGスタッフを読み込めませんでした</section>'; return }
  CLIENT_NG = { cid: Number(cid), list }
  const ngIds = new Set(list.map(s => s.staff_id))
  const EMP = { leave: '休職中', retired: '退職', preboarding: '入社予定' }
  host.innerHTML = `<section class="card p-4" id="client-ng-staff">
    <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-ban text-red-500 mr-1"></i>NGスタッフ<span class="text-[11px] font-normal text-gray-400 ml-1">（シフトの候補・割り当て・応募の承認で警告します）</span></h3>
    <div class="overflow-x-auto mb-3"><table class="tbl"><thead><tr><th>スタッフ</th><th>理由</th><th>登録</th><th></th></tr></thead><tbody>
      ${list.map(s => `<tr><td class="whitespace-nowrap"><a href="#staff/${Number(s.staff_id)}" class="font-bold text-blue-700 hover:underline">${esc(s.name)}</a>${EMP[s.employment_status] ? `<span class="badge badge-gray ml-1">${EMP[s.employment_status]}</span>` : ''}</td>
        <td class="text-xs text-gray-600 whitespace-pre-wrap">${esc(s.reason || '-')}</td>
        <td class="text-xs text-gray-400 whitespace-nowrap">${s.created_at ? esc(dayjs(s.created_at).format('YYYY/M/D')) : '-'}${s.created_by_name ? `<span class="block">${esc(s.created_by_name)}</span>` : ''}</td>
        <td class="text-right"><button class="text-xs text-red-600 hover:underline" data-action="removeClientNg" data-id="${Number(s.staff_id)}" data-name="${esc(s.name)}">解除</button></td></tr>`).join('') || '<tr><td colspan="4" class="text-center text-gray-400">NGスタッフは登録されていません</td></tr>'}
    </tbody></table></div>
    <div class="grid sm:grid-cols-12 gap-2 items-center">
      <input id="ng-filter" class="inp text-sm sm:col-span-3" placeholder="名前で絞り込み">
      <select id="ng-staff" class="inp text-sm sm:col-span-4"><option value="">スタッフを選択</option>${staff.filter(s => !ngIds.has(s.staff_id)).map(s => `<option value="${Number(s.staff_id)}">${esc(s.name)}</option>`).join('')}</select>
      <input id="ng-reason" class="inp text-sm sm:col-span-3" maxlength="500" placeholder="理由（任意）">
      <button class="btn btn-primary text-sm sm:col-span-2" data-action="addClientNg"><i class="fas fa-plus"></i>NGに追加</button>
    </div>
  </section>`
  document.getElementById('ng-filter').addEventListener('input', (ev) => {
    const q = ev.target.value.trim()
    document.querySelectorAll('#ng-staff option').forEach(o => { if (o.value) o.hidden = !!q && !o.textContent.includes(q) })
  })
}
function saveClientNg(list, el, msg) {
  return withSubmitLock(el, async () => {
    try {
      await axios.put(`/api/admin/clients/${CLIENT_NG.cid}/ng-staff`, { staff: list.map(s => ({ staff_id: s.staff_id, reason: s.reason || '' })) })
    } catch (e) { showApiError(e, '保存に失敗しました'); return }
    toast(msg)
    renderClientDetail(CLIENT_NG.cid)
  })
}
delegate('addClientNg', (el) => {
  const id = Number(document.getElementById('ng-staff').value)
  if (!id) { toast('スタッフを選択してください'); return }
  return saveClientNg([...CLIENT_NG.list, { staff_id: id, reason: document.getElementById('ng-reason').value.trim() }], el, 'NGスタッフに追加しました')
})
delegate('removeClientNg', (el) => {
  if (!confirm(`${el.dataset.name} さんをこのクライアントのNGスタッフから外しますか？`)) return
  return saveClientNg(CLIENT_NG.list.filter(s => s.staff_id !== Number(el.dataset.id)), el, 'NGスタッフから外しました')
})

// 描画した顧客担当者（編集・削除ボタンは contact_id だけを持ち、値はここから取り出す）
const CLIENT_CONTACTS = new Map()
function clientContactsHtml(contacts, cid) {
  CLIENT_CONTACTS.clear()
  contacts.forEach(ct => CLIENT_CONTACTS.set(Number(ct.contact_id), ct))
  if (contacts.length === 0) return '<p class="text-sm text-gray-400">顧客担当者が登録されていません</p>'
  return `<div class="space-y-2">${contacts.map(ct => `
    <div class="p-2.5 rounded-lg bg-gray-50">
      <div class="flex items-start justify-between gap-2">
        <div class="text-sm min-w-0">
          <p class="font-medium text-gray-800">${esc(ct.contact_name)}${ct.title ? ` <span class="text-xs text-gray-400">（${esc(ct.title)}）</span>` : ''}</p>
          <p class="text-xs text-gray-500">${[ct.branch_name, ct.department].filter(Boolean).map(esc).join(' / ') || '-'}</p>
          <p class="text-xs text-gray-500">${esc(ct.phone || '-')}　${esc(ct.email || '')}</p>
        </div>
        <div class="flex gap-1 shrink-0">
          <button class="btn btn-outline text-xs" data-action="editClientContact" data-cid="${esc(cid)}" data-id="${ct.contact_id}">編集</button>
          <button class="btn btn-danger text-xs" data-action="deleteClientContact" data-cid="${esc(cid)}" data-id="${ct.contact_id}">削除</button>
        </div>
      </div>
    </div>`).join('')}</div>`
}

window.showClientContactForm = function (cid, contact) {
  const ct = contact || {}
  modal(`
    <h3 class="font-bold text-lg mb-4">${ct.contact_id ? '担当者を編集' : '担当者を追加'}</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">顧客名（担当者氏名） *</label><input id="cc-name" class="inp" value="${esc(ct.contact_name || '')}"></div>
      <div class="grid grid-cols-2 gap-2">
        <div><label class="text-sm text-gray-600 block mb-1">支店名</label><input id="cc-branch" class="inp" value="${esc(ct.branch_name || '')}"></div>
        <div><label class="text-sm text-gray-600 block mb-1">部署名</label><input id="cc-department" class="inp" value="${esc(ct.department || '')}"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">担当者役職</label><input id="cc-title" class="inp" value="${esc(ct.title || '')}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">電話番号</label><input id="cc-phone" class="inp" value="${esc(ct.phone || '')}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">メールアドレス</label><input id="cc-email" type="email" class="inp" value="${esc(ct.email || '')}"></div>
      <p id="cc-error" class="hidden text-sm text-red-600"></p>
      <div class="flex gap-2 pt-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" onclick="saveClientContact(${cid}, ${ct.contact_id || 'null'})">保存</button>
      </div>
    </div>`)
}

window.saveClientContact = async function (cid, contactId) {
  const err = document.getElementById('cc-error')
  err.classList.add('hidden')
  const name = document.getElementById('cc-name').value.trim()
  if (!name) { err.textContent = '担当者氏名は必須です'; err.classList.remove('hidden'); return }
  const payload = {
    contact_name: name,
    branch_name: document.getElementById('cc-branch').value || null,
    department: document.getElementById('cc-department').value || null,
    title: document.getElementById('cc-title').value || null,
    phone: document.getElementById('cc-phone').value || null,
    email: document.getElementById('cc-email').value || null,
  }
  try {
    if (contactId) await axios.put(`/api/admin/clients/contacts/${contactId}`, payload)
    else await axios.post(`/api/admin/clients/${cid}/contacts`, payload)
    closeModal(); toast('担当者を保存しました'); renderClientDetail(cid)
  } catch (e) {
    err.textContent = (e.response && e.response.data && e.response.data.error) || '保存に失敗しました'
    err.classList.remove('hidden')
  }
}

window.deleteClientContact = async function (cid, contactId, name) {
  if (!confirm(`${name} を削除しますか？`)) return
  try {
    await axios.delete(`/api/admin/clients/contacts/${contactId}`)
    toast('担当者を削除しました')
    renderClientDetail(cid)
  } catch {
    toast('削除に失敗しました')
  }
}
delegate('editClientContact', el => showClientContactForm(Number(el.dataset.cid), CLIENT_CONTACTS.get(Number(el.dataset.id))))
delegate('deleteClientContact', el => {
  const ct = CLIENT_CONTACTS.get(Number(el.dataset.id))
  deleteClientContact(Number(el.dataset.cid), Number(el.dataset.id), ct ? ct.contact_name : '')
})

// 会社基本情報の保存（#307）。空欄は消す（クライアント名は必須）
window.saveClientBasicInfo = async function (cid) {
  const err = document.getElementById('cl-basic-error')
  err.classList.add('hidden')
  const v = id => document.getElementById(id).value.trim()
  if (!v('cl-name')) { err.textContent = 'クライアント名を入力してください'; err.classList.remove('hidden'); return }
  try {
    await axios.put('/api/admin/clients/' + cid, {
      client_name: v('cl-name'), stream_type: v('cl-stream'), contact_name: v('cl-contact'), phone: v('cl-phone'), email: v('cl-email'),
      address: v('cl-address'), contract_type: v('cl-contract'), billing_rule: v('cl-billing'), client_rating: Number(v('cl-rating')),
      memo: document.getElementById('cl-memo').value,
      representative_title: v('cl-rep-title'), representative_name: v('cl-rep-name'), representative_kana: v('cl-rep-kana'), invoice_number: v('cl-invoice'),
    })
    toast('会社基本情報を保存しました')
    renderClientDetail(cid)
  } catch (e) {
    err.textContent = (e.response && e.response.data && e.response.data.error) || '保存に失敗しました'
    err.classList.remove('hidden')
  }
}

// ============ 社員名簿（自社社員のみ表示） ============
const EMP_STATUS_LABEL = { working: '在職中', leave: '休職中', retired: '退職', preboarding: '入社予定' }
// 契約終了日（30日以内は強調し、過ぎても在職中なら『終了日超過』）と、有給の付与日（前回の付与日と、1年後の次回の付与日）。#282
const EMP_CONTRACT_WARN_DAYS = 30
function empContractEndCell(e) {
  if (!e.contract_end) return '<span class="text-gray-300">-</span>'
  const left = dayjs(e.contract_end).diff(dayjs().format('YYYY-MM-DD'), 'day')
  const retired = e.employment_status === 'retired'
  const badge = retired ? '' : left < 0 ? ' <span class="badge badge-red text-[10px]">終了日超過</span>'
    : left <= EMP_CONTRACT_WARN_DAYS ? ` <span class="badge badge-yellow text-[10px]">${left ? 'あと' + left + '日' : '今日まで'}</span>` : ''
  return `<span class="${!retired && left <= EMP_CONTRACT_WARN_DAYS ? 'font-bold text-red-700' : ''}">${esc(e.contract_end)}</span>${badge}`
}
function empLeaveGrantCell(e) {
  if (!e.paid_leave_granted_at) return '<span class="text-gray-300">-</span>'
  const today = dayjs().format('YYYY-MM-DD')
  const next = e.paid_leave_granted_at > today ? dayjs(e.paid_leave_granted_at) : dayjs(e.paid_leave_granted_at).add(1, 'year')
  const left = next.diff(today, 'day')
  const warn = e.employment_status !== 'retired' && left <= 14
  return `${esc(e.paid_leave_granted_at)}<span class="block text-[11px] ${warn ? 'text-red-700 font-bold' : 'text-gray-400'}">次回 ${esc(next.format('YYYY-MM-DD'))}${warn ? (left < 0 ? '（過ぎています）' : `（あと${left}日）`) : ''}</span>`
}

async function renderEmployees() {
  loading()
  const { data } = await axios.get('/api/admin/employees')
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-xl font-bold text-gray-900">従業員管理 <span class="text-sm font-normal text-gray-400">（社員名簿）</span></h2>
      <div class="flex items-center gap-3 flex-wrap">
        <p class="text-sm text-gray-400"><i class="fas fa-lock mr-1"></i>自社雇用者のみ表示。雇用・給与・口座等は他社に一切共有されません</p>
        <button class="btn btn-primary" onclick="showRosterForm('employee')"><i class="fas fa-user-plus"></i>従業員を登録</button>
      </div>
    </div>
    <section class="card p-3 mb-4 flex flex-wrap items-center gap-2 text-sm" id="emp-export">
      <span class="text-xs font-bold text-gray-600"><i class="fas fa-file-csv text-blue-500 mr-1"></i>従業員名簿のCSV</span>
      <select id="emp-export-status" class="inp text-sm w-auto">
        <option value="">自社雇用のすべて</option>${Object.entries(EMP_STATUS_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}<option value="ended">雇用終了（他の区分へ移行・統合）</option>
      </select>
      ${ME && ME.role === 'company_admin' ? '<label class="flex items-center gap-1 text-xs"><input type="checkbox" id="emp-export-pay">口座・給与を含める（会社管理者のみ）</label>' : ''}
      <button class="btn btn-outline text-sm" data-action="exportEmployees"><i class="fas fa-download"></i>出力</button>
      <span class="text-[11px] text-gray-400">社員番号・氏名・入社日・契約・住所・連絡先・保険番号を出します。出力した記録が残ります</span>
    </section>
    <section class="card p-4">
      <input id="emp-q" class="inp text-sm mb-3" placeholder="社員番号・氏名・フリガナ・所属・役職・拠点で検索">
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>社員番号</th><th>氏名</th><th>フリガナ</th><th>在籍確認</th><th>所属</th><th>役職</th><th>拠点</th><th>契約形態</th><th>契約終了</th><th>有給付与日</th></tr></thead>
          <tbody>
            ${data.employees.length === 0 ? '<tr><td colspan="10" class="text-center text-gray-400 py-6">自社社員が登録されていません</td></tr>' : data.employees.map(e => `
              <tr class="cursor-pointer" data-action="openEmployee" data-id="${Number(e.staff_id)}" data-search="${escAttr([e.employee_number, e.name, e.kana, e.department, e.job_title, e.base_location].filter(Boolean).join(' '))}">
                <td>${esc(e.employee_number || '-')}</td>
                <td class="text-blue-600 hover:underline">${esc(e.name)}</td>
                <td>${esc(e.kana || '-')}</td>
                <td><span class="badge ${e.employment_status === 'retired' ? 'badge-gray' : e.employment_status === 'leave' ? 'badge-yellow' : e.employment_status === 'preboarding' ? 'badge-purple' : 'badge-green'}">${EMP_STATUS_LABEL[e.employment_status] || '在職中'}</span></td>
                <td>${esc(e.department || '-')}</td>
                <td>${esc(e.job_title || '-')}</td>
                <td>${esc(e.base_location || '-')}</td>
                <td>${esc(e.contract_type || '-')}</td>
                <td class="whitespace-nowrap">${empContractEndCell(e)}</td>
                <td class="whitespace-nowrap">${empLeaveGrantCell(e)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
    ${(data.ended || []).length ? `<section class="card p-4 mt-4" id="employees-ended">
      <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-box-archive text-gray-400 mr-1"></i>雇用終了（他の区分へ移行・統合したスタッフ）</h3>
      <p class="text-xs text-gray-400 mb-2">従業員管理のデータは閲覧のみで保持しています（7年保存）。スタッフとしての稼働はスタッフマスタで管理します</p>
      <div class="overflow-x-auto"><table class="tbl"><thead><tr><th>社員番号</th><th>氏名</th><th>現在の区分</th><th>雇用終了日</th><th>理由</th></tr></thead><tbody>
        ${data.ended.map(e => `<tr class="cursor-pointer" data-action="openEmployee" data-id="${Number(e.staff_id)}"><td>${esc(e.employee_number || '-')}</td><td class="text-blue-600">${esc(e.name)}</td>
          <td>${e.merged_into_staff_id ? '<span class="badge badge-gray">統合済み</span>' : affTypeBadge(e.affiliation_type)}</td><td>${esc(e.employment_ended_at)}</td><td class="text-xs text-gray-500">${esc(e.ended_reason || '')}</td></tr>`).join('')}
      </tbody></table></div>
    </section>` : ''}`
  document.getElementById('emp-q').addEventListener('input', ev => {
    const q = ev.target.value
    document.querySelectorAll('tr[data-search]').forEach(tr => { tr.hidden = !matchesKeyword(q, [tr.dataset.search]) })
  })
}

// 従業員名簿の CSV（#431）
delegate('exportEmployees', () => {
  const status = document.getElementById('emp-export-status').value
  const pay = document.getElementById('emp-export-pay')
  if (pay && pay.checked && !confirm('口座番号・給与を含めた名簿を出力します。ファイルの扱い（保存場所・共有先）に注意してください。よろしいですか？')) return
  const q = new URLSearchParams()
  if (status) q.set('status', status)
  if (pay && pay.checked) q.set('include_pay', '1')
  location.href = '/api/admin/employees/export' + (q.toString() ? '?' + q : '')
})

async function renderEmployeeDetail(sid) {
  loading()
  const [{ data }, { data: docData }] = await Promise.all([
    axios.get('/api/admin/employees/' + sid),
    axios.get('/api/admin/employees/' + sid + '/documents'),
  ])
  const s = data.staff; const r = data.record || {}
  const field = (id, label, value, type = 'text') =>
    `<div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">${label}</dt><dd class="flex-1"><input type="${type}" id="${id}" class="inp text-xs" value="${esc(value ?? '')}"></dd></div>`

  $app.innerHTML = `
    <div class="flex items-center gap-3 mb-5 flex-wrap">
      <a href="#employees" class="btn btn-outline"><i class="fas fa-arrow-left"></i></a>
      <div class="flex-1">
        <h2 class="text-xl font-bold text-gray-900">${esc(s.name)}</h2>
        <div class="flex gap-2 mt-1">
          <span class="badge ${s.employment_status === 'retired' ? 'badge-gray' : s.employment_status === 'leave' ? 'badge-yellow' : s.employment_status === 'preboarding' ? 'badge-purple' : 'badge-green'}">${EMP_STATUS_LABEL[s.employment_status] || '在職中'}</span>
        </div>
      </div>
      <a class="btn btn-outline" href="#staff/${sid}"><i class="fas fa-user"></i>スタッフ情報を見る</a>
      <button class="btn btn-primary" onclick="saveEmployeeRecord(${sid})"><i class="fas fa-floppy-disk"></i>保存</button>
    </div>

    <section class="card p-4 mb-4" id="employee-staff-profile">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 class="text-sm font-bold text-gray-700">スタッフ基本情報 <span class="text-xs font-normal text-gray-400">（スタッフマスタにそのまま反映されます）</span></h3>
        <span class="text-xs text-gray-400"><i class="fas fa-circle-info mr-1"></i>自社雇用スタッフの労務側の基本情報はこの画面でのみ編集できます</span>
      </div>
      <dl class="grid md:grid-cols-2 gap-x-6 gap-y-2">
        ${field('sp-name', '氏名 *', s.name)}
        ${field('sp-kana', 'フリガナ', s.kana || '')}
        <div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">性別 *</dt><dd class="flex-1"><select id="sp-gender" class="inp text-xs">${genderOptions(s.gender)}</select></dd></div>
        ${field('sp-dob', '生年月日', s.date_of_birth, 'date')}
        <div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">年齢</dt><dd class="text-xs">${s.age != null ? s.age + '歳' : '-'}</dd></div>
        <div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">在籍状況</dt><dd class="flex-1">
          <select id="sp-emp-status" class="inp text-xs">
            ${Object.entries(EMP_STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${(s.employment_status || 'working') === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></dd></div>
        ${field('sp-retired', '退職日', s.retired_at, 'date')}
        <div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">所属会社名</dt><dd class="text-xs">${esc(s.affiliation || '')}${data.read_only ? `（現在: ${esc(AFF_TYPE_LABEL[s.affiliation_type] || s.affiliation_type || '')}）` : '（自社）'}</dd></div>
        ${field('sp-station-line', '最寄駅（路線）', s.nearest_station_line || '')}
        ${field('sp-station', '最寄駅（駅）', s.nearest_station || '')}
      </dl>
      <div class="mt-3 pt-3 border-t border-gray-100 text-xs" id="employee-business-summary">
        <div class="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <p class="text-gray-500"><i class="fas fa-briefcase mr-1 text-gray-400"></i>業務側の情報（通勤可能時間・稼働開始可能日・稼働可能エリア・スキル・経歴・PRポイント・備考）はスタッフマスタで編集します</p>
          ${data.read_only ? '' : `<a class="btn btn-outline text-xs" href="#staff/${sid}"><i class="fas fa-pen"></i>スタッフマスタで編集</a>`}
        </div>
        <dl class="grid md:grid-cols-2 gap-x-6 gap-y-1 text-gray-600">
          <div class="flex gap-2"><dt class="w-32 text-gray-400 shrink-0">通勤可能時間</dt><dd>${s.commute_minutes != null ? esc(s.commute_minutes) + '分' : '-'}</dd></div>
          <div class="flex gap-2"><dt class="w-32 text-gray-400 shrink-0">稼働開始可能日</dt><dd>${esc(s.available_from || '-')}</dd></div>
          <div class="flex gap-2"><dt class="w-32 text-gray-400 shrink-0">稼働可能エリア</dt><dd>${esc(s.work_area || '-')}</dd></div>
          <div class="flex gap-2"><dt class="w-32 text-gray-400 shrink-0">スキル</dt><dd>${esc(s.skills || '-')}</dd></div>
          <div class="flex gap-2 md:col-span-2"><dt class="w-32 text-gray-400 shrink-0">経歴</dt><dd class="whitespace-pre-wrap">${esc(s.career || '-')}</dd></div>
        </dl>
      </div>
      <p class="text-xs text-gray-400 mt-2">※ 退職日を設定すると在籍状況は「退職」になります。退職日から7年経過すると出退勤記録等が定期削除の対象になります。</p>
    </section>

    <div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">在籍・雇用情報</h3>
        <dl class="space-y-2">
          ${field('emp-number', '社員番号', r.employee_number)}
          ${field('emp-hire-date', '入社年月日', r.hire_date, 'date')}
          <div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">勤続年月</dt><dd class="text-xs">${esc(r.tenure || '-')}</dd></div>
          ${field('emp-location', '拠点', r.base_location)}
          ${field('emp-department', '所属', r.department)}
          ${field('emp-job-title', '役職', r.job_title)}
          ${field('emp-contract-type', '契約形態', r.contract_type)}
          ${field('emp-work-style', '勤務形態', r.work_style)}
          ${field('emp-hours', '所定労働時間', r.scheduled_hours, 'number')}
          ${field('emp-days-week', '所定労働日数(週)', r.scheduled_days_week, 'number')}
          ${field('emp-days-month', '所定労働日数(月)', r.scheduled_days_month, 'number')}
        </dl>
        <div class="mt-4 pt-3 border-t border-gray-100">
          <div class="flex items-center justify-between mb-2">
            <h4 class="text-xs font-bold text-gray-500"><i class="fas fa-file-lines text-blue-500 mr-1"></i>入社時書類</h4>
            <button class="btn btn-outline text-xs" onclick="openDocumentUpload('employee', ${sid})"><i class="fas fa-upload"></i>アップロード</button>
          </div>
          <div id="employee-documents-list">${documentListHtml(docData.documents, 'employee', sid)}</div>
        </div>
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">個人情報</h3>
        <dl class="space-y-2">
          ${field('emp-postal', '郵便番号', r.postal_code)}
          ${field('emp-pref', '都道府県', r.prefecture)}
          ${field('emp-city', '市区町村', r.city)}
          ${field('emp-town', '町名', r.town)}
          ${field('emp-address', '住所', r.address_detail)}
          ${field('emp-personal-email', 'メアド（個人）', r.personal_email)}
          ${field('emp-phone-main', '電話番号（メイン）', r.phone_main)}
          ${field('emp-phone-work', '電話番号（業務）', r.phone_work)}
          ${field('emp-dependents-info', '扶養情報', r.dependents_info)}
          ${field('emp-dependents-count', '扶養人数', r.dependents_count, 'number')}
          <p class="text-xs text-gray-400 pt-1">マイナンバーは今回のバージョンでは保存されません（項目のみ用意）</p>
          <div class="flex items-center gap-2"><dt class="w-32 text-gray-400 text-xs shrink-0">マイナンバー</dt><dd class="flex-1"><input class="inp text-xs bg-gray-50" disabled placeholder="未実装（保存されません）"></dd></div>
        </dl>
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">緊急連絡先</h3>
        <dl class="space-y-2">
          ${field('emp-em-name', '名前', r.emergency_name)}
          ${field('emp-em-kana', 'フリガナ', r.emergency_kana)}
          ${field('emp-em-relationship', '続柄', r.emergency_relationship)}
          ${field('emp-em-phone', '電話番号', r.emergency_phone)}
          ${field('emp-em-postal', '郵便番号', r.emergency_postal_code)}
          ${field('emp-em-pref', '都道府県', r.emergency_prefecture)}
          ${field('emp-em-city', '市区町村', r.emergency_city)}
          ${field('emp-em-town', '町名', r.emergency_town)}
          ${field('emp-em-address', '住所', r.emergency_address)}
        </dl>
      </section>

      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">給与・契約・保険</h3>
        <dl class="space-y-2">
          ${field('emp-contract-start', '契約開始', r.contract_start, 'date')}
          ${field('emp-contract-end', '契約終了', r.contract_end, 'date')}
          ${field('emp-bank-code', '銀行コード', r.bank_code)}
          ${field('emp-bank-name', '銀行名', r.bank_name)}
          ${field('emp-branch-name', '支店名', r.branch_name)}
          ${field('emp-branch-code', '支店番号', r.branch_code)}
          ${field('emp-account-type', '種別', r.account_type)}
          ${field('emp-account-number', '口座番号', r.account_number)}
          ${field('emp-salary-type', '基本給種別', r.base_salary_type)}
          ${field('emp-salary', '基本給', r.base_salary, 'number')}
          ${field('emp-ot-hours', '固定残業時間', r.fixed_overtime_hours, 'number')}
          ${field('emp-ot-pay', '固定残業代', r.fixed_overtime_pay, 'number')}
          ${field('emp-gross', '総支給額', r.gross_pay, 'number')}
          ${field('emp-position-note', '役職手当（摘要）', r.position_allowance_note)}
          ${field('emp-position-pay', '役職手当', r.position_allowance, 'number')}
          ${field('emp-sales-note', '営業手当（摘要）', r.sales_allowance_note)}
          ${field('emp-sales-pay', '営業手当', r.sales_allowance, 'number')}
          ${field('emp-deduction-note', 'その他控除（摘要）', r.other_deduction_note)}
          ${field('emp-deduction', 'その他控除', r.other_deduction, 'number')}
          ${field('emp-emp-ins', '雇用保険被保険者番号', r.employment_insurance_no)}
          ${field('emp-soc-ins', '社会保険番号', r.social_insurance_no)}
          ${field('emp-leave-granted', '有給付与日', r.paid_leave_granted_at, 'date')}
          ${field('emp-leave-remaining', '有給残数', r.paid_leave_remaining, 'number')}
          ${field('emp-telework', '今月テレワーク残数', r.telework_remaining_this_month, 'number')}
        </dl>
      </section>
    </div>`
  // 雇用終了（他の区分へ移行）した従業員は閲覧のみ（第2段階）
  if (data.read_only) {
    $app.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true })
    $app.querySelectorAll('button[onclick^="saveEmployeeRecord"], button[onclick^="openDocumentUpload"], button[data-action="deleteDocument"]').forEach(el => el.remove())
    const head = $app.querySelector('#employee-staff-profile')
    if (head) head.insertAdjacentHTML('beforebegin', `<div class="text-sm bg-gray-100 text-gray-700 rounded-lg p-3 mb-4" id="employee-ended-notice">
      <i class="fas fa-box-archive mr-1"></i>雇用終了日: <b>${esc(r.employment_ended_at || '-')}</b>（${esc(r.ended_reason || '')}）。従業員管理のデータは閲覧のみで保持しています（7年保存）。
      自社雇用に戻す場合はスタッフ詳細の「区分を変更」から行ってください。</div>`)
  }
}

window.saveEmployeeRecord = async function (sid) {
  const num = (id) => { const v = document.getElementById(id).value; return v === '' ? null : Number(v) }
  const str = (id) => document.getElementById(id).value || null
  const raw = (id) => document.getElementById(id).value
  // スタッフ基本情報（スタッフマスタに反映）。在籍状況と退職日は、変えたときだけ送る（#139）
  const retiredEl = document.getElementById('sp-retired'), statusEl = document.getElementById('sp-emp-status')
  const retired = retiredEl.value, empStatus = statusEl.value
  const origRetired = retiredEl.defaultValue
  const origStatus = ([...statusEl.options].find(o => o.defaultSelected) || statusEl.options[0]).value
  if (!raw('sp-name').trim()) { toast('氏名を入力してください'); return }
  if (!raw('sp-gender')) { toast('性別を選択してください'); return }
  const profile = {
    name: raw('sp-name').trim(), kana: raw('sp-kana'), gender: raw('sp-gender'), date_of_birth: str('sp-dob'),
    nearest_station_line: raw('sp-station-line'), nearest_station: raw('sp-station'),
  }
  if (retired !== origRetired || empStatus !== origStatus) {
    const r = retirementBody(empStatus, retired, origRetired)
    if (r.error) { toast(r.error); return }
    if (r.confirm && !confirm(r.confirm)) return
    Object.assign(profile, r.body)
  }
  try {
    const saved = await putConfirmingRetiredAt('/api/admin/employees/' + sid, {
      profile,
      employee_number: str('emp-number'), hire_date: str('emp-hire-date'), base_location: str('emp-location'),
      department: str('emp-department'), job_title: str('emp-job-title'), contract_type: str('emp-contract-type'),
      work_style: str('emp-work-style'), scheduled_hours: num('emp-hours'), scheduled_days_week: num('emp-days-week'),
      scheduled_days_month: num('emp-days-month'),
      postal_code: str('emp-postal'), prefecture: str('emp-pref'), city: str('emp-city'), town: str('emp-town'),
      address_detail: str('emp-address'), personal_email: str('emp-personal-email'), phone_main: str('emp-phone-main'),
      phone_work: str('emp-phone-work'), dependents_info: str('emp-dependents-info'), dependents_count: num('emp-dependents-count'),
      emergency_name: str('emp-em-name'), emergency_kana: str('emp-em-kana'), emergency_relationship: str('emp-em-relationship'),
      emergency_phone: str('emp-em-phone'), emergency_postal_code: str('emp-em-postal'), emergency_prefecture: str('emp-em-pref'),
      emergency_city: str('emp-em-city'), emergency_town: str('emp-em-town'), emergency_address: str('emp-em-address'),
      contract_start: str('emp-contract-start'), contract_end: str('emp-contract-end'),
      bank_code: str('emp-bank-code'), bank_name: str('emp-bank-name'), branch_name: str('emp-branch-name'),
      branch_code: str('emp-branch-code'), account_type: str('emp-account-type'), account_number: str('emp-account-number'),
      base_salary_type: str('emp-salary-type'), base_salary: num('emp-salary'), fixed_overtime_hours: num('emp-ot-hours'),
      fixed_overtime_pay: num('emp-ot-pay'), gross_pay: num('emp-gross'),
      position_allowance_note: str('emp-position-note'), position_allowance: num('emp-position-pay'),
      sales_allowance_note: str('emp-sales-note'), sales_allowance: num('emp-sales-pay'),
      other_deduction_note: str('emp-deduction-note'), other_deduction: num('emp-deduction'),
      employment_insurance_no: str('emp-emp-ins'), social_insurance_no: str('emp-soc-ins'),
      paid_leave_granted_at: str('emp-leave-granted'), paid_leave_remaining: num('emp-leave-remaining'),
      telework_remaining_this_month: num('emp-telework'),
    }, profile)
    if (!saved) return
    toast('従業員情報を保存しました（スタッフマスタにも反映されます）')
    renderEmployeeDetail(sid)
  } catch (e) {
    toast((e.response && e.response.data && e.response.data.error) || '保存に失敗しました')
  }
}

window.showAddClient = function () {
  modal(`
    <h3 class="font-bold text-lg mb-4">クライアント登録</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">クライアント名 *</label><input id="nc-name" class="inp"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">上流/下流</label>
          <select id="nc-stream" class="inp"><option value="upstream">上流</option><option value="downstream">下流</option></select></div>
        <div><label class="text-sm text-gray-600 block mb-1">契約形態</label>
          <select id="nc-contract" class="inp"><option>業務委託</option><option>派遣</option><option>請負</option><option>紹介</option></select></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">担当者</label><input id="nc-contact" class="inp"></div>
        <div><label class="text-sm text-gray-600 block mb-1">電話</label><input id="nc-phone" class="inp" type="tel"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">メール</label><input id="nc-email" class="inp" type="email"></div>
        <div><label class="text-sm text-gray-600 block mb-1">住所</label><input id="nc-address" class="inp"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">請求条件</label><input id="nc-billing" class="inp" placeholder="月末締め・翌月末払い"></div>
      <div><label class="text-sm text-gray-600 block mb-1">備考</label><textarea id="nc-memo" rows="2" class="inp"></textarea></div>
      <button class="btn btn-primary w-full" data-action="addClient">登録する</button>
    </div>`)
}
delegate('addClient', el => withSubmitLock(el, addClient))
window.addClient = async function () {
  const name = document.getElementById('nc-name').value.trim()
  if (!name) { toast('クライアント名を入力してください'); return }
  try {
    const res = await postConfirmingDuplicate('/api/admin/clients', {
      client_name: name, stream_type: document.getElementById('nc-stream').value,
      contract_type: document.getElementById('nc-contract').value, contact_name: document.getElementById('nc-contact').value,
      phone: document.getElementById('nc-phone').value, billing_rule: document.getElementById('nc-billing').value,
      email: document.getElementById('nc-email').value.trim(), address: document.getElementById('nc-address').value,
      memo: document.getElementById('nc-memo').value
    })
    if (!res) return
    closeModal(); toast('クライアントを登録しました'); renderClients()
  } catch (e) { showApiError(e, 'クライアントの登録に失敗しました') }
}

// ============ シフト管理 ============
// 表示中の週の初日。確定・欠勤・代打・削除・登録の後も、同じ週を出し直す（#551）
let shiftsWeekFrom = null
function refreshShiftWeek(date) {
  let from = shiftsWeekFrom || dayjs().format('YYYY-MM-DD')
  // 登録した日が表示中の週の外なら、週の区切り（曜日）を保ったまま、その日を含む週へ移る
  const off = date ? dayjs(date).diff(dayjs(from), 'day') : 0
  if (off < 0 || off > 6) from = dayjs(from).add(Math.floor(off / 7) * 7, 'day').format('YYYY-MM-DD')
  return renderShifts(from)
}
async function renderShifts(dateStr) {
  loading()
  const from = dateStr || dayjs().format('YYYY-MM-DD')
  shiftsWeekFrom = from
  const to = dayjs(from).add(6, 'day').format('YYYY-MM-DD')
  const { data } = await axios.get(`/api/admin/shifts?from=${from}&to=${to}`)
  const days = []
  for (let i = 0; i < 7; i++) days.push(dayjs(from).add(i, 'day').format('YYYY-MM-DD'))
  const byDay = {}
  for (const s of data.shifts) { (byDay[s.work_date] = byDay[s.work_date] || []).push(s) }
  const stColor = { requested: 'bg-amber-50 border-amber-200', confirmed: 'bg-blue-50 border-blue-200', absent: 'bg-red-50 border-red-200 opacity-60', substitute: 'bg-purple-50 border-purple-200' }
  const stLabel = { requested: '希望', confirmed: '確定', absent: '欠勤', substitute: '代打' }

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">シフト管理</h2>
      <div class="flex gap-2">
        <button class="btn btn-outline" onclick="renderShifts('${dayjs(from).subtract(7, 'day').format('YYYY-MM-DD')}')"><i class="fas fa-chevron-left"></i>前週</button>
        <button class="btn btn-outline" onclick="renderShifts()">今週</button>
        <button class="btn btn-outline" onclick="renderShifts('${dayjs(from).add(7, 'day').format('YYYY-MM-DD')}')">翌週<i class="fas fa-chevron-right"></i></button>
        <button class="btn btn-primary" onclick="showAddShift('${from}')"><i class="fas fa-plus"></i>シフト登録</button>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-7 gap-2" id="shift-week">
      ${days.map(d => {
        const isToday = d === dayjs().format('YYYY-MM-DD')
        const dow = ['日', '月', '火', '水', '木', '金', '土'][dayjs(d).day()]
        return `<div class="card p-2 ${isToday ? 'ring-2 ring-blue-400' : ''}">
          <p class="text-xs font-bold text-center mb-2 ${dayjs(d).day() === 0 ? 'text-red-500' : dayjs(d).day() === 6 ? 'text-blue-500' : 'text-gray-600'}">
            ${dayjs(d).format('M/D')}(${dow})${isToday ? ' <span class="badge badge-blue">今日</span>' : ''}</p>
          <div class="space-y-1.5">
            ${(byDay[d] || []).map(s => `
              <div class="border rounded-lg p-1.5 text-xs ${stColor[s.status] || ''} cursor-pointer" data-action="showEditShift" data-id="${s.shift_id}" data-name="${esc(s.staff_name)}" data-status="${esc(s.status)}">
                <p class="font-bold truncate">${esc(s.staff_name)}</p>
                <p class="text-gray-500 truncate">${esc(s.project_name)}</p>
                <p class="text-gray-400">${esc(s.start_time)}〜${esc(s.end_time)} <span class="font-bold">${stLabel[s.status] || ''}</span>
                  ${Number(s.photo_count) > 0 ? `<button class="text-blue-500 ml-1" title="入店・退店の写真" data-action="attendancePhotos" data-id="${Number(s.shift_id)}" data-name="${esc(s.staff_name)}"><i class="fas fa-camera"></i></button>` : ''}</p>
              </div>`).join('') || '<p class="text-xs text-gray-300 text-center py-2">-</p>'}
          </div>
        </div>`
      }).join('')}
    </div>`
}

window.showAddShift = async function (defaultDate) {
  // スタッフは選択肢用の軽いAPIで取る（#463）。割り当てられる人だけが返る（退職・停止・統合・スキルシートのみ・取引終了・所属元で退職を除く #94）
  const [{ data: st }, { data: pj }] = await Promise.all([axios.get('/api/admin/staff/options'), axios.get('/api/admin/projects')])
  const staff = st.staff.filter(s => s.assignable !== 0)
  addShiftProjects = pj.projects.filter(p => p.status === 'active')
  modal(`
    <h3 class="font-bold text-lg mb-4">シフト登録</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">スタッフ *</label>
          <select id="sh-staff" class="inp">${staff.map(s => `<option value="${s.staff_id}">${esc(s.name)}${s.employment_status === 'leave' ? '（休職中）' : ''}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">案件 *</label>
          <select id="sh-project" class="inp" onchange="addShiftFeeHint()">${addShiftProjects.map(p => `<option value="${p.project_id}">${esc(p.project_name)}</option>`).join('')}</select></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">日付 *</label><input id="sh-date" type="date" class="inp" value="${defaultDate || ''}"></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">開始</label><input id="sh-start" type="time" value="09:30" class="inp"></div>
        <div><label class="text-sm text-gray-600 block mb-1">終了</label><input id="sh-end" type="time" value="19:00" class="inp"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">状態</label>
          <select id="sh-status" class="inp"><option value="confirmed">確定</option><option value="requested">希望</option><option value="substitute">代打</option></select></div>
        <div><label class="text-sm text-gray-600 block mb-1">交通費（実費）</label><input id="sh-fee" type="number" min="0" class="inp" placeholder="空欄なら0円">
          <p id="sh-fee-hint" class="text-[11px] text-gray-400 mt-1"></p></div>
      </div>
      <button class="btn btn-primary w-full" data-action="addShift">登録する</button>
    </div>`)
  addShiftFeeHint()
}
// 案件の交通費ルール（実費の入力が請求・支払にどう効くか）を入力欄の下に出す（#94）
let addShiftProjects = []
const BILL_TRANSPORT_LABEL = { actual: '実費', fixed: '定額', included: '単価に含む' }
const PAY_TRANSPORT_LABEL = { actual: '実費', capped: '上限あり', fixed: '定額', none: '支給なし' }
window.addShiftFeeHint = function () {
  const el = document.getElementById('sh-fee-hint'); if (!el) return
  const p = addShiftProjects.find(x => String(x.project_id) === document.getElementById('sh-project').value)
  if (!p) { el.textContent = ''; return }
  const bt = p.bill_transport_type || 'actual', pt = p.pay_transport_type || 'actual'
  el.textContent = `案件の交通費: 請求 ${BILL_TRANSPORT_LABEL[bt] || bt}${bt === 'fixed' ? ' ' + Number(p.bill_transport_amount || 0) + '円' : ''}`
    + ` ／ 支払 ${PAY_TRANSPORT_LABEL[pt] || pt}${pt === 'fixed' || pt === 'capped' ? ' ' + Number(p.pay_transport_amount || 0) + '円' : ''}`
}
// 重複・NG・休職中があれば内容を出して確認し、確認できたら force で登録する（シフトボードと同じ流れ #94）
window.addShift = async function (force) {
  const date = document.getElementById('sh-date').value
  if (!date) { toast('日付を選択してください'); return }
  const staffId = document.getElementById('sh-staff').value
  if (!staffId) { toast('スタッフを選択してください'); return }
  const fee = document.getElementById('sh-fee').value
  try {
    await axios.post('/api/admin/shifts', {
      staff_id: Number(staffId), project_id: document.getElementById('sh-project').value,
      work_date: date, start_time: document.getElementById('sh-start').value, end_time: document.getElementById('sh-end').value,
      status: document.getElementById('sh-status').value, transportation_fee: fee === '' ? null : Number(fee),
      confirm_warnings: true, force: !!force,
    })
  } catch (e) {
    const d = e.response && e.response.data
    if (d && d.need_force) { if (confirm(d.warnings.join('\n') + '\n\nこのまま登録しますか？')) return addShift(true); return }
    showApiError(e, '登録に失敗しました'); return
  }
  closeModal(); toast('シフトを登録しました'); refreshShiftWeek(date)
}
delegate('addShift', el => withSubmitLock(el, () => addShift()))

window.showEditShift = function (shiftId, staffName, status) {
  modal(`
    <h3 class="font-bold text-lg mb-4">シフト操作 — ${esc(staffName)}</h3>
    <div class="space-y-2">
      <button class="btn btn-outline w-full" onclick="updateShift(${shiftId}, 'confirmed')"><i class="fas fa-check text-emerald-500"></i>確定にする</button>
      <button class="btn btn-outline w-full" onclick="updateShift(${shiftId}, 'absent')"><i class="fas fa-user-xmark text-red-500"></i>欠勤にする</button>
      <button class="btn btn-outline w-full" onclick="updateShift(${shiftId}, 'substitute')"><i class="fas fa-people-arrows text-purple-500"></i>代打にする</button>
      <button class="btn btn-danger w-full" onclick="deleteShift(${shiftId})"><i class="fas fa-trash"></i>削除する</button>
    </div>
    <div class="mt-4 pt-3 border-t"><p class="text-sm font-bold text-gray-700 mb-2">勤怠報告の写真</p><div id="edit-shift-photos"></div></div>
    <div id="edit-shift-withdrawals"></div>`)
  loadAttendancePhotos(document.getElementById('edit-shift-photos'), shiftId)
  loadAttendanceWithdrawals(document.getElementById('edit-shift-withdrawals'), shiftId)
}
delegate('showEditShift', el => showEditShift(Number(el.dataset.id), el.dataset.name, el.dataset.status))
// スタッフ本人が押し間違いで取り消した勤怠報告の記録（#323）。無ければ何も出さない
async function loadAttendanceWithdrawals(box, shiftId) {
  if (!box) return
  let data
  try { data = (await axios.get('/api/admin/shifts/' + Number(shiftId) + '/attendance-withdrawals')).data } catch (e) { return }
  if (!data.withdrawals.length) return
  box.innerHTML = `<div class="mt-4 pt-3 border-t"><p class="text-sm font-bold text-gray-700 mb-2">本人が取り消した報告</p>
    <ul class="space-y-1">${data.withdrawals.map(w => `<li class="text-xs text-gray-600"><i class="fas fa-rotate-left text-gray-400 mr-1"></i>${esc(w.body || w.title)}</li>`).join('')}</ul></div>`
}

// ============ 勤怠報告の写真（入店・退店。#217） ============
// 他の画面からも使えるように、data-action="attendancePhotos" data-id="シフトID" data-name="スタッフ名" のボタンで開く。
// 写真は GET /api/admin/attendance-photo/:attendance_id（自社のシフトの報告だけ返す）。クリックで原寸を別タブに開く
const PHOTO_REPORT_LABEL = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店' }
const PHOTO_ENTRY_LABEL = { app: 'アプリ', link: '報告用URL', proxy: '代理入力' }
const PHOTO_SOURCE_LABEL = { camera: 'カメラで撮影', album: 'アルバムから選択' }
// 写真を送れないときの扱い（会社設定。#535）: 許可すると、スタッフは理由を選んで写真なしで入店・退店を報告できる（理由は報告状況・写真の一覧に出る）
delegate('photoSkipSetting', async () => {
  let d
  try { d = (await axios.get('/api/admin/settings/photo-skip')).data } catch (e) { showApiError(e, '設定を読み込めませんでした'); return }
  modal(`<h3 class="font-bold text-lg mb-2">写真を送れないときの扱い</h3>
    <p class="text-sm text-gray-600 mb-3">店舗が撮影禁止・カメラが使えないなどで写真を送れないとき、スタッフが理由を選んで写真なしで入店・退店を報告できるようにします（アプリと報告用URL）。写真なしの報告と理由は、シフトの報告状況と写真の一覧に表示されます。</p>
    <p class="text-xs text-gray-500 mb-3">選べる理由: ${Object.values(d.reasons || {}).map(esc).join('・')}</p>
    <p class="text-sm mb-4">現在: <span class="badge ${d.enabled ? 'badge-green' : 'badge-gray'}">${d.enabled ? '写真なしの報告を許可' : '許可しない（担当者に連絡してもらう）'}</span></p>
    <div class="flex gap-2"><button class="btn btn-outline flex-1" onclick="closeModal()">閉じる</button>
      <button class="btn btn-primary flex-1" data-action="savePhotoSkip" data-enabled="${d.enabled ? '0' : '1'}">${d.enabled ? '許可をやめる' : '許可する'}</button></div>`)
})
delegate('savePhotoSkip', (el) => withSubmitLock(el, async () => {
  try {
    await axios.post('/api/admin/settings/photo-skip', { enabled: el.dataset.enabled === '1' })
    closeModal(); toast(el.dataset.enabled === '1' ? '写真なしの報告を許可しました' : '写真なしの報告を許可しないようにしました')
  } catch (e) { showApiError(e, '設定の更新に失敗しました') }
}))
async function loadAttendancePhotos(box, shiftId) {
  if (!box) return
  box.innerHTML = '<span class="spin"></span>'
  let data
  try { data = (await axios.get('/api/admin/shifts/' + Number(shiftId) + '/attendance-photos')).data } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">${esc((e.response && e.response.data && e.response.data.error) || '写真を読み込めませんでした')}</p>`
    return
  }
  const rows = data.reports.filter(r => r.has_photo)
  // 写真なしで報告した入店・退店（理由つき。#535）
  const skipped = data.reports.filter(r => !r.has_photo && r.no_photo_reason)
  box.innerHTML = (rows.length ? `<div class="grid grid-cols-2 gap-2">${rows.map(r => `
      <a href="/api/admin/attendance-photo/${Number(r.attendance_id)}" target="_blank" rel="noopener" class="block border rounded-lg overflow-hidden hover:ring-2 ring-blue-300">
        <img src="/api/admin/attendance-photo/${Number(r.attendance_id)}" alt="${esc(PHOTO_REPORT_LABEL[r.report_type] || r.report_type)}の写真" loading="lazy" class="w-full h-32 object-cover bg-gray-100">
        <p class="text-xs px-2 py-1 text-gray-600"><span class="font-bold">${esc(PHOTO_REPORT_LABEL[r.report_type] || r.report_type)}</span> ${esc(dayjs(r.reported_at).format('M/D HH:mm'))}
          <span class="text-gray-400">${esc(PHOTO_ENTRY_LABEL[r.entry_method] || '')}${r.device ? '・' + esc(r.device) : ''}${r.photo_source ? '・' + esc(PHOTO_SOURCE_LABEL[r.photo_source] || '') : ''}</span>
          ${r.photo_stale ? `<span class="block text-amber-700"><i class="fas fa-clock-rotate-left mr-0.5"></i>写真の日時 ${esc(dayjs(r.photo_taken_at).format('M/D HH:mm'))}（報告と30分以上ずれています）</span>` : ''}</p>
      </a>`).join('')}</div>`
    : '<p class="text-xs text-gray-400">写真の付いた報告はありません</p>')
    + skipped.map(r => `<p class="text-xs text-amber-800 bg-amber-50 rounded p-2 mt-2"><i class="fas fa-camera-slash mr-1"></i>${esc(PHOTO_REPORT_LABEL[r.report_type] || r.report_type)} ${esc(dayjs(r.reported_at).format('M/D HH:mm'))}: 写真なしで報告（${esc(r.no_photo_reason)}）</p>`).join('')
}
window.loadAttendancePhotos = loadAttendancePhotos
window.openAttendancePhotos = function (shiftId, staffName) {
  modal(`<h3 class="font-bold text-lg mb-4">勤怠報告の写真${staffName ? ' — ' + esc(staffName) : ''}</h3><div id="attendance-photos"></div>
    <button class="btn btn-outline w-full mt-4" onclick="closeModal()">閉じる</button>`)
  loadAttendancePhotos(document.getElementById('attendance-photos'), shiftId)
}
delegate('attendancePhotos', el => openAttendancePhotos(Number(el.dataset.id), el.dataset.name))
window.updateShift = async function (id, status) {
  // 欠勤から戻すとき、退職・取引終了の人や、同じ枠に有効なシフトがある人は戻せない（理由を表示する）
  try { if (!await putShiftStatus(id, status)) return } catch (e) { showApiError(e, '更新に失敗しました'); return }
  closeModal(); toast('シフトを更新しました'); refreshShiftWeek()
}
window.deleteShift = async function (id) {
  if (!confirm('このシフトを削除しますか？')) return
  try { await axios.delete('/api/admin/shifts/' + id) } catch (e) { showApiError(e, '削除に失敗しました'); return }
  closeModal(); toast('シフトを削除しました'); refreshShiftWeek()
}

// ============ 日報一覧 ============
// 絞り込みの条件はハッシュに持つ（例: #reports/from=2026-10-01&to=2026-10-31&project=1&staff=2&unchecked=1&flagged=1&page=2。
// 1日だけなら date=2026-10-19 でもよい）。ほかの画面・通知からは、この形のリンクで条件付きの一覧を開ける
const REPORT_PAGE_SIZE = 50
const REPORT_ROWS = new Map()      // 表示中の日報（コメントの編集で使う）
let REPORT_OPTIONS = null          // 絞り込みの選択肢（案件・日報のあるスタッフ）
let REPORT_AS_OF = null            // 一覧を読んだ時刻（その後に出し直された日報を、見ないまま確認済みにしないため）
// テンプレートの無い案件で受け付ける項目（src/lib/validate.ts の NO_TEMPLATE_FIELDS と同じ）
const REPORT_NO_TEMPLATE_FIELDS = [{ key: 'free', label: '報告内容', type: 'textarea' }]
// インシデント・クレームの内容（スタッフの日報画面で入力する）。incident_ / complaint_ で始まるキー（_flag を除く）を、
// values の項目でも日報の列でも、赤枠の中にまとめて出す
const REPORT_INCIDENT_KEY = /^(incident|complaint)_(?!flag$)/
const reportEmpty = v => v === undefined || v === null || v === ''
const REPORT_TEXT_STYLE = { good_case: 'text-emerald-700 bg-emerald-50', store_share: 'text-blue-700 bg-blue-50' }

function reportFilterFromHash() {
  const m = (location.hash || '').match(/^#reports\/(.*)$/)
  const p = new URLSearchParams(m ? m[1] : '')
  const f = {}
  const day = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '')
  if (day(p.get('date'))) { f.from = f.to = day(p.get('date')) }
  if (day(p.get('from'))) f.from = day(p.get('from'))
  if (day(p.get('to'))) f.to = day(p.get('to'))
  for (const k of ['project', 'staff', 'page']) { const v = p.get(k); if (v && /^\d+$/.test(v) && Number(v) > 0) f[k] = Number(v) }
  if (p.get('unchecked') === '1') f.unchecked = 1
  if (p.get('flagged') === '1') f.flagged = 1
  if (p.get('open') === '1') f.open = 1
  return f
}
function reportsHash(f) {
  const p = new URLSearchParams()
  for (const k of ['from', 'to', 'project', 'staff', 'unchecked', 'flagged', 'open', 'page']) if (f[k]) p.set(k, f[k])
  const s = p.toString()
  return '#reports' + (s ? '/' + s : '')
}
function goReports(f) {
  const h = reportsHash(f)
  if (location.hash === h) renderReports(true); else location.hash = h
}
window.applyReportFilter = function () {
  const v = id => (document.getElementById(id) || {}).value || ''
  const f = { from: v('rp-from'), to: v('rp-to'), project: v('rp-project'), staff: v('rp-staff'),
    unchecked: document.getElementById('rp-unchecked').checked ? 1 : 0, flagged: document.getElementById('rp-flagged').checked ? 1 : 0, open: document.getElementById('rp-open').checked ? 1 : 0 }
  if (f.from && f.to && f.from > f.to) { toast('期間の開始日が終了日より後になっています'); return }
  goReports(f)
}

// テンプレートの項目の順に「ラベル: 値」を出す。数値はバッジ、テキストは本文。テンプレートにないキーは最後にまとめる
function reportValuesHtml(r, fields) {
  const vals = r.values || {}
  const list = fields && fields.length ? fields : REPORT_NO_TEMPLATE_FIELDS
  const used = new Set(Object.keys(vals).filter(k => REPORT_INCIDENT_KEY.test(k) && typeof vals[k] !== 'number'))
  const nums = [], texts = []
  const empty = reportEmpty
  for (const f of list) {
    const v = vals[f.key]
    if (used.has(f.key) || empty(v)) { used.add(f.key); continue }
    used.add(f.key)
    if (f.type === 'number') { if (Number(v) > 0) nums.push([f.label, v]) } else texts.push([f.label, v, f.key])
  }
  const others = Object.entries(vals).filter(([k, v]) => !used.has(k) && !empty(v) && !(typeof v === 'number' && v === 0))
  const textHtml = ([label, v, key]) => `<div class="text-xs rounded-lg px-2.5 py-1.5 mb-1 ${REPORT_TEXT_STYLE[key] || 'text-gray-700 bg-gray-50'}">
      <span class="font-bold">${esc(label)}</span><p class="whitespace-pre-wrap break-words mt-0.5">${esc(v)}</p></div>`
  return `
    ${nums.length ? `<div class="flex flex-wrap gap-1.5 mb-2">${nums.map(([l, v]) => `<span class="badge badge-blue">${esc(l)} ${esc(v)}</span>`).join('')}</div>` : ''}
    ${texts.map(textHtml).join('')}
    ${others.length ? `<div class="mt-2"><p class="text-[11px] text-gray-400 mb-1">テンプレートにない項目</p>
      ${others.map(([k, v]) => typeof v === 'number'
        ? `<span class="badge badge-gray mr-1">${esc(LABELS[k] || k)} ${esc(v)}</span>`
        : textHtml([LABELS[k] || k, typeof v === 'object' ? JSON.stringify(v) : v, k])).join('')}</div>` : ''}
    ${!nums.length && !texts.length && !others.length ? '<p class="text-xs text-gray-400">入力された項目はありません</p>' : ''}`
}

function reportIncidentHtml(r, fields) {
  const vals = r.values || {}
  const label = k => ((fields || []).find(f => f.key === k) || {}).label || (k.startsWith('complaint') ? 'クレームの内容' : 'インシデントの内容')
  const notes = []
  for (const [k, v] of Object.entries(vals)) if (REPORT_INCIDENT_KEY.test(k) && typeof v !== 'number' && !reportEmpty(v)) notes.push([label(k), v])
  for (const [k, v] of Object.entries(r)) if (REPORT_INCIDENT_KEY.test(k) && !REPORT_INCIDENT_META.has(k) && !(k in vals) && typeof v === 'string' && v) notes.push([label(k), v])
  if (!r.incident_flag && !r.complaint_flag && !notes.length) return ''
  const kinds = [r.incident_flag ? 'インシデント' : '', r.complaint_flag ? 'クレーム' : ''].filter(Boolean).join('・') || 'インシデント・クレーム'
  return `<div class="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2 mb-2">
    <p class="font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>${esc(kinds)}の報告あり</p>
    ${notes.length ? notes.map(([l, v]) => `<p class="mt-1"><span class="font-bold">${esc(l)}</span></p><p class="whitespace-pre-wrap break-words">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</p>`).join('')
      : '<p class="mt-1 text-red-500">内容の記入はありません。スタッフに確認してください。</p>'}
    ${r.incident_flag || r.complaint_flag ? reportIncidentStatusHtml(r) : ''}
  </div>`
}

// インシデント・クレームの対応状況（#169）。対応中・対応済み・クライアント共有と対応メモを、誰がいつ記録したかと一緒に出す
const REPORT_INCIDENT_META = new Set(['incident_status', 'incident_memo', 'incident_updated_by', 'incident_updated_at', 'incident_client_shared_at', 'incident_updated_by_name'])
const INCIDENT_STATUS_LABEL = { open: '未対応', in_progress: '対応中', done: '対応済み' }
const INCIDENT_STATUS_BADGE = { open: 'badge-red', in_progress: 'badge-yellow', done: 'badge-green' }
function reportIncidentStatusHtml(r) {
  const st = r.incident_status || 'open'
  const fmt = d => (d ? dayjs(String(d).replace(' ', 'T')).format('M/D HH:mm') : '')
  return `<div class="mt-2 pt-2 border-t border-red-200 text-gray-700">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="font-bold text-red-700">対応状況</span>
      <span class="badge ${INCIDENT_STATUS_BADGE[st] || 'badge-gray'}">${INCIDENT_STATUS_LABEL[st] || ''}</span>
      ${r.incident_client_shared_at ? `<span class="badge badge-blue">クライアント共有済み ${esc(fmt(r.incident_client_shared_at))}</span>` : ''}
      <button class="btn btn-outline text-xs ml-auto" data-action="editIncident" data-id="${Number(r.daily_report_id)}"><i class="fas fa-pen-to-square"></i>対応を記録</button>
    </div>
    ${r.incident_memo ? `<p class="whitespace-pre-wrap break-words mt-1">${esc(r.incident_memo)}</p>` : ''}
    ${r.incident_updated_at ? `<p class="text-[11px] text-gray-400 mt-0.5">更新: ${esc(r.incident_updated_by_name || '')} ${esc(fmt(r.incident_updated_at))}</p>` : ''}
  </div>`
}
delegate('editIncident', (el) => {
  const r = REPORT_ROWS.get(Number(el.dataset.id)); if (!r) return
  const st = r.incident_status || 'open'
  modal(`
    <h3 class="font-bold text-lg mb-1">インシデント・クレームの対応</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(dayjs(r.work_date).format('M/D(dd)'))} ${esc(r.staff_name)}・${esc(r.project_name)}</p>
    <div class="flex gap-2 flex-wrap mb-3">
      ${Object.entries(INCIDENT_STATUS_LABEL).map(([k, l]) => `<label class="flex items-center gap-1.5 text-sm border rounded-lg px-3 py-2 cursor-pointer"><input type="radio" name="inc-status" value="${k}" ${k === st ? 'checked' : ''}>${l}</label>`).join('')}
    </div>
    <label class="flex items-center gap-2 text-sm mb-3"><input id="inc-shared" type="checkbox" class="w-4 h-4" ${r.incident_client_shared_at ? 'checked' : ''}>クライアントに共有した${r.incident_client_shared_at ? `（${esc(dayjs(String(r.incident_client_shared_at).replace(' ', 'T')).format('M/D HH:mm'))}）` : ''}</label>
    <label class="text-sm text-gray-600 block mb-1" for="inc-memo">対応メモ</label>
    <textarea id="inc-memo" rows="5" class="inp text-sm w-full" style="resize:vertical" maxlength="2000" placeholder="だれに・いつ・何を連絡したか、再発防止の内容など">${esc(r.incident_memo || '')}</textarea>
    <div class="flex gap-2 justify-end mt-3">
      <button class="btn btn-outline text-sm" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary text-sm" data-action="saveIncident" data-id="${Number(r.daily_report_id)}"><i class="fas fa-check"></i>保存</button>
    </div>`)
})
delegate('saveIncident', (el) => {
  const r = REPORT_ROWS.get(Number(el.dataset.id)); if (!r) return
  const picked = document.querySelector('input[name="inc-status"]:checked')
  const body = {
    status: picked ? picked.value : 'open', memo: document.getElementById('inc-memo').value.trim() || null,
    client_shared: document.getElementById('inc-shared').checked, expected_updated_at: r.incident_updated_at || null,
  }
  withSubmitLock(el, async () => {
    try { await axios.put('/api/admin/daily-reports/' + Number(r.daily_report_id) + '/incident', body) } catch (e) {
      showApiError(e, '対応状況を保存できませんでした')
      // ほかの管理者が更新していた（409）ときは、今の内容で表示し直す
      if (e.response && e.response.status === 409) { closeModal(); renderReports(true) }
      return
    }
    closeModal(); toast('対応状況を保存しました'); renderReports(true)
  })
})

function reportCardHtml(r, fields) {
  const fmt = d => (d ? dayjs(d).format('M/D HH:mm') : '')
  const revised = !r.manager_checked && r.revised_after_check_at
  return `
    <section class="card p-4 ${r.incident_flag || r.complaint_flag ? 'ring-1 ring-red-200' : ''}">
      <div class="flex items-center gap-2 flex-wrap mb-2">
        <span class="font-bold text-gray-800">${dayjs(r.work_date).format('M/D(dd)')}</span>
        <a href="#staff/${Number(r.staff_id)}" class="text-blue-600 font-medium hover:underline">${esc(r.staff_name)}</a>
        <a href="${esc(reportsHash({ ...reportFilterFromHash(), project: r.project_id, page: 0 }))}" class="text-xs text-gray-400 hover:underline" title="この案件の日報で絞り込む">${esc(r.project_name)}</a>
        ${r.incident_flag ? '<span class="badge badge-red">インシデント</span>' : ''}
        ${r.complaint_flag ? '<span class="badge badge-purple">クレーム</span>' : ''}
        ${r.manager_checked ? '<span class="badge badge-green">確認済</span>' : '<span class="badge badge-yellow">未確認</span>'}
        ${revised ? `<span class="badge badge-red" title="確認済みにした後、スタッフが ${esc(fmt(r.revised_after_check_at))} に修正しました">確認後に修正あり</span>` : ''}
        <span class="text-xs text-gray-400 ml-auto">提出 ${esc(fmt(r.submitted_at))}</span>
      </div>
      ${reportIncidentHtml(r, fields)}
      ${reportValuesHtml(r, fields)}
      ${r.manager_comment ? `<div class="text-xs bg-gray-50 rounded-lg px-2.5 py-1.5 mt-2"><i class="fas fa-comment-dots text-gray-400 mr-1"></i><span class="whitespace-pre-wrap break-words">${esc(r.manager_comment)}</span>
        ${r.manager_comment_by_name || r.manager_comment_at ? `<span class="block text-[11px] text-gray-400 mt-0.5">${esc(r.manager_comment_by_name || '')} ${esc(fmt(r.manager_comment_at))}</span>` : ''}</div>` : ''}
      <div class="flex gap-2 mt-3 flex-wrap items-center">
        ${r.manager_checked
          ? `<button class="btn btn-outline text-xs" data-action="uncheckReport" data-id="${Number(r.daily_report_id)}"><i class="fas fa-rotate-left"></i>未確認に戻す</button>
             ${r.manager_checked_by_name || r.manager_checked_at ? `<span class="text-[11px] text-gray-400">確認: ${esc(r.manager_checked_by_name || '')} ${esc(fmt(r.manager_checked_at))}</span>` : ''}`
          : `<button class="btn btn-outline text-xs" data-action="checkReport" data-id="${Number(r.daily_report_id)}"><i class="fas fa-check"></i>確認済みにする</button>`}
        <button class="btn btn-outline text-xs" data-action="commentReport" data-id="${Number(r.daily_report_id)}"><i class="fas fa-comment"></i>${r.manager_comment ? 'コメントを編集' : 'コメント'}</button>
      </div>
    </section>`
}

// refresh: 確認・コメントの後の読み直し（読み込み中の表示を出さず、スクロール位置を保つ）
async function renderReports(refresh) {
  const f = reportFilterFromHash()
  const page = f.page || 1
  const scrollY = window.scrollY
  if (!refresh) loading()
  const q = new URLSearchParams({ offset: String((page - 1) * REPORT_PAGE_SIZE), limit: String(REPORT_PAGE_SIZE) })
  if (f.from) q.set('from', f.from)
  if (f.to) q.set('to', f.to)
  if (f.project) q.set('project_id', f.project)
  if (f.staff) q.set('staff_id', f.staff)
  if (f.unchecked) q.set('unchecked', '1')
  if (f.flagged) q.set('flagged', '1')
  if (f.open) q.set('incident_open', '1')
  if (!refresh || !REPORT_OPTIONS) q.set('options', '1')
  let data
  try { data = (await axios.get('/api/admin/daily-reports?' + q.toString())).data } catch (e) {
    $app.innerHTML = `<div class="card p-6 text-center text-sm text-gray-500">日報を読み込めませんでした。<button class="btn btn-outline text-xs ml-2" onclick="renderReports()">再読み込み</button></div>`
    showApiError(e, '日報を読み込めませんでした'); return
  }
  if (data.options) REPORT_OPTIONS = data.options
  REPORT_AS_OF = data.as_of || null
  const opts = REPORT_OPTIONS || { projects: [], staff: [] }
  REPORT_ROWS.clear()
  data.reports.forEach(r => REPORT_ROWS.set(r.daily_report_id, r))
  const total = data.total, start = total ? data.offset + 1 : 0, end = data.offset + data.reports.length
  const lastPage = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE))
  const uncheckedShown = data.reports.filter(r => !r.manager_checked).length
  const filtered = f.from || f.to || f.project || f.staff || f.unchecked || f.flagged || f.open
  const pager = total > REPORT_PAGE_SIZE ? `
    <div class="flex items-center justify-center gap-2 mt-4">
      <button class="btn btn-outline text-xs" data-action="reportPage" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i>前へ</button>
      <span class="text-xs text-gray-500">${page} / ${lastPage} ページ</span>
      <button class="btn btn-outline text-xs" data-action="reportPage" data-page="${page + 1}" ${page >= lastPage ? 'disabled' : ''}>次へ<i class="fas fa-chevron-right"></i></button>
    </div>` : ''
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">日報一覧</h2>
      <div class="flex gap-2 text-xs">
        <button class="badge badge-yellow" data-action="reportQuick" data-kind="unchecked">未確認 ${Number(data.counts.unchecked)}件</button>
        <button class="badge badge-red" data-action="reportQuick" data-kind="flagged">インシデント・クレーム ${Number(data.counts.flagged)}件</button>
        <button class="badge badge-red" data-action="reportQuick" data-kind="open">うち未対応 ${Number(data.counts.incident_open || 0)}件</button>
      </div>
    </div>
    <section class="card p-3 mb-4">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <label>開始日<input id="rp-from" type="date" class="inp" value="${esc(f.from || '')}" onchange="applyReportFilter()"></label>
        <label>終了日<input id="rp-to" type="date" class="inp" value="${esc(f.to || '')}" onchange="applyReportFilter()"></label>
        <label>案件<select id="rp-project" class="inp" onchange="applyReportFilter()"><option value="">すべて</option>
          ${opts.projects.map(p => `<option value="${Number(p.project_id)}" ${f.project === p.project_id ? 'selected' : ''}>${esc(p.project_name)}${p.status !== 'active' ? '（終了）' : ''}</option>`).join('')}</select></label>
        <label>スタッフ<select id="rp-staff" class="inp" onchange="applyReportFilter()"><option value="">すべて</option>
          ${opts.staff.map(s => `<option value="${Number(s.staff_id)}" ${f.staff === s.staff_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      </div>
      <div class="flex items-center gap-4 flex-wrap mt-2 text-sm">
        <label class="flex items-center gap-2"><input id="rp-unchecked" type="checkbox" class="w-4 h-4" ${f.unchecked ? 'checked' : ''} onchange="applyReportFilter()">未確認のみ</label>
        <label class="flex items-center gap-2"><input id="rp-flagged" type="checkbox" class="w-4 h-4" ${f.flagged ? 'checked' : ''} onchange="applyReportFilter()">インシデント・クレームのみ</label>
        <label class="flex items-center gap-2"><input id="rp-open" type="checkbox" class="w-4 h-4" ${f.open ? 'checked' : ''} onchange="applyReportFilter()">対応済みでないインシデント・クレームのみ</label>
        ${filtered ? '<a href="#reports" class="text-xs text-blue-600 hover:underline">条件をクリア</a>' : ''}
      </div>
    </section>
    ${reportArchiveBarHtml()}
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <p class="text-xs text-gray-500">全 ${total} 件${total ? `中 ${start}〜${end} 件を表示` : ''}</p>
      ${uncheckedShown ? `<button class="btn btn-primary text-xs" data-action="checkShownReports"><i class="fas fa-check-double"></i>表示中の未確認 ${uncheckedShown}件をまとめて確認済みにする</button>` : ''}
    </div>
    <div class="space-y-3">
      ${data.reports.map(r => reportCardHtml(r, data.templates[r.report_template_id])).join('') || `<p class="text-center text-gray-400 py-10">${filtered ? '条件に合う日報がありません' : '日報がありません'}</p>`}
    </div>
    ${pager}`
  loadReportRetentionNote()
  if (refresh) window.scrollTo(0, scrollY)
  // ページ送りで最後のページより後を開いた（確認して件数が減ったときなど）ら、最後のページへ
  if (!data.reports.length && page > 1 && total > 0) goReports({ ...f, page: lastPage })
}
// ---------- 日報の書き出しと保存期間の案内（#417） ----------
// 日報は稼働日から3年で定期削除される。削除の前に控えを取れるよう、期間・案件・スタッフで絞って CSV で書き出す
let REPORT_RETENTION = null // 保存期間と、今後30日で削除される件数（画面を開いた最初の1回だけ読む）
function reportArchiveBarHtml() {
  return `
    <div class="flex items-center justify-between flex-wrap gap-2 mb-3 text-xs text-gray-500">
      <p id="rp-retention"><i class="fas fa-box-archive mr-1"></i>日報は稼働日から3年で自動削除されます。必要な日報は CSV で控えを保存してください。</p>
      <button class="btn btn-outline text-xs" data-action="openReportCsv"><i class="fas fa-file-csv"></i>CSVで書き出す</button>
    </div>`
}
async function loadReportRetentionNote() {
  if (!REPORT_RETENTION) {
    try { REPORT_RETENTION = (await axios.get('/api/admin/daily-reports-retention')).data } catch (e) { return }
  }
  const el = document.getElementById('rp-retention')
  const r = REPORT_RETENTION
  if (!el || !r) return
  const due = r.due_count > 0
    ? `今後${Number(r.days)}日のうちに <b class="text-red-600">${Number(r.due_count)}件</b>（稼働日 ${esc(r.due_from)}〜${esc(r.due_to)}）が削除されます。`
    : `今後${Number(r.days)}日のうちに削除される日報はありません。`
  el.innerHTML = `<i class="fas fa-box-archive mr-1"></i>日報は稼働日から${Number(r.years)}年で自動削除されます。${due}必要な日報は CSV で控えを保存してください。`
}
delegate('openReportCsv', () => {
  const f = reportFilterFromHash()
  const r = REPORT_RETENTION
  // 期間の既定: 絞り込みの期間。なければ、今後削除される日報の範囲（最大62日）か、先月
  const today = dayjs()
  let from = f.from || '', to = f.to || ''
  if (!from || !to) {
    if (r && r.due_count > 0 && r.due_from) { from = r.due_from; to = dayjs(r.due_from).add(61, 'day').format('YYYY-MM-DD'); if (r.due_to < to) to = r.due_to }
    else { from = today.subtract(1, 'month').startOf('month').format('YYYY-MM-DD'); to = today.subtract(1, 'month').endOf('month').format('YYYY-MM-DD') }
  }
  const opts = REPORT_OPTIONS || { projects: [], staff: [] }
  modal(`
    <h3 class="font-bold text-lg mb-2">日報をCSVで書き出す</h3>
    <p class="text-xs text-gray-500 mb-3">日報は稼働日から3年で自動削除されます。1回に書き出せる期間は62日まで（2,000件まで）です。項目ごとの列と、インシデント・コメントを含みます。</p>
    <div class="grid grid-cols-2 gap-2 text-xs">
      <label>開始日<input id="rpc-from" type="date" class="inp" value="${esc(from)}"></label>
      <label>終了日<input id="rpc-to" type="date" class="inp" value="${esc(to)}"></label>
      <label class="col-span-2">案件<select id="rpc-project" class="inp"><option value="">すべて</option>
        ${opts.projects.map(p => `<option value="${Number(p.project_id)}" ${f.project === p.project_id ? 'selected' : ''}>${esc(p.project_name)}${p.status !== 'active' ? '（終了）' : ''}</option>`).join('')}</select></label>
    </div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="downloadReportCsv"><i class="fas fa-download"></i>書き出す</button>
    </div>`)
})
delegate('downloadReportCsv', (el) => withSubmitLock(el, async () => {
  const from = document.getElementById('rpc-from').value, to = document.getElementById('rpc-to').value
  const project = document.getElementById('rpc-project').value
  if (!from || !to) return toast('開始日と終了日を入力してください')
  if (from > to) return toast('開始日は終了日より前にしてください')
  if (dayjs(to).diff(dayjs(from), 'day') >= 62) return toast('書き出す期間は62日以内にしてください')
  const f = reportFilterFromHash()
  const params = { from, to }
  if (project) params.project_id = project
  if (f.staff) params.staff_id = f.staff
  try {
    const res = await axios.get('/api/admin/daily-reports-csv', { params, responseType: 'blob' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(res.data)
    a.download = `daily_reports_${from}_${to}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    closeModal()
    toast(res.headers['x-csv-truncated'] === '1' ? `上限の2,000件までを書き出しました（全${Number(res.headers['x-csv-total'])}件）。期間を分けて書き出してください` : 'CSVをダウンロードしました')
  } catch (e) {
    // blob で受けたエラーの本文（JSON）を読んでから出す
    let msg = null
    try { msg = JSON.parse(await e.response.data.text()).error } catch { }
    toast(msg || 'CSVを書き出せませんでした')
  }
}))
delegate('reportPage', (el) => { const f = reportFilterFromHash(); goReports({ ...f, page: Number(el.dataset.page) || 1 }); window.scrollTo(0, 0) })
delegate('reportQuick', (el) => {
  const f = reportFilterFromHash()
  goReports({ ...f, unchecked: el.dataset.kind === 'unchecked' ? 1 : f.unchecked, flagged: el.dataset.kind === 'flagged' ? 1 : f.flagged, open: el.dataset.kind === 'open' ? 1 : f.open, page: 0 })
})

async function updateReport(el, body, msg) {
  await withSubmitLock(el, async () => {
    try { await axios.put('/api/admin/daily-reports/' + Number(el.dataset.id), body) } catch (e) {
      showApiError(e, '更新に失敗しました')
      // 一覧を開いた後にスタッフが修正していた（409）ときは、今の内容で表示し直す
      if (e.response && e.response.status === 409) renderReports(true)
      return
    }
    toast(msg); renderReports(true)
  })
}
delegate('checkReport', (el) => updateReport(el, { manager_checked: 1, as_of: REPORT_AS_OF }, '確認済みにしました'))
delegate('uncheckReport', (el) => {
  if (!confirm('この日報を未確認に戻しますか？')) return
  updateReport(el, { manager_checked: 0 }, '未確認に戻しました')
})
delegate('checkShownReports', (el) => {
  const ids = [...REPORT_ROWS.values()].filter(r => !r.manager_checked).map(r => r.daily_report_id)
  if (!ids.length || !confirm(`表示中の未確認の日報 ${ids.length}件を、まとめて確認済みにしますか？`)) return
  withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post('/api/admin/daily-reports/check', { ids, as_of: REPORT_AS_OF })
      toast(`${data.checked}件を確認済みにしました` + (data.checked < ids.length ? '（表示の後に修正・確認された日報は除きました）' : '')); renderReports(true)
    } catch (e) { showApiError(e, '確認済みにできませんでした') }
  })
})

// コメントは今の内容を入れて開き、空にして保存すると削除。開いた後に別の管理者が変えていたら保存しない（#360）
delegate('commentReport', (el) => {
  const r = REPORT_ROWS.get(Number(el.dataset.id)); if (!r) return
  modal(`
    <h3 class="font-bold text-lg mb-1">スタッフへのコメント</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(dayjs(r.work_date).format('M/D(dd)'))} ${esc(r.staff_name)}・${esc(r.project_name)}</p>
    <p id="rc-meta" class="text-[11px] text-gray-400 mb-1">${r.manager_comment ? `前回: ${esc(r.manager_comment_by_name || '')} ${esc(r.manager_comment_at ? dayjs(r.manager_comment_at).format('M/D HH:mm') : '')}` : ''}</p>
    <textarea id="rc-text" rows="5" class="inp text-sm w-full" style="resize:vertical" maxlength="2000" placeholder="コメントを入力（空にして保存すると削除します）">${esc(r.manager_comment || '')}</textarea>
    <div class="flex gap-2 justify-end mt-3 flex-wrap">
      ${r.manager_comment ? `<button class="btn btn-danger text-sm mr-auto" data-action="saveReportComment" data-id="${Number(r.daily_report_id)}" data-mode="delete"><i class="fas fa-trash"></i>削除</button>` : ''}
      <button class="btn btn-outline text-sm" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary text-sm" data-action="saveReportComment" data-id="${Number(r.daily_report_id)}"><i class="fas fa-paper-plane"></i>保存</button>
    </div>`)
  setTimeout(() => { const t = document.getElementById('rc-text'); if (t) t.focus() }, 0)
})
delegate('saveReportComment', (el) => {
  const r = REPORT_ROWS.get(Number(el.dataset.id)); if (!r) return
  const del = el.dataset.mode === 'delete'
  if (del && !confirm('このコメントを削除しますか？')) return
  const text = del ? '' : document.getElementById('rc-text').value.trim()
  if (!del && text === (r.manager_comment || '')) { closeModal(); return }
  withSubmitLock(el, async () => {
    let res
    try {
      res = (await axios.put('/api/admin/daily-reports/' + r.daily_report_id, { manager_comment: text || null, expected_comment: r.manager_comment || null })).data
    } catch (e) {
      showApiError(e, 'コメントを保存できませんでした')
      // 別の管理者が変えていた場合は、今のコメントを表示する（もう一度保存すると、その内容を置き換える）
      if (e.response && e.response.status === 409 && e.response.data && 'current_comment' in e.response.data) {
        r.manager_comment = e.response.data.current_comment
        const meta = document.getElementById('rc-meta')
        if (meta) meta.textContent = '今のコメント: ' + (r.manager_comment || '（なし）')
      }
      return
    }
    // コメントはスタッフのアプリに通知する。ログインのない人には届かない（#158）
    const notice = !res || res.staff_notified == null ? '' : res.staff_notified ? '（スタッフのアプリに通知しました）' : '（このスタッフはアプリにログインしないため、通知は届きません）'
    closeModal(); toast(del || !text ? 'コメントを削除しました' : 'コメントを保存しました' + notice); renderReports(true)
  })
})

// ============ 実績分析 ============
// 集計する項目は、API がその月の日報テンプレートの数値項目から返す（#184）。
// 指標を選ぶと、スタッフ別ランキングの並びと日別のグラフが切り替わる。各表は CSV でも出せる
const ANALYTICS = { data: null, key: '' }
async function renderAnalytics(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  let data
  try { data = (await axios.get('/api/admin/analytics', { params: { month } })).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(showApiError(e, '実績を読み込めませんでした'))}</p>`; return }
  ANALYTICS.data = data
  // 選んでいた指標が無い月は、成約数（あれば）か最初の項目にする
  if (!data.fields.some(f => f.key === ANALYTICS.key)) ANALYTICS.key = (data.fields.find(f => f.key === 'seiyaku') || data.fields[0] || {}).key || ''
  drawAnalytics()
}
delegate('analyticsMonth', el => renderAnalytics(el.dataset.month))

// 案件の月間目標（#292）。日報テンプレートの数値項目ごとに、スタッフ1人あたりの件数を決める。スタッフの実績画面に進み具合が出る
let GOAL_PROJECTS = []
delegate('showProjectGoals', async () => {
  try { GOAL_PROJECTS = (await axios.get('/api/admin/project-goals')).data.projects || [] } catch (e) { showApiError(e, '目標を読み込めませんでした'); return }
  const summary = p => {
    const set = p.fields.filter(f => p.goals[f.key])
    return set.length ? set.map(f => `${esc(f.label)} ${Number(p.goals[f.key])}件`).join('、') : '<span class="text-gray-400">目標なし</span>'
  }
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-bullseye text-emerald-600 mr-1"></i>案件の月間目標</h3>
    <p class="text-xs text-gray-500 mb-3">スタッフ1人あたりの今月の目標件数です。スタッフの実績画面に、目標・実績・あと何件かが出ます（実績を見せない案件では出ません）。</p>
    <div class="space-y-2 max-h-[60vh] overflow-y-auto">
      ${GOAL_PROJECTS.map(p => `<div class="border rounded-lg p-2.5 flex items-center gap-2">
        <div class="min-w-0 flex-1"><p class="text-sm font-medium text-gray-800">${esc(p.project_name)}${p.show_performance ? '' : ' <span class="badge badge-gray">実績を見せない</span>'}</p>
          <p class="text-xs text-gray-600 mt-0.5">${p.fields.length ? summary(p) : '<span class="text-gray-400">日報テンプレートに数値の項目がありません</span>'}</p></div>
        ${p.fields.length ? `<button class="btn btn-outline text-xs shrink-0" data-action="editProjectGoals" data-id="${Number(p.project_id)}">設定</button>` : ''}
      </div>`).join('') || '<p class="text-sm text-gray-400">稼働中の案件がありません</p>'}
    </div>
    <button class="btn btn-outline w-full mt-4" onclick="closeModal()">閉じる</button>`)
})
delegate('editProjectGoals', (el) => {
  const p = GOAL_PROJECTS.find(x => x.project_id === Number(el.dataset.id)); if (!p) return
  modal(`
    <h3 class="font-bold text-lg mb-1">月間目標（1人あたり）</h3>
    <p class="text-xs text-gray-500 mb-3">${esc(p.project_name)}。空欄・0 の項目は目標なしになります。</p>
    <div class="grid grid-cols-2 gap-3">
      ${p.fields.map(f => `<label class="text-xs text-gray-600">${esc(f.label)}<input type="number" min="0" max="99999" step="1" inputmode="numeric" class="inp goal-inp" data-key="${esc(f.key)}" value="${p.goals[f.key] ? Number(p.goals[f.key]) : ''}"></label>`).join('')}
    </div>
    <div class="flex gap-2 justify-end mt-4">
      <button class="btn btn-outline text-sm" data-action="showProjectGoals">戻る</button>
      <button class="btn btn-primary text-sm" data-action="saveProjectGoals" data-id="${Number(p.project_id)}"><i class="fas fa-check"></i>保存</button>
    </div>`)
})
delegate('saveProjectGoals', (el) => {
  const goals = {}
  for (const inp of document.querySelectorAll('.goal-inp')) {
    const v = inp.value.trim()
    if (v !== '' && !/^\d+$/.test(v)) { toast('目標は0以上の整数で入力してください'); inp.focus(); return }
    goals[inp.dataset.key] = v === '' ? null : Number(v)
  }
  withSubmitLock(el, async () => {
    try { await axios.put('/api/admin/projects/' + Number(el.dataset.id) + '/goals', { goals }) } catch (e) { showApiError(e, '目標を保存できませんでした'); return }
    toast('目標を保存しました')
    delegate.handlers.showProjectGoals()
  })
})

// スタッフアプリに出す社内の情報（#496 #523）。実績画面の順位（匿名にもできる）と、同じ日・同じ案件に入るほかのスタッフ。変更は会社管理者だけ
delegate('showStaffViewSetting', async () => {
  let s
  try { s = (await axios.get('/api/admin/settings/staff-view')).data } catch (e) { showApiError(e, '設定を読み込めませんでした'); return }
  const row = (id, checked, title, note) => `<label class="flex items-start gap-2 py-2 border-b last:border-b-0">
    <input id="${id}" type="checkbox" class="w-4 h-4 mt-0.5" ${checked ? 'checked' : ''} ${s.can_edit ? '' : 'disabled'}>
    <span><span class="text-sm font-medium text-gray-800">${title}</span><span class="block text-xs text-gray-500">${note}</span></span></label>`
  modal(`
    <h3 class="font-bold text-lg mb-2"><i class="fas fa-mobile-screen text-blue-600 mr-1"></i>スタッフアプリへの表示</h3>
    ${row('sv-ranking', s.ranking_visible, '実績画面に、案件の中での順位を出す', '同じ月・同じ案件の日報の合計で、本人の順位・人数・平均との差と上位の件数を出します')}
    ${row('sv-anon', s.ranking_anonymous, '順位はほかの人の名前を出さない（匿名）', 'オフにすると、上位の人の姓も出します')}
    ${row('sv-cowork', s.show_coworkers, '一緒に入る人を出す', 'シフト画面で、同じ日・同じ現場に入るほかのスタッフの姓と時刻を出します（電話番号などは出しません）')}
    ${s.can_edit ? '<button class="btn btn-primary w-full mt-4" data-action="saveStaffViewSetting">保存する</button>' : '<p class="text-xs text-gray-500 mt-3">この設定は会社管理者だけが変更できます</p>'}`)
})
delegate('saveStaffViewSetting', el => withSubmitLock(el, async () => {
  const body = { ranking_visible: document.getElementById('sv-ranking').checked, ranking_anonymous: document.getElementById('sv-anon').checked, show_coworkers: document.getElementById('sv-cowork').checked }
  try { await axios.put('/api/admin/settings/staff-view', body); closeModal(); toast('スタッフアプリへの表示を保存しました') } catch (e) { showApiError(e, '保存できませんでした') }
}))
window.setAnalyticsKey = function (key) { ANALYTICS.key = key; drawAnalytics() }
delegate('rankAnalytics', el => { RANK_STATE.mode = el.dataset.mode; drawAnalytics() })
function drawAnalytics() {
  const data = ANALYTICS.data; const month = data.month; const fields = data.fields; const key = ANALYTICS.key
  const tv = (data.totals && data.totals.values) || {}
  const has = k => fields.some(f => f.key === k)
  const rate = has('shodan') && has('seiyaku') ? (tv.shodan ? Math.round((tv.seiyaku / tv.shodan) * 100) : 0) + '%' : null
  const num = v => Number(v || 0).toLocaleString()
  const heads = fields.map(f => `<th class="whitespace-nowrap ${f.key === key ? 'text-blue-700' : ''}">${esc(f.label)}</th>`).join('')
  const cells = r => fields.map(f => `<td class="${f.key === key ? 'font-bold' : ''}">${num(r.values[f.key])}</td>`).join('')
  const csvLink = by => `<a class="text-xs text-blue-600 hover:underline font-normal ml-2" href="/api/admin/analytics/csv?${esc(new URLSearchParams({ month, by }).toString())}"><i class="fas fa-file-csv mr-0.5"></i>CSV</a>`
  const empty = (n) => `<tr><td colspan="${n}" class="text-center text-gray-400 py-4">日報はありません</td></tr>`
  // ランキングは 合計・1日あたり・成約率 で並べ替えられる（#489）。日数は日報の数
  const hasRate = has('shodan') && has('seiyaku')
  const staff = rankRows(data.by_staff.map(s => ({ ...s, days: Number(s.reports || 0), val: Number(s.values[key] || 0), num: Number(s.values.seiyaku || 0), den: Number(s.values.shodan || 0) })), hasRate)
  const keyLabel = (fields.find(f => f.key === key) || {}).label || ''
  const rankLabel = { total: `${keyLabel}の多い順`, per_day: `1日あたりの${keyLabel}の多い順`, rate: '成約率の高い順' }[RANK_STATE.mode === 'rate' && !hasRate ? 'total' : RANK_STATE.mode]
  const m0 = dayjs(month + '-01')

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">実績分析</h2>
      <div class="flex gap-2 items-center flex-wrap">
        <button class="btn btn-outline" data-action="analyticsMonth" data-month="${esc(m0.subtract(1, 'month').format('YYYY-MM'))}" aria-label="前の月"><i class="fas fa-chevron-left"></i></button>
        <span class="font-bold">${esc(m0.format('YYYY年M月'))}</span>
        <button class="btn btn-outline" data-action="analyticsMonth" data-month="${esc(m0.add(1, 'month').format('YYYY-MM'))}" aria-label="次の月"><i class="fas fa-chevron-right"></i></button>
        ${fields.length ? `<label class="text-xs text-gray-500 flex items-center gap-1 ml-2">指標
          <select class="inp text-sm w-auto" onchange="setAnalyticsKey(this.value)">${fields.map(f => `<option value="${esc(f.key)}" ${f.key === key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>` : ''}
        <button class="btn btn-outline text-sm" data-action="showProjectGoals" title="スタッフの実績画面に出す、案件ごとの月間目標"><i class="fas fa-bullseye"></i>案件の目標</button>
        <button class="btn btn-outline text-sm" data-action="showStaffViewSetting" title="スタッフアプリに出す順位・一緒に入る人の設定"><i class="fas fa-mobile-screen"></i>スタッフへの表示</button>
      </div>
    </div>
    <p class="text-xs text-gray-500 mb-3">集計する項目は、この月に日報のある案件の日報テンプレートの数値項目です。</p>
    <section class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-5">
      ${[...fields.map(f => [f.label, num(tv[f.key])]), ...(rate ? [['成約率（成約数÷商談数）', rate]] : []), ['日報数', num(data.totals && data.totals.reports)]].map(([l, v]) => `
        <div class="card p-3 text-center"><p class="text-xl font-bold text-blue-600">${esc(v)}</p><p class="text-xs text-gray-500">${esc(l)}</p></div>`).join('')}
    </section>
    ${fields.length ? '' : '<p class="card p-4 text-sm text-gray-400 mb-5">この月の日報には、集計できる数値の項目がありません。</p>'}
    <section class="card p-4 mb-5">
      <h3 class="text-sm font-bold text-gray-700 mb-3">日別推移${keyLabel ? `（${esc(keyLabel)}）` : ''}${csvLink('daily')}</h3>
      ${key ? '<canvas id="daily-chart" height="80"></canvas>' : '<p class="text-sm text-gray-400">表示する項目がありません</p>'}
    </section>
    <section class="card p-4 mb-5">
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-ranking-star text-amber-500 mr-1"></i>スタッフ別ランキング${keyLabel ? `（${esc(rankLabel)}）` : ''}${csvLink('staff')}</h3>
        ${key ? `<span class="ml-auto">${rankControlsHtml('rankAnalytics', hasRate)}</span>` : ''}
      </div>
      <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>#</th><th>スタッフ</th><th>日報</th>${heads}${key ? `<th class="whitespace-nowrap">${esc(keyLabel)}/日</th>` : ''}${hasRate ? '<th>成約率</th>' : ''}</tr></thead>
        <tbody>${staff.map((s, i) => `
          <tr><td>${i < 3 && key && s.values[key] ? ['🥇', '🥈', '🥉'][i] : i + 1}</td>
          <td class="whitespace-nowrap"><a href="#staff/${Number(s.staff_id)}" class="text-blue-600 hover:underline">${esc(s.name || '')}</a></td>
          <td>${s.reports}</td>${cells(s)}${key ? `<td>${perDay(s.val, s.days)}</td>` : ''}${hasRate ? `<td>${ratePct(s.num, s.den)}</td>` : ''}</tr>`).join('') || empty(fields.length + 3 + (key ? 1 : 0) + (hasRate ? 1 : 0))}
        </tbody>
      </table>
      </div>
    </section>
    <section class="card p-4 mb-5">
      <h3 class="text-sm font-bold text-gray-700 mb-3">案件別実績${csvLink('project')}</h3>
      <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>案件</th><th>クライアント</th><th>日報</th>${heads}</tr></thead>
        <tbody>${data.by_project.map(p => `
          <tr><td><a href="#projects/${Number(p.project_id)}" class="text-blue-600 hover:underline text-xs">${esc(p.project_name || '')}</a></td>
          <td class="text-xs">${esc(p.client_name || '-')}</td><td>${p.reports}</td>${cells(p)}</tr>`).join('') || empty(fields.length + 3)}
        </tbody>
      </table>
      </div>
    </section>
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">クライアント別実績${csvLink('client')}</h3>
      <div class="overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>クライアント</th><th>日報</th>${heads}</tr></thead>
        <tbody>${data.by_client.map(c => `
          <tr><td class="text-xs">${esc(c.client_name || '（クライアント未設定）')}</td><td>${c.reports}</td>${cells(c)}</tr>`).join('') || empty(fields.length + 2)}
        </tbody>
      </table>
      </div>
    </section>`

  if (!key) return
  // 日別推移は月の1日から末日まで並べ、日報のない日は0にする（#550。日付が詰まって見えないように）
  const byDay = new Map(data.daily.map(d => [d.work_date, d]))
  const days = Array.from({ length: m0.daysInMonth() }, (_, i) => m0.add(i, 'day').format('YYYY-MM-DD'))
  new Chart(document.getElementById('daily-chart'), {
    type: 'bar',
    data: {
      labels: days.map(d => dayjs(d).format('M/D')),
      datasets: [{ label: keyLabel, data: days.map(d => (byDay.get(d) ? byDay.get(d).values[key] || 0 : 0)), backgroundColor: '#2563eb' }],
    },
    options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  })
}

// ============ お知らせ配信 ============
// 一覧は50件ずつ（もっと見る）。キーワード・配信先の案件・期間・状態で絞り込める。配信先の案件名・配信した人も出す（#368）。
// 下書き・予約（#291）、配信後の修正・取消（#157）、掲載期限（#294）、回答（#554）、添付（#555）
let NOTICE_ADMIN = { list: [], offset: 0, has_more: false, q: '', project_id: '', from: '', to: '', status: '' }
// 配信先の選択肢（案件・個人あての候補）。renderNotices で読み込み、作成と修正のフォームで使う
let NOTICE_FORM_DATA = { projects: [], staff: [] }
const NOTICE_ATTACH_ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp,application/pdf,image/jpeg,image/png,image/gif,image/webp'
const NOTICE_RESPONSE_PRESETS = [['参加する', '参加しない', '未定'], ['はい', 'いいえ']]
function noticeAdminImportanceBadge(n) {
  return n.importance === 'urgent' ? '<span class="badge badge-red"><i class="fas fa-triangle-exclamation"></i>緊急</span>'
    : n.importance === 'important' ? '<span class="badge badge-yellow">重要</span>' : ''
}
function noticeFmt(t, f) { return t ? esc(dayjs(String(t).replace(' ', 'T')).format(f || 'YYYY/M/D HH:mm')) : '' }
function noticeStateBadge(n) {
  if (n.state === 'draft') return '<span class="badge badge-gray"><i class="fas fa-pen"></i>下書き</span>'
  if (n.state === 'scheduled') return `<span class="badge badge-blue"><i class="fas fa-clock"></i>予約 ${noticeFmt(n.published_at, 'M/D HH:mm')}</span>`
  if (n.state === 'withdrawn') return '<span class="badge badge-red">取消済み</span>'
  return n.expired ? '<span class="badge badge-gray">掲載終了</span>' : ''
}
function noticeAttachmentLinks(n, base) {
  const files = n.attachments || []
  if (!files.length) return ''
  return `<div class="flex flex-wrap gap-2 mt-2">${files.map(a => `
    <a class="text-xs text-blue-600 hover:underline inline-flex items-center gap-1" target="_blank" rel="noopener" href="${base}/${Number(a.attachment_id)}">
      <i class="fas ${a.content_type === 'application/pdf' ? 'fa-file-pdf' : 'fa-image'}"></i>${esc(a.file_name)}</a>`).join('')}</div>`
}
function noticeAdminCardHtml(n) {
  const read = Number(n.read_count) || 0, total = Number(n.staff_total) || 0
  const pending = n.state === 'draft' || n.state === 'scheduled'
  const withdrawn = n.state === 'withdrawn'
  const target = n.target_type === 'all' ? '全体'
    : n.target_type === 'project' ? `案件: ${esc(n.target_names || '（削除された案件）')}`
    : `個人: ${esc(n.target_names || '-')}`
  const options = n.response_options || []
  const id = Number(n.notice_id)
  return `
    <div class="card p-4 ${withdrawn ? 'opacity-70' : ''}">
      <div class="flex items-center gap-2 mb-1 flex-wrap">
        ${noticeStateBadge(n)}
        ${noticeAdminImportanceBadge(n)}
        ${n.read_required ? '<span class="badge badge-purple">既読確認必須</span>' : ''}
        <span class="badge badge-gray">${target}</span>
        ${pending ? '' : `<span class="text-xs text-gray-400">${noticeFmt(n.published_at)}</span>`}
        <span class="text-xs text-gray-400">作成: ${esc(n.created_by_name || '-')}</span>
        ${pending ? `<span class="text-xs text-gray-500 ml-auto">配信予定 ${total}名</span>`
          : `<button class="text-xs text-blue-600 ml-auto hover:underline" data-action="showReads" data-id="${id}"
          ${n.reads_purged_at ? 'title="公開から2年たったため、既読の記録は削除済みです（人数は削除の直前の値）"' : ''}>
          既読 ${read}/${total}名${!n.reads_purged_at && !withdrawn && total > read ? `<span class="${n.read_required || n.importance === 'urgent' ? 'text-red-600 font-bold' : ''}">（未読 ${total - read}名）</span>` : ''}${n.reads_purged_at ? '（記録の保存期間外）' : ''}</button>`}
      </div>
      <h3 class="font-bold text-gray-800 ${withdrawn ? 'line-through' : ''}">${esc(n.title)}</h3>
      <p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap">${esc(n.body)}</p>
      ${noticeAttachmentLinks(n, `/api/admin/notices/${id}/attachments`)}
      <div class="text-xs text-gray-500 mt-2 space-y-0.5">
        ${n.expires_at ? `<p><i class="fas fa-calendar-xmark mr-1"></i>掲載期限 ${noticeFmt(n.expires_at, 'YYYY/M/D')} まで${n.expired ? '（終了）' : ''}</p>` : ''}
        ${options.length || n.response_comment ? `<p><i class="fas fa-reply mr-1"></i>回答: ${options.length ? esc(options.join('／')) : ''}${n.response_comment ? `${options.length ? '・' : ''}自由記入` : ''}
          ${pending ? '' : `<button class="text-blue-600 hover:underline ml-1" data-action="showReads" data-id="${id}">回答 ${Number(n.response_count) || 0}件を見る</button>`}</p>` : ''}
        ${pending && n.send_email ? '<p><i class="fas fa-envelope mr-1"></i>配信のときにメールでも送ります</p>' : ''}
        ${n.updated_at ? `<p><i class="fas fa-pen mr-1"></i>${noticeFmt(n.updated_at, 'M/D HH:mm')} に修正（${esc(n.updated_by_name || '-')}）
          <button class="text-blue-600 hover:underline ml-1" data-action="noticeRevisions" data-id="${id}">履歴</button></p>` : ''}
        ${withdrawn ? `<p class="text-red-600"><i class="fas fa-ban mr-1"></i>${noticeFmt(n.withdrawn_at, 'M/D HH:mm')} に取消（${esc(n.withdrawn_by_name || '-')}）${n.withdraw_reason ? `: ${esc(n.withdraw_reason)}` : ''}
          <button class="text-blue-600 hover:underline ml-1" data-action="noticeRevisions" data-id="${id}">履歴</button></p>` : ''}
      </div>
      ${n.remind_count ? `<p class="text-xs text-gray-500 mt-2"><i class="fas fa-bell mr-1"></i>未読者に再通知 ${Number(n.remind_count)}回（最終 ${noticeFmt(n.reminded_at, 'M/D HH:mm')}）</p>` : ''}
      ${noticeEmailSummary(n)}
      ${withdrawn ? '' : `<div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
        <button class="btn btn-outline text-xs" data-action="noticeEdit" data-id="${id}"><i class="fas fa-pen"></i>${pending ? '編集' : '修正'}</button>
        ${pending ? `<button class="btn btn-primary text-xs" data-action="noticePublishNow" data-id="${id}"><i class="fas fa-paper-plane"></i>今すぐ配信</button>
          <button class="btn btn-outline text-xs text-red-600" data-action="noticeDelete" data-id="${id}"><i class="fas fa-trash"></i>削除</button>`
          : `<button class="btn btn-outline text-xs text-red-600" data-action="noticeWithdraw" data-id="${id}"><i class="fas fa-ban"></i>取り消す</button>`}
      </div>`}
    </div>`
}
async function loadAdminNotices(more) {
  const f = NOTICE_ADMIN
  const params = { offset: more ? f.offset : 0 }
  if (f.q) params.q = f.q
  if (f.project_id) params.project_id = f.project_id
  if (f.from) params.from = f.from
  if (f.to) params.to = f.to
  if (f.status) params.status = f.status
  const { data } = await axios.get('/api/admin/notices', { params })
  if (!more) f.list = []
  const seen = new Set(f.list.map(n => n.notice_id))
  f.list.push(...data.notices.filter(n => !seen.has(n.notice_id)))
  f.offset = Number(data.offset || 0) + data.notices.length
  f.has_more = !!data.has_more
}
function noticeAdminFiltered() { const f = NOTICE_ADMIN; return !!(f.q || f.project_id || f.from || f.to || f.status) }
function drawAdminNoticeList() {
  const el = document.getElementById('notice-admin-list')
  if (!el) return
  const f = NOTICE_ADMIN
  el.innerHTML = (f.list.map(noticeAdminCardHtml).join('') || `<p class="text-sm text-gray-400 text-center py-8">${noticeAdminFiltered() ? '条件に合うお知らせはありません' : 'お知らせはまだありません'}</p>`)
    + (f.has_more ? '<button class="btn btn-outline w-full" data-action="noticeAdminMore">もっと見る</button>' : '')
}

// 作成・修正のフォーム。p は入力欄の id の頭（nt: 新規、ne: 修正）、n は修正するお知らせ（新規は null）
function noticeFormHtml(p, n) {
  const d = NOTICE_FORM_DATA
  const tt = n ? n.target_type : 'all'
  const ids = new Set(n && n.target_type !== 'all' ? String(n.target_ids || '').split(',').filter(Boolean).map(Number) : [])
  const options = n ? (n.response_options || []) : []
  const wantResponse = !!(options.length || (n && n.response_comment))
  const pending = !n || n.state === 'draft' || n.state === 'scheduled'
  const scheduled = n && n.state === 'scheduled' ? dayjs(String(n.published_at).replace(' ', 'T')).format('YYYY-MM-DDTHH:mm') : ''
  return `
    <div class="space-y-3" id="${p}-form">
      <div><label class="text-sm text-gray-600 block mb-1">タイトル *</label><input id="${p}-title" class="inp" maxlength="200" value="${esc(n ? n.title : '')}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">本文</label><textarea id="${p}-body" rows="4" class="inp">${esc(n ? n.body : '')}</textarea></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">配信対象</label>
          <select id="${p}-target" class="inp" data-notice-target="${p}">
            <option value="all" ${tt === 'all' ? 'selected' : ''}>全スタッフ</option>
            <option value="project" ${tt === 'project' ? 'selected' : ''}>案件を選ぶ（複数可）</option>
            <option value="staff" ${tt === 'staff' ? 'selected' : ''}>スタッフを選ぶ（複数可）</option>
          </select></div>
        <div><label class="text-sm text-gray-600 block mb-1">重要度</label>
          <select id="${p}-importance" class="inp">${[['normal', '通常'], ['important', '重要'], ['urgent', '緊急']].map(([v, l]) => `<option value="${v}" ${(n ? n.importance : 'normal') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div id="${p}-project-wrap" style="display:${tt === 'project' ? 'block' : 'none'}">
        <label class="text-sm text-gray-600 block mb-1">対象案件 <span class="text-xs text-gray-400" id="${p}-project-count"></span></label>
        <div class="border border-gray-200 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">
          ${d.projects.map(pj => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" class="w-4 h-4" name="${p}-project" value="${Number(pj.project_id)}" ${tt === 'project' && ids.has(Number(pj.project_id)) ? 'checked' : ''}>${esc(pj.project_name)}</label>`).join('') || '<p class="text-xs text-gray-400">案件がありません</p>'}
        </div>
        <p class="text-[11px] text-gray-400 mt-1">公開日の30日前以降に、選んだ案件で確定・代打のシフトがあるスタッフに届きます</p>
      </div>
      <div id="${p}-staff-wrap" style="display:${tt === 'staff' ? 'block' : 'none'}">
        <label class="text-sm text-gray-600 block mb-1">対象スタッフ <span class="text-xs text-gray-400" id="${p}-staff-count"></span></label>
        <input class="inp text-sm mb-1" placeholder="氏名・かなで絞り込む" data-notice-staff-filter="${p}">
        <div class="border border-gray-200 rounded-lg p-2 max-h-48 overflow-y-auto space-y-1" id="${p}-staff-list">
          ${d.staff.map(s => `<label class="flex items-center gap-2 text-sm" data-q="${esc(String((s.name || '') + ' ' + (s.kana || '')).toLowerCase())}"><input type="checkbox" class="w-4 h-4" name="${p}-staff" value="${Number(s.staff_id)}" ${tt === 'staff' && ids.has(Number(s.staff_id)) ? 'checked' : ''}>${esc(s.name)}</label>`).join('') || '<p class="text-xs text-gray-400">ログインのある在籍中のスタッフがいません</p>'}
        </div>
        <p class="text-[11px] text-gray-400 mt-1">ログインのある在籍中のスタッフから選べます</p>
      </div>
      <label class="flex items-center gap-2 text-sm"><input id="${p}-required" type="checkbox" class="w-4 h-4" ${n && n.read_required ? 'checked' : ''}>既読確認を必須にする</label>
      <p class="text-[11px] text-gray-400 -mt-2 ml-6">スタッフの一覧で上に固定し、「まとめて確認」から外します。未読の人には既読状況から再通知できます</p>
      <div><label class="text-sm text-gray-600 block mb-1">掲載期限（任意）</label>
        <input id="${p}-expires" type="date" class="inp" value="${esc(n && n.expires_at ? String(n.expires_at).slice(0, 10) : '')}">
        <p class="text-[11px] text-gray-400 mt-1">この日を過ぎると、スタッフのホームと一覧から外れ「掲載終了」に移ります</p></div>
      <div class="border border-gray-100 rounded-lg p-3">
        <label class="flex items-center gap-2 text-sm"><input id="${p}-response" type="checkbox" class="w-4 h-4" data-notice-response="${p}" ${wantResponse ? 'checked' : ''}>回答を求める（出欠・質問など）</label>
        <div id="${p}-response-wrap" class="mt-2 space-y-2" style="display:${wantResponse ? 'block' : 'none'}">
          <div><label class="text-xs text-gray-500 block mb-1">選択肢（1行に1つ。空なら自由記入だけ）</label>
            <textarea id="${p}-options" rows="3" class="inp text-sm">${esc(options.join('\n'))}</textarea>
            <div class="flex flex-wrap gap-2 mt-1">${NOTICE_RESPONSE_PRESETS.map((set, i) => `<button type="button" class="text-xs text-blue-600 hover:underline" data-action="noticeResponsePreset" data-prefix="${p}" data-i="${i}">「${esc(set.join('／'))}」を入れる</button>`).join('')}</div></div>
          <label class="flex items-center gap-2 text-sm"><input id="${p}-comment" type="checkbox" class="w-4 h-4" ${n && n.response_comment ? 'checked' : ''}>自由記入欄を付ける（コメント・質問への回答）</label>
        </div>
      </div>
      ${n ? '' : `<div><label class="text-sm text-gray-600 block mb-1">添付（画像・PDF。5件まで、1件10MBまで）</label>
        <input id="${p}-files" type="file" multiple accept="${NOTICE_ATTACH_ACCEPT}" class="text-sm"></div>`}
      ${pending ? `<div class="border border-gray-100 rounded-lg p-3 space-y-1">
        <p class="text-sm text-gray-600">配信のしかた</p>
        ${n ? '' : `<label class="flex items-center gap-2 text-sm"><input type="radio" name="${p}-mode" value="publish" checked data-notice-mode="${p}">すぐに配信する</label>`}
        <label class="flex items-center gap-2 text-sm"><input type="radio" name="${p}-mode" value="schedule" ${n && n.state === 'scheduled' ? 'checked' : ''} data-notice-mode="${p}">日時を指定して配信する（予約）</label>
        <div id="${p}-schedule-wrap" class="ml-6" style="display:${n && n.state === 'scheduled' ? 'block' : 'none'}"><input id="${p}-scheduled" type="datetime-local" class="inp text-sm" value="${esc(scheduled)}"></div>
        <label class="flex items-center gap-2 text-sm"><input type="radio" name="${p}-mode" value="draft" ${n && n.state === 'draft' ? 'checked' : ''} data-notice-mode="${p}">下書きとして保存する（スタッフには出ません）</label>
      </div>
      <label class="flex items-center gap-2 text-sm"><input id="${p}-send-email" type="checkbox" class="w-4 h-4" ${n && n.send_email ? 'checked' : ''}>メールでも通知する${n ? '（配信するときに送ります）' : ''}</label>`
      : `<label class="flex items-center gap-2 text-sm"><input id="${p}-notify" type="checkbox" class="w-4 h-4">修正したことを配信先のスタッフにアプリで知らせる</label>
      <label class="flex items-center gap-2 text-sm"><input id="${p}-send-email" type="checkbox" class="w-4 h-4">新しく配信先に加えた人にメールを送る</label>`}
    </div>`
}
function noticeFormCounts(p) {
  const pc = document.querySelectorAll(`input[name="${p}-project"]:checked`).length
  const sc = document.querySelectorAll(`input[name="${p}-staff"]:checked`).length
  const a = document.getElementById(`${p}-project-count`), b = document.getElementById(`${p}-staff-count`)
  if (a) a.textContent = pc ? `${pc}件を選択中` : ''
  if (b) b.textContent = sc ? `${sc}名を選択中` : ''
}
// フォームの切り替え（配信対象・回答・配信のしかた）と、スタッフの絞り込み
document.addEventListener('change', (ev) => {
  const el = ev.target
  if (!el || !el.dataset) return
  if (el.dataset.noticeTarget) {
    const p = el.dataset.noticeTarget
    document.getElementById(`${p}-project-wrap`).style.display = el.value === 'project' ? 'block' : 'none'
    document.getElementById(`${p}-staff-wrap`).style.display = el.value === 'staff' ? 'block' : 'none'
  } else if (el.dataset.noticeResponse) {
    document.getElementById(`${el.dataset.noticeResponse}-response-wrap`).style.display = el.checked ? 'block' : 'none'
  } else if (el.dataset.noticeMode) {
    document.getElementById(`${el.dataset.noticeMode}-schedule-wrap`).style.display = el.value === 'schedule' ? 'block' : 'none'
  } else if (/-(project|staff)$/.test(el.name || '')) {
    noticeFormCounts(el.name.replace(/-(project|staff)$/, ''))
  }
})
document.addEventListener('input', (ev) => {
  const el = ev.target
  if (!el || !el.dataset || !el.dataset.noticeStaffFilter) return
  const q = el.value.trim().toLowerCase()
  document.querySelectorAll(`#${el.dataset.noticeStaffFilter}-staff-list label`).forEach(l => { l.style.display = !q || l.dataset.q.includes(q) ? '' : 'none' })
})
delegate('noticeResponsePreset', el => {
  const t = document.getElementById(`${el.dataset.prefix}-options`)
  if (t) t.value = NOTICE_RESPONSE_PRESETS[Number(el.dataset.i)].join('\n')
})
// フォームの値。足りない入力があれば error を返す
function collectNoticeForm(p) {
  const v = (id) => { const e = document.getElementById(`${p}-${id}`); return e ? e.value : '' }
  const checked = (id) => !!(document.getElementById(`${p}-${id}`) || {}).checked
  const title = v('title').trim()
  if (!title) return { error: 'タイトルを入力してください' }
  const target_type = v('target')
  let target_ids = ''
  if (target_type === 'project' || target_type === 'staff') {
    target_ids = [...document.querySelectorAll(`input[name="${p}-${target_type}"]:checked`)].map(e => e.value).join(',')
    if (!target_ids) return { error: target_type === 'project' ? '対象の案件を選んでください' : '対象のスタッフを選んでください' }
  }
  const respond = checked('response')
  const body = {
    title, body: v('body'), target_type, target_ids, importance: v('importance'), read_required: checked('required'),
    expires_at: v('expires') || null,
    response_options: respond ? v('options').split('\n').map(s => s.trim()).filter(Boolean) : [],
    response_comment: respond && checked('comment'),
  }
  if (respond && !body.response_options.length && !body.response_comment) return { error: '回答の選択肢を入れるか、自由記入欄を付けてください' }
  const modeEl = document.querySelector(`input[name="${p}-mode"]:checked`)
  const mode = modeEl ? modeEl.value : null
  if (mode === 'schedule' && !v('scheduled')) return { error: '配信日時を入力してください' }
  return { body, mode, scheduled_at: mode === 'schedule' ? v('scheduled') : null, send_email: checked('send-email'), notify: checked('notify') }
}

async function renderNotices() {
  loading()
  try {
    const [, p, s] = await Promise.all([loadAdminNotices(false), axios.get('/api/admin/projects'), axios.get('/api/admin/notices/recipients')])
    NOTICE_FORM_DATA = { projects: p.data.projects || [], staff: s.data.staff || [] }
  } catch (e) {
    $app.innerHTML = `<div class="card p-4 text-sm text-gray-600">お知らせを読み込めませんでした。<button class="btn btn-outline ml-2" onclick="renderNotices()">再読み込み</button></div>`
    return
  }
  const f = NOTICE_ADMIN
  const pj = NOTICE_FORM_DATA.projects
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">お知らせ配信</h2>
    <div class="grid lg:grid-cols-5 gap-4">
      <section class="card p-4 lg:col-span-2 h-fit">
        <h3 class="font-bold text-gray-700 mb-3"><i class="fas fa-paper-plane text-blue-600 mr-1"></i>新規配信</h3>
        ${noticeFormHtml('nt', null)}
        <button class="btn btn-primary w-full mt-3" data-action="sendNotice">配信する／保存する</button>
      </section>
      <section class="lg:col-span-3 space-y-3">
        <div class="card p-3 flex flex-wrap items-end gap-2">
          <div class="flex-1 min-w-[10rem]"><label class="text-xs text-gray-500 block mb-1">キーワード（タイトル・本文）</label><input id="nf-q" class="inp text-sm" value="${esc(f.q)}"></div>
          <div><label class="text-xs text-gray-500 block mb-1">配信先の案件</label>
            <select id="nf-project" class="inp text-sm"><option value="">すべて</option>${pj.map(p => `<option value="${Number(p.project_id)}" ${String(p.project_id) === String(f.project_id) ? 'selected' : ''}>${esc(p.project_name)}</option>`).join('')}</select></div>
          <div><label class="text-xs text-gray-500 block mb-1">状態</label>
            <select id="nf-status" class="inp text-sm">${[['', 'すべて'], ['pending', '下書き・予約'], ['expired', '掲載終了'], ['withdrawn', '取消']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label class="text-xs text-gray-500 block mb-1">配信日</label>
            <div class="flex items-center gap-1"><input id="nf-from" type="date" class="inp text-sm" value="${esc(f.from)}"><span class="text-xs">〜</span><input id="nf-to" type="date" class="inp text-sm" value="${esc(f.to)}"></div></div>
          <button class="btn btn-outline text-sm" data-action="noticeAdminSearch"><i class="fas fa-magnifying-glass"></i>絞り込む</button>
          ${noticeAdminFiltered() ? '<button class="text-xs text-gray-500 hover:underline" data-action="noticeAdminClear">条件をクリア</button>' : ''}
        </div>
        <div id="notice-admin-list" class="space-y-3"></div>
      </section>
    </div>`
  drawAdminNoticeList()
}
delegate('noticeAdminSearch', el => withSubmitLock(el, async () => {
  Object.assign(NOTICE_ADMIN, {
    q: document.getElementById('nf-q').value.trim(), project_id: document.getElementById('nf-project').value,
    from: document.getElementById('nf-from').value, to: document.getElementById('nf-to').value, status: document.getElementById('nf-status').value,
  })
  try { await loadAdminNotices(false) } catch (e) { showApiError(e, 'お知らせを読み込めませんでした'); return }
  drawAdminNoticeList()
}))
delegate('noticeAdminClear', () => { Object.assign(NOTICE_ADMIN, { q: '', project_id: '', from: '', to: '', status: '' }); renderNotices() })
delegate('noticeAdminMore', el => withSubmitLock(el, async () => {
  try { await loadAdminNotices(true) } catch (e) { showApiError(e, 'お知らせを読み込めませんでした'); return }
  drawAdminNoticeList()
}))
async function refreshAdminNotices() {
  try { await loadAdminNotices(false); drawAdminNoticeList() } catch (_) { }
}
// お知らせメールの送信結果（状態ごとの人数）。押すと1人ずつの結果を出す
const NOTICE_MAIL_STATUS = { sent: '送信済み', failed: '送信失敗', no_email: 'メール未登録', pending: '送信中', skipped: '送信停止中' }
function noticeEmailSummary(n) {
  const m = n.email_counts
  if (!m) return ''
  // 10分以上たっても送信中のものは、処理が途中で止まったとみなす
  const stalled = m.pending && dayjs().diff(dayjs(n.published_at), 'minute') >= 10
  const parts = Object.keys(NOTICE_MAIL_STATUS).filter(k => m[k]).map(k => {
    const label = k === 'pending' && stalled ? '未完了' : NOTICE_MAIL_STATUS[k]
    return `<span class="${k === 'failed' || (k === 'pending' && stalled) ? 'text-red-600' : k === 'no_email' ? 'text-amber-600' : ''}">${label} ${Number(m[k])}名</span>`
  })
  return `<button class="text-xs text-gray-500 mt-2 hover:underline text-left" onclick="showNoticeEmails(${Number(n.notice_id)})">
    <i class="fas fa-envelope mr-1"></i>メール: ${parts.join(' ・')}</button>`
}
window.showNoticeEmails = async function (id) {
  const { data } = await axios.get(`/api/admin/notices/${Number(id)}/email-deliveries`)
  const ERR = { mail_not_configured: 'メールの送信設定がありません', resend_error: 'メール送信サービスがエラーを返しました', network_error: '通信エラー', invalid_address: 'メールアドレスの形式が正しくありません', internal_error: '送信処理が途中で止まりました',
    bounced: '宛先に届きませんでした（アドレスの誤り・使われていないアドレス）', bounced_soft: '一時的に届きませんでした（受信側の容量・混雑など）', complained: '受信者が迷惑メールとして報告しました',
    suppressed_bounced: '以前に届かなかったアドレスのため送っていません', suppressed_complained: '迷惑メールと報告されたアドレスのため送っていません', company_inactive: 'ご契約が停止中のため送っていません' }
  const errText = (e) => { const k = String(e).split(':')[0]; const rest = String(e).slice(k.length + 1).trim(); return (ERR[k] || k) + (rest ? `（${rest}）` : '') }
  const badge = (s) => `<span class="badge ${s === 'sent' ? 'badge-green' : s === 'failed' ? 'badge-red' : s === 'no_email' ? 'badge-yellow' : 'badge-gray'} whitespace-nowrap">${NOTICE_MAIL_STATUS[s] || esc(s)}</span>`
  modal(`
    <h3 class="font-bold text-lg mb-1">メールの送信結果</h3>
    <p class="text-sm text-gray-600 mb-3">${esc(data.notice.title)}</p>
    <div class="space-y-1 text-sm max-h-96 overflow-y-auto">${data.deliveries.map(d => `<div class="flex items-center gap-2">${badge(d.status)}<span>${esc(d.name || '')}</span>
      ${d.error ? `<span class="text-xs text-red-600">${esc(errText(d.error))}</span>` : ''}</div>`).join('') || '<p class="text-gray-400 text-xs">なし</p>'}</div>
    <p class="text-xs text-gray-500 mt-3">メール未登録の人には、アプリのお知らせだけが届いています。届かなかったアドレスは<a href="#corrections/emails" class="text-blue-600 hover:underline" onclick="closeModal()">メール送信状況</a>で確認できます。</p>`)
}
function noticeEmailMessage(e) {
  if (!e) return ''
  return e.mode === 'disabled' ? '（メール送信は停止中のため、メールは送っていません）'
    : e.mode === 'not_configured' ? '（メールの送信設定がないため、メールは送れません）'
    : `（メール送信対象 ${Number(e.with_email)}名・メール未登録 ${Number(e.no_email)}名）`
}
// 二重配信の防止用キー（配信が成功するまで同じキーを使う。サーバーは同じキーの配信を受け付けない）
let NOTICE_REQUEST_ID = null
function newNoticeRequestId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)
}
// 添付を上げる。失敗したファイルの名前と理由を返す
async function uploadNoticeFiles(noticeId, files) {
  if (!files.length) return []
  const fd = new FormData()
  for (const f of files) fd.append('files', f)
  const { data } = await axios.post(`/api/admin/notices/${Number(noticeId)}/attachments`, fd)
  return (data.results || []).filter(r => !r.ok).map(r => `${r.filename}: ${r.error}`)
}
// 新規配信。添付があるときは、まず下書きで作って添付を上げ、すべて上がってから配信・予約する
// （添付の失敗した状態でスタッフに届かないように。失敗したら下書きのまま残す）
delegate('sendNotice', el => withSubmitLock(el, async () => {
  const f = collectNoticeForm('nt')
  if (f.error) { toast(f.error); return }
  const fileInput = document.getElementById('nt-files')
  const files = fileInput ? [...fileInput.files] : []
  if (files.length > 5) { toast('添付は5件までです'); return }
  if (files.some(x => x.size > 10 * 1024 * 1024)) { toast('添付は1件10MB以下にしてください'); return }
  const mode = f.mode || 'publish'
  if (!NOTICE_REQUEST_ID) NOTICE_REQUEST_ID = newNoticeRequestId()
  let data
  try {
    data = (await axios.post('/api/admin/notices', {
      ...f.body, mode: files.length ? 'draft' : mode, scheduled_at: files.length ? null : f.scheduled_at,
      send_email: f.send_email, client_request_id: NOTICE_REQUEST_ID,
    })).data
  } catch (err) {
    const r = err.response
    if (r && r.status === 409 && r.data && r.data.duplicate) { NOTICE_REQUEST_ID = null; toast(r.data.error); renderNotices(); return }
    showApiError(err, 'お知らせを配信できませんでした。通信状況を確認してください')
    return
  }
  NOTICE_REQUEST_ID = null
  if (files.length) {
    let failed
    try { failed = await uploadNoticeFiles(data.notice_id, files) } catch (e) { failed = ['通信に失敗しました'] }
    if (failed.length) {
      alert(`添付できなかったファイルがあるため、下書きとして保存しました。一覧の「編集」から添付を直して配信してください。\n${failed.join('\n')}`)
      renderNotices(); return
    }
    if (mode !== 'draft') {
      try {
        data = (await axios.post(`/api/admin/notices/${Number(data.notice_id)}/publish`, { scheduled_at: mode === 'schedule' ? f.scheduled_at : null, send_email: f.send_email })).data
        data.status = data.state
      } catch (e) { showApiError(e, '配信できませんでした。下書きとして保存しています'); renderNotices(); return }
    }
  }
  const msg = data.status === 'draft' ? '下書きとして保存しました'
    : data.status === 'scheduled' ? `${dayjs(String(data.published_at).replace(' ', 'T')).format('M/D HH:mm')} に配信するよう予約しました`
    : 'お知らせを配信しました' + noticeEmailMessage(data.email)
  toast(msg); renderNotices()
}))

// 修正（#157）・下書きと予約の編集（#291）。添付の追加・削除もここで行う
function noticeEditAttachmentsHtml(n) {
  const files = n.attachments || []
  return `
    <div class="border-t border-gray-100 pt-3 mt-3" id="ne-attachments">
      <p class="text-sm text-gray-600 mb-1">添付（画像・PDF。5件まで、1件10MBまで）</p>
      <div class="space-y-1 mb-2">${files.map(a => `<div class="flex items-center gap-2 text-sm">
        <a class="text-blue-600 hover:underline truncate" target="_blank" rel="noopener" href="/api/admin/notices/${Number(n.notice_id)}/attachments/${Number(a.attachment_id)}">${esc(a.file_name)}</a>
        <button class="text-xs text-red-600 hover:underline ml-auto" data-action="noticeAttachmentDelete" data-id="${Number(n.notice_id)}" data-aid="${Number(a.attachment_id)}" data-name="${esc(a.file_name)}">削除</button></div>`).join('') || '<p class="text-xs text-gray-400">なし</p>'}</div>
      ${files.length < 5 ? `<div class="flex items-center gap-2"><input id="ne-files" type="file" multiple accept="${NOTICE_ATTACH_ACCEPT}" class="text-sm flex-1">
        <button class="btn btn-outline text-xs" data-action="noticeAttachmentAdd" data-id="${Number(n.notice_id)}"><i class="fas fa-paperclip"></i>添付する</button></div>` : ''}
      ${n.state === 'published' ? '<p class="text-[11px] text-gray-400 mt-1">配信済みのお知らせの添付を変えると、スタッフの画面に「更新」の印が付きます</p>' : ''}
    </div>`
}
function openNoticeEdit(id) {
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === id)
  if (!n) { toast('お知らせが見つかりません。画面を読み直してください'); return }
  const pending = n.state === 'draft' || n.state === 'scheduled'
  modal(`
    <h3 class="font-bold text-lg mb-1">${pending ? 'お知らせの編集' : 'お知らせの修正'}</h3>
    ${pending ? '' : '<p class="text-xs text-gray-500 mb-3">配信済みのお知らせを直します。直す前の内容は履歴に残ります。タイトル・本文を直すと、スタッフの画面に「更新」の印が付きます</p>'}
    ${noticeFormHtml('ne', n)}
    ${noticeEditAttachmentsHtml(n)}
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">閉じる</button>
      <button class="btn btn-primary flex-1" data-action="noticeSave" data-id="${Number(id)}">保存する</button>
    </div>`)
  noticeFormCounts('ne')
}
delegate('noticeEdit', el => openNoticeEdit(Number(el.dataset.id)))
delegate('noticeSave', el => withSubmitLock(el, async () => {
  const id = Number(el.dataset.id)
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === id)
  const f = collectNoticeForm('ne')
  if (f.error) { toast(f.error); return }
  const pending = n && (n.state === 'draft' || n.state === 'scheduled')
  const body = { ...f.body, send_email: f.send_email }
  if (pending) { body.mode = f.mode || 'draft'; body.scheduled_at = f.scheduled_at } else body.notify = f.notify
  let data
  try { data = (await axios.put(`/api/admin/notices/${id}`, body)).data } catch (e) { showApiError(e, '保存できませんでした'); return }
  closeModal()
  toast((data.state === 'scheduled' ? '予約を保存しました' : data.state === 'draft' ? '下書きを保存しました' : '修正しました')
    + (data.notified ? `（${Number(data.notified)}名に知らせました）` : '') + noticeEmailMessage(data.email))
  refreshAdminNotices()
}))
delegate('noticeAttachmentAdd', el => withSubmitLock(el, async () => {
  const id = Number(el.dataset.id)
  const input = document.getElementById('ne-files')
  const files = input ? [...input.files] : []
  if (!files.length) { toast('ファイルを選んでください'); return }
  let failed
  try { failed = await uploadNoticeFiles(id, files) } catch (e) { showApiError(e, '添付できませんでした'); return }
  if (failed.length) alert(`添付できなかったファイルがあります。\n${failed.join('\n')}`)
  else toast('添付しました')
  await refreshAdminNotices()
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === id)
  const box = document.getElementById('ne-attachments')
  if (n && box) box.outerHTML = noticeEditAttachmentsHtml(n)
}))
delegate('noticeAttachmentDelete', el => withSubmitLock(el, async () => {
  const id = Number(el.dataset.id)
  if (!confirm(`添付「${el.dataset.name}」を削除しますか？`)) return
  try { await axios.delete(`/api/admin/notices/${id}/attachments/${Number(el.dataset.aid)}`) } catch (e) { showApiError(e, '削除できませんでした'); return }
  toast('添付を削除しました')
  await refreshAdminNotices()
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === id)
  const box = document.getElementById('ne-attachments')
  if (n && box) box.outerHTML = noticeEditAttachmentsHtml(n)
}))
delegate('noticePublishNow', el => withSubmitLock(el, async () => {
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === Number(el.dataset.id))
  if (!n || !confirm(`「${n.title}」を今すぐ配信しますか？${n.send_email ? '（メールも送ります）' : ''}`)) return
  let data
  try { data = (await axios.post(`/api/admin/notices/${Number(n.notice_id)}/publish`, {})).data } catch (e) { showApiError(e, '配信できませんでした'); return }
  toast('お知らせを配信しました' + noticeEmailMessage(data.email))
  refreshAdminNotices()
}))
delegate('noticeDelete', el => withSubmitLock(el, async () => {
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === Number(el.dataset.id))
  if (!n || !confirm(`${n.state === 'scheduled' ? '予約' : '下書き'}「${n.title}」を削除しますか？（元に戻せません）`)) return
  try { await axios.delete(`/api/admin/notices/${Number(n.notice_id)}`) } catch (e) { showApiError(e, '削除できませんでした'); return }
  toast('削除しました')
  refreshAdminNotices()
}))
// 取消（#157）。スタッフの画面から消える。理由と、配信先への知らせを選べる
delegate('noticeWithdraw', el => {
  const n = NOTICE_ADMIN.list.find(x => x.notice_id === Number(el.dataset.id))
  if (!n) return
  modal(`
    <h3 class="font-bold text-lg mb-1">お知らせを取り消す</h3>
    <p class="text-sm text-gray-600 mb-3">「${esc(n.title)}」をスタッフの画面から消します。既読・回答の記録は残ります。取り消した後は元に戻せません。</p>
    <label class="text-sm text-gray-600 block mb-1">取消の理由（任意・200文字まで）</label>
    <input id="nw-reason" class="inp mb-2" maxlength="200" placeholder="例: 日時に誤りがあったため">
    <label class="flex items-center gap-2 text-sm"><input id="nw-notify" type="checkbox" class="w-4 h-4" checked>取り消したことを配信先のスタッフにアプリで知らせる</label>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
      <button class="btn btn-danger flex-1" data-action="noticeWithdrawDo" data-id="${Number(n.notice_id)}">取り消す</button>
    </div>`)
})
delegate('noticeWithdrawDo', el => withSubmitLock(el, async () => {
  let data
  try {
    data = (await axios.post(`/api/admin/notices/${Number(el.dataset.id)}/withdraw`, {
      reason: document.getElementById('nw-reason').value.trim(), notify: document.getElementById('nw-notify').checked,
    })).data
  } catch (e) { showApiError(e, '取り消せませんでした'); return }
  closeModal()
  toast('お知らせを取り消しました' + (data.notified ? `（${Number(data.notified)}名に知らせました）` : ''))
  refreshAdminNotices()
}))
delegate('noticeRevisions', async el => {
  let data
  try { data = (await axios.get(`/api/admin/notices/${Number(el.dataset.id)}/revisions`)).data } catch (e) { showApiError(e, '履歴を読み込めませんでした'); return }
  const label = { edit: '修正', withdraw: '取消' }
  modal(`
    <h3 class="font-bold text-lg mb-1">修正・取消の履歴</h3>
    <p class="text-xs text-gray-500 mb-3">それぞれの操作の前の内容です（新しい順）</p>
    <div class="space-y-3 max-h-96 overflow-y-auto">${data.revisions.map(r => `
      <div class="border border-gray-100 rounded-lg p-3 text-sm">
        <p class="text-xs text-gray-500 mb-1"><span class="badge ${r.action === 'withdraw' ? 'badge-red' : 'badge-gray'}">${label[r.action] || esc(r.action)}</span>
          ${noticeFmt(r.edited_at)}（${esc(r.edited_by_name || '-')}）</p>
        <p class="font-bold">${esc(r.title)}</p>
        <p class="text-gray-600 whitespace-pre-wrap">${esc(r.body)}</p>
        ${r.expires_at ? `<p class="text-xs text-gray-500 mt-1">掲載期限 ${noticeFmt(r.expires_at, 'YYYY/M/D')}</p>` : ''}
      </div>`).join('') || '<p class="text-sm text-gray-400">履歴はありません</p>'}</div>`)
})
// 既読状況。既読・未読とも配信対象の人だけ。既読の時刻はサーバーで日本時間にして返す（#7 #104）。
// 回答を求めるお知らせは、選択肢ごとの人数・回答・未回答の人も出す（#554）
window.showReads = async function (id) {
  let data
  try { data = (await axios.get(`/api/admin/notices/${Number(id)}/reads`)).data } catch (e) { showApiError(e, '既読状況を読み込めませんでした'); return }
  if (data.purged) {
    modal(`
      <h3 class="font-bold text-lg mb-4">既読状況</h3>
      <p class="text-sm text-gray-600">公開から2年たったため、既読・回答の記録は削除済みです。</p>
      <p class="text-sm text-gray-600 mt-2">削除の直前の既読: ${Number(data.read_count) || 0}/${Number(data.target_count) || 0}名</p>`)
    return
  }
  const rs = data.responses
  const canRemind = data.state === 'published' && data.unread.length
  modal(`
    <h3 class="font-bold text-lg mb-1">既読状況${rs ? '・回答' : ''}</h3>
    <p class="text-xs text-gray-500 mb-4">配信対象 ${Number(data.target_count) || 0}名（いま在籍中の人）${data.state === 'withdrawn' ? '・取消済み' : ''}</p>
    ${rs ? `<div class="border border-gray-100 rounded-lg p-3 mb-4">
      <div class="flex items-center mb-2"><h4 class="text-sm font-bold text-gray-700">回答 ${rs.answered.length}名・未回答 ${rs.unanswered.length}名</h4>
        <a class="text-xs text-blue-600 hover:underline ml-auto" href="/api/admin/notices/${Number(id)}/responses.csv"><i class="fas fa-file-csv mr-1"></i>CSV</a></div>
      ${rs.options.length ? `<div class="flex flex-wrap gap-2 mb-2">${rs.options.map(o => `<span class="badge badge-blue">${esc(o)} ${Number(rs.counts[o]) || 0}名</span>`).join('')}</div>` : ''}
      <div class="space-y-1 text-sm max-h-48 overflow-y-auto">${rs.answered.map(a => `<p>${esc(a.name)}${a.choice != null ? ` <span class="badge badge-gray">${esc(a.choice)}</span>` : ''}
        ${a.comment ? `<span class="text-gray-600">「${esc(a.comment)}」</span>` : ''} <span class="text-xs text-gray-400">${noticeFmt(a.answered_at, 'M/D HH:mm')}</span></p>`).join('') || '<p class="text-gray-400 text-xs">まだ回答はありません</p>'}</div>
      ${rs.unanswered.length ? `<p class="text-xs text-gray-500 mt-2">未回答: ${rs.unanswered.map(u => esc(u.name)).join('、')}</p>` : ''}
    </div>` : ''}
    <div class="grid grid-cols-2 gap-4">
      <div><h4 class="text-sm font-bold text-emerald-700 mb-2">既読 ${data.read.length}名</h4>
        <div class="space-y-1 text-sm">${data.read.map(r => `<p>${esc(r.name)} <span class="text-xs text-gray-400">${r.read_at ? esc(dayjs(String(r.read_at).replace(' ', 'T')).format('M/D HH:mm')) : ''}</span></p>`).join('') || '<p class="text-gray-400 text-xs">なし</p>'}</div></div>
      <div><h4 class="text-sm font-bold text-red-700 mb-2">未読 ${data.unread.length}名</h4>
        <div class="space-y-1 text-sm">${data.unread.map(r => `<p>${esc(r.name)}</p>`).join('') || '<p class="text-gray-400 text-xs">なし</p>'}</div></div>
    </div>
    ${canRemind ? `<div class="border-t border-gray-100 mt-4 pt-3">
      <label class="flex items-center gap-2 text-sm mb-2"><input id="remind-email" type="checkbox" class="w-4 h-4">メールでも送る</label>
      <button class="btn btn-primary w-full" data-action="remindNotice" data-id="${Number(id)}"><i class="fas fa-bell"></i>未読の ${data.unread.length}名に再通知する</button>
      <p class="text-[11px] text-gray-400 mt-1">スタッフのアプリの「通知」に確認のお願いが届きます（押すとこのお知らせが開きます）</p>
    </div>` : ''}`)
}
delegate('showReads', el => showReads(Number(el.dataset.id)))
// 未読者への再通知（#191）。アプリ内通知と、選んだときはメールも送る
delegate('remindNotice', el => withSubmitLock(el, async () => {
  const sendEmail = !!(document.getElementById('remind-email') || {}).checked
  if (!confirm(`未読の人に再通知します${sendEmail ? '（メールも送ります）' : ''}。よろしいですか？`)) return
  let data
  try { data = (await axios.post(`/api/admin/notices/${Number(el.dataset.id)}/remind`, { send_email: sendEmail })).data } catch (e) { showApiError(e, '再通知できませんでした'); return }
  const e = data.email
  let msg = `未読の ${Number(data.notified)}名に再通知しました`
  if (e) {
    msg += e.mode === 'disabled' ? '（メール送信は停止中のため、メールは送っていません）'
      : e.mode === 'not_configured' ? '（メールの送信設定がないため、メールは送れません）'
      : `（メール送信 ${Number(e.with_email)}名・メール未登録 ${Number(e.no_email)}名）`
  }
  toast(msg); closeModal()
  refreshAdminNotices()
}))

// ============ お知らせ既読率レポート ============
function fiscalYearLabel(fy) { return `${fy}年度（${fy}/04〜${fy + 1}/03）` }
function currentFiscalYearJs() {
  const d = new Date(Date.now() + 9 * 3600 * 1000) // JST
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1
  return m >= 4 ? y : y - 1
}
// 集計日時（JST の 'YYYY-MM-DD HH:MM:SS'）を表示用にする
function noticeReportTime(t) { return t ? esc(dayjs(String(t).replace(' ', 'T')).format('YYYY/M/D HH:mm')) : '-' }
async function renderNoticeReadReport(fy) {
  loading()
  fy = fy || currentFiscalYearJs() - 1 // 直近に終わった年度を既定で表示する（今年度は年度の途中の値）
  const { data } = await axios.get(`/api/admin/notice-reports/${fy}`)
  window._noticeReportData = data
  const s = data.summary
  const fyOptions = []
  for (let y = currentFiscalYearJs(); y >= currentFiscalYearJs() - 6; y--) fyOptions.push(y)
  // 年度の状態: 確定済み / 年度の途中（毎日更新）/ 集計中（確定前）
  const state = !s ? '' : data.finalized
    ? `<span class="badge badge-green">確定</span><span class="text-xs text-gray-500">確定日時: ${noticeReportTime(s.finalized_at)}</span>`
    : data.in_progress
      ? `<span class="badge badge-yellow">年度の途中</span><span class="text-xs text-gray-500">${noticeReportTime(s.calculated_at)} 時点の集計（毎日更新）</span>`
      : `<span class="badge badge-gray">確定前</span><span class="text-xs text-gray-500">${noticeReportTime(s.calculated_at)} 時点の集計（年度末から30日後に確定）</span>`

  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">お知らせ既読率レポート</h2>
      <div class="flex items-center gap-2">
        <select class="inp text-sm" onchange="renderNoticeReadReport(Number(this.value))">
          ${fyOptions.map(y => `<option value="${y}" ${y === fy ? 'selected' : ''}>${fiscalYearLabel(y)}</option>`).join('')}
        </select>
        <button class="btn btn-outline text-sm" data-action="recalcNoticeReport" data-fy="${Number(fy)}" ${data.recalculable ? '' : `disabled title="${escAttr(data.recalc_block_reason || '')}"`}><i class="fas fa-rotate"></i>再集計</button>
        <a class="btn btn-outline text-sm" href="/api/admin/notice-reports/${Number(fy)}/csv"><i class="fas fa-file-csv"></i>CSV出力</a>
      </div>
    </div>
    ${data.recalculable ? '' : `<p class="text-xs text-gray-500 mb-3"><i class="fas fa-lock mr-1"></i>${esc(data.recalc_block_reason || '')}（保存済みの集計を表示しています）</p>`}

    <section class="card p-4 mb-4">
      <div class="flex items-center gap-2 mb-3 flex-wrap"><h3 class="text-sm font-bold text-gray-700">年度全体</h3>${state}</div>
      ${!s ? `<p class="text-sm text-gray-400">このレポートはまだ生成されていません。${data.recalculable ? '「再集計」を実行してください。' : ''}</p>` : `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><p class="text-xs text-gray-400">対象お知らせ数</p><p class="text-lg font-bold">${s.target_notice_count}件</p></div>
          <div><p class="text-xs text-gray-400">対象延べ人数</p><p class="text-lg font-bold">${s.target_user_count}人</p></div>
          <div><p class="text-xs text-gray-400">既読延べ人数</p><p class="text-lg font-bold text-emerald-600">${s.read_count}人</p></div>
          <div><p class="text-xs text-gray-400">年度既読率</p><p class="text-lg font-bold text-blue-600">${s.read_rate == null ? '-' : s.read_rate.toFixed(1) + '%'}</p></div>
        </div>
        <p class="text-xs text-gray-500 mt-3">対象は、お知らせを公開した時点で在籍していた人です（後で退職した人も含みます。入社前のお知らせは含みません）。</p>`}
    </section>

    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">スタッフ別（人事評価の参考資料）</h3>
      ${data.staff_reports.length === 0 ? '<p class="text-sm text-gray-400">対象となるお知らせがありません。</p>' : `
      <div class="flex items-center gap-3 flex-wrap text-xs text-gray-600 mb-3">
        <label class="flex items-center gap-1">既読率<input type="number" min="0" max="100" step="1" class="inp text-sm w-20" value="${esc(NR_STAFF.rateBelow)}" oninput="setNoticeStaffFilter('rateBelow', this.value)">%未満</label>
        <label class="flex items-center gap-1">未読<input type="number" min="0" step="1" class="inp text-sm w-20" value="${esc(NR_STAFF.unreadMin)}" oninput="setNoticeStaffFilter('unreadMin', this.value)">件以上</label>
        <span class="text-gray-400">見出しを押すと並べ替えます</span>
      </div>
      <div id="nr-staff-table" class="overflow-x-auto"></div>`}
    </section>`
  if (data.staff_reports.length) drawNoticeStaffTable()
}
// スタッフ別の並べ替えと絞り込み（#518）。初期表示は既読率の低い順。数字は集計した時点の値なので、画面の中だけで並べ替える
const NR_STAFF = { sort: 'rate', dir: 1, rateBelow: '', unreadMin: '' }
const NR_SORT = {
  name: { label: 'スタッフ', dir: 1, v: r => r.staff_name || '' },
  target: { label: '対象数', dir: -1, v: r => r.target_count || 0 },
  read: { label: '既読数', dir: -1, v: r => r.read_count || 0 },
  unread: { label: '未読数', dir: -1, v: r => r.unread_count || 0 },
  rate: { label: '既読率', dir: 1, v: r => r.read_rate },
}
function drawNoticeStaffTable() {
  const box = document.getElementById('nr-staff-table')
  const data = window._noticeReportData
  if (!box || !data) return
  const fy = data.fiscal_year
  const below = NR_STAFF.rateBelow === '' ? null : Number(NR_STAFF.rateBelow)
  const unreadMin = NR_STAFF.unreadMin === '' ? null : Number(NR_STAFF.unreadMin)
  const key = NR_SORT[NR_STAFF.sort]
  const rows = data.staff_reports
    .filter(r => (below == null || (r.read_rate != null && r.read_rate < below)) && (unreadMin == null || r.unread_count >= unreadMin))
    .sort((a, b) => {
      const x = key.v(a), y = key.v(b)
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1 // 既読率なしは最後
      const c = typeof x === 'string' ? x.localeCompare(y, 'ja') : x - y
      return c * NR_STAFF.dir || String(a.staff_name || '').localeCompare(String(b.staff_name || ''), 'ja')
    })
  const th = (k) => `<th><button class="hover:underline whitespace-nowrap ${NR_STAFF.sort === k ? 'text-blue-700' : ''}" data-action="nrStaffSort" data-key="${k}">${NR_SORT[k].label}${NR_STAFF.sort === k ? (NR_STAFF.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`
  box.innerHTML = `
    <table class="tbl">
      <thead><tr>${th('name')}<th>社員番号</th>${th('target')}${th('read')}${th('unread')}${th('rate')}<th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.staff_name)}</td>
            <td class="text-xs text-gray-500">${esc(r.employee_number || '')}</td>
            <td>${r.target_count}</td>
            <td>${r.read_count}</td>
            <td>${r.unread_count}</td>
            <td>${r.read_rate == null ? '-' : r.read_rate.toFixed(1) + '%'}</td>
            <td><button class="text-xs text-blue-600 hover:underline" data-action="showStaffNoticeReport" data-fy="${Number(fy)}" data-id="${Number(r.staff_id)}">詳細</button></td>
          </tr>`).join('') || '<tr><td colspan="7" class="text-center text-gray-400 py-4">条件に合うスタッフはいません</td></tr>'}
      </tbody>
    </table>
    <p class="text-xs text-gray-400 mt-2">${rows.length} / ${data.staff_reports.length}人を表示</p>`
}
delegate('nrStaffSort', el => {
  const k = el.dataset.key
  if (!NR_SORT[k]) return
  NR_STAFF.dir = NR_STAFF.sort === k ? -NR_STAFF.dir : NR_SORT[k].dir
  NR_STAFF.sort = k
  drawNoticeStaffTable()
})
window.setNoticeStaffFilter = function (k, v) { NR_STAFF[k] = v; drawNoticeStaffTable() }
window.recalculateNoticeReadReport = async function (fy, btn) {
  await withSubmitLock(btn, async () => {
    try {
      const { data } = await axios.post(`/api/admin/notice-reports/${Number(fy)}/recalculate`)
      toast(`再集計しました（${noticeReportTime(data.calculated_at)} 時点）`)
      renderNoticeReadReport(fy)
    } catch (e) {
      showApiError(e, '再集計に失敗しました')
    }
  })
}
delegate('recalcNoticeReport', el => recalculateNoticeReadReport(Number(el.dataset.fy), el))
// スタッフ別の詳細はその場で計算する。一覧の数字は集計した時点の値なので、その日時を添える（#481）
window.showStaffNoticeReport = async function (fy, staffId) {
  let data
  try { data = (await axios.get(`/api/admin/notice-reports/${Number(fy)}/staff/${Number(staffId)}`)).data } catch (e) { showApiError(e, '詳細を読み込めませんでした'); return }
  const s = window._noticeReportData && window._noticeReportData.fiscal_year === fy ? window._noticeReportData.summary : null
  modal(`
    <h3 class="font-bold text-lg mb-1">${esc(data.staff_name)}</h3>
    <p class="text-sm text-gray-400 mb-1">${fiscalYearLabel(fy)}</p>
    <p class="text-xs text-gray-500 mb-4">下の既読・未読はいまの状態です。一覧の数字は ${s ? noticeReportTime(s.calculated_at) : '-'} 時点の集計です。</p>
    <div class="space-y-1.5 max-h-96 overflow-y-auto">
      ${data.notices.length === 0 ? '<p class="text-sm text-gray-400">対象のお知らせがありません</p>' : noticeDetailRows(data.notices)}
    </div>`)
}
// 未読を上にまとめ、それぞれ配信日の新しい順。配信日と重要度・既読必須も出す（#518）
const NOTICE_IMPORTANCE_BADGE = { important: '<span class="badge badge-yellow text-[10px]">重要</span>', urgent: '<span class="badge badge-red text-[10px]">緊急</span>' }
function noticeDetailRows(notices) {
  const rank = n => (n.is_read === false ? 0 : n.is_read === null ? 1 : 2)
  return notices.slice().sort((a, b) => rank(a) - rank(b) || String(b.published_at || '').localeCompare(String(a.published_at || ''))).map(n => `
    <div class="flex items-center justify-between gap-2 text-sm p-2 rounded-lg ${n.is_read === false ? 'bg-red-50' : 'bg-gray-50'}">
      <div class="min-w-0">
        <p class="truncate">${esc(n.title)}</p>
        <p class="text-xs text-gray-500 flex items-center gap-1 flex-wrap">${n.published_at ? esc(dayjs(String(n.published_at).replace(' ', 'T')).format('YYYY/M/D')) + ' 配信' : ''}
          ${NOTICE_IMPORTANCE_BADGE[n.importance] || ''}${n.read_required ? '<span class="badge badge-blue text-[10px]">既読必須</span>' : ''}</p>
      </div>
      <span class="badge ${n.is_read === null ? 'badge-gray' : n.is_read ? 'badge-green' : 'badge-red'} shrink-0">${n.is_read === null ? '記録なし（保存期間外）' : n.is_read ? '既読' : '未読'}</span>
    </div>`).join('')
}
delegate('showStaffNoticeReport', el => showStaffNoticeReport(Number(el.dataset.fy), Number(el.dataset.id)))


// ============ フォロー履歴 ============
// 対応中・期日が来たもの・完了で絞り、スタッフ名で探し、ページ送りで古い記録まで見られる（#385 #90）。
// 対応中は次回対応日の早い順。次回対応日はここで変えられる
const FOLLOW_TABS = [['open', '対応中'], ['due', '期日が来たもの'], ['done', '完了'], ['all', 'すべて']]
const FOLLOW_VIEW = { tab: 'open', q: '', page: 1 }
async function renderFollow() {
  // #follow/due などで開いたときは、そのタブにする
  const h = (location.hash.split('/')[1] || '')
  if (FOLLOW_TABS.some(([k]) => k === h)) FOLLOW_VIEW.tab = h
  loading()
  const params = { page: String(FOLLOW_VIEW.page), status: FOLLOW_VIEW.tab === 'due' ? 'open' : FOLLOW_VIEW.tab }
  if (FOLLOW_VIEW.tab === 'due') params.due = '1'
  if (FOLLOW_VIEW.q) params.q = FOLLOW_VIEW.q
  let data
  try { data = (await axios.get('/api/admin/follow-logs?' + new URLSearchParams(params))).data } catch (e) {
    $app.innerHTML = `<h2 class="text-xl font-bold text-gray-900 mb-4">フォロー履歴管理</h2>
      <section class="card p-6 text-center"><p class="text-sm text-red-600 mb-3">${esc((e && e.response && e.response.data && e.response.data.error) || 'フォロー履歴を読み込めませんでした')}</p>
      <button class="btn btn-outline" data-action="followReload"><i class="fas fa-rotate-right"></i>再読み込み</button></section>`
    return
  }
  const counts = data.counts || {}
  const tabCount = { open: counts.open || 0, due: counts.due || 0, done: counts.done || 0, all: counts.all || 0 }
  const pages = Math.max(1, Math.ceil((data.total || 0) / (data.per_page || 50)))
  const day = d => esc(dayjs(d).format('M/D'))
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">フォロー履歴管理</h2>
    <div class="flex gap-2 flex-wrap items-center mb-4">
      ${FOLLOW_TABS.map(([k, l]) => `<button class="btn ${FOLLOW_VIEW.tab === k ? 'btn-primary' : 'btn-outline'} text-xs" data-action="followTab" data-tab="${esc(k)}">${esc(l)}（${tabCount[k]}）</button>`).join('')}
      <form class="flex gap-1 ml-auto" id="follow-search"><input id="follow-q" class="inp text-sm w-40" placeholder="スタッフ名で探す" value="${esc(FOLLOW_VIEW.q)}" maxlength="50">
        <button class="btn btn-outline text-xs" type="submit"><i class="fas fa-magnifying-glass"></i></button></form>
    </div>
    <div class="space-y-3">
      ${(data.logs || []).map(f => {
        const due = f.status === 'open' && f.next_action_date && f.next_action_date <= data.today
        return `
        <section class="card p-4">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="badge badge-purple">${esc(FOLLOW_LABELS[f.follow_type] || f.follow_type)}</span>
            <a href="#staff/${Number(f.staff_id)}" class="font-bold text-blue-700 hover:underline">${esc(f.staff_name)}</a>
            <span class="text-xs text-gray-400">対応者: ${esc(f.manager_name || '-')}</span>
            <span class="text-xs text-gray-400">${esc(dayjs(String(f.created_at || '').replace(' ', 'T')).format('M/D HH:mm'))}</span>
            ${f.status === 'open' ? `<button type="button" class="badge badge-yellow ml-auto" data-action="closeFollow" data-id="${Number(f.follow_id)}">対応中 → 完了にする</button>`
              : `<span class="badge badge-green ml-auto">完了${f.done_at ? ' ' + esc(dayjs(String(f.done_at).replace(' ', 'T')).format('M/D')) : ''}</span>`}
          </div>
          <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">${esc(f.content)}</p>
          ${f.next_action || f.next_action_date ? `<div class="text-xs mt-1.5 rounded-lg px-2.5 py-1.5 flex items-center gap-2 flex-wrap ${due ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}">
            <span><i class="fas fa-arrow-right mr-1"></i>次回対応: ${esc(f.next_action || '-')}${f.next_action_date ? `（${day(f.next_action_date)}${due ? '・期日が来ています' : ''}）` : ''}</span>
          </div>` : ''}
          ${f.status === 'open' ? `<div class="flex items-center gap-1 mt-2 text-xs">
            <label class="text-gray-500" for="follow-date-${Number(f.follow_id)}">次回対応日</label>
            <input type="date" id="follow-date-${Number(f.follow_id)}" class="inp text-xs w-36" value="${esc(f.next_action_date || '')}">
            <button type="button" class="btn btn-outline text-xs" data-action="followSaveDate" data-id="${Number(f.follow_id)}">変更</button>
          </div>` : ''}
        </section>`
      }).join('') || '<p class="text-center text-gray-400 py-10">該当するフォロー履歴はありません</p>'}
    </div>
    ${pages > 1 ? `<div class="flex items-center justify-center gap-3 mt-4 text-sm">
      <button class="btn btn-outline text-xs" data-action="followPage" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i>前へ</button>
      <span class="text-gray-600">${data.page} / ${pages}ページ（${data.total}件）</span>
      <button class="btn btn-outline text-xs" data-action="followPage" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>次へ<i class="fas fa-chevron-right"></i></button>
    </div>` : ''}`
  document.getElementById('follow-search').addEventListener('submit', ev => {
    ev.preventDefault()
    FOLLOW_VIEW.q = document.getElementById('follow-q').value.trim(); FOLLOW_VIEW.page = 1; renderFollow()
  })
}
// タブを変えたら URL の指定（#follow/due など）は外す
function followGo() { if (location.hash !== '#follow') history.replaceState(null, '', '#follow'); renderFollow() }
delegate('followReload', () => renderFollow())
delegate('followTab', el => { FOLLOW_VIEW.tab = el.dataset.tab; FOLLOW_VIEW.page = 1; followGo() })
delegate('followPage', el => { FOLLOW_VIEW.page = Math.max(1, Number(el.dataset.page) || 1); followGo() })
delegate('followSaveDate', el => {
  const id = Number(el.dataset.id)
  const v = (document.getElementById('follow-date-' + id) || {}).value || ''
  withSubmitLock(el, async () => {
    try { await axios.put('/api/admin/follow-logs/' + id, { next_action_date: v || null }) } catch (e) { showApiError(e, '次回対応日を変更できませんでした'); return }
    toast('次回対応日を変更しました'); renderFollow()
  })
})
window.closeFollow = async function (id, btn) {
  await withSubmitLock(btn, async () => {
    try { await axios.put('/api/admin/follow-logs/' + id, { status: 'done' }) } catch (e) { showApiError(e, '完了にできませんでした'); return }
    toast('完了にしました'); renderFollow()
  })
}
delegate('closeFollow', el => closeFollow(Number(el.dataset.id), el))

// ============ 相談対応 ============
// 状態で絞り、ページ送りで古い相談まで見られる（#90）。対象のシフト（日付・案件）を出し、シフトボードで開ける（#195）。
// 本文・返信は改行を保って表示し、返信は複数行のモーダルで書く（#422）
const CONSULT_ST_BADGE = { open: '<span class="badge badge-red">未対応</span>', in_progress: '<span class="badge badge-blue">対応中</span>', done: '<span class="badge badge-green">対応済</span>' }
const CONSULT_TABS = [['active', '未完了'], ['open', '未対応'], ['in_progress', '対応中'], ['done', '対応済み'], ['all', 'すべて']]
const CONSULT_VIEW = { status: 'active', page: 1, list: [] }
// 相談の写真（#429）とやり取り（#154）。返信は上書きせず、スタッフの追加の連絡と時系列で並べる
const consultTime = (at) => esc(dayjs(String(at || '').replace(' ', 'T')).format('M/D HH:mm'))
function consultPhotosHtml(co, messageId) {
  const list = (co.photos || []).filter(p => (p.message_id || null) === (messageId || null))
  return list.length ? `<div class="flex gap-2 flex-wrap mt-2">${list.map(p => `<a href="/api/admin/consultation-photo/${Number(p.attachment_id)}" target="_blank" rel="noopener">
    <img src="/api/admin/consultation-photo/${Number(p.attachment_id)}" alt="添付の写真" loading="lazy" class="w-20 h-20 object-cover rounded-lg border border-gray-200"></a>`).join('')}</div>` : ''
}
function consultThreadHtml(co) {
  const msgs = co.messages || []
  // これまでの返信（やり取りに移す前の1件）だけがある場合
  if (!msgs.length && co.manager_reply) return `<div class="mt-2 bg-blue-50 rounded-lg px-3 py-2 text-sm text-blue-900 whitespace-pre-wrap break-words"><i class="fas fa-reply mr-1"></i>${esc(co.manager_reply)}</div>`
  return msgs.map(m => m.author_side === 'admin'
    ? `<div class="mt-2 ml-6 bg-blue-50 rounded-lg px-3 py-2"><p class="text-[11px] text-blue-700 mb-0.5"><i class="fas fa-reply mr-1"></i>${esc(m.author_name || '管理者')}・${consultTime(m.created_at)}</p>
        <p class="text-sm text-blue-900 whitespace-pre-wrap break-words">${esc(m.body)}</p></div>`
    : `<div class="mt-2 mr-6 bg-gray-50 rounded-lg px-3 py-2"><p class="text-[11px] text-gray-500 mb-0.5"><i class="fas fa-user mr-1"></i>${esc(co.staff_name)}（追加の連絡）・${consultTime(m.created_at)}</p>
        <p class="text-sm text-gray-800 whitespace-pre-wrap break-words">${esc(m.body)}</p>${consultPhotosHtml(co, m.message_id)}</div>`).join('')
}

// #consult/{id} で開いたときは、その相談だけを出して強調する（ダッシュボードの ToDo・未報告の一覧から。#402 #498）
async function renderConsult() {
  const fid = (location.hash.match(/^#consult\/(\d+)$/) || [])[1] || ''
  loading()
  let data
  try {
    data = (await axios.get('/api/admin/consultations?' + new URLSearchParams(fid ? { id: fid } : { status: CONSULT_VIEW.status, page: String(CONSULT_VIEW.page) }))).data
  } catch (e) {
    $app.innerHTML = `<h2 class="text-xl font-bold text-gray-900 mb-4">相談対応</h2>
      <section class="card p-6 text-center"><p class="text-sm text-red-600 mb-3">${esc((e && e.response && e.response.data && e.response.data.error) || '相談を読み込めませんでした')}</p>
      <button class="btn btn-outline" data-action="consultReload"><i class="fas fa-rotate-right"></i>再読み込み</button></section>`
    return
  }
  CONSULT_VIEW.list = data.consultations || []
  const counts = data.counts || {}
  const tabCount = { active: (counts.open || 0) + (counts.in_progress || 0), open: counts.open || 0, in_progress: counts.in_progress || 0, done: counts.done || 0, all: (counts.open || 0) + (counts.in_progress || 0) + (counts.done || 0) }
  const pages = Math.max(1, Math.ceil((data.total || 0) / (data.per_page || 50)))
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">相談対応</h2>
    <div class="flex gap-2 flex-wrap mb-4">
      ${CONSULT_TABS.map(([k, l]) => `<button class="btn ${!fid && data.status === k ? 'btn-primary' : 'btn-outline'} text-xs" data-action="consultTab" data-status="${esc(k)}">${esc(l)}（${tabCount[k]}）</button>`).join('')}
    </div>
    ${fid ? `<p class="text-sm text-gray-600 mb-3"><i class="fas fa-circle-info text-blue-500 mr-1"></i>選んだ相談だけを表示しています。<button type="button" class="text-blue-700 hover:underline" data-action="consultTab" data-status="${esc(CONSULT_VIEW.status)}">一覧に戻る</button></p>` : ''}
    <div class="space-y-3">
      ${CONSULT_VIEW.list.map(co => `
        <section class="card p-4${fid ? ' ring-2 ring-blue-400' : ''}">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="badge badge-gray">${esc(CAT_LABELS[co.category] || co.category)}</span>
            ${co.urgency === 'high' ? '<span class="badge badge-red">緊急</span>' : ''}
            <a href="#staff/${Number(co.staff_id)}" class="font-bold text-blue-700 hover:underline">${esc(co.staff_name)}</a>
            <span class="text-xs text-gray-400">${esc(dayjs(String(co.created_at || '').replace(' ', 'T')).format('M/D HH:mm'))}</span>
            <span class="ml-auto">${CONSULT_ST_BADGE[co.status] || ''}</span>
          </div>
          ${co.target_date ? `<p class="text-xs text-gray-600 mb-1"><i class="fas fa-calendar-day mr-1 text-gray-400"></i>対象: ${esc(dayjs(co.target_date).format('M/D'))} ${esc(co.target_project_name || '')}
            <button class="text-blue-700 hover:underline ml-1" data-action="consultOpenBoard" data-date="${esc(co.target_date)}" data-project-id="${esc(co.target_project_id || '')}">シフトボードで見る</button>
            ${co.target_project_id && !co.target_shift_id ? '<span class="text-gray-400 ml-1">（該当のシフトは見つかりません）</span>' : ''}</p>` : ''}
          <p class="text-sm text-gray-700 whitespace-pre-wrap break-words">${esc(co.body)}</p>
          ${consultPhotosHtml(co, null)}
          ${consultThreadHtml(co)}
          <div class="flex gap-2 mt-3">
            <button class="btn btn-outline text-xs" data-action="consultReply" data-id="${Number(co.consultation_id)}"><i class="fas fa-reply"></i>返信する</button>
            ${co.status !== 'done' ? `<button class="btn btn-outline text-xs" data-action="consultClose" data-id="${Number(co.consultation_id)}"><i class="fas fa-check"></i>対応済みにする</button>` : ''}
          </div>
        </section>`).join('') || '<p class="text-center text-gray-400 py-10">該当する相談はありません</p>'}
    </div>
    ${pages > 1 ? `<div class="flex items-center justify-center gap-3 mt-4 text-sm">
      <button class="btn btn-outline text-xs" data-action="consultPage" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i>前へ</button>
      <span class="text-gray-600">${data.page} / ${pages}ページ（${data.total}件）</span>
      <button class="btn btn-outline text-xs" data-action="consultPage" data-page="${data.page + 1}" ${data.page >= pages ? 'disabled' : ''}>次へ<i class="fas fa-chevron-right"></i></button>
    </div>` : ''}`
}
delegate('consultReload', () => renderConsult())
// 1件だけの表示（#consult/{id}）から一覧に戻るときは、URL を #consult にする
function consultGo() { if (location.hash !== '#consult') history.replaceState(null, '', '#consult'); renderConsult() }
delegate('consultTab', el => { CONSULT_VIEW.status = el.dataset.status; CONSULT_VIEW.page = 1; consultGo() })
delegate('consultPage', el => { CONSULT_VIEW.page = Math.max(1, Number(el.dataset.page) || 1); consultGo() })
// 対象の日を含む週（月曜始まり）と案件でシフトボードを開く
delegate('consultOpenBoard', el => {
  const d = dayjs(el.dataset.date)
  const BS = window.__boardState
  if (BS && d.isValid()) {
    BS.from = d.subtract((d.day() + 6) % 7, 'day').format('YYYY-MM-DD')
    BS.clientId = ''
    BS.projectIds = el.dataset.projectId ? [Number(el.dataset.projectId)] : []
  }
  location.hash = 'shifts'
})
delegate('consultReply', el => replyConsult(Number(el.dataset.id)))
delegate('consultClose', el => closeConsult(Number(el.dataset.id), el))

// 返信は相談の本文とこれまでのやり取りを見ながら複数行で書く（#422）。返信は前の返信を消さずに足す（#154）。未対応の相談は返信で『対応中』にする
window.replyConsult = function (id) {
  const co = CONSULT_VIEW.list.find(x => x.consultation_id === id)
  if (!co) return
  modal(`
    <h3 class="font-bold text-lg mb-1">相談への返信</h3>
    <p class="text-xs text-gray-500 mb-2">${esc(co.staff_name)}・${esc(CAT_LABELS[co.category] || co.category)}・${esc(dayjs(String(co.created_at || '').replace(' ', 'T')).format('M/D HH:mm'))}</p>
    <div class="bg-gray-50 rounded-lg px-3 py-2 max-h-64 overflow-y-auto mb-3"><p class="text-sm text-gray-700 whitespace-pre-wrap break-words">${esc(co.body)}</p>${consultThreadHtml(co)}</div>
    <label class="text-sm text-gray-600 block mb-1" for="consult-reply">返信</label>
    <textarea id="consult-reply" class="inp" rows="6" maxlength="2000" placeholder="返信内容を入力してください"></textarea>
    <p class="text-xs text-gray-400 mt-1">スタッフのアプリに通知され、ホームに『返信があります』と表示されます</p>
    <div class="flex justify-end gap-2 mt-4">
      <button class="btn btn-outline" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary" id="consult-reply-send" data-action="consultReplySend" data-id="${Number(co.consultation_id)}"><i class="fas fa-reply"></i>返信する</button>
    </div>`)
  const ta = document.getElementById('consult-reply')
  if (ta) ta.focus()
}
delegate('consultReplySend', el => {
  const id = Number(el.dataset.id)
  const co = CONSULT_VIEW.list.find(x => x.consultation_id === id)
  const reply = (document.getElementById('consult-reply') || {}).value || ''
  if (!reply.trim()) { toast('返信内容を入力してください'); return }
  withSubmitLock(el, async () => {
    try {
      await axios.put('/api/admin/consultations/' + id, { manager_reply: reply, ...(co && co.status === 'open' ? { status: 'in_progress' } : {}) })
    } catch (e) { showApiError(e, '返信を保存できませんでした'); return }
    closeModal(); toast('返信しました'); renderConsult()
  })
})
window.closeConsult = async function (id, btn) {
  await withSubmitLock(btn, async () => {
    try { await axios.put('/api/admin/consultations/' + id, { status: 'done' }) } catch (e) { showApiError(e, '対応済みにできませんでした'); return }
    toast('対応済みにしました'); renderConsult()
  })
}

// ============ 請求前確認 ============
// 金額は精算と同じ計算（交通費の請求区分・請求の調整額を含む請求合計）。total_bill / total がサーバーで計算した請求合計
async function renderBilling(month) {
  loading()
  month = month || dayjs().format('YYYY-MM')
  let data
  try { data = (await axios.get('/api/admin/billing-check?month=' + month)).data } catch (e) { $app.innerHTML = `<p class="text-red-600">${esc(showApiError(e))}</p>`; return }
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">請求前確認</h2>
      <div class="flex gap-2 items-center">
        <button class="btn btn-outline" data-action="renderBilling" data-month="${esc(dayjs(month + '-01').subtract(1, 'month').format('YYYY-MM'))}"><i class="fas fa-chevron-left"></i></button>
        <span class="font-bold">${dayjs(month + '-01').format('YYYY年M月')}</span>
        <button class="btn btn-outline" data-action="renderBilling" data-month="${esc(dayjs(month + '-01').add(1, 'month').format('YYYY-MM'))}"><i class="fas fa-chevron-right"></i></button>
        <button class="btn btn-primary" onclick="exportBillingCsv()"><i class="fas fa-file-csv"></i>CSV出力</button>
      </div>
    </div>
    <p class="text-xs text-gray-500 mb-3">今日までの確定・代打のシフトの請求額です（精算の請求合計と同じ計算: 請求基本額＋請求する交通費＋請求の調整）。支払・粗利と確定は「精算」で確認してください。
      稼働人数は確定・代打のシフトの人数、日報提出は日報が必要な確定・代打のシフトのうち日報があるものです（欠勤・希望（仮）と、日報を不要にしたシフトは数えません）</p>
    <section class="card p-4 mb-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">案件別サマリー</h3>
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead><tr><th>案件</th><th>クライアント</th><th>稼働日数</th><th>稼働人数</th><th>欠勤</th><th>代打</th><th>日報提出</th><th>請求基本額</th><th>交通費</th><th>調整</th><th>請求合計</th></tr></thead>
          <tbody>${data.by_project.map(p => `
            <tr>
              <td class="font-medium">${esc(p.project_name)}</td>
              <td class="text-xs">${esc(p.client_name || '-')}</td>
              <td>${p.work_days}</td><td>${p.staff_count}</td>
              <td>${p.absent_days ? `<span class="badge badge-red">${p.absent_days}</span>` : 0}</td>
              <td>${p.substitute_days || 0}</td>
              <td>${billingReportCell(p)}</td>
              <td>${yen(p.total_amount)}</td><td>${yen(p.total_transport)}</td><td>${p.total_adjust ? yen(p.total_adjust) : '-'}</td>
              <td class="font-bold">${yen(p.total_bill)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3">スタッフ別明細</h3>
      <div class="overflow-x-auto">
        <table class="tbl" id="billing-detail">
          <thead><tr><th>スタッフ</th><th>案件</th><th>稼働日数</th><th>欠勤</th><th>日報提出</th><th>請求基本額</th><th>交通費</th><th>調整</th><th>請求合計</th></tr></thead>
          <tbody>${data.detail.map(d => `
            <tr>
              <td><a href="#staff/${d.staff_id}" class="text-blue-600 hover:underline">${esc(d.name)}</a></td>
              <td class="text-xs">${esc(d.project_name)}</td>
              <td>${d.work_days}</td><td>${d.absent_days || 0}</td><td>${billingReportCell(d)}</td>
              <td>${yen(d.amount)}</td><td>${yen(d.transport)}</td><td>${d.adjust ? yen(d.adjust) : '-'}</td>
              <td class="font-bold">${yen(d.total)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`
  window._billingData = data
}
delegate('renderBilling', el => renderBilling(el.dataset.month))
// 日報提出 n/m（m = 日報が必要な確定・代打のシフト。#448）。日報が必要なシフトがなければ「不要」（稼働がなければ -）
function billingReportCell(x) {
  const need = Number(x.report_required || 0), done = Number(x.report_count || 0)
  if (!need) return Number(x.work_days) ? '<span class="text-gray-400">不要</span>' : '-'
  return `${done}/${need} ${done < need ? `<i class="fas fa-triangle-exclamation text-amber-500" title="日報が未提出のシフトが ${need - done}件 あります"></i>` : '<i class="fas fa-check text-emerald-500"></i>'}`
}
window.exportBillingCsv = function () {
  const data = window._billingData
  if (!data) return
  const rows = data.detail.map(d => [d.name, d.project_name, d.work_days, d.absent_days || 0, d.amount || 0, d.transport || 0, d.adjust || 0, d.total || 0, d.staff_id])
  const csv = adminToCsv(['スタッフ', '案件', '稼働日数', '欠勤', '請求基本額', '交通費', '調整', '請求合計', 'スタッフID'], rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `billing_${data.month}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
  toast('CSVをダウンロードしました')
}
// 画面で組み立てる CSV（#71）。サーバーの src/csv.ts の toCsv と同じ規則にする:
// UTF-8 BOM 付き・CRLF、カンマ・ダブルクォート・改行を含む値は引用符で囲む、= + - @ タブ CR で始まる値（負の数を除く）は先頭に ' を付ける
function adminCsvCell(v) {
  if (v == null) return ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function adminToCsv(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(adminCsvCell).join(',')).join('\r\n') + '\r\n'
}

// ============ アカウント設定（自分のアカウント・パスワード変更・管理者アカウント。#25 #43 #44） ============
const ADMIN_ROLE_LABEL = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当' }
const adminRoleOptions = (cur) => Object.entries(ADMIN_ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('')
let ADMIN_USERS = new Map()

// 仮パスワードを一度だけ表示する（閉じると二度と表示できない）。staff-lifecycle.js のスタッフの再発行でも使う
window.showTempPassword = function (title, password, lines) {
  modal(`
    <h3 class="font-bold text-lg mb-2"><i class="fas fa-key text-blue-600 mr-1"></i>${esc(title)}</h3>
    <p class="text-xs text-red-600 mb-2">この画面を閉じると、仮パスワードは二度と表示できません。本人に伝えてから閉じてください。次回ログインで、本人にパスワードの変更を求めます。</p>
    <textarea id="temp-pw-text" class="inp font-mono text-sm" rows="${(lines || []).length + 1}" readonly>${esc([...(lines || []), '仮パスワード: ' + password].join('\n'))}</textarea>
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

async function renderAccount() {
  loading()
  let me, list = null
  try {
    me = (await axios.get('/api/auth/account')).data
    if (me.role === 'company_admin') list = (await axios.get('/api/admin/users')).data
  } catch (e) { $app.innerHTML = '<p class="text-center text-gray-400 py-10">アカウント情報を取得できませんでした</p>'; return }
  ADMIN_USERS = new Map((list ? list.users : []).map(u => [u.user_id, u]))
  $app.innerHTML = `
    <h2 class="text-xl font-bold text-gray-900 mb-4">アカウント設定</h2>
    ${me.must_change_password ? `<div class="card p-3 mb-4 border-red-200 bg-red-50 text-sm text-red-700"><i class="fas fa-triangle-exclamation mr-1"></i>仮パスワードのままです。下の「パスワードの変更」で、自分だけが知っているパスワードに変更してください。</div>` : ''}
    ${!me.email ? `<div class="card p-3 mb-4 bg-amber-50 text-sm text-amber-800"><i class="fas fa-envelope mr-1"></i>メールアドレスが登録されていません。登録すると、打刻修正の承認依頼などの通知と、パスワードを忘れたときの再設定メールが届きます。</div>` : ''}
    <div class="grid lg:grid-cols-2 gap-4 mb-6">
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-user text-blue-500 mr-1"></i>自分のアカウント</h3>
        <dl class="text-sm mb-3">
          <div class="flex py-1"><dt class="w-24 text-gray-400">ID</dt><dd>${esc(me.user_code)}</dd></div>
          <div class="flex py-1"><dt class="w-24 text-gray-400">権限</dt><dd>${esc(ADMIN_ROLE_LABEL[me.role] || me.role)}</dd></div>
        </dl>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-600 block mb-1">氏名</label><input id="ac-name" class="inp" value="${esc(me.name)}" maxlength="60"></div>
          <div><label class="text-sm text-gray-600 block mb-1">メールアドレス（通知・パスワード再設定の宛先）</label><input id="ac-email" type="email" class="inp" value="${esc(me.email || '')}" data-current="${esc(me.email || '')}" autocomplete="email"></div>
          <div><label class="text-sm text-gray-600 block mb-1">現在のパスワード（メールアドレスを変更するときだけ）</label><input id="ac-email-pw" type="password" class="inp" autocomplete="current-password"></div>
          <button class="btn btn-primary w-full" data-action="saveMyAccount">保存する</button>
          <p class="text-[11px] text-gray-400">メールアドレスを変更すると、新しいアドレスに確認のメールを、以前のアドレスに変更のお知らせを送ります。</p>
        </div>
      </section>
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-lock text-blue-500 mr-1"></i>パスワードの変更</h3>
        <div class="space-y-3">
          <div><label class="text-sm text-gray-600 block mb-1">現在のパスワード</label><input id="pw-current" type="password" class="inp" autocomplete="current-password"></div>
          <div><label class="text-sm text-gray-600 block mb-1">新しいパスワード（8文字以上）</label><input id="pw-new" type="password" class="inp" autocomplete="new-password"></div>
          <div><label class="text-sm text-gray-600 block mb-1">新しいパスワード（確認）</label><input id="pw-new2" type="password" class="inp" autocomplete="new-password"></div>
          <button class="btn btn-primary w-full" data-action="changeMyPassword">変更する</button>
          <p class="text-[11px] text-gray-400">変更すると、ほかの端末のログインは終了します。</p>
        </div>
      </section>
    </div>
    <section class="card p-3 mb-6 flex items-center gap-3 flex-wrap">
      <i class="fas fa-shield-halved text-blue-500"></i>
      <span class="text-sm flex-1">二段階認証・ログイン中の端末・スタッフのログインの終了${me.role === 'company_admin' ? '・ログインの履歴・接続元の制限' : ''}は「セキュリティ」の画面で行います。</span>
      <a href="#security" class="btn btn-outline text-sm">セキュリティへ</a>
    </section>
    ${list ? adminUsersHtml(list.users, list.me) : '<p class="text-xs text-gray-400">管理者アカウントの追加・権限の変更・停止は、会社管理者が行います。</p>'}`
}

function adminUsersHtml(users, meId) {
  return `
    <section class="card p-4">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-user-shield text-blue-500 mr-1"></i>管理者アカウント</h3>
          <p class="text-[11px] text-gray-400">営業・現場・事務の担当者ごとにアカウントを作ると、承認・確定した人が正しく記録されます。退職した担当者は「停止」にしてください。</p>
        </div>
        <button class="btn btn-primary text-sm" data-action="showAddAdminUser"><i class="fas fa-plus"></i>管理者を追加</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-gray-400 text-xs border-b border-gray-100">
            <th class="text-left py-2">ID</th><th class="text-left py-2">氏名</th><th class="text-left py-2">メール</th><th class="text-left py-2">権限</th><th class="text-left py-2">状態</th><th class="text-left py-2">最終ログイン</th><th></th>
          </tr></thead>
          <tbody>
            ${users.map(u => `
              <tr class="border-b border-gray-50">
                <td class="py-2 text-gray-500">${esc(u.user_code)}</td>
                <td class="py-2">${esc(u.name)}${u.user_id === meId ? ' <span class="badge badge-blue">自分</span>' : ''}</td>
                <td class="py-2 text-xs">${u.email ? esc(u.email) : '<span class="text-amber-600">未登録</span>'}</td>
                <td class="py-2">${esc(ADMIN_ROLE_LABEL[u.role] || u.role)}</td>
                <td class="py-2">${u.status === 'active' ? '<span class="badge badge-green">利用中</span>' : '<span class="badge badge-gray">停止</span>'}${u.must_change_password ? ' <span class="badge badge-yellow">仮パスワード</span>' : ''}</td>
                <td class="py-2 text-xs text-gray-400">${u.last_login_at ? esc(dayjs(u.last_login_at).format('M/D HH:mm')) : '-'}</td>
                <td class="py-2 text-right whitespace-nowrap">
                  <button class="btn btn-outline text-xs" data-action="editAdminUser" data-id="${u.user_id}">編集</button>
                  ${u.user_id === meId ? '' : `
                    ${u.status === 'active' ? `<button class="btn btn-outline text-xs" data-action="resetAdminUserPassword" data-id="${u.user_id}">パスワード再発行</button>` : ''}
                    <button class="btn btn-outline text-xs" data-action="toggleAdminUserStatus" data-id="${u.user_id}">${u.status === 'active' ? '停止' : '利用を再開'}</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`
}

delegate('saveMyAccount', (el) => withSubmitLock(el, async () => {
  const email = document.getElementById('ac-email')
  const body = { name: document.getElementById('ac-name').value.trim(), email: email.value.trim() }
  if (body.email !== (email.dataset.current || '')) body.current_password = document.getElementById('ac-email-pw').value
  try {
    const { data } = await axios.put('/api/auth/account', body)
    ME = (await axios.get('/api/auth/me')).data
    showCompanyName(ME.company_name + ' / ' + ME.name)
    toast(data.email_notice_sent ? '保存しました。新しいメールアドレスに確認のメールを送りました' : '保存しました')
    renderAccount()
  } catch (e) { showApiError(e, '保存に失敗しました') }
}))
delegate('changeMyPassword', (el) => withSubmitLock(el, async () => {
  const cur = document.getElementById('pw-current').value
  const next = document.getElementById('pw-new').value
  if (next !== document.getElementById('pw-new2').value) { toast('新しいパスワード（確認）が一致しません'); return }
  try {
    await axios.post('/api/auth/change-password', { current_password: cur, new_password: next })
    if (ME) ME.must_change_password = false
    toast('パスワードを変更しました')
    renderAccount()
  } catch (e) { showApiError(e, 'パスワードの変更に失敗しました') }
}))

delegate('showAddAdminUser', () => {
  modal(`
    <h3 class="font-bold text-lg mb-4">管理者を追加</h3>
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">ID *</label><input id="au-code" class="inp" placeholder="sales02"></div>
        <div><label class="text-sm text-gray-600 block mb-1">氏名 *</label><input id="au-name" class="inp" maxlength="60"></div>
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">メールアドレス（通知・パスワード再設定の宛先）</label><input id="au-email" type="email" class="inp"></div>
      <div><label class="text-sm text-gray-600 block mb-1">権限 *</label><select id="au-role" class="inp">${adminRoleOptions('field_manager')}</select></div>
      <div><label class="text-sm text-gray-600 block mb-1">初期パスワード（空欄なら自動で作ります）</label><input id="au-pass" class="inp" autocomplete="new-password" placeholder="8文字以上"></div>
      <p class="text-[11px] text-gray-400">初回ログインで、本人にパスワードの変更を求めます。ログインの会社コードは自社の会社コードです。</p>
      <button class="btn btn-primary w-full" data-action="addAdminUser">追加する</button>
    </div>`)
})
delegate('addAdminUser', (el) => withSubmitLock(el, async () => {
  const v = id => document.getElementById(id).value.trim()
  try {
    const { data } = await axios.post('/api/admin/users', { user_code: v('au-code'), name: v('au-name'), email: v('au-email'), role: v('au-role'), password: document.getElementById('au-pass').value })
    const code = v('au-code'), name = v('au-name')
    closeModal(); toast('管理者を追加しました'); renderAccount()
    if (data.temp_password) showTempPassword('管理者を追加しました', data.temp_password, [`氏名: ${name}`, `ID: ${code}`, `ログイン: ${location.origin}/login`])
  } catch (e) { showApiError(e, '追加に失敗しました') }
}))
delegate('editAdminUser', (el) => {
  const u = ADMIN_USERS.get(Number(el.dataset.id)); if (!u) return
  const isMe = ME && u.user_id === ME.user_id
  modal(`
    <h3 class="font-bold text-lg mb-4">管理者の編集（${esc(u.user_code)}）</h3>
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">氏名 *</label><input id="eu-name" class="inp" value="${esc(u.name)}" maxlength="60"></div>
      <div><label class="text-sm text-gray-600 block mb-1">メールアドレス</label><input id="eu-email" type="email" class="inp" value="${esc(u.email || '')}"></div>
      <div><label class="text-sm text-gray-600 block mb-1">権限</label><select id="eu-role" class="inp" ${isMe ? 'disabled' : ''}>${adminRoleOptions(u.role)}</select>
        ${isMe ? '<p class="text-[11px] text-gray-400 mt-1">自分の権限は変更できません。自分のメールアドレスは「自分のアカウント」から変更してください。</p>' : ''}</div>
      <button class="btn btn-primary w-full" data-action="saveAdminUser" data-id="${u.user_id}">保存する</button>
    </div>`)
  if (isMe) document.getElementById('eu-email').disabled = true
})
delegate('saveAdminUser', (el) => withSubmitLock(el, async () => {
  const id = Number(el.dataset.id)
  const isMe = ME && id === ME.user_id
  const body = { name: document.getElementById('eu-name').value.trim() }
  if (!isMe) { body.email = document.getElementById('eu-email').value.trim(); body.role = document.getElementById('eu-role').value }
  try {
    await axios.put('/api/admin/users/' + id, body)
    closeModal(); toast('保存しました'); renderAccount()
  } catch (e) { showApiError(e, '保存に失敗しました') }
}))
delegate('toggleAdminUserStatus', (el) => {
  const u = ADMIN_USERS.get(Number(el.dataset.id)); if (!u) return
  const next = u.status === 'active' ? 'suspended' : 'active'
  if (next === 'suspended' && !confirm(`${u.name}（${u.user_code}）のアカウントを停止します。ログイン中の画面もすぐに使えなくなります。よろしいですか？`)) return
  withSubmitLock(el, async () => {
    try {
      await axios.put('/api/admin/users/' + u.user_id, { status: next })
      toast(next === 'suspended' ? '停止しました' : '利用を再開しました'); renderAccount()
    } catch (e) { showApiError(e, '変更に失敗しました') }
  })
})
delegate('resetAdminUserPassword', (el) => {
  const u = ADMIN_USERS.get(Number(el.dataset.id)); if (!u) return
  modal(`
    <h3 class="font-bold text-lg mb-2">パスワードの再発行（${esc(u.name)}）</h3>
    <p class="text-xs text-gray-500 mb-3">今のパスワードは使えなくなり、ログイン中の画面もログアウトされます。</p>
    <div class="space-y-2">
      ${u.email ? `<button class="btn btn-outline w-full" data-action="doResetAdminUserPassword" data-id="${u.user_id}" data-mode="email"><i class="fas fa-envelope"></i>再設定メールを送る（${esc(u.email)}）</button>` : ''}
      <button class="btn btn-primary w-full" data-action="doResetAdminUserPassword" data-id="${u.user_id}" data-mode="temp"><i class="fas fa-key"></i>仮パスワードを発行する</button>
      <button class="btn btn-outline w-full" onclick="closeModal()">キャンセル</button>
    </div>`)
})
delegate('doResetAdminUserPassword', (el) => withSubmitLock(el, async () => {
  const u = ADMIN_USERS.get(Number(el.dataset.id)); if (!u) return
  try {
    const { data } = await axios.post(`/api/admin/users/${u.user_id}/reset-password`, { mode: el.dataset.mode })
    closeModal(); renderAccount()
    if (data.mode === 'email') toast('パスワード再設定メールを送りました')
    else showTempPassword('仮パスワードを発行しました', data.temp_password, [`氏名: ${u.name}`, `ID: ${u.user_code}`, `ログイン: ${location.origin}/login`])
  } catch (e) { showApiError(e, '再発行に失敗しました') }
}))

// ダッシュボード: メールアドレスのない管理者に登録を案内する（#25）
function accountEmailNotice() {
  if (!ME || ME.email || document.getElementById('account-email-notice')) return
  $app.insertAdjacentHTML('afterbegin', `<div id="account-email-notice" class="card p-3 mb-4 bg-amber-50 text-sm text-amber-800 flex items-center gap-2 flex-wrap">
    <i class="fas fa-envelope"></i><span class="flex-1">通知メール（打刻修正の承認依頼など）を受け取るには、メールアドレスを登録してください。</span>
    <a href="#account" class="btn btn-outline text-xs">アカウント設定へ</a></div>`)
}

// ============ ルーティング ============
const routes = {
  dashboard: async () => { await renderDashboard(); accountEmailNotice() }, account: renderAccount, staff: renderStaff, projects: renderProjects, clients: renderClients,
  shifts: () => (window.renderShiftBoard ? renderShiftBoard() : renderShifts()), reports: () => renderReports(), analytics: () => renderAnalytics(),
  notices: renderNotices, follow: renderFollow, consult: renderConsult, billing: () => renderBilling(), settlement: () => (window.renderSettlement ? renderSettlement() : renderBilling()), recruit: () => (window.renderRecruit ? renderRecruit() : renderDashboard()),
  'notice-reports': () => renderNoticeReadReport(), employees: renderEmployees,
  'report-settings': () => (window.renderReportSettings ? renderReportSettings() : renderDashboard()),
  corrections: () => (window.renderCorrections ? renderCorrections() : renderDashboard()),
  notifications: () => (window.renderNotificationsInbox ? renderNotificationsInbox() : renderDashboard()),
  'attendance-history': () => (window.renderAttendanceHistory ? renderAttendanceHistory() : renderDashboard()),
  security: () => (window.renderSecurity ? renderSecurity() : renderDashboard())
}

function route() {
  const hash = (location.hash || '#dashboard').slice(1)
  const [tab, id] = hash.split('/')
  // 二段階認証が必須で未登録の間は、登録の画面だけを使える（#544。API でも同じ判定で止める）
  if (ME && ME.mfa_setup_required && tab !== 'security') { history.replaceState(null, '', '#security'); toast('二段階認証の登録が必要です'); return route() }
  // 仮パスワードのままの間は、パスワードの変更を先に求める（#43 #44）
  if (ME && !ME.mfa_setup_required && ME.must_change_password && tab !== 'account') { history.replaceState(null, '', '#account'); toast('仮パスワードのままです。パスワードを変更してください'); return route() }
  document.querySelectorAll('.side-link').forEach(el => el.classList.toggle('active', el.dataset.tab === tab))
  const mob = document.getElementById('mobile-nav')
  if (mob && routes[tab]) mob.value = tab
  // 自社の日報テンプレートの作成・編集（#165）
  if (tab === 'projects' && id === 'templates') return renderAdminTemplates()
  // 詳細画面の ID は onclick などに埋め込まれるため、数字以外（細工したリンク）は一覧へ戻す
  if (['staff', 'projects', 'clients', 'employees'].includes(tab) && id && !/^\d+$/.test(id)) { location.hash = tab; return }
  // 従業員管理（労務情報）は会社管理者・事務担当のみ（#205。API でも同じ判定で止める）
  // 社員の詳細へのリンク（スタッフマスタの登録後・未入力の一覧など）は、スタッフ詳細で開く
  if (tab === 'employees' && ME && !ME.can_manage_hr) {
    if (id) { history.replaceState(null, '', '#staff/' + id); return route() }
    $app.innerHTML = '<div class="card p-6 text-center text-sm text-gray-500"><i class="fas fa-lock mr-1"></i>従業員管理（給与・口座・保険番号などの労務情報）は、会社管理者と事務担当のみ利用できます。</div>'; return
  }
  if (tab === 'staff' && id) return renderStaffDetail(id)
  if (tab === 'projects' && id) return renderProjectDetail(id)
  if (tab === 'clients' && id) return renderClientDetail(id)
  if (tab === 'employees' && id) return renderEmployeeDetail(id)
  if (tab === 'shifts' && id === 'week') return renderShifts()
  if (tab === 'board' && window.renderBoard) return renderBoard(id)
  if (tab === 'report-settings' && window.renderReportSettings) return renderReportSettings(id)
  if (tab === 'corrections' && id === 'emails' && window.renderCorrectionEmails) return renderCorrectionEmails()
  if (tab === 'corrections' && window.renderCorrections) return renderCorrections(id)
  ;(routes[tab] || renderDashboard)()
}

window.addEventListener('hashchange', route)
document.getElementById('mobile-nav').addEventListener('change', e => { location.hash = e.target.value })

;(async () => {
  try {
    const { data } = await axios.get('/api/auth/me')
    ME = data
    showCompanyName(data.company_name + ' / ' + data.name)
  } catch (e) { return }
  // 従業員管理を扱えないロールには、メニューとスタッフ詳細の「従業員管理」ボタンを出さない（#205）
  if (!ME.can_manage_hr) {
    document.querySelectorAll('.side-link[data-tab="employees"], #mobile-nav option[value="employees"]').forEach(el => el.remove())
    const st = document.createElement('style'); st.textContent = 'a.btn[href^="#employees/"]{display:none!important}'; document.head.appendChild(st)
  }
  route()
})()
