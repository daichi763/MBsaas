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
  const ATT_LABEL = { '': '案件の設定に従う', none: '勤怠報告なし', in_out: '入店・退店のみ', full: '起床・出発・入店・退店' }
  const DR_LABEL = { '': '案件の設定に従う', none: '日報なし', required: '日報あり' }
  const RT_LABEL = { wake_up: '起床', departure: '出発', check_in: '入店', check_out: '退店' }
  const ENTRY_LABEL = { app: 'アプリ', link: '報告用URL', proxy: '代理入力' }
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
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">勤怠報告<select id="qr-att" class="inp text-sm">${opts(ATT_LABEL, '')}</select></label>
          <label class="text-sm text-gray-600">日報<select id="qr-dr" class="inp text-sm">${opts(DR_LABEL, '')}</select></label>
        </div>
        <input id="qr-memo" class="inp text-sm" placeholder="メモ（任意・紹介元など）">
        <button class="btn btn-primary w-full" onclick='submitQuickRegister(${JSON.stringify(ctx)})'>${ctx.slot_role_id ? '仮登録して枠に割り当てる' : '仮登録する'}</button>
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
  window.submitQuickRegister = async function (ctx, force) {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
    const type = v('qr-type')
    const body = { name: v('qr-name'), phone: v('qr-phone'), affiliation_type: type, attendance_mode: v('qr-att'), daily_report_mode: v('qr-dr'), memo: v('qr-memo'), trade_name: v('qr-trade'), force: !!force }
    if (type === 'partner_manual') { const p = v('qr-partner-id'); if (p && p !== 'new') body.partner_affiliation_id = Number(p); else body.new_partner_name = v('qr-partner-new') }
    if (!body.name) { toast('氏名を入力してください'); return }
    try {
      const { data } = await axios.post('/api/admin/staff-quick', body)
      if (window.invalidateBoardMaster) invalidateBoardMaster()
      if (ctx && ctx.slot_role_id && window.boardAssign) { toast('仮登録しました'); return boardAssign(ctx.slot_role_id, [data.staff_id]) }
      closeModal(); toast('仮登録しました'); location.hash = 'staff/' + data.staff_id
    } catch (e) {
      const d = e.response && e.response.data
      if (d && d.need_force) {
        if (confirm(`この電話番号のスタッフが登録済みです（${d.matches.map(m => m.name).join('、')}）。\n別の人として登録しますか？`)) return submitQuickRegister(ctx, true)
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
            <button class="btn btn-outline text-xs" onclick="openAffiliationChange(${sid}, '${t}')"><i class="fas fa-right-left"></i>区分を変更</button>`}
          </div>
        </div>
        <dl class="text-xs space-y-1.5">
          <div class="flex gap-2"><dt class="w-24 text-gray-400">現在の区分</dt><dd class="font-bold">${TYPE_LABEL[t] || t}</dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-400">登録状態</dt><dd>${data.merged_into_staff_id ? `<span class="badge badge-gray">統合済み</span> <a class="text-blue-600 hover:underline" href="#staff/${data.merged_into_staff_id}">${esc(data.merged_into_name || '統合先')}</a>（${esc(String(data.merged_at || '').slice(0, 10))}）` : data.is_provisional ? '<span class="badge badge-red">仮登録</span>' : '<span class="badge badge-green">本登録</span>'}</dd></div>
          <div class="flex gap-2"><dt class="w-24 text-gray-400">ログイン</dt><dd>${data.has_login ? 'あり（' + esc(data.user_code) + '）' : 'なし（報告用URLまたは代理入力で記録）'}</dd></div>
          ${data.employee_record && data.employee_record.employment_ended_at ? `<div class="flex gap-2"><dt class="w-24 text-gray-400">従業員管理</dt><dd>雇用終了 ${esc(data.employee_record.employment_ended_at)}（閲覧のみで保持） <a class="text-blue-600 hover:underline" href="#employees/${sid}">開く</a></dd></div>` : ''}
        </dl>
        <p class="text-xs font-bold text-gray-600 mt-3 mb-1">変更履歴</p>
        <div class="space-y-1 max-h-40 overflow-y-auto">${data.history.map(h => `<div class="text-[11px] bg-gray-50 rounded p-1.5">
          <b>${esc(h.effective_date)}</b> ${h.from_type === 'new' ? '登録' : esc(TYPE_LABEL[h.from_type] || h.from_type) + ' → '}<b>${esc(TYPE_LABEL[h.to_type] || h.to_type)}</b>
          ${h.to_affiliation ? `（${esc(h.to_affiliation)}）` : ''}${h.affected_shifts ? ` ・予定シフト${h.affected_shifts}件を置き換え` : ''}${h.note ? ` ・${esc(h.note)}` : ''}
          <span class="text-gray-400">${esc(h.changed_by_name || '')}</span></div>`).join('') || '<p class="text-[11px] text-gray-400">履歴はありません</p>'}</div>
      </section>
      <section class="card p-4" id="staff-report-settings">
        <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-clipboard-check text-blue-500 mr-1"></i>勤怠・日報の提出設定</h3>
        <p class="text-[11px] text-gray-400 mb-2">案件の初期値 → スタッフ → シフトの順に上書きします。「不要」にした報告は未報告アラートの対象外です</p>
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs text-gray-600">勤怠報告<select id="sl-att" class="inp text-sm">${opts(ATT_LABEL, data.attendance_mode || '')}</select></label>
          <label class="text-xs text-gray-600">日報<select id="sl-dr" class="inp text-sm">${opts(DR_LABEL, data.daily_report_mode || '')}</select></label>
        </div>
        <button class="btn btn-outline w-full text-xs mt-2" onclick="saveStaffReportSettings(${sid})">保存する</button>
      </section>
    </div>`
  }
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
          <div class="flex items-center justify-between gap-2"><p class="font-bold text-sm">${esc(r.name)} <span class="text-xs font-normal text-gray-400">${esc(r.kana || '')}</span></p>
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
        <button class="btn btn-danger flex-1" onclick="runMerge(${sid}, ${targetId}, ${d.warnings.length ? 'true' : 'false'})">${d.warnings.length ? '確認のうえ統合する' : '統合する'}</button>
      </div>`)
  }
  window.runMerge = async function (sid, targetId, force) {
    if (!confirm('統合は元に戻せません。統合しますか？')) return
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/merge`, { target_staff_id: targetId, force, note: document.getElementById('mg-note').value })
      closeModal(); toast(`統合しました（シフト${data.moved.shifts}件を移動）`)
      if (window.invalidateBoardMaster) window.invalidateBoardMaster()
      location.hash = 'staff/' + data.target_staff_id
    } catch (e) { toast(errMsg(e)) }
  }

  window.saveStaffReportSettings = async function (sid) {
    try { await axios.put(`/api/admin/staff/${sid}/report-settings`, { attendance_mode: document.getElementById('sl-att').value, daily_report_mode: document.getElementById('sl-dr').value }); toast('提出設定を保存しました') } catch (e) { toast(errMsg(e)) }
  }

  // ---------- 本登録 ----------
  window.openFinalize = function (sid) {
    modal(`<h3 class="font-bold text-lg mb-1">本登録</h3>
      <p class="text-xs text-gray-500 mb-3">性別などの必須項目を入力し、仮登録を解除します。ログインの発行は任意です（発行しない場合は報告用URLまたは代理入力で記録します）</p>
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">性別 <span class="text-red-500">*</span><select id="fz-gender" class="inp"><option value="">選択してください</option><option value="male">男性</option><option value="female">女性</option><option value="other">その他</option><option value="unspecified">回答しない</option></select></label>
          <label class="text-sm text-gray-600">フリガナ<input id="fz-kana" class="inp"></label>
        </div>
        <details class="p-3 rounded-lg border border-gray-200"><summary class="text-sm text-gray-600 cursor-pointer">ログインを発行する（任意）</summary>
          <div class="grid grid-cols-2 gap-3 mt-3">
            <input id="fz-code" class="inp text-sm" placeholder="スタッフ番号"><input id="fz-pass" class="inp text-sm" placeholder="初期パスワード（4文字以上）">
            <input id="fz-email" class="inp text-sm col-span-2" placeholder="メール（任意）">
          </div></details>
        <p class="text-[11px] text-gray-400">その他の項目（生年月日・スキル等）は本登録後に基本情報欄で入力できます</p>
        <button class="btn btn-primary w-full" onclick="submitFinalize(${sid})">本登録する</button>
      </div>`)
  }
  window.submitFinalize = async function (sid) {
    const v = (id) => document.getElementById(id).value.trim()
    try {
      await axios.post(`/api/admin/staff/${sid}/finalize`, { gender: v('fz-gender'), kana: v('fz-kana'), user_code: v('fz-code'), password: v('fz-pass'), email: v('fz-email') })
      closeModal(); toast('本登録しました'); renderStaffDetail(sid)
    } catch (e) { toast(errMsg(e)) }
  }

  // ---------- 区分の変更（確認画面で影響を表示してから実行） ----------
  window.openAffiliationChange = async function (sid, from) {
    let partners = []
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners } catch { }
    const targets = ['own_employee', 'daily_worker', 'freelance', 'partner_manual'].filter(k => k !== from || k === 'partner_manual')
    modal(`<h3 class="font-bold text-lg mb-1">区分を変更</h3>
      <p class="text-xs text-gray-500 mb-3">現在: <b>${TYPE_LABEL[from]}</b>。スタッフIDは変わらず、シフト・勤怠・評価・メモの履歴はそのまま引き継がれます</p>
      <div class="space-y-3">
        <div class="space-y-1.5">${targets.map((k, i) => `<label class="flex items-start gap-2 p-2 rounded-lg border border-gray-200 cursor-pointer has-[:checked]:border-blue-400 has-[:checked]:bg-blue-50">
          <input type="radio" name="ac-type" value="${k}" ${i === 0 ? 'checked' : ''} onchange="acTypeChanged()" class="mt-1"><span><b class="text-sm">${TYPE_LABEL[k]}</b><span class="block text-[11px] text-gray-500">${TYPE_DESC[k]}</span></span></label>`).join('')}</div>
        <div id="ac-partner" class="hidden p-3 rounded-lg bg-purple-50 space-y-2">
          <select id="ac-partner-id" class="inp text-sm" onchange="document.getElementById('ac-partner-new').classList.toggle('hidden', this.value !== 'new')">
            ${partners.map(p => `<option value="${p.affiliation_id}">${esc(p.affiliation_name)}</option>`).join('')}<option value="new" ${partners.length ? '' : 'selected'}>＋ 新しい取引先</option></select>
          <input id="ac-partner-new" class="inp text-sm ${partners.length ? 'hidden' : ''}" placeholder="取引先名">
        </div>
        <input id="ac-trade" class="inp text-sm hidden" placeholder="屋号（任意）">
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm text-gray-600">適用日 *<input id="ac-date" type="date" class="inp" value="${dayjs().format('YYYY-MM-DD')}"></label>
          <div id="ac-emp" class="hidden"><label class="text-sm text-gray-600">入社日<input id="ac-hire" type="date" class="inp" value="${dayjs().format('YYYY-MM-DD')}"></label></div>
        </div>
        <input id="ac-contract" class="inp text-sm hidden" placeholder="雇用形態（正社員 / アルバイト / パート 等）">
        <input id="ac-note" class="inp text-sm" placeholder="メモ（任意）">
        <div id="ac-preview"></div>
        <button id="ac-check" class="btn btn-outline w-full" onclick="previewAffiliationChange(${sid})">影響を確認する</button>
      </div>`)
    acTypeChanged()
  }
  window.acTypeChanged = function () {
    const t = (document.querySelector('input[name=ac-type]:checked') || {}).value
    document.getElementById('ac-partner').classList.toggle('hidden', t !== 'partner_manual')
    document.getElementById('ac-trade').classList.toggle('hidden', t !== 'freelance')
    document.getElementById('ac-emp').classList.toggle('hidden', t !== 'own_employee')
    document.getElementById('ac-contract').classList.toggle('hidden', t !== 'own_employee')
    document.getElementById('ac-preview').innerHTML = ''
  }
  function acBody() {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
    const t = (document.querySelector('input[name=ac-type]:checked') || {}).value
    const b = { to_type: t, effective_date: v('ac-date'), trade_name: v('ac-trade'), hire_date: v('ac-hire'), contract_type: v('ac-contract'), note: v('ac-note') }
    if (t === 'partner_manual') { const p = v('ac-partner-id'); if (p && p !== 'new') b.partner_affiliation_id = Number(p); else b.new_partner_name = v('ac-partner-new') }
    return b
  }
  window.previewAffiliationChange = async function (sid) {
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/affiliation-change`, { ...acBody(), dry_run: true })
      document.getElementById('ac-preview').innerHTML = `<div class="p-3 rounded-lg bg-blue-50 text-xs text-blue-900" id="ac-effects">
        <p class="font-bold mb-1">${esc(data.effective_date)} から「${esc(data.from_label)}」→「${esc(data.to_label)}${data.affiliation ? '（' + esc(data.affiliation) + '）' : ''}」</p>
        <ul class="list-disc ml-4 space-y-0.5">${data.effects.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <button class="btn btn-primary w-full mt-3" onclick="applyAffiliationChange(${sid})">この内容で変更する</button>`
    } catch (e) { toast(errMsg(e)) }
  }
  window.applyAffiliationChange = async function (sid) {
    try {
      const { data } = await axios.post(`/api/admin/staff/${sid}/affiliation-change`, acBody())
      closeModal(); toast(`区分を変更しました（予定シフト${data.affected_shifts}件を置き換え）`); if (window.invalidateBoardMaster) invalidateBoardMaster(); renderStaffDetail(sid)
    } catch (e) { toast(errMsg(e)) }
  }

  // =========================================================
  // シフト詳細（シフトボード）: 報告状況・報告用URL・代理入力・提出設定
  // =========================================================
  window.renderShiftReportPanel = async function (shiftId) {
    const host = document.getElementById('shift-report-panel'); if (!host) return
    let d; try { d = (await axios.get(`/api/admin/shifts/${shiftId}/report-status`)).data } catch { host.innerHTML = ''; return }
    const done = new Map(d.reports.map(r => [r.report_type, r]))
    const url = d.token ? location.origin + '/r/' + d.token.token : ''
    host.innerHTML = `<div class="rounded-lg border border-gray-100 p-3 text-xs space-y-2" id="shift-report-box">
      <div class="flex items-center justify-between"><p class="font-bold text-gray-700"><i class="fas fa-clipboard-check mr-1"></i>勤怠・日報</p>
        <span class="text-gray-400">${d.has_login ? 'アプリで報告' : 'ログインなし'}</span></div>
      <div class="flex flex-wrap gap-1">
        ${d.modes.required_attendance.map(t => { const r = done.get(t); return `<span class="badge ${r ? 'badge-green' : 'badge-gray'}" title="${r ? esc(ENTRY_LABEL[r.entry_method] || '') + (r.entered_by_name ? '（' + esc(r.entered_by_name) + '）' : '') : '未報告'}">${RT_LABEL[t]} ${r ? dayjs(r.reported_at).format('HH:mm') : '未'}${r && r.entry_method === 'proxy' ? '・代理' : r && r.entry_method === 'link' ? '・URL' : ''}</span>` }).join('') || '<span class="text-gray-400">勤怠報告なし</span>'}
        ${d.modes.daily_report_required ? `<span class="badge ${d.daily_report ? 'badge-green' : 'badge-gray'}">日報 ${d.daily_report ? '提出済み' : '未提出'}</span>` : '<span class="badge badge-gray">日報なし</span>'}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <label>このシフトの勤怠報告<select id="sr-att" class="inp text-xs" onchange="saveShiftReportSettings(${shiftId})">${opts({ '': 'スタッフ・案件の設定（' + (ATT_LABEL[d.modes.attendance_mode] || '') + '）', none: '勤怠報告なし', in_out: '入店・退店のみ', full: '起床・出発・入店・退店' }, d.shift_attendance_mode || '')}</select></label>
        <label>このシフトの日報<select id="sr-dr" class="inp text-xs" onchange="saveShiftReportSettings(${shiftId})">${opts({ '': 'スタッフ・案件の設定（' + (DR_LABEL[d.modes.daily_report_mode] || '') + '）', none: '日報なし', required: '日報あり' }, d.shift_daily_report_mode || '')}</select></label>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${d.token ? `<input class="inp text-[11px] flex-1 min-w-0" id="sr-url" readonly value="${esc(url)}">
          <button class="btn btn-primary text-xs" onclick="copyReportLink()"><i class="fas fa-copy"></i>コピー</button>
          <button class="btn btn-outline text-xs" onclick="revokeReportLink(${shiftId})" title="無効にする"><i class="fas fa-ban"></i></button>`
        : `<button class="btn btn-outline text-xs flex-1" onclick="issueReportLink(${shiftId})"><i class="fas fa-link"></i>報告用URLを発行（ログイン不要）</button>`}
        ${d.modes.required_attendance.some(t => !done.has(t)) ? `<button class="btn btn-outline text-xs" onclick="openProxyAttendance(${shiftId}, ${JSON.stringify(d.modes.required_attendance.filter(t => !done.has(t)))})"><i class="fas fa-user-pen"></i>代理入力</button>` : ''}
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
  window.openProxyAttendance = function (shiftId, types) {
    const box = document.getElementById('shift-report-box'); if (!box) return
    box.insertAdjacentHTML('beforeend', `<div class="p-2 rounded bg-amber-50 space-y-2" id="proxy-form">
      <p class="font-bold text-amber-800">代理入力（管理者が記録します。「代理入力」と表示されます）</p>
      <div class="flex flex-wrap gap-2">${types.map(t => `<label class="flex items-center gap-1"><input type="checkbox" class="px-type" value="${t}" ${['check_in', 'check_out'].includes(t) ? 'checked' : ''}>${RT_LABEL[t]}</label>`).join('')}</div>
      <label class="flex items-center gap-2">時刻<input id="px-time" type="time" class="inp text-xs w-auto"><span class="text-gray-400">空欄: 入店=開始時刻・退店=終了時刻</span></label>
      <button class="btn btn-primary text-xs w-full" onclick="submitProxyAttendance(${shiftId})">記録する</button></div>`)
    const btn = box.querySelector('button[onclick^="openProxyAttendance"]'); if (btn) btn.remove()
  }
  window.submitProxyAttendance = async function (shiftId) {
    const types = [...document.querySelectorAll('.px-type:checked')].map(el => el.value)
    if (!types.length) { toast('報告の種類を選択してください'); return }
    try { const { data } = await axios.post(`/api/admin/shifts/${shiftId}/proxy-attendance`, { report_types: types, time: document.getElementById('px-time').value }); toast(`${data.created}件を代理入力しました`); renderShiftReportPanel(shiftId) } catch (e) { toast(errMsg(e)) }
  }

  // =========================================================
  // 案件詳細: 提出設定の初期値
  // =========================================================
  window.renderProjectReportSettings = function (p) {
    const host = document.getElementById('project-report-settings'); if (!host) return
    host.innerHTML = `<div class="flex items-center justify-between flex-wrap gap-2">
      <div><h3 class="text-sm font-bold text-gray-700"><i class="fas fa-clipboard-check text-blue-500 mr-1"></i>勤怠・日報の提出設定（この案件の初期値）</h3>
        <p class="text-[11px] text-gray-400">スタッフごと・シフトごとに上書きできます。「不要」の報告は未報告アラートの対象外です</p></div>
      <div class="flex gap-2 items-end">
        <label class="text-xs text-gray-600">勤怠報告<select id="pr-att" class="inp text-sm">${opts({ none: '勤怠報告なし', in_out: '入店・退店のみ', full: '起床・出発・入店・退店' }, p.attendance_mode || 'full')}</select></label>
        <label class="text-xs text-gray-600">日報<select id="pr-dr" class="inp text-sm">${opts({ none: '日報なし', required: '日報あり' }, p.daily_report_mode || 'required')}</select></label>
        <button class="btn btn-outline text-xs" onclick="saveProjectReportSettings(${p.project_id})">保存</button>
      </div></div>`
  }
  window.saveProjectReportSettings = async function (pid) {
    try { await axios.put(`/api/admin/projects/${pid}/report-settings`, { attendance_mode: document.getElementById('pr-att').value, daily_report_mode: document.getElementById('pr-dr').value }); toast('提出設定を保存しました') } catch (e) { toast(errMsg(e)) }
  }
})()
