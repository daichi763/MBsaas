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
  let closedNotice = [] // 送信したときに締め切られていた日時（選択から外したことを一覧の上に出す。#515）

  const nl2br = (s) => esc(s).replace(/\n/g, '<br>')
  const errMsg = (e, d) => (e && e.response && e.response.data && e.response.data.error) || d
  const fmt = (d) => { const x = dayjs(d); return `${x.format('M/D')}(${WD[x.day()]})` }
  // 問い合わせ先の表示。電話番号の形の部分は tel: のリンクにする（#513。esc した後の文字列に使う）
  const contactHtml = (note) => esc(note).replace(/(^|[^\d])(0\d{1,4}-\d{1,4}-\d{3,4}|0[5789]0\d{8}|0\d{9})(?![\d-])/g, (m, pre, tel) => `${pre}<a href="tel:${tel.replace(/-/g, '')}" class="text-blue-600 underline whitespace-nowrap">${tel}</a>`)
  // 会場の住所（返されたときだけ。#362）と地図のリンク
  const mapUrl = (addr) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr)
  function toast(msg) {
    let root = document.getElementById('toast'); if (!root) { root = document.createElement('div'); root.id = 'toast'; document.body.appendChild(root) }
    const el = document.createElement('div'); el.className = 'toast-msg'; el.textContent = msg; root.appendChild(el); setTimeout(() => el.remove(), 3000)
  }

  async function load() {
    $app.innerHTML = '<div class="flex justify-center py-16"><span class="spin"></span></div>'
    try { DATA = (await axios.get(API)).data } catch (e) {
      const d = e.response && e.response.data
      // 終了した募集でも、問い合わせ先が返されたら出す（応募の後に開き直した人が連絡できるように。#513）
      $app.innerHTML = `<section class="card p-6 text-center mt-6" id="apply-closed"><i class="fas fa-calendar-xmark text-3xl text-gray-300 mb-2 block"></i>
        ${d && d.title ? `<p class="text-xs text-gray-400 mb-1">${esc(d.company_name)}・${esc(d.title)}</p>` : ''}
        <p class="font-bold text-gray-700">${esc(errMsg(e, 'この募集ページは利用できません'))}</p>
        ${d && d.contact_note ? `<div class="mt-4 pt-3 border-t text-sm text-gray-600" id="apply-closed-contact"><p class="text-xs text-gray-400 mb-1">応募の内容・取り下げのお問い合わせ</p><p class="whitespace-pre-wrap break-words"><i class="fas fa-phone mr-1 text-gray-400"></i>${contactHtml(d.contact_note)}</p></div>` : ''}</section>`
      return
    }
    document.title = DATA.title + ' | ' + DATA.company_name
    render()
    if (DATA.turnstile_site_key) loadTurnstile()
  }

  // 続きの日時を読み込む（枠が多いページは日付の順に分けて取得する。#126）
  delegate('applyLoadMore', (btn) => applyLoadMore(btn))
  async function applyLoadMore(btn) {
    if (!DATA.next_from) return
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'
    try {
      const { data } = await axios.get(API + '?from=' + encodeURIComponent(DATA.next_from))
      const seen = new Set(DATA.roles.map(r => r.slot_role_id))
      DATA.roles = DATA.roles.concat(data.roles.filter(r => !seen.has(r.slot_role_id)))
      DATA.next_from = data.next_from
      render()
    } catch (e) {
      toast(errMsg(e, '読み込みに失敗しました。通信環境を確認してもう一度お試しください'))
      btn.disabled = false; btn.textContent = 'さらに後の日時を表示'
    }
  }

  function render() {
    // 入力中の内容は描き直しても保つ
    const keep = {}
    for (const id of ['ap-name', 'ap-kana', 'ap-phone', 'ap-email', 'ap-note', 'ap-website']) { const el = document.getElementById(id); if (el) keep[id] = el.value }
    const keepAnswers = document.getElementById('apply-form') ? readAnswers() : {}
    const agreed = !!(document.getElementById('ap-agree') || {}).checked
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
        ${closedNotice.length ? `<div class="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3 mb-2" id="apply-closed-notice" role="alert">
          <p class="font-bold mb-1"><i class="fas fa-circle-exclamation mr-1"></i>次の日時は募集が終了したため、選択から外しました</p>
          <ul class="list-disc pl-5">${closedNotice.map(r => `<li>${slotLabel(r)}</li>`).join('')}</ul>
          <p class="mt-1">ご入力の内容はそのまま残っています。日時を選び直して、もう一度「応募する」を押してください</p></div>` : ''}
        ${dates.map(dt => `<div class="card p-3 mb-2">
          <p class="font-bold text-gray-800 mb-1.5">${fmt(dt)}</p>
          <div class="space-y-1.5">${byDate[dt].map(r => `
            <label class="flex items-center gap-3 p-2.5 rounded-lg border ${picked.has(r.slot_role_id) ? 'border-blue-500 bg-blue-50' : 'border-gray-200'} ${r.full ? 'opacity-60' : ''}">
              <input type="checkbox" class="w-5 h-5" data-role-id="${Number(r.slot_role_id)}" ${picked.has(r.slot_role_id) ? 'checked' : ''} onchange="applyPick(${r.slot_role_id}, this.checked)">
              <span class="flex-1 min-w-0">
                <span class="block font-medium text-sm">${esc(formatShiftTime(r.start_time, r.end_time))}${r.role_name ? `<span class="text-gray-500 font-normal">・${esc(r.role_name)}</span>` : ''}</span>
                <span class="block text-xs text-gray-500 truncate">${r.place ? '<i class="fas fa-location-dot mr-1"></i>' + esc(r.place) : ''}${Number(r.break_minutes) > 0 ? `<span class="ml-1">・休憩${Number(r.break_minutes)}分</span>` : ''}</span>
                ${r.site_address ? `<span class="block text-[11px] text-gray-500">${esc(r.site_address)} <a href="${esc(mapUrl(r.site_address))}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline whitespace-nowrap">地図</a></span>` : ''}
              </span>
              <span class="text-xs whitespace-nowrap ${r.full ? 'text-gray-500' : 'text-emerald-600'}">${r.full ? '定員に達しています<br><span class="text-[10px]">（キャンセル待ち）</span>' : r.remaining != null ? `残り${r.remaining}名` : '募集中'}</span>
            </label>`).join('')}</div></div>`).join('') || '<p class="card p-6 text-center text-gray-400 text-sm">現在、募集中の日時はありません</p>'}
        ${d.next_from ? `<button class="btn btn-outline w-full" id="apply-more" data-action="applyLoadMore">さらに後の日時を表示</button>` : ''}
      </section>
      ${dates.length ? `<p class="text-xs text-gray-500 bg-white border border-gray-100 rounded-lg p-3 mb-3" id="apply-staff-note"><i class="fas fa-mobile-screen mr-1 text-blue-500"></i>
        すでにスタッフ登録をしている方は、<a href="/login" class="text-blue-600 underline">スタッフアプリ</a>の「シフト」→「募集中のお仕事」からも応募できます。アプリから応募すると、応募の状況の確認や取り下げができます</p>` : ''}

      ${dates.length ? `<section class="card p-4 mb-3" id="apply-form">
        <h3 class="text-sm font-bold text-gray-700 mb-3">② ご連絡先</h3>
        <div class="space-y-3">
          <label class="block text-sm text-gray-600">お名前 <span class="text-red-500">*</span><input id="ap-name" class="inp" autocomplete="name" maxlength="60" placeholder="山田 太郎"></label>
          <label class="block text-sm text-gray-600">フリガナ<input id="ap-kana" class="inp" maxlength="60" placeholder="ヤマダ タロウ"></label>
          <label class="block text-sm text-gray-600">電話番号 <span class="text-red-500">*</span><input id="ap-phone" class="inp" type="tel" inputmode="tel" autocomplete="tel" maxlength="15" placeholder="09012345678"></label>
          <label class="block text-sm text-gray-600">メールアドレス<input id="ap-email" class="inp" type="email" inputmode="email" autocomplete="email" maxlength="120">
            <span class="block text-[11px] text-gray-400 mt-0.5">選考の結果（確定・見送り）をこのアドレスにお知らせします。入力がない場合は、担当者からお電話などでご連絡します</span></label>
          ${questions().map(questionHtml).join('')}
          <label class="block text-sm text-gray-600">ご質問・ご要望<textarea id="ap-note" class="inp" rows="3" maxlength="500" placeholder="経験・希望の時間など"></textarea></label>
          <div class="hidden" aria-hidden="true"><label>Website<input id="ap-website" tabindex="-1" autocomplete="off"></label></div>
          <div class="text-[11px] text-gray-500 bg-gray-50 rounded-lg p-2.5 leading-relaxed" id="ap-privacy">
            <p class="font-bold text-gray-600 mb-0.5">個人情報の取り扱い</p>
            <p>取得する者: ${esc(d.company_name)}</p>
            <p>利用目的: このお仕事の選考・ご連絡・シフトの調整に使います。採用となった場合は、${esc(d.company_name)}のスタッフとして登録し（氏名・フリガナ・電話番号・メールアドレス・${questions().length ? '質問へのご回答・' : ''}ご質問欄の内容）、勤務の連絡・勤怠の記録に使います</p>
            <p>保存期間: 採用に至らなかった応募は、応募から${Number(d.retention_days) || 180}日で削除します</p>
            <p>開示・訂正・削除のご希望: ${d.contact_note ? esc(d.contact_note) : esc(d.company_name) + 'へご連絡ください'}</p>
          </div>
          <label class="flex items-start gap-2 text-xs text-gray-600 rounded-lg p-1" id="ap-agree-box"><input type="checkbox" id="ap-agree" class="mt-0.5 w-4 h-4">
            <span>上記の個人情報の取り扱いに同意します</span></label>
          <div id="ap-turnstile"></div>
        </div>
      </section>` : ''}
      ${d.contact_note ? `<p class="text-xs text-gray-500 text-center mb-4 whitespace-pre-wrap"><i class="fas fa-phone mr-1"></i>${contactHtml(d.contact_note)}</p>` : ''}
      <p class="text-[11px] text-gray-400 text-center mb-4">応募内容を確認のうえ、結果をお知らせします（メールアドレスを入れた場合はメールで届きます）。応募の時点ではシフトは確定していません</p>

      ${dates.length ? `<div class="fixed bottom-0 inset-x-0 bg-white border-t border-gray-100 p-3 z-30" id="apply-submit-bar">
        <div class="max-w-lg mx-auto flex items-center gap-3">
          <p class="text-sm text-gray-600 whitespace-nowrap"><b id="ap-count">${picked.size}</b>件選択</p>
          <button class="btn btn-primary flex-1 py-3" id="ap-submit" onclick="applySubmit()" ${picked.size ? '' : 'disabled'}>応募する</button>
        </div>
        <p class="max-w-lg mx-auto text-[11px] text-amber-700 mt-1 hidden" id="ap-hint"></p></div>` : ''}`
    for (const [id, v] of Object.entries(keep)) { const el = document.getElementById(id); if (el) el.value = v }
    restoreAnswers(keepAnswers)
    if (agreed && document.getElementById('ap-agree')) document.getElementById('ap-agree').checked = true
    if (tsWidget !== null && window.turnstile) renderTurnstile()
    const form = document.getElementById('apply-form')
    if (form) {
      // 直した欄から、誤りの表示を外す
      form.addEventListener('input', (ev) => clearFieldError(ev.target))
      form.addEventListener('change', (ev) => { clearFieldError(ev.target); updateHint() })
      // 全角で入力・貼り付けた電話番号・メールアドレスは半角にそろえて見せる（#512）
      for (const id of ['ap-phone', 'ap-email']) document.getElementById(id).addEventListener('blur', (ev) => { ev.target.value = ev.target.value.normalize('NFKC').trim() })
    }
    updateHint()
  }
  window.applyPick = function (id, on) {
    on ? picked.add(id) : picked.delete(id)
    // 入力内容を保ったまま、選択状態だけ更新する
    const cb = document.querySelector(`input[data-role-id="${Number(id)}"]`)
    const lab = cb && cb.closest('label'); if (lab) { lab.classList.toggle('border-blue-500', on); lab.classList.toggle('bg-blue-50', on); lab.classList.toggle('border-gray-200', !on) }
    document.getElementById('ap-count').textContent = picked.size
    document.getElementById('ap-submit').disabled = !picked.size
    if (picked.size) clearFieldError(document.getElementById('apply-slots'))
    updateHint()
  }
  // ---------- 募集ページの独自の質問（#300） ----------
  // type: text（自由記述）/ select（選択肢）/ yesno（はい・いいえ）。回答は { key: 値 } で送る（yesno は yes / no）
  const questions = () => (DATA && Array.isArray(DATA.questions) ? DATA.questions : [])
  const qid = (q) => 'ap-q-' + q.key
  function questionHtml(q) {
    const mark = q.required ? ' <span class="text-red-500">*</span>' : ''
    const input = q.type === 'select'
      ? `<select id="${esc(qid(q))}" class="inp"><option value="">選択してください</option>${(q.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`
      : q.type === 'yesno'
        ? `<span class="flex gap-4 mt-1">${[['yes', 'はい'], ['no', 'いいえ']].map(([v, l]) => `<label class="inline-flex items-center gap-1.5 text-sm"><input type="radio" class="w-4 h-4" name="${esc(qid(q))}" value="${v}">${l}</label>`).join('')}</span>`
        : `<input id="${esc(qid(q))}" class="inp" maxlength="200">`
    return `<div class="block text-sm text-gray-600 rounded-lg" id="ap-qbox-${esc(q.key)}" data-question="${esc(q.key)}">${esc(q.label)}${mark}${input}</div>`
  }
  function readAnswers() {
    const out = {}
    for (const q of questions()) {
      out[q.key] = q.type === 'yesno' ? ((document.querySelector(`input[name="${qid(q)}"]:checked`) || {}).value || '')
        : ((document.getElementById(qid(q)) || {}).value || '').trim()
    }
    return out
  }
  function restoreAnswers(saved) {
    for (const q of questions()) {
      const v = saved[q.key]; if (!v) continue
      if (q.type === 'yesno') { const r = document.querySelector(`input[name="${qid(q)}"][value="${v === 'no' ? 'no' : 'yes'}"]`); if (r) r.checked = true }
      else { const el = document.getElementById(qid(q)); if (el) el.value = v }
    }
  }

  // 日時の表示（締め切りのお知らせ・完了画面の控え）
  function slotLabel(r) {
    return `${fmt(r.work_date)} ${esc(r.start_time)}〜${esc(r.end_time)}${r.role_name ? '・' + esc(r.role_name) : ''}${r.place ? '・' + esc(r.place) : ''}`
  }

  // ---------- 入力の誤りの表示（#416） ----------
  // 誤りのある欄を赤い枠で囲み、その下に理由を残して、その欄へ移動する（トーストだけでは画面の外の欄に気づけないため）
  const FIELD_EL = { name: 'ap-name', phone: 'ap-phone', email: 'ap-email', agree: 'ap-agree-box', turnstile: 'ap-turnstile', slots: 'apply-slots' }
  const INVALID = ['border-red-500', 'ring-2', 'ring-red-200', 'ap-invalid']
  // 質問の欄は q_ + key（サーバーの field と同じ）
  const fieldId = (key) => FIELD_EL[key] || (/^q_q\d+$/.test(key || '') ? 'ap-qbox-' + key.slice(2) : '')
  function fieldError(key, msg) {
    const el = document.getElementById(fieldId(key))
    toast(msg)
    if (!el) return
    clearFieldError(el)
    el.classList.add(...INVALID)
    const p = document.createElement('p'); p.className = 'ap-err text-xs text-red-600 mt-1'; p.setAttribute('role', 'alert'); p.textContent = msg
    if (key === 'slots') el.querySelector('h3').insertAdjacentElement('afterend', p)
    else el.insertAdjacentElement('afterend', p)
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const focusEl = key === 'agree' ? document.getElementById('ap-agree') : key.startsWith('q_') ? el.querySelector('input, select') : el
    if (['name', 'phone', 'email', 'agree'].includes(key) || key.startsWith('q_')) try { focusEl.focus({ preventScroll: true }) } catch (e) { }
  }
  function clearFieldError(target) {
    if (!target) return
    const el = target.id === 'ap-agree' ? document.getElementById('ap-agree-box') : target.closest ? target.closest('.ap-invalid') || target : target
    if (!el.classList || !el.classList.contains('ap-invalid')) return
    el.classList.remove(...INVALID)
    const next = el.id === 'apply-slots' ? el.querySelector('.ap-err') : el.nextElementSibling
    if (next && next.classList.contains('ap-err')) next.remove()
  }
  function clearAllErrors() { document.querySelectorAll('.ap-invalid').forEach(clearFieldError) }
  // 送信ボタンの下に、送信の前に必要なこと（同意・人間であることの確認）を出しておく
  function updateHint() {
    const el = document.getElementById('ap-hint'); if (!el) return
    const agree = document.getElementById('ap-agree')
    const msg = !picked.size ? '' : agree && !agree.checked ? '送信には、個人情報の取り扱いへの同意（チェック）が必要です'
      : DATA.turnstile_site_key && !tsToken ? '送信には「人間であることの確認」が必要です' : ''
    el.textContent = msg; el.classList.toggle('hidden', !msg)
  }

  function loadTurnstile() {
    window.__tsReady = () => { tsWidget = 0; renderTurnstile() }
    const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__tsReady&render=explicit'; s.async = true
    document.head.appendChild(s)
  }
  function renderTurnstile() {
    const el = document.getElementById('ap-turnstile'); if (!el || !window.turnstile) return
    el.innerHTML = ''
    tsWidget = window.turnstile.render(el, { sitekey: DATA.turnstile_site_key,
      callback: (t) => { tsToken = t; clearFieldError(el); updateHint() }, 'expired-callback': () => { tsToken = ''; updateHint() } })
  }
  function resetTurnstile() {
    if (window.turnstile && tsWidget !== null) { try { window.turnstile.reset(tsWidget) } catch (x) { } }
    tsToken = ''; updateHint()
  }

  // 選んだ日時が締め切られていたとき: 入力欄はそのままにして日時の一覧だけを取り直し、締め切られた日時を選択から外して知らせる（#242 #515）
  async function reloadSlots(closedIds) {
    const before = new Map(DATA.roles.map(r => [r.slot_role_id, r]))
    const lastDate = DATA.roles.length ? DATA.roles[DATA.roles.length - 1].work_date : null
    const fresh = (await axios.get(API)).data
    let roles = fresh.roles, next = fresh.next_from, guard = 0
    // 「さらに後の日時を表示」で読み込んでいた分まで取り直す
    while (next && lastDate && next <= lastDate && guard++ < 20) {
      const more = (await axios.get(API + '?from=' + encodeURIComponent(next))).data
      const seen = new Set(roles.map(r => r.slot_role_id))
      roles = roles.concat(more.roles.filter(r => !seen.has(r.slot_role_id))); next = more.next_from
    }
    // 表示から送信までの時間の確認に使う issued_at は、最初に開いたときのものを使い続ける
    DATA = { ...fresh, roles, next_from: next, issued_at: DATA.issued_at }
    const open = new Set(roles.map(r => r.slot_role_id))
    const closed = [...new Set([...closedIds, ...[...picked].filter(id => !open.has(id))])]
    closed.forEach(id => picked.delete(id))
    closedNotice = closed.map(id => before.get(id)).filter(Boolean)
    render()
  }

  window.applySubmit = async function () {
    const v = (id) => (document.getElementById(id) || {}).value || ''
    clearAllErrors()
    if (!picked.size) return fieldError('slots', '希望する日時を選択してください')
    if (!v('ap-name').trim()) return fieldError('name', 'お名前を入力してください')
    // 全角の数字も数字として数える（#512。サーバーの normalizePhone と同じ）
    const digits = v('ap-phone').normalize('NFKC').replace(/[^0-9]/g, '')
    if (digits.length < 10 || digits.length > 11) return fieldError('phone', '電話番号は10〜11桁の数字で入力してください（ハイフンはあってもなくても構いません）')
    const email = v('ap-email').normalize('NFKC').trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fieldError('email', 'メールアドレスの形式が正しくありません')
    const answers = readAnswers()
    const missing = questions().find(q => q.required && !answers[q.key])
    if (missing) return fieldError('q_' + missing.key, `「${missing.label}」に回答してください`)
    if (!document.getElementById('ap-agree').checked) return fieldError('agree', '個人情報の取り扱いに同意してください')
    if (DATA.turnstile_site_key && !tsToken) return fieldError('turnstile', '「人間であることの確認」を完了してください')
    const btn = document.getElementById('ap-submit'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'
    try {
      const { data } = await axios.post(API + '/apply', {
        name: v('ap-name'), kana: v('ap-kana'), phone: v('ap-phone').normalize('NFKC'), email, note: v('ap-note'), website: v('ap-website'),
        agree: true, slot_role_ids: [...picked], issued_at: DATA.issued_at, turnstile_token: tsToken, answers,
      })
      document.getElementById('apply-submit-bar')?.remove()
      renderDone(data, !!email)
    } catch (e) {
      const d = e && e.response && e.response.data
      btn.disabled = !picked.size; btn.textContent = '応募する'
      // 確認のトークンは1回しか使えないため、サーバーに届いた送信のあとはやり直してもらう
      if (e && e.response) resetTurnstile()
      if (d && d.need_reselect) {
        try { await reloadSlots(d.closed_role_ids || []) } catch (x) { (d.closed_role_ids || []).forEach(id => picked.delete(id)); render() }
        return fieldError('slots', d.error)
      }
      if (d && d.field && fieldId(d.field)) return fieldError(d.field, d.error)
      // 応答があった失敗（サーバー側のエラー）は通信環境の問題と区別して案内する
      toast(errMsg(e, e && e.response ? '送信に失敗しました。時間をおいてもう一度お試しいただくか、お問い合わせ先へご連絡ください' : '送信に失敗しました。通信環境を確認してもう一度お試しください'))
    }
  }

  // 完了画面: 受け付けた日時の控えと受付日時を出す（#317）。控えはサーバーが受け付けた日時だけで作る（#242）
  // byEmail: メールアドレスを入れて応募した（結果はメールで届く。#151）
  function renderDone(data, byEmail) {
    const accepted = data.accepted || [], already = data.already_applied || []
    const at = data.applied_at ? dayjs(data.applied_at) : null
    const list = (rows, waitlist) => `<ul class="space-y-1.5">${rows.map(r => `<li class="border border-gray-100 rounded-lg p-2 text-sm">${slotLabel(r)}${waitlist && r.full ? '<span class="block text-[11px] text-amber-600">定員に達しているため、キャンセル待ちとして受け付けました</span>' : ''}</li>`).join('')}</ul>`
    $app.innerHTML = `<section class="card p-6 mt-6" id="apply-done">
      <div class="text-center">
        <i class="fas fa-circle-check text-4xl text-emerald-500 mb-3 block"></i>
        <p class="font-bold text-gray-800 mb-1">${accepted.length || !data.message ? '応募を受け付けました' : esc(data.message)}</p>
        ${at ? `<p class="text-xs text-gray-500" id="apply-done-at">受付日時: ${at.format('YYYY/M/D HH:mm')}</p>` : ''}
      </div>
      ${accepted.length ? `<div class="mt-4" id="apply-done-list"><p class="text-xs font-bold text-gray-600 mb-1.5">応募した日時（${accepted.length}件）</p>${list(accepted, true)}</div>` : ''}
      ${already.length ? `<div class="mt-3" id="apply-done-already"><p class="text-xs font-bold text-gray-600 mb-1.5">すでに応募済みの日時（今回は受け付けていません）</p>${list(already, false)}</div>` : ''}
      <div class="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 mt-4 leading-relaxed">
        <p>この画面をスクリーンショットなどで保存してください。</p>
        <p>${byEmail ? '内容を確認のうえ、結果（確定・見送り）を入力いただいたメールアドレスにお知らせします。' : '内容を確認のうえ、担当者からご連絡します。'}応募の時点ではシフトは確定していません。</p>
        <p>応募の取り下げ・変更は、お問い合わせ先へご連絡ください。</p>
      </div>
      ${DATA.contact_note ? `<p class="text-xs text-gray-500 mt-3 text-center whitespace-pre-wrap"><i class="fas fa-phone mr-1"></i>${contactHtml(DATA.contact_note)}</p>` : ''}
    </section>`
    window.scrollTo(0, 0)
  }

  load()
})()
