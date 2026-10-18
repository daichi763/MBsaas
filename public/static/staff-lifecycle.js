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
  window.showQuickRegister = async function (ctx) {
    ctx = ctx || {}
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
    const { data } = await axios.get('/api/admin/staff-lookup', { params: { phone } })
    box.innerHTML = data.matches.length ? `<div class="p-2 rounded-lg bg-amber-50 text-xs text-amber-800"><i class="fas fa-triangle-exclamation mr-1"></i>この電話番号のスタッフが登録済みです:
      ${data.matches.map(m => `<a class="underline font-bold ml-1" href="#staff/${m.staff_id}" onclick="closeModal()">${esc(m.name)}（${TYPE_LABEL[m.affiliation_type] || ''}）</a>`).join('')}
      <span class="block mt-1">同じ人の場合は、既存のスタッフをシフトに割り当ててください</span></div>` : ''
  }
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
      if (d && d.need_force) {
        if (confirm(`この電話番号のスタッフが登録済みです（${d.matches.map(m => m.name).join('、')}）。\n別の人として登録しますか？`)) return submitQuickRegister(ctx, true, requestKey)
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
            ${data.is_provisional ? `<button class="btn btn-outline text-xs" onclick="openMerge(${sid})" id="merge-open-btn"><i class="fas fa-code-merge"></i>既存のスタッフに統合</button>` : ''}
            ${data.is_provisional ? `<button class="btn btn-primary text-xs" onclick="openFinalize(${sid})"><i class="fas fa-user-check"></i>本登録する</button>` : ''}
            <button class="btn btn-outline text-xs" data-action="openAffiliationChange" data-sid="${Number(sid)}" data-from="${esc(t)}"><i class="fas fa-right-left"></i>区分を変更</button>`}
          </div>
        </div>
        <dl class="text-xs space-y-1.5">
          <div class="flex gap-2"><dt class="w-24 text-gray-400">現在の区分</dt><dd class="font-bold">${TYPE_LABEL[t] || t}</dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-400">登録状態</dt><dd>${data.merged_into_staff_id ? `<span class="badge badge-gray">統合済み</span> <a class="text-blue-600 hover:underline" href="#staff/${data.merged_into_staff_id}">${esc(data.merged_into_name || '統合先')}</a>（${esc(String(data.merged_at || '').slice(0, 10))}）` : data.is_provisional ? '<span class="badge badge-red">仮登録</span>' : '<span class="badge badge-green">本登録</span>'}</dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-400">ログイン</dt><dd>${data.has_own_login ? 'あり（' + esc(data.user_code) + '）' : data.has_login ? '所属元の会社のログインから企業を切り替えて利用' : 'なし（報告用URLまたは代理入力で記録）'}
            ${data.can_issue_login ? `<button class="btn btn-outline text-xs ml-1" id="issue-login-btn" data-action="openIssueLogin" data-id="${Number(sid)}"><i class="fas fa-key"></i>ログインを発行</button>` : ''}</dd></div>
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
        <p class="text-[11px] text-gray-400 mb-2">案件の初期値 → スタッフ → シフトの順に上書きします。勤怠報告（8 種類）は${reportSettingsLink()}で案件ごとに設定します</p>
        <label class="text-xs text-gray-600 block">日報<select id="sl-dr" class="inp text-sm">${opts(DR_LABEL, data.daily_report_mode || '')}</select></label>
        <button class="btn btn-outline w-full text-xs mt-2" onclick="saveStaffReportSettings(${sid})">保存する</button>
      </section>
    </div>`
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
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-code-merge text-blue-600 mr-1"></i>既存のスタッフに統合</h3>
      <p class="text-xs text-gray-500 mb-3">仮登録の「${esc(d.source.name)}」が、すでに登録のある人（他社から連携したスタッフなど）と同じ人の場合に使います。シフト・勤怠・日報・評価などを統合先に移します</p>
      <div class="flex gap-2 mb-2"><input id="mg-q" class="inp text-sm flex-1" placeholder="氏名・フリガナで探す" value="${esc(q || '')}" onkeydown="if(event.key==='Enter')openMerge(${sid}, this.value)">
        <button class="btn btn-outline text-xs" onclick="openMerge(${sid}, document.getElementById('mg-q').value)"><i class="fas fa-magnifying-glass"></i></button></div>
      <div class="space-y-1.5 max-h-72 overflow-y-auto" id="merge-candidates">
        ${d.candidates.map(r => `<button class="w-full text-left p-2.5 rounded-lg border border-gray-200 hover:border-blue-400 hover:bg-blue-50" onclick="previewMerge(${sid}, ${r.staff_id})">
          <div class="flex items-center justify-between gap-2"><p class="font-bold text-sm">${esc(r.name)} <span class="text-xs font-normal text-gray-400">${esc(r.kana || '')}</span>${r.inactive ? ` <span class="badge badge-red">${esc(r.inactive)}</span>` : ''}</p>
            <span class="badge ${r.affiliation_type === 'linked_external' ? 'badge-blue' : 'badge-gray'}">${esc(TYPE_LABEL[r.affiliation_type] || r.affiliation_type)}${r.affiliation_type === 'linked_external' && r.owner_company_name ? '・' + esc(r.owner_company_name) : ''}</span></div>
          <p class="text-[11px] text-gray-500">${r.reasons.map(x => `<span class="text-emerald-700">${esc(x)}</span>`).join('・') || '検索に一致'}${r.global_staff_code ? '・ID ' + esc(r.global_staff_code) : ''}・稼働 ${r.shift_count}件${r.last_work_date ? '（最終 ' + esc(r.last_work_date) + '）' : ''}${r.is_provisional ? '・<span class="text-red-600">仮登録</span>' : ''}</p>
        </button>`).join('') || '<p class="text-xs text-gray-400 p-3 text-center">候補が見つかりません。氏名で検索するか、他社のスタッフなら先に「スタッフマスタ → 新規追加 → QR/ID連携」で連携してください</p>'}
      </div>
      <button class="btn btn-outline w-full mt-3" onclick="closeModal()">閉じる</button>`)
  }
  window.previewMerge = async function (sid, targetId) {
    let d; try { d = (await axios.post(`/api/admin/staff/${sid}/merge`, { target_staff_id: targetId, dry_run: true })).data } catch (e) { return toast(errMsg(e)) }
    modal(`
      <h3 class="font-bold text-lg mb-2">統合の確認</h3>
      <div class="flex items-center gap-2 text-sm mb-3" id="merge-preview">
        <div class="flex-1 p-2 rounded-lg bg-red-50"><p class="text-[11px] text-gray-500">統合元（仮登録）</p><p class="font-bold">${esc(d.source.name)}</p><p class="text-[11px]">${esc(d.source.type_label)}</p></div>
        <i class="fas fa-arrow-right text-gray-400"></i>
        <div class="flex-1 p-2 rounded-lg bg-blue-50"><p class="text-[11px] text-gray-500">統合先</p><p class="font-bold">${esc(d.target.name)}</p><p class="text-[11px]">${esc(d.target.type_label)}${d.target.owner_company_name && d.target.type === 'linked_external' ? '・' + esc(d.target.owner_company_name) : ''}</p></div>
      </div>
      <ul class="text-xs space-y-1 mb-3 list-disc pl-4">${d.effects.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${d.warnings.length ? `<div class="text-xs bg-amber-50 text-amber-800 rounded p-2 mb-3" id="merge-warnings"><p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>確認してください</p>${d.warnings.map(x => `<p>・${esc(x)}</p>`).join('')}</div>` : ''}
      <label class="block text-xs text-gray-600 mb-3">メモ（任意）<input id="mg-note" class="inp text-sm" maxlength="300" placeholder="例: 募集から応募した山田さんは〇〇社の連携スタッフと同一人物"></label>
      <div class="flex gap-2">
        <button class="btn btn-outline flex-1" onclick="openMerge(${sid})">戻る</button>
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
  const loginFieldsHtml = (d, px) => `
    <div class="grid grid-cols-2 gap-3">
      <input id="${px}-code" class="inp text-sm" placeholder="スタッフ番号" maxlength="50"><input id="${px}-pass" class="inp text-sm" placeholder="初期パスワード（8文字以上）" autocomplete="new-password">
      <label class="text-xs text-gray-600 col-span-2">メール（ログイン・パスワード再設定の宛先。任意）<input id="${px}-email" class="inp text-sm" type="email" maxlength="254" value="${esc(d.email || '')}" placeholder="メール（任意）"></label>
      ${d.unverified_email ? `<label class="col-span-2 flex items-start gap-2 text-xs p-2 rounded bg-amber-50 text-amber-800"><input type="checkbox" id="${px}-use-unverified" class="mt-0.5">
        <span>応募時などに入力されたメール <b>${esc(d.unverified_email)}</b>（未確認）を使う。本人のものと確認できた場合だけ選んでください</span></label>` : ''}
    </div>`
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  const loginBody = (px) => {
    const body = { user_code: val(px + '-code'), password: val(px + '-pass'), email: val(px + '-email') }
    const use = document.getElementById(px + '-use-unverified')
    if (use && use.checked) { body.use_unverified_email = true; delete body.email }
    return body
  }

  // ---------- 本登録 ----------
  // 今のフリガナ・性別・メールを入力欄に入れて開く（空欄のまま本登録しても応募時のフリガナを消さない。#505）
  window.openFinalize = async function (sid) {
    let d; try { d = (await axios.get(`/api/admin/staff/${Number(sid)}/lifecycle`)).data } catch (e) { return toast(errMsg(e)) }
    modal(`<h3 class="font-bold text-lg mb-1">本登録</h3>
      <p class="text-xs text-gray-500 mb-3">性別などの必須項目を入力し、仮登録を解除します。ログインの発行は任意です（発行しない場合は報告用URLまたは代理入力で記録します）</p>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">性別 <span class="text-red-500">*</span><select id="fz-gender" class="inp"><option value="">選択してください</option>${Object.entries(GENDER_LABEL).map(([k, l]) => `<option value="${k}" ${d.gender === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="text-sm text-gray-600">フリガナ<input id="fz-kana" class="inp" maxlength="60" value="${esc(d.kana || '')}"></label>
        </div>
        ${d.unverified_email ? `<p class="text-[11px] text-amber-700"><i class="fas fa-circle-info mr-1"></i>応募時のメール ${esc(d.unverified_email)} は未確認のため、ログイン・パスワード再設定には使っていません</p>` : ''}
        <details class="p-3 rounded-lg border border-gray-200"><summary class="text-sm text-gray-600 cursor-pointer">ログインを発行する（任意）</summary>
          <div class="mt-3">${loginFieldsHtml(d, 'fz')}</div></details>
        <p class="text-[11px] text-gray-400">その他の項目（生年月日・スキル等）は本登録後に基本情報欄で入力できます</p>
        <button class="btn btn-primary w-full" data-action="submitFinalize" data-id="${Number(sid)}">本登録する</button>
      </div>`)
  }
  delegate('submitFinalize', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.id)
    const body = { gender: val('fz-gender'), kana: val('fz-kana') }
    // ログインの欄に入力があるときだけ、ログインの発行とメールを送る
    if (val('fz-code') || val('fz-pass')) Object.assign(body, loginBody('fz'))
    try {
      await axios.post(`/api/admin/staff/${sid}/finalize`, body)
      closeModal(); toast('本登録しました'); renderStaffDetail(sid)
    } catch (e) { toast(errMsg(e)) }
  }))

  // ---------- ログインの発行（仮登録ではない、ログインのないスタッフ。#89） ----------
  delegate('openIssueLogin', async (el) => {
    const sid = Number(el.dataset.id)
    let d; try { d = (await axios.get(`/api/admin/staff/${sid}/lifecycle`)).data } catch (e) { return toast(errMsg(e)) }
    modal(`<h3 class="font-bold text-lg mb-1">ログインを発行</h3>
      <p class="text-xs text-gray-500 mb-3">スタッフ番号と初期パスワードを設定し、スタッフ用のアプリでシフトの確認・勤怠報告ができるようにします。初期パスワードは本人に伝えてください</p>
      <div class="space-y-3">${loginFieldsHtml(d, 'il')}
        <button class="btn btn-primary w-full" data-action="submitIssueLogin" data-id="${sid}">ログインを発行する</button></div>`)
  })
  delegate('submitIssueLogin', (el) => withSubmitLock(el, async () => {
    const sid = Number(el.dataset.id)
    try {
      await axios.post(`/api/admin/staff/${sid}/issue-login`, loginBody('il'))
      closeModal(); toast('ログインを発行しました'); renderStaffDetail(sid)
    } catch (e) { toast(errMsg(e)) }
  }))

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
    host.innerHTML = `<div class="rounded-lg border border-gray-100 p-3 text-xs space-y-2" id="shift-report-box">
      <div class="flex items-center justify-between"><p class="font-bold text-gray-700"><i class="fas fa-clipboard-check mr-1"></i>勤怠・日報</p>
        <span class="text-gray-400">${d.has_login ? 'アプリで報告' : 'ログインなし'}</span></div>
      <div class="flex flex-wrap gap-1">
        ${d.modes.required_attendance.map(t => { const r = done.get(t); return `<span class="badge ${r ? 'badge-green' : 'badge-gray'}" title="${r ? esc(ENTRY_LABEL[r.entry_method] || '') + (r.entered_by_name ? '（' + esc(r.entered_by_name) + '）' : '') : '未報告'}">${RT_LABEL[t]} ${r ? atLabel(r.reported_at, d.work_date) : '未'}${r && r.entry_method === 'proxy' ? '・代理' : r && r.entry_method === 'link' ? '・URL' : r && r.entry_method === 'correction' ? '・修正' : ''}</span>` }).join('') || '<span class="text-gray-400">勤怠報告なし</span>'}
        ${d.modes.daily_report_required ? `<span class="badge ${d.daily_report ? 'badge-green' : 'badge-gray'}">日報 ${d.daily_report ? '提出済み' : '未提出'}</span>` : '<span class="badge badge-gray">日報なし</span>'}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label>このシフトの勤怠報告<select id="sr-att" class="inp text-xs" onchange="saveShiftReportSettings(${shiftId})">${opts({ '': '案件報告管理の設定どおり', none: '勤怠報告なし', in_out: '入店・退店のみ' }, d.shift_attendance_mode === 'full' ? '' : (d.shift_attendance_mode || ''))}</select></label>
        <label>このシフトの日報<select id="sr-dr" class="inp text-xs" onchange="saveShiftReportSettings(${shiftId})">${opts({ '': 'スタッフ・案件の設定（' + (DR_LABEL[d.modes.daily_report_mode] || '') + '）', none: '日報なし', required: '日報あり' }, d.shift_daily_report_mode || '')}</select></label>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${d.token ? `<input class="inp text-[11px] flex-1 min-w-0" id="sr-url" readonly value="${esc(url)}">
          <button class="btn btn-primary text-xs" onclick="copyReportLink()"><i class="fas fa-copy"></i>コピー</button>
          <button class="btn btn-outline text-xs" onclick="revokeReportLink(${shiftId})" title="無効にする"><i class="fas fa-ban"></i></button>`
        : `<button class="btn btn-outline text-xs flex-1" onclick="issueReportLink(${shiftId})"><i class="fas fa-link"></i>報告用URLを発行（ログイン不要）</button>`}
        ${pending && !d.proxy_blocked ? `<button class="btn btn-outline text-xs" data-action="openProxyAttendance" data-shift-id="${shiftId}"><i class="fas fa-user-pen"></i>代理入力</button>` : ''}
        ${pending && d.proxy_blocked ? `<span class="text-[11px] text-gray-400 py-1">${esc(d.proxy_blocked)}のシフトは代理入力できません</span>` : ''}
      </div>
      ${d.token ? `<p class="text-[11px] text-gray-400">有効期限: ${dayjs(d.token.expires_at).format('M/D HH:mm')}${d.token.last_used_at ? '・最終アクセス ' + dayjs(d.token.last_used_at).format('M/D HH:mm') : '・未使用'}。SMS・LINEなどで本人に送ってください</p>` : ''}
    </div>`
  }
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
  window.copyReportLink = async function () {
    const el = document.getElementById('sr-url'); if (!el) return
    try { await navigator.clipboard.writeText(el.value); toast('URLをコピーしました') } catch { el.select(); document.execCommand && document.execCommand('copy'); toast('URLをコピーしました') }
  }
  // 代理入力: 報告状況の最後の取得結果（シフトごと）。既定の時刻・未報告の種類はここから読む
  const reportStatusCache = {}
  // 'YYYY-MM-DD HH:MM:SS' を表示用に（稼働日と違う日付なら M/D を付ける）
  const atLabel = (at, workDate) => at ? (String(at).slice(0, 10) !== workDate ? dayjs(at).format('M/D HH:mm') : dayjs(at).format('HH:mm')) : ''
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
    if (!d.has_login || d.merged_into_staff_id) return
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
