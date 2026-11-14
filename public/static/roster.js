// Mobital 管理画面: スタッフマスタ新規作成（4ルート）/ 企業間連携
// docs/spec_multi_company_staff.md フェーズC
// common.js の部品（modal / closeModal / onModalClose / toast / esc）と admin.js の renderStaff を利用する。admin.js の後に読み込むこと。

const ROSTER_ROUTES = [
  { key: 'link', icon: 'fa-qrcode', color: 'text-primary-600', title: '① QRコード / スタッフIDから連携',
    desc: '他社（Mobital利用企業）に所属する既存スタッフを、スタッフIDで連携登録します。基本項目は所属元が管理し、自社では追記のみ可能です。' },
  { key: 'employee', icon: 'fa-id-card', color: 'text-success-600', title: '② 従業員管理から作成（自社雇用）',
    desc: '自社で雇用するスタッフを登録します。ログインアカウントと従業員管理（社員名簿）が作成されます。' },
  { key: 'partner', icon: 'fa-building', color: 'text-accent-600', title: '③ 協力会社から作成',
    desc: '所属会社がMobitalを利用していない場合に、協力会社所属のスタッフとして登録します。' },
  { key: 'skillsheet', icon: 'fa-file-lines', color: 'text-neutral-600', title: '④ スキルシートのみ作成',
    desc: '稼働管理は行わず、スキルシートの発行だけを目的に登録します。ログインアカウントは作成されません。' },
]

window.showAddRoster = function () {
  modal(`
    <h3 class="font-bold text-lg mb-1">スタッフマスタ 新規追加</h3>
    <p class="text-xs text-neutral-500 mb-4">作成方法を選択してください</p>
    <div class="space-y-2">
      ${ROSTER_ROUTES.map(r => `
        <button class="w-full text-left p-3 rounded-xl border border-neutral-200 hover:border-primary-400 hover:bg-primary-50 transition" onclick="${r.key === 'link' ? 'showRosterLink()' : `showRosterForm('${r.key}')`}">
          <p class="font-bold text-sm text-neutral-800"><i class="fas ${r.icon} ${r.color} w-5"></i>${r.title}</p>
          <p class="text-xs text-neutral-500 mt-1 ml-5">${r.desc}</p>
        </button>`).join('')}
      <button class="w-full text-left p-3 rounded-xl border border-dashed border-neutral-300 hover:border-notice-400 hover:bg-notice-50 transition" data-action="showRosterImport">
        <p class="font-bold text-sm text-neutral-800"><i class="fas fa-file-csv text-notice-600 w-5"></i>CSV でまとめて登録（②③④）</p>
        <p class="text-xs text-neutral-500 mt-1 ml-5">導入時の名簿の移行や、まとめて受け入れるときに。テンプレートに記入して取り込み、重複などを確かめてから登録します。</p>
      </button>
    </div>
    <div class="border-t border-neutral-100 mt-4 pt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
      <button class="btn btn-outline text-xs" data-action="rosterOpenBulkLink"><i class="fas fa-users-line"></i>IDをまとめて連携</button>
      <button class="btn btn-outline text-xs" data-action="rosterOpenShareList"><i class="fas fa-id-badge"></i>連携用IDの一覧（出力）</button>
      <a class="btn btn-outline text-xs" href="#partners" onclick="closeModal()"><i class="fas fa-building"></i>協力会社の管理</a>
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
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-qrcode text-primary-600 mr-1"></i>スタッフIDから連携</h3>
    <p class="text-xs text-neutral-500 mb-4">所属元企業から共有されたスタッフID（例: FS1A2B3C4D5E）を入力してください。</p>
    <div class="flex gap-2">
      <input id="rl-code" class="inp flex-1 font-mono uppercase" placeholder="FS..." value="${esc(prefill || '')}">
      <button class="btn btn-primary" onclick="lookupRosterCode()"><i class="fas fa-magnifying-glass"></i>検索</button>
    </div>
    <button class="btn btn-outline w-full mt-2" onclick="startQrScan()"><i class="fas fa-camera"></i>カメラでQRコードを読み取る</button>
    <div id="rl-scan" class="mt-2"></div>
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
      box.innerHTML = `<div class="p-3 rounded-lg bg-warning-50 text-warning-700 text-sm">
        「${esc(cand.name)}」さんは既に連携済みです。<a class="underline font-bold" href="#staff/${data.already_linked_staff_id}" onclick="closeModal()">スタッフマスタを開く</a></div>`
      return
    }
    box.innerHTML = `
      <div class="p-3 rounded-xl border border-neutral-200">
        <p class="text-xs text-neutral-400">連携候補</p>
        <p class="font-bold text-neutral-900">${esc(cand.name)} <span class="text-xs font-normal text-neutral-400">${esc(cand.kana || '')}</span></p>
        <p class="text-xs text-neutral-500 mt-1">所属元: ${esc(cand.owner_company_name)} ／ ID: <span class="font-mono">${esc(cand.global_staff_code)}</span></p>
      </div>
      <button class="btn btn-primary w-full mt-3" data-action="rosterConsent">
        <i class="fas fa-link"></i>この人を連携登録する</button>`
  } catch (e) {
    box.innerHTML = `<div class="p-3 rounded-lg bg-danger-50 text-danger-600 text-sm">${esc((e.response && e.response.data && e.response.data.error) || '検索に失敗しました')}</div>`
  }
}

// 同意確認ポップアップ（連携のたびに毎回表示。同意結果はサーバー側で roster_consents に記録）
window.showRosterConsent = function (info) {
  ROSTER_LINK.consent = { code: info.code, version: info.consent.version }
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-shield-halved text-primary-600 mr-1"></i>情報共有の同意確認</h3>
    <p class="text-sm text-neutral-600 mb-3">「${esc(info.owner)}」に所属する <b>${esc(info.name)}</b> さんを自社のスタッフマスタに連携します。連携すると、以下の範囲の情報が所属元企業から共有されます。</p>
    <div class="grid sm:grid-cols-2 gap-3 text-xs">
      <div class="p-3 rounded-lg bg-primary-50">
        <p class="font-bold text-primary-700 mb-1"><i class="fas fa-check mr-1"></i>共有される情報（スタッフマスタ項目のみ）</p>
        <ul class="list-disc ml-4 text-primary-900 space-y-0.5">${info.consent.shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
      <div class="p-3 rounded-lg bg-neutral-50">
        <p class="font-bold text-neutral-600 mb-1"><i class="fas fa-ban mr-1"></i>共有されない情報</p>
        <ul class="list-disc ml-4 text-neutral-600 space-y-0.5">${info.consent.not_shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
    <ul class="text-xs text-neutral-500 mt-3 space-y-1">
      <li>・基本項目（氏名・スキル等）は所属元企業のみが編集でき、自社では閲覧のみとなります。</li>
      <li>・自社では評価・メモ・フォロー記録などの追記、およびシフト登録ができます。</li>
      <li>・共有情報は、スタッフの稼働管理の目的の範囲内でのみ利用してください。</li>
    </ul>
    <label class="flex items-start gap-2 mt-4 p-3 rounded-lg border border-neutral-200 cursor-pointer">
      <input type="checkbox" id="rc-agree" class="mt-0.5" onchange="document.getElementById('rc-submit').disabled = !this.checked">
      <span class="text-sm text-neutral-700">上記の共有範囲と利用条件を確認し、同意します（同意の記録は保存されます）</span>
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
const ROSTER_FORM_TITLE = { employee: '② 従業員管理から作成（自社雇用）', partner: '③ 協力会社から作成', skillsheet: '④ スキルシートのみ作成' }

window.showRosterForm = async function (route) {
  await loadRosterRequired(true)
  let partners = []
  if (route === 'partner') {
    try { partners = (await axios.get('/api/admin/roster/partners')).data.partners } catch { partners = [] }
  }
  // 空いているスタッフ番号（#424）。②は番号欄に入れておき、③（ログインは任意）は例として出す
  let next = null
  if (route !== 'skillsheet') { try { next = (await axios.get('/api/admin/roster/next-code')).data } catch { next = null } }
  const nextHint = next && next.last_code ? `<p class="text-2xs text-neutral-400 sm:col-span-2 -mt-2">空いている番号を入れています（最後の番号: ${esc(next.last_code)}）。変えることもできます</p>` : ''
  const f = (id, label, attrs = '', req = false) =>
    `<div><label class="text-sm text-neutral-600 block mb-1">${label}${req ? ' <span class="text-danger-500">*</span>' : ''}</label><input id="${id}" class="inp" ${attrs}></div>`
  modal(`
    <h3 class="font-bold text-lg mb-4">${ROSTER_FORM_TITLE[route]}</h3>
    <div class="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
      ${route === 'partner' ? `
        <div class="p-3 rounded-lg bg-accent-50 space-y-2">
          <label class="text-sm text-neutral-700 font-bold block">所属会社（協力会社） <span class="text-danger-500">*</span></label>
          <select id="rf-partner" class="inp" onchange="document.getElementById('rf-new-partner').classList.toggle('hidden', this.value !== 'new')">
            ${partners.map(p => `<option value="${p.affiliation_id}">${esc(p.affiliation_name)}（${p.staff_count}名）</option>`).join('')}
            <option value="new" ${partners.length ? '' : 'selected'}>＋ 新しい協力会社を登録</option>
          </select>
          <div id="rf-new-partner" class="${partners.length ? 'hidden' : ''} grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input id="rf-np-name" class="inp" placeholder="協力会社名 *">
            <input id="rf-np-contact" class="inp" placeholder="協力会社担当者名">
            <input id="rf-np-phone" class="inp" placeholder="電話">
            <input id="rf-np-email" class="inp" placeholder="メール">
          </div>
        </div>` : ''}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${f('rf-name', '氏名', 'placeholder="山田 太郎"', true)}
        ${f('rf-kana', 'フリガナ', 'placeholder="ヤマダ タロウ"')}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label class="text-sm text-neutral-600 block mb-1">性別 <span class="text-danger-500">*</span></label>
          <select id="rf-gender" class="inp"><option value="">選択してください</option><option value="male">男性</option><option value="female">女性</option><option value="other">その他</option><option value="unspecified">回答しない</option></select></div>
        ${f('rf-dob', '生年月日', 'type="date" data-age-input="rf-age"')}
      </div>
      <div>
        <label class="text-sm text-neutral-600 block mb-1" for="rf-age">年齢（生年月日が分からないとき）</label>
        <span class="inline-flex items-center gap-1 text-sm"><input id="rf-age" class="inp w-24" type="text" inputmode="numeric" maxlength="3" placeholder="例: 30">歳</span>
        <p class="text-2xs text-neutral-400 mt-0.5">入れた日から年が経つと自動で増えます（推定の年齢として出します）。生年月日を入れたら、そちらを使います</p>
      </div>
      ${route === 'employee' ? `
        <div class="p-3 rounded-lg bg-success-50 space-y-3">
          <p class="text-xs font-bold text-success-700"><i class="fas fa-key mr-1"></i>ログインアカウント（勤怠報告・日報用）</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${f('rf-code', 'スタッフ番号', `placeholder="st021" value="${esc(next ? next.code : '')}"`, true)}
            ${f('rf-pass', '初期パスワード', 'autocomplete="new-password" placeholder="8文字以上"', true)}
            ${route === 'employee' ? nextHint : ''}
            ${f('rf-email', 'メール', 'type="email"')}
            ${f('rf-phone', '電話', 'type="tel"')}
          </div>
          <p class="text-xs font-bold text-success-700 pt-1"><i class="fas fa-id-card mr-1"></i>従業員管理（詳細は登録後に従業員管理画面で入力）</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            ${f('rf-empno', '社員番号')}
            ${f('rf-hire', '入社年月日', 'type="date"')}
            ${f('rf-contract', '契約形態', 'placeholder="正社員 / 契約社員 等"')}
          </div>
        </div>` : ''}
      ${route === 'partner' ? `
        <details class="p-3 rounded-lg border border-neutral-200">
          <summary class="text-sm text-neutral-600 cursor-pointer">ログインアカウントを発行する（任意・勤怠報告を行う場合）</summary>
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
      <div><label class="text-sm text-neutral-600 block mb-1">経歴</label><textarea id="rf-career" rows="2" class="inp"></textarea></div>
      ${route !== 'skillsheet' ? `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          ${f('rf-line', '最寄駅（路線）')}
          ${f('rf-station', '最寄駅（駅）')}
          ${f('rf-available', '稼働開始可能日', 'type="date"')}
        </div>
        ${f('rf-commute', '通勤可能時間（分）', 'type="number" min="0" max="1440" step="1"')}
        <div id="rf-av-target">
          <span class="text-sm text-neutral-600 block mb-1">出勤可能日の提出</span>
          <div class="flex items-center gap-4 text-sm">
            <label class="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="rf-av-target" value="1" class="w-4 h-4" checked>する</label>
            <label class="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="rf-av-target" value="0" class="w-4 h-4">しない</label>
          </div>
          <p class="text-2xs text-neutral-400 mt-0.5">${esc(window.STAFF_AV_TARGET_CHOICE_HELP || '')}。登録した後も、スタッフ詳細で変えられます</p>
        </div>` : ''}
      <p class="text-xs text-neutral-400"><span class="text-danger-500">*</span> は必須項目です（氏名・性別は全企業共通の必須項目）</p>
    </div>
    <div id="rf-dup"></div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline" data-action="showAddRoster" title="作成方法の選択に戻る" aria-label="作成方法の選択に戻る"><i class="fas fa-arrow-left"></i></button>
      ${MODAL_CANCEL_BTN}
      <button class="btn btn-primary flex-1" data-action="submitRosterForm" data-route="${esc(route)}">登録する</button>
    </div>`)
  markRequiredInForm(route)
}
delegate('showAddRoster', () => showAddRoster())
// 送信中はボタンを無効にして二重登録を防ぐ
delegate('submitRosterForm', el => withSubmitLock(el, () => window.submitRosterForm(el.dataset.route)))
// 同じ人の確認で「別の人として登録する」を選んだとき（#223）
delegate('submitRosterFormForce', el => withSubmitLock(el, () => window.submitRosterForm(el.dataset.route, true)))

// 同じ人と思われる登録済みのスタッフの一覧（#223 #356）。退職・停止中は印を付ける
window.samePersonListHtml = function (matches) {
  return matches.map(m => `<li class="flex items-center gap-2 flex-wrap">
    <a class="underline font-bold" href="#staff/${Number(m.staff_id)}">${esc(m.name)}</a>
    <span class="text-neutral-500">${esc((typeof AFF_TYPE_LABEL !== 'undefined' && AFF_TYPE_LABEL[m.affiliation_type]) || m.affiliation_type || '')}${m.is_provisional ? '・仮登録' : ''}</span>
    ${m.inactive ? `<span class="badge badge-red">${esc(m.inactive)}</span>` : ''}
    <span class="text-neutral-400">${(m.reasons || []).map(esc).join('・')}</span></li>`).join('')
}
function showRosterDuplicate(route, matches) {
  const box = document.getElementById('rf-dup'); if (!box) return
  box.innerHTML = `<div class="mt-3 p-3 rounded-lg bg-warning-50 text-xs text-warning-800" id="rf-dup-box">
    <p class="font-bold mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>同じ人と思われるスタッフが登録済みです</p>
    <ul class="space-y-1 mb-2">${samePersonListHtml(matches)}</ul>
    <p class="mb-2">同じ人なら、登録せずに既存のスタッフを開いてください（退職の人は、スタッフ詳細で在籍状況を戻すと再び使えます）。
      誤って二重に登録したときは、シフトのない側をスタッフ詳細の「既存のスタッフに統合」でまとめられます</p>
    <button class="btn btn-outline text-xs" data-action="submitRosterFormForce" data-route="${esc(route)}">別の人として登録する</button></div>`
  box.scrollIntoView && box.scrollIntoView({ block: 'nearest' })
}

window.submitRosterForm = async function (route, force) {
  if (!rosterRequiredFilled(route)) return
  const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  const body = {
    route, name: v('rf-name'), kana: v('rf-kana'), gender: v('rf-gender'), date_of_birth: v('rf-dob') || null,
    age_entered: v('rf-dob') ? null : (toHalfWidthNumber(v('rf-age')) || null),
    skills: v('rf-skills'), work_area: v('rf-area'), career: v('rf-career'),
    nearest_station_line: v('rf-line'), nearest_station: v('rf-station'), available_from: v('rf-available') || null,
    commute_minutes: v('rf-commute') ? Number(v('rf-commute')) : null,
    user_code: v('rf-code'), password: v('rf-pass'), email: v('rf-email'), phone: v('rf-phone'),
    employee_number: v('rf-empno'), hire_date: v('rf-hire') || null, contract_type: v('rf-contract'),
    affiliation_contact: v('rf-aff-contact'), affiliation: v('rf-affiliation'),
  }
  // 出勤可能日の提出（する／しない。#9918）。④スキルシートのみには欄がない（送らない）
  const avTarget = document.querySelector('input[name="rf-av-target"]:checked')
  if (avTarget) body.availability_target = avTarget.value === '1'
  if (!body.name) { toast('氏名を入力してください'); return }
  if (!body.gender) { toast('性別を選択してください'); return }
  if (route === 'partner') {
    const sel = v('rf-partner')
    if (sel && sel !== 'new') body.partner_affiliation_id = Number(sel)
    else {
      body.new_partner_name = v('rf-np-name'); body.new_partner_contact = v('rf-np-contact')
      body.new_partner_phone = v('rf-np-phone'); body.new_partner_email = v('rf-np-email')
      if (!body.new_partner_name) { toast('協力会社名を入力してください'); return }
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
// CSV でまとめて登録（#430）。②自社雇用・③取引先・④スキルシートのみ を1つのファイルで登録する
// 1. テンプレートに記入した CSV を選ぶ → 2. サーバーで確かめた結果（エラー・警告）を見る → 3. 登録する
// 登録は、サーバーの CPU 時間の上限があるため数行ずつ（ログインを作る行は1行ずつ）に分けて送る。
// 自動で作った初期パスワードはこの画面でしか分からないので、ログイン案内の CSV を保存してもらう
// =========================================================
const ROSTER_IMPORT_MAX_ROWS = 500
const ROSTER_IMPORT = { header: null, rows: [], preview: null, created: [], failed: [], downloaded: true }
function parseCsvText(text) {
  const rows = []; let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += ch
      continue
    }
    if (ch === '"') q = true
    else if (ch === ',') { row.push(f); f = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(f); rows.push(row); row = []; f = ''
    } else f += ch
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row) }
  return rows
}
// UTF-8 で読めなければ Shift_JIS（Excel で保存した CSV）として読む
function decodeCsvBuffer(buf) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { text = new TextDecoder('shift_jis').decode(buf) }
  return text.replace(/^﻿/, '')
}
function rosterImportResultHtml() {
  const created = ROSTER_IMPORT.created, failed = ROSTER_IMPORT.failed
  if (!created.length && !failed.length) return ''
  const withPw = created.filter(r => r.password)
  return `<div class="p-3 rounded-lg ${failed.length ? 'bg-warning-50 text-warning-800' : 'bg-success-50 text-success-800'} text-xs space-y-2" id="ri-result">
    <p class="font-bold"><i class="fas fa-circle-check mr-1"></i>${created.length}人を登録しました${failed.length ? `（登録しなかった行: ${failed.length}）` : ''}</p>
    ${withPw.length ? `<p>ログインを作った ${withPw.length}人の初期パスワードは、この画面でしか確認できません。ログイン案内（CSV）を保存して、本人に伝えてください（初回のログインでパスワードの変更を求めます）。</p>
      <button class="btn btn-primary text-xs" data-action="downloadRosterImportLogins"><i class="fas fa-download"></i>ログイン案内をダウンロード（CSV）</button>` : ''}
    ${failed.length ? `<ul class="space-y-0.5">${failed.map(r => `<li>${Number(r.line)}行目 ${esc(r.name || '')}: ${esc(r.status === 'skipped' ? '警告があるため登録しませんでした' : (r.errors || []).join(' / ') || '登録できませんでした')}</li>`).join('')}</ul>` : ''}
  </div>`
}
window.showRosterImport = function () {
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-file-csv text-notice-600 mr-1"></i>CSV でまとめて登録</h3>
    <p class="text-xs text-neutral-500 mb-3">テンプレートの CSV に1行1人で記入して選んでください。登録の前に、必須項目の不足・スタッフ番号や社員番号の重複・同じ人と思われる登録済みのスタッフを確かめます。
      区分は「自社雇用」「協力会社」「スキルシートのみ」です（他社から連携するスタッフは ①スタッフIDから連携 で登録してください）。
      生年月日が分からない人は「年齢」の列に入れてください（取り込んだ日の年齢として登録します。両方あるときは生年月日を使います）。</p>
    ${ROSTER_IMPORT.downloaded ? '' : rosterImportResultHtml()}
    <div class="flex gap-2 flex-wrap items-center mt-3">
      <a class="btn btn-outline text-xs" href="/api/admin/roster/import/template"><i class="fas fa-download"></i>テンプレートをダウンロード</a>
      <input type="file" id="ri-file" accept=".csv,text/csv" class="text-xs flex-1 min-w-0">
    </div>
    <p class="text-2xs text-neutral-400 mt-1">文字コードは UTF-8 と Shift_JIS（Excel で保存した CSV）に対応しています。1回に${ROSTER_IMPORT_MAX_ROWS}行まで。</p>
    <div id="ri-preview" class="mt-3"></div>
    <button class="btn btn-outline w-full mt-4 text-xs" data-action="showAddRoster"><i class="fas fa-arrow-left"></i>作成方法の選択に戻る</button>`)
  const input = document.getElementById('ri-file')
  if (input) input.addEventListener('change', () => { if (input.files && input.files[0]) previewRosterImport(input.files[0]) })
}
delegate('showRosterImport', () => showRosterImport())
async function previewRosterImport(file) {
  const box = document.getElementById('ri-preview'); if (!box) return
  box.innerHTML = '<div class="flex justify-center py-4"><span class="spin"></span></div>'
  let records
  try { records = parseCsvText(decodeCsvBuffer(await file.arrayBuffer())) } catch { box.innerHTML = '<p class="text-xs text-danger-500">ファイルを読めませんでした</p>'; return }
  const header = records[0] || []
  // 空の行は読み飛ばす。行番号は CSV の何行目か（見出しが1行目）
  const rows = records.slice(1).map((cells, i) => ({ line: i + 2, cells })).filter(r => r.cells.some(v => String(v).trim()))
  if (!rows.length) { box.innerHTML = '<p class="text-xs text-danger-500">登録する行がありません</p>'; return }
  if (rows.length > ROSTER_IMPORT_MAX_ROWS) { box.innerHTML = `<p class="text-xs text-danger-500">${rows.length}行あります。1回に${ROSTER_IMPORT_MAX_ROWS}行までにして、ファイルを分けてください</p>`; return }
  Object.assign(ROSTER_IMPORT, { header, rows, preview: null })
  try {
    ROSTER_IMPORT.preview = (await axios.post('/api/admin/roster/import/preview', { header, rows })).data
  } catch (e) {
    const d = e.response && e.response.data
    box.innerHTML = `<p class="text-xs text-danger-500">${esc((d && d.error) || '確かめられませんでした')}</p>`
    return
  }
  renderRosterImportPreview()
}
function renderRosterImportPreview() {
  const box = document.getElementById('ri-preview'); const p = ROSTER_IMPORT.preview
  if (!box || !p) return
  const s = p.summary
  const msg = (list, cls) => (list || []).map(m => `<p class="${cls}">${esc(m)}</p>`).join('')
  box.innerHTML = `
    <div class="flex gap-2 flex-wrap text-xs mb-2">
      <span class="badge badge-gray">${Number(s.total)}行</span>
      <span class="badge badge-green">登録できる ${Number(s.ok)}</span>
      <span class="badge badge-yellow">警告 ${Number(s.warning)}</span>
      <span class="badge badge-red">エラー ${Number(s.error)}</span>
    </div>
    ${p.unknown_columns && p.unknown_columns.length ? `<p class="text-xs text-warning-700 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>読まない列: ${p.unknown_columns.map(esc).join('・')}（見出しがテンプレートと違います）</p>` : ''}
    <div class="max-h-[40vh] overflow-auto border border-neutral-100 rounded-lg">
      <table class="w-full text-xs"><thead class="sticky top-0 bg-neutral-50"><tr class="text-left text-neutral-500">
        <th class="p-1.5">行</th><th class="p-1.5">区分</th><th class="p-1.5">氏名</th><th class="p-1.5">スタッフ番号</th><th class="p-1.5">確認の結果</th></tr></thead>
        <tbody>${p.rows.map(r => `<tr class="border-t border-neutral-100 align-top ${r.errors.length ? 'bg-danger-50' : r.warnings.length ? 'bg-warning-50' : ''}">
          <td class="p-1.5">${Number(r.line)}</td><td class="p-1.5 whitespace-nowrap">${esc(r.type_label || '')}</td><td class="p-1.5 whitespace-nowrap">${esc(r.name || '')}</td>
          <td class="p-1.5 whitespace-nowrap">${r.login ? esc(r.user_code || '自動') : '<span class="text-neutral-400">ログインなし</span>'}</td>
          <td class="p-1.5">${r.errors.length || r.warnings.length || r.notes.length ? msg(r.errors, 'text-danger-600') + msg(r.warnings, 'text-warning-700') + msg(r.notes, 'text-neutral-500') : '<span class="text-success-600">登録できます</span>'}</td></tr>`).join('')}</tbody></table>
    </div>
    ${s.warning ? `<label class="flex items-start gap-2 text-xs mt-3"><input type="checkbox" id="ri-accept" class="mt-0.5">
      <span>警告のある行も登録する（同じ人と思われるスタッフがいる行は、別の人であることを確かめてから登録してください）</span></label>` : ''}
    <p class="text-xs text-neutral-500 mt-2">エラーの行は登録しません。CSV を直して、もう一度選び直すこともできます。</p>
    <div id="ri-progress" class="text-xs text-neutral-500 mt-2"></div>
    <button class="btn btn-primary w-full mt-2" data-action="commitRosterImport" ${s.ok + s.warning ? '' : 'disabled'}><i class="fas fa-user-plus"></i>登録する</button>`
}
delegate('commitRosterImport', el => withSubmitLock(el, () => commitRosterImport()))
async function commitRosterImport() {
  const p = ROSTER_IMPORT.preview; if (!p) return
  const acceptEl = document.getElementById('ri-accept')
  const accept = !!(acceptEl && acceptEl.checked)
  const ok = new Map(p.rows.filter(r => !r.errors.length && (!r.warnings.length || accept)).map(r => [r.line, r]))
  const targets = ROSTER_IMPORT.rows.filter(r => ok.has(r.line))
  if (!targets.length) { toast('登録できる行がありません'); return }
  if (!confirm(`${targets.length}人を登録します。よろしいですか？`)) return
  // 1回に送る行数とログインを作る行数の上限（preview が返す値）
  const maxRows = (p.limits && p.limits.commit_rows) || 5, maxLogins = (p.limits && p.limits.commit_logins) || 1
  const chunks = []; let cur = [], logins = 0
  for (const r of targets) {
    const login = ok.get(r.line).login ? 1 : 0
    if (cur.length && (cur.length >= maxRows || logins + login > maxLogins)) { chunks.push(cur); cur = []; logins = 0 }
    cur.push(r); logins += login
  }
  if (cur.length) chunks.push(cur)
  const created = []
  const failed = p.rows.filter(r => r.errors.length || (r.warnings.length && !accept))
    .map(r => ({ line: r.line, name: r.name, status: r.errors.length ? 'error' : 'skipped', errors: r.errors }))
  // ファイルで指定されたスタッフ番号（空欄の行に自動で付ける番号がこれと重ならないように送る）
  const reservedCodes = p.rows.filter(r => !r.errors.length && r.login && r.user_code).map(r => r.user_code)
  const progress = document.getElementById('ri-progress')
  let stopped = null
  for (const part of chunks) {
    if (progress) progress.textContent = `登録しています… ${created.length} / ${targets.length}`
    try {
      const { data } = await axios.post('/api/admin/roster/import/commit', { header: ROSTER_IMPORT.header, rows: part, accept_warnings: accept, reserved_codes: reservedCodes })
      for (const r of data.results) (r.status === 'created' ? created : failed).push(r)
    } catch (e) {
      stopped = (e.response && e.response.data && e.response.data.error) || '通信に失敗しました'
      const done = new Set([...created, ...failed].map(r => r.line))
      for (const r of targets) if (!done.has(r.line)) failed.push({ line: r.line, name: (ok.get(r.line) || {}).name, status: 'error', errors: [`登録を中断しました（${stopped}）`] })
      break
    }
  }
  failed.sort((a, b) => a.line - b.line)
  Object.assign(ROSTER_IMPORT, { created, failed, downloaded: !created.some(r => r.password), preview: null })
  const box = document.getElementById('ri-preview')
  if (box) box.innerHTML = rosterImportResultHtml() + `<button class="btn btn-outline w-full mt-3 text-xs" data-action="closeRosterImport"><i class="fas fa-users"></i>スタッフマスタを開く</button>`
  toast(stopped ? `${created.length}人を登録し、途中で中断しました` : `${created.length}人を登録しました`)
}
delegate('closeRosterImport', () => {
  if (!ROSTER_IMPORT.downloaded && !confirm('ログイン案内をまだダウンロードしていません。閉じると初期パスワードを確認できなくなります。閉じますか？')) return
  ROSTER_IMPORT.downloaded = true
  closeModal()
  if (location.hash === '#staff' && typeof renderStaff === 'function') renderStaff()
  else location.hash = 'staff'
})
delegate('downloadRosterImportLogins', () => {
  const rows = ROSTER_IMPORT.created.filter(r => r.password)
  if (!rows.length) return
  const q = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const code = (typeof ME !== 'undefined' && ME && ME.company_code) || ''
  const lines = [['会社コード', 'スタッフ番号', '氏名', '初期パスワード'], ...rows.map(r => [code, r.user_code, r.name, r.password])].map(r => r.map(q).join(','))
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ログイン案内.csv'
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  ROSTER_IMPORT.downloaded = true
})

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
  const canEdit = hasPerm('roster.required_fields')
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-sliders text-primary-600 mr-1"></i>スタッフマスタ 必須項目の設定</h3>
    <p class="text-xs text-neutral-500 mb-4">新規作成時・基本項目の更新時に入力を必須にする項目を選択します。登録済みのスタッフで未入力の人は「未入力のスタッフを確認」で一覧できます。${canEdit ? '' : '<br><span class="text-danger-500">変更は会社管理者のみ可能です</span>'}</p>
    <p class="text-xs font-bold text-neutral-500 mb-1">常に必須（変更不可）</p>
    <div class="flex gap-2 mb-4">${data.absolute.map(f => `<span class="badge badge-red">${esc(f.label)}</span>`).join('')}</div>
    <p class="text-xs font-bold text-neutral-500 mb-1">企業ごとに設定</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      ${data.fields.map(f => {
        // 対象の説明（例: 所属先担当者名は③取引先のみ、メールはログインのある人のみ、④スキルシートのみは対象外）
        const scope = [f.note, f.skillsheet || f.only ? '' : '④対象外'].filter(Boolean).join('・')
        return `
        <label class="flex items-center gap-2 p-2 rounded-lg border border-neutral-200 ${canEdit ? 'cursor-pointer' : 'opacity-70'}">
          <input type="checkbox" class="rq-field" data-code="${esc(f.code)}" ${f.is_required ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
          <span class="text-sm">${esc(f.label)}</span>
          ${scope ? `<span class="text-3xs text-neutral-400 ml-auto">${esc(scope)}</span>` : ''}
        </label>`
      }).join('')}
    </div>
    <p class="text-xs text-neutral-400 mt-3">※ ①QR/ID連携で登録したスタッフの基本項目は所属元企業が管理するため、自社の必須設定は適用されません。</p>
    <div class="flex gap-2 mt-4">
      ${canEdit ? MODAL_CANCEL_BTN : ''}
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
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-triangle-exclamation text-warning-500 mr-1"></i>必須項目が未入力のスタッフ</h3>
    <p class="text-sm text-neutral-600 mb-3">既存スタッフのうち <b>${Number(data.count)}名</b> が未入力です。${data.truncated ? `（先頭の${Number(data.staff.length)}名を表示）` : ''}<br>
      <span class="text-xs text-neutral-400">他社連携・退職・統合済みのスタッフは対象外です。名前を押すと詳細を開きます。</span></p>
    <div class="max-h-[60vh] overflow-y-auto">
      <table class="tbl">
        <thead><tr><th>氏名</th><th>区分</th><th>未入力の項目</th></tr></thead>
        <tbody>${data.staff.map(s => `
          <tr>
            <td><a class="text-primary-700 hover:underline" href="${link(s)}">${esc(s.name)}</a></td>
            <td class="text-xs">${esc((typeof AFF_TYPE_LABEL !== 'undefined' && AFF_TYPE_LABEL[s.affiliation_type]) || s.affiliation_type)}</td>
            <td class="text-xs text-danger-600">${s.missing.map(esc).join('・')}</td>
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
    if (label && !label.querySelector('.req-mark')) label.insertAdjacentHTML('beforeend', ' <span class="text-danger-500 req-mark">*</span>')
  }
}
// 送信前の必須項目の確認（submitRosterForm の初めに呼ぶ）。足りなければ知らせて false
function rosterRequiredFilled(route) {
  const req = ROSTER_REQUIRED || {}
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
  // ログイン: ②は必ず作る、③はスタッフ番号と初期パスワードを入れたときだけ、④は作らない
  const hasLogin = route === 'employee' || (route === 'partner' && !!val('rf-code') && !!val('rf-pass'))
  const lacks = []
  for (const [code, id] of Object.entries(RF_FIELD_IDS)) {
    if (!req[code] || !rfRequirementApplies(code, route, hasLogin)) continue
    if (code === 'date_of_birth' && val('rf-age')) continue // 年齢（#9710）を入れれば生年月日の必須を満たす
    const el = document.getElementById(id)
    if (el && !el.value.trim()) lacks.push(el.parentElement.querySelector('label').textContent.replace('*', '').trim())
  }
  if (lacks.length) { toast('次の項目は必須です: ' + lacks.join('・')); return false }
  return true
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
        <h3 class="font-bold text-lg"><i class="fas fa-qrcode text-primary-600 mr-1"></i>連携用QRコード</h3>
        <button class="btn btn-outline text-xs" onclick="window.print()"><i class="fas fa-print"></i>印刷</button>
      </div>
      <div class="text-center">
        <div class="w-56 h-56 mx-auto">${qrSvg(data.global_staff_code)}</div>
        <p class="font-mono text-xl font-bold tracking-widest mt-2">${esc(String(data.global_staff_code || '').replace(/(.{4})(?=.)/g, '$1 '))}</p>
        <p class="text-sm text-neutral-700 mt-1">${esc(data.name)}（${esc(data.company_name)}）</p>
        <button class="btn btn-outline text-xs mt-2" data-action="copyShareCode" data-code="${esc(data.global_staff_code)}"><i class="fas fa-copy"></i>IDをコピー</button>
      </div>
      <ul class="text-xs text-neutral-500 mt-4 space-y-1">
        <li>・このQRコード / スタッフIDは${data.relink ? '自社から連携するための専用コードで、固定です' : '恒久固定です（再発行・有効期限・取り消しはありません）'}。IDを渡した企業はいつでも連携できるため、渡す相手を確かめてください。</li>
        <li>・稼働先企業が「スタッフマスタ → 新規追加 → ① QRコード / スタッフIDから連携」で読み取ると、スタッフマスタ項目（氏名・年代・最寄駅・スキル・経歴・「経験・スキル・人柄・PRポイント等」など）が共有されます。生年月日は年代（20代など）だけを渡し、備考は共有しません。</li>
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
    <p class="text-xs text-neutral-500 mt-1 text-center">QRコードを枠内に映してください（画像はサーバーに送信されません）</p>
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

// ① のモーダルのカメラ読み取りボタン（showRosterLink が描く）。モーダルを閉じたらカメラを止める
onModalClose(stopQrScan)

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
      <h3 class="text-sm font-bold text-neutral-700 mb-1"><i class="fas fa-pen-to-square text-success-500 mr-1"></i>稼働先追記項目</h3>
      <p class="text-xs text-neutral-400 mb-3">ここに記入した内容は所属元「${esc(p.owner_company_name || '')}」も閲覧できます（スタッフ本人には表示されません）。社内だけのメモは「管理者メモ」に記入してください。</p>
      <label class="text-xs text-neutral-500 block mb-1">現場評価</label>
      <textarea id="host-site-eval" rows="2" class="inp text-xs mb-2">${esc(p.site_evaluation || '')}</textarea>
      <label class="text-xs text-neutral-500 block mb-1">稼働メモ</label>
      <textarea id="host-work-memo" rows="2" class="inp text-xs">${esc(p.work_memo || '')}</textarea>
      <div class="flex items-center justify-between mt-2">
        <span class="text-2xs text-neutral-400">${p.host_note_updated_at ? '最終更新 ' + esc(p.host_note_updated_at) : ''}</span>
        <button class="btn btn-outline text-xs" data-action="saveHostNotes" data-sid="${Number(sid)}">保存</button>
      </div>
    </section>` : ''
  let linkHtml = ''
  if (links && (links.role === 'owner' || (links.role === 'host' && links.links && links.links.length))) {
    linkHtml = `
      <section class="card p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold text-neutral-700"><i class="fas fa-link text-primary-500 mr-1"></i>連携先企業（自社から連携した稼働先）</h3>
          ${p.link_shareable ? `<button class="btn btn-outline text-xs" onclick="showShareQr(${sid})"><i class="fas fa-qrcode"></i>連携用QR</button>` : ''}
        </div>
        ${links.links.length ? links.links.map(l => `
          <div class="p-2.5 rounded-lg ${l.link_revoked_at ? 'bg-neutral-100 opacity-80' : 'bg-neutral-50'} mb-2">
            <div class="flex items-center gap-2 text-xs flex-wrap">
              <span class="font-bold text-neutral-800">${esc(l.host_company_name)}</span>
              <span class="text-neutral-400">連携 ${esc((l.consented_at || l.linked_at || '').slice(0, 10))}</span>
              ${l.link_revoked_at ? `<span class="badge badge-gray">連携終了 ${esc(String(l.link_revoked_at).slice(0, 10))}${l.revoked_by_name ? '（' + esc(l.revoked_by_name) + '）' : ''}</span>` : '<span class="badge badge-green">共有中</span>'}
              <span class="ml-auto text-neutral-500">今月の稼働 ${Number(l.month_days) || 0}日${Number(l.month_planned_days) > Number(l.month_days) ? `（予定を含め ${Number(l.month_planned_days)}日）` : ''} / 最終稼働 ${l.last_work_date ? dayjs(l.last_work_date).format('M/D') : '-'}</span>
            </div>
            ${l.site_evaluation || l.work_memo ? `
              <p class="text-xs text-neutral-700 mt-1 whitespace-pre-wrap break-words"><span class="text-neutral-400">現場評価:</span> ${esc(l.site_evaluation || '-')}</p>
              <p class="text-xs text-neutral-700 whitespace-pre-wrap break-words"><span class="text-neutral-400">稼働メモ:</span> ${esc(l.work_memo || '-')}</p>
              ${l.host_note_updated_at ? `<p class="text-2xs text-neutral-400">更新 ${esc(String(l.host_note_updated_at).slice(0, 16))}</p>` : ''}` : '<p class="text-xs text-neutral-400 mt-1">稼働先からの追記はまだありません</p>'}
            ${(l.history || []).length > 1 ? `<details class="mt-1"><summary class="text-2xs text-primary-600 cursor-pointer">変更の履歴（${l.history.length}件${l.history.length >= 10 ? '・新しい10件' : ''}）</summary>
              <div class="mt-1 space-y-1">${l.history.map(h => `<div class="text-2xs text-neutral-600 border-l-2 border-neutral-200 pl-2">
                <p class="text-neutral-400">${esc(String(h.created_at || '').slice(0, 16))}</p>
                <p class="whitespace-pre-wrap break-words">現場評価: ${esc(h.site_evaluation || '-')}</p>
                <p class="whitespace-pre-wrap break-words">稼働メモ: ${esc(h.work_memo || '-')}</p></div>`).join('')}</div></details>` : ''}
            <div class="flex justify-end mt-1">${l.link_revoked_at
              ? (p.link_shareable ? `<button class="btn btn-outline text-xs" data-action="rosterResumeLink" data-sid="${Number(sid)}" data-linked="${Number(l.linked_staff_id)}"><i class="fas fa-rotate-left"></i>連携を再開</button>` : '')
              : `<button class="btn btn-outline text-xs text-danger-600" data-action="rosterEndLink" data-sid="${Number(sid)}" data-linked="${Number(l.linked_staff_id)}"><i class="fas fa-link-slash"></i>連携を終了</button>`}</div>
          </div>`).join('') : `<p class="text-sm text-neutral-400">${!p.linkable ? '連携対象外のスタッフです' : p.link_shareable ? 'まだ他社には連携されていません' : '退職・停止中のため、新しく連携することはできません'}</p>`}
        <p class="text-2xs text-neutral-400 mt-1">稼働先の追記内容は閲覧のみです（編集は稼働先企業が行います）。<a href="#roster-notes" class="text-primary-600 hover:underline">連携先からの追記の一覧</a></p>
      </section>`
  }
  if (links && links.role === 'host') {
    linkHtml += `
      <section class="card p-4">
        <h3 class="text-sm font-bold text-neutral-700 mb-3"><i class="fas fa-shield-halved text-primary-500 mr-1"></i>連携の同意履歴</h3>
        ${links.link_revoked_at ? `<div class="p-2.5 rounded-lg bg-danger-50 text-danger-700 text-xs mb-2"><i class="fas fa-link-slash mr-1"></i>所属元の企業が ${esc(String(links.link_revoked_at).slice(0, 16))} に連携を終了しました。基本項目は表示されず、新しいシフトには割り当てられません。</div>` : ''}
        ${links.consents.map(x => `
          <div class="p-2.5 rounded-lg bg-neutral-50 mb-2 text-xs">
            <p><span class="font-bold">${esc(x.agreed_by || '-')}</span> が同意 <span class="text-neutral-400">${esc((x.created_at || '').slice(0, 16))}</span> <span class="badge badge-gray">${esc(x.consent_version)}</span></p>
            <p class="text-neutral-500 mt-1">共有範囲: ${esc(Array.isArray(x.shared_scope) ? x.shared_scope.join('・') : x.shared_scope)}</p>
          </div>`).join('') || '<p class="text-sm text-neutral-400">記録がありません</p>'}
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
    $app.innerHTML = `<div class="card p-6 text-center text-sm text-danger-500">${esc(showApiError(e, '読み込みに失敗しました'))}</div>`; return
  }
  const diff = (label, now, prev, first) => `<p class="text-sm whitespace-pre-wrap break-words"><span class="text-xs text-neutral-400">${label}:</span> ${esc(now || '-')}</p>
    ${!first && (prev || '') !== (now || '') ? `<p class="text-2xs text-neutral-400 whitespace-pre-wrap break-words line-through">前: ${esc(prev || '（空欄）')}</p>` : ''}`
  $app.innerHTML = `
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-neutral-900">連携先からの追記</h2>
      <div class="flex items-center gap-2">
        <label class="text-xs text-neutral-600 flex items-center gap-1"><input type="checkbox" id="hn-unseen" ${HOST_NOTES_VIEW.unseen ? 'checked' : ''}>未確認だけ</label>
        <button class="btn btn-outline text-xs" data-action="hostNotesSeen" ${d.unseen_count ? '' : 'disabled'}><i class="fas fa-check-double"></i>すべて確認済みにする</button>
      </div>
    </div>
    <p class="text-xs text-neutral-500 mb-4">自社から連携した稼働先の企業が書いた「現場評価」「稼働メモ」の変更です（未確認 ${Number(d.unseen_count) || 0}件）。スタッフ本人には表示されません。</p>
    <div class="space-y-2">
      ${d.notes.map(n => `
        <section class="card p-3 ${n.unseen ? 'border-l-4 border-primary-500' : ''}">
          <div class="flex items-center gap-2 flex-wrap text-xs mb-1">
            ${n.unseen ? '<span class="badge badge-blue">未確認</span>' : ''}
            <a href="#staff/${Number(n.staff_id)}" class="font-bold text-primary-700 hover:underline text-sm">${esc(n.staff_name || '')}</a>
            <span class="text-neutral-500">${esc(n.host_company_name || '')}</span>
            <span class="text-neutral-400 ml-auto">${esc(String(n.created_at || '').slice(0, 16))}</span>
          </div>
          ${diff('現場評価', n.site_evaluation, n.prev_site_evaluation, n.prev_site_evaluation == null && n.prev_work_memo == null)}
          ${diff('稼働メモ', n.work_memo, n.prev_work_memo, n.prev_site_evaluation == null && n.prev_work_memo == null)}
        </section>`).join('') || `<p class="card p-6 text-center text-sm text-neutral-400">${HOST_NOTES_VIEW.unseen ? '未確認の追記はありません' : '連携先からの追記はまだありません'}</p>`}
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
// #roster-notes で開く（画面の登録は src/admin-menu.ts の ADMIN_EXTRA_SCREENS）。開くたびに1ページ目から出す
window.openRosterHostNotes = () => { HOST_NOTES_VIEW.offset = 0; renderRosterHostNotes() }

// =========================================================
// 所属元による連携の終了・再開（#162）
// =========================================================
let ROSTER_PANEL_LINKS = []
const rosterLinkHost = (id) => { const l = ROSTER_PANEL_LINKS.find(x => Number(x.linked_staff_id) === Number(id)); return l ? l.host_company_name : '' }
delegate('rosterEndLink', (el) => withSubmitLock(el, async () => {
  const sid = Number(el.dataset.sid), linked = Number(el.dataset.linked)
  if (!confirm(`「${rosterLinkHost(linked)}」との連携を終了します。\n\n・連携先は、このスタッフの基本項目（年代・最寄駅・スキル・経歴など）を見られなくなります\n・連携先では新しいシフトに割り当てられなくなります（入っているシフトは連携先が見直します）\n・本人は、スタッフのアプリで連携先の会社に切り替えられなくなります\n・連携先がさらに別の企業へ連携していた場合は、その連携も終了します\n・連携先の管理者に通知されます\n\nよろしいですか？`)) return
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
// 取引先（Mobital 未契約の所属元）の管理（#161）: 一覧・登録・編集・統合・削除
// =========================================================
// 協力会社（#9301。以前の名前は「取引先」）の詳細（#partners/<id>）とクライアントとのつながり（#9302）
// 一覧の「編集」は、詳細の会社基本情報をクライアントと同じ形の編集欄で開く（#9909。editOnOpen に開く協力会社の ID を入れる）
const PARTNERS = { list: [], detail: null, month: '', q: '', assignee: '', editOnOpen: null }
const partnerById = (id) => PARTNERS.list.find(p => Number(p.affiliation_id) === Number(id))
  || (PARTNERS.detail && Number(PARTNERS.detail.partner.affiliation_id) === Number(id) ? PARTNERS.detail.partner : null)
window.renderPartners = async function () {
  const id = (location.hash || '').split('/')[1] || ''
  if (id && /^\d+$/.test(id)) return renderPartnerDetail(Number(id))
  if (id) { history.replaceState(null, '', '#partners') }
  PARTNERS.detail = null
  loading()
  try {
    const [d] = await Promise.all([axios.get('/api/admin/roster/partners').then(r => r.data), loadAssigneeOptions(true)])
    PARTNERS.list = d.partners || []
  } catch (e) {
    $app.innerHTML = `<div class="card p-6 text-center text-sm text-danger-500">${esc(showApiError(e, '読み込みに失敗しました'))}</div>`; return
  }
  const contact = (p) => [p.contact_name ? esc(p.contact_name) + (p.contact_name_kana ? `<span class="text-2xs text-neutral-400">（${esc(p.contact_name_kana)}）</span>` : '') : '', esc(p.phone || ''), esc(p.email || '')].filter(Boolean).join('<br>') || '<span class="text-neutral-300">-</span>'
  $app.innerHTML = `
    <a href="#staff" class="text-sm text-primary-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>スタッフマスタ</a>
    <div class="flex items-center justify-between mt-2 mb-2 flex-wrap gap-2">
      <h2 class="text-xl font-bold text-neutral-900">協力会社 <span class="text-sm font-normal text-neutral-400">${PARTNERS.list.length}社</span></h2>
      <button class="btn btn-primary" data-action="partnerEdit"><i class="fas fa-plus"></i>協力会社を登録</button>
    </div>
    <p class="text-sm text-neutral-700 mb-1">スタッフの所属会社・支払先になる会社です（Mobital を使っている会社は企業間連携で扱います）</p>
    <p class="text-xs text-neutral-500 mb-4">精算では、協力会社ごとに支払先がまとまります。クライアントでもある会社は、詳細でクライアントとつなげます。
      同じ会社が別の名前（表記ゆれ）で分かれているときは「統合」でまとめてください（所属スタッフと未確定のシフトの支払先を付け替えます。確定済みの精算は変えません）。</p>
    ${PARTNERS.list.length ? `<div class="card p-3 mb-3 flex gap-2 items-center flex-wrap"><i class="fas fa-magnifying-glass text-neutral-400"></i>
      <input id="partner-q" class="inp text-sm flex-1 min-w-[200px]" placeholder="協力会社名・フリガナ・住所・ホームページ・担当者・社内担当者・メモで検索" value="${esc(PARTNERS.q)}">
      <select id="partner-assignee" class="inp text-sm w-auto" aria-label="社内担当者で絞り込み">${assigneeFilterOptions(PARTNERS.list, PARTNERS.assignee)}</select>
      <span id="partner-count" class="text-xs text-neutral-400 whitespace-nowrap"></span></div>` : ''}
    <div class="card overflow-x-auto">
      <table class="tbl">
        <thead><tr><th>協力会社名</th><th>担当者・連絡先</th><th>社内担当者</th><th>所属スタッフ</th><th>今月の稼働</th><th>クライアント</th><th>メモ</th><th></th></tr></thead>
        <tbody>${PARTNERS.list.map(p => `
          <tr data-partner-row="${Number(p.affiliation_id)}">
            <td class="font-medium">${p.affiliation_name_kana ? `<span class="block text-2xs font-normal text-neutral-400">${esc(p.affiliation_name_kana)}</span>` : ''}<a href="#partners/${Number(p.affiliation_id)}" class="text-primary-600 hover:underline">${esc(p.affiliation_name)}</a>
              ${p.address || p.postal_code ? `<span class="block text-2xs font-normal text-neutral-500 max-w-[260px] truncate" title="${esc(partnerAddress(p))}"><i class="fas fa-location-dot mr-1 text-neutral-400"></i>${esc(partnerAddress(p))}</span>` : ''}
              ${p.website_url ? `<span class="block text-2xs font-normal text-neutral-500 max-w-[260px] truncate"><i class="fas fa-globe mr-1 text-neutral-400"></i>${esc(partnerUrlHost(p.website_url))}</span>` : ''}</td>
            <td class="text-xs">${contact(p)}</td>
            <td class="text-xs">${assigneeShortHtml(p.assignees, p.internal_contact_name)}</td>
            <td class="whitespace-nowrap">${Number(p.active_staff_count) || 0}名${Number(p.staff_count) > Number(p.active_staff_count) ? `<span class="text-2xs text-neutral-400">（退職等を含め ${Number(p.staff_count)}名）</span>` : ''}</td>
            <td class="whitespace-nowrap text-xs">${Number(p.month_shifts) || 0}件（${Number(p.month_staff) || 0}名）</td>
            <td class="text-xs">${p.client_id ? `<a href="#clients/${Number(p.client_id)}" class="badge badge-blue hover:underline"><i class="fas fa-link mr-1"></i>${esc(p.client_name)}</a>` : '<span class="text-neutral-300">-</span>'}</td>
            <td class="text-xs max-w-[240px] whitespace-pre-wrap break-words">${esc(p.memo || '')}</td>
            <td class="whitespace-nowrap text-right">
              <a class="btn btn-outline text-xs" href="#partners/${Number(p.affiliation_id)}">詳細</a>
              <button class="btn btn-outline text-xs" data-action="partnerEdit" data-id="${Number(p.affiliation_id)}">編集</button>
              ${PARTNERS.list.length > 1 ? `<button class="btn btn-outline text-xs" data-action="partnerMerge" data-id="${Number(p.affiliation_id)}">統合</button>` : ''}
              ${p.can_delete ? `<button class="btn btn-outline text-xs text-danger-600" data-action="partnerDelete" data-id="${Number(p.affiliation_id)}">削除</button>` : ''}
            </td>
          </tr>`).join('') || '<tr><td colspan="8" class="text-center text-neutral-400 py-6">協力会社はまだありません</td></tr>'}</tbody>
      </table>
      <p id="partner-empty" class="hidden text-center text-sm text-neutral-400 py-6">条件に合う協力会社はありません</p>
    </div>`
  const q = document.getElementById('partner-q')
  if (q) {
    let timer = null
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { PARTNERS.q = q.value; filterPartnerRows() }, 200) })
    document.getElementById('partner-assignee').addEventListener('change', ev => { PARTNERS.assignee = ev.target.value; filterPartnerRows() })
    filterPartnerRows()
  }
}
// 協力会社の一覧の絞り込み（#9709。似た名前の会社を、住所・ホームページ・担当者でも探せるように）
function filterPartnerRows() {
  let shown = 0
  for (const p of PARTNERS.list) {
    const tr = document.querySelector(`tr[data-partner-row="${Number(p.affiliation_id)}"]`); if (!tr) continue
    const hit = matchesAssigneeFilter(p.assignees, PARTNERS.assignee) && matchesKeyword(PARTNERS.q, [p.affiliation_name, p.affiliation_name_kana, p.postal_code, p.address, p.website_url,
      p.contact_name, p.contact_name_kana, p.contact_department, p.phone, p.email, p.company_phone, p.company_email, p.representative_name, p.branch_name, p.department_name,
      p.internal_contact_name, p.memo, p.client_name, ...(p.assignees || []).map(a => a.name)])
    tr.hidden = !hit; if (hit) shown++
  }
  const cnt = document.getElementById('partner-count')
  if (cnt) cnt.textContent = shown === PARTNERS.list.length ? '' : `${shown}社（全${PARTNERS.list.length}社）`
  const empty = document.getElementById('partner-empty')
  if (empty) empty.classList.toggle('hidden', shown > 0 || !PARTNERS.list.length)
}
const partnerAddress = (p) => [p.postal_code ? '〒' + p.postal_code : '', p.address || ''].filter(Boolean).join(' ')
function partnerUrlHost(u) { try { return new URL(u).host } catch { return String(u || '') } }
async function renderPartnerDetail(pid) {
  if (!PARTNERS.detail || Number(PARTNERS.detail.partner.affiliation_id) !== pid) { loading(); PARTNERS.month = '' }
  PARTNERS.month = PARTNERS.month || dayjs().format('YYYY-MM')
  let data
  try { data = (await axios.get('/api/admin/roster/partners/' + pid, { params: { month: PARTNERS.month } })).data } catch (e) {
    const msg = showApiError(e, '読み込みに失敗しました')
    $app.innerHTML = `<a href="#partners" class="text-sm text-primary-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>協力会社</a>
      <div class="card p-6 mt-3 text-center text-sm text-danger-500">${esc(msg)}</div>`; return
  }
  PARTNERS.detail = data
  const p = data.partner
  let editNow = PARTNERS.editOnOpen === pid
  PARTNERS.editOnOpen = null
  // 選択肢を読めないまま編集欄を出すと、保存で社内担当者が消えるので、読めなければ表示のままにする
  if (editNow) { try { await loadAssigneeOptions(true) } catch (e) { editNow = false; showApiError(e, '社内担当者の選択肢を読み込めませんでした') } }
  $app.innerHTML = `
    <a href="#partners" class="text-sm text-primary-600 hover:underline"><i class="fas fa-arrow-left mr-1"></i>協力会社</a>
    ${p.affiliation_name_kana ? `<p class="text-xs text-neutral-400 mt-2">${esc(p.affiliation_name_kana)}</p>` : ''}
    <div class="flex items-center gap-2 ${p.affiliation_name_kana ? '' : 'mt-2'} mb-4 flex-wrap">
      <h2 class="text-xl font-bold text-neutral-900">${esc(p.affiliation_name)}</h2>
      <span class="badge badge-purple">協力会社</span>
      ${p.client_id ? `<a href="#clients/${Number(p.client_id)}" class="badge badge-blue hover:underline"><i class="fas fa-link mr-1"></i>クライアント「${esc(p.client_name)}」でもあります</a>` : ''}
    </div>
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="space-y-4">
        <section class="card p-4" id="partner-basic-info">${partnerBasicHtml(p, editNow)}</section>
      </div>
      <div class="space-y-4">
        <section class="card p-4" id="partner-contact">${partnerContactHtml(p)}</section>
        <section class="card p-4" id="partner-client-link">${partnerClientLinkHtml(data)}</section>
      </div>
      <section class="card p-4 lg:col-span-2" id="partner-deals">${partnerDealsHtml(data)}</section>
      <section class="card p-4 lg:col-span-2">
        <h3 class="text-sm font-bold text-neutral-700 mb-2"><i class="fas fa-users text-primary-500 mr-1"></i>所属スタッフ（在籍中） <span class="font-normal text-neutral-400">${(data.staff || []).length}名</span></h3>
        ${(data.staff || []).length ? `<div class="flex flex-wrap gap-2">${data.staff.map(s => `<a href="#staff/${Number(s.staff_id)}" class="badge badge-gray hover:underline">${esc(s.name)}</a>`).join('')}</div>`
          : '<p class="text-sm text-neutral-400">在籍中の所属スタッフはいません</p>'}
      </section>
    </div>`
}
// 会社基本情報（#9909）。クライアントの会社基本情報（admin.js の clientBasicHtml）と同じ項目・並び・見た目にする。
// 「編集」で入力欄に切り替え、表示中の項目をすべて保存できる。社内担当者は自社の管理者のアカウントから選ぶ（#9910）
function partnerBasicHtml(p, editing) {
  const pid = Number(p.affiliation_id)
  if (!editing) return `
        <h3 class="text-sm font-bold text-neutral-700 mb-3 flex items-center">会社基本情報
          <button type="button" class="ml-auto btn btn-outline text-xs" data-action="partnerEditBasic"><i class="fas fa-pen"></i>編集</button></h3>
        <dl class="text-sm space-y-2">
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">代表者氏名</dt><dd>${esc(p.representative_name || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">支店</dt><dd class="break-all">${esc(p.branch_name || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">部門</dt><dd class="break-all">${esc(p.department_name || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">連絡先</dt><dd class="text-xs">${esc(p.company_phone || '-')}<br>${esc(p.company_email || '')}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">住所</dt><dd class="whitespace-pre-wrap">${esc(partnerAddress(p) || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">ホームページ</dt><dd class="min-w-0">${websiteLinkHtml(p.website_url)}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">種別</dt><dd>${esc(clientKindLabel(p.partner_kind))}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">支払条件</dt><dd class="whitespace-pre-wrap">${esc(p.payment_rule || '-')}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">評価</dt><dd>${p.partner_rating ? ratingStars(p.partner_rating) : '<span class="text-neutral-400">未評価</span>'}</dd></div>
          <div class="flex"><dt class="w-24 text-neutral-400 shrink-0">社内担当者</dt><dd class="min-w-0">${assigneesViewHtml(p.assignees, p.internal_contact_name)}</dd></div>
          <div><dt class="text-neutral-400 mb-1">備考</dt><dd class="text-xs text-neutral-600 whitespace-pre-wrap">${esc(p.memo || '-')}</dd></div>
        </dl>
        <div class="mt-3 pt-3 border-t border-neutral-100">
          <p class="text-xs text-neutral-500 mb-1"><i class="fas fa-receipt text-neutral-400 mr-1"></i>インボイス情報</p>
          <dl class="text-xs space-y-1.5">
            <div class="flex"><dt class="w-28 text-neutral-400 shrink-0">インボイス番号</dt><dd>${esc(p.invoice_number || '-')}</dd></div>
          </dl>
        </div>`
  const inp = (id, label, v, extra = '') => `<div class="flex items-center gap-2"><label for="${id}" class="w-28 text-xs text-neutral-400 shrink-0">${label}</label><input id="${id}" class="inp text-xs flex-1" value="${esc(v || '')}" ${extra}></div>`
  return `
        <h3 class="text-sm font-bold text-neutral-700 mb-3">会社基本情報の編集</h3>
        <div class="space-y-2">
          ${inp('pt-name', '協力会社名 *', p.affiliation_name, 'maxlength="100"')}
          <p class="text-2xs text-neutral-400 -mt-1 text-right">名前を変えると、所属スタッフの所属会社名も変わります</p>
          ${inp('pt-name-kana', 'フリガナ', p.affiliation_name_kana, 'maxlength="100" placeholder="ひらがなでも可（カタカナで保存）"')}
          ${inp('pt-rep', '代表者氏名', p.representative_name, 'maxlength="100"')}
          ${inp('pt-branch', '支店', p.branch_name, 'maxlength="100"')}
          ${inp('pt-department', '部門', p.department_name, 'maxlength="100"')}
          ${inp('pt-company-phone', '電話', p.company_phone, 'type="tel" maxlength="20"')}
          ${inp('pt-company-email', 'メール', p.company_email, 'type="email" maxlength="254"')}
          ${inp('pt-postal', '郵便番号', p.postal_code, 'inputmode="numeric" maxlength="10" placeholder="123-4567" data-halfwidth="1"')}
          ${inp('pt-address', '住所', p.address, 'maxlength="300"')}
          ${inp('pt-url', 'ホームページ', p.website_url, 'type="url" maxlength="500" placeholder="https://example.co.jp"')}
          <div class="flex items-center gap-2"><label for="pt-kind" class="w-28 text-xs text-neutral-400 shrink-0">種別</label>
            <select id="pt-kind" class="inp text-xs flex-1">${clientKindOptions(p.partner_kind)}</select></div>
          ${inp('pt-payment', '支払条件', p.payment_rule, 'maxlength="200" placeholder="月末締め・翌月末払い"')}
          <div class="flex items-center gap-2"><label for="pt-rating" class="w-28 text-xs text-neutral-400 shrink-0">評価</label>
            <select id="pt-rating" class="inp text-xs flex-1"><option value="">（未評価）</option>${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${Number(p.partner_rating) === n ? 'selected' : ''}>${ratingStars(n)}</option>`).join('')}</select></div>
          <div class="flex items-start gap-2"><span class="w-28 text-xs text-neutral-400 shrink-0 pt-1">社内担当者</span><div class="flex-1 min-w-0">${assigneesEditorHtml('pt', p.assignees)}
            ${p.internal_contact_name ? `<div class="flex items-center gap-2 mt-1.5"><label for="pt-internal" class="text-2xs text-neutral-400 shrink-0">旧（文字）</label><input id="pt-internal" class="inp text-xs flex-1" maxlength="100" value="${esc(p.internal_contact_name)}"></div>
              <p class="text-2xs text-neutral-400">アカウントを選んだら、旧の文字は消してかまいません</p>` : ''}</div></div>
          <div><label for="pt-memo" class="text-xs text-neutral-400 block mb-1">備考</label><textarea id="pt-memo" rows="3" class="inp text-xs" maxlength="2000">${esc(p.memo || '')}</textarea></div>
          <p class="text-xs text-neutral-500 pt-2 border-t border-neutral-100"><i class="fas fa-receipt text-neutral-400 mr-1"></i>インボイス情報</p>
          ${inp('pt-invoice', 'インボイス番号', p.invoice_number, 'maxlength="20" placeholder="T1234567890123"')}
          <p id="pt-basic-error" class="hidden text-xs text-danger-600"></p>
          <div class="flex gap-2">
            <button type="button" class="btn btn-outline text-xs flex-1" data-action="partnerCancelBasic">取り消す</button>
            <button type="button" class="btn btn-primary text-xs flex-1" data-action="partnerSaveBasic" data-id="${pid}">保存</button>
          </div>
        </div>`
}
// 先方の担当者（クライアントの「顧客担当者」の欄にあたる。協力会社は1人分）
function partnerContactHtml(p) {
  const has = p.contact_name || p.contact_department || p.phone || p.email
  return `<div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-bold text-neutral-700"><i class="fas fa-address-book text-primary-500 mr-1"></i>先方の担当者</h3>
      <button class="btn btn-outline text-xs" data-action="partnerEditContact"><i class="fas fa-pen"></i>${has ? '編集' : '担当者を登録'}</button>
    </div>
    ${has ? `<div class="p-2.5 rounded-lg bg-neutral-50 text-sm min-w-0">
      ${p.contact_name_kana ? `<p class="text-2xs text-neutral-400">${esc(p.contact_name_kana)}</p>` : ''}
      <p class="font-medium text-neutral-800">${esc(p.contact_name || '-')}</p>
      <p class="text-xs text-neutral-500">${esc(p.contact_department || '-')}</p>
      <p class="text-xs text-neutral-500">${esc(p.phone || '-')}　${esc(p.email || '')}</p>
    </div>` : '<p class="text-sm text-neutral-400">先方の担当者が登録されていません</p>'}`
}
delegate('partnerEditBasic', el => withSubmitLock(el, async () => {
  try { await loadAssigneeOptions(true) } catch (e) { showApiError(e, '社内担当者の選択肢を読み込めませんでした'); return }
  const box = document.getElementById('partner-basic-info'); if (box && PARTNERS.detail) box.innerHTML = partnerBasicHtml(PARTNERS.detail.partner, true)
}))
delegate('partnerCancelBasic', () => { const box = document.getElementById('partner-basic-info'); if (box && PARTNERS.detail) box.innerHTML = partnerBasicHtml(PARTNERS.detail.partner, false) })
delegate('partnerSaveBasic', el => withSubmitLock(el, async () => {
  const err = document.getElementById('pt-basic-error'); err.classList.add('hidden')
  const v = id => { const x = document.getElementById(id); return x ? (x.value || '').trim() : undefined }
  const body = { affiliation_name: v('pt-name'), affiliation_name_kana: v('pt-name-kana'), representative_name: v('pt-rep'), branch_name: v('pt-branch'), department_name: v('pt-department'),
    company_phone: v('pt-company-phone'), company_email: v('pt-company-email'), postal_code: v('pt-postal'), address: v('pt-address'), website_url: v('pt-url'),
    partner_kind: v('pt-kind'), payment_rule: v('pt-payment'), partner_rating: v('pt-rating'), memo: document.getElementById('pt-memo').value,
    invoice_number: v('pt-invoice'), assignees: collectAssignees('pt') }
  // 旧の文字の社内担当者は、欄があるときだけ送る（無ければ今の値のまま）
  if (document.getElementById('pt-internal')) body.internal_contact_name = v('pt-internal')
  if (!body.affiliation_name) { err.textContent = '協力会社名を入力してください'; err.classList.remove('hidden'); return }
  try { await axios.put('/api/admin/roster/partners/' + Number(el.dataset.id), body) } catch (e) {
    err.textContent = (e.response && e.response.data && e.response.data.error) || '保存に失敗しました'; err.classList.remove('hidden'); return
  }
  toast('会社基本情報を保存しました')
  renderPartnerDetail(Number(el.dataset.id))
}))
delegate('partnerEditContact', () => {
  const p = PARTNERS.detail && PARTNERS.detail.partner; if (!p) return
  const f = (id, label, v, attrs = '') => `<div><label class="text-sm text-neutral-600 block mb-1">${label}</label><input id="${id}" class="inp" value="${esc(v || '')}" ${attrs}></div>`
  modal(`
    <h3 class="font-bold text-lg mb-4">先方の担当者</h3>
    <div class="space-y-3">
      ${f('pc-name', '担当者氏名', p.contact_name, 'maxlength="100"')}
      ${f('pc-name-kana', 'フリガナ', p.contact_name_kana, 'maxlength="100" placeholder="ひらがなでも入力できます（カタカナで保存します）"')}
      ${f('pc-dept', '部署・役職', p.contact_department, 'maxlength="100"')}
      ${f('pc-phone', '電話番号', p.phone, 'type="tel" maxlength="20"')}
      ${f('pc-email', 'メールアドレス', p.email, 'type="email" maxlength="254"')}
      <p class="text-2xs text-neutral-400">すべて空欄で保存すると、担当者を消します</p>
      <div class="flex gap-2 pt-2">
        <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
        <button class="btn btn-primary flex-1" data-action="partnerSaveContact" data-id="${Number(p.affiliation_id)}">保存</button>
      </div>
    </div>`)
})
delegate('partnerSaveContact', el => withSubmitLock(el, async () => {
  const v = id => (document.getElementById(id).value || '').trim()
  try {
    await axios.put('/api/admin/roster/partners/' + Number(el.dataset.id), { contact_name: v('pc-name'), contact_name_kana: v('pc-name-kana'), contact_department: v('pc-dept'), phone: v('pc-phone'), email: v('pc-email') })
    closeModal(); toast('先方の担当者を保存しました'); renderPartnerDetail(Number(el.dataset.id))
  } catch (e) { showApiError(e, '保存に失敗しました') }
}))
// クライアントとのつながりの欄（協力会社の詳細）
function partnerClientLinkHtml(data) {
  const p = data.partner
  const head = '<h3 class="text-sm font-bold text-neutral-700 mb-2"><i class="fas fa-link text-primary-500 mr-1"></i>クライアントとのつながり</h3>'
  if (p.client_id) return `${head}
    <p class="text-sm text-neutral-700">この会社は、クライアント「<a href="#clients/${Number(p.client_id)}" class="text-primary-600 hover:underline font-medium">${esc(p.client_name)}</a>」でもあります。</p>
    <p class="text-xs text-neutral-500 mt-1">クライアントの詳細にも、この協力会社へのリンクと、協力会社としての支払が出ます。</p>
    <div class="flex gap-2 mt-3 flex-wrap">
      <a href="#clients/${Number(p.client_id)}" class="btn btn-outline text-xs"><i class="fas fa-arrow-right"></i>クライアントの詳細</a>
      <button class="btn btn-outline text-xs text-danger-600" data-action="partnerUnlinkClient" data-id="${Number(p.affiliation_id)}">つながりを外す</button>
    </div>`
  const clients = data.clients || []
  return `${head}
    <p class="text-xs text-neutral-500 mb-2">この会社がクライアントでもあるときは、クライアントを選んでつなぎます。つなぐと、お互いの詳細に相手へのリンクと、月の請求・支払が出ます（いつでも外せます）。</p>
    ${clients.length ? `<div class="flex gap-2 flex-wrap">
      <select id="pt-link-client" class="inp text-sm flex-1 min-w-[12rem]"><option value="">クライアントを選ぶ</option>
        ${clients.map(c => `<option value="${Number(c.client_id)}" ${c.linked_partner_name ? 'disabled' : ''}>${esc(c.client_name)}${c.linked_partner_name ? `（${esc(c.linked_partner_name)} とつながっています）` : ''}</option>`).join('')}</select>
      <button class="btn btn-primary text-xs" data-action="partnerLinkClient" data-id="${Number(p.affiliation_id)}"><i class="fas fa-link"></i>つなぐ</button>
    </div>` : '<p class="text-sm text-neutral-400">クライアントがまだ登録されていません（<a href="#clients" class="text-primary-600 hover:underline">クライアント</a>）</p>'}`
}
// 月の取引（協力会社の詳細）: この会社への支払と、つながったクライアントへの請求
function partnerDealsHtml(data) {
  const p = data.partner, s = data.summary || {}, ml = monthLabel(s.month)
  const pay = s.pay || { total: 0, shifts: 0, staff: 0, unset: 0 }
  const box = (title, amount, sub, color) => `<div class="bg-neutral-50 rounded-lg p-3"><p class="text-xs text-neutral-500">${title}</p><p class="text-lg font-bold ${color}">${amount}</p><p class="text-xs text-neutral-500 mt-0.5">${sub}</p></div>`
  return `
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <h3 class="text-sm font-bold text-neutral-700"><i class="fas fa-chart-column text-primary-500 mr-1"></i>月の取引</h3>
      <span class="ml-auto">${monthNavHtml('partnerDetailMonth', s.month)}</span>
    </div>
    <div class="grid sm:grid-cols-2 gap-3">
      ${box(`${esc(ml)}の支払（この会社へ）`, yen(pay.total), `${Number(pay.shifts)}件・${Number(pay.staff)}名${pay.unset ? `<span class="text-warning-600">（支払額が未設定 ${Number(pay.unset)}件は含みません）</span>` : ''}`, 'text-accent-700')}
      ${s.bill ? box(`${esc(ml)}の請求（クライアント「${esc(p.client_name)}」へ）`, yen(s.bill.total), `案件 ${Number(s.bill.projects)}件・シフト ${Number(s.bill.shifts)}件 <a href="#clients/${Number(p.client_id)}" class="text-primary-600 hover:underline ml-1">案件ごとの内訳</a>`, 'text-primary-600')
        : `<div class="bg-neutral-50 rounded-lg p-3 text-xs text-neutral-400 flex items-center">クライアントとつながると、この会社への請求も出ます</div>`}
    </div>
    <p class="text-2xs text-neutral-400 mt-2">今日までの確定・代打のシフトの合計です（単価・交通費・調整。精算の確定前の概算を含みます）。支払は、支払先がこの協力会社のシフトです</p>`
}
delegate('partnerDetailMonth', async (el) => {
  const d = PARTNERS.detail; if (!d) return
  PARTNERS.month = el.dataset.month
  const box = document.getElementById('partner-deals'); if (!box) return
  try {
    const data = (await axios.get('/api/admin/roster/partners/' + Number(d.partner.affiliation_id), { params: { month: PARTNERS.month } })).data
    PARTNERS.detail = data; box.innerHTML = partnerDealsHtml(data)
  } catch (e) { showApiError(e, '実績を読み込めませんでした') }
})
delegate('partnerLinkClient', (el) => withSubmitLock(el, async () => {
  const sel = document.getElementById('pt-link-client')
  const cid = Number(sel && sel.value)
  if (!cid) { toast('クライアントを選んでください'); return }
  try {
    await axios.put(`/api/admin/roster/partners/${Number(el.dataset.id)}/client`, { client_id: cid })
    toast('クライアントとつなぎました'); renderPartners()
  } catch (e) { showApiError(e, 'つなげませんでした') }
}))
delegate('partnerUnlinkClient', (el) => withSubmitLock(el, async () => {
  const p = partnerById(el.dataset.id); if (!p) return
  if (!confirm(`「${p.affiliation_name}」とクライアント「${p.client_name}」のつながりを外します。よろしいですか？\n（協力会社・クライアントのデータは消えません）`)) return
  try {
    await axios.put(`/api/admin/roster/partners/${Number(el.dataset.id)}/client`, { client_id: null })
    toast('つながりを外しました'); renderPartners()
  } catch (e) { showApiError(e, '外せませんでした') }
}))
// 協力会社の登録（#9909。クライアントの登録と同じ項目・並び）。一覧の「編集」は、詳細の会社基本情報の編集欄を開く
delegate('partnerEdit', (el) => withSubmitLock(el, async () => {
  if (el.dataset.id) {
    const id = Number(el.dataset.id)
    PARTNERS.editOnOpen = id
    if (location.hash === '#partners/' + id) renderPartnerDetail(id)
    else location.hash = '#partners/' + id
    return
  }
  try { await loadAssigneeOptions(true) } catch (e) { showApiError(e, '社内担当者の選択肢を読み込めませんでした'); return }
  const f = (id, label, attrs = '') => `<div><label class="text-sm text-neutral-600 block mb-1">${label}</label><input id="${id}" class="inp" ${attrs}></div>`
  modal(`
    <h3 class="font-bold text-lg mb-4">協力会社の登録</h3>
    <div class="space-y-3">
      ${f('pt-name', '協力会社名 *', 'maxlength="100"')}
      ${f('pt-name-kana', 'フリガナ', 'maxlength="100" placeholder="ひらがなでも入力できます（カタカナで保存します）"')}
      <div><label class="text-sm text-neutral-600 block mb-1">種別</label><select id="pt-kind" class="inp">${clientKindOptions('')}</select></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${f('pt-rep', '代表者氏名', 'maxlength="100"')}
        ${f('pt-company-phone', '電話', 'type="tel" maxlength="20"')}
      </div>
      ${f('pt-company-email', 'メール', 'type="email" maxlength="254"')}
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        ${f('pt-postal', '郵便番号', 'inputmode="numeric" maxlength="10" placeholder="123-4567" data-halfwidth="1"')}
        <div class="sm:col-span-2">${f('pt-address', '住所', 'maxlength="300"')}</div>
      </div>
      ${f('pt-url', 'ホームページ', 'type="url" maxlength="500" placeholder="https://example.co.jp"')}
      ${f('pt-payment', '支払条件', 'maxlength="200" placeholder="月末締め・翌月末払い"')}
      ${f('pt-invoice', 'インボイス登録番号', 'maxlength="20" placeholder="T1234567890123"')}
      <div><p class="text-sm text-neutral-600 mb-1">社内担当者</p>${assigneesEditorHtml('pt', [])}</div>
      <div><label class="text-sm text-neutral-600 block mb-1">備考</label><textarea id="pt-memo" rows="2" class="inp" maxlength="2000"></textarea></div>
      <p class="text-2xs text-neutral-400">名前や住所が似た会社と区別できるよう、住所やホームページを入れておくと一覧で見分けられます。先方の担当者・支店・部門・評価は、登録した後に詳細で入れられます</p>
    </div>
    <div class="flex gap-2 mt-4">
      <button class="btn btn-outline flex-1" onclick="closeModal()">キャンセル</button>
      <button class="btn btn-primary flex-1" data-action="partnerSave">登録する</button>
    </div>`)
}))
delegate('partnerSave', (el) => withSubmitLock(el, async () => {
  const v = (id) => (document.getElementById(id).value || '').trim()
  const body = { affiliation_name: v('pt-name'), affiliation_name_kana: v('pt-name-kana'), partner_kind: v('pt-kind'), representative_name: v('pt-rep'), company_phone: v('pt-company-phone'),
    company_email: v('pt-company-email'), postal_code: v('pt-postal'), address: v('pt-address'), website_url: v('pt-url'), payment_rule: v('pt-payment'),
    invoice_number: v('pt-invoice'), memo: document.getElementById('pt-memo').value, assignees: collectAssignees('pt') }
  if (!body.affiliation_name) { toast('協力会社名を入力してください'); return }
  try {
    const { data } = await axios.post('/api/admin/roster/partners', body)
    closeModal(); toast('協力会社を登録しました')
    if (data && data.affiliation_id) location.hash = '#partners/' + Number(data.affiliation_id)
    else renderPartners()
  } catch (e) { showApiError(e, '保存に失敗しました') }
}))
delegate('partnerMerge', (el) => {
  const p = partnerById(el.dataset.id); if (!p) return
  const others = PARTNERS.list.filter(x => x.affiliation_id !== p.affiliation_id)
  modal(`
    <h3 class="font-bold text-lg mb-1">協力会社の統合</h3>
    <p class="text-sm text-neutral-600 mb-3">「${esc(p.affiliation_name)}」を、次の協力会社にまとめます（同じ会社が表記ゆれで分かれているとき）。</p>
    <select id="pt-merge-into" class="inp">${others.map(x => `<option value="${Number(x.affiliation_id)}">${esc(x.affiliation_name)}（${Number(x.staff_count) || 0}名）</option>`).join('')}</select>
    <ul class="text-xs text-neutral-500 mt-3 space-y-1">
      <li>・所属スタッフ ${Number(p.staff_count) || 0}名の所属会社を、統合先に付け替えます</li>
      <li>・精算が確定していないシフトの支払先も、統合先に付け替えます（確定済みの精算は変えません）</li>
      <li>・統合先の住所・ホームページ・担当者・電話・メールなどが空欄なら、「${esc(p.affiliation_name)}」の値で埋めます。メモは後ろに足します</li>
      ${p.client_id ? `<li>・クライアント「${esc(p.client_name)}」とのつながりは、統合先がほかのクライアントとつながっていなければ統合先に移します</li>` : ''}
      <li>・統合した協力会社は一覧と選択肢から消えます（元に戻せません）</li>
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
  if (!confirm(`協力会社「${p.affiliation_name}」を削除します。よろしいですか？`)) return
  try { await axios.delete('/api/admin/roster/partners/' + Number(p.affiliation_id)); toast('削除しました'); renderPartners() } catch (e) { showApiError(e, '削除に失敗しました') }
}))

// ---------- クライアント詳細の「協力会社としての支払」の欄（#9302。admin.js の renderClientDetail から呼ぶ） ----------
// 取引の実績（#client-deals）の下に足す。つながっていなければ、つなげる協力会社を選べるようにする
const CLIENT_PARTNER = { cid: null, month: '' }
window.renderClientPartnerPanel = async function (cid, month) {
  cid = Number(cid)
  if (CLIENT_PARTNER.cid !== cid) { CLIENT_PARTNER.cid = cid; CLIENT_PARTNER.month = '' }
  CLIENT_PARTNER.month = month || CLIENT_PARTNER.month || (typeof CLIENT_DETAIL === 'object' && CLIENT_DETAIL.month) || dayjs().format('YYYY-MM')
  let data
  try { data = (await axios.get('/api/admin/roster/partners/by-client/' + cid, { params: { month: CLIENT_PARTNER.month } })).data } catch (e) { return }
  // 読み込みの間に別の画面へ移ったときは描かない
  if (location.hash !== '#clients/' + cid) return
  let box = document.getElementById('client-partner-panel')
  if (!box) {
    const anchor = document.getElementById('client-deals')
    if (!anchor) return
    anchor.insertAdjacentHTML('afterend', '<section class="card p-4 lg:col-span-2" id="client-partner-panel"></section>')
    box = document.getElementById('client-partner-panel')
  }
  const head = '<i class="fas fa-handshake text-accent-500 mr-1"></i>協力会社としての支払'
  if (data.partner) {
    const p = data.partner, s = data.summary || {}, pay = s.pay || { total: 0, shifts: 0, staff: 0, unset: 0 }
    box.innerHTML = `
      <div class="flex items-center gap-2 mb-2 flex-wrap">
        <h3 class="text-sm font-bold text-neutral-700">${head}</h3>
        <span class="ml-auto">${monthNavHtml('clientPartnerMonth', s.month)}</span>
      </div>
      <p class="text-sm text-neutral-700 mb-3">この会社は、協力会社「<a href="#partners/${Number(p.affiliation_id)}" class="text-primary-600 hover:underline font-medium">${esc(p.affiliation_name)}</a>」でもあります（スタッフの所属会社・支払先）。</p>
      <div class="flex items-center gap-3 flex-wrap">
        <div class="bg-neutral-50 rounded-lg p-3 min-w-[14rem]"><p class="text-xs text-neutral-500">${esc(monthLabel(s.month))}の支払（この会社へ）</p>
          <p class="text-lg font-bold text-accent-700">${yen(pay.total)}</p>
          <p class="text-xs text-neutral-500 mt-0.5">${Number(pay.shifts)}件・${Number(pay.staff)}名${pay.unset ? `<span class="text-warning-600">（支払額が未設定 ${Number(pay.unset)}件は含みません）</span>` : ''}</p></div>
        <a href="#partners/${Number(p.affiliation_id)}" class="btn btn-outline text-xs"><i class="fas fa-arrow-right"></i>協力会社の詳細</a>
      </div>
      <p class="text-2xs text-neutral-400 mt-2">今日までの確定・代打のシフトのうち、支払先がこの協力会社のものの合計です（精算の確定前の概算を含みます）</p>`
    return
  }
  const cand = data.candidates || []
  box.innerHTML = `
    <h3 class="text-sm font-bold text-neutral-700 mb-1">${head}</h3>
    <p class="text-xs text-neutral-500">この会社が協力会社（スタッフの所属会社・支払先）でもあるときは、協力会社とつなぐと、協力会社としての月の支払がここに出ます。</p>
    ${cand.length ? `<div class="flex gap-2 flex-wrap mt-2">
      <select id="cl-link-partner" class="inp text-sm flex-1 min-w-[12rem]"><option value="">協力会社を選ぶ</option>
        ${cand.map(p => `<option value="${Number(p.affiliation_id)}">${esc(p.affiliation_name)}</option>`).join('')}</select>
      <button class="btn btn-outline text-xs" data-action="clientLinkPartner" data-cid="${cid}"><i class="fas fa-link"></i>つなぐ</button>
    </div>` : '<p class="text-xs text-neutral-400 mt-1">つなげる協力会社がありません（協力会社は <a href="#partners" class="text-primary-600 hover:underline">協力会社</a> で登録します）</p>'}`
}
delegate('clientPartnerMonth', (el) => { if (CLIENT_PARTNER.cid) renderClientPartnerPanel(CLIENT_PARTNER.cid, el.dataset.month) })
delegate('clientLinkPartner', (el) => withSubmitLock(el, async () => {
  const sel = document.getElementById('cl-link-partner')
  const pid = Number(sel && sel.value)
  if (!pid) { toast('協力会社を選んでください'); return }
  try {
    await axios.put(`/api/admin/roster/partners/${pid}/client`, { client_id: Number(el.dataset.cid) })
    toast('協力会社とつなぎました'); renderClientPartnerPanel(Number(el.dataset.cid))
  } catch (e) { showApiError(e, 'つなげませんでした') }
}))

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
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-id-badge text-primary-600 mr-1"></i>連携用IDの一覧</h3>
    <p class="text-xs text-neutral-500 mb-2">選んだスタッフの氏名と連携用ID（FS／RL）を、CSV または印刷用の一覧で出します。稼働先は「新規追加 → IDをまとめて連携」で一度に連携できます。</p>
    <div class="text-xs bg-warning-50 text-warning-800 rounded-lg p-2 mb-3">IDを渡した企業は、いつでもそのスタッフを連携できます。渡す相手を確かめてください。連携されると自社に通知が届き、スタッフ詳細の「連携先企業」から終了できます。</div>
    <div class="flex gap-2 items-center mb-2">
      <input id="sc-q" class="inp text-sm flex-1" placeholder="氏名・フリガナ・番号で絞り込み">
      <label class="text-xs text-neutral-600 flex items-center gap-1 whitespace-nowrap"><input type="checkbox" id="sc-all">表示中をすべて選択</label>
    </div>
    <div class="max-h-[50vh] overflow-y-auto border border-neutral-100 rounded-lg" id="sc-rows"></div>
    <p class="text-xs text-neutral-500 mt-2" id="sc-count"></p>
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
  box.innerHTML = list.map(s => `<label class="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-50 text-sm cursor-pointer">
      <input type="checkbox" class="sc-pick" value="${Number(s.staff_id)}" ${SHARE_LIST.picked.has(Number(s.staff_id)) ? 'checked' : ''}>
      <span class="flex-1">${esc(s.name)} <span class="text-2xs text-neutral-400">${esc(s.kana || '')}</span></span>
      <span class="text-2xs text-neutral-400">${s.affiliation_type === 'linked_external' ? '他社連携' : '自社雇用'}</span></label>`).join('')
    || '<p class="text-center text-neutral-400 text-sm py-6">連携用IDを共有できるスタッフはいません（在籍中の自社雇用・他社連携のスタッフが対象です）</p>'
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
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-users-line text-primary-600 mr-1"></i>IDをまとめて連携</h3>
    <p class="text-xs text-neutral-500 mb-3">所属元の企業から受け取ったスタッフID（FS… / RL…）を、1行に1人ずつ貼り付けてください（所属元が出力した CSV の中身をそのまま貼り付けてもかまいません）。一度に ${ROSTER_BULK_MAX}人まで。</p>
    <textarea id="rb-codes" rows="8" class="inp font-mono text-sm" placeholder="FS1A2B3C4D5E&#10;FS2B3C4D5E6F">${esc(prefill || '')}</textarea>
    <div id="rb-result" class="mt-3"></div>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-outline" data-action="showAddRoster" title="作成方法の選択に戻る" aria-label="作成方法の選択に戻る"><i class="fas fa-arrow-left"></i></button>
      ${MODAL_CANCEL_BTN}
      <button class="btn btn-primary flex-1" data-action="rosterBulkCheck"><i class="fas fa-magnifying-glass"></i>確認する</button>
    </div>`)
}
delegate('rosterBulkCheck', (el) => withSubmitLock(el, async () => {
  const { codes, bad } = parseRosterCodes(document.getElementById('rb-codes').value)
  const box = document.getElementById('rb-result')
  if (!codes.length) { box.innerHTML = '<div class="p-3 rounded-lg bg-danger-50 text-danger-600 text-sm">スタッフIDが見つかりません（「FS」または「RL」で始まる12文字です）</div>'; return }
  if (codes.length > ROSTER_BULK_MAX) { box.innerHTML = `<div class="p-3 rounded-lg bg-danger-50 text-danger-600 text-sm">一度に連携できるのは${ROSTER_BULK_MAX}人までです（${codes.length}人分のIDがあります）</div>`; return }
  box.innerHTML = `<p class="text-sm text-neutral-500"><span class="spin"></span> <span id="rb-checking">確認しています（0/${codes.length}）</span></p>`
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
    <div class="max-h-[40vh] overflow-y-auto border border-neutral-100 rounded-lg">
      <table class="tbl"><thead><tr><th></th><th>氏名</th><th>所属元</th><th>ID</th><th>状態</th></tr></thead><tbody>
      ${items.map((x, i) => `<tr>
        <td>${x.status === 'ok' ? `<input type="checkbox" class="rb-pick" value="${i}" checked>` : ''}</td>
        <td>${esc(x.name || '-')}${x.kana ? `<div class="text-2xs text-neutral-400">${esc(x.kana)}</div>` : ''}</td>
        <td class="text-xs">${esc(x.owner || '')}</td>
        <td class="font-mono text-xs">${esc(x.code)}</td>
        <td class="text-xs">${label[x.status] || `<span class="text-danger-600">${esc(x.error || '')}</span>`}${x.status === 'already' && x.staff_id ? ` <a class="text-primary-600 underline" href="#staff/${Number(x.staff_id)}" onclick="closeModal()">開く</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    ${ROSTER_BULK.bad.length ? `<p class="text-xs text-warning-700 mt-2">IDが見つからない行（${ROSTER_BULK.bad.length}行）: ${ROSTER_BULK.bad.slice(0, 5).map(esc).join('、')}${ROSTER_BULK.bad.length > 5 ? ' …' : ''}</p>` : ''}
    ${okCount ? '<button class="btn btn-primary w-full mt-3" data-action="rosterBulkConsent"><i class="fas fa-link"></i>選んだ人を連携する（同意の確認へ）</button>' : '<p class="text-sm text-neutral-500 mt-2">連携できる人はいません</p>'}`
}
delegate('rosterBulkConsent', () => {
  const picks = [...document.querySelectorAll('#rb-result .rb-pick:checked')].map(cb => ROSTER_BULK.items[Number(cb.value)]).filter(Boolean)
  if (!picks.length) { toast('連携する人を選んでください'); return }
  const consent = ROSTER_BULK.consent
  if (!consent) { toast('同意文面を取得できませんでした。もう一度確認してください'); return }
  ROSTER_BULK.picks = picks
  const owners = [...new Set(picks.map(x => x.owner).filter(Boolean))]
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-shield-halved text-primary-600 mr-1"></i>情報共有の同意確認（${picks.length}人）</h3>
    <p class="text-sm text-neutral-600 mb-2">「${owners.map(esc).join('」「')}」に所属する次の <b>${picks.length}人</b> を自社のスタッフマスタに連携します。連携すると、以下の範囲の情報が所属元企業から共有されます。</p>
    <div class="text-xs text-neutral-700 max-h-24 overflow-y-auto p-2 rounded-lg border border-neutral-100 mb-3">${picks.map(x => esc(x.name)).join('、')}</div>
    <div class="grid sm:grid-cols-2 gap-3 text-xs">
      <div class="p-3 rounded-lg bg-primary-50">
        <p class="font-bold text-primary-700 mb-1"><i class="fas fa-check mr-1"></i>共有される情報（スタッフマスタ項目のみ）</p>
        <ul class="list-disc ml-4 text-primary-900 space-y-0.5">${consent.shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
      <div class="p-3 rounded-lg bg-neutral-50">
        <p class="font-bold text-neutral-600 mb-1"><i class="fas fa-ban mr-1"></i>共有されない情報</p>
        <ul class="list-disc ml-4 text-neutral-600 space-y-0.5">${consent.not_shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      </div>
    </div>
    <ul class="text-xs text-neutral-500 mt-3 space-y-1">
      <li>・基本項目（氏名・スキル等）は所属元企業のみが編集でき、自社では閲覧のみとなります。</li>
      <li>・自社では評価・メモ・フォロー記録などの追記、およびシフト登録ができます。</li>
      <li>・共有情報は、スタッフの稼働管理の目的の範囲内でのみ利用してください。</li>
      <li>・同意の記録は1人ずつ保存され、所属元企業とスタッフ本人に連携されたことが通知されます。</li>
    </ul>
    <label class="flex items-start gap-2 mt-4 p-3 rounded-lg border border-neutral-200 cursor-pointer">
      <input type="checkbox" id="rb-agree" class="mt-0.5" onchange="document.getElementById('rb-submit').disabled = !this.checked">
      <span class="text-sm text-neutral-700">上記の${picks.length}人について、共有範囲と利用条件を確認し、同意します（同意の記録は保存されます）</span>
    </label>
    <p class="text-sm text-neutral-600 mt-2 hidden" id="rb-progress"></p>
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
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-circle-check text-success-600 mr-1"></i>まとめて連携の結果</h3>
    <p class="text-sm text-neutral-600 mb-3">${okN}人を連携しました${results.length - okN ? `（連携できなかった人 ${results.length - okN}人）` : ''}。${picks.length > results.length ? `残りの${picks.length - results.length}人は連携していません。` : ''}</p>
    <div class="max-h-[50vh] overflow-y-auto"><table class="tbl"><thead><tr><th>氏名</th><th>結果</th></tr></thead><tbody>
      ${results.map(r => `<tr><td>${r.staff_id ? `<a class="text-primary-700 hover:underline" href="#staff/${Number(r.staff_id)}" onclick="closeModal()">${esc(r.name)}</a>` : esc(r.name)}</td>
        <td class="text-xs">${r.ok ? '<span class="badge badge-green">連携しました</span>' : `<span class="text-danger-600">${esc(r.error)}</span>`}</td></tr>`).join('')}
    </tbody></table></div>
    <button class="btn btn-outline w-full mt-4" data-action="rosterBulkClose">閉じる</button>`)
  if (okN) toast(`${okN}人を連携しました`)
}))
delegate('rosterBulkClose', () => {
  closeModal()
  if ((location.hash || '#dashboard') === '#staff' && typeof renderStaff === 'function') renderStaff({ reload: true })
})

// 作成方法の選択（showAddRoster）の下の、まとめて連携・連携用IDの一覧への入口
delegate('rosterOpenBulkLink', () => showRosterBulkLink())
delegate('rosterOpenShareList', () => showShareCodeList())
