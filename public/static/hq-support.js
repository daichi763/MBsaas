// 管理画面の本部との連携（作業単位 w5-hq-support）
//  #179 「伴走支援を依頼する」のフォーム（依頼は本部の受付一覧に入り、本部にメールで知らせる）
//  #516 本部からのお知らせを画面の上部に出し、「確認しました」で既読にする
//  #293 本部の閲覧（読み取り専用）: 閲覧中の本部には帯と「閲覧を終了」を、企業には「本部が閲覧中」を出す。閲覧の許可は会社管理者が切り替える
// admin.js より先に読み込む（閲覧中は、admin.js の最初の /api/auth/me にも X-HQ-View を付けるため）。modal・toast は admin.js のものを使う
;(function () {
  const VIEW = window.HQ_VIEW || null
  const $bar = document.getElementById('hq-support-bar')
  const fmt = (v, utc) => v ? dayjs(String(v).replace(' ', 'T') + (utc && !/Z$/.test(String(v)) ? 'Z' : '')).format('M/D HH:mm') : ''
  const ANN_STYLE = {
    maintenance: { cls: 'border-amber-300 bg-amber-50', badge: '<span class="badge badge-yellow">メンテナンス</span>' },
    important: { cls: 'border-red-200 bg-red-50', badge: '<span class="badge badge-red">重要</span>' },
    normal: { cls: 'border-blue-200 bg-blue-50', badge: '<span class="badge badge-blue">お知らせ</span>' },
  }
  const SUPPORT_STATUS = { open: '<span class="badge badge-red">受付</span>', in_progress: '<span class="badge badge-yellow">対応中</span>', done: '<span class="badge badge-green">完了</span>' }
  const END_REASON = { hq: '本部が終了', replaced: '本部が終了', revoked: '許可の取り消し', logout: '本部がログアウト' }

  if (VIEW) axios.interceptors.request.use(cfg => { cfg.headers['X-HQ-View'] = '1'; return cfg })

  function showBar(html) {
    if (!$bar) return
    $bar.innerHTML = html
    $bar.classList.toggle('hidden', !html)
  }

  // ---------- 本部の閲覧中（本部ユーザーが開いている） ----------
  function renderViewBar() {
    const expired = Date.parse(VIEW.expires_at) <= Date.now()
    showBar(`<div class="rounded-xl border border-cyan-300 bg-cyan-50 text-cyan-900 px-4 py-3 text-sm flex flex-wrap items-center gap-3">
      <span class="flex-1 min-w-0"><i class="fas fa-eye mr-1"></i>本部として「${esc(VIEW.company_name)}」の管理画面を閲覧しています（読み取り専用。登録・変更はできません）。
        ${expired ? '<b>閲覧の期限が切れました。</b>本部画面から開き直してください。' : `期限: ${esc(fmt(VIEW.expires_at))}`}</span>
      <button type="button" class="btn btn-outline text-xs" data-action="hqsEndView"><i class="fas fa-right-from-bracket"></i>閲覧を終了</button>
    </div>`)
  }
  delegate('hqsEndView', (el) => withSubmitLock(el, async () => {
    try { await axios.delete('/api/hq/view-sessions/current') } catch (e) { }
    location.href = '/hq#support'
  }))

  // ---------- 企業の管理者: 本部からのお知らせ・本部が閲覧中の表示 ----------
  async function loadStatus() {
    let s
    try { s = (await axios.get('/api/admin/hq-support/status', { background: true })).data } catch (e) { return }
    const parts = []
    for (const v of s.active_views || []) {
      parts.push(`<div class="rounded-xl border border-cyan-200 bg-cyan-50 text-cyan-900 px-4 py-2 text-sm"><i class="fas fa-eye mr-1"></i>本部（${esc(v.hq_name || '担当者')}）が、${esc(fmt(v.expires_at))} までこの管理画面を閲覧しています（読み取り専用）。
        <button type="button" class="underline ml-1" data-action="hqsOpenSupport" data-section="access">閲覧の記録・許可</button></div>`)
    }
    for (const a of s.announcements || []) {
      const st = ANN_STYLE[a.importance] || ANN_STYLE.normal
      parts.push(`<div class="rounded-xl border ${st.cls} px-4 py-3 text-sm">
        <div class="flex flex-wrap items-center gap-2 mb-1">${st.badge}<span class="font-bold text-gray-800">${esc(a.title)}</span>
          <span class="text-xs text-gray-400">本部より ${esc(fmt(a.starts_at))}${a.ends_at ? ` 〜 ${esc(fmt(a.ends_at))}` : ''}</span></div>
        <p class="text-gray-700 whitespace-pre-wrap">${esc(a.body)}</p>
        ${VIEW ? '' : `<div class="mt-2"><button type="button" class="btn btn-outline text-xs" data-action="hqsReadAnn" data-id="${Number(a.announcement_id)}"><i class="fas fa-check"></i>確認しました</button></div>`}
      </div>`)
    }
    showBar(parts.join(''))
  }
  delegate('hqsReadAnn', (el) => withSubmitLock(el, async () => {
    try {
      await axios.post(`/api/admin/hq-announcements/${Number(el.dataset.id)}/read`)
      const box = el.closest('.rounded-xl'); if (box) box.remove()
      if ($bar && !$bar.children.length) $bar.classList.add('hidden')
    } catch (e) { showApiError(e, '既読にできませんでした') }
  }))

  // ---------- 伴走支援の依頼・閲覧の許可（モーダル） ----------
  delegate('hqsOpenSupport', async (el) => {
    if (VIEW) { toast('本部の閲覧中は依頼できません'); return }
    let reqs, access
    try {
      [reqs, access] = await Promise.all([axios.get('/api/admin/support-requests'), axios.get('/api/admin/hq-access')]).then(rs => rs.map(r => r.data))
    } catch (e) { showApiError(e, '読み込めませんでした'); return }
    const menus = reqs.menus || {}
    modal(`
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-hands-holding-circle text-blue-600 mr-1"></i>伴走支援を依頼する</h3>
      <p class="text-xs text-gray-500 mb-3">依頼は会社名・依頼者の名前を付けて本部に届きます。本部の担当者から、入力された連絡先へご連絡します。</p>
      <div class="space-y-3">
        <div><label class="text-sm text-gray-600 block mb-1">メニュー *</label>
          <select id="hqs-menu" class="inp"><option value="">選んでください</option>${Object.entries(menus).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1">内容 *（困っていること・お願いしたいこと）</label>
          <textarea id="hqs-detail" rows="4" maxlength="2000" class="inp" placeholder="例: 新しい案件の日報項目を一緒に決めたい"></textarea></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-sm text-gray-600 block mb-1">希望の日時</label><input id="hqs-preferred" class="inp" maxlength="100" placeholder="例: 来週の平日午後"></div>
          <div><label class="text-sm text-gray-600 block mb-1">連絡先（電話・メール）</label><input id="hqs-contact" class="inp" maxlength="200"></div>
        </div>
        <button type="button" class="btn btn-primary w-full" data-action="hqsSendSupport">本部に依頼する</button>
      </div>
      ${(reqs.requests || []).length ? `
      <h4 class="font-bold text-sm mt-5 mb-2">これまでの依頼</h4>
      <div class="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100 text-xs">
        ${reqs.requests.map(r => `<div class="px-3 py-2"><div class="flex items-center gap-2">${SUPPORT_STATUS[r.status] || ''}<span class="font-medium">${esc(menus[r.menu] || r.menu)}</span><span class="text-gray-400 ml-auto">${esc(fmt(r.created_at, true))}・${esc(r.requester_name || '')}</span></div>
          <p class="text-gray-600 mt-1 whitespace-pre-wrap line-clamp-2">${esc(r.detail)}</p></div>`).join('')}
      </div>` : ''}
      <div id="hqs-access" class="mt-5 pt-4 border-t border-gray-100">${accessHtml(access)}</div>`)
    if (el.dataset.section === 'access') { const a = document.getElementById('hqs-access'); if (a) a.scrollIntoView() }
  })
  function accessHtml(a) {
    return `<h4 class="font-bold text-sm mb-1"><i class="fas fa-eye text-gray-400 mr-1"></i>本部による管理画面の閲覧</h4>
      <p class="text-xs text-gray-500 mb-2">許可すると、問い合わせや設定の支援のために、本部の担当者が期限付き（最長60分）・読み取り専用でこの管理画面を確認できます。従業員管理（給与・口座・保険番号）とセキュリティの画面は見られません。閲覧の開始・終了と開いた画面は記録され、下の一覧で確認できます。</p>
      <div class="flex items-center gap-3 mb-2">
        <span class="text-sm">現在: ${a.allowed ? '<span class="badge badge-green">許可している</span>' : '<span class="badge badge-gray">許可していない</span>'}</span>
        ${a.can_manage ? `<button type="button" class="btn ${a.allowed ? 'btn-outline' : 'btn-primary'} text-xs ml-auto" data-action="hqsToggleAccess" data-allowed="${a.allowed ? '0' : '1'}">${a.allowed ? '許可を取り消す' : '閲覧を許可する'}</button>` : '<span class="text-xs text-gray-400 ml-auto">変更は会社管理者が行えます</span>'}
      </div>
      ${(a.sessions || []).length ? `<div class="max-h-40 overflow-y-auto text-xs border border-gray-100 rounded-lg divide-y divide-gray-100">
        ${a.sessions.map(v => {
          const active = !v.ended_at && Date.parse(v.expires_at) > Date.parse(a.now)
          return `<div class="px-3 py-2"><div class="flex items-center gap-2">${active ? '<span class="badge badge-blue">閲覧中</span>' : ''}<span class="font-medium">${esc(v.hq_name || '本部')}</span>
            <span class="text-gray-400 ml-auto">${esc(fmt(v.started_at))} 〜 ${esc(fmt(v.ended_at || v.expires_at))}${v.ended_at && END_REASON[v.end_reason] ? `（${esc(END_REASON[v.end_reason])}）` : ''}・${Number(v.pages) || 0}画面</span></div>
            <p class="text-gray-500 mt-0.5">目的: ${esc(v.reason)}</p></div>`
        }).join('')}</div>` : '<p class="text-xs text-gray-400">閲覧の記録はありません</p>'}`
  }
  delegate('hqsToggleAccess', (el) => withSubmitLock(el, async () => {
    const allowed = el.dataset.allowed === '1'
    if (!allowed && !confirm('本部の閲覧の許可を取り消しますか？閲覧中のものもすぐに終わります')) return
    try {
      await axios.put('/api/admin/hq-access', { allowed })
      const a = (await axios.get('/api/admin/hq-access')).data
      const box = document.getElementById('hqs-access'); if (box) box.innerHTML = accessHtml(a)
      toast(allowed ? '本部の閲覧を許可しました' : '本部の閲覧の許可を取り消しました')
      loadStatus()
    } catch (e) { showApiError(e, '変更できませんでした') }
  }))
  delegate('hqsSendSupport', (el) => withSubmitLock(el, async () => {
    const body = {
      menu: document.getElementById('hqs-menu').value,
      detail: document.getElementById('hqs-detail').value.trim(),
      preferred_at: document.getElementById('hqs-preferred').value.trim(),
      contact: document.getElementById('hqs-contact').value.trim(),
    }
    if (!body.menu) { toast('メニューを選んでください'); return }
    if (!body.detail) { toast('内容を入力してください'); return }
    try {
      await axios.post('/api/admin/support-requests', body)
      closeModal()
      toast('本部に依頼しました。担当者からご連絡します')
    } catch (e) { showApiError(e, '依頼を送れませんでした') }
  }))

  if (VIEW) {
    renderViewBar()
    // 期限を過ぎたら表示を切り替える（API は期限の後は 403 になる）
    setInterval(renderViewBar, 60 * 1000)
    document.querySelectorAll('[data-action="hqsOpenSupport"]').forEach(b => b.classList.add('hidden'))
  } else {
    // admin.js の API の共通処理（定期の取得の印など）が登録されてから取る
    document.addEventListener('DOMContentLoaded', loadStatus)
  }
})()
