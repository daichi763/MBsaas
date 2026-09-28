// Field OS 管理画面: スタッフマスタ新規作成（4ルート）/ 企業間連携
// docs/spec_multi_company_staff.md フェーズC
// admin.js のヘルパー（modal / closeModal / toast / esc / renderStaff）を利用する。admin.js の後に読み込むこと。

const ROSTER_ROUTES = [
  { key: 'link', icon: 'fa-qrcode', color: 'text-blue-600', title: '① QRコード / スタッフIDから連携',
    desc: '他社（Field OS利用企業）に所属する既存スタッフを、スタッフIDで連携登録します。基本項目は所属元が管理し、自社では追記のみ可能です。' },
  { key: 'employee', icon: 'fa-id-card', color: 'text-emerald-600', title: '② 従業員管理から作成（自社雇用）',
    desc: '自社で雇用するスタッフを登録します。ログインアカウントと従業員管理（社員名簿）が作成されます。' },
  { key: 'partner', icon: 'fa-building', color: 'text-purple-600', title: '③ 取引先から作成',
    desc: '所属会社がField OSを利用していない場合に、取引先所属のスタッフとして登録します。' },
  { key: 'skillsheet', icon: 'fa-file-lines', color: 'text-gray-600', title: '④ スキルシートのみ作成',
    desc: '稼働管理は行わず、スキルシートの発行だけを目的に登録します。ログインアカウントは作成されません。' },
]

window.showAddRoster = function () {
  modal(`
    <h3 class="font-bold text-lg mb-1">スタッフマスタ 新規追加</h3>
    <p class="text-xs text-gray-500 mb-4">作成方法を選択してください</p>
    <div class="space-y-2">
      ${ROSTER_ROUTES.map(r => `
        <button class="w-full text-left p-3 rounded-xl border border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition" onclick="${r.key === 'link' ? 'showRosterLink()' : `showRosterForm('${r.key}')`}">
          <p class="font-bold text-sm text-gray-800"><i class="fas ${r.icon} ${r.color} w-5"></i>${r.title}</p>
          <p class="text-xs text-gray-500 mt-1 ml-5">${r.desc}</p>
        </button>`).join('')}
    </div>`)
}

// ---------- ① QR / ID 連携 ----------
window.showRosterLink = function (prefill) {
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-qrcode text-blue-600 mr-1"></i>スタッフIDから連携</h3>
    <p class="text-xs text-gray-500 mb-4">所属元企業から共有されたスタッフID（例: FS1A2B3C4D5E）を入力してください。</p>
    <div class="flex gap-2">
      <input id="rl-code" class="inp flex-1 font-mono uppercase" placeholder="FS..." value="${esc(prefill || '')}">
      <button class="btn btn-primary" onclick="lookupRosterCode()"><i class="fas fa-magnifying-glass"></i>検索</button>
    </div>
    <div id="rl-result" class="mt-4"></div>
    <button class="btn btn-outline w-full mt-4 text-xs" onclick="showAddRoster()"><i class="fas fa-arrow-left"></i>作成方法の選択に戻る</button>`)
  setTimeout(() => { const el = document.getElementById('rl-code'); if (el) el.focus() }, 50)
}

window.lookupRosterCode = async function () {
  const code = document.getElementById('rl-code').value.trim()
  const box = document.getElementById('rl-result')
  box.innerHTML = '<div class="flex justify-center py-4"><span class="spin"></span></div>'
  try {
    const { data } = await axios.get('/api/admin/roster/lookup', { params: { code } })
    const cand = data.candidate
    if (data.already_linked_staff_id) {
      box.innerHTML = `<div class="p-3 rounded-lg bg-amber-50 text-amber-700 text-sm">
        「${esc(cand.name)}」さんは既に連携済みです。<a class="underline font-bold" href="#staff/${data.already_linked_staff_id}" onclick="closeModal()">スタッフマスタを開く</a></div>`
      return
    }
    box.innerHTML = `
      <div class="p-3 rounded-xl border border-gray-200">
        <p class="text-xs text-gray-400">連携候補</p>
        <p class="font-bold text-gray-900">${esc(cand.name)} <span class="text-xs font-normal text-gray-400">${esc(cand.kana || '')}</span></p>
        <p class="text-xs text-gray-500 mt-1">所属元: ${esc(cand.owner_company_name)} ／ ID: <span class="font-mono">${esc(cand.global_staff_code)}</span></p>
      </div>
      <button class="btn btn-primary w-full mt-3" onclick='showRosterConsent(${JSON.stringify({ code: cand.global_staff_code, name: cand.name, owner: cand.owner_company_name, consent: data.consent }).replace(/'/g, '&#39;')})'>
        <i class="fas fa-link"></i>この人を連携登録する</button>`
  } catch (e) {
    box.innerHTML = `<div class="p-3 rounded-lg bg-red-50 text-red-600 text-sm">${esc((e.response && e.response.data && e.response.data.error) || '検索に失敗しました')}</div>`
  }
}

// 同意確認ポップアップ（連携のたびに毎回表示。同意結果はサーバー側で roster_consents に記録）
window.showRosterConsent = function (info) {
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-shield-halved text-blue-600 mr-1"></i>情報共有の同意確認</h3>
    <p class="text-sm text-gray-600 mb-3">「${esc(info.owner)}」に所属する <b>${esc(info.name)}</b> さんを自社のスタッフマスタに連携します。連携すると、以下の範囲の情報が所属元企業から共有されます。</p>
    <div class="grid sm:grid-cols-2 gap-3 text-xs">
      <div class="p-3 rounded-lg bg-blue-50">
        <p class="font-bold text-blue-700 mb-1"><i class="fas fa-check mr-1"></i>共有される情報（スタッフマスタ項目のみ）</p>
        <ul class="list-disc ml-4 text-blue-900 space-y-0.5">${info.consent.shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
      <div class="p-3 rounded-lg bg-gray-50">
        <p class="font-bold text-gray-600 mb-1"><i class="fas fa-ban mr-1"></i>共有されない情報</p>
        <ul class="list-disc ml-4 text-gray-600 space-y-0.5">${info.consent.not_shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
    <ul class="text-xs text-gray-500 mt-3 space-y-1">
      <li>・基本項目（氏名・スキル等）は所属元企業のみが編集でき、自社では閲覧のみとなります。</li>
      <li>・自社では評価・メモ・フォロー記録などの追記、およびシフト登録ができます。</li>
      <li>・共有情報は、スタッフの稼働管理の目的の範囲内でのみ利用してください。</li>
    </ul>
    <label class="flex items-start gap-2 mt-4 p-3 rounded-lg border border-gray-200 cursor-pointer">
      <input type="checkbox" id="rc-agree" class="mt-0.5" onchange="document.getElementById('rc-submit').disabled = !this.checked">
      <span class="text-sm text-gray-700">上記の共有範囲と利用条件を確認し、同意します（同意の記録は保存されます）</span>
    </label>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="showRosterLink('${esc(info.code)}')">戻る</button>
      <button id="rc-submit" class="btn btn-primary flex-1" disabled onclick='submitRosterLink(${JSON.stringify({ code: info.code, version: info.consent.version })})'>同意して連携する</button>
    </div>`)
}

window.submitRosterLink = async function (p) {
  if (!document.getElementById('rc-agree').checked) { toast('同意が必要です'); return }
  try {
    const { data } = await axios.post('/api/admin/roster/link', { code: p.code, agreed: true, consent_version: p.version })
    closeModal(); toast('スタッフマスタに連携登録しました')
    location.hash = 'staff/' + data.staff_id
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '連携に失敗しました') }
}

// ---------- ②③④ フォーム ----------
const ROSTER_FORM_TITLE = { employee: '② 従業員管理から作成（自社雇用）', partner: '③ 取引先から作成', skillsheet: '④ スキルシートのみ作成' }

window.showRosterForm = async function (route) {
  let partners = []
  if (route === 'partner') {
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners } catch { partners = [] }
  }
  const f = (id, label, attrs = '', req = false) =>
    `<div><label class="text-sm text-gray-600 block mb-1">${label}${req ? ' <span class="text-red-500">*</span>' : ''}</label><input id="${id}" class="inp" ${attrs}></div>`
  modal(`
    <h3 class="font-bold text-lg mb-4">${ROSTER_FORM_TITLE[route]}</h3>
    <div class="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
      ${route === 'partner' ? `
        <div class="p-3 rounded-lg bg-purple-50 space-y-2">
          <label class="text-sm text-gray-700 font-bold block">所属会社（取引先） <span class="text-red-500">*</span></label>
          <select id="rf-partner" class="inp" onchange="document.getElementById('rf-new-partner').classList.toggle('hidden', this.value !== 'new')">
            ${partners.map(p => `<option value="${p.affiliation_id}">${esc(p.affiliation_name)}（${p.staff_count}名）</option>`).join('')}
            <option value="new" ${partners.length ? '' : 'selected'}>＋ 新しい取引先を登録</option>
          </select>
          <div id="rf-new-partner" class="${partners.length ? 'hidden' : ''} grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input id="rf-np-name" class="inp" placeholder="取引先名 *">
            <input id="rf-np-contact" class="inp" placeholder="取引先担当者名">
            <input id="rf-np-phone" class="inp" placeholder="電話">
            <input id="rf-np-email" class="inp" placeholder="メール">
          </div>
        </div>` : ''}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${f('rf-name', '氏名', 'placeholder="山田 太郎"', true)}
        ${f('rf-kana', 'フリガナ', 'placeholder="ヤマダ タロウ"')}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-gray-600 block mb-1">性別 <span class="text-red-500">*</span></label>
          <select id="rf-gender" class="inp"><option value="">選択してください</option><option value="male">男性</option><option value="female">女性</option><option value="other">その他</option><option value="unspecified">回答しない</option></select></div>
        ${f('rf-dob', '生年月日', 'type="date"')}
      </div>
      ${route === 'employee' ? `
        <div class="p-3 rounded-lg bg-emerald-50 space-y-3">
          <p class="text-xs font-bold text-emerald-700"><i class="fas fa-key mr-1"></i>ログインアカウント（勤怠報告・日報用）</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${f('rf-code', 'スタッフ番号', 'placeholder="st021"', true)}
            ${f('rf-pass', '初期パスワード', 'value="pass1234"', true)}
            ${f('rf-email', 'メール')}
            ${f('rf-phone', '電話')}
          </div>
          <p class="text-xs font-bold text-emerald-700 pt-1"><i class="fas fa-id-card mr-1"></i>従業員管理（詳細は登録後に従業員管理画面で入力）</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            ${f('rf-empno', '社員番号')}
            ${f('rf-hire', '入社年月日', 'type="date"')}
            ${f('rf-contract', '契約形態', 'placeholder="正社員 / 契約社員 等"')}
          </div>
        </div>` : ''}
      ${route === 'partner' ? `
        <details class="p-3 rounded-lg border border-gray-200">
          <summary class="text-sm text-gray-600 cursor-pointer">ログインアカウントを発行する（任意・勤怠報告を行う場合）</summary>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            ${f('rf-code', 'スタッフ番号', 'placeholder="pt001"')}
            ${f('rf-pass', '初期パスワード')}
            ${f('rf-email', 'メール')}
            ${f('rf-phone', '電話')}
          </div>
        </details>
        ${f('rf-aff-contact', '所属先担当者名')}` : ''}
      ${route === 'skillsheet' ? f('rf-affiliation', '所属会社名（任意・スキルシート表示用）') : ''}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${f('rf-skills', 'スキル（カンマ区切り）', 'placeholder="MNP,接客"')}
        ${f('rf-area', '稼働可能エリア', 'placeholder="東京23区"')}
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">経歴</label><textarea id="rf-career" rows="2" class="inp"></textarea></div>
      ${route !== 'skillsheet' ? `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          ${f('rf-line', '最寄駅（路線）')}
          ${f('rf-station', '最寄駅（駅）')}
          ${f('rf-available', '稼働開始可能日', 'type="date"')}
        </div>` : ''}
      <p class="text-xs text-gray-400"><span class="text-red-500">*</span> は必須項目です（氏名・性別は全企業共通の必須項目）</p>
    </div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline" onclick="showAddRoster()"><i class="fas fa-arrow-left"></i></button>
      <button class="btn btn-primary flex-1" onclick="submitRosterForm('${route}')">登録する</button>
    </div>`)
}

window.submitRosterForm = async function (route) {
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  const body = {
    route, name: v('rf-name'), kana: v('rf-kana'), gender: v('rf-gender'), date_of_birth: v('rf-dob') || null,
    skills: v('rf-skills'), work_area: v('rf-area'), career: v('rf-career'),
    nearest_station_line: v('rf-line'), nearest_station: v('rf-station'), available_from: v('rf-available') || null,
    user_code: v('rf-code'), password: v('rf-pass'), email: v('rf-email'), phone: v('rf-phone'),
    employee_number: v('rf-empno'), hire_date: v('rf-hire') || null, contract_type: v('rf-contract'),
    affiliation_contact: v('rf-aff-contact'), affiliation: v('rf-affiliation'),
  }
  if (!body.name) { toast('氏名を入力してください'); return }
  if (!body.gender) { toast('性別を選択してください'); return }
  if (route === 'partner') {
    const sel = v('rf-partner')
    if (sel && sel !== 'new') body.partner_affiliation_id = Number(sel)
    else {
      body.new_partner_name = v('rf-np-name'); body.new_partner_contact = v('rf-np-contact')
      body.new_partner_phone = v('rf-np-phone'); body.new_partner_email = v('rf-np-email')
      if (!body.new_partner_name) { toast('取引先名を入力してください'); return }
    }
    if ((body.user_code && !body.password) || (!body.user_code && body.password)) { toast('ログインを発行する場合はスタッフ番号と初期パスワードの両方を入力してください'); return }
  }
  try {
    const { data } = await axios.post('/api/admin/roster', body)
    closeModal(); toast('スタッフマスタに登録しました')
    location.hash = (route === 'employee' ? 'employees/' : 'staff/') + data.staff_id
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '登録に失敗しました') }
}

// 画面遷移（hash変更）時に開いたままの作成モーダルを閉じる
window.addEventListener('hashchange', () => { if (typeof closeModal === 'function') closeModal() })
