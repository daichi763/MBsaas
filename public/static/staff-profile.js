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

// ホーム: 本日のシフトが他社の場合・複数ある場合の表示（打刻は企業を切り替えずにそのまま行える）
if (typeof routes === 'object' && routes.home) {
  const _origHome = routes.home
  routes.home = window.renderHome = async function () {
    await _origHome()
    const d = typeof HOME === 'object' && HOME
    const card = document.getElementById('today-shift')
    if (!d || !card || !d.today_shifts) return
    const cur = d.today_shifts.find(s => s.shift_id === (d.shift && d.shift.shift_id))
    if (cur && cur.other_company) {
      card.insertAdjacentHTML('beforeend', `<p class="text-xs mt-2 text-blue-700 bg-blue-50 rounded-lg px-2 py-1"><i class="fas fa-building mr-1"></i>${esc(cur.company_name)} のシフトです。報告は自動的に ${esc(cur.company_name)} に送られます。</p>`)
    }
    if (d.today_shifts.length > 1) {
      card.insertAdjacentHTML('beforeend', `<div class="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500">本日のシフト（${d.today_shifts.length}件）:
        ${d.today_shifts.map(s => `<div class="flex justify-between mt-0.5"><span>${esc(s.start_time)}〜${esc(s.end_time)} ${esc(s.project_name)}</span><span>${esc(s.company_name)}${s.checked_out ? ' ✓' : ''}</span></div>`).join('')}
        <p class="text-[11px] text-gray-400 mt-1">退店報告が済むと、次のシフトの報告に切り替わります。</p></div>`)
    }
  }
}
// シフト: 他社シフトに企業名を表示
if (typeof routes === 'object' && routes.shift) {
  const _origShift = window.renderShifts || renderShifts
  window.renderShifts = async function (month) {
    await _origShift(month)
    try {
      const m = month || dayjs().format('YYYY-MM')
      const { data } = await axios.get('/api/staff/shifts?month=' + m)
      if (!data.shifts.some(s => s.other_company)) return
      const rows = document.querySelectorAll('#shift-list .mt-1\\.5')
      const sorted = [...data.shifts].sort((a, b) => a.work_date < b.work_date ? -1 : a.work_date > b.work_date ? 1 : 0)
      rows.forEach((el, i) => { const s = sorted[i]; if (s && s.other_company) el.querySelector('p').insertAdjacentHTML('beforeend', ` <span class="badge badge-purple">${esc(s.company_name)}</span>`) })
    } catch { /* 表示補助のみ */ }
  }
  routes.shift = () => window.renderShifts()
}
