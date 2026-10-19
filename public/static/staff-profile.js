// Field OS スタッフ画面: 自分のスタッフマスタ情報・連携用QR（フェーズE）
// staff.js のヘルパー（loading / esc / $app）を利用する。staff.js の後に読み込むこと。
// ※企業間チャット・稼働先追記項目・評価メモ等は本人には一切表示しない（APIも返さない）。
const GENDER_LABEL = { male: '男性', female: '女性', other: 'その他', unspecified: '回答しない' }

window.renderMyProfile = async function () {
  loading()
  let p
  try { p = (await axios.get('/api/staff/me/profile')).data.profile } catch { $app.innerHTML = '<p class="text-center text-gray-400 py-10">プロフィールを取得できませんでした</p>'; return }
  const row = (k, v) => `<div class="flex py-2 border-b border-gray-50 last:border-0"><dt class="w-28 text-gray-400 shrink-0">${k}</dt><dd class="flex-1 text-gray-800">${esc(v || '-')}</dd></div>`
  let qr = ''
  if (p.global_staff_code && window.qrcode) {
    const q = qrcode(0, 'M'); q.addData(p.global_staff_code); q.make()
    qr = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
  }
  $app.innerHTML = `
    <button class="text-sm text-blue-600 mb-3" onclick="renderMore()"><i class="fas fa-chevron-left mr-1"></i>戻る</button>
    ${p.global_staff_code ? `
      <section class="card p-4 mb-3 text-center">
        <p class="text-xs text-gray-500 mb-2">スタッフID（企業間連携用・恒久固定）</p>
        ${qr ? `<div class="w-44 h-44 mx-auto">${qr}</div>` : ''}
        <p class="font-mono text-lg font-bold tracking-widest mt-1">${esc(p.global_staff_code)}</p>
        <p class="text-[11px] text-gray-400 mt-2">稼働先の担当者に提示すると、スタッフマスタ項目（氏名・スキル等）のみが共有されます。給与・口座などの雇用情報は共有されません。</p>
      </section>` : ''}
    <section class="card p-4">
      <h3 class="text-sm font-bold text-gray-700 mb-2">登録情報</h3>
      <dl class="text-sm">
        ${row('氏名', p.name)}${row('フリガナ', p.kana)}${row('性別', GENDER_LABEL[p.gender])}
        ${row('生年月日', p.date_of_birth)}${row('所属会社', p.affiliation)}
        ${row('最寄駅', [p.nearest_station_line, p.nearest_station].filter(Boolean).join(' '))}
        ${row('稼働エリア', p.work_area)}${row('スキル', p.skills)}${row('経歴', p.career)}
      </dl>
      <p class="text-[11px] text-gray-400 mt-2">内容の変更は所属会社の担当者にご連絡ください。</p>
    </section>`
}

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
// ヘッダーに所属企業の切替を表示（2社以上に所属している場合のみ）
async function renderCompanySwitcher() {
  let data
  try { data = (await axios.get('/api/staff/me/companies')).data } catch { return }
  if (!data.companies || data.companies.length < 2) return
  const nameEl = document.getElementById('user-name')
  if (!nameEl || document.getElementById('company-switch')) return
  nameEl.insertAdjacentHTML('beforebegin', `
    <select id="company-switch" class="text-xs border border-gray-200 rounded-lg px-1.5 py-1 max-w-[9rem]" title="表示する所属企業（お知らせ・相談の切替）">
      ${data.companies.map(c => `<option value="${c.company_id}" ${c.current ? 'selected' : ''}>${esc(c.company_name)}</option>`).join('')}
    </select>`)
  document.getElementById('company-switch').addEventListener('change', async (e) => {
    try {
      const r = await axios.post('/api/staff/me/switch-company', { company_id: Number(e.target.value) })
      toast(r.data.company_name + ' に切り替えました'); setTimeout(() => location.reload(), 400)
    } catch (err) { toast((err.response && err.response.data && err.response.data.error) || '切り替えに失敗しました') }
  })
}
setTimeout(renderCompanySwitcher, 300)

// ホーム・シフト一覧の会社名（他社のシフト）と、同じ日の複数のシフトの一覧は staff.js が描く（#503 #504）
