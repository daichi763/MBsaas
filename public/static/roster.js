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
      <button class="w-full text-left p-3 rounded-xl border border-dashed border-gray-300 hover:border-orange-400 hover:bg-orange-50 transition" data-action="showRosterImport">
        <p class="font-bold text-sm text-gray-800"><i class="fas fa-file-csv text-orange-600 w-5"></i>CSV でまとめて登録（②③④）</p>
        <p class="text-xs text-gray-500 mt-1 ml-5">導入時の名簿の移行や、まとめて受け入れるときに。テンプレートに記入して取り込み、重複などを確かめてから登録します。</p>
      </button>
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
  return `<div class="p-3 rounded-lg ${failed.length ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'} text-xs space-y-2" id="ri-result">
    <p class="font-bold"><i class="fas fa-circle-check mr-1"></i>${created.length}人を登録しました${failed.length ? `（登録しなかった行: ${failed.length}）` : ''}</p>
    ${withPw.length ? `<p>ログインを作った ${withPw.length}人の初期パスワードは、この画面でしか確認できません。ログイン案内（CSV）を保存して、本人に伝えてください（初回のログインでパスワードの変更を求めます）。</p>
      <button class="btn btn-primary text-xs" data-action="downloadRosterImportLogins"><i class="fas fa-download"></i>ログイン案内をダウンロード（CSV）</button>` : ''}
    ${failed.length ? `<ul class="space-y-0.5">${failed.map(r => `<li>${Number(r.line)}行目 ${esc(r.name || '')}: ${esc(r.status === 'skipped' ? '警告があるため登録しませんでした' : (r.errors || []).join(' / ') || '登録できませんでした')}</li>`).join('')}</ul>` : ''}
  </div>`
}
window.showRosterImport = function () {
  modal(`
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-file-csv text-orange-600 mr-1"></i>CSV でまとめて登録</h3>
    <p class="text-xs text-gray-500 mb-3">テンプレートの CSV に1行1人で記入して選んでください。登録の前に、必須項目の不足・スタッフ番号や社員番号の重複・同じ人と思われる登録済みのスタッフを確かめます。
      区分は「自社雇用」「取引先」「スキルシートのみ」です（他社から連携するスタッフは ①スタッフIDから連携 で登録してください）。</p>
    ${ROSTER_IMPORT.downloaded ? '' : rosterImportResultHtml()}
    <div class="flex gap-2 flex-wrap items-center mt-3">
      <a class="btn btn-outline text-xs" href="/api/admin/roster/import/template"><i class="fas fa-download"></i>テンプレートをダウンロード</a>
      <input type="file" id="ri-file" accept=".csv,text/csv" class="text-xs flex-1 min-w-0">
    </div>
    <p class="text-[11px] text-gray-400 mt-1">文字コードは UTF-8 と Shift_JIS（Excel で保存した CSV）に対応しています。1回に${ROSTER_IMPORT_MAX_ROWS}行まで。</p>
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
  try { records = parseCsvText(decodeCsvBuffer(await file.arrayBuffer())) } catch { box.innerHTML = '<p class="text-xs text-red-500">ファイルを読めませんでした</p>'; return }
  const header = records[0] || []
  // 空の行は読み飛ばす。行番号は CSV の何行目か（見出しが1行目）
  const rows = records.slice(1).map((cells, i) => ({ line: i + 2, cells })).filter(r => r.cells.some(v => String(v).trim()))
  if (!rows.length) { box.innerHTML = '<p class="text-xs text-red-500">登録する行がありません</p>'; return }
  if (rows.length > ROSTER_IMPORT_MAX_ROWS) { box.innerHTML = `<p class="text-xs text-red-500">${rows.length}行あります。1回に${ROSTER_IMPORT_MAX_ROWS}行までにして、ファイルを分けてください</p>`; return }
  Object.assign(ROSTER_IMPORT, { header, rows, preview: null })
  try {
    ROSTER_IMPORT.preview = (await axios.post('/api/admin/roster/import/preview', { header, rows })).data
  } catch (e) {
    const d = e.response && e.response.data
    box.innerHTML = `<p class="text-xs text-red-500">${esc((d && d.error) || '確かめられませんでした')}</p>`
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
    ${p.unknown_columns && p.unknown_columns.length ? `<p class="text-xs text-amber-700 mb-2"><i class="fas fa-triangle-exclamation mr-1"></i>読まない列: ${p.unknown_columns.map(esc).join('・')}（見出しがテンプレートと違います）</p>` : ''}
    <div class="max-h-[40vh] overflow-auto border border-gray-100 rounded-lg">
      <table class="w-full text-xs"><thead class="sticky top-0 bg-gray-50"><tr class="text-left text-gray-500">
        <th class="p-1.5">行</th><th class="p-1.5">区分</th><th class="p-1.5">氏名</th><th class="p-1.5">スタッフ番号</th><th class="p-1.5">確認の結果</th></tr></thead>
        <tbody>${p.rows.map(r => `<tr class="border-t border-gray-100 align-top ${r.errors.length ? 'bg-red-50' : r.warnings.length ? 'bg-amber-50' : ''}">
          <td class="p-1.5">${Number(r.line)}</td><td class="p-1.5 whitespace-nowrap">${esc(r.type_label || '')}</td><td class="p-1.5 whitespace-nowrap">${esc(r.name || '')}</td>
          <td class="p-1.5 whitespace-nowrap">${r.login ? esc(r.user_code || '自動') : '<span class="text-gray-400">ログインなし</span>'}</td>
          <td class="p-1.5">${r.errors.length || r.warnings.length || r.notes.length ? msg(r.errors, 'text-red-600') + msg(r.warnings, 'text-amber-700') + msg(r.notes, 'text-gray-500') : '<span class="text-emerald-600">登録できます</span>'}</td></tr>`).join('')}</tbody></table>
    </div>
    ${s.warning ? `<label class="flex items-start gap-2 text-xs mt-3"><input type="checkbox" id="ri-accept" class="mt-0.5">
      <span>警告のある行も登録する（同じ人と思われるスタッフがいる行は、別の人であることを確かめてから登録してください）</span></label>` : ''}
    <p class="text-xs text-gray-500 mt-2">エラーの行は登録しません。CSV を直して、もう一度選び直すこともできます。</p>
    <div id="ri-progress" class="text-xs text-gray-500 mt-2"></div>
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
          <div class="p-2.5 rounded-lg bg-gray-50 mb-2">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-bold text-gray-800">${esc(l.host_company_name)}</span>
              <span class="text-gray-400">連携 ${esc((l.consented_at || l.linked_at || '').slice(0, 10))}</span>
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
          </div>`).join('') : `<p class="text-sm text-gray-400">${!p.linkable ? '連携対象外のスタッフです' : p.link_shareable ? 'まだ他社には連携されていません' : '退職・停止中のため、新しく連携することはできません'}</p>`}
        <p class="text-[11px] text-gray-400 mt-1">稼働先の追記内容は閲覧のみです（編集は稼働先企業が行います）。<a href="#roster-notes" class="text-blue-600 hover:underline">連携先からの追記の一覧</a></p>
      </section>`
  }
  if (links && links.role === 'host') {
    linkHtml += `
      <section class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-shield-halved text-blue-500 mr-1"></i>連携の同意履歴</h3>
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
