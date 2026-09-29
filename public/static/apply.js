// =========================================================
// 公開の募集ページ（/apply/:token）。ログイン不要で、日時を選んで応募する（管理者の承認で確定）
// docs/spec_spot_shift.md 第4段階。API: /api/public/recruit/:token
// =========================================================
(function () {
  const $app = document.getElementById('app')
  const TOKEN = location.pathname.split('/').pop()
  const API = '/api/public/recruit/' + encodeURIComponent(TOKEN)
  const WD = ['日', '月', '火', '水', '木', '金', '土']
  let DATA = null
  const picked = new Set()
  let tsToken = '', tsWidget = null

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]))
  const nl2br = (s) => esc(s).replace(/\n/g, '<br>')
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d
  const fmt = (d) => { const x = dayjs(d); return `${x.format('M/D')}(${WD[x.day()]})` }
  function toast(msg) {
    let root = document.getElementById('toast'); if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
    const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg; root.appendChild(el); setTimeout(() => el.remove(), 3000)
  }

  async function load() {
    $app.innerHTML = '<div class="flex justify-center py-16"><span class="spin"></span></div>'
    try { DATA = (await axios.get(API)).data } catch (e) {
      const d = e.response && e.response.data
      $app.innerHTML = `<section class="card p-6 text-center mt-6" id="apply-closed"><i class="fas fa-calendar-xmark text-3xl text-gray-300 mb-2 block"></i>
        ${d && d.title ? `<p class="text-xs text-gray-400 mb-1">${esc(d.company_name)}・${esc(d.title)}</p>` : ''}
        <p class="font-bold text-gray-700">${esc(errMsg(e, 'この募集ページは利用できません'))}</p></section>`
      return
    }
    document.title = DATA.title + ' | ' + DATA.company_name
    render()
    if (DATA.turnstile_site_key) loadTurnstile()
  }

  function render() {
    const d = DATA
    const byDate = {}
    for (const r of d.roles) (byDate[r.work_date] = byDate[r.work_date] || []).push(r)
    const dates = Object.keys(byDate).sort()
    $app.innerHTML = `
      <section class="card p-4 mb-3" id="apply-intro">
        <p class="text-xs text-gray-500">${esc(d.company_name)}</p>
        <h2 class="text-lg font-bold text-gray-900 mb-1">${esc(d.title)}</h2>
        <p class="text-xs text-gray-500 mb-2"><i class="far fa-calendar mr-1"></i>${fmt(d.date_from)}〜${fmt(d.date_to)}</p>
        ${d.description ? `<p class="text-sm text-gray-700 leading-relaxed">${nl2br(d.description)}</p>` : ''}
        ${d.pay_note ? `<p class="text-sm mt-2"><i class="fas fa-yen-sign text-blue-500 mr-1"></i>${esc(d.pay_note)}</p>` : ''}
      </section>

      <section class="mb-3" id="apply-slots">
        <h3 class="text-sm font-bold text-gray-700 mb-2">① 希望する日時を選んでください（複数可）</h3>
        ${dates.map(dt => `<div class="card p-3 mb-2">
          <p class="font-bold text-gray-800 mb-1.5">${fmt(dt)}</p>
          <div class="space-y-1.5">${byDate[dt].map(r => `
            <label class="flex items-center gap-3 p-2.5 rounded-lg border ${picked.has(r.slot_role_id) ? 'border-blue-500 bg-blue-50' : 'border-gray-200'} ${r.full ? 'opacity-60' : ''}">
              <input type="checkbox" class="w-5 h-5" ${picked.has(r.slot_role_id) ? 'checked' : ''} onchange="applyPick(${r.slot_role_id}, this.checked)">
              <span class="flex-1 min-w-0">
                <span class="block font-medium text-sm">${esc(r.start_time)}〜${esc(r.end_time)}${r.role_name ? `<span class="text-gray-500 font-normal">・${esc(r.role_name)}</span>` : ''}</span>
                <span class="block text-xs text-gray-500 truncate">${r.place ? '<i class="fas fa-location-dot mr-1"></i>' + esc(r.place) : ''}</span>
              </span>
              <span class="text-xs whitespace-nowrap ${r.full ? 'text-gray-500' : 'text-emerald-600'}">${r.full ? '定員に達しています<br><span class="text-[10px]">（キャンセル待ち）</span>' : r.remaining != null ? `残り${r.remaining}名` : '募集中'}</span>
            </label>`).join('')}</div></div>`).join('') || '<p class="card p-6 text-center text-gray-400 text-sm">現在、募集中の日時はありません</p>'}
      </section>

      ${dates.length ? `<section class="card p-4 mb-3" id="apply-form">
        <h3 class="text-sm font-bold text-gray-700 mb-3">② ご連絡先</h3>
        <div class="space-y-3">
          <label class="block text-sm text-gray-600">お名前 <span class="text-red-500">*</span><input id="ap-name" class="inp" autocomplete="name" maxlength="60" placeholder="山田 太郎"></label>
          <label class="block text-sm text-gray-600">フリガナ<input id="ap-kana" class="inp" maxlength="60" placeholder="ヤマダ タロウ"></label>
          <label class="block text-sm text-gray-600">電話番号 <span class="text-red-500">*</span><input id="ap-phone" class="inp" type="tel" inputmode="tel" autocomplete="tel" maxlength="15" placeholder="09012345678"></label>
          <label class="block text-sm text-gray-600">メールアドレス<input id="ap-email" class="inp" type="email" inputmode="email" autocomplete="email" maxlength="120"></label>
          <label class="block text-sm text-gray-600">ご質問・ご要望<textarea id="ap-note" class="inp" rows="3" maxlength="500" placeholder="経験・希望の時間など"></textarea></label>
          <div class="hidden" aria-hidden="true"><label>Website<input id="ap-website" tabindex="-1" autocomplete="off"></label></div>
          <label class="flex items-start gap-2 text-xs text-gray-600"><input type="checkbox" id="ap-agree" class="mt-0.5 w-4 h-4">
            <span>入力した個人情報は、このお仕事のご連絡・シフトの調整にのみ使用することに同意します</span></label>
          <div id="ap-turnstile"></div>
        </div>
      </section>` : ''}
      ${d.contact_note ? `<p class="text-xs text-gray-500 text-center mb-4"><i class="fas fa-phone mr-1"></i>${esc(d.contact_note)}</p>` : ''}
      <p class="text-[11px] text-gray-400 text-center mb-4">応募内容を確認のうえ、担当者からご連絡します。応募の時点ではシフトは確定していません</p>

      ${dates.length ? `<div class="fixed bottom-0 inset-x-0 bg-white border-t border-gray-100 p-3 z-30" id="apply-submit-bar">
        <div class="max-w-lg mx-auto flex items-center gap-3">
          <p class="text-sm text-gray-600 whitespace-nowrap"><b id="ap-count">${picked.size}</b>件選択</p>
          <button class="btn btn-primary flex-1 py-3" id="ap-submit" onclick="applySubmit()" ${picked.size ? '' : 'disabled'}>応募する</button>
        </div></div>` : ''}`
    if (tsWidget !== null && window.turnstile) renderTurnstile()
  }
  window.applyPick = function (id, on) {
    on ? picked.add(id) : picked.delete(id)
    // 入力内容を保ったまま、選択状態だけ更新する
    const cb = document.querySelector(`input[onchange="applyPick(${id}, this.checked)"]`)
    const lab = cb && cb.closest('label'); if (lab) { lab.classList.toggle('border-blue-500', on); lab.classList.toggle('bg-blue-50', on); lab.classList.toggle('border-gray-200', !on) }
    document.getElementById('ap-count').textContent = picked.size
    document.getElementById('ap-submit').disabled = !picked.size
  }

  function loadTurnstile() {
    window.__tsReady = () => { tsWidget = 0; renderTurnstile() }
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__tsReady&render=explicit'; s.async = true
    document.head.appendChild(s)
  }
  function renderTurnstile() {
    const el = document.getElementById('ap-turnstile'); if (!el || !window.turnstile) return
    el.innerHTML = ''
    tsWidget = window.turnstile.render(el, { sitekey: DATA.turnstile_site_key, callback: (t) => { tsToken = t }, 'expired-callback': () => { tsToken = '' } })
  }

  window.applySubmit = async function () {
    const v = (id) => (document.getElementById(id) || {}).value || ''
    if (!picked.size) return toast('希望する日時を選択してください')
    if (!v('ap-name').trim()) return toast('お名前を入力してください')
    if (v('ap-phone').replace(/[^0-9]/g, '').length < 10) return toast('電話番号を正しく入力してください')
    if (!document.getElementById('ap-agree').checked) return toast('個人情報の取り扱いに同意してください')
    if (DATA.turnstile_site_key && !tsToken) return toast('「人間であることの確認」を完了してください')
    const btn = document.getElementById('ap-submit'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'
    try {
      const { data } = await axios.post(API + '/apply', {
        name: v('ap-name'), kana: v('ap-kana'), phone: v('ap-phone'), email: v('ap-email'), note: v('ap-note'), website: v('ap-website'),
        agree: true, slot_role_ids: [...picked], issued_at: DATA.issued_at, turnstile_token: tsToken,
      })
      document.getElementById('apply-submit-bar')?.remove()
      $app.innerHTML = `<section class="card p-6 text-center mt-6" id="apply-done">
        <i class="fas fa-circle-check text-4xl text-emerald-500 mb-3 block"></i>
        <p class="font-bold text-gray-800 mb-1">応募を受け付けました</p>
        <p class="text-sm text-gray-600">${data.count === 0 && data.message ? esc(data.message) : '内容を確認のうえ、担当者からご連絡します。<br>応募の時点ではシフトは確定していません'}</p>
        ${data.full_count ? `<p class="text-xs text-amber-600 mt-2">定員に達している日時（${data.full_count}件）はキャンセル待ちとして受け付けました</p>` : ''}
        ${DATA.contact_note ? `<p class="text-xs text-gray-500 mt-4">${esc(DATA.contact_note)}</p>` : ''}
      </section>`
    } catch (e) {
      toast(errMsg(e, '送信に失敗しました。通信環境を確認してもう一度お試しください'))
      btn.disabled = false; btn.textContent = '応募する'
      if (window.turnstile && tsWidget !== null) { try { window.turnstile.reset(tsWidget) } catch (x) { } tsToken = '' }
    }
  }

  load()
})()
