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
// 検索した候補と同意画面の値（ボタンの onclick に値を埋め込まないため、ここに保持して data-action から呼ぶ）
const ROSTER_LINK = { candidate: null, consent: null }
delegate('rosterConsent', () => { if (ROSTER_LINK.candidate) showRosterConsent(ROSTER_LINK.candidate) })
delegate('rosterLinkBack', () => showRosterLink(ROSTER_LINK.consent ? ROSTER_LINK.consent.code : ''))
delegate('rosterLinkSubmit', (el) => { if (ROSTER_LINK.consent) submitRosterLink(ROSTER_LINK.consent, el) })
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
    // 他社が登録した氏名・会社名を含むため、onclick に埋め込まずここに保持する
    ROSTER_LINK.candidate = { code: cand.global_staff_code, name: cand.name, owner: cand.owner_company_name, consent: data.consent }
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
      <button class="btn btn-primary w-full mt-3" data-action="rosterConsent">
        <i class="fas fa-link"></i>この人を連携登録する</button>`
  } catch (e) {
    box.innerHTML = `<div class="p-3 rounded-lg bg-red-50 text-red-600 text-sm">${esc((e.response && e.response.data && e.response.data.error) || '検索に失敗しました')}</div>`
  }
}

// 同意確認ポップアップ（連携のたびに毎回表示。同意結果はサーバー側で roster_consents に記録）
window.showRosterConsent = function (info) {
  ROSTER_LINK.consent = { code: info.code, version: info.consent.version }
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
      <button class="btn btn-outline flex-1" data-action="rosterLinkBack">戻る</button>
      <button id="rc-submit" class="btn btn-primary flex-1" disabled data-action="rosterLinkSubmit">同意して連携する</button>
    </div>`)
}

// 送信中はボタンを止める（二度押しで同じ人が二重に連携されないように。#238）
window.submitRosterLink = async function (p, button) {
  if (!document.getElementById('rc-agree').checked) { toast('同意が必要です'); return }
  await withSubmitLock(button || document.getElementById('rc-submit'), async () => {
    try {
      const { data } = await axios.post('/api/admin/roster/link', { code: p.code, agreed: true, consent_version: p.version })
      closeModal(); toast('スタッフマスタに連携登録しました')
      location.hash = 'staff/' + data.staff_id
    } catch (e) { showApiError(e, '連携に失敗しました') }
  })
}

// ---------- ②③④ フォーム ----------
const ROSTER_FORM_TITLE = { employee: '② 従業員管理から作成（自社雇用）', partner: '③ 取引先から作成', skillsheet: '④ スキルシートのみ作成' }

window.showRosterForm = async function (route) {
  let partners = []
  if (route === 'partner') {
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners } catch { partners = [] }
  }
  // 空いているスタッフ番号（#424）。②は番号欄に入れておき、③（ログインは任意）は例として出す
  let next = null
  if (route !== 'skillsheet') { try { next = (await axios.get('/api/admin/roster/next-code')).data } catch { next = null } }
  const nextHint = next && next.last_code ? `<p class="text-[11px] text-gray-400 sm:col-span-2 -mt-2">空いている番号を入れています（最後の番号: ${esc(next.last_code)}）。変えることもできます</p>` : ''
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
            ${f('rf-code', 'スタッフ番号', `placeholder="st021" value="${esc(next ? next.code : '')}"`, true)}
            ${f('rf-pass', '初期パスワード', 'autocomplete="new-password" placeholder="8文字以上"', true)}
            ${route === 'employee' ? nextHint : ''}
            ${f('rf-email', 'メール', 'type="email"')}
            ${f('rf-phone', '電話', 'type="tel"')}
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
            ${f('rf-code', 'スタッフ番号', `placeholder="${esc(next ? '空いている番号: ' + next.code : 'pt001')}" data-suggested="${esc(next ? next.code : '')}"`)}
            ${f('rf-pass', '初期パスワード', 'autocomplete="new-password" placeholder="8文字以上"')}
            ${f('rf-email', 'メール', 'type="email"')}
          </div>
        </details>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${f('rf-phone', '電話', 'type="tel"')}
          ${f('rf-aff-contact', '所属先担当者名')}
        </div>` : ''}
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
        </div>
        ${f('rf-commute', '通勤可能時間（分）', 'type="number" min="0" max="1440" step="1"')}` : ''}
      <p class="text-xs text-gray-400"><span class="text-red-500">*</span> は必須項目です（氏名・性別は全企業共通の必須項目）</p>
    </div>
    <div id="rf-dup"></div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline" data-action="showAddRoster"><i class="fas fa-arrow-left"></i></button>
      <button class="btn btn-primary flex-1" data-action="submitRosterForm" data-route="${esc(route)}">登録する</button>
    </div>`)
}
delegate('showAddRoster', () => showAddRoster())
// 送信中はボタンを無効にして二重登録を防ぐ（submitRosterForm は下で必須確認付きに差し替えるため、呼ぶときに window から引く）
delegate('submitRosterForm', el => withSubmitLock(el, () => window.submitRosterForm(el.dataset.route)))
// 同じ人の確認で「別の人として登録する」を選んだとき（#223）
delegate('submitRosterFormForce', el => withSubmitLock(el, () => window.submitRosterForm(el.dataset.route, true)))

// 同じ人と思われる登録済みのスタッフの一覧（#223 #356）。退職・停止中は印を付ける
window.samePersonListHtml = function (matches) {
  return matches.map(m => `<li class="flex items-center gap-2 flex-wrap">
    <a class="underline font-bold" href="#staff/${Number(m.staff_id)}">${esc(m.name)}</a>
    <span class="text-gray-500">${esc((typeof AFF_TYPE_LABEL !== 'undefined' && AFF_TYPE_LABEL[m.affiliation_type]) || m.affiliation_type || '')}${m.is_provisional ? '・仮登録' : ''}</span>
    ${m.inactive ? `<span class="badge badge-red">${esc(m.inactive)}</span>` : ''}
    <span class="text-gray-400">${(m.reasons || []).map(esc).join('・')}</span></li>`).join('')
}
function showRosterDuplicate(route, matches) {
  const box = document.getElementById('rf-dup'); if (!box) return
  box.innerHTML = `<div class="mt-3 p-3 rounded-lg bg-amber-50 text-xs text-amber-800" id="rf-dup-box">
    <p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>同じ人と思われるスタッフが登録済みです</p>
    <ul class="space-y-1 mb-2">${samePersonListHtml(matches)}</ul>
    <p class="mb-2">同じ人なら、登録せずに既存のスタッフを開いてください（退職の人は、スタッフ詳細で在籍状況を戻すと再び使えます）。
      誤って二重に登録したときは、シフトのない側をスタッフ詳細の「既存のスタッフに統合」でまとめられます</p>
    <button class="btn btn-outline text-xs" data-action="submitRosterFormForce" data-route="${esc(route)}">別の人として登録する</button></div>`
  box.scrollIntoView && box.scrollIntoView({ block: 'nearest' })
}

window.submitRosterForm = async function (route, force) {
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  const body = {
    route, name: v('rf-name'), kana: v('rf-kana'), gender: v('rf-gender'), date_of_birth: v('rf-dob') || null,
    skills: v('rf-skills'), work_area: v('rf-area'), career: v('rf-career'),
    nearest_station_line: v('rf-line'), nearest_station: v('rf-station'), available_from: v('rf-available') || null,
    commute_minutes: v('rf-commute') ? Number(v('rf-commute')) : null,
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
    // 初期パスワードだけ入れたときは、空いている番号を使う（#424）
    const codeEl = document.getElementById('rf-code')
    if (!body.user_code && body.password && codeEl && codeEl.dataset.suggested) { body.user_code = codeEl.dataset.suggested; codeEl.value = body.user_code }
    if ((body.user_code && !body.password) || (!body.user_code && body.password)) { toast('ログインを発行する場合はスタッフ番号と初期パスワードの両方を入力してください'); return }
  }
  if (force) body.force = true
  try {
    const { data } = await axios.post('/api/admin/roster', body)
    closeModal(); toast('スタッフマスタに登録しました')
    location.hash = (route === 'employee' ? 'employees/' : 'staff/') + data.staff_id
  } catch (e) {
    const d = e.response && e.response.data
    if (d && d.need_force && d.matches) { showRosterDuplicate(route, d.matches); return }
    // スタッフ番号が使われていたら、空いている番号を入れ直す（#424）
    if (d && d.suggested_code) { const el = document.getElementById('rf-code'); if (el) el.value = d.suggested_code; toast(`スタッフ番号が使われています。空いている番号（${d.suggested_code}）を入れました`); return }
    toast((d && d.error) || '登録に失敗しました')
  }
}

// 画面遷移（hash変更）時に開いたままの作成モーダルを閉じる
window.addEventListener('hashchange', () => { if (typeof closeModal === 'function') closeModal() })

// =========================================================
// フェーズD: 必須項目の企業別設定
// =========================================================
let ROSTER_REQUIRED = null // { code: true } のキャッシュ（フォームの * 表示用）
async function loadRosterRequired(force) {
  if (ROSTER_REQUIRED && !force) return ROSTER_REQUIRED
  try {
    const { data } = await axios.get('/api/admin/roster/field-settings')
    ROSTER_REQUIRED = Object.fromEntries(data.fields.filter(f => f.is_required).map(f => [f.code, true]))
    ROSTER_REQUIRED.__meta = data
  } catch { ROSTER_REQUIRED = {} }
  return ROSTER_REQUIRED
}

window.showRosterFieldSettings = async function () {
  const req = await loadRosterRequired(true)
  const data = req.__meta
  const canEdit = ME && ['company_admin', 'system_admin'].includes(ME.role)
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-sliders text-blue-600 mr-1"></i>スタッフマスタ 必須項目の設定</h3>
    <p class="text-xs text-gray-500 mb-4">新規作成時・基本項目の更新時に入力を必須にする項目を選択します。登録済みのスタッフで未入力の人は「未入力のスタッフを確認」で一覧できます。${canEdit ? '' : '<br><span class="text-red-500">変更は会社管理者のみ可能です</span>'}</p>
    <p class="text-xs font-bold text-gray-500 mb-1">常に必須（変更不可）</p>
    <div class="flex gap-2 mb-4">${data.absolute.map(f => `<span class="badge badge-red">${esc(f.label)}</span>`).join('')}</div>
    <p class="text-xs font-bold text-gray-500 mb-1">企業ごとに設定</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      ${data.fields.map(f => {
        // 対象の説明（例: 所属先担当者名は③取引先のみ、メールはログインのある人のみ、④スキルシートのみは対象外）
        const scope = [f.note, f.skillsheet || f.only ? '' : '④対象外'].filter(Boolean).join('・')
        return `
        <label class="flex items-center gap-2 p-2 rounded-lg border border-gray-200 ${canEdit ? 'cursor-pointer' : 'opacity-70'}">
          <input type="checkbox" class="rq-field" data-code="${esc(f.code)}" ${f.is_required ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
          <span class="text-sm">${esc(f.label)}</span>
          ${scope ? `<span class="text-[10px] text-gray-400 ml-auto">${esc(scope)}</span>` : ''}
        </label>`
      }).join('')}
    </div>
    <p class="text-xs text-gray-400 mt-3">※ ①QR/ID連携で登録したスタッフの基本項目は所属元企業が管理するため、自社の必須設定は適用されません。</p>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" data-action="showRosterMissing">未入力のスタッフを確認</button>
      ${canEdit ? '<button class="btn btn-primary flex-1" data-action="saveRosterFieldSettings">保存する</button>' : ''}
    </div>`)
}
delegate('saveRosterFieldSettings', el => withSubmitLock(el, () => saveRosterFieldSettings()))
delegate('showRosterMissing', el => withSubmitLock(el, () => showRosterMissing()))
window.saveRosterFieldSettings = async function () {
  const required = {}
  document.querySelectorAll('.rq-field').forEach(el => { required[el.dataset.code] = el.checked })
  try {
    await axios.put('/api/admin/roster/field-settings', { required })
    await loadRosterRequired(true)
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '保存に失敗しました'); return }
  toast('必須項目の設定を保存しました')
  // 必須にした項目が未入力の既存スタッフがいれば一覧で知らせる（新規作成・更新時にしか確認しないため）
  await showRosterMissing({ afterSave: true })
}

// 必須項目が未入力の既存スタッフの一覧（必須を後から ON にしたときの確認用）
window.showRosterMissing = async function (opts) {
  const afterSave = opts && opts.afterSave
  let data
  try { data = (await axios.get('/api/admin/roster/field-settings/missing')).data }
  catch (e) { if (afterSave) closeModal(); toast((e.response && e.response.data && e.response.data.error) || '未入力のスタッフを取得できませんでした'); return }
  if (!data.count) {
    if (afterSave) { closeModal(); return }
    toast('必須項目が未入力のスタッフはいません'); return
  }
  const link = s => (s.affiliation_type === 'own_employee' ? '#employees/' : '#staff/') + Number(s.staff_id)
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-triangle-exclamation text-amber-500 mr-1"></i>必須項目が未入力のスタッフ</h3>
    <p class="text-sm text-gray-600 mb-3">既存スタッフのうち <b>${Number(data.count)}名</b> が未入力です。${data.truncated ? `（先頭の${Number(data.staff.length)}名を表示）` : ''}<br>
      <span class="text-xs text-gray-400">他社連携・退職・統合済みのスタッフは対象外です。名前を押すと詳細を開きます。</span></p>
    <div class="max-h-[60vh] overflow-y-auto">
      <table class="tbl">
        <thead><tr><th>氏名</th><th>区分</th><th>未入力の項目</th></tr></thead>
        <tbody>${data.staff.map(s => `
          <tr>
            <td><a class="text-blue-700 hover:underline" href="${link(s)}">${esc(s.name)}</a></td>
            <td class="text-xs">${esc((typeof AFF_TYPE_LABEL !== 'undefined' && AFF_TYPE_LABEL[s.affiliation_type]) || s.affiliation_type)}</td>
            <td class="text-xs text-red-600">${s.missing.map(esc).join('・')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <button class="btn btn-outline w-full mt-4" onclick="closeModal()">閉じる</button>`)
}

// 作成フォームの必須項目（showRosterForm の描画後に * を付け、送信前に確認する。サーバーの missingRequired と同じ考え方）
const RF_FIELD_IDS = { kana: 'rf-kana', date_of_birth: 'rf-dob', affiliation_contact: 'rf-aff-contact', phone: 'rf-phone', email: 'rf-email',
  skills: 'rf-skills', career: 'rf-career', work_area: 'rf-area', nearest_station_line: 'rf-line', nearest_station: 'rf-station',
  available_from: 'rf-available', commute_minutes: 'rf-commute' }
const RF_ROUTE_TYPE = { employee: 'own_employee', partner: 'partner_manual', skillsheet: 'skillsheet_only' }
// この作成方法で、その項目に必須設定を当てはめるか。hasLogin が未指定なら、ログインのある人だけの項目も当てはめる
function rfRequirementApplies(code, route, hasLogin) {
  const meta = ROSTER_REQUIRED && ROSTER_REQUIRED.__meta
  const f = meta && meta.fields.find(x => x.code === code)
  if (!f) return false
  const type = RF_ROUTE_TYPE[route]
  if (type === 'skillsheet_only' && !f.skillsheet) return false
  if (f.only && !f.only.includes(type)) return false
  if (f.login_only && hasLogin === false) return false
  return true
}
function markRequiredInForm(route) {
  const req = ROSTER_REQUIRED || {}
  for (const [code, id] of Object.entries(RF_FIELD_IDS)) {
    if (!req[code] || !rfRequirementApplies(code, route)) continue
    const el = document.getElementById(id); if (!el) continue
    const label = el.parentElement && el.parentElement.querySelector('label')
    if (label && !label.querySelector('.req-mark')) label.insertAdjacentHTML('beforeend', ' <span class="text-red-500 req-mark">*</span>')
  }
}
const _origShowRosterForm = window.showRosterForm
window.showRosterForm = async function (route) {
  await loadRosterRequired(true)
  await _origShowRosterForm(route)
  markRequiredInForm(route)
}
const _origSubmitRosterForm = window.submitRosterForm
window.submitRosterForm = async function (route, force) {
  const req = ROSTER_REQUIRED || {}
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  // ログイン: ②は必ず作る、③はスタッフ番号と初期パスワードを入れたときだけ、④は作らない
  const hasLogin = route === 'employee' || (route === 'partner' && !!val('rf-code') && !!val('rf-pass'))
  const lacks = []
  for (const [code, id] of Object.entries(RF_FIELD_IDS)) {
    if (!req[code] || !rfRequirementApplies(code, route, hasLogin)) continue
    const el = document.getElementById(id)
    if (el && !el.value.trim()) lacks.push(el.parentElement.querySelector('label').textContent.replace('*', '').trim())
  }
  if (lacks.length) { toast('次の項目は必須です: ' + lacks.join('・')); return }
  return _origSubmitRosterForm(route, force)
}

// =========================================================
// フェーズE: QRコード（恒久固定）の表示 / カメラで読み取り
// =========================================================
// 連携用IDのコピー（メール・チャットで離れた稼働先に送れるように。#475）
delegate('copyShareCode', async (el) => {
  const code = el.dataset.code || ''
  try { await navigator.clipboard.writeText(code); toast('スタッフIDをコピーしました') } catch {
    const ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta); ta.select()
    try { document.execCommand && document.execCommand('copy'); toast('スタッフIDをコピーしました') } catch { toast('コピーできませんでした') }
    ta.remove()
  }
})
function qrSvg(text, cell) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make()
  return qr.createSvgTag({ cellSize: cell || 6, margin: 2, scalable: true })
}
window.showShareQr = async function (sid) {
  try {
    const { data } = await axios.get(`/api/admin/roster/${sid}/share-code`)
    modal(`
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-bold text-lg"><i class="fas fa-qrcode text-blue-600 mr-1"></i>連携用QRコード</h3>
        <button class="btn btn-outline text-xs" onclick="window.print()"><i class="fas fa-print"></i>印刷</button>
      </div>
      <div class="text-center">
        <div class="w-56 h-56 mx-auto">${qrSvg(data.global_staff_code)}</div>
        <p class="font-mono text-xl font-bold tracking-widest mt-2">${esc(String(data.global_staff_code || '').replace(/(.{4})(?=.)/g, '$1 '))}</p>
        <p class="text-sm text-gray-700 mt-1">${esc(data.name)}（${esc(data.company_name)}）</p>
        <button class="btn btn-outline text-xs mt-2" data-action="copyShareCode" data-code="${esc(data.global_staff_code)}"><i class="fas fa-copy"></i>IDをコピー</button>
      </div>
      <ul class="text-xs text-gray-500 mt-4 space-y-1">
        <li>・このQRコード / スタッフIDは${data.relink ? '自社から連携するための専用コードで、固定です' : '恒久固定です（再発行・有効期限・取り消しはありません）'}。IDを渡した企業はいつでも連携できるため、渡す相手を確かめてください。</li>
        <li>・稼働先企業が「スタッフマスタ → 新規追加 → ① QRコード / スタッフIDから連携」で読み取ると、スタッフマスタ項目（氏名・生年月日・最寄駅・スキル・経歴のほか、「経験・スキル・人柄・PRポイント等」「備考」を含む）が共有されます。</li>
        <li>・連携先から見える所属元は${data.relink ? '自社（' + esc(data.company_name) + '）のみです。自社の所属元の企業名は連携先には表示されません' : '自社のみです。連携先がさらに別の企業へ連携しても、その先の企業から見える所属元は直前の企業だけです'}。</li>
        <li>・従業員管理の情報（給与・口座・社会保険等）は共有されません。</li>
      </ul>`)
  } catch (e) { toast((e.response && e.response.data && e.response.data.error) || '取得に失敗しました') }
}

let qrStream = null
function stopQrScan() {
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null }
}
window.startQrScan = async function () {
  const box = document.getElementById('rl-scan')
  if (!box) return
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('この端末ではカメラを利用できません。IDを入力してください'); return }
  box.innerHTML = `<video id="rl-video" class="w-full rounded-lg bg-black" playsinline muted></video>
    <p class="text-xs text-gray-500 mt-1 text-center">QRコードを枠内に映してください（画像はサーバーに送信されません）</p>
    <button class="btn btn-outline w-full mt-2 text-xs" onclick="stopQrScanUi()">カメラを停止</button>`
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  } catch { box.innerHTML = ''; toast('カメラへのアクセスが許可されませんでした'); return }
  const video = document.getElementById('rl-video'); video.srcObject = qrStream; await video.play()
  const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const tick = () => {
    if (!qrStream || !document.getElementById('rl-video')) { stopQrScan(); return }
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const hit = window.jsQR && jsQR(img.data, img.width, img.height)
      if (hit && hit.data) {
        stopQrScan(); box.innerHTML = ''
        document.getElementById('rl-code').value = hit.data.trim()
        lookupRosterCode(); return
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
window.stopQrScanUi = function () { stopQrScan(); const b = document.getElementById('rl-scan'); if (b) b.innerHTML = '' }
window.addEventListener('hashchange', stopQrScan)

// ① のモーダルにカメラ読み取りボタンを追加
const _origShowRosterLink = window.showRosterLink
window.showRosterLink = function (prefill) {
  _origShowRosterLink(prefill)
  const res = document.getElementById('rl-result')
  if (res) res.insertAdjacentHTML('beforebegin', `
    <button class="btn btn-outline w-full mt-2" onclick="startQrScan()"><i class="fas fa-camera"></i>カメラでQRコードを読み取る</button>
    <div id="rl-scan" class="mt-2"></div>`)
}
const _origCloseModal = window.closeModal
window.closeModal = function () { stopQrScan(); _origCloseModal() }

// =========================================================
// フェーズE/F: スタッフ詳細への追加パネル（連携状況・共有追記項目・同意履歴）
// admin.js の renderStaffDetail 描画後に呼び出される
// =========================================================
window.renderRosterPanels = async function (sid, p) {
  const host = document.getElementById('roster-panels')
  if (!host) return
  let links = null
  try { links = (await axios.get(`/api/admin/roster/${sid}/links`)).data } catch { links = null }
  // 連携の終了・再開の確認に出す企業名（ボタンに埋め込まない）
  ROSTER_PANEL_LINKS = (links && links.links) || []
  const hostNotes = p.affiliation_type === 'linked_external' ? `
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-pen-to-square text-emerald-500 mr-1"></i>稼働先追記項目</h3>
      <p class="text-xs text-gray-400 mb-3">ここに記入した内容は所属元「${esc(p.owner_company_name || '')}」も閲覧できます（スタッフ本人には表示されません）。社内だけのメモは「管理者メモ」に記入してください。</p>
      <label class="text-xs text-gray-500 block mb-1">現場評価</label>
      <textarea id="host-site-eval" rows="2" class="inp text-xs mb-2">${esc(p.site_evaluation || '')}</textarea>
      <label class="text-xs text-gray-500 block mb-1">稼働メモ</label>
      <textarea id="host-work-memo" rows="2" class="inp text-xs">${esc(p.work_memo || '')}</textarea>
      <div class="flex items-center justify-between mt-2">
        <span class="text-[11px] text-gray-400">${p.host_note_updated_at ? '最終更新 ' + esc(p.host_note_updated_at) : ''}</span>
        <button class="btn btn-outline text-xs" data-action="saveHostNotes" data-sid="${Number(sid)}">保存</button>
      </div>
    </section>` : ''
  let linkHtml = ''
  if (links && (links.role === 'owner' || (links.role === 'host' && links.links && links.links.length))) {
    linkHtml = `
      <section class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold text-gray-700"><i class="fas fa-link text-blue-500 mr-1"></i>連携先企業（自社から連携した稼働先）</h3>
          ${p.link_shareable ? `<button class="btn btn-outline text-xs" onclick="showShareQr(${sid})"><i class="fas fa-qrcode"></i>連携用QR</button>` : ''}
        </div>
        ${links.links.length ? links.links.map(l => `
          <div class="p-2.5 rounded-lg ${l.link_revoked_at ? 'bg-gray-100 opacity-80' : 'bg-gray-50'} mb-2">
            <div class="flex items-center gap-2 text-xs flex-wrap">
              <span class="font-bold text-gray-800">${esc(l.host_company_name)}</span>
              <span class="text-gray-400">連携 ${esc((l.consented_at || l.linked_at || '').slice(0, 10))}</span>
              ${l.link_revoked_at ? `<span class="badge badge-gray">連携終了 ${esc(String(l.link_revoked_at).slice(0, 10))}${l.revoked_by_name ? '（' + esc(l.revoked_by_name) + '）' : ''}</span>` : '<span class="badge badge-green">共有中</span>'}
              <span class="ml-auto text-gray-500">今月の稼働 ${Number(l.month_days) || 0}日${Number(l.month_planned_days) > Number(l.month_days) ? `（予定を含め ${Number(l.month_planned_days)}日）` : ''} / 最終稼働 ${l.last_work_date ? dayjs(l.last_work_date).format('M/D') : '-'}</span>
            </div>
            ${l.site_evaluation || l.work_memo ? `
              <p class="text-xs text-gray-700 mt-1 whitespace-pre-wrap break-words"><span class="text-gray-400">現場評価:</span> ${esc(l.site_evaluation || '-')}</p>
              <p class="text-xs text-gray-700 whitespace-pre-wrap break-words"><span class="text-gray-400">稼働メモ:</span> ${esc(l.work_memo || '-')}</p>
              ${l.host_note_updated_at ? `<p class="text-[11px] text-gray-400">更新 ${esc(String(l.host_note_updated_at).slice(0, 16))}</p>` : ''}` : '<p class="text-xs text-gray-400 mt-1">稼働先からの追記はまだありません</p>'}
            ${(l.history || []).length > 1 ? `<details class="mt-1"><summary class="text-[11px] text-blue-600 cursor-pointer">変更の履歴（${l.history.length}件${l.history.length >= 10 ? '・新しい10件' : ''}）</summary>
              <div class="mt-1 space-y-1">${l.history.map(h => `<div class="text-[11px] text-gray-600 border-l-2 border-gray-200 pl-2">
                <p class="text-gray-400">${esc(String(h.created_at || '').slice(0, 16))}</p>
                <p class="whitespace-pre-wrap break-words">現場評価: ${esc(h.site_evaluation || '-')}</p>
                <p class="whitespace-pre-wrap break-words">稼働メモ: ${esc(h.work_memo || '-')}</p></div>`).join('')}</div></details>` : ''}
            <div class="flex justify-end mt-1">${l.link_revoked_at
              ? (p.link_shareable ? `<button class="btn btn-outline text-xs" data-action="rosterResumeLink" data-sid="${Number(sid)}" data-linked="${Number(l.linked_staff_id)}"><i class="fas fa-rotate-left"></i>連携を再開</button>` : '')
              : `<button class="btn btn-outline text-xs text-red-600" data-action="rosterEndLink" data-sid="${Number(sid)}" data-linked="${Number(l.linked_staff_id)}"><i class="fas fa-link-slash"></i>連携を終了</button>`}</div>
          </div>`).join('') : `<p class="text-sm text-gray-400">${!p.linkable ? '連携対象外のスタッフです' : p.link_shareable ? 'まだ他社には連携されていません' : '退職・停止中のため、新しく連携することはできません'}</p>`}
        <p class="text-[11px] text-gray-400 mt-1">稼働先の追記内容は閲覧のみです（編集は稼働先企業が行います）。<a href="#roster-notes" class="text-blue-600 hover:underline">連携先からの追記の一覧</a></p>
      </section>`
  }
  if (links && links.role === 'host') {
    linkHtml += `
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-shield-halved text-blue-500 mr-1"></i>連携の同意履歴</h3>
        ${links.link_revoked_at ? `<div class="p-2.5 rounded-lg bg-red-50 text-red-700 text-xs mb-2"><i class="fas fa-link-slash mr-1"></i>所属元の企業が ${esc(String(links.link_revoked_at).slice(0, 16))} に連携を終了しました。基本項目は表示されず、新しいシフトには割り当てられません。</div>` : ''}
        ${links.consents.map(x => `
          <div class="p-2.5 rounded-lg bg-gray-50 mb-2 text-xs">
            <p><span class="font-bold">${esc(x.agreed_by || '-')}</span> が同意 <span class="text-gray-400">${esc((x.created_at || '').slice(0, 16))}</span> <span class="badge badge-gray">${esc(x.consent_version)}</span></p>
            <p class="text-gray-500 mt-1">共有範囲: ${esc(Array.isArray(x.shared_scope) ? x.shared_scope.join('・') : x.shared_scope)}</p>
          </div>`).join('') || '<p class="text-sm text-gray-400">記録がありません</p>'}
      </section>`
  }
  host.innerHTML = hostNotes + linkHtml
  host.classList.toggle('hidden', !(hostNotes || linkHtml))
}
window.saveHostNotes = async function (sid) {
  try {
    await axios.put('/api/admin/staff/' + sid, {
      site_evaluation: document.getElementById('host-site-eval').value,
      work_memo: document.getElementById('host-work-memo').value,
    })
    toast('稼働先追記項目を保存しました（所属元にも通知されます）')
  } catch (e) { showApiError(e, '保存に失敗しました') }
}
delegate('saveHostNotes', el => withSubmitLock(el, () => saveHostNotes(Number(el.dataset.sid))))

// =========================================================
// 連携先からの追記の一覧（#538）: 自社から連携した稼働先が書いた現場評価・稼働メモの変更を新しい順に
// =========================================================
const HOST_NOTES_VIEW = { unseen: false, offset: 0 }
window.renderRosterHostNotes = async function () {
  loading()
  let d
  try { d = (await axios.get('/api/admin/roster/host-notes', { params: { unseen: HOST_NOTES_VIEW.unseen ? 1 : undefined, offset: HOST_NOTES_VIEW.offset || undefined } })).data } catch (e) {
    $app.innerHTML = `<div class="card p-6 text-center text-sm text-red-500">${esc(showApiError(e, '読み込みに失敗しました'))}</div>`; return
  }
  const diff = (label, now, prev, first) => `<p class="text-sm whitespace-pre-wrap break-words"><span class="text-xs text-gray-400">${label}:</span> ${esc(now || '-')}</p>
    ${!first && (prev || '') !== (now || '') ? `<p class="text-[11px] text-gray-400 whitespace-pre-wrap break-words line-through">前: ${esc(prev || '（空欄）')}</p>` : ''}`
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">連携先からの追記</h2>
      <div class="flex items-center gap-2">
        <label class="text-xs text-gray-600 flex items-center gap-1"><input type="checkbox" id="hn-unseen" ${HOST_NOTES_VIEW.unseen ? 'checked' : ''}>未確認だけ</label>
        <button class="btn btn-outline text-xs" data-action="hostNotesSeen" ${d.unseen_count ? '' : 'disabled'}><i class="fas fa-check-double"></i>すべて確認済みにする</button>
      </div>
    </div>
    <p class="text-xs text-gray-500 mb-4">自社から連携した稼働先の企業が書いた「現場評価」「稼働メモ」の変更です（未確認 ${Number(d.unseen_count) || 0}件）。スタッフ本人には表示されません。</p>
    <div class="space-y-2">
      ${d.notes.map(n => `
        <section class="card p-3 ${n.unseen ? 'border-l-4 border-blue-500' : ''}">
          <div class="flex items-center gap-2 flex-wrap text-xs mb-1">
            ${n.unseen ? '<span class="badge badge-blue">未確認</span>' : ''}
            <a href="#staff/${Number(n.staff_id)}" class="font-bold text-blue-700 hover:underline text-sm">${esc(n.staff_name || '')}</a>
            <span class="text-gray-500">${esc(n.host_company_name || '')}</span>
            <span class="text-gray-400 ml-auto">${esc(String(n.created_at || '').slice(0, 16))}</span>
          </div>
          ${diff('現場評価', n.site_evaluation, n.prev_site_evaluation, n.prev_site_evaluation == null && n.prev_work_memo == null)}
          ${diff('稼働メモ', n.work_memo, n.prev_work_memo, n.prev_site_evaluation == null && n.prev_work_memo == null)}
        </section>`).join('') || `<p class="card p-6 text-center text-sm text-gray-400">${HOST_NOTES_VIEW.unseen ? '未確認の追記はありません' : '連携先からの追記はまだありません'}</p>`}
    </div>
    <div class="flex justify-between mt-3">
      ${HOST_NOTES_VIEW.offset ? '<button class="btn btn-outline text-xs" data-action="hostNotesPage" data-dir="-1">前へ</button>' : '<span></span>'}
      ${d.has_more ? '<button class="btn btn-outline text-xs" data-action="hostNotesPage" data-dir="1">次へ</button>' : ''}
    </div>`
  const cb = document.getElementById('hn-unseen')
  if (cb) cb.addEventListener('change', () => { HOST_NOTES_VIEW.unseen = cb.checked; HOST_NOTES_VIEW.offset = 0; renderRosterHostNotes() })
}
delegate('hostNotesPage', (el) => {
  HOST_NOTES_VIEW.offset = Math.max(0, HOST_NOTES_VIEW.offset + Number(el.dataset.dir) * 50)
  renderRosterHostNotes()
})
delegate('hostNotesSeen', (el) => withSubmitLock(el, async () => {
  try { await axios.post('/api/admin/roster/host-notes/seen', {}); toast('確認済みにしました'); renderRosterHostNotes() } catch (e) { showApiError(e, '更新に失敗しました') }
}))
if (typeof routes === 'object') routes['roster-notes'] = () => { HOST_NOTES_VIEW.offset = 0; renderRosterHostNotes() }

// =========================================================
// 所属元による連携の終了・再開（#162）
// =========================================================
let ROSTER_PANEL_LINKS = []
const rosterLinkHost = (id) => { const l = ROSTER_PANEL_LINKS.find(x => Number(x.linked_staff_id) === Number(id)); return l ? l.host_company_name : '' }
delegate('rosterEndLink', (el) => withSubmitLock(el, async () => {
  const sid = Number(el.dataset.sid), linked = Number(el.dataset.linked)
  if (!confirm(`「${rosterLinkHost(linked)}」との連携を終了します。\n\n・連携先は、このスタッフの基本項目（生年月日・最寄駅・スキル・経歴など）を見られなくなります\n・連携先では新しいシフトに割り当てられなくなります（入っているシフトは連携先が見直します）\n・連携先がさらに別の企業へ連携していた場合は、その連携も終了します\n・連携先の管理者に通知されます\n\nよろしいですか？`)) return
  try {
    const { data } = await axios.post(`/api/admin/roster/${sid}/links/${linked}/end`, {})
    toast(data.ended > 1 ? `連携を終了しました（その先の連携 ${data.ended - 1}件も終了）` : '連携を終了しました')
    renderStaffDetail(sid)
  } catch (e) { showApiError(e, '連携を終了できませんでした') }
}))
delegate('rosterResumeLink', (el) => withSubmitLock(el, async () => {
  const sid = Number(el.dataset.sid), linked = Number(el.dataset.linked)
  if (!confirm(`「${rosterLinkHost(linked)}」との連携を再開します。連携先はふたたび基本項目を見られるようになります（連携先の取引状況は「取引終了」のままです）。よろしいですか？`)) return
  try {
    await axios.post(`/api/admin/roster/${sid}/links/${linked}/resume`, {})
    toast('連携を再開しました'); renderStaffDetail(sid)
  } catch (e) { showApiError(e, '連携を再開できませんでした') }
}))

// =========================================================
// 取引先（Field OS 未契約の所属元）の管理（#161）: 一覧・登録・編集・統合・削除
// =========================================================
const PARTNERS = { list: [] }
const partnerById = (id) => PARTNERS.list.find(p => Number(p.affiliation_id) === Number(id))
window.renderPartners = async function () {
  loading()
  try { PARTNERS.list = (await axios.get('/api/admin/roster/partners')).data.partners || [] } catch (e) {
    $app.innerHTML = `<div class="card p-6 text-center text-sm text-red-500">${esc(showApiError(e, '読み込みに失敗しました'))}</div>`; return
  }
  const contact = (p) => [p.contact_name, p.phone, p.email].filter(Boolean).map(esc).join('<br>') || '<span class="text-gray-300">-</span>'
  $app.innerHTML = `
    <a href="#staff" class="text-sm text-blue-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>スタッフマスタ</a>
    <div class="flex items-center justify-between mt-2 mb-2 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-gray-900">取引先の管理 <span class="text-sm font-normal text-gray-400">${PARTNERS.list.length}社</span></h2>
      <button class="btn btn-primary" data-action="partnerEdit"><i class="fas fa-plus"></i>取引先を登録</button>
    </div>
    <p class="text-xs text-gray-500 mb-4">Field OS を使っていない所属元（③取引先から作成したスタッフの所属会社）です。精算では、取引先ごとに支払先がまとまります。
      同じ会社が別の名前（表記ゆれ）で分かれているときは「統合」でまとめてください（所属スタッフと未確定のシフトの支払先を付け替えます。確定済みの精算は変えません）。</p>
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>取引先名</th><th>担当者・連絡先</th><th>所属スタッフ</th><th>今月の稼働</th><th>メモ</th><th></th></tr></thead>
        <tbody>${PARTNERS.list.map(p => `
          <tr>
            <td class="font-medium">${esc(p.affiliation_name)}</td>
            <td class="text-xs">${contact(p)}</td>
            <td class="whitespace-nowrap">${Number(p.active_staff_count) || 0}名${Number(p.staff_count) > Number(p.active_staff_count) ? `<span class="text-[11px] text-gray-400">（退職等を含め ${Number(p.staff_count)}名）</span>` : ''}</td>
            <td class="whitespace-nowrap text-xs">${Number(p.month_shifts) || 0}件（${Number(p.month_staff) || 0}名）</td>
            <td class="text-xs max-w-[240px] whitespace-pre-wrap break-words">${esc(p.memo || '')}</td>
            <td class="whitespace-nowrap text-right">
              <button class="btn btn-outline text-xs" data-action="partnerEdit" data-id="${Number(p.affiliation_id)}">編集</button>
              ${PARTNERS.list.length > 1 ? `<button class="btn btn-outline text-xs" data-action="partnerMerge" data-id="${Number(p.affiliation_id)}">統合</button>` : ''}
              ${p.can_delete ? `<button class="btn btn-outline text-xs text-red-600" data-action="partnerDelete" data-id="${Number(p.affiliation_id)}">削除</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="text-center text-gray-400 py-6">取引先はまだありません</td></tr>'}</tbody>
      </table>
    </div>`
}
delegate('partnerEdit', (el) => {
  const p = el.dataset.id ? partnerById(el.dataset.id) : null
  const f = (id, label, v, attrs = '') => `<div><label class="text-sm text-gray-600 block mb-1">${label}</label><input id="${id}" class="inp" value="${esc(v || '')}" ${attrs}></div>`
  modal(`
    <h3 class="font-bold text-lg mb-4">${p ? '取引先の編集' : '取引先の登録'}</h3>
    <div class="space-y-3">
      ${f('pt-name', '取引先名 <span class="text-red-500">*</span>', p && p.affiliation_name, 'maxlength="100"')}
      ${p ? '<p class="text-[11px] text-gray-400 -mt-2">名前を変えると、所属スタッフの所属会社名も変わります</p>' : ''}
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        ${f('pt-contact', '担当者名', p && p.contact_name, 'maxlength="100"')}
        ${f('pt-phone', '電話', p && p.phone, 'type="tel" maxlength="20"')}
        ${f('pt-email', 'メール', p && p.email, 'type="email" maxlength="254"')}
      </div>
      <div><label class="text-sm text-gray-600 block mb-1">メモ</label><textarea id="pt-memo" rows="3" class="inp" maxlength="2000">${esc((p && p.memo) || '')}</textarea></div>
    </div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="partnerSave" data-id="${p ? Number(p.affiliation_id) : ''}">保存する</button>
    </div>`)
})
delegate('partnerSave', (el) => withSubmitLock(el, async () => {
  const v = (id) => (document.getElementById(id).value || '').trim()
  const body = { affiliation_name: v('pt-name'), contact_name: v('pt-contact'), phone: v('pt-phone'), email: v('pt-email'), memo: v('pt-memo') }
  if (!body.affiliation_name) { toast('取引先名を入力してください'); return }
  try {
    if (el.dataset.id) await axios.put('/api/admin/roster/partners/' + Number(el.dataset.id), body)
    else await axios.post('/api/admin/roster/partners', body)
    closeModal(); toast('保存しました'); renderPartners()
  } catch (e) { showApiError(e, '保存に失敗しました') }
}))
delegate('partnerMerge', (el) => {
  const p = partnerById(el.dataset.id); if (!p) return
  const others = PARTNERS.list.filter(x => x.affiliation_id !== p.affiliation_id)
  modal(`
    <h3 class="font-bold text-lg mb-1">取引先の統合</h3>
    <p class="text-sm text-gray-600 mb-3">「${esc(p.affiliation_name)}」を、次の取引先にまとめます（同じ会社が表記ゆれで分かれているとき）。</p>
    <select id="pt-merge-into" class="inp">${others.map(x => `<option value="${Number(x.affiliation_id)}">${esc(x.affiliation_name)}（${Number(x.staff_count) || 0}名）</option>`).join('')}</select>
    <ul class="text-xs text-gray-500 mt-3 space-y-1">
      <li>・所属スタッフ ${Number(p.staff_count) || 0}名の所属会社を、統合先に付け替えます</li>
      <li>・精算が確定していないシフトの支払先も、統合先に付け替えます（確定済みの精算は変えません）</li>
      <li>・統合先の担当者・電話・メールが空欄なら、「${esc(p.affiliation_name)}」の値で埋めます。メモは後ろに足します</li>
      <li>・統合した取引先は一覧と選択肢から消えます（元に戻せません）</li>
    </ul>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="partnerMergeSubmit" data-id="${Number(p.affiliation_id)}">統合する</button>
    </div>`)
})
delegate('partnerMergeSubmit', (el) => withSubmitLock(el, async () => {
  const into = Number(document.getElementById('pt-merge-into').value)
  const from = partnerById(el.dataset.id), to = partnerById(into)
  if (!from || !to || !confirm(`「${from.affiliation_name}」を「${to.affiliation_name}」に統合します。よろしいですか？`)) return
  try {
    const { data } = await axios.post(`/api/admin/roster/partners/${Number(el.dataset.id)}/merge`, { into_id: into })
    closeModal(); toast(`統合しました（スタッフ ${data.moved_staff}名・シフト ${data.moved_shifts}件を付け替え）`); renderPartners()
  } catch (e) { showApiError(e, '統合に失敗しました') }
}))
delegate('partnerDelete', (el) => withSubmitLock(el, async () => {
  const p = partnerById(el.dataset.id); if (!p) return
  if (!confirm(`取引先「${p.affiliation_name}」を削除します。よろしいですか？`)) return
  try { await axios.delete('/api/admin/roster/partners/' + Number(p.affiliation_id)); toast('削除しました'); renderPartners() } catch (e) { showApiError(e, '削除に失敗しました') }
}))
if (typeof routes === 'object') routes['partners'] = () => renderPartners()

// =========================================================
// 複数のスタッフをまとめて連携する（#539）
//   所属元: 連携用IDの一覧を選んで CSV・印刷で出す
//   稼働先: 複数のIDを貼り付けて確認し、1回の同意でまとめて連携する（同意の記録は1人ずつ残る）
// =========================================================
// ---------- 所属元: 連携用IDの一覧 ----------
const SHARE_LIST = { staff: [], q: '' }
window.showShareCodeList = async function () {
  try { SHARE_LIST.staff = (await axios.get('/api/admin/roster/share-codes')).data.staff || [] } catch (e) { showApiError(e, '読み込みに失敗しました'); return }
  SHARE_LIST.q = ''
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-id-badge text-blue-600 mr-1"></i>連携用IDの一覧</h3>
    <p class="text-xs text-gray-500 mb-2">選んだスタッフの氏名と連携用ID（FS／RL）を、CSV または印刷用の一覧で出します。稼働先は「新規追加 → IDをまとめて連携」で一度に連携できます。</p>
    <div class="text-xs bg-amber-50 text-amber-800 rounded-lg p-2 mb-3">IDを渡した企業は、いつでもそのスタッフを連携できます。渡す相手を確かめてください。連携されると自社に通知が届き、スタッフ詳細の「連携先企業」から終了できます。</div>
    <div class="flex gap-2 items-center mb-2">
      <input id="sc-q" class="inp text-sm flex-1" placeholder="氏名・フリガナ・番号で絞り込み">
      <label class="text-xs text-gray-600 flex items-center gap-1 whitespace-nowrap"><input type="checkbox" id="sc-all">表示中をすべて選択</label>
    </div>
    <div class="max-h-[50vh] overflow-y-auto border border-gray-100 rounded-lg" id="sc-rows"></div>
    <p class="text-xs text-gray-500 mt-2" id="sc-count"></p>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-outline flex-1" data-action="shareCodesExport" data-kind="csv"><i class="fas fa-file-csv"></i>CSVで保存</button>
      <button class="btn btn-primary flex-1" data-action="shareCodesExport" data-kind="print"><i class="fas fa-print"></i>印刷用に表示</button>
    </div>`)
  SHARE_LIST.picked = new Set()
  drawShareCodeRows()
  document.getElementById('sc-q').addEventListener('input', (ev) => { SHARE_LIST.q = ev.target.value; drawShareCodeRows() })
  document.getElementById('sc-all').addEventListener('change', (ev) => {
    document.querySelectorAll('#sc-rows .sc-pick').forEach(cb => { cb.checked = ev.target.checked; if (cb.checked) SHARE_LIST.picked.add(Number(cb.value)); else SHARE_LIST.picked.delete(Number(cb.value)) })
    countShareCodePicks()
  })
}
function drawShareCodeRows() {
  const box = document.getElementById('sc-rows'); if (!box) return
  const q = SHARE_LIST.q.trim().toLowerCase()
  const list = SHARE_LIST.staff.filter(s => !q || [s.name, s.kana, s.user_code].some(v => String(v || '').toLowerCase().includes(q)))
  box.innerHTML = list.map(s => `<label class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-50 text-sm cursor-pointer">
      <input type="checkbox" class="sc-pick" value="${Number(s.staff_id)}" ${SHARE_LIST.picked.has(Number(s.staff_id)) ? 'checked' : ''}>
      <span class="flex-1">${esc(s.name)} <span class="text-[11px] text-gray-400">${esc(s.kana || '')}</span></span>
      <span class="text-[11px] text-gray-400">${s.affiliation_type === 'linked_external' ? '他社連携' : '自社雇用'}</span></label>`).join('')
    || '<p class="text-center text-gray-400 text-sm py-6">連携用IDを共有できるスタッフはいません（在籍中の自社雇用・他社連携のスタッフが対象です）</p>'
  box.querySelectorAll('.sc-pick').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) SHARE_LIST.picked.add(Number(cb.value)); else SHARE_LIST.picked.delete(Number(cb.value))
    countShareCodePicks()
  }))
  countShareCodePicks()
}
function countShareCodePicks() {
  const el = document.getElementById('sc-count')
  if (el) el.textContent = `${SHARE_LIST.picked.size}人を選択中（対象 ${SHARE_LIST.staff.length}人）`
}
// CSV の値（数式として解釈されないように先頭の = + - @ を無効にする）
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"' }
delegate('shareCodesExport', (el) => withSubmitLock(el, async () => {
  const ids = [...SHARE_LIST.picked]
  if (!ids.length) { toast('スタッフを選んでください'); return }
  // 印刷用の画面は、通信の待ち時間の後に開くとポップアップとして止められるため、先に開いておく
  const win = el.dataset.kind === 'print' ? window.open('', '_blank') : null
  if (el.dataset.kind === 'print' && !win) { toast('印刷用の画面を開けませんでした（ポップアップを許可してください）'); return }
  let data
  try { data = (await axios.post('/api/admin/roster/share-codes', { staff_ids: ids })).data } catch (e) { if (win) win.close(); showApiError(e, 'IDを取得できませんでした'); return }
  const company = (ME && ME.company_name) || ''
  if (el.dataset.kind === 'csv') {
    const lines = [['氏名', 'フリガナ', 'スタッフID', '連携元'].map(csvCell).join(',')]
      .concat(data.staff.map(s => [s.name, s.kana || '', s.code, company].map(csvCell).join(',')))
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `連携用ID_${dayjs().format('YYYYMMDD')}.csv`
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  } else {
    const fmt = (c) => esc(String(c || '').replace(/(.{4})(?=.)/g, '$1 '))
    win.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>連携用IDの一覧</title>
      <style>body{font-family:sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;font-size:13px;text-align:left;vertical-align:middle}
      .id{font-family:monospace;font-size:16px;font-weight:bold;letter-spacing:2px}.qr{width:72px;height:72px}p{font-size:12px;color:#555}</style></head><body>
      <h2>連携用IDの一覧（${esc(company)}）</h2>
      <p>稼働先の企業は「スタッフマスタ → 新規追加 → IDをまとめて連携」に、この一覧のIDを貼り付けると、まとめて連携できます。IDを渡した企業はいつでも連携できるため、渡す相手を確かめてください。</p>
      <table><thead><tr><th>氏名</th><th>スタッフID</th><th>QR</th></tr></thead><tbody>
      ${data.staff.map(s => `<tr><td>${esc(s.name)}<br><small>${esc(s.kana || '')}</small></td><td class="id">${fmt(s.code)}</td><td><div class="qr">${qrSvg(s.code, 2)}</div></td></tr>`).join('')}
      </tbody></table><p>出力日 ${esc(dayjs().format('YYYY/M/D'))}</p></body></html>`)
    win.document.close()
    setTimeout(() => { try { win.focus(); win.print() } catch { } }, 300)
  }
  toast(`${data.staff.length}人のIDを出力しました${data.skipped ? `（退職・停止中などで出せなかった人 ${data.skipped}人）` : ''}`)
}))

// ---------- 稼働先: IDをまとめて連携 ----------
const ROSTER_BULK_MAX = 50
const ROSTER_BULK = { items: [], consent: null, bad: [], picks: [] }
// 貼り付けた文字からIDを取り出す（1行に1人。CSV の行・空白で区切ったID・氏名との並びでもよい）
function parseRosterCodes(text) {
  const codes = [], bad = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.replace(/[\s　]/g, '').toUpperCase()
    if (!t) continue
    const m = t.match(/(FS|RL)[0-9A-F]{10}/g)
    if (m) { for (const c of m) if (!codes.includes(c)) codes.push(c) }
    else if (!/^"?(氏名|名前|NAME)/i.test(line.trim())) bad.push(line.trim())
  }
  return { codes, bad }
}
window.showRosterBulkLink = function (prefill) {
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-users-line text-blue-600 mr-1"></i>IDをまとめて連携</h3>
    <p class="text-xs text-gray-500 mb-3">所属元の企業から受け取ったスタッフID（FS… / RL…）を、1行に1人ずつ貼り付けてください（所属元が出力した CSV の中身をそのまま貼り付けてもかまいません）。一度に ${ROSTER_BULK_MAX}人まで。</p>
    <textarea id="rb-codes" rows="8" class="inp font-mono text-sm" placeholder="FS1A2B3C4D5E&#10;FS2B3C4D5E6F">${esc(prefill || '')}</textarea>
    <div id="rb-result" class="mt-3"></div>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-outline" data-action="showAddRoster"><i class="fas fa-arrow-left"></i></button>
      <button class="btn btn-primary flex-1" data-action="rosterBulkCheck"><i class="fas fa-magnifying-glass"></i>確認する</button>
    </div>`)
}
delegate('rosterBulkCheck', (el) => withSubmitLock(el, async () => {
  const { codes, bad } = parseRosterCodes(document.getElementById('rb-codes').value)
  const box = document.getElementById('rb-result')
  if (!codes.length) { box.innerHTML = '<div class="p-3 rounded-lg bg-red-50 text-red-600 text-sm">スタッフIDが見つかりません（「FS」または「RL」で始まる12文字です）</div>'; return }
  if (codes.length > ROSTER_BULK_MAX) { box.innerHTML = `<div class="p-3 rounded-lg bg-red-50 text-red-600 text-sm">一度に連携できるのは${ROSTER_BULK_MAX}人までです（${codes.length}人分のIDがあります）</div>`; return }
  box.innerHTML = `<p class="text-sm text-gray-500"><span class="spin"></span> <span id="rb-checking">確認しています（0/${codes.length}）</span></p>`
  const items = new Array(codes.length)
  let next = 0, doneCount = 0
  // 1件ずつ検索する（同時に3件まで。1回の通信を軽くするため）
  const worker = async () => {
    while (next < codes.length) {
      const i = next++, code = codes[i]
      try {
        const { data } = await axios.get('/api/admin/roster/lookup', { params: { code } })
        const c = data.candidate || {}
        items[i] = data.already_linked_staff_id
          ? { code, status: 'already', name: c.name, staff_id: data.already_linked_staff_id }
          : { code, status: 'ok', name: c.name, kana: c.kana, owner: c.owner_company_name, consent: data.consent }
      } catch (e) {
        items[i] = { code, status: 'error', error: (e.response && e.response.data && e.response.data.error) || '確認できませんでした' }
      }
      doneCount++
      const p = document.getElementById('rb-checking'); if (p) p.textContent = `確認しています（${doneCount}/${codes.length}）`
    }
  }
  await Promise.all([worker(), worker(), worker()])
  ROSTER_BULK.items = items; ROSTER_BULK.bad = bad
  ROSTER_BULK.consent = (items.find(x => x.status === 'ok') || {}).consent || null
  drawRosterBulkCandidates()
}))
function drawRosterBulkCandidates() {
  const box = document.getElementById('rb-result'); if (!box) return
  const items = ROSTER_BULK.items
  const okCount = items.filter(x => x.status === 'ok').length
  const label = { ok: '<span class="badge badge-green">連携できます</span>', already: '<span class="badge badge-gray">連携済み</span>' }
  box.innerHTML = `
    <div class="max-h-[40vh] overflow-y-auto border border-gray-100 rounded-lg">
      <table class="tbl"><thead><tr><th></th><th>氏名</th><th>所属元</th><th>ID</th><th>状態</th></tr></thead><tbody>
      ${items.map((x, i) => `<tr>
        <td>${x.status === 'ok' ? `<input type="checkbox" class="rb-pick" value="${i}" checked>` : ''}</td>
        <td>${esc(x.name || '-')}${x.kana ? `<div class="text-[11px] text-gray-400">${esc(x.kana)}</div>` : ''}</td>
        <td class="text-xs">${esc(x.owner || '')}</td>
        <td class="font-mono text-xs">${esc(x.code)}</td>
        <td class="text-xs">${label[x.status] || `<span class="text-red-600">${esc(x.error || '')}</span>`}${x.status === 'already' && x.staff_id ? ` <a class="text-blue-600 underline" href="#staff/${Number(x.staff_id)}" onclick="closeModal()">開く</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    ${ROSTER_BULK.bad.length ? `<p class="text-xs text-amber-700 mt-2">IDが見つからない行（${ROSTER_BULK.bad.length}行）: ${ROSTER_BULK.bad.slice(0, 5).map(esc).join('、')}${ROSTER_BULK.bad.length > 5 ? ' …' : ''}</p>` : ''}
    ${okCount ? '<button class="btn btn-primary w-full mt-3" data-action="rosterBulkConsent"><i class="fas fa-link"></i>選んだ人を連携する（同意の確認へ）</button>' : '<p class="text-sm text-gray-500 mt-2">連携できる人はいません</p>'}`
}
delegate('rosterBulkConsent', () => {
  const picks = [...document.querySelectorAll('#rb-result .rb-pick:checked')].map(cb => ROSTER_BULK.items[Number(cb.value)]).filter(Boolean)
  if (!picks.length) { toast('連携する人を選んでください'); return }
  const consent = ROSTER_BULK.consent
  if (!consent) { toast('同意文面を取得できませんでした。もう一度確認してください'); return }
  ROSTER_BULK.picks = picks
  const owners = [...new Set(picks.map(x => x.owner).filter(Boolean))]
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-shield-halved text-blue-600 mr-1"></i>情報共有の同意確認（${picks.length}人）</h3>
    <p class="text-sm text-gray-600 mb-2">「${owners.map(esc).join('」「')}」に所属する次の <b>${picks.length}人</b> を自社のスタッフマスタに連携します。連携すると、以下の範囲の情報が所属元企業から共有されます。</p>
    <div class="text-xs text-gray-700 max-h-24 overflow-y-auto p-2 rounded-lg border border-gray-100 mb-3">${picks.map(x => esc(x.name)).join('、')}</div>
    <div class="grid sm:grid-cols-2 gap-3 text-xs">
      <div class="p-3 rounded-lg bg-blue-50">
        <p class="font-bold text-blue-700 mb-1"><i class="fas fa-check mr-1"></i>共有される情報（スタッフマスタ項目のみ）</p>
        <ul class="list-disc ml-4 text-blue-900 space-y-0.5">${consent.shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
      <div class="p-3 rounded-lg bg-gray-50">
        <p class="font-bold text-gray-600 mb-1"><i class="fas fa-ban mr-1"></i>共有されない情報</p>
        <ul class="list-disc ml-4 text-gray-600 space-y-0.5">${consent.not_shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
    <ul class="text-xs text-gray-500 mt-3 space-y-1">
      <li>・基本項目（氏名・スキル等）は所属元企業のみが編集でき、自社では閲覧のみとなります。</li>
      <li>・自社では評価・メモ・フォロー記録などの追記、およびシフト登録ができます。</li>
      <li>・共有情報は、スタッフの稼働管理の目的の範囲内でのみ利用してください。</li>
      <li>・同意の記録は1人ずつ保存され、所属元企業とスタッフ本人に連携されたことが通知されます。</li>
    </ul>
    <label class="flex items-start gap-2 mt-4 p-3 rounded-lg border border-gray-200 cursor-pointer">
      <input type="checkbox" id="rb-agree" class="mt-0.5" onchange="document.getElementById('rb-submit').disabled = !this.checked">
      <span class="text-sm text-gray-700">上記の${picks.length}人について、共有範囲と利用条件を確認し、同意します（同意の記録は保存されます）</span>
    </label>
    <p class="text-sm text-gray-600 mt-2 hidden" id="rb-progress"></p>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" data-action="rosterBulkBack">戻る</button>
      <button id="rb-submit" class="btn btn-primary flex-1" disabled data-action="rosterBulkSubmit">同意して${picks.length}人を連携する</button>
    </div>`)
})
delegate('rosterBulkBack', () => {
  showRosterBulkLink(ROSTER_BULK.items.map(x => x.code).join('\n'))
  drawRosterBulkCandidates()
})
// 1人ずつ順に連携する（1回の通信を軽くするため。同意の記録はサーバーで1人ずつ残る）。途中で失敗しても残りは続ける
delegate('rosterBulkSubmit', (el) => withSubmitLock(el, async () => {
  if (!document.getElementById('rb-agree').checked) { toast('同意が必要です'); return }
  const picks = ROSTER_BULK.picks || []
  const prog = document.getElementById('rb-progress'); prog.classList.remove('hidden')
  const results = []
  for (const [i, x] of picks.entries()) {
    prog.textContent = `連携しています（${i + 1}/${picks.length}）`
    try {
      const { data } = await axios.post('/api/admin/roster/link', { code: x.code, agreed: true, consent_version: ROSTER_BULK.consent.version })
      results.push({ ...x, ok: true, staff_id: data.staff_id })
    } catch (e) {
      const d = e.response && e.response.data
      results.push({ ...x, ok: false, error: (d && d.error) || '連携できませんでした', staff_id: d && d.staff_id })
      // 同意文面が更新されたときは、残りも同じ結果になるため止める
      if (e.response && e.response.status === 409 && d && /同意文面/.test(d.error || '')) break
    }
  }
  const okN = results.filter(r => r.ok).length
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-circle-check text-emerald-600 mr-1"></i>まとめて連携の結果</h3>
    <p class="text-sm text-gray-600 mb-3">${okN}人を連携しました${results.length - okN ? `（連携できなかった人 ${results.length - okN}人）` : ''}。${picks.length > results.length ? `残りの${picks.length - results.length}人は連携していません。` : ''}</p>
    <div class="max-h-[50vh] overflow-y-auto"><table class="tbl"><thead><tr><th>氏名</th><th>結果</th></tr></thead><tbody>
      ${results.map(r => `<tr><td>${r.staff_id ? `<a class="text-blue-700 hover:underline" href="#staff/${Number(r.staff_id)}" onclick="closeModal()">${esc(r.name)}</a>` : esc(r.name)}</td>
        <td class="text-xs">${r.ok ? '<span class="badge badge-green">連携しました</span>' : `<span class="text-red-600">${esc(r.error)}</span>`}</td></tr>`).join('')}
    </tbody></table></div>
    <button class="btn btn-outline w-full mt-4" data-action="rosterBulkClose">閉じる</button>`)
  if (okN) toast(`${okN}人を連携しました`)
}))
delegate('rosterBulkClose', () => {
  closeModal()
  if ((location.hash || '#dashboard') === '#staff' && typeof renderStaff === 'function') renderStaff({ reload: true })
})

// 作成方法の選択に、まとめて連携・連携用IDの一覧・取引先の管理への入口を足す
const _origShowAddRosterW5 = window.showAddRoster
window.showAddRoster = function () {
  _origShowAddRosterW5()
  const box = document.querySelector('#modal-root .modal-box')
  if (box) box.insertAdjacentHTML('beforeend', `
    <div class="border-t border-gray-100 mt-4 pt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
      <button class="btn btn-outline text-xs" data-action="rosterOpenBulkLink"><i class="fas fa-users-line"></i>IDをまとめて連携</button>
      <button class="btn btn-outline text-xs" data-action="rosterOpenShareList"><i class="fas fa-id-badge"></i>連携用IDの一覧（出力）</button>
      <a class="btn btn-outline text-xs" href="#partners" onclick="closeModal()"><i class="fas fa-building"></i>取引先の管理</a>
    </div>`)
}
delegate('rosterOpenBulkLink', () => showRosterBulkLink())
delegate('rosterOpenShareList', () => showShareCodeList())
