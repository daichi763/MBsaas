// =========================================================
// 募集ページ・応募の承認（管理画面 #recruit）
// docs/spec_spot_shift.md 第4段階。admin.js の後に読み込む
// =========================================================
(function () {
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  const fmt = (d) => { const x = dayjs(d); return `${x.format('M/D')}(${WD[x.day()]})` }
  const TYPE_LABEL = { daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属', own_employee: '自社雇用' }
  const ITEM_LABEL = { pending: '未対応', approved: '承認', rejected: '見送り', cancelled: '取り下げ' }
  const ITEM_BADGE = { pending: 'badge-yellow', approved: 'badge-green', rejected: 'badge-gray', cancelled: 'badge-gray' }
  const S = window.__recruitState = window.__recruitState || { tab: 'applications', status: 'pending' }
  let projects = null
  const pageUrl = (t) => location.origin + '/apply/' + t

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
      ${data.turnstile_enabled ? '' : '<p class="text-[11px] text-amber-700 bg-amber-50 rounded p-2 mb-3" id="turnstile-note"><i class="fas fa-shield-halved mr-1"></i>ボット対策（Cloudflare Turnstile）は未設定です。送信回数の制限と入力チェックで保護しています。設定する場合は TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY を登録してください</p>'}
      <div class="grid md:grid-cols-2 gap-3" id="recruit-page-list">
        ${data.pages.map(p => `<article class="card p-4">
          <div class="flex items-start justify-between gap-2 mb-1">
            <div class="min-w-0"><p class="font-bold text-gray-800 truncate">${esc(p.title)}</p>
              <p class="text-xs text-gray-500">${fmt(p.date_from)}〜${fmt(p.date_to)}・${p.project_names.map(esc).join('、')}</p></div>
            ${p.is_open ? '<span class="badge badge-green shrink-0">募集中</span>' : '<span class="badge badge-gray shrink-0">終了</span>'}
          </div>
          <p class="text-xs text-gray-600 mb-2">募集中の枠 ${p.open_roles}件（残り${p.open_remaining}名）・応募 ${p.application_count}件${p.pending_count ? `・<b class="text-red-600">未対応 ${p.pending_count}件</b>` : ''}</p>
          <div class="flex gap-1.5 flex-wrap">
            <button class="btn btn-outline text-xs" onclick="showRecruitShare(${p.page_id})"><i class="fas fa-qrcode"></i>URL・QR</button>
            <button class="btn btn-outline text-xs" onclick="openRecruitPage(${p.page_id})"><i class="fas fa-pen"></i>編集</button>
            ${p.pending_count ? `<button class="btn btn-outline text-xs" onclick="window.__recruitState.tab='applications';window.__recruitState.page_id=${p.page_id};renderRecruit()">応募を見る</button>` : ''}
            ${p.status === 'open' ? `<button class="btn btn-outline text-xs" onclick="setRecruitStatus(${p.page_id},'closed')">募集を終了</button>` : `<button class="btn btn-outline text-xs" onclick="setRecruitStatus(${p.page_id},'open')">再開</button>`}
          </div>
        </article>`).join('') || '<p class="card p-6 text-center text-sm text-gray-400 md:col-span-2">募集ページはありません。「募集ページを作成」から作成してください</p>'}
      </div>`
  }

  window.openRecruitPage = function (id) {
    const p = id ? (window.__recruitPages || []).find(x => x.page_id === id) : null
    const sel = new Set(p ? String(p.project_ids).split(',').map(Number) : [])
    const spot = projects.filter(x => x.status !== 'ended')
    modal(`
      <h3 class="font-bold text-lg mb-3">${p ? '募集ページの編集' : '募集ページの作成'}</h3>
      <div class="space-y-3 text-sm" id="recruit-page-form">
        <label class="block text-gray-600">タイトル（応募者に表示）<span class="text-red-500">*</span><input id="rp-title" class="inp" maxlength="80" value="${esc(p?.title || '')}" placeholder="例: 週末のスマホ販売イベントスタッフ"></label>
        <div class="text-gray-600">対象の案件 <span class="text-red-500">*</span>
          <div class="max-h-36 overflow-y-auto border border-gray-200 rounded-lg p-2 mt-1 space-y-1">
            ${spot.map(x => `<label class="flex items-center gap-2 text-xs"><input type="checkbox" class="rp-proj" value="${x.project_id}" ${sel.has(x.project_id) ? 'checked' : ''}>${esc(x.project_name)}<span class="text-gray-400">${esc(x.client_name || '')}</span>${x.engagement_type === 'spot' ? '<span class="badge badge-purple">スポット</span>' : ''}</label>`).join('')}
          </div>
          <p class="text-[11px] text-gray-400 mt-1">案件名・クライアント名・金額は公開ページに表示しません。表示するのは、日時・開催場所・役割・残り人数です</p></div>
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
        <button class="btn btn-primary flex-1" onclick="saveRecruitPage(${p ? p.page_id : 'null'})">${p ? '保存' : '作成してURLを発行'}</button>
      </div>`)
  }
  window.saveRecruitPage = async function (id) {
    const v = (k) => document.getElementById(k).value
    const body = {
      title: v('rp-title'), project_ids: [...document.querySelectorAll('.rp-proj:checked')].map(x => Number(x.value)),
      date_from: v('rp-from'), date_to: v('rp-to'), description: v('rp-desc'), pay_note: v('rp-pay'), contact_note: v('rp-contact'),
      show_remaining: document.getElementById('rp-remaining').checked, allow_staff: document.getElementById('rp-staff').checked,
      ...(id && document.getElementById('rp-regen')?.checked ? { regenerate_token: true } : {}),
    }
    try {
      const { data } = id ? await axios.put('/api/admin/recruit-pages/' + id, body) : await axios.post('/api/admin/recruit-pages', body)
      closeModal(); toast(id ? '保存しました' : '募集ページを作成しました')
      S.tab = 'pages'; await renderRecruit()
      showRecruitShare(id || data.page_id)
    } catch (e) { toast(errMsg(e)) }
  }
  window.setRecruitStatus = async function (id, status) {
    if (status === 'closed' && !confirm('募集を終了します。公開ページでは応募できなくなります（未対応の応募はそのまま残ります）')) return
    try { await axios.put('/api/admin/recruit-pages/' + id, { status }); toast(status === 'closed' ? '募集を終了しました' : '募集を再開しました'); renderRecruit() } catch (e) { toast(errMsg(e)) }
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
  async function renderApplications() {
    const host = document.getElementById('recruit-body')
    const q = new URLSearchParams({ status: S.status, ...(S.page_id ? { page_id: S.page_id } : {}) })
    let data; try { data = (await axios.get('/api/admin/recruit-applications?' + q)).data } catch (e) { host.innerHTML = `<p class="text-red-600">${esc(errMsg(e))}</p>`; return }
    window.__recruitApps = data.applications
    host.innerHTML = `
      <div class="flex items-center gap-2 mb-3 flex-wrap text-xs">
        ${[['pending', `未対応（${data.counts.pending}）`], ['done', '対応済み'], ['cancelled', '取り下げ']].map(([k, l]) =>
          `<button class="btn ${S.status === k ? 'btn-primary' : 'btn-outline'} text-xs" onclick="window.__recruitState.status='${k}';renderRecruit()">${l}</button>`).join('')}
        ${S.page_id ? `<span class="badge badge-blue">募集ページで絞り込み中 <button onclick="window.__recruitState.page_id=null;renderRecruit()" class="ml-1"><i class="fas fa-xmark"></i></button></span>` : ''}
      </div>
      <div class="space-y-3" id="recruit-app-list">
        ${data.applications.map(appCard).join('') || '<p class="card p-6 text-center text-sm text-gray-400">応募はありません</p>'}
      </div>`
  }
  function appCard(a) {
    const pending = a.items.filter(i => i.status === 'pending')
    const who = a.staff_id
      ? `<a class="text-blue-600 hover:underline" href="#staff/${a.staff_id}">${esc(a.staff_name || a.name)}</a>${a.is_provisional ? '<span class="badge badge-yellow ml-1">仮</span>' : ''}<span class="badge badge-blue ml-1">${a.source === 'staff' ? 'アプリから応募' : '登録済み'}</span>`
      : `${esc(a.name)}<span class="badge badge-gray ml-1">新規（未登録）</span>`
    return `<article class="card p-4" data-application-id="${a.application_id}">
      <div class="flex items-start justify-between gap-2 flex-wrap mb-2">
        <div><p class="font-bold text-gray-800">${who}</p>
          <p class="text-xs text-gray-500">${a.kana ? esc(a.kana) + '・' : ''}${a.phone ? `<a href="tel:${esc(a.phone)}" class="hover:underline">${esc(a.phone)}</a>` : ''}${a.email ? '・' + esc(a.email) : ''}</p></div>
        <p class="text-[11px] text-gray-400 text-right">${esc(a.page_title || '')}<br>${dayjs(a.created_at).format('M/D HH:mm')} 応募</p>
      </div>
      ${a.note ? `<p class="text-xs bg-gray-50 rounded p-2 mb-2 whitespace-pre-wrap">${esc(a.note)}</p>` : ''}
      ${!a.staff_id && a.phone_matches.length ? `<p class="text-xs text-amber-700 bg-amber-50 rounded p-2 mb-2"><i class="fas fa-user-check mr-1"></i>電話番号が一致するスタッフがいます: ${a.phone_matches.map(m => `<a class="underline" href="#staff/${m.staff_id}">${esc(m.name)}</a>`).join('、')}</p>` : ''}
      <div class="overflow-x-auto"><table class="tbl text-xs"><thead><tr>${pending.length ? `<th><input type="checkbox" checked onchange="document.querySelectorAll('[data-application-id=&quot;${a.application_id}&quot;] .ri-check').forEach(x=>x.checked=this.checked)"></th>` : ''}<th>日時</th><th>案件・場所・役割</th><th>充足</th><th>確認</th><th>状態</th></tr></thead><tbody>
        ${a.items.map(i => `<tr>
          ${pending.length ? `<td>${i.status === 'pending' ? `<input type="checkbox" class="ri-check" value="${i.item_id}" ${i.remaining > 0 && !i.past && !i.conflicts.length ? 'checked' : ''}>` : ''}</td>` : ''}
          <td class="whitespace-nowrap">${fmt(i.work_date)} ${i.start_time}〜${i.end_time}</td>
          <td>${esc(i.project_name)}<span class="text-gray-400">${i.place ? '・' + esc(i.place) : ''}・${esc(i.role_name)}</span></td>
          <td class="whitespace-nowrap ${i.remaining <= 0 ? 'text-red-600' : ''}">${i.assigned}/${i.headcount}名</td>
          <td>${[...(i.remaining <= 0 && i.status === 'pending' ? ['定員に達しています'] : []), ...(i.past && i.status === 'pending' ? ['過去の日付'] : []), ...i.conflicts.map(x => '重複: ' + x)].map(x => `<span class="badge badge-red block mb-0.5 whitespace-nowrap">${esc(x)}</span>`).join('') || '-'}</td>
          <td><span class="badge ${ITEM_BADGE[i.status]}">${ITEM_LABEL[i.status]}</span></td></tr>`).join('')}
      </tbody></table></div>
      ${pending.length ? `<div class="flex gap-2 mt-3 flex-wrap">
        <button class="btn btn-primary text-xs" onclick="decideApplication(${a.application_id}, true)"><i class="fas fa-check"></i>選択した日時を承認（シフト確定）</button>
        <button class="btn btn-outline text-xs" onclick="decideApplication(${a.application_id}, false)">選択した日時を見送る</button>
      </div>` : ''}
    </article>`
  }

  window.decideApplication = async function (id, approve) {
    const a = window.__recruitApps.find(x => x.application_id === id); if (!a) return
    const ids = [...document.querySelectorAll(`[data-application-id="${id}"] .ri-check:checked`)].map(x => Number(x.value))
    if (!ids.length) return toast('日時を選択してください')
    if (!approve) {
      if (!confirm(`${ids.length}件を見送ります。応募者への連絡は各自で行ってください`)) return
      try { await axios.post(`/api/admin/recruit-applications/${id}/decide`, { reject: ids }); toast('見送りにしました'); renderRecruit() } catch (e) { toast(errMsg(e)) }
      return
    }
    if (a.staff_id) return runDecide(id, { approve: ids })
    // 未登録の応募者: 既存スタッフに紐づけるか、仮登録を作成する
    let partners = []
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners || [] } catch (e) { }
    modal(`
      <h3 class="font-bold text-lg mb-1">承認（${ids.length}件）</h3>
      <p class="text-xs text-gray-500 mb-3">${esc(a.name)}さんはスタッフ登録がありません。どちらかを選んでください</p>
      <div class="space-y-3 text-sm" id="recruit-approve-form">
        ${a.phone_matches.length ? `<label class="flex items-start gap-2 p-3 rounded-lg border border-gray-200"><input type="radio" name="ra-mode" value="link" checked class="mt-1">
          <span class="flex-1">登録済みのスタッフに紐づける<select id="ra-staff" class="inp text-sm mt-1">${a.phone_matches.map(m => `<option value="${m.staff_id}">${esc(m.name)}（${esc(m.phone)}）${m.is_provisional ? '・仮登録' : ''}</option>`).join('')}</select></span></label>` : ''}
        <label class="flex items-start gap-2 p-3 rounded-lg border border-gray-200"><input type="radio" name="ra-mode" value="new" ${a.phone_matches.length ? '' : 'checked'} class="mt-1">
          <span class="flex-1">仮登録を作成する（氏名・電話番号）
            <select id="ra-type" class="inp text-sm mt-1" onchange="document.getElementById('ra-partner-box').classList.toggle('hidden', this.value!=='partner_manual')">
              ${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
            <span id="ra-partner-box" class="hidden block mt-1"><select id="ra-partner" class="inp text-sm"><option value="">取引先を選択</option>${partners.map(p => `<option value="${p.affiliation_id}">${esc(p.affiliation_name)}</option>`).join('')}</select></span>
            <span class="block text-[11px] text-gray-400 mt-1">ログインは発行しません。報告用URL・代理入力で勤怠を記録できます。後からスタッフ詳細で本登録できます</span></span></label>
      </div>
      <div class="flex gap-2 mt-4"><button class="btn btn-outline flex-1" onclick="closeModal()">やめる</button>
        <button class="btn btn-primary flex-1" onclick="approveUnregistered(${id}, ${JSON.stringify(ids)})">承認してシフトを確定</button></div>`)
  }
  window.approveUnregistered = function (id, ids) {
    const mode = (document.querySelector('input[name="ra-mode"]:checked') || {}).value
    const body = { approve: ids }
    if (mode === 'link') body.staff_id = Number(document.getElementById('ra-staff').value)
    else { body.new_staff_type = document.getElementById('ra-type').value; body.partner_affiliation_id = document.getElementById('ra-partner').value || null; body.force_new = true }
    runDecide(id, body)
  }
  async function runDecide(id, body) {
    try {
      const { data } = await axios.post(`/api/admin/recruit-applications/${id}/decide`, body)
      closeModal(); toast(`${data.created_shifts}件のシフトを確定しました${data.created_staff ? '（仮登録を作成）' : ''}`); renderRecruit()
      if (window.invalidateBoardMaster) window.invalidateBoardMaster()
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force && d.warnings) {
        if (confirm('確認してください:\n・' + d.warnings.join('\n・') + '\n\nこのまま承認しますか？')) return runDecide(id, { ...body, force: true })
        return
      }
      if (d && d.need_staff) { toast(d.error); return }
      toast(errMsg(e))
    }
  }
})()
