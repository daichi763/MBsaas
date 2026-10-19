// セキュリティの画面（作業単位 w4-auth-features: #544 #453 #552）
// 管理画面（admin.js の #security）と本部画面（hq.js の #security）で共用する。
// - 自分の二段階認証（認証アプリ）の登録・解除・予備コード、自分のログイン中の端末と「すべての端末からログアウト」
// - 管理画面: スタッフのログインの強制終了（管理系のロール全員）。会社の設定・管理者の二段階認証・ログインの履歴（会社管理者のみ）
// - 本部: 本部ユーザーの設定・ログインの強制終了、二段階認証と接続元の制限の解除（問い合わせ窓口）、全社のログインの履歴
;(function () {
  const IS_HQ = location.pathname.startsWith('/hq')
  const CARD = IS_HQ ? 'bg-slate-800 border border-slate-700 rounded-xl p-4' : 'card p-4'
  const H3 = IS_HQ ? 'font-bold mb-3' : 'text-sm font-bold text-gray-700 mb-3'
  const ICON = IS_HQ ? 'text-cyan-400' : 'text-blue-500'
  const MUTED = IS_HQ ? 'text-slate-400' : 'text-gray-500'
  const BORDER = IS_HQ ? 'border-slate-700' : 'border-gray-100'
  const INP = IS_HQ ? 'class="inp" style="background:#1e293b;border-color:#334155;color:#fff"' : 'class="inp"'
  const app = () => document.getElementById('app')

  const RESULT_LABEL = {
    success: ['成功', 'badge-green'], bad_password: ['ID・パスワードの誤り', 'badge-red'], locked: ['失敗が続き一時停止', 'badge-red'],
    inactive: ['停止中のアカウント', 'badge-yellow'], company_inactive: ['契約停止中', 'badge-yellow'], ip_denied: ['接続元の制限', 'badge-red'], mfa_failed: ['確認コードの誤り', 'badge-red'],
  }
  const EVENT_LABEL = { login: 'ログイン', password_reset: 'パスワード再設定', logout_all: '本人がすべての端末からログアウト', forced_logout: '管理者がログインを終了' }
  const METHOD_LABEL = { password: 'パスワード', totp: 'パスワード＋認証アプリ', recovery: 'パスワード＋予備コード' }
  const ROLE_LABEL = { company_admin: '会社管理者', sales_manager: '営業管理者', field_manager: '現場管理者', office_staff: '事務担当', system_admin: '本部' }

  // ログインの履歴・セッションの日時は UTC（ISO 8601 または CURRENT_TIMESTAMP）。最終ログイン（last_login_at）は日本時間の文字列
  function utcTime(s) {
    if (!s) return '-'
    let t = String(s)
    if (!/[TZ]/.test(t)) t = t.replace(' ', 'T') + 'Z'
    const d = dayjs(t)
    return d.isValid() ? d.format('YYYY/M/D HH:mm') : esc(s)
  }
  function jstTime(s) { return s ? esc(dayjs(String(s).replace(' ', 'T')).format('YYYY/M/D HH:mm')) : '-' }
  function resultBadge(r) { const l = RESULT_LABEL[r] || [r, 'badge-gray']; return `<span class="badge ${l[1]}">${esc(l[0])}</span>` }
  function failText(e, fallback) { return showApiError(e, fallback) }
  function sectionError(el, msg, action) {
    el.innerHTML = `<p class="text-sm text-red-500">${esc(msg)} <button class="btn btn-outline text-xs ml-2" data-action="${action}">再読み込み</button></p>`
  }

  // ============ 自分の二段階認証 ============
  function mfaCardHtml(m) {
    if (!m.available) return `<h3 class="${H3}"><i class="fas fa-shield-halved ${ICON} mr-1"></i>二段階認証</h3><p class="text-sm ${MUTED}">このアカウントでは使えません。</p>`
    const head = `<h3 class="${H3}"><i class="fas fa-shield-halved ${ICON} mr-1"></i>自分の二段階認証（認証アプリ）</h3>`
    if (m.enabled) {
      return `${head}
        <p class="text-sm mb-2"><span class="badge badge-green">登録済み</span> <span class="${MUTED} text-xs">${utcTime(m.enabled_at)} に登録</span></p>
        <p class="text-xs ${MUTED} mb-3">ログインのたびに、パスワードの後で認証アプリの6桁を入力します。予備コードの残り: <b>${Number(m.recovery_codes_left) || 0}</b> 個${m.recovery_codes_left <= 2 ? '（少なくなっています。作り直してください）' : ''}</p>
        <div class="space-y-2">
          <input id="sec-mfa-pw" type="password" ${INP} autocomplete="current-password" placeholder="現在のパスワード">
          ${m.required ? '' : `<input id="sec-mfa-code" ${INP} inputmode="numeric" autocomplete="one-time-code" placeholder="解除するときは、認証アプリの6桁（または予備コード）">`}
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-outline text-sm" data-action="secMfaRecovery"><i class="fas fa-key"></i>予備コードを作り直す</button>
            ${m.required ? '' : '<button class="btn btn-outline text-sm" data-action="secMfaDisable"><i class="fas fa-unlock"></i>解除する</button>'}
          </div>
          ${m.required ? `<p class="text-[11px] ${MUTED}">${IS_HQ ? '本部' : '会社'}の設定で必須のため、自分では解除できません。スマホを替えるときは、${IS_HQ ? '別の本部ユーザー' : '会社管理者（会社管理者の方は本部）'}に解除を依頼してください。</p>` : ''}
        </div>`
    }
    return `${head}
      ${m.required ? `<p class="text-sm text-red-600 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>${IS_HQ ? '本部' : '会社'}の設定で必須です。登録するまで、ほかの画面は使えません。</p>` : ''}
      <p class="text-sm ${MUTED} mb-3">パスワードが漏れても、本人のスマホがなければログインできないようにします。スマホに認証アプリ（Google Authenticator、Microsoft Authenticator など）を入れてから始めてください。</p>
      <div id="sec-mfa-setup"><button class="btn btn-primary" data-action="secMfaStart"><i class="fas fa-qrcode"></i>登録を始める</button></div>`
  }
  delegate('secMfaStart', (el) => withSubmitLock(el, async () => {
    let d
    try { d = (await axios.post('/api/auth/mfa/setup')).data } catch (e) { failText(e, '登録を始められませんでした'); return }
    let qr = ''
    try { if (window.qrcode) { const q = qrcode(0, 'M'); q.addData(d.uri); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) } } catch (e) { qr = '' }
    document.getElementById('sec-mfa-setup').innerHTML = `
      <ol class="text-sm space-y-3 list-decimal pl-5">
        <li>認証アプリで、この QR コードを読み取ってください。${qr ? `<div class="bg-white p-2 rounded-lg w-44 mt-2">${qr}</div>` : ''}
          <p class="text-[11px] ${MUTED} mt-1">読み取れないときは、アプリで「キーを入力」を選び、次のキーを入力します（時間ベース）。</p>
          <p class="font-mono text-xs break-all select-all mt-1">${esc(String(d.secret).replace(/(.{4})/g, '$1 ').trim())}</p></li>
        <li>アプリに表示された6桁と、現在のパスワードを入力してください。
          <div class="space-y-2 mt-2">
            <input id="sec-mfa-new-code" ${INP} inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="6桁の確認コード">
            <input id="sec-mfa-new-pw" type="password" ${INP} autocomplete="current-password" placeholder="現在のパスワード">
            <button class="btn btn-primary w-full" data-action="secMfaEnable">登録を完了する</button>
          </div></li>
      </ol>`
    const code = document.getElementById('sec-mfa-new-code'); if (code) code.focus()
  }))
  delegate('secMfaEnable', (el) => withSubmitLock(el, async () => {
    const code = document.getElementById('sec-mfa-new-code').value.trim()
    const password = document.getElementById('sec-mfa-new-pw').value
    if (!code || !password) { toast('確認コードと現在のパスワードを入力してください'); return }
    try {
      const { data } = await axios.post('/api/auth/mfa/enable', { code, password })
      showRecoveryCodes(data.recovery_codes, '二段階認証を登録しました')
    } catch (e) { failText(e, '登録に失敗しました') }
  }))
  // 予備コードは一度だけ表示する。閉じたら画面を読み直す（登録待ちの制限を解き、メニューを使えるようにする）
  function showRecoveryCodes(codes, title) {
    modal(`
      <h3 class="font-bold text-lg mb-2 text-gray-800">${esc(title)}</h3>
      <p class="text-sm text-gray-600 mb-3">スマホを失くしたときなど、認証アプリを使えないときの<b>予備コード</b>です。1つにつき1回だけ、6桁の代わりに使えます。<b>この画面を閉じると二度と表示できません。</b>印刷するか、パスワード管理アプリなど安全な場所に控えてください。</p>
      <div class="grid grid-cols-2 gap-2 font-mono text-sm bg-gray-50 rounded-lg p-3 mb-3 text-gray-800 select-all" id="sec-rc-list">${codes.map(c => `<span>${esc(c)}</span>`).join('')}</div>
      <div class="flex flex-wrap gap-2 justify-end">
        <button class="btn btn-outline" data-action="secRcCopy"><i class="fas fa-copy"></i>コピー</button>
        <button class="btn btn-primary" data-action="secRcDone">控えました</button>
      </div>`)
    // 背景のタップでは閉じない（控える前に消えないように）
    const bg = document.querySelector('#modal-root .modal-bg'); if (bg) bg.onclick = null
  }
  delegate('secRcCopy', async () => {
    const text = [...document.querySelectorAll('#sec-rc-list span')].map(s => s.textContent).join('\n')
    try { await navigator.clipboard.writeText(text); toast('コピーしました') } catch (e) { toast('コピーできませんでした。手で控えてください') }
  })
  delegate('secRcDone', () => { closeModal(); location.reload() })
  delegate('secMfaRecovery', (el) => withSubmitLock(el, async () => {
    const password = document.getElementById('sec-mfa-pw').value
    if (!password) { toast('現在のパスワードを入力してください'); return }
    if (!confirm('予備コードを作り直します。以前の予備コードは使えなくなります。よろしいですか？')) return
    try { showRecoveryCodes((await axios.post('/api/auth/mfa/recovery-codes', { password })).data.recovery_codes, '予備コードを作り直しました') }
    catch (e) { failText(e, '作り直せませんでした') }
  }))
  delegate('secMfaDisable', (el) => withSubmitLock(el, async () => {
    const password = document.getElementById('sec-mfa-pw').value
    const code = (document.getElementById('sec-mfa-code') || {}).value || ''
    if (!password || !code.trim()) { toast('現在のパスワードと、認証アプリの6桁（または予備コード）を入力してください'); return }
    if (!confirm('二段階認証を解除します。ログインはパスワードだけになります。よろしいですか？')) return
    try { await axios.post('/api/auth/mfa/disable', { password, code: code.trim() }); toast('二段階認証を解除しました'); reloadSecurity() }
    catch (e) { failText(e, '解除できませんでした') }
  }))

  // ============ 自分のログイン中の端末 ============
  function sessionRowsHtml(list, opts = {}) {
    if (!list.length) return `<p class="text-sm ${MUTED}">ログイン中の端末はありません。</p>`
    return `<ul class="divide-y ${IS_HQ ? 'divide-slate-700' : 'divide-gray-100'} text-sm">${list.map(s => `
      <li class="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="font-medium"><i class="fas ${/iPhone|Android|iPad/.test(s.device) ? 'fa-mobile-screen' : 'fa-display'} ${MUTED} mr-1"></i>${esc(s.device)}</span>
        ${s.current ? '<span class="badge badge-blue">この端末</span>' : ''}
        ${opts.showOther && s.other_company ? '<span class="badge badge-gray">他社の画面</span>' : ''}
        <span class="text-xs ${MUTED}">ログイン ${utcTime(s.created_at)} / 接続元 ${esc(s.ip || '不明')}</span>
      </li>`).join('')}</ul>`
  }
  function mySessionsHtml(list) {
    return `<h3 class="${H3}"><i class="fas fa-laptop-mobile ${ICON} mr-1"></i>自分のログイン中の端末</h3>
      ${sessionRowsHtml(list)}
      <button class="btn btn-outline text-sm mt-3" data-action="secLogoutAll"><i class="fas fa-right-from-bracket"></i>すべての端末からログアウト</button>
      <p class="text-[11px] ${MUTED} mt-1">心当たりのない端末があるときや、共用の端末でログアウトを忘れたときに使います。この端末もログアウトします。心当たりがなければパスワードも変更してください。</p>`
  }
  delegate('secLogoutAll', (el) => {
    if (!confirm('すべての端末（この端末を含む）からログアウトします。よろしいですか？')) return
    withSubmitLock(el, async () => {
      try { await axios.post('/api/auth/logout-all'); location.href = '/login' } catch (e) { failText(e, 'ログアウトできませんでした') }
    })
  })

  // ============ ログインの履歴（会社管理者: 自社 / 本部: 全社） ============
  const HIST = { page: 1, result: '', q: '', company_id: '' }
  function historyFrameHtml(companies) {
    return `<h3 class="${H3}"><i class="fas fa-clock-rotate-left ${ICON} mr-1"></i>ログインの履歴</h3>
      <p class="text-[11px] ${MUTED} mb-2">ログインの成功・失敗、パスワードの再設定、ログインの強制終了を1年間残します。心当たりのない接続元や、失敗が続く ID がないかを確かめてください。</p>
      <div class="flex flex-wrap gap-2 mb-3">
        ${companies ? `<select id="sec-h-company" ${INP.replace('class="inp"', 'class="inp w-auto"')}><option value="">すべての会社</option><option value="unknown">会社コードの誤りなど（会社不明）</option>${companies.map(c => `<option value="${c.company_id}">${esc(c.company_name)}</option>`).join('')}</select>` : ''}
        <select id="sec-h-result" ${INP.replace('class="inp"', 'class="inp w-auto"')}><option value="">すべて</option><option value="failed">失敗だけ</option><option value="success">成功だけ</option></select>
        <input id="sec-h-q" ${INP.replace('class="inp"', 'class="inp w-auto"')} placeholder="ID・氏名・接続元" maxlength="50">
        <button class="btn btn-outline text-sm" data-action="secHistSearch"><i class="fas fa-magnifying-glass"></i>絞り込む</button>
      </div>
      <div id="sec-h-body"><div class="flex justify-center py-6"><span class="spin"></span></div></div>`
  }
  async function loadHistory() {
    const box = document.getElementById('sec-h-body'); if (!box) return
    const params = new URLSearchParams({ page: String(HIST.page) })
    if (HIST.result) params.set('result', HIST.result)
    if (HIST.q) params.set('q', HIST.q)
    if (IS_HQ && HIST.company_id) params.set('company_id', HIST.company_id)
    let d
    try { d = (await axios.get((IS_HQ ? '/api/hq/login-history?' : '/api/admin/login-history?') + params)).data }
    catch (e) { sectionError(box, 'ログインの履歴を読み込めませんでした', 'secHistReload'); return }
    const alerts = (d.alerts || []).length ? `<div class="rounded-lg p-3 mb-3 text-sm ${IS_HQ ? 'bg-red-900/30 text-red-200' : 'bg-red-50 text-red-700'}">
        <p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>直近24時間に失敗が続いている ID（${d.alert_threshold}回以上）</p>
        <ul class="text-xs space-y-0.5">${d.alerts.map(a => `<li>${IS_HQ ? esc(a.company_name || '会社不明') + ' / ' : ''}ID ${esc(a.user_code || '-')}${a.user_name ? '（' + esc(a.user_name) + '）' : '（該当なし）'}: ${a.failures}回・接続元${a.ip_count}か所・最後 ${utcTime(a.last_at)}</li>`).join('')}</ul>
        <p class="text-[11px] mt-1">総当たりやパスワードの使い回しの疑いがあります。本人に確かめ、必要ならパスワードの再発行や二段階認証の登録をしてください。</p></div>` : ''
    const rows = d.events.map(e => `
      <tr class="border-b ${BORDER}">
        <td class="py-2 pr-2 whitespace-nowrap text-xs">${utcTime(e.created_at)}</td>
        <td class="py-2 pr-2">${resultBadge(e.result)}</td>
        <td class="py-2 pr-2 text-xs">${esc(EVENT_LABEL[e.event_type] || e.event_type)}${e.method && e.event_type === 'login' ? `<br><span class="${MUTED}">${esc(METHOD_LABEL[e.method] || e.method)}</span>` : ''}${e.actor_name ? `<br><span class="${MUTED}">操作: ${esc(e.actor_name)}</span>` : ''}</td>
        ${IS_HQ ? `<td class="py-2 pr-2 text-xs">${esc(e.company_name || (e.company_code ? '不明（' + e.company_code + '）' : '本部・会社コードなし'))}</td>` : ''}
        <td class="py-2 pr-2 text-xs">${esc(e.user_code || '-')}${e.user_name ? `<br><span class="${MUTED}">${esc(e.user_name)}</span>` : e.result === 'bad_password' ? `<br><span class="${MUTED}">該当する ID なし</span>` : ''}</td>
        <td class="py-2 pr-2 text-xs font-mono">${esc(e.ip || '-')}</td>
        <td class="py-2 text-xs">${esc(e.device)}</td>
      </tr>`).join('')
    box.innerHTML = `${alerts}
      ${d.events.length ? `<div class="overflow-x-auto"><table class="w-full text-sm">
        <thead><tr class="${MUTED} text-xs border-b ${BORDER}"><th class="text-left py-2">日時</th><th class="text-left py-2">結果</th><th class="text-left py-2">種類</th>${IS_HQ ? '<th class="text-left py-2">会社</th>' : ''}<th class="text-left py-2">ID</th><th class="text-left py-2">接続元</th><th class="text-left py-2">端末</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : `<p class="text-sm ${MUTED}">該当する記録はありません。</p>`}
      <div class="flex justify-between items-center mt-3 text-sm">
        <button class="btn btn-outline text-xs" data-action="secHistPage" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>前へ</button>
        <span class="${MUTED} text-xs">${d.page} ページ</span>
        <button class="btn btn-outline text-xs" data-action="secHistPage" data-page="${d.page + 1}" ${d.has_more ? '' : 'disabled'}>次へ</button>
      </div>`
  }
  function readHistoryFilter() {
    HIST.result = (document.getElementById('sec-h-result') || {}).value || ''
    HIST.q = ((document.getElementById('sec-h-q') || {}).value || '').trim()
    HIST.company_id = (document.getElementById('sec-h-company') || {}).value || ''
  }
  function restoreHistoryFilter() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v }
    set('sec-h-result', HIST.result); set('sec-h-q', HIST.q); set('sec-h-company', HIST.company_id)
    const q = document.getElementById('sec-h-q')
    if (q) q.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); readHistoryFilter(); HIST.page = 1; loadHistory() } })
  }
  delegate('secHistSearch', () => { readHistoryFilter(); HIST.page = 1; loadHistory() })
  delegate('secHistPage', (el) => { HIST.page = Math.max(1, Number(el.dataset.page) || 1); loadHistory() })
  delegate('secHistReload', () => loadHistory())

  // ============ 接続元の制限・二段階認証の必須（会社管理者: 自社 / 本部: 本部ユーザー） ============
  function settingsHtml(s) {
    const who = IS_HQ ? '本部ユーザー' : '管理画面を使う全員（会社管理者・営業管理者・現場管理者・事務担当）'
    return `<h3 class="${H3}"><i class="fas fa-building-shield ${ICON} mr-1"></i>${IS_HQ ? '本部ユーザーの設定' : '会社の設定'}</h3>
      <label class="flex items-start gap-2 text-sm mb-1"><input type="checkbox" id="sec-set-mfa" class="mt-1" ${s.mfa_required ? 'checked' : ''} ${!s.my_mfa_enabled && !s.mfa_required ? 'disabled' : ''}>
        <span>${who}に二段階認証を必須にする</span></label>
      <p class="text-[11px] ${MUTED} mb-3 pl-6">${s.my_mfa_enabled ? '必須にすると、未登録の人は次の操作のときに登録の画面へ移ります（登録するまでほかの画面は使えません）。' : '必須にするには、先にご自身の二段階認証を登録してください。'}${IS_HQ ? '' : 'スタッフは対象外です。'}</p>
      <label class="text-sm block mb-1">ログインできる接続元（IP アドレス。1行に1つ。空欄なら制限しません）</label>
      <textarea id="sec-set-ip" rows="4" ${INP} placeholder="203.0.113.5&#10;198.51.100.0/24">${esc((s.ip_allowlist || []).join('\n'))}</textarea>
      <p class="text-[11px] ${MUTED} mt-1 mb-3">今の接続元: <span class="font-mono">${esc(s.current_ip || '不明')}</span>。事務所の固定 IP などを入れると、${who}はそれ以外の場所からログインできなくなります${IS_HQ ? '' : '（スタッフは対象外）'}。今の接続元を含まない一覧は保存できません。${IS_HQ ? '' : '誤って誰も入れなくなったときは、本部に解除を依頼してください。'}</p>
      <button class="btn btn-primary text-sm" data-action="secSaveSettings">保存する</button>`
  }
  delegate('secSaveSettings', (el) => withSubmitLock(el, async () => {
    const mfa = document.getElementById('sec-set-mfa')
    const body = { ip_allowlist: document.getElementById('sec-set-ip').value }
    if (!mfa.disabled) body.mfa_required = mfa.checked
    try {
      await axios.put(IS_HQ ? '/api/hq/security/settings' : '/api/admin/security/settings', body)
      toast('保存しました'); reloadSecurity()
    } catch (e) { failText(e, '保存に失敗しました') }
  }))

  // ============ 管理者アカウント（本部ユーザー）の二段階認証とログイン ============
  function usersHtml(users, meId) {
    return `<h3 class="${H3}"><i class="fas fa-user-shield ${ICON} mr-1"></i>${IS_HQ ? '本部ユーザー' : '管理者アカウント'}の二段階認証とログイン</h3>
      <div class="overflow-x-auto"><table class="w-full text-sm">
        <thead><tr class="${MUTED} text-xs border-b ${BORDER}"><th class="text-left py-2">ID</th><th class="text-left py-2">氏名</th>${IS_HQ ? '' : '<th class="text-left py-2">権限</th>'}<th class="text-left py-2">二段階認証</th><th class="text-left py-2">ログイン中</th><th class="text-left py-2">最終ログイン</th><th></th></tr></thead>
        <tbody>${users.map(u => `
          <tr class="border-b ${BORDER}">
            <td class="py-2 text-xs">${esc(u.user_code)}</td>
            <td class="py-2">${esc(u.name)}${u.user_id === meId ? ' <span class="badge badge-blue">自分</span>' : ''}${u.status !== 'active' ? ' <span class="badge badge-gray">停止</span>' : ''}</td>
            ${IS_HQ ? '' : `<td class="py-2 text-xs">${esc(ROLE_LABEL[u.role] || u.role)}</td>`}
            <td class="py-2">${u.totp_enabled_at ? '<span class="badge badge-green">登録済み</span>' : '<span class="badge badge-gray">未登録</span>'}</td>
            <td class="py-2 text-xs">${Number(u.session_count) || 0}台</td>
            <td class="py-2 text-xs">${jstTime(u.last_login_at)}</td>
            <td class="py-2 text-right whitespace-nowrap">${u.user_id === meId ? '' : `
              ${!IS_HQ && u.totp_enabled_at ? `<button class="btn btn-outline text-xs" data-action="secResetUserMfa" data-id="${u.user_id}" data-name="${esc(u.name)}">二段階認証を解除</button>` : ''}
              ${Number(u.session_count) ? `<button class="btn btn-outline text-xs" data-action="secRevokeUser" data-id="${u.user_id}" data-name="${esc(u.name)}">ログインを終了</button>` : ''}`}</td>
          </tr>`).join('')}</tbody></table></div>
      <p class="text-[11px] ${MUTED} mt-2">${IS_HQ ? '本部ユーザーの二段階認証の解除は、下の「二段階認証の解除」から会社コードを空欄にして行います。' : '二段階認証の解除は、スマホを失くした・替えたときに使います。解除するとログイン中の画面も終了し、次のログインはパスワードだけになります（必須の設定なら登録し直しになります）。'}</p>`
  }
  delegate('secResetUserMfa', (el) => {
    if (!confirm(`${el.dataset.name} さんの二段階認証を解除します。ログイン中の画面も終了します。本人からの依頼を確かめましたか？`)) return
    withSubmitLock(el, async () => {
      try { await axios.delete(`/api/admin/security/users/${Number(el.dataset.id)}/mfa`); toast('二段階認証を解除しました'); reloadSecurity() }
      catch (e) { failText(e, '解除できませんでした') }
    })
  })
  delegate('secRevokeUser', (el) => {
    if (!confirm(`${el.dataset.name} さんのログインをすべての端末で終了します。よろしいですか？`)) return
    withSubmitLock(el, async () => {
      try {
        const { data } = await axios.delete(`${IS_HQ ? '/api/hq/security/users/' : '/api/admin/security/users/'}${Number(el.dataset.id)}/sessions`)
        toast(`${data.revoked}件のログインを終了しました`); reloadSecurity()
      } catch (e) { failText(e, '終了できませんでした') }
    })
  })

  // ============ スタッフのログイン（管理画面。スマホの紛失・共用端末のログアウト忘れ） ============
  function staffFrameHtml() {
    return `<h3 class="${H3}"><i class="fas fa-mobile-screen ${ICON} mr-1"></i>スタッフのログイン中の端末</h3>
      <p class="text-[11px] ${MUTED} mb-2">スマホを失くした・共用の端末でログアウトを忘れた、という連絡があったときに、そのスタッフのログインをすべての端末で終了できます（本人は新しい端末でログインし直します）。空欄で探すと、今ログイン中のスタッフを最近ログインした順に出します。</p>
      <div class="flex gap-2 mb-3"><input id="sec-staff-q" class="inp" placeholder="氏名・スタッフ番号" maxlength="50"><button class="btn btn-outline text-sm whitespace-nowrap" data-action="secStaffSearch"><i class="fas fa-magnifying-glass"></i>探す</button></div>
      <div id="sec-staff-list"><div class="flex justify-center py-4"><span class="spin"></span></div></div>`
  }
  async function loadStaffList() {
    const box = document.getElementById('sec-staff-list'); if (!box) return
    const q = ((document.getElementById('sec-staff-q') || {}).value || '').trim()
    let d
    try { d = (await axios.get('/api/admin/security/staff', { params: q ? { q } : {} })).data }
    catch (e) { sectionError(box, 'スタッフを読み込めませんでした', 'secStaffSearch'); return }
    if (!d.staff.length) { box.innerHTML = `<p class="text-sm ${MUTED}">${q ? '該当するスタッフはいません。' : 'ログイン中のスタッフはいません。'}</p>`; return }
    box.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-gray-400 text-xs border-b border-gray-100"><th class="text-left py-2">スタッフ番号</th><th class="text-left py-2">氏名</th><th class="text-left py-2">ログイン中</th><th class="text-left py-2">最終ログイン</th><th></th></tr></thead>
      <tbody>${d.staff.map(s => `
        <tr class="border-b border-gray-50">
          <td class="py-2 text-xs text-gray-500">${esc(s.user_code || '-')}</td>
          <td class="py-2">${esc(s.name)}${s.status !== 'active' ? ' <span class="badge badge-gray">利用停止</span>' : ''}</td>
          <td class="py-2 text-xs">${Number(s.session_count) || 0}台</td>
          <td class="py-2 text-xs text-gray-400">${jstTime(s.last_login_at)}</td>
          <td class="py-2 text-right"><button class="btn btn-outline text-xs" data-action="secStaffOpen" data-id="${s.staff_id}">端末を見る</button></td>
        </tr>`).join('')}</tbody></table></div>`
  }
  delegate('secStaffSearch', () => loadStaffList())
  delegate('secStaffOpen', (el) => withSubmitLock(el, async () => {
    const id = Number(el.dataset.id)
    let d
    try { d = (await axios.get(`/api/admin/staff/${id}/sessions`)).data } catch (e) { failText(e, '読み込めませんでした'); return }
    modal(`
      <h3 class="font-bold text-lg mb-1">${esc(d.staff.name)} さんのログイン</h3>
      <p class="text-xs text-gray-500 mb-3">スタッフ番号 ${esc(d.staff.user_code || '-')}</p>
      <h4 class="text-sm font-bold text-gray-700 mb-1">ログイン中の端末（${d.sessions.length}台）</h4>
      ${sessionRowsHtml(d.sessions, { showOther: true })}
      ${d.sessions.some(s => s.other_company) ? '<p class="text-[11px] text-gray-400 mt-1">「他社の画面」は、同じ人が連携先の会社に切り替えて使っている端末です。終了するとこちらも終了します。</p>' : ''}
      ${d.history.length ? `<h4 class="text-sm font-bold text-gray-700 mt-4 mb-1">直近のログインの履歴</h4>
        <ul class="text-xs space-y-1 max-h-48 overflow-y-auto">${d.history.map(e => `<li>${utcTime(e.created_at)} ${resultBadge(e.result)} ${esc(EVENT_LABEL[e.event_type] || e.event_type)} <span class="text-gray-400">${esc(e.ip || '')} ${esc(e.device)}</span></li>`).join('')}</ul>` : ''}
      <div class="flex flex-wrap gap-2 justify-end mt-4">
        <button class="btn btn-outline" onclick="closeModal()">閉じる</button>
        ${d.sessions.length ? `<button class="btn btn-danger" data-action="secStaffRevoke" data-id="${id}" data-name="${esc(d.staff.name)}"><i class="fas fa-power-off"></i>ログインを終了させる</button>` : ''}
      </div>`)
  }))
  delegate('secStaffRevoke', (el) => {
    if (!confirm(`${el.dataset.name} さんのログインを、すべての端末で終了します。本人は新しい端末でログインし直す必要があります。よろしいですか？`)) return
    withSubmitLock(el, async () => {
      try {
        const { data } = await axios.delete(`/api/admin/staff/${Number(el.dataset.id)}/sessions`)
        closeModal(); toast(`${data.revoked}件のログインを終了しました`); loadStaffList()
      } catch (e) { failText(e, '終了できませんでした') }
    })
  })

  // ============ 本部: 二段階認証・接続元の制限の解除（問い合わせ窓口） ============
  function hqSupportHtml() {
    return `<h3 class="${H3}"><i class="fas fa-life-ring ${ICON} mr-1"></i>解除の窓口</h3>
      <div class="space-y-4 text-sm">
        <div>
          <p class="font-bold mb-1">二段階認証の解除</p>
          <p class="text-[11px] ${MUTED} mb-2">スマホを失くした会社管理者など、社内で解除できる人がいないときに使います。本人確認をしてから行ってください。会社コードを空欄にすると本部ユーザーが対象です。</p>
          <div class="grid grid-cols-2 gap-2 mb-2"><input id="sec-rm-company" ${INP} placeholder="会社コード"><input id="sec-rm-user" ${INP} placeholder="ID"></div>
          <button class="btn btn-outline text-sm" data-action="secHqResetMfa">二段階認証を解除する</button>
        </div>
        <div>
          <p class="font-bold mb-1">接続元の制限の解除</p>
          <p class="text-[11px] ${MUTED} mb-2">企業が接続元の設定を誤って、管理者が誰もログインできなくなったときに使います。</p>
          <div class="flex gap-2"><input id="sec-ci-company" ${INP} placeholder="会社コード"><button class="btn btn-outline text-sm whitespace-nowrap" data-action="secHqClearIp">制限を外す</button></div>
        </div>
      </div>`
  }
  delegate('secHqResetMfa', (el) => {
    const company_code = document.getElementById('sec-rm-company').value.trim(), user_code = document.getElementById('sec-rm-user').value.trim()
    if (!user_code) { toast('ID を入力してください'); return }
    if (!confirm(`${company_code ? '会社コード ' + company_code : '本部ユーザー'} / ID ${user_code} の二段階認証を解除し、ログイン中の画面を終了します。本人確認は済みましたか？`)) return
    withSubmitLock(el, async () => {
      try {
        const { data } = await axios.post('/api/hq/security/reset-mfa', { company_code, user_code })
        toast(`${data.company_name} ${data.name} さんの二段階認証を解除しました${data.was_enabled ? '' : '（もともと未登録でした）'}`); reloadSecurity()
      } catch (e) { failText(e, '解除できませんでした') }
    })
  })
  delegate('secHqClearIp', (el) => {
    const company_code = document.getElementById('sec-ci-company').value.trim()
    if (!company_code) { toast('会社コードを入力してください'); return }
    if (!confirm(`会社コード ${company_code} の接続元の制限を外します。よろしいですか？`)) return
    withSubmitLock(el, async () => {
      try { const { data } = await axios.post('/api/hq/security/clear-ip', { company_code }); toast(`${data.company_name} の接続元の制限を外しました`) }
      catch (e) { failText(e, '外せませんでした') }
    })
  })

  // ============ 画面 ============
  function reloadSecurity() { (IS_HQ ? window.renderHqSecurity : window.renderSecurity)() }
  async function loadSection(id, url, render, errMsg) {
    const el = document.getElementById(id); if (!el) return
    try { el.innerHTML = render((await axios.get(url)).data) } catch (e) { sectionError(el, errMsg, IS_HQ ? 'secReloadHq' : 'secReload') }
  }
  delegate('secReload', () => window.renderSecurity())
  delegate('secReloadHq', () => window.renderHqSecurity())
  async function loadMine() {
    const [mfa, sess] = await Promise.all([axios.get('/api/auth/mfa'), axios.get('/api/auth/sessions')])
    return { mfa: mfa.data, sessions: sess.data.sessions }
  }
  const loadingHtml = '<div class="flex justify-center py-20"><span class="spin"></span></div>'

  // 管理画面: 自分の二段階認証・端末は全員、スタッフのログインは管理系のロール全員、会社の設定以下は会社管理者だけ
  window.renderSecurity = async function () {
    const $app = app(); $app.innerHTML = loadingHtml
    let mine
    try { mine = await loadMine() } catch (e) { $app.innerHTML = `<p class="text-center text-gray-400 py-10">読み込めませんでした <button class="btn btn-outline text-xs ml-2" data-action="secReload">再読み込み</button></p>`; return }
    const isCA = typeof ME !== 'undefined' && ME && ME.role === 'company_admin'
    const pending = mine.mfa.setup_required
    $app.innerHTML = `
      <h2 class="text-xl font-bold text-gray-900 mb-4">セキュリティ</h2>
      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <section class="${CARD}" id="sec-mfa">${mfaCardHtml(mine.mfa)}</section>
        <section class="${CARD}">${mySessionsHtml(mine.sessions)}</section>
      </div>
      ${pending ? '' : `
        <section class="${CARD} mb-4">${staffFrameHtml()}</section>
        ${isCA ? `
          <div class="grid lg:grid-cols-2 gap-4 mb-4">
            <section class="${CARD}" id="sec-settings">${loadingHtml}</section>
            <section class="${CARD}" id="sec-users">${loadingHtml}</section>
          </div>
          <section class="${CARD} mb-4">${historyFrameHtml(null)}</section>` : `<p class="text-xs text-gray-400">会社の設定（二段階認証の必須・接続元の制限）とログインの履歴は、会社管理者が見られます。</p>`}`}`
    if (pending) return
    const q = document.getElementById('sec-staff-q')
    if (q) q.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); loadStaffList() } })
    loadStaffList()
    if (!isCA) return
    loadSection('sec-settings', '/api/admin/security/settings', settingsHtml, '会社の設定を読み込めませんでした')
    loadSection('sec-users', '/api/admin/security/users', d => usersHtml(d.users, d.me), '管理者アカウントを読み込めませんでした')
    restoreHistoryFilter(); loadHistory()
  }

  // 本部画面
  window.renderHqSecurity = async function () {
    const $app = app(); $app.innerHTML = loadingHtml
    let mine
    try { mine = await loadMine() } catch (e) { $app.innerHTML = `<p class="text-center text-slate-400 py-10">読み込めませんでした <button class="btn btn-outline text-xs ml-2" data-action="secReloadHq">再読み込み</button></p>`; return }
    const pending = mine.mfa.setup_required
    let companies = []
    if (!pending) { try { companies = (await axios.get('/api/hq/companies')).data.companies || [] } catch (e) { companies = [] } }
    $app.innerHTML = `
      <h2 class="text-xl font-bold mb-5">セキュリティ</h2>
      <div class="grid lg:grid-cols-2 gap-4 mb-4">
        <section class="${CARD}" id="sec-mfa">${mfaCardHtml(mine.mfa)}</section>
        <section class="${CARD}">${mySessionsHtml(mine.sessions)}</section>
      </div>
      ${pending ? '' : `
        <div class="grid lg:grid-cols-2 gap-4 mb-4">
          <section class="${CARD}" id="sec-settings">${loadingHtml}</section>
          <section class="${CARD}">${hqSupportHtml()}</section>
        </div>
        <section class="${CARD} mb-4" id="sec-users">${loadingHtml}</section>
        <section class="${CARD} mb-4">${historyFrameHtml(companies)}</section>`}`
    if (pending) return
    loadSection('sec-settings', '/api/hq/security', settingsHtml, '設定を読み込めませんでした')
    loadSection('sec-users', '/api/hq/security', d => usersHtml(d.users, d.me), '本部ユーザーを読み込めませんでした')
    restoreHistoryFilter(); loadHistory()
  }
})()
