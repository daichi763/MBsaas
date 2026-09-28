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
      </button>`)
  }
  // routes テーブルは staff.js 内の const のため直接差し替える
  if (typeof routes === 'object') routes.more = window.renderMore
}
