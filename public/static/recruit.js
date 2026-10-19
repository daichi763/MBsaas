// =========================================================
// 募集ページ・応募の承認（管理画面 #recruit）
// docs/spec_spot_shift.md 第4段階。admin.js の後に読み込む
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const fmt = (d) => { const x = dayjs(d); return `${x.format('M/D')}(${WD[x.day()]})` }
  const TYPE_LABEL = { daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属', own_employee: '自社雇用' }
  // released: 承認後にシフトが削除・欠勤・差し替え・移動になった / slot_removed: 応募の後に枠・役割が削除された /
  // expired: 未対応のまま勤務日を過ぎた（src/recruit.ts）
  const ITEM_LABEL = { pending: '未対応', processing: '処理中', approved: '承認', rejected: '見送り', cancelled: '取り下げ', released: 'シフト解除', slot_removed: '枠の削除', expired: '期限切れ' }
  const ITEM_BADGE = { pending: 'badge-yellow', processing: 'badge-yellow', approved: 'badge-green', rejected: 'badge-gray', cancelled: 'badge-gray', released: 'badge-red', slot_removed: 'badge-gray', expired: 'badge-gray' }
  const TURNSTILE_NOTE = {
    off: 'ボット対策（Cloudflare Turnstile）は未設定です。送信回数の制限と入力チェックで保護しています。設定する場合は TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY の両方を登録してください',
    site_key_only: 'ボット対策（Cloudflare Turnstile）はサイトキー（TURNSTILE_SITE_KEY）だけが登録されているため、使われていません。秘密鍵（TURNSTILE_SECRET_KEY）も登録してください',
    secret_key_only: 'ボット対策（Cloudflare Turnstile）は秘密鍵（TURNSTILE_SECRET_KEY）だけが登録されているため、使われていません。サイトキー（TURNSTILE_SITE_KEY）も登録してください',
  }
  const S = window.__recruitState = window.__recruitState || { tab: 'applications', status: 'pending' }
  let projects = null
  const pageUrl = (t) => location.origin + '/apply/' + t
  const MAX_PAGE_PROJECTS = 50 // src/recruit.ts と同じ上限

  // サイドメニューの未対応件数
  window.refreshRecruitBadge = async function () {
    try {
      const { data } = await axios.get('/api/admin/recruit-applications/summary')
      const el = document.getElementById('recruit-badge'); if (!el) return
      el.textContent = data.pending; el.classList.toggle('hidden', !data.pending)
    } catch (e) { }
  }
  setTimeout(() => window.refreshRecruitBadge(), 800)

  window.renderRecruit = async function () {
    // シフトボードの「応募n」（#recruit/slot-枠ID）から開いたときは、その枠の未対応の応募に絞り込む（#303）。
    // 絞り込みは状態に移し、URL は #recruit に戻す（読み直しで絞り込みが戻らないように）
    const m = (location.hash || '').match(/^#recruit\/slot-(\d+)$/)
    if (m) {
      Object.assign(S, { tab: 'applications', status: 'pending', slot_role_id: Number(m[1]), page_id: null, q: '', from: '', to: '' })
      history.replaceState(null, '', '#recruit')
    }
    loading()
    if (!projects) projects = (await axios.get('/api/admin/projects')).data.projects || []
    $app.innerHTML = `
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 class="text-xl font-bold text-gray-900"><i class="fas fa-bullhorn text-blue-600 mr-1"></i>募集・応募</h2>
        <button class="btn btn-primary text-sm" onclick="openRecruitPage()"><i class="fas fa-plus"></i>募集ページを作成</button>
      </div>
      <p class="text-xs text-gray-500 mb-3">シフトボードの「募集枠」を公開のURL・QRで募集します。応募はすべて承認で確定し、登録のない人は承認時に仮登録を作成します</p>
      <div class="flex gap-1 mb-3" id="recruit-tabs">
        <button class="btn ${S.tab === 'applications' ? 'btn-primary' : 'btn-outline'} text-xs" onclick="window.__recruitState.tab='applications';renderRecruit()">応募</button>
        <button class="btn ${S.tab === 'pages' ? 'btn-primary' : 'btn-outline'} text-xs" onclick="window.__recruitState.tab='pages';renderRecruit()">募集ページ</button>
      </div>
      <section id="recruit-body"><div class="flex justify-center py-10"><span class="spin"></span></div></section>`
    S.tab === 'pages' ? renderPages() : renderApplications()
    window.refreshRecruitBadge()
  }

  // ---------- 募集ページ ----------
  async function renderPages() {
    const host = document.getElementById('recruit-body')
    let data; try { data = (await axios.get('/api/admin/recruit-pages')).data } catch (e) { host.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    window.__recruitPages = data.pages
    host.innerHTML = `
      ${TURNSTILE_NOTE[data.turnstile] ? `<p class="text-[11px] ${data.turnstile === 'off' ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50 font-bold'} rounded p-2 mb-3" id="turnstile-note" data-state="${esc(data.turnstile)}"><i class="fas fa-shield-halved mr-1"></i>${TURNSTILE_NOTE[data.turnstile]}</p>` : ''}
      <div class="grid md:grid-cols-2 gap-3" id="recruit-page-list">
        ${data.pages.map(p => `<article class="card p-4">
          <div class="flex items-start justify-between gap-2 mb-1">
            <div class="min-w-0"><p class="font-bold text-gray-800 truncate">${esc(p.title)}</p>
              <p class="text-xs text-gray-500">${fmt(p.date_from)}〜${fmt(p.date_to)}・${p.project_names.map(esc).join('、')}</p></div>
            ${p.is_open ? '<span class="badge badge-green shrink-0">募集中</span>' : p.status === 'open' && p.expired ? '<span class="badge badge-gray shrink-0">期間終了</span>' : '<span class="badge badge-gray shrink-0">終了</span>'}
          </div>
          <p class="text-xs text-gray-600 mb-2">募集中の枠 ${p.open_roles}件（残り${p.open_remaining}名）・応募 ${p.application_count}件${p.pending_count ? `・<b class="text-red-600">未対応 ${p.pending_count}件</b>` : ''}</p>
          <div class="flex gap-1.5 flex-wrap">
            <button class="btn btn-outline text-xs" onclick="showRecruitShare(${p.page_id})"><i class="fas fa-qrcode"></i>URL・QR</button>
            <button class="btn btn-outline text-xs" onclick="openRecruitPage(${p.page_id})"><i class="fas fa-pen"></i>編集</button>
            ${p.pending_count ? `<button class="btn btn-outline text-xs" onclick="window.__recruitState.tab='applications';window.__recruitState.page_id=${p.page_id};renderRecruit()">応募を見る</button>` : ''}
            ${p.is_open ? `<button class="btn btn-outline text-xs" onclick="setRecruitStatus(${p.page_id},'closed')">募集を終了</button>`
              : p.expired ? `<button class="btn btn-outline text-xs" data-action="recruitReopen" data-id="${p.page_id}">期間を延長して再開</button>`
              : `<button class="btn btn-outline text-xs" onclick="setRecruitStatus(${p.page_id},'open')">再開</button>`}
          </div>
        </article>`).join('') || '<p class="card p-6 text-center text-sm text-gray-400 md:col-span-2">募集ページはありません。「募集ページを作成」から作成してください</p>'}
      </div>`
  }

  // reopen: 期間が切れたページを、期間を延ばして再開する（保存するときに status を open にする。#136）
  window.openRecruitPage = function (id, reopen) {
    const p = id ? (window.__recruitPages || []).find(x => x.page_id === id) : null
    const sel = new Set(p ? String(p.project_ids).split(',').map(Number) : [])
    const spot = projects.filter(x => x.status !== 'ended')
    modal(`
      <h3 class="font-bold text-lg mb-3">${p ? (reopen ? '期間を延長して再開' : '募集ページの編集') : '募集ページの作成'}</h3>
      ${reopen ? '<p class="text-xs text-amber-700 bg-amber-50 rounded p-2 mb-3">期間の終了日が過ぎています。「期間（終了）」を今日以降に延ばしてから保存してください</p>' : ''}
      <div class="space-y-3 text-sm" id="recruit-page-form">
        <label class="block text-gray-600">タイトル（応募者に表示）<span class="text-red-500">*</span><input id="rp-title" class="inp" maxlength="80" value="${esc(p?.title || '')}" placeholder="例: 週末のスマホ販売イベントスタッフ"></label>
        <div class="text-gray-600">対象の案件 <span class="text-red-500">*</span>
          <div class="max-h-36 overflow-y-auto border border-gray-200 rounded-lg p-2 mt-1 space-y-1">
            ${spot.map(x => `<label class="flex items-center gap-2 text-xs"><input type="checkbox" class="rp-proj" value="${x.project_id}" ${sel.has(x.project_id) ? 'checked' : ''}>${esc(x.project_name)}<span class="text-gray-400">${esc(x.client_name || '')}</span>${x.engagement_type === 'spot' ? '<span class="badge badge-purple">スポット</span>' : ''}</label>`).join('')}
          </div>
          <p class="text-[11px] text-gray-400 mt-1">案件名・クライアント名・金額は公開ページに表示しません。表示するのは、日時・開催場所・役割・残り人数です（対象の案件は${MAX_PAGE_PROJECTS}件まで）</p></div>
        <div class="grid grid-cols-2 gap-2">
          <label class="text-gray-600">期間（開始）<input id="rp-from" type="date" class="inp" value="${p?.date_from || dayjs().format('YYYY-MM-DD')}"></label>
          <label class="text-gray-600">期間（終了）<input id="rp-to" type="date" class="inp" value="${p?.date_to || dayjs().add(1, 'month').format('YYYY-MM-DD')}"></label>
        </div>
        <label class="block text-gray-600">仕事内容・条件<textarea id="rp-desc" class="inp" rows="4" maxlength="2000" placeholder="仕事内容、服装、持ち物、集合場所など">${esc(p?.description || '')}</textarea></label>
        <label class="block text-gray-600">給与の表示（任意）<input id="rp-pay" class="inp" maxlength="200" value="${esc(p?.pay_note || '')}" placeholder="例: 日給 12,000円〜・交通費支給"></label>
        <label class="block text-gray-600">問い合わせ先の表示（任意）<input id="rp-contact" class="inp" maxlength="200" value="${esc(p?.contact_note || '')}" placeholder="例: 採用担当 03-0000-0000（平日10〜18時）"></label>
        <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="rp-remaining" ${p ? (p.show_remaining ? 'checked' : '') : 'checked'}>残り人数を表示する</label>
        <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="rp-staff" ${p ? (p.allow_staff ? 'checked' : '') : 'checked'}>登録済みのスタッフがアプリから応募できるようにする</label>
        ${p ? '<label class="flex items-center gap-2 text-xs text-red-600"><input type="checkbox" id="rp-regen">URLを再発行する（今のURL・QRは使えなくなります）</label>' : ''}
      </div>
      <div class="flex gap-2 mt-4">
        <button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        ${p && !p.application_count ? `<button class="btn btn-danger" onclick="deleteRecruitPage(${p.page_id})"><i class="fas fa-trash"></i></button>` : ''}
        <button class="btn btn-primary flex-1" data-action="recruitSavePage" data-id="${p ? p.page_id : ''}" data-reopen="${reopen ? '1' : ''}">${p ? (reopen ? '保存して再開' : '保存') : '作成してURLを発行'}</button>
      </div>`)
  }
  delegate('recruitReopen', (el) => openRecruitPage(Number(el.dataset.id), true))
  delegate('recruitSavePage', (el) => withSubmitLock(el, () => saveRecruitPage(Number(el.dataset.id) || null, el.dataset.reopen === '1')))
  async function saveRecruitPage(id, reopen) {
    const v = (k) => document.getElementById(k).value
    const body = {
      title: v('rp-title'), project_ids: [...document.querySelectorAll('.rp-proj:checked')].map(x => Number(x.value)),
      date_from: v('rp-from'), date_to: v('rp-to'), description: v('rp-desc'), pay_note: v('rp-pay'), contact_note: v('rp-contact'),
      show_remaining: document.getElementById('rp-remaining').checked, allow_staff: document.getElementById('rp-staff').checked,
      ...(id && document.getElementById('rp-regen')?.checked ? { regenerate_token: true } : {}),
      ...(id && reopen ? { status: 'open' } : {}),
    }
    if (body.project_ids.length > MAX_PAGE_PROJECTS) return toast(`対象の案件は${MAX_PAGE_PROJECTS}件までです（${body.project_ids.length}件選択中）`)
    try {
      const { data } = id ? await axios.put('/api/admin/recruit-pages/' + id, body) : await axios.post('/api/admin/recruit-pages', body)
      closeModal(); toast(id ? (reopen ? '募集を再開しました' : '保存しました') : '募集ページを作成しました')
      S.tab = 'pages'; await renderRecruit()
      showRecruitShare(id || data.page_id)
    } catch (e) { toast(errMsg(e)) }
  }
  window.setRecruitStatus = async function (id, status) {
    if (status === 'closed' && !confirm('募集を終了します。公開ページでは応募できなくなります（未対応の応募はそのまま残ります）')) return
    try { await axios.put('/api/admin/recruit-pages/' + id, { status }); toast(status === 'closed' ? '募集を終了しました' : '募集を再開しました'); renderRecruit() } catch (e) {
      toast(errMsg(e))
      // 期間が切れていて再開できないときは、期間を延ばす画面を開く
      if (e.response && e.response.data && e.response.data.need_extend) openRecruitPage(id, true)
    }
  }
  window.deleteRecruitPage = async function (id) {
    if (!confirm('この募集ページを削除しますか？')) return
    try { await axios.delete('/api/admin/recruit-pages/' + id); closeModal(); toast('削除しました'); renderRecruit() } catch (e) { toast(errMsg(e)) }
  }
  window.showRecruitShare = function (id) {
    const p = (window.__recruitPages || []).find(x => x.page_id === id); if (!p) return
    const url = pageUrl(p.token)
    let qr = ''
    try { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); qr = q.createDataURL(6, 12) } catch (e) { }
    modal(`
      <h3 class="font-bold text-lg mb-1">URL・QR</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(p.title)}（${fmt(p.date_from)}〜${fmt(p.date_to)}）</p>
      <div class="flex gap-2 mb-3"><input id="rp-url" class="inp text-xs flex-1" readonly value="${esc(url)}">
        <button class="btn btn-primary text-xs" onclick="navigator.clipboard.writeText(document.getElementById('rp-url').value).then(()=>toast('URLをコピーしました'))"><i class="fas fa-copy"></i>コピー</button></div>
      ${qr ? `<div class="text-center" id="rp-qr"><img src="${qr}" alt="QRコード" class="mx-auto border border-gray-100 rounded-lg" width="240" height="240">
        <a class="btn btn-outline text-xs mt-2" href="${qr}" download="recruit_qr_${p.page_id}.gif"><i class="fas fa-download"></i>QRを保存</a></div>` : '<p class="text-xs text-gray-400">QRを作成できませんでした</p>'}
      <p class="text-[11px] text-gray-400 mt-3">SNS・チラシ・求人サイトに掲載できます。URLを知っている人は誰でも応募できます（承認するまでシフトは確定しません）</p>
      <div class="flex gap-2 mt-3"><a class="btn btn-outline flex-1 text-xs" href="${esc(url)}" target="_blank" rel="noopener">公開ページを開く</a><button class="btn btn-outline flex-1 text-xs" onclick="closeModal()">閉じる</button></div>`)
  }

  // ---------- 応募 ----------
  // 絞り込み: 状態のタブ・募集ページ・枠（シフトボードから）・氏名/電話番号・勤務日。100件ずつ表示し、続きは「さらに読み込む」（#339）
  const STATUS_TABS = [['pending', '未対応'], ['waitlist', 'キャンセル待ち'], ['done', '対応済み'], ['cancelled', '取り下げ'], ['all', 'すべて']]
  function appQuery(offset) {
    const q = { status: S.status }
    for (const k of ['page_id', 'slot_role_id', 'q', 'from', 'to']) if (S[k]) q[k] = S[k]
    if (offset) q.offset = offset
    return new URLSearchParams(q)
  }
  async function renderApplications() {
    const host = document.getElementById('recruit-body')
    let data; try { data = (await axios.get('/api/admin/recruit-applications?' + appQuery(0))).data } catch (e) { host.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    window.__recruitApps = data.applications
    const sl = data.slot
    const pageTitle = S.page_id ? ((data.pages || []).find(p => p.page_id === Number(S.page_id)) || {}).title : ''
    host.innerHTML = `
      ${data.ip_salt === 'none' ? '<p class="text-[11px] text-amber-700 bg-amber-50 rounded p-2 mb-3" id="recruit-salt-note"><i class="fas fa-key mr-1"></i>公開ページの送信回数の制限に使う秘密の値（RATE_LIMIT_SALT）が未設定です。接続元IPは短いハッシュにして保存しています。wrangler secret put RATE_LIMIT_SALT で推測できない値を登録してください</p>' : ''}
      <div class="flex items-center gap-1.5 mb-2 flex-wrap text-xs" id="recruit-status-tabs">
        ${STATUS_TABS.map(([k, l]) => `<button class="btn ${S.status === k ? 'btn-primary' : 'btn-outline'} text-xs" data-action="recruitStatus" data-status="${k}">${l}${k === 'pending' ? `（${data.counts.pending}）` : ''}</button>`).join('')}
      </div>
      <form class="flex items-end gap-2 mb-3 flex-wrap text-xs" id="recruit-filter">
        <label class="text-gray-500">氏名・フリガナ・電話番号<input id="rc-q" class="inp text-sm w-48" maxlength="60" value="${esc(S.q || '')}" placeholder="例: 山田 / 0901234"></label>
        <label class="text-gray-500">募集ページ<select id="rc-page" class="inp text-sm max-w-[14rem]"><option value="">すべて</option>
          ${(data.pages || []).map(p => `<option value="${p.page_id}" ${Number(S.page_id) === p.page_id ? 'selected' : ''}>${esc(p.title)}${p.status === 'open' ? '' : '（終了）'}</option>`).join('')}</select></label>
        <label class="text-gray-500">勤務日<span class="flex items-center gap-1"><input id="rc-from" type="date" class="inp text-sm" value="${esc(S.from || '')}">〜<input id="rc-to" type="date" class="inp text-sm" value="${esc(S.to || '')}"></span></label>
        <button type="submit" class="btn btn-primary text-xs"><i class="fas fa-magnifying-glass"></i>検索</button>
        ${S.q || S.page_id || S.from || S.to ? '<button type="button" class="btn btn-outline text-xs" data-action="recruitClearFilter">条件をクリア</button>' : ''}
      </form>
      ${S.slot_role_id ? `<div class="text-xs bg-blue-50 border border-blue-100 rounded-lg p-3 mb-3 flex items-center gap-2 flex-wrap" id="recruit-slot-filter">
        <span class="badge badge-blue">枠で絞り込み中</span>
        ${sl ? `<span>${fmt(sl.work_date)} ${esc(sl.start_time)}〜${esc(sl.end_time)}・${esc(sl.project_name)}・${esc(sl.role_name)}</span>
          <span class="${sl.full ? 'text-red-600 font-bold' : ''}">充足 ${sl.assigned}/${sl.headcount}名${sl.full ? '（定員に達しています）' : ''}・未対応 ${sl.pending}件</span>
          ${sl.pending ? `<button class="btn ${sl.full ? 'btn-danger' : 'btn-outline'} text-xs" data-action="recruitRejectSlot" data-id="${sl.slot_role_id}" data-count="${sl.pending}">この枠の残りの応募をまとめて見送る</button>` : ''}`
          : '<span class="text-gray-500">枠が見つかりません（削除された可能性があります）</span>'}
        <button class="ml-auto text-gray-500" data-action="recruitClearSlot" title="絞り込みを外す"><i class="fas fa-xmark"></i></button></div>` : ''}
      ${S.status === 'pending' && data.counts.pending_inactive ? `<p class="text-[11px] text-gray-500 mb-2">退職・停止中のスタッフの応募（${data.counts.pending_inactive}件）は承認できないため、未対応の件数に含めていません。見送りにしてください</p>` : ''}
      ${S.status === 'waitlist' ? '<p class="text-[11px] text-gray-500 mb-2">見送りにした日時のうち、開始前のものです。キャンセルが出たときは「繰り上げて承認」でシフトを確定できます</p>' : ''}
      <p class="text-xs text-gray-500 mb-2" id="recruit-app-total">${data.total}件${pageTitle ? `（${esc(pageTitle)}）` : ''}</p>
      <div class="space-y-3" id="recruit-app-list">
        ${data.applications.map(appCard).join('') || '<p class="card p-6 text-center text-sm text-gray-400">応募はありません</p>'}
      </div>
      ${moreButton(data)}`
    document.getElementById('recruit-filter').addEventListener('submit', (ev) => {
      ev.preventDefault()
      const v = (id) => document.getElementById(id).value.trim()
      Object.assign(S, { q: v('rc-q'), page_id: v('rc-page') ? Number(v('rc-page')) : null, from: v('rc-from'), to: v('rc-to') })
      renderApplications()
    })
  }
  const moreButton = (data) => data.next_offset != null
    ? `<button class="btn btn-outline w-full mt-3 text-xs" id="recruit-app-more" data-action="recruitMore" data-offset="${Number(data.next_offset)}">さらに読み込む（残り${data.total - data.next_offset}件）</button>` : ''
  delegate('recruitStatus', (el) => { S.status = el.dataset.status; renderApplications() })
  delegate('recruitClearFilter', () => { Object.assign(S, { q: '', page_id: null, from: '', to: '' }); renderApplications() })
  delegate('recruitClearSlot', () => { S.slot_role_id = null; renderApplications() })
  delegate('recruitMore', (el) => withSubmitLock(el, async () => {
    let data; try { data = (await axios.get('/api/admin/recruit-applications?' + appQuery(Number(el.dataset.offset)))).data } catch (e) { toast(errMsg(e)); return }
    const seen = new Set(window.__recruitApps.map(a => a.application_id))
    const add = data.applications.filter(a => !seen.has(a.application_id))
    window.__recruitApps = window.__recruitApps.concat(add)
    document.getElementById('recruit-app-list').insertAdjacentHTML('beforeend', add.map(appCard).join(''))
    el.outerHTML = moreButton(data)
  }))
  // 定員に達した枠の残りの未対応の応募をまとめて見送る（#303）
  delegate('recruitRejectSlot', (el) => withSubmitLock(el, async () => {
    if (!confirm(`この枠に残っている未対応の応募 ${Number(el.dataset.count)}件をまとめて見送ります。応募者への連絡は各自で行ってください`)) return
    try {
      const { data } = await axios.post(`/api/admin/recruit-slots/${Number(el.dataset.id)}/reject-pending`)
      toast(`${data.rejected}件を見送りにしました`); renderRecruit()
    } catch (e) { toast(errMsg(e)) }
  }))

  // 見送りにした日時のうち、開始前のもの（繰り上げて承認できる。#211）
  const promotable = (i) => i.status === 'rejected' && !!i.work_date && !i.past
  function appCard(a) {
    const pending = a.items.filter(i => i.status === 'pending')
    const promo = a.staff_inactive ? [] : a.items.filter(promotable)
    const hasCheck = pending.length || promo.length
    const who = a.staff_id
      ? `<a class="text-blue-600 hover:underline" href="#staff/${Number(a.staff_id)}">${esc(a.staff_name || a.name)}</a>${a.is_provisional ? '<span class="badge badge-yellow ml-1">仮</span>' : ''}<span class="badge badge-blue ml-1">${a.source === 'staff' ? 'アプリから応募' : '登録済み'}</span>${a.staff_inactive ? '<span class="badge badge-red ml-1">退職・停止中</span>' : ''}`
      : `${esc(a.name)}<span class="badge badge-gray ml-1">新規（未登録）</span>`
    const matchName = (m) => `<a class="underline" href="#staff/${Number(m.staff_id)}">${esc(m.name)}</a>${m.inactive ? '（退職・停止中）' : ''}`
    const checks = (i) => [
      ...(i.work_date && i.remaining <= 0 && (i.status === 'pending' || promotable(i)) ? ['定員に達しています'] : []),
      ...(i.past && i.status === 'pending' ? ['開始時刻を過ぎています'] : []),
      ...i.conflicts.map(x => '重複: ' + x)]
    return `<article class="card p-4" data-application-id="${a.application_id}">
      <div class="flex items-start justify-between gap-2 flex-wrap mb-2">
        <div><p class="font-bold text-gray-800">${who}</p>
          <p class="text-xs text-gray-500">${a.kana ? esc(a.kana) + '・' : ''}${a.phone ? `<a href="tel:${esc(a.phone)}" class="hover:underline">${esc(a.phone)}</a>` : ''}${a.email ? '・' + esc(a.email) : ''}</p></div>
        <p class="text-[11px] text-gray-400 text-right">${esc(a.page_title || '')}<br>${dayjs(a.created_at).format('M/D HH:mm')} 応募</p>
      </div>
      ${a.note ? `<p class="text-xs bg-gray-50 rounded p-2 mb-2 whitespace-pre-wrap">${esc(a.note)}</p>` : ''}
      ${a.staff_inactive && pending.length ? '<p class="text-xs text-red-700 bg-red-50 rounded p-2 mb-2"><i class="fas fa-user-slash mr-1"></i>このスタッフは退職・停止中のため、承認できません。見送りにしてください</p>' : ''}
      ${!a.staff_id && a.phone_matches.length ? `<p class="text-xs text-amber-700 bg-amber-50 rounded p-2 mb-2"><i class="fas fa-user-check mr-1"></i>電話番号が一致するスタッフがいます: ${a.phone_matches.map(matchName).join('、')}</p>` : ''}
      <div class="overflow-x-auto"><table class="tbl text-xs"><thead><tr>${hasCheck ? `<th>${pending.length ? `<input type="checkbox" checked data-action="recruitCheckAll" data-id="${a.application_id}" title="未対応をすべて選ぶ">` : ''}</th>` : ''}<th>日時</th><th>案件・場所・役割</th><th>充足</th><th>確認</th><th>状態</th></tr></thead><tbody>
        ${a.items.map(i => `<tr>
          ${hasCheck ? `<td>${i.status === 'pending' ? `<input type="checkbox" class="ri-check" value="${i.item_id}" ${i.remaining > 0 && !i.past && !i.conflicts.length && !a.staff_inactive ? 'checked' : ''}>`
            : promo.includes(i) ? `<input type="checkbox" class="ri-promote" value="${i.item_id}" title="繰り上げて承認する日時">` : ''}</td>` : ''}
          ${i.work_date ? `<td class="whitespace-nowrap">${fmt(i.work_date)} ${esc(i.start_time)}〜${esc(i.end_time)}</td>
          <td>${esc(i.project_name)}<span class="text-gray-400">${i.place ? '・' + esc(i.place) : ''}・${esc(i.role_name)}</span></td>
          <td class="whitespace-nowrap ${i.remaining <= 0 ? 'text-red-600' : ''}">${i.assigned}/${i.headcount}名</td>`
          : '<td colspan="3" class="text-gray-400">（削除された枠）</td>'}
          <td>${checks(i).map(x => `<span class="badge badge-red block mb-0.5 whitespace-nowrap">${esc(x)}</span>`).join('') || '-'}</td>
          <td><span class="badge ${ITEM_BADGE[i.status] || 'badge-gray'}">${esc(ITEM_LABEL[i.status] || i.status)}</span>${promo.includes(i) ? '<span class="block text-[10px] text-gray-400 mt-0.5">キャンセル待ち</span>' : ''}</td></tr>`).join('')}
      </tbody></table></div>
      ${hasCheck ? `<div class="flex gap-2 mt-3 flex-wrap">
        ${pending.length ? `<button class="btn btn-primary text-xs" data-action="recruitDecide" data-id="${a.application_id}" data-approve="1"><i class="fas fa-check"></i>選択した日時を承認（シフト確定）</button>
        <button class="btn btn-outline text-xs" data-action="recruitDecide" data-id="${a.application_id}" data-approve="0">選択した日時を見送る</button>` : ''}
        ${promo.length ? `<button class="btn btn-outline text-xs" data-action="recruitDecide" data-id="${a.application_id}" data-approve="1" data-promote="1"><i class="fas fa-arrow-up"></i>選択した見送りを繰り上げて承認</button>` : ''}
      </div>` : ''}
    </article>`
  }
  delegate('recruitCheckAll', (el) => {
    document.querySelectorAll(`[data-application-id="${Number(el.dataset.id)}"] .ri-check`).forEach(x => { x.checked = el.checked })
  })
  // 承認・見送りは処理中にボタンを無効にして、二度押しで仮登録・シフトが2つずつできないようにする（#86。サーバーでも明細を押さえて防ぐ）
  delegate('recruitDecide', (el) => withSubmitLock(el, () => decideApplication(Number(el.dataset.id), el.dataset.approve === '1', el.dataset.promote === '1')))

  async function decideApplication(id, approve, promote) {
    const a = window.__recruitApps.find(x => x.application_id === id); if (!a) return
    const ids = [...document.querySelectorAll(`[data-application-id="${id}"] ${promote ? '.ri-promote' : '.ri-check'}:checked`)].map(x => Number(x.value))
    if (!ids.length) return toast(promote ? '繰り上げる日時を選択してください' : '日時を選択してください')
    if (!approve) {
      if (!confirm(`${ids.length}件を見送ります。応募者への連絡は各自で行ってください`)) return
      try { await axios.post(`/api/admin/recruit-applications/${id}/decide`, { reject: ids }); toast('見送りにしました'); renderRecruit() } catch (e) { toast(errMsg(e)) }
      return
    }
    if (promote && !confirm(`見送りにした${ids.length}件を繰り上げて承認します（シフトを確定します）。応募者への連絡は各自で行ってください`)) return
    if (a.staff_id) return runDecide(id, { approve: ids })
    // 未登録の応募者: 既存スタッフに紐づけるか、仮登録を作成する（退職・停止中のスタッフには紐づけられない）。
    // 電話番号が一致しなくても、氏名・フリガナ・スタッフ番号・電話番号で探して紐づけられる（#395）
    let partners = [], cands = []
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners || [] } catch (e) { }
    try { cands = (await axios.get(`/api/admin/recruit-applications/${id}/staff-candidates`)).data.candidates || [] } catch (e) { cands = a.phone_matches.map(m => ({ ...m, phone_match: true })) }
    const usable = cands.filter(m => m.phone_match && !m.inactive)
    window.__recruitApproveIds = ids
    modal(`
      <h3 class="font-bold text-lg mb-1">承認（${ids.length}件）</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(a.name)}さんはスタッフ登録がありません。どちらかを選んでください</p>
      <div class="space-y-3 text-sm" id="recruit-approve-form">
        <div class="flex items-start gap-2 p-3 rounded-lg border border-gray-200"><input type="radio" name="ra-mode" value="link" id="ra-mode-link" ${usable.length ? 'checked' : ''} class="mt-1">
          <div class="flex-1 min-w-0"><label for="ra-mode-link">登録済みのスタッフに紐づける</label>
            <div class="flex gap-1 mt-1"><input id="ra-q" class="inp text-sm flex-1" maxlength="60" placeholder="氏名・フリガナ・スタッフ番号・電話番号で検索">
              <button type="button" class="btn btn-outline text-xs" data-action="recruitStaffSearch" data-id="${id}"><i class="fas fa-magnifying-glass"></i>検索</button></div>
            <select id="ra-staff" class="inp text-sm mt-1">${candidateOptions(cands)}</select>
            <span class="block text-[11px] text-gray-400 mt-1">電話番号・氏名が一致する人を上に表示します。別の電話番号で応募した既存のスタッフも、検索して選べます</span></div></div>
        <label class="flex items-start gap-2 p-3 rounded-lg border border-gray-200"><input type="radio" name="ra-mode" value="new" ${usable.length ? '' : 'checked'} class="mt-1">
          <span class="flex-1">仮登録を作成する（氏名・電話番号）
            <select id="ra-type" class="inp text-sm mt-1" onchange="document.getElementById('ra-partner-box').classList.toggle('hidden', this.value!=='partner_manual')">
              ${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
            <span id="ra-partner-box" class="hidden block mt-1"><select id="ra-partner" class="inp text-sm"><option value="">取引先を選択</option>${partners.map(p => `<option value="${p.affiliation_id}">${esc(p.affiliation_name)}</option>`).join('')}</select></span>
            <span class="block text-[11px] text-gray-400 mt-1">ログインは発行しません。報告用URL・代理入力で勤怠を記録できます。後からスタッフ詳細で本登録できます</span></span></label>
      </div>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-primary flex-1" data-action="recruitApproveUnregistered" data-id="${id}">承認してシフトを確定</button></div>`)
    const qEl = document.getElementById('ra-q')
    if (qEl) qEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); document.querySelector('[data-action="recruitStaffSearch"]').click() } })
  }
  function candidateOptions(list) {
    if (!list.length) return '<option value="">候補がありません。検索してください</option>'
    return list.map(m => `<option value="${Number(m.staff_id)}" ${m.inactive ? 'disabled' : ''}>${esc(m.name)}（${esc([m.user_code, m.phone].filter(Boolean).join('・') || '-')}）${m.is_provisional ? '・仮登録' : ''}${m.phone_match ? '・電話番号が一致' : m.name_match ? '・氏名が一致' : ''}${m.inactive ? '・退職・停止中' : ''}</option>`).join('')
  }
  delegate('recruitStaffSearch', (el) => withSubmitLock(el, async () => {
    const q = document.getElementById('ra-q').value.trim()
    try {
      const { data } = await axios.get(`/api/admin/recruit-applications/${Number(el.dataset.id)}/staff-candidates?` + new URLSearchParams(q ? { q } : {}))
      document.getElementById('ra-staff').innerHTML = candidateOptions(data.candidates || [])
      const link = document.getElementById('ra-mode-link'); if (link && (data.candidates || []).some(m => !m.inactive)) link.checked = true
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('recruitApproveUnregistered', (el) => withSubmitLock(el, () => approveUnregistered(Number(el.dataset.id), window.__recruitApproveIds || [])))
  function approveUnregistered(id, ids) {
    const mode = (document.querySelector('input[name="ra-mode"]:checked') || {}).value
    const body = { approve: ids }
    if (!mode) return toast('紐づけるか、仮登録を作成するかを選んでください')
    if (mode === 'link') {
      body.staff_id = Number(document.getElementById('ra-staff').value)
      if (!body.staff_id) return toast('紐づけるスタッフを選んでください')
    } else { body.new_staff_type = document.getElementById('ra-type').value; body.partner_affiliation_id = document.getElementById('ra-partner').value || null; body.force_new = true }
    return runDecide(id, body)
  }
  async function runDecide(id, body) {
    try {
      const { data } = await axios.post(`/api/admin/recruit-applications/${id}/decide`, body)
      closeModal(); toast(`${data.created_shifts}件のシフトを確定しました${data.promoted ? '（繰り上げ）' : ''}${data.created_staff ? '（仮登録を作成）' : ''}`)
      if (window.invalidateBoardMaster) window.invalidateBoardMaster()
      // 承認で定員に達した枠に、ほかの人の未対応の応募が残っていれば、まとめて見送るかを確かめる（#303）
      const filled = data.filled_slots || []
      if (filled.length && confirm('定員に達した枠に、ほかの人の未対応の応募が残っています:\n・' + filled.map(s => `${fmt(s.work_date)} ${s.start_time}〜${s.end_time} ${s.role_name}（${s.pending}件）`).join('\n・') + '\n\nまとめて見送りますか？（応募者への連絡は各自で行ってください）')) {
        let n = 0
        for (const s of filled) { try { n += (await axios.post(`/api/admin/recruit-slots/${Number(s.slot_role_id)}/reject-pending`)).data.rejected || 0 } catch (e) { toast(errMsg(e)) } }
        toast(`${n}件を見送りにしました`)
      }
      renderRecruit()
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force && d.warnings) {
        if (confirm('確認してください:\n・' + d.warnings.join('\n・') + '\n\nこのまま承認しますか？')) return runDecide(id, { ...body, force: true })
        return
      }
      if (d && d.need_staff) { toast(d.error); return }
      toast(errMsg(e))
      // ほかの操作で対応済みになっていたときは、一覧を読み直す
      if (e.response && e.response.status === 409) { closeModal(); renderRecruit() }
    }
  }
})()
