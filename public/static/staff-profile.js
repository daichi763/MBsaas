// Field OS スタッフ画面: 自分のスタッフマスタ情報・連携用QR（フェーズE）
// staff.js のヘルパー（loading / esc / $app）を利用する。staff.js の後に読み込むこと。
// ※企業間チャット・稼働先追記項目・評価メモ等は本人には一切表示しない（APIも返さない）。
const GENDER_LABEL = { male: '男性', female: '女性', other: 'その他', unspecified: '回答しない' }

// 表示中のスタッフID（コピー・共有のボタンから使う。onclick に値を埋め込まない）
const MY_STAFF_ID = { code: '', name: '' }
// 読みやすいよう4文字ずつ区切る（FS1A 2B3C 4D5E）。連携画面の検索は空白を取り除いて照合する
const groupStaffId = (code) => String(code || '').replace(/(.{4})(?=.)/g, '$1 ')

// 経歴: 表形式（career_rows）があれば1行ずつ、なければ要約の改行をそのまま出す（#259）
function careerHtml(p) {
  let rows = []
  try { const a = JSON.parse(p.career_rows || '[]'); if (Array.isArray(a)) rows = a } catch { rows = [] }
  if (rows.length) {
    // dd は改行をそのまま出す（whitespace-pre-wrap）ため、タグの間に改行・字下げを入れない
    return `<ul class="space-y-1">${rows.map(r => `<li class="whitespace-pre-wrap break-words">${r.from || r.to ? `<span class="text-xs text-gray-500">${esc(r.from || '')}〜${esc(r.to || '')}</span> ` : ''}${esc(r.company || '')}${r.work ? ` <span class="text-gray-600">${esc(r.work)}</span>` : ''}${r.note ? ` <span class="text-xs text-gray-400">（${esc(r.note)}）</span>` : ''}</li>`).join('')}</ul>`
  }
  return p.career ? `<span class="whitespace-pre-wrap break-words">${esc(p.career)}</span>` : '-'
}
function skillsHtml(v) {
  const list = String(v || '').split(/[,、，\n]/).map(s => s.trim()).filter(Boolean)
  return list.length ? `<span class="flex flex-wrap gap-1">${list.map(s => `<span class="badge badge-gray">${esc(s)}</span>`).join('')}</span>` : '-'
}

// 共有中の会社（#285）: あなたのスタッフ情報を企業間連携で参照している会社と連携日。所属会社が連携を終了した会社は「終了」と出す
function sharedWithHtml(list) {
  const rows = Array.isArray(list) ? list : []
  const day = (v) => String(v || '').slice(0, 10)
  return `<section class="card p-4 mb-3">
      <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-share-nodes text-blue-500 mr-1"></i>あなたの情報を共有中の会社</h3>
      ${rows.length ? `<ul class="text-sm divide-y divide-gray-50">${rows.map(r => `<li class="flex items-center gap-2 py-2">
          <span class="flex-1 min-w-0 break-words ${r.ended ? 'text-gray-400' : 'text-gray-800'}">${esc(r.company_name)}</span>
          <span class="text-[11px] text-gray-400 whitespace-nowrap">連携 ${esc(day(r.linked_at))}</span>
          ${r.ended ? `<span class="badge badge-gray">終了 ${esc(day(r.ended_at))}</span>` : '<span class="badge badge-blue">共有中</span>'}</li>`).join('')}</ul>`
        : '<p class="text-sm text-gray-400">他の会社とは共有していません</p>'}
      <p class="text-[11px] text-gray-400 mt-2">スタッフIDを使って他の会社に連携されると、通知でお知らせします。心当たりのない会社があるときは、所属会社の担当者に連絡してください（所属会社が連携を終了できます）。</p>
    </section>`
}
window.renderMyProfile = async function () {
  loading()
  let p
  // 読み込めなかったら、再読み込みのボタンを出す（#524。staff.js の showLoadError）
  try { p = (await axios.get('/api/staff/me/profile')).data.profile } catch (e) {
    if (typeof showLoadError === 'function') showLoadError(e)
    else $app.innerHTML = '<p class="text-center text-gray-400 py-10">プロフィールを取得できませんでした</p>'
    return
  }
  // 値は esc 済みの HTML で渡す（経歴・スキルは複数行・バッジで出すため）
  const rowHtml = (k, html) => `<div class="flex py-2 border-b border-gray-50 last:border-0"><dt class="w-28 text-gray-400 shrink-0">${k}</dt><dd class="flex-1 min-w-0 text-gray-800 whitespace-pre-wrap break-words">${html}</dd></div>`
  const row = (k, v) => rowHtml(k, esc(v == null || v === '' ? '-' : v))
  MY_STAFF_ID.code = p.global_staff_code || ''; MY_STAFF_ID.name = p.name || ''
  const terms = p.share_terms || { shared: [], not_shared: [] }
  const logins = p.logins || []
  $app.innerHTML = `
    <button class="text-sm text-blue-600 mb-3" onclick="renderMore()"><i class="fas fa-chevron-left mr-1"></i>戻る</button>
    ${logins.length ? `
      <section class="card p-4 mb-3">
        <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-right-to-bracket text-blue-500 mr-1"></i>ログイン情報</h3>
        ${logins.map(l => `<dl class="text-sm ${logins.length > 1 ? 'mb-2 pb-2 border-b border-gray-100 last:border-0' : ''}">
          ${logins.length > 1 ? `<p class="text-xs font-bold text-gray-500">${esc(l.company_name)}</p>` : ''}
          ${row('会社コード', l.company_code)}${row('スタッフ番号', l.user_code)}
          ${row('電話番号', l.phone_masked || '未登録')}
          ${rowHtml('メール', l.email_masked ? esc(l.email_masked) : '<span class="text-amber-700">未登録（パスワードを忘れたときの再設定に使います。所属会社の担当者に登録を依頼してください）</span>')}
        </dl>`).join('')}
        <p class="text-[11px] text-gray-400 mt-1">機種変更などでログインし直すときに使います。パスワードは表示しません。</p>
      </section>` : ''}
    ${p.global_staff_code ? `
      <section class="card p-4 mb-3">
        <p class="text-xs text-gray-500 mb-2 text-center">スタッフID（企業間連携用）${p.qr_company_name && p.qr_company_name !== p.company_name ? `<br><span class="text-[11px]">${esc(p.qr_company_name)} に所属するスタッフとしてのIDです</span>` : ''}</p>
        <div class="text-xs bg-amber-50 text-amber-800 rounded-lg p-3 space-y-1">
          <p class="font-bold"><i class="fas fa-triangle-exclamation mr-1"></i>IDを見せる前に確認してください</p>
          <p>このIDは変わりません（再発行・取り消しはできません）。IDを見せた会社は、いつでもあなたを自社のスタッフとして連携できます。信頼できる稼働先の担当者にだけ見せてください。</p>
        </div>
        <div class="grid grid-cols-2 gap-2 text-[11px] mt-2">
          <div class="p-2 rounded-lg bg-blue-50"><p class="font-bold text-blue-700 mb-1">共有される情報</p>
            <ul class="list-disc ml-4 text-blue-900 space-y-0.5">${terms.shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
            <p class="text-blue-800 mt-1">「PRポイント等」「備考」は所属会社の担当者が記入する欄で、この画面には表示されませんが共有されます。</p></div>
          <div class="p-2 rounded-lg bg-gray-50"><p class="font-bold text-gray-600 mb-1">共有されない情報</p>
            <ul class="list-disc ml-4 text-gray-600 space-y-0.5">${terms.not_shared.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>
        </div>
        <div id="my-staff-id" class="mt-3 text-center">
          <button class="btn btn-primary w-full" data-action="showMyStaffId"><i class="fas fa-qrcode"></i>共有範囲を確認してIDを表示する</button>
        </div>
      </section>` : ''}
    ${sharedWithHtml(p.shared_with)}
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">登録情報</h3>
      <dl class="text-sm">
        ${row('氏名', p.name)}${row('フリガナ', p.kana)}${row('性別', GENDER_LABEL[p.gender])}
        ${row('生年月日', p.date_of_birth)}${row('所属会社', p.affiliation)}
        ${row('最寄駅', [p.nearest_station_line, p.nearest_station].filter(Boolean).join(' '))}
        ${row('通勤可能時間', p.commute_minutes != null && p.commute_minutes !== '' ? p.commute_minutes + '分' : '')}
        ${row('稼働開始可能日', p.available_from)}
        ${row('稼働エリア', p.work_area)}${rowHtml('スキル', skillsHtml(p.skills))}${rowHtml('経歴', careerHtml(p))}
      </dl>
      <a href="#profile-request" class="btn btn-outline w-full mt-3"><i class="fas fa-pen"></i>最寄駅・稼働エリアなどの変更を申請する</a>
      <p class="text-[11px] text-gray-400 mt-2">氏名・生年月日などほかの項目の変更は、所属会社の担当者にご連絡ください。</p>
    </section>`
}
// 確認してから QR とIDを出す（うっかり見せないように。#229）。コピー・共有のボタンも出す（#475）
delegate('showMyStaffId', () => {
  const box = document.getElementById('my-staff-id')
  if (!box || !MY_STAFF_ID.code) return
  let qr = ''
  if (window.qrcode) {
    const q = qrcode(0, 'M'); q.addData(MY_STAFF_ID.code); q.make()
    qr = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
  }
  box.innerHTML = `
    ${qr ? `<div class="w-44 h-44 mx-auto">${qr}</div>` : ''}
    <p class="font-mono text-lg font-bold tracking-widest mt-1">${esc(groupStaffId(MY_STAFF_ID.code))}</p>
    <div class="flex gap-2 mt-2">
      <button class="btn btn-outline flex-1" data-action="copyMyStaffId"><i class="fas fa-copy"></i>IDをコピー</button>
      ${navigator.share ? '<button class="btn btn-outline flex-1" data-action="shareMyStaffId"><i class="fas fa-share-nodes"></i>共有</button>' : ''}
    </div>`
})
async function copyTextToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { /* 使えない端末では下の方法でコピーする */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = !!(document.execCommand && document.execCommand('copy')) } catch { ok = false }
  ta.remove()
  return ok
}
delegate('copyMyStaffId', async () => {
  if (!MY_STAFF_ID.code) return
  toast(await copyTextToClipboard(MY_STAFF_ID.code) ? 'スタッフIDをコピーしました' : 'コピーできませんでした。IDを書き写してください')
})
delegate('shareMyStaffId', async () => {
  if (!MY_STAFF_ID.code || !navigator.share) return
  try { await navigator.share({ text: `Field OS スタッフID: ${MY_STAFF_ID.code}（${MY_STAFF_ID.name}）` }) } catch (e) {
    if (!e || e.name !== 'AbortError') toast('共有できませんでした。「IDをコピー」を使ってください')
  }
})

// 「その他」メニューに項目を追加。画面は URL（#profile・#password）で開く（戻る・下のタブで戻れるように #374）
const _origRenderMore = window.renderMore || (typeof renderMore === 'function' ? renderMore : null)
if (_origRenderMore) {
  window.renderMore = function () {
    if (_origRenderMore() === false) return false // URL を #more に変えて描き直す途中
    const wrap = $app.querySelector('.space-y-3')
    if (wrap) wrap.insertAdjacentHTML('beforeend', `
      <a href="#profile" class="report-btn">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-id-badge"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">マイプロフィール / スタッフID</span><span class="block text-xs text-gray-400">登録情報と企業間連携用QRコード</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </a>
      <a href="#my-docs" class="report-btn">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-file-arrow-up"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">書類の提出</span><span class="block text-xs text-gray-400">資格証・身分証・入社書類などを写真やPDFで提出</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </a>
      <a href="#my-leave" class="report-btn hidden" id="more-leave-link">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-umbrella-beach"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">有給・休暇</span><span class="block text-xs text-gray-400">有給の残日数の確認と休暇の申請</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </a>
      <a href="#password" class="report-btn">
        <span class="w-11 h-11 rounded-xl bg-gray-100 text-gray-600 flex items-center justify-center text-lg"><i class="fas fa-lock"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">パスワードの変更</span><span class="block text-xs text-gray-400">ログインのパスワードを変更します</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </a>`)
    showLeaveMenuIfEligible()
  }
  // routes テーブルは staff.js 内の const のため直接差し替える
  if (typeof routes === 'object') {
    routes.more = window.renderMore
    routes.profile = () => window.renderMyProfile()
    routes.password = () => window.renderChangePassword()
  }
}

// =========================================================
// パスワードの変更（#43）。管理者が発行した仮パスワード・初期パスワードのままなら、ログイン直後に変更を求める
// =========================================================
function passwordFormHtml(prefix) {
  return `
    <div class="space-y-3">
      <div><label class="text-sm text-gray-600 block mb-1">現在のパスワード</label><input id="${prefix}-current" type="password" class="inp" autocomplete="current-password"></div>
      <div><label class="text-sm text-gray-600 block mb-1">新しいパスワード（8文字以上）</label><input id="${prefix}-new" type="password" class="inp" autocomplete="new-password"></div>
      <div><label class="text-sm text-gray-600 block mb-1">新しいパスワード（確認）</label><input id="${prefix}-new2" type="password" class="inp" autocomplete="new-password"></div>
      <button class="btn btn-primary w-full" data-action="staffChangePassword" data-prefix="${prefix}">変更する</button>
    </div>`
}
window.renderChangePassword = function () {
  $app.innerHTML = `
    <button class="text-sm text-blue-600 mb-3" onclick="renderMore()"><i class="fas fa-chevron-left mr-1"></i>戻る</button>
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-lock text-blue-500 mr-1"></i>パスワードの変更</h3>
      ${passwordFormHtml('spw')}
      <p class="text-[11px] text-gray-400 mt-3">変更すると、ほかの端末のログインは終了します。パスワードを忘れたときは、登録したメールアドレスで再設定するか、所属会社の担当者に再発行を依頼してください。</p>
    </section>
    <section class="card p-4 mt-3">
      <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-mobile-screen text-blue-500 mr-1"></i>ログイン中の端末</h3>
      <div id="my-sessions" class="text-sm text-gray-500">読み込み中...</div>
      <button class="btn btn-outline w-full mt-3" data-action="staffLogoutAll"><i class="fas fa-right-from-bracket"></i>すべての端末からログアウト</button>
      <p class="text-[11px] text-gray-400 mt-2">機種変更の前の端末や、共用の端末にログインが残っているときに使います。この端末もログアウトします。</p>
    </section>`
  loadMySessions()
}
// 自分のログイン中の端末と、すべての端末からのログアウト（#453。スマホの紛失・機種変更・共用端末のログアウト忘れ）
async function loadMySessions() {
  const box = document.getElementById('my-sessions'); if (!box) return
  try {
    const { data } = await axios.get('/api/auth/sessions')
    box.innerHTML = data.sessions.length ? `<ul class="divide-y divide-gray-100">${data.sessions.map(s => `
      <li class="py-1.5"><span class="text-gray-800">${esc(s.device)}</span>${s.current ? ' <span class="badge badge-blue">この端末</span>' : ''}
        <span class="block text-[11px] text-gray-400">ログイン ${esc(dayjs(String(s.created_at).replace(' ', 'T') + (/[TZ]/.test(String(s.created_at)) ? '' : 'Z')).format('M/D HH:mm'))}</span></li>`).join('')}</ul>` : 'ログイン中の端末はありません'
  } catch (e) { box.textContent = '読み込めませんでした' }
}
delegate('staffLogoutAll', (el) => {
  if (!confirm('すべての端末（この端末を含む）からログアウトします。よろしいですか？')) return
  withSubmitLock(el, async () => {
    try { await axios.post('/api/auth/logout-all'); location.href = '/login' } catch (e) { showApiError(e, 'ログアウトできませんでした') }
  })
})
delegate('staffChangePassword', (el) => withSubmitLock(el, async () => {
  const p = el.dataset.prefix
  const cur = document.getElementById(p + '-current').value
  const next = document.getElementById(p + '-new').value
  if (next !== document.getElementById(p + '-new2').value) { toast('新しいパスワード（確認）が一致しません'); return }
  try {
    await axios.post('/api/auth/change-password', { current_password: cur, new_password: next })
    toast('パスワードを変更しました')
    if (p === 'fpw') closeModal()
    else renderMore()
  } catch (e) { showApiError(e, 'パスワードの変更に失敗しました') }
}))
// 仮パスワードのままなら、閉じられない画面で変更を求める（背景のタップでは閉じない）
;(async () => {
  let me
  try { me = (await axios.get('/api/auth/me')).data } catch { return }
  if (!me || !me.must_change_password) return
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg"><div class="modal-box p-5">
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-key text-blue-600 mr-1"></i>パスワードを変更してください</h3>
    <p class="text-xs text-gray-500 mb-3">所属会社の担当者が発行したパスワードのままです。自分だけが知っているパスワードに変更してから使ってください。</p>
    ${passwordFormHtml('fpw')}
  </div></div>`
})()

// =========================================================
// フェーズH: 統合ログイン（企業切替）/ 勤怠の自動振り分けの表示
// =========================================================
// 所属企業を切り替えて、今の画面（URL の #以降）を開き直す。お知らせの画面からも呼ぶ（staff.js）
window.switchStaffCompany = async function (companyId) {
  const r = await axios.post('/api/staff/me/switch-company', { company_id: Number(companyId) })
  toast(r.data.company_name + ' に切り替えました'); setTimeout(() => location.reload(), 400)
}
// ヘッダーに所属企業の切替を表示（2社以上に所属している場合のみ）。
// 切り替えていない企業に未読のお知らせがあれば、件数を選択肢に出し、切替に印を付ける（#203）
async function renderCompanySwitcher() {
  let data
  try { data = (await axios.get('/api/staff/me/companies')).data } catch { return }
  if (!data.companies || data.companies.length < 2) return
  const nameEl = document.getElementById('user-name')
  if (!nameEl || document.getElementById('company-switch')) return
  const otherUnread = data.companies.filter(c => !c.current).reduce((s, c) => s + (Number(c.unread_notices) || 0), 0)
  nameEl.insertAdjacentHTML('beforebegin', `
    <span class="relative inline-flex">
      <select id="company-switch" class="text-xs border ${otherUnread ? 'border-red-300' : 'border-gray-200'} rounded-lg px-1.5 py-1 max-w-[9rem]"
        title="表示する所属企業（お知らせ・相談の切替）${otherUnread ? `。ほかの所属企業に未読のお知らせが ${otherUnread}件 あります` : ''}">
        ${data.companies.map(c => `<option value="${Number(c.company_id)}" ${c.current ? 'selected' : ''}>${esc(c.company_name)}${!c.current && c.unread_notices ? `（未読${Number(c.unread_notices)}）` : ''}</option>`).join('')}
      </select>
      ${otherUnread ? '<span class="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500" aria-hidden="true"></span>' : ''}
    </span>`)
  const sel = document.getElementById('company-switch')
  // 切り替えに失敗したら、選択欄を今のセッションの会社に戻す（#466）。
  // 通信が途中で切れた場合はサーバー側で切り替わっていることもあるため、今の会社を問い合わせ直して合わせる
  sel.addEventListener('change', async (e) => {
    sel.disabled = true
    try { await switchStaffCompany(Number(e.target.value)) } catch (err) {
      let current = data.current_company_id
      if (!err.response) {
        try { current = (await axios.get('/api/staff/me/companies')).data.current_company_id } catch { /* 元の会社に戻す */ }
      }
      if (Number(current) !== Number(data.current_company_id)) { location.reload(); return }
      sel.value = String(data.current_company_id); sel.disabled = false
      showApiError(err, '切り替えに失敗しました。表示している会社は「' + ((data.companies.find(c => c.current) || {}).company_name || '') + '」のままです')
    }
  })
}
setTimeout(renderCompanySwitcher, 300)

// ホーム・シフト一覧の会社名（他社のシフト）と、同じ日の複数のシフトの一覧は staff.js が描く（#503 #504）

// =========================================================
// スタッフ本人の手続き（作業単位 w5-staff-self-service）
//   #profile-request 登録情報の変更申請（#272）/ #my-docs 書類の提出（#288 #297）/ #my-leave 有給の残日数と休暇の申請（#289）
// 結果は通知（#notifications）にも届く。API は /api/staff/self/*（src/staff-self-service.ts）
// =========================================================
const SELF_STATUS = { pending: ['承認待ち', 'badge-yellow'], approved: ['承認済み', 'badge-green'], rejected: ['見送り', 'badge-red'], cancelled: ['取り消し', 'badge-gray'] }
const selfStatusBadge = (s) => { const [l, cls] = SELF_STATUS[s] || [s, 'badge-gray']; return `<span class="badge ${cls}">${esc(l)}</span>` }
const selfDate = (at) => esc(String(at || '').slice(0, 16).replace(/^(\d{4})-(\d{2})-(\d{2})/, (m, y, mo, d) => `${Number(mo)}/${Number(d)}`))
const selfLoadFailed = (back) => { $app.innerHTML = `${back}<div class="card p-6 text-center mt-2" role="alert"><p class="text-sm text-gray-500">読み込めませんでした。通信状況を確かめて、もう一度開いてください</p>
  <button class="btn btn-primary mt-4" data-action="retryLoad"><i class="fas fa-rotate-right"></i>再読み込み</button></div>` }
const SELF_WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

// 『その他』の「有給・休暇」は自社雇用の社員だけに出す（企業を切り替えると画面ごと読み直すので、1回だけ問い合わせる）
let SELF_SUMMARY = null
async function showLeaveMenuIfEligible() {
  try { if (!SELF_SUMMARY) SELF_SUMMARY = (await axios.get('/api/staff/self/summary')).data } catch { return }
  const el = document.getElementById('more-leave-link')
  if (el && SELF_SUMMARY.leave_eligible) el.classList.remove('hidden')
}

// ---------- 登録情報の変更申請（#272） ----------
const PROFILE_BACK = '<a href="#profile" class="text-sm text-blue-600 mb-3 inline-block"><i class="fas fa-chevron-left mr-1"></i>マイプロフィールへ戻る</a>'
window.renderProfileRequest = async function () {
  loading()
  let d
  try { d = (await axios.get('/api/staff/self/profile-requests')).data } catch { selfLoadFailed(PROFILE_BACK); return }
  const L = d.labels, cur = d.current || {}
  const show = (v) => v == null || v === '' ? '（空欄）' : String(v)
  const inp = (k, type, ph) => `<div><label class="text-sm text-gray-600 block mb-1" for="pr-${k}">${esc(L[k])}</label>
    <input id="pr-${k}" type="${type}" class="inp" value="${esc(cur[k] ?? '')}" ${ph ? `placeholder="${esc(ph)}"` : ''} ${type === 'number' ? 'min="0" max="1440" inputmode="numeric"' : ''}></div>`
  let form
  if (!d.available) form = `<p class="text-sm text-gray-600">${esc(d.reason)}</p>`
  else if (d.pending) form = '<p class="text-sm bg-amber-50 text-amber-800 rounded-lg p-3">承認待ちの申請があります。内容を変えるときは、下の申請を取り消してから出し直してください。</p>'
  else form = `
    <p class="text-xs text-gray-500 mb-3">変えたい項目だけ書き換えて送ってください。${esc(d.target_company_name)} の担当者が確認して、承認されたら登録が変わります。</p>
    <div class="space-y-3">
      ${inp('nearest_station_line', 'text', '例: JR山手線')}${inp('nearest_station', 'text', '例: 渋谷')}
      ${inp('commute_minutes', 'number', '例: 60')}${inp('available_from', 'date')}${inp('work_area', 'text', '例: 東京都23区・神奈川県東部')}
      <div><label class="text-sm text-gray-600 block mb-1" for="pr-skills">${esc(L.skills)}（読点か改行で区切る）</label><textarea id="pr-skills" class="inp" rows="3" maxlength="1000">${esc(cur.skills ?? '')}</textarea></div>
      ${d.email_allowed ? `<div><label class="text-sm text-gray-600 block mb-1" for="pr-login_email">${esc(L.login_email)}（変えるときだけ入力）</label>
        <input id="pr-login_email" type="email" class="inp" autocomplete="email" placeholder="今: ${esc(cur.login_email || '未登録')}">
        <p class="text-[11px] text-gray-400 mt-1">承認されると確認用のメールが届きます。メールのリンクを開くと切り替わります。</p></div>` : ''}
      <div><label class="text-sm text-gray-600 block mb-1" for="pr-note">補足（任意）</label><textarea id="pr-note" class="inp" rows="2" maxlength="500" placeholder="例: 引っ越しのため"></textarea></div>
      <button class="btn btn-primary w-full" data-action="submitProfileRequest"><i class="fas fa-paper-plane"></i>変更を申請する</button>
    </div>`
  $app.innerHTML = `${PROFILE_BACK}
    <section class="card p-4 mb-3"><h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-pen text-blue-500 mr-1"></i>登録情報の変更申請</h3>${form}</section>
    ${d.requests.length ? `<section class="card p-4"><h3 class="text-sm font-bold text-gray-700 mb-2">これまでの申請</h3><div class="space-y-3">${d.requests.map(r => `
      <div class="border-b border-gray-100 pb-2 last:border-0">
        <div class="flex items-center gap-2 flex-wrap text-xs text-gray-500">${selfStatusBadge(r.status)}<span>${selfDate(r.created_at)} 申請</span>${r.company_name ? `<span>${esc(r.company_name)}</span>` : ''}</div>
        <ul class="text-sm mt-1 space-y-0.5">${Object.keys(r.changes || {}).map(k => `<li class="break-words"><span class="text-gray-400">${esc(L[k] || k)}:</span> ${esc(show(r.before && r.before[k]))} → <b>${esc(show(r.changes[k]))}</b></li>`).join('')}</ul>
        ${r.review_comment ? `<p class="text-xs text-gray-600 mt-1">担当者のコメント: ${esc(r.review_comment)}</p>` : ''}
        ${r.status === 'pending' ? `<button class="btn btn-outline text-xs mt-1" data-action="cancelProfileRequest" data-id="${Number(r.request_id)}">この申請を取り消す</button>` : ''}
      </div>`).join('')}</div></section>` : ''}`
}
delegate('submitProfileRequest', el => withSubmitLock(el, async () => {
  const changes = {}
  for (const k of ['nearest_station_line', 'nearest_station', 'commute_minutes', 'available_from', 'work_area', 'skills', 'login_email']) {
    const f = document.getElementById('pr-' + k)
    if (!f) continue
    if (k === 'login_email' && !f.value.trim()) continue
    changes[k] = f.value
  }
  try {
    const { data } = await axios.post('/api/staff/self/profile-requests', { changes, note: (document.getElementById('pr-note') || {}).value || '' })
    toast(`${data.target_company_name || '所属会社'} に変更を申請しました`)
    renderProfileRequest()
  } catch (e) { showApiError(e, '申請できませんでした') }
}))
delegate('cancelProfileRequest', el => {
  if (!confirm('この変更申請を取り消しますか？')) return
  withSubmitLock(el, async () => {
    try { await axios.post(`/api/staff/self/profile-requests/${Number(el.dataset.id)}/cancel`); toast('申請を取り消しました'); renderProfileRequest() } catch (e) { showApiError(e, '取り消せませんでした') }
  })
})

// ---------- 書類の提出（#288 #297） ----------
const MY_DOC_LABEL = { resume: '履歴書', qualification: '資格証', id_card: '身分証', residence_card: '在留カード', bank: '口座の確認書類', onboarding: '入社書類', other: 'その他' }
function myDocExpiryBadge(v) {
  if (!v) return ''
  const days = dayjs(v).diff(dayjs().startOf('day'), 'day')
  if (days < 0) return `<span class="badge badge-red">期限切れ ${esc(v)}</span>`
  if (days <= 30) return `<span class="badge badge-yellow">期限まで${days}日</span>`
  return `<span class="badge badge-gray">期限 ${esc(v)}</span>`
}
window.renderMyDocs = async function () {
  loading()
  let d
  try { d = (await axios.get('/api/staff/self/documents')).data } catch { selfLoadFailed(MORE_BACK); return }
  const types = d.types || Object.keys(MY_DOC_LABEL)
  $app.innerHTML = `${MORE_BACK}
    <section class="card p-4 mb-3">
      <h3 class="text-sm font-bold text-gray-700 mb-1"><i class="fas fa-file-arrow-up text-blue-500 mr-1"></i>書類を提出する</h3>
      <p class="text-xs text-gray-500 mb-3">提出先: ${esc(d.company_name || '')}。担当者だけが見られます。文字が読めるように、明るい所で全体を写してください。</p>
      <div class="space-y-3">
        <div><label class="text-sm text-gray-600 block mb-1" for="md-type">書類の種類</label>
          <select id="md-type" class="inp"><option value="">選んでください</option>${types.map(t => `<option value="${esc(t)}">${esc(MY_DOC_LABEL[t] || t)}</option>`).join('')}</select></div>
        <div><label class="text-sm text-gray-600 block mb-1" for="md-valid">有効期限（資格証・在留カードなど。ない場合は空欄）</label><input id="md-valid" type="date" class="inp"></div>
        <div class="grid grid-cols-2 gap-2">
          <label class="btn btn-primary w-full cursor-pointer"><i class="fas fa-camera"></i>撮影して提出<input type="file" accept="image/*" capture="environment" class="hidden" data-doc-input="1"></label>
          <label class="btn btn-outline w-full cursor-pointer"><i class="fas fa-folder-open"></i>写真・PDFを選ぶ<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" class="hidden" data-doc-input="1"></label>
        </div>
        <p id="md-msg" class="text-xs text-gray-500" role="status"></p>
      </div>
    </section>
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">提出した書類</h3>
      ${d.documents.length ? `<div class="space-y-2">${d.documents.map(x => `
        <div class="flex items-center gap-2 p-2 rounded-lg bg-gray-50">
          <div class="flex-1 min-w-0">
            <p class="text-sm text-gray-800 truncate">${esc(x.original_file_name)}</p>
            <div class="flex flex-wrap gap-1 mt-0.5">${x.doc_type ? `<span class="badge badge-blue">${esc(MY_DOC_LABEL[x.doc_type] || x.doc_type)}</span>` : ''}${myDocExpiryBadge(x.valid_until)}
              ${x.confirmed_at ? '<span class="badge badge-green">担当者が確認済み</span>' : '<span class="badge badge-yellow">確認待ち</span>'}
              <span class="text-[11px] text-gray-400">${selfDate(x.uploaded_at)} 提出</span></div>
          </div>
          <a class="btn btn-outline text-xs" href="/api/staff/self/documents/${Number(x.document_id)}/download" target="_blank" rel="noopener" aria-label="開く"><i class="fas fa-download"></i></a>
          ${x.confirmed_at ? '' : `<button class="btn btn-danger text-xs" data-action="deleteMyDoc" data-id="${Number(x.document_id)}" data-name="${esc(x.original_file_name)}" aria-label="削除"><i class="fas fa-trash"></i></button>`}
        </div>`).join('')}</div>
        <p class="text-[11px] text-gray-400 mt-2">担当者が確認した書類は削除できません。期限が切れたら新しい書類を提出してください。</p>` : '<p class="text-sm text-gray-400">まだ提出した書類はありません</p>'}
    </section>`
  $app.querySelectorAll('input[data-doc-input]').forEach(inp => inp.addEventListener('change', () => uploadMyDoc(inp)))
}
async function uploadMyDoc(inp) {
  const file = inp.files && inp.files[0]
  inp.value = ''
  const msg = document.getElementById('md-msg')
  const type = document.getElementById('md-type').value
  if (!file) return
  if (!type) { toast('書類の種類を選んでください'); return }
  const labels = $app.querySelectorAll('label.btn')
  labels.forEach(l => l.classList.add('opacity-50', 'pointer-events-none'))
  msg.textContent = '送信しています…'
  try {
    let upload = file
    // 写真は入店報告と同じ方法で小さくしてから送る（小さくできなくても、JPEG・PNG・WebP ならそのまま送る）
    if (/^image\//.test(file.type)) {
      try {
        const blob = await compressImage(file)
        upload = new File([blob], String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
      } catch (e) {
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { msg.textContent = ''; toast(e.message || '画像を読み込めませんでした'); return }
      }
    }
    const form = new FormData()
    form.append('file', upload); form.append('doc_type', type)
    const valid = document.getElementById('md-valid').value
    if (valid) form.append('valid_until', valid)
    await axios.post('/api/staff/self/documents', form)
    toast('書類を提出しました')
    renderMyDocs()
  } catch (e) {
    msg.textContent = ''
    showApiError(e, '提出できませんでした。通信状況を確かめて、もう一度お試しください')
  } finally { labels.forEach(l => l.classList.remove('opacity-50', 'pointer-events-none')) }
}
delegate('deleteMyDoc', el => {
  if (!confirm(`${el.dataset.name} を削除しますか？`)) return
  withSubmitLock(el, async () => {
    try { await axios.delete(`/api/staff/self/documents/${Number(el.dataset.id)}`); toast('削除しました'); renderMyDocs() } catch (e) { showApiError(e, '削除できませんでした') }
  })
})

// ---------- 有給の残日数と休暇の申請（#289） ----------
const MY_LEAVE_TYPE = { paid: '有給休暇', other: 'その他の休暇（無給・特別休暇など）' }
const MY_LEAVE_UNIT = { full: '全日', am: '午前半休', pm: '午後半休' }
window.renderMyLeave = async function () {
  loading()
  let d
  try { d = (await axios.get('/api/staff/self/leave')).data } catch { selfLoadFailed(MORE_BACK); return }
  if (!d.eligible) { $app.innerHTML = `${MORE_BACK}<section class="card p-4 text-sm text-gray-600">有給・休暇の申請は、所属会社に雇用されている社員のみ利用できます。休みの連絡は「相談・連絡」から担当者に伝えてください。</section>`; return }
  const b = d.balance || {}
  const num = (v, unit) => v == null || v === '' ? '<span class="text-gray-400">未登録</span>' : `<b class="text-lg">${esc(v)}</b>${unit}`
  $app.innerHTML = `${MORE_BACK}
    <section class="card p-4 mb-3">
      <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-umbrella-beach text-blue-500 mr-1"></i>有給の残日数</h3>
      <div class="grid grid-cols-2 gap-2 text-sm">
        <div class="p-2 rounded-lg bg-blue-50"><p class="text-xs text-gray-500">有給の残り</p><p>${num(b.paid_leave_remaining, '日')}</p>
          ${b.pending_paid_days ? `<p class="text-[11px] text-amber-700">承認待ち ${esc(b.pending_paid_days)}日</p>` : ''}</div>
        <div class="p-2 rounded-lg bg-gray-50"><p class="text-xs text-gray-500">今月のテレワーク残り</p><p>${num(b.telework_remaining_this_month, '回')}</p></div>
      </div>
      <p class="text-[11px] text-gray-400 mt-2">付与日: ${esc(b.paid_leave_granted_at || '未登録')}。残日数は担当者が登録した値です。違っている場合は担当者に確認してください。</p>
    </section>
    <section class="card p-4 mb-3">
      <h3 class="text-sm font-bold text-gray-700 mb-2">休暇を申請する</h3>
      <div class="space-y-3">
        <div><label class="text-sm text-gray-600 block mb-1" for="lv-date">日付</label><input id="lv-date" type="date" class="inp" min="${esc(dayjs().subtract(31, 'day').format('YYYY-MM-DD'))}"></div>
        <div class="grid grid-cols-2 gap-2">
          <div><label class="text-sm text-gray-600 block mb-1" for="lv-type">種類</label><select id="lv-type" class="inp">${Object.entries(MY_LEAVE_TYPE).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
          <div><label class="text-sm text-gray-600 block mb-1" for="lv-unit">全日・半休</label><select id="lv-unit" class="inp">${Object.entries(MY_LEAVE_UNIT).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
        </div>
        <div><label class="text-sm text-gray-600 block mb-1" for="lv-reason">理由（任意）</label><textarea id="lv-reason" class="inp" rows="2" maxlength="500"></textarea></div>
        <button class="btn btn-primary w-full" data-action="submitLeave"><i class="fas fa-paper-plane"></i>申請する</button>
        <p class="text-[11px] text-gray-400">その日にシフトが入っている場合は、承認の後に担当者がシフトを調整します。</p>
      </div>
    </section>
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">申請の一覧</h3>
      ${d.requests.length ? `<div class="space-y-2">${d.requests.map(l => `
        <div class="border-b border-gray-100 pb-2 last:border-0 text-sm">
          <div class="flex items-center gap-2 flex-wrap"><b>${esc(dayjs(l.leave_date).format('M/D'))}（${SELF_WEEKDAY[dayjs(l.leave_date).day()]}）</b>
            <span class="text-xs text-gray-600">${esc((MY_LEAVE_TYPE[l.leave_type] || l.leave_type).replace(/（.*）/, ''))}・${esc(MY_LEAVE_UNIT[l.leave_unit] || l.leave_unit)}</span>${selfStatusBadge(l.status)}</div>
          ${l.reason ? `<p class="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">${esc(l.reason)}</p>` : ''}
          ${l.review_comment ? `<p class="text-xs text-gray-600 mt-0.5">担当者のコメント: ${esc(l.review_comment)}</p>` : ''}
          ${l.status === 'pending' ? `<button class="btn btn-outline text-xs mt-1" data-action="cancelLeave" data-id="${Number(l.leave_id)}">取り消す</button>` : ''}
        </div>`).join('')}</div>` : '<p class="text-sm text-gray-400">まだ申請はありません</p>'}
    </section>`
}
delegate('submitLeave', el => withSubmitLock(el, async () => {
  const date = document.getElementById('lv-date').value
  if (!date) { toast('日付を選んでください'); return }
  try {
    await axios.post('/api/staff/self/leave', { leave_date: date, leave_type: document.getElementById('lv-type').value, leave_unit: document.getElementById('lv-unit').value,
      reason: document.getElementById('lv-reason').value })
    toast('休暇を申請しました'); renderMyLeave()
  } catch (e) { showApiError(e, '申請できませんでした') }
}))
delegate('cancelLeave', el => {
  if (!confirm('この休暇の申請を取り消しますか？')) return
  withSubmitLock(el, async () => {
    try { await axios.post(`/api/staff/self/leave/${Number(el.dataset.id)}/cancel`); toast('取り消しました'); renderMyLeave() } catch (e) { showApiError(e, '取り消せませんでした') }
  })
})

// 通知の行き先: この作業単位の通知（変更申請・休暇の結果）は、それぞれの画面を開く。
// 通知の一覧（staff-attendance.js）は知らない種類を打刻修正の申請へ送るので、その前に振り分ける
const SELF_NOTIF_LINK = /^#(profile-request|my-leave|my-docs)$/
const _origNotifOpenStaff = window.notifOpenStaff
if (typeof _origNotifOpenStaff === 'function') {
  window.notifOpenStaff = async function (id) {
    let n = null
    try { n = (await axios.get('/api/staff/notifications?limit=100')).data.notifications.find(x => x.notification_id === id) } catch { /* 元の処理に任せる */ }
    if (n && SELF_NOTIF_LINK.test(n.link || '') && /^(profile_change_|leave_)/.test(n.kind || '')) {
      try { await axios.post(`/api/staff/notifications/${id}/read`) } catch { /* 既読にできなくても画面は開く */ }
      location.hash = n.link.slice(1)
      return
    }
    return _origNotifOpenStaff(id)
  }
}

// 画面の URL（staff.js の routes・titles・MORE_SUB_TABS に足す。下のタブは『その他』を選んだ表示にする）
if (typeof routes === 'object') {
  routes['profile-request'] = () => window.renderProfileRequest()
  routes['my-docs'] = () => window.renderMyDocs()
  routes['my-leave'] = () => window.renderMyLeave()
  if (typeof titles === 'object') Object.assign(titles, { 'profile-request': '登録情報の変更申請', 'my-docs': '書類の提出', 'my-leave': '有給・休暇' })
  if (typeof MORE_SUB_TABS === 'object') MORE_SUB_TABS.push('profile-request', 'my-docs', 'my-leave')
}
