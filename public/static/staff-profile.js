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
    return `<ul class="space-y-1">${rows.map(r => `<li class="whitespace-pre-wrap break-words">
      ${r.from || r.to ? `<span class="text-xs text-gray-500">${esc(r.from || '')}〜${esc(r.to || '')}</span> ` : ''}${esc(r.company || '')}${r.work ? ` <span class="text-gray-600">${esc(r.work)}</span>` : ''}${r.note ? ` <span class="text-xs text-gray-400">（${esc(r.note)}）</span>` : ''}</li>`).join('')}</ul>`
  }
  return p.career ? `<span class="whitespace-pre-wrap break-words">${esc(p.career)}</span>` : '-'
}
function skillsHtml(v) {
  const list = String(v || '').split(/[,、，\n]/).map(s => s.trim()).filter(Boolean)
  return list.length ? `<span class="flex flex-wrap gap-1">${list.map(s => `<span class="badge badge-gray">${esc(s)}</span>`).join('')}</span>` : '-'
}

window.renderMyProfile = async function () {
  loading()
  let p
  try { p = (await axios.get('/api/staff/me/profile')).data.profile } catch { $app.innerHTML = '<p class="text-center text-gray-400 py-10">プロフィールを取得できませんでした</p>'; return }
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
      <p class="text-[11px] text-gray-400 mt-2">内容の変更は所属会社の担当者にご連絡ください。</p>
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

// 「その他」メニューに項目を追加
const _origRenderMore = window.renderMore || (typeof renderMore === 'function' ? renderMore : null)
if (_origRenderMore) {
  window.renderMore = function () {
    _origRenderMore()
    const wrap = $app.querySelector('.space-y-3')
    if (wrap) wrap.insertAdjacentHTML('beforeend', `
      <button class="report-btn" onclick="renderMyProfile()">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-id-badge"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">マイプロフィール / スタッフID</span><span class="block text-xs text-gray-400">登録情報と企業間連携用QRコード</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>
      <button class="report-btn" onclick="renderChangePassword()">
        <span class="w-11 h-11 rounded-xl bg-gray-100 text-gray-600 flex items-center justify-center text-lg"><i class="fas fa-lock"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">パスワードの変更</span><span class="block text-xs text-gray-400">ログインのパスワードを変更します</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>`)
  }
  // routes テーブルは staff.js 内の const のため直接差し替える
  if (typeof routes === 'object') routes.more = window.renderMore
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
    </section>`
}
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
