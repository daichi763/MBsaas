// =========================================================
// 所属区分の移行 / 仮登録 / 勤怠・日報の提出設定 / 報告用URL / 代理入力（管理画面）
// docs/spec_spot_shift.md 第2段階。admin.js・shift-board.js の後に読み込む
// =========================================================
(function () {
  const TYPE_LABEL = { own_employee: '自社雇用', daily_worker: '自社日雇い', freelance: '個人事業主', partner_manual: '取引先所属', linked_external: '他社連携', skillsheet_only: 'スキルシートのみ' }
  const TYPE_DESC = {
    own_employee: '正社員・契約社員・アルバイト・パート。従業員管理に登録します',
    daily_worker: '自社で日々雇用する人。従業員管理には登録しません',
    freelance: '個人で業務委託する人。支払は本人への業務委託費になります',
    partner_manual: '取引先（Field OS 未利用の会社）に所属する人。支払は取引先へ',
  }
  // シフト単位の例外のみ（案件・スタッフ単位の勤怠報告は「案件報告管理」で 8 種類ごとに設定する）
  const ATT_LABEL = { '': '案件報告管理の設定どおり', none: '勤怠報告なし', in_out: '入店・退店のみ', full: '案件報告管理の設定どおり' }
  const DR_LABEL = { '': '案件の設定に従う', none: '日報なし', required: '日報あり' }
  const RT_LABEL = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店' }
  const reportSettingsLink = (pid) => `<a href="#report-settings${pid ? '/' + pid : ''}" class="text-blue-600 hover:underline" onclick="closeModal && closeModal()">案件報告管理</a>`
  const ENTRY_LABEL = { app: 'アプリ', link: '報告用URL', proxy: '代理入力', correction: '修正申請の承認' }
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const opts = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${String(v ?? '') === k ? 'selected' : ''}>${l}</option>`).join('')

  // =========================================================
  // 仮登録（氏名・電話のみ）。ctx.slot_role_id があれば、登録後にその枠へ割り当てる
  // =========================================================
  // 開いている仮登録の画面の枠（重複したときの「この人を割り当てる」に使う。#506）
  let quickCtx = {}
  window.showQuickRegister = async function (ctx) {
    ctx = ctx || {}
    quickCtx = ctx
    let partners = []
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners } catch { }
    modal(`
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-bolt text-amber-500 mr-1"></i>仮登録</h3>
      <p class="text-xs text-gray-500 mb-3">氏名と電話番号だけで登録し、すぐシフトに入れられます。必須項目は後から「本登録」で入力します</p>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">氏名 <span class="text-red-500">*</span><input id="qr-name" class="inp" placeholder="山田 太郎"></label>
          <label class="text-sm text-gray-600">電話番号 <span class="text-red-500">*</span><input id="qr-phone" class="inp" inputmode="tel" placeholder="09012345678" onblur="quickLookupPhone()"></label>
        </div>
        <div id="qr-dup"></div>
        <label class="text-sm text-gray-600 block">区分
          <select id="qr-type" class="inp" onchange="quickTypeChanged()">
            ${['daily_worker', 'freelance', 'partner_manual', 'own_employee'].map(k => `<option value="${k}">${TYPE_LABEL[k]}</option>`).join('')}
          </select></label>
        <p id="qr-type-desc" class="text-[11px] text-gray-400 -mt-2">${TYPE_DESC.daily_worker}</p>
        <div id="qr-partner" class="hidden p-3 rounded-lg bg-purple-50 space-y-2">
          <select id="qr-partner-id" class="inp text-sm" onchange="document.getElementById('qr-partner-new').classList.toggle('hidden', this.value !== 'new')">
            ${partners.map(p => `<option value="${p.affiliation_id}">${esc(p.affiliation_name)}</option>`).join('')}<option value="new" ${partners.length ? '' : 'selected'}>＋ 新しい取引先</option>
          </select>
          <input id="qr-partner-new" class="inp text-sm ${partners.length ? 'hidden' : ''}" placeholder="取引先名">
        </div>
        <input id="qr-trade" class="inp text-sm hidden" placeholder="屋号（任意）">
        <div class="grid grid-cols-2 gap-3 items-end">
          <label class="text-sm text-gray-600">日報<select id="qr-dr" class="inp text-sm">${opts(DR_LABEL, '')}</select></label>
          <p class="text-[11px] text-gray-400">勤怠報告は、シフトを割り当てた案件の標準設定が適用されます</p>
        </div>
        <input id="qr-memo" class="inp text-sm" placeholder="メモ（任意・紹介元など）">
        <button class="btn btn-primary w-full" data-action="submitQuickRegister" data-slot-role-id="${Number(ctx.slot_role_id) || ''}" data-request-key="${esc(newRequestKey())}">${ctx.slot_role_id ? '仮登録して枠に割り当てる' : '仮登録する'}</button>
      </div>`)
  }
  window.quickTypeChanged = function () {
    const t = document.getElementById('qr-type').value
    document.getElementById('qr-type-desc').textContent = TYPE_DESC[t] || ''
    document.getElementById('qr-partner').classList.toggle('hidden', t !== 'partner_manual')
    document.getElementById('qr-trade').classList.toggle('hidden', t !== 'freelance')
  }
  window.quickLookupPhone = async function () {
    const phone = document.getElementById('qr-phone').value
    const box = document.getElementById('qr-dup'); if (!box) return
    if (phone.replace(/\D/g, '').length < 10) { box.innerHTML = ''; return }
    let data; try { data = (await axios.get('/api/admin/staff-lookup', { params: { phone } })).data } catch { return }
    box.innerHTML = data.matches.length ? quickMatchesHtml(data.matches, {}) : ''
  }
  // 電話番号が同じ登録済みのスタッフ（#356 #506）。退職・停止中は印を付けて区別し、割り当てのボタンは出さない。
  // 枠から開いたときは、在籍中の人に「この人を割り当てる」を出す。登録時の重複（409）では「別の人として登録する」も出す
  function quickMatchesHtml(matches, opt) {
    const slot = Number(quickCtx.slot_role_id) || 0
    const blocked = (m) => m.inactive === '退職' || m.inactive === '停止'
    const allBlocked = matches.every(blocked)
    return `<div class="p-2 rounded-lg bg-amber-50 text-xs text-amber-800" id="qr-dup-box"><p><i class="fas fa-triangle-exclamation mr-1"></i>この電話番号のスタッフが登録済みです</p>
      <ul class="mt-1 space-y-1">${matches.map(m => `<li class="flex items-center gap-2 flex-wrap">
        <a class="underline font-bold" href="#staff/${Number(m.staff_id)}" onclick="closeModal()">${esc(m.name)}</a>
        <span>（${esc(TYPE_LABEL[m.affiliation_type] || '')}${m.is_provisional ? '・仮登録' : ''}）</span>
        ${m.inactive ? `<span class="badge badge-red">${esc(m.inactive)}${m.retired_at && m.inactive === '退職' ? ' ' + esc(String(m.retired_at).slice(0, 10)) : ''}</span>` : ''}
        ${slot && !blocked(m) ? `<button class="btn btn-primary text-xs" data-action="quickAssignExisting" data-slot-role-id="${slot}" data-staff-id="${Number(m.staff_id)}">この人を割り当てる</button>` : ''}</li>`).join('')}</ul>
      <p class="mt-1">${allBlocked
        ? '退職・停止中の人です。同じ人なら、名前からスタッフ詳細を開いて在籍状況を戻してから割り当ててください（別の人として登録すると、評価や勤怠の履歴が分かれます）'
        : slot ? '同じ人の場合は「この人を割り当てる」で、この枠に割り当ててください' : '同じ人の場合は、既存のスタッフをシフトに割り当ててください'}</p>
      ${opt.needForce ? `<button class="btn btn-outline text-xs mt-2" data-action="quickForceRegister" data-slot-role-id="${slot || ''}" data-request-key="${esc(opt.requestKey || '')}">別の人として登録する</button>` : ''}</div>`
  }
  // 登録済みの人をその枠に割り当てる（#506）
  delegate('quickAssignExisting', (el) => withSubmitLock(el, async () => {
    if (!window.boardAssign) return
    if (window.invalidateBoardMaster) invalidateBoardMaster()
    await boardAssign(Number(el.dataset.slotRoleId), [Number(el.dataset.staffId)])
  }))
  delegate('quickForceRegister', (el) => withSubmitLock(el, () =>
    submitQuickRegister({ slot_role_id: Number(el.dataset.slotRoleId) || null }, true, el.dataset.requestKey)))
  // 画面を開くたびに作る値。同じ画面からの再送（二度押し・通信の再試行）をサーバーが同じ登録として扱う（#568）
  function newRequestKey() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch { }
    return Date.now().toString(36) + Math.random().toString(36).slice(2)
  }
  // 送信中はボタンを無効にする（二度押しで同じ人が2人登録され、同じ枠に2件割り当てられるのを防ぐ）
  delegate('submitQuickRegister', (el) => withSubmitLock(el, () =>
    submitQuickRegister({ slot_role_id: Number(el.dataset.slotRoleId) || null }, false, el.dataset.requestKey)))
  window.submitQuickRegister = async function (ctx, force, requestKey) {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
    const type = v('qr-type')
    const body = { name: v('qr-name'), phone: v('qr-phone'), affiliation_type: type, daily_report_mode: v('qr-dr'), memo: v('qr-memo'), trade_name: v('qr-trade'), force: !!force, request_key: requestKey || null }
    if (type === 'partner_manual') { const p = v('qr-partner-id'); if (p && p !== 'new') body.partner_affiliation_id = Number(p); else body.new_partner_name = v('qr-partner-new') }
    if (!body.name) { toast('氏名を入力してください'); return }
    try {
      const { data } = await axios.post('/api/admin/staff-quick', body)
      if (window.invalidateBoardMaster) invalidateBoardMaster()
      if (ctx && ctx.slot_role_id && window.boardAssign) { toast(data.reused ? '登録済みのスタッフを割り当てます' : '仮登録しました'); return boardAssign(ctx.slot_role_id, [data.staff_id]) }
      closeModal(); toast('仮登録しました'); location.hash = 'staff/' + data.staff_id
    } catch (e) {
      const d = e.response && e.response.data
      // 確認のダイアログではなく、その場に登録済みの人を出す（在籍状況の区別と、枠への割り当て。#356 #506）
      if (d && d.need_force) {
        const box = document.getElementById('qr-dup')
        if (box) { box.innerHTML = quickMatchesHtml(d.matches || [], { needForce: true, requestKey }); box.scrollIntoView && box.scrollIntoView({ block: 'nearest' }); return }
        if (confirm(`この電話番号のスタッフが登録済みです（${(d.matches || []).map(m => m.name).join('、')}）。\n別の人として登録しますか？`)) return submitQuickRegister(ctx, true, requestKey)
        return
      }
      toast(errMsg(e))
    }
  }

  // =========================================================
  // スタッフ詳細: 区分・登録状態・提出設定・履歴
  // =========================================================
  window.renderStaffLifecyclePanel = async function (sid, p) {
    const host = document.getElementById('staff-lifecycle-panel'); if (!host) return
    if (p && p.affiliation_type === 'skillsheet_only') { host.innerHTML = ''; return }
    const { data } = await axios.get(`/api/admin/staff/${sid}/lifecycle`)
    const t = data.affiliation_type
    host.innerHTML = `<div class="grid lg:grid-cols-2 gap-4">
      <section class="card p-4" id="staff-lifecycle">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-arrows-rotate text-blue-500 mr-1"></i>区分・登録状態</h3>
          <div class="flex gap-2 flex-wrap justify-end">
            ${data.merged_into_staff_id ? '' : `
            ${data.can_merge ? `<button class="btn btn-outline text-xs" data-action="openMerge" data-id="${Number(sid)}" id="merge-open-btn"><i class="fas fa-code-merge"></i>${data.is_provisional ? '既存のスタッフに統合' : '重複登録を統合'}</button>` : ''}
            ${data.is_provisional ? `<button class="btn btn-primary text-xs" data-action="openFinalize" data-id="${Number(sid)}"><i class="fas fa-user-check"></i>本登録する</button>` : ''}
            <button class="btn btn-outline text-xs" data-action="openAffiliationChange" data-sid="${Number(sid)}" data-from="${esc(t)}"><i class="fas fa-right-left"></i>区分を変更</button>`}
          </div>
        </div>
        <dl class="text-xs space-y-1.5">
          <div class="flex gap-2"><dt class="w-24 text-gray-400">現在の区分</dt><dd class="font-bold">${TYPE_LABEL[t] || t}</dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-400">登録状態</dt><dd>${data.merged_into_staff_id ? `<span class="badge badge-gray">統合済み</span> <a class="text-blue-600 hover:underline" href="#staff/${data.merged_into_staff_id}">${esc(data.merged_into_name || '統合先')}</a>（${esc(String(data.merged_at || '').slice(0, 10))}）` : data.is_provisional ? '<span class="badge badge-red">仮登録</span>' : '<span class="badge badge-green">本登録</span>'}</dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-400">ログイン</dt><dd>${data.has_own_login ? 'あり（' + esc(data.user_code) + '）' : data.has_login ? '所属元の会社のログインから企業を切り替えて利用' : 'なし（報告用URLまたは代理入力で記録）'}
            ${data.can_issue_login ? `<button class="btn btn-outline text-xs ml-1" id="issue-login-btn" data-action="openIssueLogin" data-id="${Number(sid)}"><i class="fas fa-key"></i>ログインを発行</button>` : ''}</dd></div>
          ${window.scheduleLinkRowHtml ? scheduleLinkRowHtml(sid, data) : ''}
          ${t !== 'linked_external' && !data.merged_into_staff_id ? `<div class="flex gap-2"><dt class="w-24 text-gray-400">メール</dt><dd>${data.email ? esc(data.email) : '<span class="text-gray-400">なし</span>'}
            ${data.unverified_email ? `<div class="mt-1" id="unverified-email"><span class="badge badge-yellow">未確認</span> ${esc(data.unverified_email)}
              <span class="block text-[11px] text-gray-400">応募フォームなどで入力された、本人確認をしていないメールです。ログイン・パスワード再設定・お知らせには使いません</span>
              <button class="btn btn-outline text-xs mt-1" data-action="confirmUnverifiedEmail" data-id="${Number(sid)}" data-email="${esc(data.unverified_email)}" data-current="${esc(data.email || '')}">本人に確認したので設定する</button>
              <button class="btn btn-outline text-xs mt-1" data-action="discardUnverifiedEmail" data-id="${Number(sid)}">消す</button></div>` : ''}</dd></div>` : ''}
          ${data.employee_record && data.employee_record.employment_ended_at ? `<div class="flex gap-2"><dt class="w-24 text-gray-400">従業員管理</dt><dd>雇用終了 ${esc(data.employee_record.employment_ended_at)}（閲覧のみで保持） <a class="text-blue-600 hover:underline" href="#employees/${sid}">開く</a></dd></div>` : ''}
        </dl>
        ${(data.schedules || []).map(s => s.status === 'pending'
          ? `<div class="text-xs bg-blue-50 text-blue-900 rounded-lg p-2 mt-3 flex items-center gap-2 flex-wrap" id="aff-schedule"><i class="fas fa-clock"></i>
              <span class="flex-1"><b>${esc(s.effective_date)}</b> から「${esc(TYPE_LABEL[s.to_type] || s.to_type)}${s.to_affiliation ? '（' + esc(s.to_affiliation) + '）' : ''}」に変更する予約があります</span>
              <button class="btn btn-outline text-xs" data-action="cancelAffiliationSchedule" data-sid="${Number(sid)}" data-id="${Number(s.schedule_id)}">予約を取り消す</button></div>`
          : `<div class="text-xs bg-amber-50 text-amber-800 rounded-lg p-2 mt-3 flex items-center gap-2 flex-wrap"><i class="fas fa-triangle-exclamation"></i>
              <span class="flex-1">${esc(s.effective_date)} からの「${esc(TYPE_LABEL[s.to_type] || s.to_type)}」への変更の予約は適用できませんでした: ${esc(s.error || '')}</span>
              <button class="btn btn-outline text-xs" data-action="cancelAffiliationSchedule" data-sid="${Number(sid)}" data-id="${Number(s.schedule_id)}" data-failed="1">確認した（表示を消す）</button></div>`).join('')}
        <p class="text-xs font-bold text-gray-600 mt-3 mb-1">変更履歴</p>
        <div class="space-y-1 max-h-40 overflow-y-auto">${data.history.map(h => `<div class="text-[11px] bg-gray-50 rounded p-1.5">
          <b>${esc(h.effective_date)}</b> ${h.from_type === 'new' ? '登録' : esc(TYPE_LABEL[h.from_type] || h.from_type) + ' → '}<b>${esc(TYPE_LABEL[h.to_type] || h.to_type)}</b>
          ${h.to_affiliation ? `（${esc(h.to_affiliation)}）` : ''}${h.affected_shifts ? ` ・予定シフト${Number(h.affected_shifts)}件を置き換え` : ''}${h.excluded_shifts ? `（勤務済み${Number(h.excluded_shifts)}件は対象外）` : ''}${h.note ? ` ・${esc(h.note)}` : ''}
          <span class="text-gray-400">${esc(h.changed_by_name || '')}</span></div>`).join('') || '<p class="text-[11px] text-gray-400">履歴はありません</p>'}</div>
        ${(data.employment_periods || []).length ? `<p class="text-xs font-bold text-gray-600 mt-3 mb-1">過去の雇用期間</p>
        <div class="space-y-1" id="employment-periods">${data.employment_periods.map(e => `<div class="text-[11px] bg-gray-50 rounded p-1.5">
          入社 <b>${esc(e.hire_date || '未登録')}</b> 〜 雇用終了 <b>${esc(e.employment_ended_at || '未登録')}</b>${e.ended_reason ? `（${esc(e.ended_reason)}）` : ''}${e.contract_type ? ` ・${esc(e.contract_type)}` : ''}</div>`).join('')}</div>` : ''}
      </section>
      <section class="card p-4" id="staff-report-settings">
        <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-clipboard-check text-blue-500 mr-1"></i>日報の提出設定</h3>
        <p class="text-[11px] text-gray-400 mb-2">案件の初期値 → スタッフ → シフトの順に上書きします。勤怠報告（8 種類）は${reportSettingsLink()}で案件ごとに設定します（下の一覧から、このスタッフの全案件をまとめて設定できます）</p>
        <label class="text-xs text-gray-600 block">日報<select id="sl-dr" class="inp text-sm">${opts(DR_LABEL, data.daily_report_mode || '')}</select></label>
        <button class="btn btn-outline w-full text-xs mt-2" onclick="saveStaffReportSettings(${sid})">保存する</button>
        <div id="staff-attendance-report-summary" class="mt-3"></div>
      </section>
    </div>`
    // 案件ごとの勤怠報告の要約（report-settings.js。#413）
    if (window.renderStaffReportSummary) renderStaffReportSummary(sid)
    renderHostStatusPanel(sid, p)
  }
  // =========================================================
  // 他社連携のスタッフ: 稼働先での取引状況（#249）と所属元での退職（#187）
  // 所属元のユーザー状態・退職日は変えない。取引終了・所属元で退職の人はシフトの割当候補から外れる
  // =========================================================
  const HOST_STATUS_LABEL = { working: '稼働中', leave: '休止中', ended: '取引終了' }
  function renderHostStatusPanel(sid, p) {
    const host = document.getElementById('staff-lifecycle-panel')
    if (!host || !p || p.affiliation_type !== 'linked_external' || p.merged_into_staff_id) return
    const cur = p.link_ended_at ? 'ended' : p.employment_status === 'leave' ? 'leave' : 'working'
    host.insertAdjacentHTML('afterbegin', `<section class="card p-4 mb-4" id="staff-host-status">
      <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-handshake text-blue-500 mr-1"></i>自社での取引状況</h3>
      ${p.source_retired ? '<div class="text-xs bg-red-50 text-red-700 rounded-lg p-2 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>所属元で退職（または利用停止）になっています。シフトの割当候補には出ません</div>' : ''}
      <div class="flex gap-2 flex-wrap items-center">
        <select id="host-status" class="inp text-sm w-40">${opts(HOST_STATUS_LABEL, cur)}</select>
        <button class="btn btn-outline text-xs" data-action="saveHostStatus" data-sid="${Number(sid)}">保存する</button>
        ${p.link_ended_at ? `<span class="text-xs text-gray-500">取引終了 ${esc(String(p.link_ended_at).slice(0, 10))}</span>` : ''}
      </div>
      <p class="text-[11px] text-gray-400 mt-1">「取引終了」にすると、自社のシフトの割当候補から外れます（所属元の登録内容・ログインは変わりません）。「休止中」は割り当てるときに警告を出します</p>
    </section>`)
  }
  delegate('saveHostStatus', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.sid), status = document.getElementById('host-status').value
    if (status === 'ended' && !confirm('取引終了にしますか？\n自社のシフトの割当候補から外れます（登録済みのシフトはそのまま残ります）')) return
    try {
      await axios.put(`/api/admin/roster/${sid}/host-status`, { status })
      toast('取引状況を保存しました'); if (window.invalidateBoardMaster) invalidateBoardMaster(); renderStaffDetail(sid)
    } catch (e) { toast(errMsg(e)) }
  }))
  // =========================================================
  // 仮登録スタッフの統合（第5段階。src/staff-merge.ts）
  // =========================================================
  window.openMerge = async function (sid, q) {
    let d; try { d = (await axios.get(`/api/admin/staff/${sid}/merge-candidates` + (q ? '?q=' + encodeURIComponent(q) : ''))).data } catch (e) { return toast(errMsg(e)) }
    modal(`
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-code-merge text-blue-600 mr-1"></i>${d.source.is_provisional ? '既存のスタッフに統合' : '重複登録を統合'}</h3>
      <p class="text-xs text-gray-500 mb-3">${d.source.is_provisional
        ? `仮登録の「${esc(d.source.name)}」が、すでに登録のある人（他社から連携したスタッフなど）と同じ人の場合に使います。シフト・勤怠・日報・評価などを統合先に移します`
        : `「${esc(d.source.name)}」を誤って二重に登録したときに、同じ区分（${esc(TYPE_LABEL[d.source.affiliation_type] || '')}）の登録済みのスタッフにまとめます。この人は統合済みとして残り、一覧から外れます`}</p>
      <div class="flex gap-2 mb-2"><input id="mg-q" class="inp text-sm flex-1" placeholder="氏名・フリガナで探す" value="${esc(q || '')}">
        <button class="btn btn-outline text-xs" data-action="mergeSearch" data-id="${Number(sid)}"><i class="fas fa-magnifying-glass"></i></button></div>
      <div class="space-y-1.5 max-h-72 overflow-y-auto" id="merge-candidates">
        ${d.candidates.map(r => `<button class="w-full text-left p-2.5 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50" data-action="previewMerge" data-id="${Number(sid)}" data-target="${Number(r.staff_id)}">
          <div class="flex items-center justify-between gap-2"><p class="font-bold text-sm">${esc(r.name)} <span class="text-xs font-normal text-gray-400">${esc(r.kana || '')}</span>${r.inactive ? ` <span class="badge badge-red">${esc(r.inactive)}</span>` : ''}</p>
            <span class="badge ${r.affiliation_type === 'linked_external' ? 'badge-blue' : 'badge-gray'}">${esc(TYPE_LABEL[r.affiliation_type] || r.affiliation_type)}${r.affiliation_type === 'linked_external' && r.owner_company_name ? '・' + esc(r.owner_company_name) : ''}</span></div>
          <p class="text-[11px] text-gray-500">${r.reasons.map(x => `<span class="text-emerald-700">${esc(x)}</span>`).join('・') || '検索に一致'}${r.global_staff_code ? '・ID ' + esc(r.global_staff_code) : ''}・稼働 ${r.shift_count}件${r.last_work_date ? '（最終 ' + esc(r.last_work_date) + '）' : ''}${r.is_provisional ? '・<span class="text-red-600">仮登録</span>' : ''}</p>
        </button>`).join('') || '<p class="text-xs text-gray-400 p-3 text-center">候補が見つかりません。氏名で検索するか、他社のスタッフなら先に「スタッフマスタ → 新規追加 → QR/ID連携」で連携してください</p>'}
      </div>
      <button class="btn btn-outline w-full mt-3" onclick="closeModal()">閉じる</button>`)
    const qEl = document.getElementById('mg-q')
    if (qEl) qEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openMerge(sid, qEl.value) })
  }
  delegate('openMerge', (el) => openMerge(Number(el.dataset.id)))
  delegate('mergeSearch', (el) => { const q = document.getElementById('mg-q'); openMerge(Number(el.dataset.id), q ? q.value : '') })
  delegate('previewMerge', (el) => previewMerge(Number(el.dataset.id), Number(el.dataset.target)))
  delegate('openFinalize', (el) => openFinalize(Number(el.dataset.id)))
  window.previewMerge = async function (sid, targetId) {
    let d; try { d = (await axios.post(`/api/admin/staff/${sid}/merge`, { target_staff_id: targetId, dry_run: true })).data } catch (e) { return toast(errMsg(e)) }
    modal(`
      <h3 class="font-bold text-lg mb-2">統合の確認</h3>
      <div class="flex items-center gap-2 text-sm mb-3" id="merge-preview">
        <div class="flex-1 p-2 rounded-lg bg-red-50"><p class="text-[11px] text-gray-500">統合元${d.source.is_provisional ? '（仮登録）' : ''}</p><p class="font-bold">${esc(d.source.name)}</p><p class="text-[11px]">${esc(d.source.type_label)}</p></div>
        <i class="fas fa-arrow-right text-gray-400"></i>
        <div class="flex-1 p-2 rounded-lg bg-blue-50"><p class="text-[11px] text-gray-500">統合先</p><p class="font-bold">${esc(d.target.name)}</p><p class="text-[11px]">${esc(d.target.type_label)}${d.target.owner_company_name && d.target.type === 'linked_external' ? '・' + esc(d.target.owner_company_name) : ''}</p></div>
      </div>
      <ul class="text-xs space-y-1 mb-3 list-disc pl-4">${d.effects.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${d.warnings.length ? `<div class="text-xs bg-amber-50 text-amber-800 rounded p-2 mb-3" id="merge-warnings"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>確認してください</p>${d.warnings.map(x => `<p>・${esc(x)}</p>`).join('')}</div>` : ''}
      <label class="block text-xs text-gray-600 mb-3">メモ（任意）<input id="mg-note" class="inp text-sm" maxlength="300" placeholder="例: 募集から応募した山田さんは〇〇社の連携スタッフと同一人物"></label>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" data-action="openMerge" data-id="${Number(sid)}">戻る</button>
        <button class="btn btn-danger flex-1" data-action="runMerge" data-id="${Number(sid)}" data-target="${Number(targetId)}" data-force="${d.warnings.length ? '1' : ''}">${d.warnings.length ? '確認のうえ統合する' : '統合する'}</button>
      </div>`)
  }
  // 統合の実行（二度押しで2回送らないように送信ロックをかける）
  delegate('runMerge', (el) => {
    if (el.dataset.busy === '1' || !confirm('統合は元に戻せません。統合しますか？')) return
    withSubmitLock(el, async () => {
      try {
        const { data } = await axios.post(`/api/admin/staff/${Number(el.dataset.id)}/merge`, { target_staff_id: Number(el.dataset.target), force: el.dataset.force === '1', note: document.getElementById('mg-note').value })
        closeModal(); toast(`統合しました（シフト${data.moved.shifts}件を移動）`)
        if (window.invalidateBoardMaster) window.invalidateBoardMaster()
        location.hash = 'staff/' + data.target_staff_id
      } catch (e) { toast(errMsg(e)) }
    })
  })

  window.saveStaffReportSettings = async function (sid) {
    try { await axios.put(`/api/admin/staff/${sid}/report-settings`, { daily_report_mode: document.getElementById('sl-dr').value }); toast('提出設定を保存しました') } catch (e) { toast(errMsg(e)) }
  }

  // ---------- 本登録 ----------
  // ログインの入力欄（本登録・後からの発行で共用）。メール欄には今のログイン用のメールを入れ、
  // 応募フォームなどの未確認のメールは初期値に入れず、管理者が本人に確認して選んだときだけ使う（#148）
  const GENDER_LABEL = { male: '男性', female: '女性', other: 'その他', unspecified: '回答しない' }
  // スタッフ番号の欄には、空いている番号（#424）を例として出す。初期パスワードだけ入れたときはその番号を使う
  const loginFieldsHtml = (d, px, next) => `
    <div class="grid grid-cols-2 gap-3">
      <input id="${px}-code" class="inp text-sm" placeholder="${esc(next ? 'スタッフ番号（空いている番号: ' + next.code + '）' : 'スタッフ番号')}" data-suggested="${esc(next ? next.code : '')}" maxlength="50"><input id="${px}-pass" class="inp text-sm" placeholder="初期パスワード（8文字以上）" autocomplete="new-password">
      ${next && next.last_code ? `<p class="col-span-2 text-[11px] text-gray-400 -mt-2">スタッフ番号を空欄にすると ${esc(next.code)} を使います（最後の番号: ${esc(next.last_code)}）</p>` : ''}
      <label class="text-xs text-gray-600 col-span-2">メール（ログイン・パスワード再設定の宛先。任意）<input id="${px}-email" class="inp text-sm" type="email" maxlength="254" value="${esc(d.email || '')}" placeholder="メール（任意）"></label>
      ${d.unverified_email ? `<label class="col-span-2 flex items-start gap-2 text-xs p-2 rounded bg-amber-50 text-amber-800"><input type="checkbox" id="${px}-use-unverified" class="mt-0.5">
        <span>応募時などに入力されたメール <b>${esc(d.unverified_email)}</b>（未確認）を使う。本人のものと確認できた場合だけ選んでください</span></label>` : ''}
    </div>`
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  const loginBody = (px) => {
    const codeEl = document.getElementById(px + '-code')
    let code = val(px + '-code')
    if (!code && val(px + '-pass') && codeEl && codeEl.dataset.suggested) { code = codeEl.dataset.suggested; codeEl.value = code }
    const body = { user_code: code, password: val(px + '-pass'), email: val(px + '-email') }
    const use = document.getElementById(px + '-use-unverified')
    if (use && use.checked) { body.use_unverified_email = true; delete body.email }
    return body
  }
  const fetchNextCode = async () => { try { return (await axios.get('/api/admin/roster/next-code')).data } catch { return null } }
  // スタッフ番号が使われていたとき（409）、空いている番号を入れ直す（#424）
  const applySuggestedCode = (px, e) => {
    const d = e && e.response && e.response.data
    const el = document.getElementById(px + '-code')
    if (!d || !d.suggested_code || !el) return false
    el.value = d.suggested_code; el.dataset.suggested = d.suggested_code
    toast(`スタッフ番号が使われています。空いている番号（${d.suggested_code}）を入れました`)
    return true
  }

  // ---------- 本登録 ----------
  // 今のフリガナ・性別・メールを入力欄に入れて開く（空欄のまま本登録しても応募時のフリガナを消さない。#505）
  // 企業が必須にした項目（#251）も、今の値を入れて出す（本登録の時点でそろえる）
  const REQ_INPUT = {
    date_of_birth: 'type="date"', available_from: 'type="date"', commute_minutes: 'type="number" min="0" max="1440" step="1"',
    phone: 'type="tel" inputmode="tel"',
  }
  const requiredFieldHtml = (f) => f.code === 'career'
    ? `<label class="text-sm text-gray-600 col-span-2">${esc(f.label)} <span class="text-red-500">*</span><textarea class="inp fz-req" data-code="career" rows="2">${esc(f.value || '')}</textarea></label>`
    : `<label class="text-sm text-gray-600">${esc(f.label)} <span class="text-red-500">*</span><input class="inp fz-req" data-code="${esc(f.code)}" ${REQ_INPUT[f.code] || ''} value="${esc(f.value ?? '')}"></label>`
  window.openFinalize = async function (sid) {
    let d; try { d = (await axios.get(`/api/admin/staff/${Number(sid)}/lifecycle`)).data } catch (e) { return toast(errMsg(e)) }
    const next = await fetchNextCode()
    // フリガナは上の欄で入れる。メールはログインを発行するときだけ必要（ログインの欄で入れる）
    const req = (d.required_fields || []).filter(f => f.code !== 'kana' && f.code !== 'email')
    const kanaReq = (d.required_fields || []).some(f => f.code === 'kana')
    const emailReq = (d.required_fields || []).some(f => f.code === 'email')
    modal(`<h3 class="font-bold text-lg mb-1">本登録</h3>
      <p class="text-xs text-gray-500 mb-3">性別などの必須項目を入力し、仮登録を解除します。ログインの発行は任意です（発行しない場合は報告用URLまたは代理入力で記録します）</p>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">性別 <span class="text-red-500">*</span><select id="fz-gender" class="inp"><option value="">選択してください</option>${Object.entries(GENDER_LABEL).map(([k, l]) => `<option value="${k}" ${d.gender === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="text-sm text-gray-600">フリガナ${kanaReq ? ' <span class="text-red-500">*</span>' : ''}<input id="fz-kana" class="inp" maxlength="60" value="${esc(d.kana || '')}"></label>
          ${req.map(requiredFieldHtml).join('')}
        </div>
        ${req.length ? '<p class="text-[11px] text-gray-400 -mt-1">* の項目は、会社の設定で必須になっています</p>' : ''}
        ${d.unverified_email ? `<p class="text-[11px] text-amber-700"><i class="fas fa-circle-info mr-1"></i>応募時のメール ${esc(d.unverified_email)} は未確認のため、ログイン・パスワード再設定には使っていません</p>` : ''}
        <details class="p-3 rounded-lg border border-gray-200"><summary class="text-sm text-gray-600 cursor-pointer">ログインを発行する（任意）</summary>
          <div class="mt-3">${loginFieldsHtml(d, 'fz', next)}${emailReq ? '<p class="text-[11px] text-red-600 mt-1">ログインを発行する場合、メールは必須です（会社の設定）</p>' : ''}</div></details>
        <p class="text-[11px] text-gray-400">${req.length || kanaReq ? 'そのほかの項目' : 'その他の項目（生年月日・スキル等）'}は本登録後に基本情報欄で入力できます</p>
        <button class="btn btn-primary w-full" data-action="submitFinalize" data-id="${Number(sid)}">本登録する</button>
      </div>`)
  }
  delegate('submitFinalize', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.id)
    const body = { gender: val('fz-gender'), kana: val('fz-kana') }
    const lacks = []
    document.querySelectorAll('.fz-req').forEach(x => {
      body[x.dataset.code] = x.value.trim()
      if (!x.value.trim()) lacks.push(x.parentElement.firstChild.textContent.trim())
    })
    if (lacks.length) { toast('次の項目は必須です: ' + lacks.join('・')); return }
    // ログインの欄に入力があるときだけ、ログインの発行とメールを送る
    if (val('fz-code') || val('fz-pass')) Object.assign(body, loginBody('fz'))
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/finalize`, body)
      closeModal(); toast('本登録しました'); renderStaffDetail(sid)
      if (data.login) showLoginGuide(data.login)
    } catch (e) { if (!applySuggestedCode('fz', e)) toast(errMsg(e)) }
  }))

  // ---------- ログインの発行（仮登録ではない、ログインのないスタッフ。#89） ----------
  delegate('openIssueLogin', async (el) => {
    const sid = Number(el.dataset.id)
    let d; try { d = (await axios.get(`/api/admin/staff/${sid}/lifecycle`)).data } catch (e) { return toast(errMsg(e)) }
    modal(`<h3 class="font-bold text-lg mb-1">ログインを発行</h3>
      <p class="text-xs text-gray-500 mb-3">スタッフ番号と初期パスワードを設定し、スタッフ用のアプリでシフトの確認・勤怠報告ができるようにします。初期パスワードは本人に伝えてください</p>
      <div class="space-y-3">${loginFieldsHtml(d, 'il', await fetchNextCode())}
        <button class="btn btn-primary w-full" data-action="submitIssueLogin" data-id="${sid}">ログインを発行する</button></div>`)
  })
  delegate('submitIssueLogin', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.id)
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/issue-login`, loginBody('il'))
      closeModal(); toast('ログインを発行しました'); renderStaffDetail(sid)
      if (data.login) showLoginGuide(data.login)
    } catch (e) { if (!applySuggestedCode('il', e)) toast(errMsg(e)) }
  }))

  // ---------- ログイン案内（#328）。本人に SMS・LINE などで送れるよう、URL・会社コード・スタッフ番号・初期パスワードをまとめてコピーできるようにする ----------
  window.showLoginGuide = function (g) {
    const text = [
      `【Field OS ログインのご案内】${g.company_name ? '（' + g.company_name + '）' : ''}`,
      `ログインURL: ${g.login_url}`,
      `会社コード: ${g.company_code}`,
      `スタッフ番号: ${g.user_code}`,
      g.password ? `初期パスワード: ${g.password}` : '',
      '※ 初回のログインで、ご自身のパスワードへの変更をお願いします。',
      '※ ログインの後に「ホーム画面に追加」すると、次から1回で開けます。',
    ].filter(Boolean).join('\n')
    modal(`<h3 class="font-bold text-lg mb-1"><i class="fas fa-paper-plane text-blue-600 mr-1"></i>ログイン案内</h3>
      <p class="text-xs text-gray-500 mb-2">コピーして、SMS・LINE などで本人に送ってください。初期パスワードは、この画面を閉じると二度と表示できません。</p>
      <textarea id="login-guide-text" class="inp font-mono text-sm" rows="8" readonly>${esc(text)}</textarea>
      <div class="flex gap-2 mt-3">
        <button class="btn btn-outline flex-1" data-action="copyLoginGuide"><i class="fas fa-copy"></i>コピー</button>
        <button class="btn btn-primary flex-1" onclick="closeModal()">閉じる</button>
      </div>`)
  }
  delegate('copyLoginGuide', async () => {
    const el = document.getElementById('login-guide-text'); if (!el) return
    try { await navigator.clipboard.writeText(el.value) } catch { el.select(); document.execCommand && document.execCommand('copy') }
    toast('コピーしました')
  })

  // ---------- 未確認のメール（本人に確認したら設定する／不要なら消す。#38 #148） ----------
  delegate('confirmUnverifiedEmail', (el) => {
    const cur = el.dataset.current
    if (!confirm(`${cur ? `今のメール（${cur}）を ` : ''}${el.dataset.email} ${cur ? 'に置き換えます' : 'をログイン・パスワード再設定の宛先に設定します'}。\n本人のメールアドレスであることを確認しましたか？`)) return
    withSubmitLock(el, async () => {
      try {
        await axios.post(`/api/admin/staff/${Number(el.dataset.id)}/unverified-email`, { action: 'confirm' })
        toast('メールアドレスを設定しました'); renderStaffDetail(Number(el.dataset.id))
      } catch (e) { toast(errMsg(e)) }
    })
  })
  delegate('discardUnverifiedEmail', (el) => {
    if (!confirm('未確認のメールアドレスを消します。よろしいですか？')) return
    withSubmitLock(el, async () => {
      try {
        await axios.post(`/api/admin/staff/${Number(el.dataset.id)}/unverified-email`, { action: 'discard' })
        toast('未確認のメールアドレスを消しました'); renderStaffDetail(Number(el.dataset.id))
      } catch (e) { toast(errMsg(e)) }
    })
  })

  // ---------- 区分の変更（確認画面で影響を表示してから実行） ----------
  // 確認した後に入力（区分・適用日・取引先・入社日・屋号・雇用形態）を変えたら、確認結果と実行ボタンを消して確認し直してもらう。
  // 実行のときは確認で受け取った preview_token を送り、サーバーで内容が同じことを確かめる（#100）
  window.openAffiliationChange = async function (sid, from) {
    let partners = []
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners } catch { }
    const targets = ['own_employee', 'daily_worker', 'freelance', 'partner_manual'].filter(k => k !== from || k === 'partner_manual')
    modal(`<h3 class="font-bold text-lg mb-1">区分を変更</h3>
      <p class="text-xs text-gray-500 mb-3">現在: <b>${esc(TYPE_LABEL[from] || from)}</b>。スタッフIDは変わらず、シフト・勤怠・評価・メモの履歴はそのまま引き継がれます</p>
      <div class="space-y-3" id="ac-form" data-sid="${Number(sid)}">
        <div class="space-y-1.5">${targets.map((k, i) => `<label class="flex items-start gap-2 p-2 rounded-lg border border-gray-200 cursor-pointer has-[:checked]:border-blue-400 has-[:checked]:bg-blue-50">
          <input type="radio" name="ac-type" value="${k}" ${i === 0 ? 'checked' : ''} class="mt-1"><span><b class="text-sm">${TYPE_LABEL[k]}</b><span class="block text-[11px] text-gray-500">${TYPE_DESC[k]}</span></span></label>`).join('')}</div>
        <div id="ac-partner" class="hidden p-3 rounded-lg bg-purple-50 space-y-2">
          <select id="ac-partner-id" class="inp text-sm">
            ${partners.map(p => `<option value="${Number(p.affiliation_id)}">${esc(p.affiliation_name)}</option>`).join('')}<option value="new" ${partners.length ? '' : 'selected'}>＋ 新しい取引先</option></select>
          <input id="ac-partner-new" class="inp text-sm ${partners.length ? 'hidden' : ''}" placeholder="取引先名">
        </div>
        <input id="ac-trade" class="inp text-sm hidden" placeholder="屋号（任意）">
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">適用日 *<input id="ac-date" type="date" class="inp" value="${dayjs().format('YYYY-MM-DD')}"></label>
          <div id="ac-emp" class="hidden"><label class="text-sm text-gray-600">入社日<input id="ac-hire" type="date" class="inp"></label>
            <p class="text-[11px] text-gray-400">空欄なら適用日を入社日にします</p></div>
        </div>
        <p class="text-[11px] text-gray-400">適用日が明日以降なら予約になり、適用日の早朝に切り替わります（それまでは今の区分のままです）</p>
        <input id="ac-contract" class="inp text-sm hidden" placeholder="雇用形態（正社員 / アルバイト / パート 等）">
        <input id="ac-note" class="inp text-sm" placeholder="メモ（任意）">
        <div id="ac-preview"></div>
        <button id="ac-check" class="btn btn-outline w-full" data-action="previewAffiliationChange" data-sid="${Number(sid)}">影響を確認する</button>
      </div>`)
    const form = document.getElementById('ac-form')
    // メモ以外の入力が変わったら確認をやり直す
    const onEdit = (e) => {
      if (e.target && e.target.id === 'ac-note') return
      if (e.target && e.target.id === 'ac-partner-id') document.getElementById('ac-partner-new').classList.toggle('hidden', e.target.value !== 'new')
      acTypeChanged()
    }
    form.addEventListener('input', onEdit)
    form.addEventListener('change', onEdit)
    acTypeChanged()
  }
  delegate('openAffiliationChange', (el) => openAffiliationChange(Number(el.dataset.sid), el.dataset.from))
  window.acTypeChanged = function () {
    const t = (document.querySelector('input[name=ac-type]:checked') || {}).value
    document.getElementById('ac-partner').classList.toggle('hidden', t !== 'partner_manual')
    document.getElementById('ac-trade').classList.toggle('hidden', t !== 'freelance')
    document.getElementById('ac-emp').classList.toggle('hidden', t !== 'own_employee')
    document.getElementById('ac-contract').classList.toggle('hidden', t !== 'own_employee')
    document.getElementById('ac-preview').innerHTML = ''
    const chk = document.getElementById('ac-check'); if (chk) chk.classList.remove('hidden')
  }
  function acBody() {
    const v = (id) => { const el = document.getElementById(id); return el && !el.closest('.hidden') ? el.value.trim() : '' }
    const t = (document.querySelector('input[name=ac-type]:checked') || {}).value
    const b = { to_type: t, effective_date: v('ac-date'), trade_name: v('ac-trade'), hire_date: v('ac-hire'), contract_type: v('ac-contract'), note: v('ac-note') }
    if (t === 'partner_manual') { const p = v('ac-partner-id'); if (p && p !== 'new') b.partner_affiliation_id = Number(p); else b.new_partner_name = v('ac-partner-new') }
    return b
  }
  delegate('previewAffiliationChange', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.sid)
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/affiliation-change`, { ...acBody(), dry_run: true })
      document.getElementById('ac-preview').innerHTML = `<div class="p-3 rounded-lg bg-blue-50 text-xs text-blue-900" id="ac-effects">
        <p class="font-bold mb-1">${esc(data.effective_date)} から「${esc(data.from_label)}」→「${esc(data.to_label)}${data.affiliation ? '（' + esc(data.affiliation) + '）' : ''}」${data.scheduled ? ' <span class="badge badge-blue">予約</span>' : ''}</p>
        <ul class="list-disc ml-4 space-y-0.5">${data.effects.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        ${(data.warnings || []).length ? `<div class="text-xs bg-amber-50 text-amber-800 rounded-lg p-2 mt-2" id="ac-warnings"><i class="fas fa-triangle-exclamation mr-1"></i>${data.warnings.map(x => esc(x)).join('<br>')}</div>` : ''}
        <button class="btn btn-primary w-full mt-3" id="ac-apply" data-action="applyAffiliationChange" data-sid="${sid}" data-token="${esc(data.preview_token)}" data-scheduled="${data.scheduled ? '1' : ''}">${data.scheduled ? 'この内容で予約する' : 'この内容で変更する'}</button>`
      el.classList.add('hidden')
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('applyAffiliationChange', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.sid)
    if (document.getElementById('ac-warnings') && !confirm('確認事項があります。この内容で実行しますか？')) return
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/affiliation-change`, { ...acBody(), preview_token: el.dataset.token })
      closeModal()
      toast(data.scheduled ? `${data.effective_date} に区分を変更する予約をしました` : `区分を変更しました（予定シフト${data.affected_shifts}件を置き換え）`)
      if (window.invalidateBoardMaster) invalidateBoardMaster(); renderStaffDetail(sid)
    } catch (e) {
      toast(errMsg(e))
      // 確認したときから内容が変わった: 確認からやり直す
      if (e.response && e.response.data && e.response.data.preview_changed) acTypeChanged()
    }
  }))
  // 区分変更の予約の取消
  delegate('cancelAffiliationSchedule', (el) => withSubmitLock(el, async () => {
    const failed = !!el.dataset.failed
    if (!failed && !confirm('区分変更の予約を取り消しますか？')) return
    const sid = Number(el.dataset.sid)
    try {
      await axios.delete(`/api/admin/staff/${sid}/affiliation-schedules/${Number(el.dataset.id)}`)
      toast(failed ? '表示を消しました' : '予約を取り消しました'); renderStaffDetail(sid)
    } catch (e) { toast(errMsg(e)) }
  }))

  // =========================================================
  // シフト詳細（シフトボード）: 報告状況・報告用URL・代理入力・提出設定
  // =========================================================
  window.renderShiftReportPanel = async function (shiftId) {
    const host = document.getElementById('shift-report-panel'); if (!host) return
    let d; try { d = (await axios.get(`/api/admin/shifts/${shiftId}/report-status`)).data } catch { host.innerHTML = ''; return }
    reportStatusCache[shiftId] = d
    const done = new Map(d.reports.map(r => [r.report_type, r]))
    const pending = d.modes.required_attendance.some(t => !done.has(t))
    const url = d.token ? location.origin + '/r/' + d.token.token : ''
    const phone = String(d.staff_phone || '').replace(/[^\d+]/g, '')
    // 取り消せる代理入力（確定済みのシフト・打刻修正で直した報告は取り消せない。#322）
    const cancellable = d.settled ? [] : d.reports.filter(r => r.entry_method === 'proxy' && !r.corrected_by_correction_id)
    host.innerHTML = `<div class="rounded-lg border border-gray-100 p-3 text-xs space-y-2" id="shift-report-box">
      <div class="flex items-center justify-between"><p class="font-bold text-gray-700"><i class="fas fa-clipboard-check mr-1"></i>勤怠・日報</p>
        <span class="text-gray-400">${d.login_via_owner ? '所属元のアカウントで報告' : d.has_login ? 'アプリで報告' : 'ログインなし'}</span></div>
      <div class="flex flex-wrap gap-1">
        ${d.modes.required_attendance.map(t => { const r = done.get(t); return `<span class="badge ${r ? (r.no_photo_reason || r.photo_stale ? 'badge-yellow' : 'badge-green') : 'badge-gray'}" title="${r ? esc(ENTRY_LABEL[r.entry_method] || '') + (r.entered_by_name ? '（' + esc(r.entered_by_name) + '）' : '') + (r.device ? ' ・' + esc(r.device) : '') + correctedNote(r, d.work_date) : '未報告'}">${RT_LABEL[t]} ${r ? atLabel(r.reported_at, d.work_date) : '未'}${r && r.entry_method === 'proxy' ? '・代理' : r && r.entry_method === 'link' ? '・URL' : ''}${r && (r.corrected_by_correction_id || r.entry_method === 'correction') ? '・修正' : ''}${r && r.no_photo_reason ? '・写真なし' : ''}</span>` }).join('') || '<span class="text-gray-400">勤怠報告なし</span>'}
        ${d.modes.daily_report_required ? `<span class="badge ${d.daily_report ? 'badge-green' : 'badge-gray'}" title="${d.daily_report ? esc(ENTRY_LABEL[d.daily_report.entry_method] || '') + (d.daily_report.entered_by_name ? '（' + esc(d.daily_report.entered_by_name) + '）' : '') : ''}">日報 ${d.daily_report ? '提出済み' + (d.daily_report.entry_method === 'proxy' ? '・代理' : d.daily_report.entry_method === 'link' ? '・URL' : '') : '未提出'}</span>` : '<span class="badge badge-gray">日報なし</span>'}
      </div>
      ${reportNotesHtml(d)}
      ${cancellable.length ? `<div class="flex flex-wrap items-center gap-1"><span class="text-gray-500">代理入力の取消:</span>${cancellable.map(r => `<button class="btn btn-outline text-[11px] py-0.5 px-2" data-action="cancelProxyAttendance" data-shift-id="${Number(shiftId)}" data-type="${esc(r.report_type)}" title="この代理入力を取り消す"><i class="fas fa-xmark"></i>${esc(RT_LABEL[r.report_type] || r.report_type)} ${esc(atLabel(r.reported_at, d.work_date))}</button>`).join('')}</div>` : ''}
      <div class="grid grid-cols-2 gap-2">
        <label>このシフトの勤怠報告<select id="sr-att" class="inp text-xs" onchange="saveShiftReportSettings(${shiftId})">${opts({ '': '案件報告管理の設定どおり', none: '勤怠報告なし', in_out: '入店・退店のみ' }, d.shift_attendance_mode === 'full' ? '' : (d.shift_attendance_mode || ''))}</select></label>
        <label>このシフトの日報<select id="sr-dr" class="inp text-xs" onchange="saveShiftReportSettings(${shiftId})">${opts({ '': 'スタッフ・案件の設定（' + (DR_LABEL[d.inherited_daily_report_mode || d.modes.daily_report_mode] || '') + '）', none: '日報なし', required: '日報あり' }, d.shift_daily_report_mode || '')}</select></label>
      </div>
      ${d.shift_daily_report_mode && DR_LABEL[d.shift_daily_report_mode] ? `<p class="text-[11px] text-gray-500">日報は、このシフトの例外で「${esc(DR_LABEL[d.shift_daily_report_mode])}」にしています（指定なしに戻すと、スタッフ・案件の設定の「${esc(DR_LABEL[d.inherited_daily_report_mode] || '')}」になります）</p>` : ''}
      <div class="flex flex-wrap gap-1.5">
        ${d.token ? `<input class="inp text-[11px] flex-1 min-w-0" id="sr-url" readonly value="${esc(url)}">
          <button class="btn btn-primary text-xs" data-action="copyReportLink" title="URLだけをコピー"><i class="fas fa-copy"></i>コピー</button>
          <button class="btn btn-outline text-xs" data-action="copyReportGuide" data-shift-id="${Number(shiftId)}" title="日時・現場名・有効期限を添えた案内文をコピー"><i class="fas fa-file-lines"></i>案内文ごとコピー</button>
          <button class="btn btn-outline text-xs" onclick="revokeReportLink(${shiftId})" title="無効にする"><i class="fas fa-ban"></i></button>`
        : `<button class="btn btn-outline text-xs flex-1" onclick="issueReportLink(${shiftId})"><i class="fas fa-link"></i>報告用URLを発行（ログイン不要）</button>`}
        ${pending && !d.proxy_blocked ? `<button class="btn btn-outline text-xs" data-action="openProxyAttendance" data-shift-id="${shiftId}"><i class="fas fa-user-pen"></i>代理入力</button>` : ''}
        ${pending && d.proxy_blocked ? `<span class="text-[11px] text-gray-400 py-1">${esc(d.proxy_blocked)}のシフトは代理入力できません</span>` : ''}
        ${d.modes.daily_report_required && !d.daily_blocked ? `<button class="btn btn-outline text-xs" data-action="openProxyDaily" data-shift-id="${Number(shiftId)}"><i class="fas fa-file-pen"></i>日報を${d.daily_report ? '代理で修正' : '代理入力'}</button>` : ''}
      </div>
      ${!d.has_login ? `<p class="text-[11px] text-gray-500">この日のログインのない人をまとめて:
        <button class="text-blue-600 underline" data-action="openNologinBulk" data-date="${esc(d.work_date)}" data-project-id="${Number(d.project_id) || ''}" data-tab="links">報告用URLを発行</button>・
        <button class="text-blue-600 underline" data-action="openNologinBulk" data-date="${esc(d.work_date)}" data-project-id="${Number(d.project_id) || ''}" data-tab="proxy">予定どおりで代理入力</button></p>` : ''}
      ${d.token ? `<div class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span class="text-gray-500"><i class="fas fa-phone mr-0.5"></i>${phone ? `<a href="tel:${esc(phone)}" class="text-blue-600 underline">${esc(d.staff_phone)}</a>` : '電話番号の登録なし'}</span>
          ${phone ? `<a class="btn btn-outline text-[11px] py-0.5 px-2" href="sms:${esc(phone)}?&body=${esc(encodeURIComponent(reportGuideText(d, url)))}"><i class="fas fa-comment-sms"></i>SMSで送る</a>` : ''}
          ${navigator.share ? `<button class="btn btn-outline text-[11px] py-0.5 px-2" data-action="shareReportGuide" data-shift-id="${Number(shiftId)}"><i class="fas fa-share-nodes"></i>LINEなどで送る</button>` : ''}
        </div>
        <p class="text-[11px] text-gray-400">有効期限: ${dayjs(d.token.expires_at).format('M/D HH:mm')}${d.token.last_used_at ? '・最終アクセス ' + dayjs(d.token.last_used_at).format('M/D HH:mm') : '・未使用'}。SMS・LINEなどで本人に送ってください（送り先の番号を確かめてください）</p>` : ''}
      <div class="flex flex-wrap gap-1.5 pt-2 border-t border-gray-100">
        ${d.proxy_blocked === '欠勤' || d.proxy_blocked === '稼働日より前' ? '' : `<button type="button" class="btn btn-outline text-xs" data-action="corrNew" data-shift-id="${Number(shiftId)}" title="このシフトの打刻の修正・打刻漏れの追加を、管理者として申請します（#393）"><i class="fas fa-user-clock"></i>打刻を修正</button>`}
        <button type="button" class="btn btn-outline text-xs" data-action="opLogShow" data-entity="shift" data-id="${Number(shiftId)}" data-host="shift-op-log-${Number(shiftId)}" title="このシフトの状態・時間・金額・精算の変更を、誰がいつ行ったか（#159）"><i class="fas fa-clock-rotate-left"></i>変更履歴</button>
      </div>
      <div id="shift-op-log-${Number(shiftId)}"></div>
    </div>`
  }
  // 報告の確認事項: 写真なしの報告・撮影日時のずれ・報告用URLの端末（#418 #532 #535）
  const SOURCE_LABEL = { camera: 'カメラで撮影', album: 'アルバムから選択' }
  function reportNotesHtml(d) {
    const notes = []
    for (const r of d.reports) {
      const label = RT_LABEL[r.report_type] || r.report_type
      if (r.no_photo_reason) notes.push(`<i class="fas fa-camera-slash mr-1"></i>${esc(label)}: 写真なしで報告（${esc(r.no_photo_reason)}）`)
      if (r.photo_stale) notes.push(`<i class="fas fa-clock-rotate-left mr-1"></i>${esc(label)}: 写真のファイルの日時（${esc(dayjs(r.photo_taken_at).format('M/D HH:mm'))}${r.photo_source ? '・' + esc(SOURCE_LABEL[r.photo_source] || '') : ''}）が報告の時刻と30分以上ずれています`)
    }
    const ld = d.link_devices || { count: 0, summaries: [] }
    if (ld.count > 1) notes.push(`<i class="fas fa-mobile-screen mr-1"></i>報告用URLが ${Number(ld.count)} 台の端末から使われています${ld.summaries.length ? '（' + esc(ld.summaries.join('、')) + '）' : ''}。本人以外が報告していないか確かめてください`)
    const linkInfo = ld.count === 1 && ld.summaries.length ? `<p class="text-[11px] text-gray-400"><i class="fas fa-mobile-screen mr-1"></i>報告用URLの端末: ${esc(ld.summaries.join('、'))}</p>` : ''
    return (notes.length ? `<div class="rounded bg-amber-50 text-amber-800 p-2 space-y-0.5">${notes.map(n => `<p>${n}</p>`).join('')}</div>` : '') + linkInfo
  }
  // 報告用URLの案内文（会社名・稼働日・時間・案件・場所・有効期限。#441）
  const GUIDE_WD = ['日', '月', '火', '水', '木', '金', '土']
  function reportGuideText(d, url) {
    const x = dayjs(d.work_date)
    const end = d.end_time <= d.start_time ? '翌' + d.end_time : d.end_time
    return `【${d.company_name}】${x.format('M/D')}(${GUIDE_WD[x.day()]}) ${d.start_time}〜${end} ${d.project_name}${d.place ? '（' + d.place + '）' : ''}の勤怠・日報は、こちらのURLから報告してください（${dayjs(d.token.expires_at).format('M/D HH:mm')}まで有効。${d.staff_name}さん専用のURLです）`
      // 本人あての重要なお知らせがあれば、報告用のページで読めることを添える（#281）
      + (d.notice_count ? `\n会社からの重要なお知らせが${Number(d.notice_count)}件あります。URLのページで確認してください` : '')
      + `\n${url}`
  }
  window.reportGuideText = reportGuideText
  window.saveShiftReportSettings = async function (shiftId) {
    try { await axios.put(`/api/admin/shifts/${shiftId}/report-settings`, { attendance_mode: document.getElementById('sr-att').value, daily_report_mode: document.getElementById('sr-dr').value }); toast('このシフトの提出設定を保存しました'); renderShiftReportPanel(shiftId) } catch (e) { toast(errMsg(e)) }
  }
  window.issueReportLink = async function (shiftId) {
    try { await axios.post(`/api/admin/shifts/${shiftId}/report-link`, {}); renderShiftReportPanel(shiftId) } catch (e) { toast(errMsg(e)) }
  }
  window.revokeReportLink = async function (shiftId) {
    if (!confirm('この報告用URLを無効にしますか？')) return
    try { await axios.delete(`/api/admin/shifts/${shiftId}/report-link`); toast('無効にしました'); renderShiftReportPanel(shiftId) } catch (e) { toast(errMsg(e)) }
  }
  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done) } catch {
      // クリップボードが使えない環境: 一時的な入力欄から写す
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select()
      try { document.execCommand && document.execCommand('copy'); toast(done) } catch { toast('コピーできませんでした。URLを長押ししてコピーしてください') }
      ta.remove()
    }
  }
  window.copyReportLink = async function () {
    const el = document.getElementById('sr-url'); if (!el) return
    copyText(el.value, 'URLをコピーしました')
  }
  delegate('copyReportLink', () => copyReportLink())
  delegate('copyReportGuide', (el) => {
    const d = reportStatusCache[Number(el.dataset.shiftId)]; if (!d || !d.token) return
    copyText(reportGuideText(d, location.origin + '/r/' + d.token.token), '案内文をコピーしました')
  })
  // スマホの管理画面から、そのまま LINE などで送る（navigator.share がある端末だけボタンを出す。#441）
  delegate('shareReportGuide', async (el) => {
    const d = reportStatusCache[Number(el.dataset.shiftId)]; if (!d || !d.token || !navigator.share) return
    try { await navigator.share({ text: reportGuideText(d, location.origin + '/r/' + d.token.token) }) } catch { }
  })
  // 代理入力の取消（確認のうえ DELETE を呼び、パネルを描き直す。#322）
  delegate('cancelProxyAttendance', (el) => withSubmitLock(el, async () => {
    const shiftId = Number(el.dataset.shiftId), type = el.dataset.type
    if (!confirm(`${RT_LABEL[type] || type}の代理入力を取り消しますか？\n実績（実働時間）も報告に合わせて計算し直します。`)) return
    try {
      const { data } = await axios.delete(`/api/admin/shifts/${shiftId}/proxy-attendance/${encodeURIComponent(type)}`)
      toast(data.deleted ? '代理入力を取り消しました' : '取り消す代理入力がありませんでした（画面を更新しました）')
      renderShiftReportPanel(shiftId)
    } catch (e) { toast(errMsg(e)) }
  }))
  // 代理入力: 報告状況の最後の取得結果（シフトごと）。既定の時刻・未報告の種類はここから読む
  const reportStatusCache = {}
  // 'YYYY-MM-DD HH:MM:SS' を表示用に（稼働日と違う日付なら M/D を付ける）
  const atLabel = (at, workDate) => at ? (String(at).slice(0, 10) !== workDate ? dayjs(at).format('M/D HH:mm') : dayjs(at).format('HH:mm')) : ''
  // 打刻修正の承認で直した報告の注記（元の打刻の日時。位置・写真は元の打刻のもの。#252）
  const correctedNote = (r, workDate) => r.original_reported_at ? ` ・打刻修正で変更（元: ${esc(atLabel(r.original_reported_at, workDate))}）`
    : (r.corrected_by_correction_id || r.entry_method === 'correction') ? ' ・打刻修正で追加' : ''
  window.openProxyAttendance = function (shiftId) {
    const box = document.getElementById('shift-report-box'); const d = reportStatusCache[shiftId]; if (!box || !d) return
    if (document.getElementById('proxy-form')) return
    const done = new Set(d.reports.map(r => r.report_type))
    const types = d.modes.required_attendance.filter(t => !done.has(t))
    const crosses = d.end_time <= d.start_time
    // 既定のチェックは入店だけ（勤務中に予定どおりの退店まで記録しないように）
    box.insertAdjacentHTML('beforeend', `<div class="p-2 rounded bg-amber-50 space-y-2" id="proxy-form">
      <p class="font-bold text-amber-800">代理入力（管理者が記録します。「代理入力」と表示されます）</p>
      <div class="space-y-1">${types.map(t => { const def = d.proxy_defaults && d.proxy_defaults[t]; return `<label class="flex items-center gap-2 flex-wrap">
        <input type="checkbox" class="px-type" value="${esc(t)}" ${t === 'check_in' ? 'checked' : ''}><span class="w-16">${esc(RT_LABEL[t] || t)}</span>
        <input type="time" class="inp text-xs w-auto px-time" data-type="${esc(t)}">
        <span class="text-gray-400">${def ? '空欄: ' + esc(atLabel(def, d.work_date)) + '（予定）' : '時刻を入力してください'}</span></label>` }).join('')}</div>
      <p class="text-[11px] text-gray-500">実際の時刻を種類ごとに入力します。まだ来ていない時刻は記録できません。${crosses ? '日をまたぐシフトです。翌日の時刻はそのまま入力すると翌日として記録します。' : ''}</p>
      <button class="btn btn-primary text-xs w-full" data-action="submitProxyAttendance" data-shift-id="${shiftId}">記録する</button></div>`)
    // 時刻を入力した種類にはチェックを入れる
    box.querySelectorAll('#proxy-form .px-time').forEach(el => el.addEventListener('input', () => { if (el.value) el.closest('label').querySelector('.px-type').checked = true }))
  }
  window.submitProxyAttendance = async function (shiftId, button) {
    const types = [...document.querySelectorAll('#proxy-form .px-type:checked')].map(el => el.value)
    if (!types.length) { toast('報告の種類を選択してください'); return }
    const times = {}
    document.querySelectorAll('#proxy-form .px-time').forEach(el => { if (types.includes(el.dataset.type) && el.value) times[el.dataset.type] = el.value })
    await withSubmitLock(button, async () => {
      try {
        const { data } = await axios.post(`/api/admin/shifts/${shiftId}/proxy-attendance`, { report_types: types, times })
        const late = (data.reports || []).some(r => r.status === 'late')
        toast(`${data.created}件を代理入力しました${late ? '（入店は遅延として記録）' : ''}`); renderShiftReportPanel(shiftId)
      } catch (e) { toast(errMsg(e)) }
    })
  }
  // 日報の代理入力（#276）: 案件の日報テンプレートの項目で入力する。今の内容があれば初期値にする
  delegate('openProxyDaily', (el) => {
    const shiftId = Number(el.dataset.shiftId)
    const box = document.getElementById('shift-report-box'); const d = reportStatusCache[shiftId]; if (!box || !d) return
    if (document.getElementById('proxy-daily-form')) return
    const cur = (d.daily_report && d.daily_report.values) || {}
    const fields = d.daily_template && d.daily_template.fields && d.daily_template.fields.length ? d.daily_template.fields : [{ key: 'free', label: '報告内容', type: 'textarea' }]
    const fieldHtml = (f) => {
      const v = cur[f.key]
      const label = `${esc(f.label || f.key)}${f.required === true || f.required === 1 || f.required === 'true' ? ' <span class="text-red-500">*</span>' : ''}`
      if (f.type === 'number') return `<label class="flex items-center gap-2"><span class="flex-1">${label}</span><input type="number" min="0" max="99999" step="1" class="inp text-xs w-24 pdr-field" data-key="${esc(f.key)}" data-type="number" value="${esc(v == null ? '' : v)}"></label>`
      if (f.type === 'textarea') return `<label class="block">${label}<textarea rows="2" class="inp text-xs pdr-field" data-key="${esc(f.key)}">${esc(v || '')}</textarea></label>`
      return `<label class="block">${label}<input class="inp text-xs pdr-field" data-key="${esc(f.key)}" value="${esc(v || '')}"></label>`
    }
    box.insertAdjacentHTML('beforeend', `<div class="p-2 rounded bg-amber-50 space-y-2" id="proxy-daily-form">
      <p class="font-bold text-amber-800">日報の代理入力（管理者が記録します。日報の一覧・報告状況に「代理」と表示されます）</p>
      ${d.daily_report && d.daily_report.entry_method !== 'proxy' ? '<p class="text-[11px] text-red-600">本人が提出した日報があります。記録すると上書きします</p>' : ''}
      <div class="space-y-1.5">${fields.map(fieldHtml).join('')}</div>
      <label class="flex items-center gap-2"><input type="checkbox" id="pdr-incident" ${d.daily_report && d.daily_report.incident_flag ? 'checked' : ''}>インシデントがあった</label>
      <textarea rows="2" class="inp text-xs" id="pdr-incident-note" placeholder="インシデントの内容（任意）">${esc(cur.incident_note || '')}</textarea>
      <label class="flex items-center gap-2"><input type="checkbox" id="pdr-complaint" ${d.daily_report && d.daily_report.complaint_flag ? 'checked' : ''}>クレームがあった</label>
      <textarea rows="2" class="inp text-xs" id="pdr-complaint-note" placeholder="クレームの内容（任意）">${esc(cur.complaint_note || '')}</textarea>
      <button class="btn btn-primary text-xs w-full" data-action="submitProxyDaily" data-shift-id="${shiftId}">日報を記録する</button></div>`)
    el.remove()
  })
  delegate('submitProxyDaily', (el) => withSubmitLock(el, async () => {
    const shiftId = Number(el.dataset.shiftId); const d = reportStatusCache[shiftId]
    const values = {}
    document.querySelectorAll('#proxy-daily-form .pdr-field').forEach(f => { values[f.dataset.key] = f.dataset.type === 'number' ? (f.value === '' ? '' : Number(f.value)) : f.value })
    const body = { values, incident_flag: document.getElementById('pdr-incident').checked, complaint_flag: document.getElementById('pdr-complaint').checked,
      incident_note: document.getElementById('pdr-incident-note').value, complaint_note: document.getElementById('pdr-complaint-note').value }
    if (d && d.daily_report && d.daily_report.entry_method !== 'proxy') {
      if (!confirm('本人が提出した日報を、入力した内容で上書きします。よろしいですか？')) return
      body.overwrite = true
    }
    try {
      await axios.post(`/api/admin/shifts/${shiftId}/proxy-daily-report`, body)
      toast('日報を代理入力しました'); renderShiftReportPanel(shiftId)
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('openProxyAttendance', el => { openProxyAttendance(Number(el.dataset.shiftId)); el.remove() })
  delegate('submitProxyAttendance', el => submitProxyAttendance(Number(el.dataset.shiftId), el))

  // =========================================================
  // 案件詳細: 提出設定の初期値
  // =========================================================
  window.renderProjectReportSettings = function (p) {
    const host = document.getElementById('project-report-settings'); if (!host) return
    host.innerHTML = `<div class="flex items-center justify-between flex-wrap gap-2">
      <div><h3 class="text-sm font-bold text-gray-700"><i class="fas fa-clipboard-check text-blue-500 mr-1"></i>日報の提出設定（この案件の初期値）</h3>
        <p class="text-[11px] text-gray-400">スタッフごと・シフトごとに上書きできます。勤怠報告（8 種類）は${reportSettingsLink(p.project_id)}で設定します</p></div>
      <div class="flex gap-2 items-end">
        <label class="text-xs text-gray-600">日報<select id="pr-dr" class="inp text-sm">${opts({ none: '日報なし', required: '日報あり' }, p.daily_report_mode || 'required')}</select></label>
        <button class="btn btn-outline text-xs" onclick="saveProjectReportSettings(${p.project_id})">保存</button>
      </div></div>`
  }
  window.saveProjectReportSettings = async function (pid) {
    try { await axios.put(`/api/admin/projects/${pid}/report-settings`, { daily_report_mode: document.getElementById('pr-dr').value }); toast('提出設定を保存しました') } catch (e) { toast(errMsg(e)) }
  }
})()

// =========================================================
// スタッフのパスワード再発行（#45）。区分・登録状態のパネルの「ログイン」欄にボタンを足す
// メールのないスタッフも、管理者が仮パスワードを発行してログインできる状態に戻せる（仮パスワードは一度だけ表示）
// =========================================================
;(function () {
  const orig = window.renderStaffLifecyclePanel
  if (!orig) return
  window.renderStaffLifecyclePanel = async function (sid, p) {
    await orig(sid, p)
    if (!p || p.affiliation_type === 'linked_external' || p.affiliation_type === 'skillsheet_only') return
    let d; try { d = (await axios.get(`/api/admin/staff/${Number(sid)}/lifecycle`)).data } catch { return }
    // 他社連携から区分を変えた行（LK- のまま）は自社のログインではないので出さない（#569）
    if (!d.has_own_login || d.merged_into_staff_id) return
    const dl = document.querySelector('#staff-lifecycle dl')
    if (!dl || document.getElementById('staff-reset-password-btn')) return
    dl.insertAdjacentHTML('beforeend', `<div class="flex gap-2 items-center"><dt class="w-24 text-gray-400">パスワード</dt><dd>
      <button id="staff-reset-password-btn" class="btn btn-outline text-xs" data-action="resetStaffPassword" data-id="${Number(sid)}"><i class="fas fa-key"></i>パスワードを再発行</button></dd></div>`)
  }
  delegate('resetStaffPassword', (el) => {
    if (!confirm('仮パスワードを発行します。今のパスワードは使えなくなり、ログイン中の画面もログアウトされます。よろしいですか？')) return
    withSubmitLock(el, async () => {
      try {
        const { data } = await axios.post(`/api/admin/staff/${Number(el.dataset.id)}/reset-password`)
        showTempPassword('仮パスワードを発行しました', data.temp_password, [`氏名: ${data.name}`, `会社コード: ${data.company_code}`, `スタッフ番号: ${data.user_code}`, `ログイン: ${data.login_url}`])
      } catch (e) { showApiError(e, '再発行に失敗しました') }
    })
  })
})()

// =========================================================
// ログインのない人の報告をまとめて扱う画面（#275 報告用URLのまとめての発行、#508 予定どおりでのまとめての代理入力）
// openNologinBulk(日付, 案件ID, 'links' | 'proxy') で開く（シフト詳細の報告パネル・ほかの画面から呼べる）。
// 予定確認URL（#442）: スタッフ詳細の「区分・登録状態」に発行・無効化の行を出す
// =========================================================
;(function () {
  const RT = { wake_up: '起床', departure: '出発', check_in: '入店', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店' }
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d || 'エラーが発生しました'
  const PROXY_CHUNK = 50 // サーバーの1回の上限（staff-lifecycle.ts の BULK_PROXY_MAX）
  let st = { date: '', projectId: '', tab: 'links', links: null, proxy: null, result: null }
  async function copyText(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done) } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select()
      try { document.execCommand && document.execCommand('copy'); toast(done) } catch { toast('コピーできませんでした') }
      ta.remove()
    }
  }
  const telOf = (p) => String(p || '').replace(/[^\d+]/g, '')
  const hhmm = (at) => at ? dayjs(at).format('HH:mm') : ''

  window.openNologinBulk = async function (date, projectId, tab) {
    st = { date: date || dayjs().format('YYYY-MM-DD'), projectId: projectId ? String(projectId) : '', tab: tab === 'proxy' ? 'proxy' : 'links', links: null, proxy: null, result: null }
    modal(`<div id="nl-bulk"><div class="flex justify-center py-10"><span class="spin"></span></div></div>`)
    await loadBulk()
  }
  delegate('openNologinBulk', (el) => openNologinBulk(el.dataset.date, el.dataset.projectId, el.dataset.tab))

  async function loadBulk() {
    const q = `?date=${encodeURIComponent(st.date)}${st.projectId ? '&project_id=' + encodeURIComponent(st.projectId) : ''}`
    try {
      if (st.tab === 'links') st.links = (await axios.get('/api/admin/report-links/bulk' + q)).data
      else st.proxy = (await axios.get('/api/admin/proxy-attendance/bulk' + q)).data
    } catch (e) { toast(errMsg(e, '読み込みに失敗しました')); return }
    drawBulk()
  }
  function drawBulk() {
    const host = document.getElementById('nl-bulk'); if (!host) return
    const data = st.tab === 'links' ? st.links : st.proxy
    const projects = (data && data.projects) || []
    host.innerHTML = `<div class="flex items-center justify-between mb-2"><h3 class="font-bold text-gray-800"><i class="fas fa-users-viewfinder text-blue-600 mr-1"></i>ログインのない人の報告（まとめて）</h3>
        <button class="text-gray-400" onclick="closeModal()" title="閉じる"><i class="fas fa-xmark"></i></button></div>
      <div class="flex flex-wrap gap-2 items-end mb-3 text-xs">
        <label>稼働日<input type="date" id="nl-date" class="inp text-sm" value="${esc(st.date)}"></label>
        <label class="flex-1 min-w-[10rem]">案件<select id="nl-project" class="inp text-sm"><option value="">すべての案件</option>
          ${projects.map(p => `<option value="${Number(p.project_id)}" ${String(p.project_id) === st.projectId ? 'selected' : ''}>${esc(p.project_name)}</option>`).join('')}</select></label>
        <button class="btn btn-outline text-xs" data-action="nlReload"><i class="fas fa-rotate-right"></i>表示</button>
      </div>
      <div class="flex gap-1 mb-3 border-b">
        <button class="px-3 py-1.5 text-sm ${st.tab === 'links' ? 'border-b-2 border-blue-600 font-bold text-blue-700' : 'text-gray-500'}" data-action="nlTab" data-tab="links"><i class="fas fa-link mr-1"></i>報告用URL</button>
        <button class="px-3 py-1.5 text-sm ${st.tab === 'proxy' ? 'border-b-2 border-blue-600 font-bold text-blue-700' : 'text-gray-500'}" data-action="nlTab" data-tab="proxy"><i class="fas fa-user-pen mr-1"></i>予定どおりで代理入力</button>
      </div>
      <div id="nl-body">${!data ? '' : st.tab === 'links' ? linksHtml(data) : proxyHtml(data)}</div>`
  }
  delegate('nlReload', () => {
    st.date = (document.getElementById('nl-date') || {}).value || st.date
    st.projectId = (document.getElementById('nl-project') || {}).value || ''
    st.result = null
    loadBulk()
  })
  delegate('nlTab', (el) => { st.tab = el.dataset.tab === 'proxy' ? 'proxy' : 'links'; st.result = null; loadBulk() })

  // ---------- 報告用URL（#275） ----------
  const guideOf = (data, r) => reportGuideText({ company_name: data.company_name, work_date: r.work_date, start_time: r.start_time, end_time: r.end_time, project_name: r.project_name,
    place: r.place, staff_name: r.staff_name, token: { expires_at: r.expires_at }, notice_count: r.notice_count }, location.origin + '/r/' + r.token)
  function linksHtml(data) {
    const rows = data.rows || []
    if (!rows.length) return '<p class="text-sm text-gray-500 py-6 text-center">この日のログインのない人のシフトはありません</p>'
    const issued = rows.filter(r => r.token), unissued = rows.filter(r => !r.token && !r.unavailable), unused = issued.filter(r => !r.last_used_at)
    return `<p class="text-xs text-gray-600 mb-2">対象 ${rows.length}件（発行済み ${issued.length}件・うち未使用 ${unused.length}件 / 未発行 ${unissued.length}件）${data.truncated ? '<span class="text-amber-700">。件数が多いため一部だけを表示しています。案件で絞り込んでください</span>' : ''}</p>
      <div class="flex flex-wrap gap-2 mb-3">
        ${unissued.length ? `<button class="btn btn-primary text-xs" data-action="nlIssueAll"><i class="fas fa-link"></i>未発行の${unissued.length}件をまとめて発行</button>` : ''}
        ${issued.length ? `<button class="btn btn-outline text-xs" data-action="nlCopyAll"><i class="fas fa-copy"></i>発行済み${issued.length}件の案内文をまとめてコピー</button>` : ''}
      </div>
      <div class="space-y-1.5 max-h-[55vh] overflow-y-auto" id="nl-links">${rows.map(r => {
        const tel = telOf(r.staff_phone)
        const status = r.unavailable ? `<span class="badge badge-gray">${esc(r.unavailable)}</span>`
          : !r.token ? '<span class="badge badge-yellow">未発行</span>'
          : r.last_used_at ? `<span class="badge badge-green">開いた ${esc(dayjs(r.last_used_at).format('M/D HH:mm'))}</span>` : '<span class="badge badge-blue">発行済み・未使用</span>'
        return `<div class="rounded border border-gray-100 p-2 text-xs flex flex-wrap items-center gap-2" data-shift-id="${Number(r.shift_id)}">
          <div class="flex-1 min-w-[12rem]"><p class="font-bold text-gray-800">${esc(r.staff_name)} ${status}</p>
            <p class="text-gray-500">${esc(formatShiftTime(r.start_time, r.end_time))} ${esc(r.project_name)}${r.place ? '（' + esc(r.place) + '）' : ''}
              ${tel ? ` ・<a href="tel:${esc(tel)}" class="text-blue-600 underline">${esc(r.staff_phone)}</a>` : ' ・電話番号の登録なし'}${r.notice_count ? ` ・お知らせ${Number(r.notice_count)}件` : ''}</p></div>
          ${r.token ? `<button class="btn btn-outline text-[11px] py-0.5 px-2" data-action="nlCopyOne" data-shift-id="${Number(r.shift_id)}"><i class="fas fa-copy"></i>案内文</button>
            ${tel ? `<a class="btn btn-outline text-[11px] py-0.5 px-2" href="sms:${esc(tel)}?&body=${esc(encodeURIComponent(guideOf(data, r)))}"><i class="fas fa-comment-sms"></i>SMS</a>` : ''}` : ''}
        </div>` }).join('')}</div>
      <p class="text-[11px] text-gray-400 mt-2">報告用URLは稼働日の翌日 23:59 まで使えます。送り先の番号を確かめてから送ってください。本人あての重要なお知らせがあれば、案内文に一言添えます（お知らせは報告用のページに出ます）</p>`
  }
  delegate('nlIssueAll', (el) => withSubmitLock(el, async () => {
    try {
      const { data } = await axios.post('/api/admin/report-links/bulk', { date: st.date, project_id: st.projectId || undefined })
      st.links = { ...st.links, ...data }
      toast(`${data.issued}件の報告用URLを発行しました`); drawBulk()
    } catch (e) { toast(errMsg(e)) }
  }))
  delegate('nlCopyOne', (el) => {
    const r = ((st.links && st.links.rows) || []).find(x => x.shift_id === Number(el.dataset.shiftId)); if (!r || !r.token) return
    copyText(guideOf(st.links, r), `${r.staff_name}さんの案内文をコピーしました`)
  })
  delegate('nlCopyAll', () => {
    const rows = ((st.links && st.links.rows) || []).filter(r => r.token)
    if (!rows.length) return
    copyText(rows.map(r => `■ ${r.staff_name}さん${r.staff_phone ? '（' + r.staff_phone + '）' : ''}\n${guideOf(st.links, r)}`).join('\n\n'), `${rows.length}件の案内文をコピーしました`)
  })

  // ---------- 予定どおりで代理入力（#508） ----------
  function proxyHtml(data) {
    const rows = data.shifts || []
    if (!rows.length) return '<p class="text-sm text-gray-500 py-6 text-center">この日の勤務のシフトはありません</p>'
    const past = st.date < dayjs().format('YYYY-MM-DD')
    const res = st.result
    return `${res ? `<div class="rounded bg-gray-50 p-2 mb-2 text-xs" id="nl-proxy-result"><p class="font-bold">${Number(res.created)}件の報告を記録しました（${res.recorded.length}人）</p>
        ${res.skipped.length ? `<p class="text-amber-800 mt-1">記録しなかったシフト ${res.skipped.length}件:</p><ul class="list-disc ml-5 text-amber-800">${res.skipped.map(s => `<li>${esc(s.staff_name || 'シフト#' + s.shift_id)}: ${esc(s.reason)}</li>`).join('')}</ul>` : ''}</div>` : ''}
      <div class="flex flex-wrap items-center gap-3 text-xs mb-2">
        <span class="text-gray-600">記録する範囲:</span>
        <label class="flex items-center gap-1"><input type="radio" name="nl-scope" value="start" ${past ? '' : 'checked'}>入店・勤務開始だけ</label>
        <label class="flex items-center gap-1"><input type="radio" name="nl-scope" value="all" ${past ? 'checked' : ''}>予定どおり全部（休憩・勤務終了・退店も）</label>
      </div>
      <p class="text-[11px] text-gray-500 mb-2">チェックした人を、予定の時刻（入店・勤務開始は開始、勤務終了・退店は終了、休憩は予定の休憩）で記録します。違う人は時刻を直してください。まだ来ていない時刻・報告済みの報告・起床と出発は記録しません。ログインのない人を先に並べています${data.truncated ? '<span class="text-amber-700">。件数が多いため一部だけを表示しています。案件で絞り込んでください</span>' : ''}</p>
      <div class="max-h-[50vh] overflow-y-auto space-y-1" id="nl-proxy-rows">${rows.map(r => {
        const pending = r.required.filter(t => !r.done[t])
        const can = !r.blocked && pending.length > 0
        const check = can && !r.has_login
        return `<div class="rounded border border-gray-100 p-2 text-xs flex flex-wrap items-center gap-2 ${can ? '' : 'opacity-60'}">
          <input type="checkbox" class="nl-px" data-shift-id="${Number(r.shift_id)}" ${check ? 'checked' : ''} ${can ? '' : 'disabled'}>
          <div class="flex-1 min-w-[12rem]"><p class="font-bold text-gray-800">${esc(r.staff_name)} ${r.has_login ? '' : '<span class="badge badge-gray">ログインなし</span>'}</p>
            <p class="text-gray-500">${esc(formatShiftTime(r.start_time, r.end_time))} ${esc(r.project_name)}</p>
            <p class="text-[11px] text-gray-500">${r.required.map(t => r.done[t] ? `<span class="text-emerald-700">${esc(RT[t] || t)} ${esc(hhmm(r.done[t].at))}${r.done[t].entry_method === 'proxy' ? '（代理）' : ''}</span>` : `<span class="text-gray-400">${esc(RT[t] || t)} 未</span>`).join(' ・ ') || '勤怠報告なし'}
              ${r.daily.required ? ` ・日報 ${r.daily.submitted ? '提出済み' : '<span class="text-amber-700">未提出</span>'}` : ''}${r.blocked ? ` ・<span class="text-gray-500">${esc(r.blocked)}のため記録できません</span>` : ''}</p></div>
          ${can ? `<label class="text-[11px] text-gray-500">開始<input type="time" class="inp text-xs w-auto nl-start" data-shift-id="${Number(r.shift_id)}" placeholder="${esc(hhmm(r.defaults.check_in || r.defaults.work_start))}"></label>
            <label class="text-[11px] text-gray-500">終了<input type="time" class="inp text-xs w-auto nl-end" data-shift-id="${Number(r.shift_id)}" placeholder="${esc(hhmm(r.defaults.check_out || r.defaults.work_end))}"></label>` : ''}
        </div>` }).join('')}</div>
      <div class="flex gap-2 mt-3"><button class="btn btn-outline text-xs" data-action="nlCheckAll">記録できる人をすべてチェック</button>
        <button class="btn btn-primary text-xs flex-1" data-action="nlProxySubmit"><i class="fas fa-user-pen"></i>チェックした人を記録する</button></div>`
  }
  delegate('nlCheckAll', () => document.querySelectorAll('#nl-proxy-rows .nl-px:not(:disabled)').forEach(el => { el.checked = true }))
  delegate('nlProxySubmit', (el) => withSubmitLock(el, async () => {
    const scope = (document.querySelector('input[name="nl-scope"]:checked') || {}).value
    const val = (cls, id) => { const x = document.querySelector(`#nl-proxy-rows .${cls}[data-shift-id="${id}"]`); return x && x.value ? x.value : undefined }
    const items = [...document.querySelectorAll('#nl-proxy-rows .nl-px:checked')].map(x => Number(x.dataset.shiftId)).map(id => ({ shift_id: id, start: val('nl-start', id), end: val('nl-end', id) }))
    if (!items.length) { toast('記録する人をチェックしてください'); return }
    if (!confirm(`${items.length}人の勤怠を${scope === 'all' ? '予定どおり（終了まで）' : '入店・勤務開始だけ'}代理入力します。よろしいですか？`)) return
    const total = { created: 0, recorded: [], skipped: [] }
    for (let i = 0; i < items.length; i += PROXY_CHUNK) {
      try {
        const { data } = await axios.post('/api/admin/proxy-attendance/bulk', { scope, items: items.slice(i, i + PROXY_CHUNK) })
        total.created += data.created; total.recorded.push(...data.recorded); total.skipped.push(...data.skipped)
      } catch (e) { toast(errMsg(e)); break }
    }
    st.result = total
    toast(`${total.created}件の報告を記録しました`)
    await loadBulk()
  }))

  // ---------- 予定確認URL（#442） ----------
  // 区分・登録状態のパネルの行（ログインのない人だけ）。URL は発行したときだけ表示できる（保存しているのはハッシュだけのため）
  window.scheduleLinkRowHtml = function (sid, data) {
    if (data.has_login || data.merged_into_staff_id || data.affiliation_type === 'skillsheet_only') return ''
    const l = data.schedule_link
    const expired = l && l.expires_at < dayjs().format('YYYY-MM-DD HH:mm:ss')
    return `<div class="flex gap-2" id="schedule-link-row"><dt class="w-24 text-gray-400">予定確認URL</dt><dd>
      ${l && !expired ? `発行済み（${esc(dayjs(l.expires_at).format('M/D'))}まで有効・${l.last_used_at ? '最終アクセス ' + esc(dayjs(l.last_used_at).format('M/D HH:mm')) : '未使用'}）
        <button class="btn btn-outline text-xs ml-1" data-action="issueScheduleLink" data-id="${Number(sid)}" data-reissue="1"><i class="fas fa-rotate"></i>発行し直す</button>
        <button class="btn btn-outline text-xs" data-action="revokeScheduleLink" data-id="${Number(sid)}"><i class="fas fa-ban"></i>無効にする</button>`
      : data.schedule_link_blocked ? `<span class="text-gray-400">${esc(data.schedule_link_blocked)}</span>`
      : `${expired ? '<span class="text-gray-400">期限切れ</span> ' : ''}<button class="btn btn-outline text-xs" data-action="issueScheduleLink" data-id="${Number(sid)}"><i class="fas fa-calendar-days"></i>発行する</button>`}
      <span class="block text-[11px] text-gray-400">本人が、今日から2週間の確定シフト（日時・案件・場所）を見られるURLです。前日〜翌日のシフトは、そのページから勤怠・日報を報告できます。金額は表示しません</span></dd></div>`
  }
  delegate('issueScheduleLink', (el) => {
    if (el.dataset.reissue && !confirm('予定確認URLを発行し直します。今のURLは使えなくなります。よろしいですか？')) return
    withSubmitLock(el, async () => {
      const sid = Number(el.dataset.id)
      try {
        const { data } = await axios.post(`/api/admin/staff/${sid}/schedule-link`, {})
        const url = location.origin + '/r/' + data.token
        const text = `【${data.company_name}】${data.staff_name}さんの今後2週間のシフトは、こちらのURLで確認できます。当日の勤怠・日報の報告や、遅刻・欠勤の連絡もこのページからできます（${dayjs(data.expires_at).format('M/D')}まで有効。${data.staff_name}さん専用のURLです）\n${url}`
        const tel = telOf(data.staff_phone)
        window.__scheduleGuide = text
        modal(`<h3 class="font-bold text-gray-800 mb-2"><i class="fas fa-calendar-days text-blue-600 mr-1"></i>予定確認URLを発行しました</h3>
          <p class="text-xs text-red-600 mb-2">このURLはこの画面でだけ表示します。閉じる前に本人に送ってください（あとから確かめることはできません。必要なら発行し直してください）</p>
          <input class="inp text-xs w-full" readonly value="${esc(url)}" id="schedule-link-url">
          <textarea class="inp text-xs w-full mt-2" rows="4" readonly id="schedule-link-guide">${esc(text)}</textarea>
          <div class="flex flex-wrap gap-2 mt-3">
            <button class="btn btn-primary text-xs" data-action="copyScheduleGuide"><i class="fas fa-copy"></i>案内文をコピー</button>
            ${tel ? `<a class="btn btn-outline text-xs" href="sms:${esc(tel)}?&body=${esc(encodeURIComponent(text))}"><i class="fas fa-comment-sms"></i>SMSで送る</a>` : ''}
            <button class="btn btn-outline text-xs" onclick="closeModal()">閉じる</button></div>`, { onClose: () => { window.__scheduleGuide = ''; if (window.renderStaffDetail) renderStaffDetail(sid) } })
      } catch (e) { toast(errMsg(e)) }
    })
  })
  delegate('copyScheduleGuide', () => { if (window.__scheduleGuide) copyText(window.__scheduleGuide, '案内文をコピーしました') })
  delegate('revokeScheduleLink', (el) => {
    if (!confirm('予定確認URLを無効にしますか？本人はこのURLを開けなくなります')) return
    withSubmitLock(el, async () => {
      try { await axios.delete(`/api/admin/staff/${Number(el.dataset.id)}/schedule-link`); toast('無効にしました'); if (window.renderStaffDetail) renderStaffDetail(Number(el.dataset.id)) } catch (e) { toast(errMsg(e)) }
    })
  })
})()
