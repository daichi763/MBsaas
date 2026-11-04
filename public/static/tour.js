// =========================================================
// 案内（チュートリアル。利用者の決定 Sprint 15。#9711 管理画面 / #9712 スタッフアプリ）
// ゲームのチュートリアルのように、画面を少し暗くして説明する要素だけを浮かせ、吹き出しで順に案内する。
//   - 管理画面: 初回（初回のパスワード変更の後）に「主な機能を案内します［始める］［あとで］」。
//     右上の「？」から「この画面の使い方」「最初の案内をもう一度見る」。主な画面は初めて開いたときに1回だけ短い案内を出す。
//     会社管理者には、ダッシュボードの上に「はじめにやること」（実データで自動でチェック。全部済んだら消える）
//   - スタッフアプリ: 初回に短い案内（ホーム画面に追加 → 打刻 → 日報 → 通知）。「その他」の「使い方をもう一度見る」から再表示
// 進み具合は人ごとにサーバーに残す（GET/PUT /api/admin/tours・/api/staff/tours。src/tours.ts）。途中で閉じたら続きから。
// 案内が指す要素は、各画面の既存の id・data-* で探す。見つからないステップは飛ばす（ほかの作業で画面が変わっても止まらないように）。
// 呼び出しの口: admin.js の起動の後（FosTour.init）・ダッシュボードの描画の後（FosTour.dashboard）、staff.js の起動の後（FosTour.init）と
// 「その他」の画面（FosTour.staffMoreHtml）。common.js（esc・delegate）の後、admin.js・staff.js の後に読み込む（index.tsx）
// =========================================================
;(function () {
  'use strict'
  if (window.FosTour) return

  const S = {
    app: null, me: null, inited: false, loaded: false, readonly: false,
    progress: {},          // tour_key → { status, step }
    active: null,          // 実行中の案内 { tour, idx, dir, auto, shown, visited, el }
    prompt: null,          // 開いている確認（始める・あとで）{ onEsc }
    seq: 0,                // ステップの表示の順番（古い待ちを捨てる）
    autoSeq: 0,
    tourNav: null,         // 案内が自分で移した画面の hash（その hashchange では案内を止めない）
    suppressHash: null,    // 案内を閉じた画面では、自動の案内をすぐに出し直さない
    saveTimer: null, tick: null, raf: 0,
    layer: null, menu: null, menuBtn: null,
    checklist: null,       // 最後に読んだ「はじめにやること」
  }
  const $ = (sel, root) => (root || document).querySelector(sel)
  const wait = (ms) => new Promise(r => setTimeout(r, ms))
  const h = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])))
  const say = (msg, ms) => { if (typeof toast === 'function') toast(msg, ms) }
  const isAdmin = () => S.app === 'admin'

  // ---------- サーバーへの保存（失敗しても案内は続ける） ----------
  const apiBase = () => '/api/' + S.app + '/tours'
  function save(items) {
    for (const it of items) S.progress[it.key] = { status: it.status, step: it.step }
    if (S.readonly || !items.length) return Promise.resolve()
    return axios.put(apiBase(), { items }, { background: true }).catch(() => { /* 残せなくても画面の操作は止めない */ })
  }
  // 途中のステップは、続けて押したときに何度も送らないよう少し待ってから残す
  function saveStep(key, step) {
    S.progress[key] = { status: 'in_progress', step }
    clearTimeout(S.saveTimer)
    S.saveTimer = setTimeout(() => save([{ key, status: 'in_progress', step }]), 700)
  }

  // ---------- 要素の探し方 ----------
  function visible(el) {
    if (!el || !el.isConnected || !el.getBoundingClientRect) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  // sel: CSS セレクタ・要素を返す関数、またはその配列（先に見つかった表示中のもの）
  function findTarget(sel) {
    for (const s of Array.isArray(sel) ? sel : [sel]) {
      let els = []
      try { els = typeof s === 'function' ? [s()] : [...document.querySelectorAll(s)] } catch (e) { els = [] }
      const el = els.find(visible)
      if (el) return el
    }
    return null
  }
  // 画面が読み込み中か（各画面の loading() は #app に読み込み中の印だけを描く）
  function pageBusy() {
    const app = document.getElementById('app')
    if (!app) return false
    return app.children.length === 0 || (app.children.length === 1 && !!app.querySelector(':scope > div > .spin'))
  }
  // 要素が出るまで待つ。画面の読み込みが終わってもしばらく出なければ null（そのステップを飛ばす）。待ちが古くなったら undefined
  async function waitTarget(sel, token) {
    const start = Date.now()
    let settledAt = 0
    while (Date.now() - start < 8000) {
      if (token !== S.seq) return undefined
      const el = sel ? findTarget(sel) : null
      if (el) return el
      if (pageBusy()) settledAt = 0
      else if (!settledAt) settledAt = Date.now()
      else if (Date.now() - settledAt > (sel ? 900 : 150)) return null
      await wait(120)
    }
    return null
  }

  // ---------- 画面の移動 ----------
  const homeTab = () => (isAdmin() ? 'dashboard' : 'home')
  const curHash = () => (location.hash || '').slice(1) || homeTab()
  function goRoute(route) {
    if (curHash() === route) return
    S.tourNav = '#' + route
    location.hash = route
  }

  // ---------- 見た目（このファイルだけで完結させる） ----------
  function injectStyle() {
    if (document.getElementById('tour-style')) return
    const st = document.createElement('style')
    st.id = 'tour-style'
    st.textContent = `
#tour-root{position:fixed;inset:0;z-index:1000;pointer-events:none}
#tour-root[hidden]{display:none}
#tour-root .tour-block{position:fixed;inset:0;pointer-events:auto;background:transparent}
#tour-root .tour-block.dim{background:rgba(15,23,42,.55)}
#tour-root .tour-hole{position:fixed;border-radius:10px;pointer-events:none;box-shadow:0 0 0 3px rgba(96,165,250,.95),0 0 0 200vmax rgba(15,23,42,.55);transition:top .2s,left .2s,width .2s,height .2s}
#tour-root .tour-bubble{position:fixed;pointer-events:auto;background:#fff;color:#1f2937;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.28);padding:14px 16px 12px;font-size:14px;line-height:1.65;overflow:auto;overscroll-behavior:contain;outline:none}
#tour-root .tour-arrow{position:fixed;width:14px;height:14px;background:#fff;transform:rotate(45deg);pointer-events:none}
#tour-root .tour-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
#tour-root .tour-count{font-size:11px;color:#6b7280;flex:1}
#tour-root .tour-x{width:2rem;height:2rem;margin:-6px -8px 0 0;border-radius:9999px;color:#9ca3af;font-size:1.05rem}
#tour-root .tour-x:hover{color:#4b5563;background:#f3f4f6}
#tour-root .tour-title{font-weight:700;font-size:15px;color:#111827;margin-bottom:4px}
#tour-root .tour-body p+p,#tour-root .tour-body p+ol,#tour-root .tour-body ol+p{margin-top:6px}
#tour-root .tour-body ol{list-style:decimal;padding-left:1.3em}
#tour-root .tour-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px}
#tour-root .tour-actions .tour-skip{font-size:12px;color:#6b7280;text-decoration:underline;padding:6px 2px;margin-right:auto}
#tour-root .tour-actions .btn{padding:.45rem .9rem;font-size:13px}
#tour-root .tour-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#tour-menu{position:fixed;z-index:1100;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.18);padding:6px;min-width:240px;max-width:calc(100vw - 24px)}
#tour-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:8px 10px;border-radius:8px;font-size:14px;color:#374151}
#tour-menu button:hover:not(:disabled),#tour-menu button:focus-visible{background:#eff6ff;color:#1d4ed8;outline:none}
#tour-menu button:disabled{color:#9ca3af;cursor:default}
#tour-menu button i{width:1.1rem;text-align:center;color:#2563eb}
#tour-menu button:disabled i{color:#d1d5db}
@media (prefers-reduced-motion: reduce){#tour-root .tour-hole{transition:none}}`
    document.head.appendChild(st)
  }
  function ensureLayer() {
    injectStyle()
    if (S.layer && S.layer.isConnected) { S.layer.hidden = false; return S.layer }
    const root = document.createElement('div')
    root.id = 'tour-root'
    root.innerHTML = '<div class="tour-block"></div><div class="tour-hole" hidden></div><div class="tour-arrow" hidden></div>'
      + '<div class="tour-bubble" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body" tabindex="-1"></div>'
      + '<div class="tour-sr" aria-live="polite"></div>'
    document.body.appendChild(root)
    root.querySelector('.tour-bubble').addEventListener('click', onBubbleClick)
    // 暗い所を押しても何もしない（吹き出しを軽く揺らして気づかせる）
    root.querySelector('.tour-block').addEventListener('click', () => {
      const b = root.querySelector('.tour-bubble')
      if (b.animate) b.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 250 })
    })
    S.layer = root
    window.addEventListener('resize', schedulePlace)
    window.addEventListener('scroll', schedulePlace, true)
    return root
  }
  function teardown() {
    clearInterval(S.tick); S.tick = null
    if (S.layer) S.layer.hidden = true
    window.removeEventListener('resize', schedulePlace)
    window.removeEventListener('scroll', schedulePlace, true)
    if (S.layer) { S.layer.remove(); S.layer = null }
  }

  // 下のナビゲーション（スタッフアプリ）と重ならないよう、画面の下の使えない高さ
  function bottomInset() {
    const nav = document.getElementById('bottom-nav')
    if (!nav || !visible(nav)) return 0
    const r = nav.getBoundingClientRect()
    return r.top < window.innerHeight ? Math.max(0, window.innerHeight - r.top) : 0
  }
  function schedulePlace() {
    if (S.raf) return
    S.raf = requestAnimationFrame(() => { S.raf = 0; place() })
  }
  // 吹き出しと穴の位置を決める。対象が無ければ画面の中央（下のナビゲーションの上）に出す
  function place() {
    const root = S.layer
    if (!root || root.hidden) return
    const a = S.active
    let el = a && a.el
    if (a && a.sel && (!el || !el.isConnected || !visible(el))) { el = findTarget(a.sel); a.el = el }
    const bubble = root.querySelector('.tour-bubble'), hole = root.querySelector('.tour-hole'), arrow = root.querySelector('.tour-arrow'), block = root.querySelector('.tour-block')
    const vw = document.documentElement.clientWidth || window.innerWidth
    const vh = window.innerHeight
    const bottom = vh - bottomInset()
    const M = 12
    const w = Math.min(380, vw - M * 2)
    bubble.style.width = w + 'px'
    bubble.style.maxHeight = Math.max(160, bottom - M * 2) + 'px'
    const bh = bubble.offsetHeight
    if (!el) {
      hole.hidden = true; arrow.hidden = true; block.classList.add('dim')
      bubble.style.left = Math.round((vw - w) / 2) + 'px'
      bubble.style.top = Math.round(Math.max(M, (bottom - bh) / 2)) + 'px'
      return
    }
    block.classList.remove('dim')
    const r = el.getBoundingClientRect()
    const pad = 6
    const ht = Math.max(-pad, r.top - pad), hl = Math.max(-pad, r.left - pad)
    const hb = Math.min(vh + pad, r.bottom + pad), hr = Math.min(vw + pad, r.right + pad)
    hole.hidden = false
    Object.assign(hole.style, { top: ht + 'px', left: hl + 'px', width: Math.max(0, hr - hl) + 'px', height: Math.max(0, hb - ht) + 'px' })
    let top, side
    if (hb + M + bh <= bottom - M) { top = hb + M; side = 'below' }
    else if (ht - M - bh >= M) { top = ht - M - bh; side = 'above' }
    else { top = Math.max(M, bottom - M - bh); side = null } // 大きな要素: 下の端に重ねる
    const left = Math.round(Math.min(Math.max(M, r.left + r.width / 2 - w / 2), vw - w - M))
    bubble.style.left = left + 'px'
    bubble.style.top = Math.round(top) + 'px'
    if (side) {
      const ax = Math.min(Math.max(left + 16, r.left + r.width / 2 - 7), left + w - 30)
      arrow.hidden = false
      arrow.style.left = Math.round(ax) + 'px'
      arrow.style.top = Math.round(side === 'below' ? top - 7 : top + bh - 7) + 'px'
    } else arrow.hidden = true
  }
  // 上に固定されたヘッダー（スタッフアプリ・スマホの管理画面）の下端
  function topInset() {
    let t = 0
    for (const hd of document.querySelectorAll('#staff-header, header.sticky')) {
      if (!visible(hd)) continue
      const r = hd.getBoundingClientRect()
      if (r.top <= 0 && r.bottom > t) t = r.bottom
    }
    return t
  }
  // 対象が画面の外にあれば、見える位置までスクロールする。大きな要素は、上のヘッダーのすぐ下に先頭が来るようにする
  function bringIntoView(el) {
    const r = el.getBoundingClientRect()
    const top = topInset(), bottom = window.innerHeight - bottomInset()
    if (r.top >= top + 8 && r.bottom <= bottom - 8) return
    if (r.height > (bottom - top) * 0.6) { window.scrollBy(0, r.top - top - 8); return }
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch (e) { el.scrollIntoView() }
  }

  // ---------- 吹き出しの中身 ----------
  function btnHtml(b) {
    if (b.skip) return `<button type="button" class="tour-skip" data-tour-act="${h(b.act)}">${h(b.label)}</button>`
    return `<button type="button" class="btn ${b.primary ? 'btn-primary' : 'btn-outline'}" data-tour-act="${h(b.act)}" ${b.disabled ? 'disabled' : ''}>${h(b.label)}</button>`
  }
  // count: 「2 / 8」などの文言（無ければ出さない）。closeLabel: ✕ の読み上げ
  function fillBubble({ count, title, body, buttons, closeLabel }) {
    const root = ensureLayer()
    const bubble = root.querySelector('.tour-bubble')
    bubble.innerHTML = `
      <div class="tour-head"><p class="tour-count">${h(count || '')}</p>
        <button type="button" class="tour-x" data-tour-act="close" aria-label="${h(closeLabel || '閉じる')}" title="${h(closeLabel || '閉じる')}"><i class="fas fa-xmark"></i></button></div>
      <h2 class="tour-title" id="tour-title">${h(title)}</h2>
      <div class="tour-body" id="tour-body">${body}</div>
      <div class="tour-actions">${buttons.map(btnHtml).join('')}</div>`
    root.querySelector('.tour-sr').textContent = (count ? count + ' ' : '') + title
    return bubble
  }
  // 入力中（入力欄にカーソルがある）のときは、自動で出した案内にフォーカスを移さない
  function focusBubble(auto) {
    const ae = document.activeElement
    if (auto && ae && ae !== document.body && ae.matches && ae.matches('input, textarea, select, [contenteditable]') && !(S.layer && S.layer.contains(ae))) return
    const bubble = S.layer && S.layer.querySelector('.tour-bubble')
    if (!bubble) return
    const b = bubble.querySelector('.tour-actions .btn-primary:not(:disabled)') || bubble
    try { b.focus({ preventScroll: true }) } catch (e) { b.focus() }
  }
  function onBubbleClick(ev) {
    const b = ev.target.closest('[data-tour-act]')
    if (!b || b.disabled) return
    const act = b.getAttribute('data-tour-act')
    if (S.prompt) { const fn = S.prompt.acts[act]; if (fn) fn(); return }
    if (act === 'next') next()
    else if (act === 'prev') prev()
    else if (act === 'skip') finishTour('skipped')
    else if (act === 'close') pauseTour()
  }

  // ---------- 案内の進め方 ----------
  // tour: { key, steps: [{ route?, sel?, title, body(el) | string, fallback?(), skip?() }], onFinish?(status, a) }
  function startTour(tour, from, opts) {
    closeMenu()
    closePrompt()
    if (S.active) stopActive()
    S.active = { tour, idx: -1, dir: 1, auto: !!(opts && opts.auto), shown: 0, visited: new Set(), el: null, sel: null }
    return showStep(Math.max(0, Math.min(Number(from) || 0, tour.steps.length - 1)), 1)
  }
  async function showStep(idx, dir) {
    const a = S.active
    if (!a) return
    const token = ++S.seq
    const steps = a.tour.steps
    while (idx >= 0 && idx < steps.length) {
      const st = steps[idx]
      let skip = false
      try { skip = !!(st.skip && st.skip()) } catch (e) { skip = true }
      if (skip) { idx += dir; continue }
      if (st.route && curHash() !== st.route) {
        goRoute(st.route)
        // 画面を移すときは、読み込みの間も暗いままにして待つ（自動で出した案内は、出せると決まるまで画面を暗くしない）
        if (!a.auto) waitingBubble(a, idx)
      }
      const el = await waitTarget(st.sel, token)
      if (el === undefined || S.active !== a || token !== S.seq) return
      if (st.sel && !el && !st.fallback) { idx += dir; continue } // 見つからないステップは飛ばす
      if (st.route) a.visited.add(st.route)
      render(a, idx, el)
      return
    }
    if (idx >= steps.length) {
      // 1つも出せなかった自動の案内は、見たことにしない
      if (!a.shown) { cancelActive(); return }
      return finishTour('done')
    }
    // 「前へ」で先頭より前に出た（前のステップが見つからない）: 今のステップに戻る
    if (a.idx >= 0) return showStep(a.idx, 1)
    cancelActive()
  }
  function waitingBubble(a, idx) {
    a.el = null; a.sel = null
    fillBubble({ count: `${idx + 1} / ${a.tour.steps.length}`, title: '画面を開いています…', body: '<p class="text-gray-500"><span class="spin" style="width:16px;height:16px;vertical-align:-3px"></span> 少しお待ちください</p>', buttons: [{ act: 'skip', label: 'スキップ', skip: true }], closeLabel: '案内を閉じる（続きはあとで見られます）' })
    place()
  }
  function render(a, idx, el) {
    const st = a.tour.steps[idx]
    a.idx = idx; a.shown++; a.el = el; a.sel = el ? st.sel : null
    const last = idx === a.tour.steps.length - 1
    let body
    try { body = el ? (typeof st.body === 'function' ? st.body(el) : st.body) : (st.fallback ? st.fallback() : (typeof st.body === 'function' ? st.body(null) : st.body)) } catch (e) { body = '' }
    fillBubble({
      count: `${idx + 1} / ${a.tour.steps.length}`, title: st.title, body,
      buttons: [{ act: 'skip', label: 'スキップ', skip: true }, { act: 'prev', label: '前へ', disabled: idx === 0 }, { act: 'next', label: last ? '完了' : '次へ', primary: true }],
      closeLabel: '案内を閉じる（続きはあとで見られます）',
    })
    if (el) bringIntoView(el)
    place()
    // 画面の描き直しで対象が入れ替わっても、吹き出しが付いていくように
    clearInterval(S.tick)
    S.tick = setInterval(place, 400)
    focusBubble(a.auto && a.shown === 1)
    if (!S.readonly) saveStep(a.tour.key, idx)
  }
  function next() { const a = S.active; if (a && a.idx >= 0) { a.dir = 1; showStep(a.idx + 1, 1) } }
  function prev() { const a = S.active; if (a && a.idx > 0) { a.dir = -1; showStep(a.idx - 1, -1) } }
  function stopActive() {
    clearTimeout(S.saveTimer)
    S.seq++
    S.active = null
    teardown()
  }
  // 何も残さずにやめる（自動の案内を出せなかった・出す前に画面を移ったとき）
  function cancelActive() { stopActive() }
  // 見終わった・スキップした
  function finishTour(status) {
    const a = S.active
    if (!a) return
    stopActive()
    S.suppressHash = location.hash
    const items = [{ key: a.tour.key, status, step: status === 'done' ? 0 : Math.max(0, a.idx) }]
    if (a.tour.onFinish) { try { a.tour.onFinish(status, a, items) } catch (e) { } }
    save(items)
    if (status === 'skipped') say(isAdmin() ? '案内は、右上の「？」からいつでも見られます' : '使い方は「その他」の「使い方をもう一度見る」からいつでも見られます', 4000)
  }
  // ✕・Esc・画面の移動: 途中のステップを残して閉じる（次に開いたときに続きから）
  function pauseTour(quiet) {
    const a = S.active
    if (!a) return
    stopActive()
    S.suppressHash = location.hash
    if (!a.shown || a.idx < 0) return
    save([{ key: a.tour.key, status: 'in_progress', step: a.idx }])
    if (!quiet) say('案内を閉じました。続きは次に開いたときに表示します（やめるときは「スキップ」）', 4000)
  }

  // ---------- 確認（始める・あとで） ----------
  function showPrompt({ title, body, buttons, acts, onEsc }) {
    closeMenu()
    if (S.active) stopActive()
    S.prompt = { acts: Object.assign({ close: onEsc }, acts), onEsc }
    const root = ensureLayer()
    S.active = null
    fillBubble({ title, body, buttons, closeLabel: '閉じる' })
    root.querySelector('.tour-hole').hidden = true
    place()
    focusBubble(true)
  }
  function closePrompt() {
    if (!S.prompt) return
    S.prompt = null
    teardown()
  }

  // ---------- キーボード（Esc で閉じる・→ と Enter で次へ・← で前へ・Tab は吹き出しの中を回る） ----------
  document.addEventListener('keydown', (e) => {
    if (S.menu && e.key === 'Escape') { e.preventDefault(); closeMenu(true); return }
    if (S.menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveMenuFocus(e.key === 'ArrowDown' ? 1 : -1); return }
    if (!(S.active || S.prompt) || !S.layer || S.layer.hidden) return
    const bubble = S.layer.querySelector('.tour-bubble')
    const ae = document.activeElement
    const inBox = !!(ae && bubble.contains(ae))
    const onBody = !ae || ae === document.body || ae === document.documentElement
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (S.prompt) S.prompt.onEsc(); else pauseTour()
      return
    }
    if (!inBox && !onBody) return
    if (e.key === 'Tab') {
      const f = [...bubble.querySelectorAll('button:not(:disabled), a[href]')]
      if (!f.length) return
      const i = f.indexOf(ae)
      e.preventDefault()
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus()
      return
    }
    if (S.prompt) return
    const onButton = !!(ae && ae.closest && ae.closest('button') && inBox)
    if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onButton)) { e.preventDefault(); next() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
  }, true)

  // ---------- 「？」のメニュー（管理画面） ----------
  const helpBtnHtml = (cls, withLabel) => `<button type="button" class="tour-help-btn ${cls}" data-action="tourHelpMenu" aria-haspopup="menu" aria-expanded="false" aria-label="使い方・案内" title="使い方・案内"><i class="fas fa-circle-question"></i>${withLabel ? '<span>使い方</span>' : ''}</button>`
  function mountAdminHelp() {
    // スマホ: 上のヘッダーの「伴走支援」の左。PC: 画面の右上（内容の上の細い行）
    const head = document.querySelector('header.md\\:hidden')
    const ref = head && head.querySelector('[data-action="hqsOpenSupport"]')
    if (ref && !head.querySelector('.tour-help-btn')) ref.insertAdjacentHTML('beforebegin', helpBtnHtml('text-blue-600 shrink-0 px-1 py-1 text-lg'))
    const bar = document.getElementById('hq-support-bar')
    if (bar && !document.getElementById('tour-help-bar')) {
      bar.insertAdjacentHTML('beforebegin', `<div id="tour-help-bar" class="hidden md:flex justify-end px-6 pt-3 -mb-4 max-w-7xl">
        ${helpBtnHtml('inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-blue-700 bg-white border border-gray-200 rounded-full px-3 py-1 shadow-sm', true)}</div>`)
    }
  }
  function menuItems() {
    const items = []
    if (isAdmin()) {
      const name = adminScreen()
      items.push(name ? { act: 'screen', icon: 'fa-circle-info', label: `この画面の使い方（${SCREEN_TOURS[name].label}）` }
        : { icon: 'fa-circle-info', label: 'この画面の使い方（この画面の案内はありません）', disabled: true })
      items.push({ act: 'welcome', icon: 'fa-route', label: '最初の案内をもう一度見る' })
      const c = S.checklist
      if (!S.readonly && c && c.items && !c.show && !CHECKLIST.every(x => c.items[x.key])) items.push({ act: 'checklist', icon: 'fa-list-check', label: '「はじめにやること」を表示する' })
    } else {
      items.push({ act: 'welcome', icon: 'fa-route', label: '使い方をもう一度見る' })
    }
    return items
  }
  function openMenu(btn) {
    closeMenu()
    injectStyle()
    const m = document.createElement('div')
    m.id = 'tour-menu'
    m.setAttribute('role', 'menu')
    m.setAttribute('aria-label', '使い方・案内')
    m.innerHTML = menuItems().map(it => `<button type="button" role="menuitem" ${it.act ? `data-tour-menu="${h(it.act)}"` : ''} ${it.disabled ? 'disabled' : ''}><i class="fas ${h(it.icon)}"></i><span>${h(it.label)}</span></button>`).join('')
    document.body.appendChild(m)
    const r = btn.getBoundingClientRect()
    const vw = document.documentElement.clientWidth || window.innerWidth
    m.style.top = Math.round(r.bottom + 6) + 'px'
    m.style.right = Math.max(12, Math.round(vw - r.right)) + 'px'
    m.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-tour-menu]')
      if (!b || b.disabled) return
      const act = b.getAttribute('data-tour-menu')
      closeMenu()
      if (act === 'screen') { const n = adminScreen(); if (n) startTour(screenTour(n), 0) }
      else if (act === 'welcome') startTour(isAdmin() ? ADMIN_WELCOME : STAFF_WELCOME, 0)
      else if (act === 'checklist') reopenChecklist()
    })
    S.menu = m; S.menuBtn = btn
    btn.setAttribute('aria-expanded', 'true')
    const first = m.querySelector('button:not(:disabled)')
    if (first) first.focus()
  }
  function closeMenu(refocus) {
    if (!S.menu) return
    S.menu.remove(); S.menu = null
    if (S.menuBtn) { S.menuBtn.setAttribute('aria-expanded', 'false'); if (refocus) S.menuBtn.focus() }
    S.menuBtn = null
  }
  function moveMenuFocus(d) {
    const f = [...S.menu.querySelectorAll('button:not(:disabled)')]
    if (!f.length) return
    const i = f.indexOf(document.activeElement)
    f[(i + d + f.length) % f.length].focus()
  }
  document.addEventListener('click', (ev) => {
    if (!S.menu) return
    if (S.menu.contains(ev.target) || (ev.target.closest && ev.target.closest('.tour-help-btn'))) return
    closeMenu()
  }, true)
  if (typeof delegate === 'function') {
    delegate('tourHelpMenu', (el) => { if (S.menu && S.menuBtn === el) closeMenu(); else openMenu(el) })
    delegate('tourChecklistClose', () => closeChecklist())
    delegate('tourStaffReplay', () => startTour(STAFF_WELCOME, 0))
  }

  // =========================================================
  // 管理画面の案内（文言は今の画面の名前・ボタンに合わせる）
  // =========================================================
  const P = (...lines) => lines.map(l => `<p>${l}</p>`).join('')
  const parentOf = (sel) => () => { const el = $(sel); return el ? el.parentElement : null }
  const closestOf = (sel, up) => () => { const el = $(sel); return el ? el.closest(up) : null }
  const HELP_BTN_SEL = ['#tour-help-bar .tour-help-btn', 'header .tour-help-btn']

  // 最初の案内: クライアント → 案件 → スタッフ → シフト → 日報・勤怠の確認 → 精算
  const ADMIN_WELCOME = {
    key: 'admin-welcome',
    steps: [
      { title: 'Field OS の主な機能', body: P('クライアント → 案件 → スタッフ → シフト → 日報・勤怠の確認 → 精算 の順に、実際の画面で案内します。',
        '［次へ］で進み、［スキップ］でいつでも終われます。キーボードでは →・Enter で次へ、← で前へ、Esc で閉じます。') },
      { route: 'clients', sel: '[onclick^="showAddClient"]', title: '1. クライアント',
        body: P('まず、取引先（請求先）の会社を登録します。', '「クライアント登録」から、会社名・住所・締め日・担当者などを入れます。') },
      { route: 'projects', sel: '[onclick^="showAddProject"]', title: '2. 案件',
        body: P('次に、クライアントから受けた仕事を「案件登録」で作ります。', '稼働場所・請求と支払の単価・日報の項目などを、案件ごとに決めます。') },
      { route: 'staff', sel: '[onclick^="showAddRoster"]', title: '3. スタッフ',
        body: P('働く人を「新規追加」で登録します。氏名と電話番号だけなら「仮登録（氏名・電話のみ）」でもすぐ作れます。',
          'スタッフの詳細で「ログインを発行」すると、スタッフアプリで打刻・日報を使えます。') },
      { route: 'shifts', sel: ['[data-action="boardNewSlot"]', '#board-grid'], title: '4. シフト',
        body: P('シフト管理では、まず「枠を作成」で案件・日付・時間・人数の枠を作ります。', '表のマスを押すと、右の欄にその枠の候補のスタッフが出ます。') },
      { route: 'shifts', sel: '#board-save-top', title: '4. シフト（まとめて保存）',
        body: P('候補を押した割り当ては下書きとして表に入り、「まとめて保存」を押すと登録されます。', '毎週同じ人が入るときは「常勤の繰り返し登録」が便利です。') },
      { route: 'dashboard', sel: '#today-shifts', title: '5. 日報・勤怠の確認（当日）',
        body: P('当日は、ダッシュボードの「本日のシフト・報告状況」で、起床・入店などの報告と遅刻を確かめます。', '予定の時刻を過ぎても報告がない人は、上の「未報告」の欄にも出ます。') },
      { route: 'reports', sel: [parentOf('[data-action="reportQuick"]'), '#report-mode-tabs'], title: '5. 日報・勤怠の確認（日報）',
        body: P('「日報一覧」で、スタッフが出した日報を確認します。', '「未確認」を押すと、まだ確認していない日報だけを出せます。') },
      { route: 'corrections', sel: [parentOf('[onclick^="corrSet(\'status\'"]'), '[data-action="corrNew"]'], title: '5. 日報・勤怠の確認（打刻の修正）',
        body: P('スタッフから打刻の修正の申請が届いたら、「打刻修正承認」で承認します。', '承認すると、勤怠の記録と実績に反映します。') },
      { route: 'settlement', sel: '[data-action="settleSync"]', title: '6. 精算',
        body: P('月末は「精算」で実績を確かめます。', '「入店・退店報告から実績を反映」で実績の時間を取り込み、シフト明細で確かめてから、請求・支払を出します。') },
      { route: 'settlement', sel: '#settle-export', title: '6. 精算（CSV出力）',
        body: P('シフト明細・請求集計・支払集計を CSV で出せます。') },
      { sel: HELP_BTN_SEL, title: '使い方はいつでも見られます',
        body: P('各画面の使い方は、右上の「？」の「この画面の使い方」から見られます。', 'この案内も「最初の案内をもう一度見る」から、もう一度見られます。'),
        fallback: () => P('各画面の使い方は、右上の「？」から見られます。') },
    ],
    // 見終わったら、案内の中で開いた画面の「この画面の使い方」は自動では出さない（同じ画面で続けて出さないように）。ダッシュボードへ戻る
    onFinish(status, a, items) {
      if (status !== 'done') return
      for (const r of a.visited) {
        const key = 'admin-screen-' + r
        if (SCREEN_TOURS[r] && !S.progress[key]) items.push({ key, status: 'done', step: 0 })
      }
      // ダッシュボードの「はじめにやること」は、画面の描画の後に admin.js が FosTour.dashboard を呼んで出す
      if (curHash() !== 'dashboard') goRoute('dashboard')
      S.suppressHash = '#dashboard'
    },
  }

  // 画面ごとの使い方（3〜5ステップ）。key は src/tours.ts の ADMIN_TOUR_SCREENS と合わせる
  const SCREEN_TOURS = {
    dashboard: { label: 'ダッシュボード', steps: [
      { sel: '#kpi-cards', title: '今日の数字', body: P('本日の稼働予定・売上予定、日報未提出（直近3日）、要フォローのスタッフの数です。') },
      { sel: '#unreported-section', title: '未報告の人', body: P('予定の時刻を過ぎても、起床・出発・入店・退店の報告がない人が出ます。', '名前を押すと、代理入力や報告用URLの発行ができます。') },
      { sel: '#todo-section', title: '管理者ToDo', body: P('対応が必要なことが一覧で出ます。押すと、その画面を開きます。') },
      { sel: '#today-shifts', title: '本日のシフト・報告状況', body: P('今日のシフトごとに、報告の時刻・遅刻・未報告を確かめられます。案件や状態で絞り込めます。') },
      { sel: '#dash-ahead', title: '今後の人員不足・未確定', body: P('この先の、人が足りない枠と未確定のシフトです。押すとシフト管理でその週を開きます。') },
    ] },
    clients: { label: 'クライアント', steps: [
      { sel: '[onclick^="showAddClient"]', title: 'クライアント登録', body: P('取引先（請求先）の会社を登録します。会社名・住所・締め日・担当者などを入れます。') },
      { sel: [parentOf('#client-q'), '#client-q'], title: '検索・並べ替え', body: P('会社名・代表者・担当者・稼働中の案件で探せます。上流・下流や並び順も選べます。') },
      { sel: '#client-cards', title: 'クライアントの一覧', body: P('会社名を押すと詳細を開き、担当者・契約書・案件などを確かめられます。') },
      { sel: closestOf('#client-docexp', 'label'), title: '契約書の期限', body: P('契約書の契約終了日が近い・過ぎた会社だけを出せます。') },
    ] },
    projects: { label: '案件管理', steps: [
      { sel: '[onclick^="showAddProject"]', title: '案件登録', body: P('クライアントから受けた仕事を案件として登録します。稼働場所・請求と支払の単価・日報の項目などを、案件ごとに決めます。') },
      { sel: [parentOf('#proj-q'), '#proj-q'], title: '検索・絞り込み', body: P('案件名・稼働場所・クライアント名で探し、クライアント・状態（稼働中・終了）などで絞り込めます。') },
      { sel: '#proj-rows', title: '案件の一覧', body: P('行を押すと案件の詳細を開きます。見出しを押すと並べ替えられます。') },
      { sel: '[data-action="showLatenessSetting"]', title: '遅刻の猶予', body: P('入店・勤務開始を何分まで遅刻にしないかを、会社全体で決めます。') },
    ] },
    staff: { label: 'スタッフマスタ', steps: [
      { sel: '[onclick^="showAddRoster"]', title: '新規追加', body: P('スタッフを登録します。', '詳細の「ログインを発行」で、スタッフアプリ（打刻・日報）を使えるようになります。') },
      { sel: '[onclick^="showQuickRegister"]', title: '仮登録（氏名・電話のみ）', body: P('氏名と電話番号だけで、先に登録しておけます。詳しい情報は後から入れられます。') },
      { sel: '#staff-filters', title: '検索・絞り込み', body: P('氏名・電話・スキル・エリアなどで探せます。「要フォロー」「離職リスク」「アプリ未利用」などで絞り込めます。') },
      { sel: '#staff-rows', title: 'スタッフの一覧', body: P('行を押すと詳細を開き、基本情報・ログイン・評価・書類などを確かめられます。') },
    ] },
    shifts: { label: 'シフト管理', steps: [
      { sel: '#board-filters', title: '期間と絞り込み', body: P('週・2週間・月を切り替え、クライアント・案件・「不足のみ」で絞り込めます。「案件ごと」「人ごと」で表の見方も変えられます。') },
      { sel: '[data-action="boardNewSlot"]', title: '枠を作成', body: P('案件・日付・時間・必要な人数の枠を作ります。毎週同じ枠は「その他の操作」の「枠の繰り返し登録」が便利です。') },
      { sel: '#board-grid', title: 'シフトの表', body: P('マスを押すと、右の欄にその枠の候補のスタッフが出ます。') },
      { sel: '#board-side', title: '候補のスタッフ', body: P('候補を押すと、下書きとして表に入ります（この時点では、まだ保存されていません）。') },
      { sel: '#board-save-top', title: 'まとめて保存', body: P('下書きの割り当ては、「まとめて保存」を押すと登録されます。') },
    ] },
    reports: { label: '日報一覧', steps: [
      { sel: '#report-mode-tabs', title: '提出済み・未提出', body: P('提出された日報と、日報がまだ出ていないシフトを切り替えて見られます。') },
      { sel: parentOf('[data-action="reportQuick"]'), title: '未確認・インシデント', body: P('まだ確認していない日報や、インシデント・クレームのある日報だけを、押すとすぐに出せます。') },
      { sel: closestOf('#rp-from', 'section'), title: '絞り込み', body: P('期間・案件・スタッフで絞り込めます。') },
      { sel: '[data-action="checkShownReports"]', title: 'まとめて確認済みにする', body: P('表示中の未確認の日報を、まとめて確認済みにできます。') },
    ] },
    corrections: { label: '打刻修正承認（勤怠）', steps: [
      { sel: parentOf('[onclick^="corrSet(\'status\'"]'), title: '申請の状態', body: P('「承認待ち」「承認済み」「却下」などで切り替えます。まずは「承認待ち」を確かめます。', '申請を押すと内容を確かめて承認・却下できます。承認すると、勤怠の記録と実績に反映します。') },
      { sel: '[data-action="corrNew"]', title: '管理者として申請', body: P('スタッフの代わりに、打刻の修正や打刻漏れの追加を申請できます。') },
      { sel: 'a[href="#corrections/punches"]', title: '打刻一覧', body: P('スタッフの打刻（入店・退店など）を一覧で確かめられます。') },
      { sel: '[data-action="corrDeadlineSetting"]', title: '受付期限', body: P('スタッフがアプリから修正を申請できる期限（勤務日から何日後まで）を決めます。') },
    ] },
    settlement: { label: '精算', steps: [
      { sel: '#settle-filters', title: '期間と絞り込み', body: P('期間・クライアント・案件・スタッフで対象を決めて、「表示」を押します。') },
      { sel: '[data-action="settleSync"]', title: '入店・退店報告から実績を反映', body: P('入店・退店の報告から、実績の時間を取り込みます。') },
      { sel: '#settle-totals', title: '合計', body: P('表示中の対象の、請求・支払などの合計です。') },
      { sel: '#settle-tabs', title: '明細・請求・支払', body: P('「シフト明細」で1件ずつ確かめ、「請求（クライアント別）」「支払（支払先別）」で集計を見ます。') },
      { sel: '#settle-export', title: 'CSV出力', body: P('シフト明細・請求集計・支払集計を CSV で出せます。') },
    ] },
  }
  const screenTour = (name) => ({ key: 'admin-screen-' + name, steps: SCREEN_TOURS[name].steps })
  // 今の画面の案内の名前（一覧の画面だけ。詳細の画面・別の表示では出さない）
  function adminScreen() {
    const [tab, sub] = ((location.hash || '').slice(1) || 'dashboard').split('/')
    if (!SCREEN_TOURS[tab]) return null
    if (sub && tab !== 'reports') return null // 日報一覧の絞り込み（#reports/date=…）は同じ画面
    return tab
  }

  // 初回の確認（始める・あとで）。途中で閉じていたら「続きから」
  function maybeAdminWelcome() {
    const rec = S.progress['admin-welcome']
    if (rec && rec.status !== 'in_progress') return false
    const later = () => {
      closePrompt()
      S.suppressHash = location.hash
      save([{ key: 'admin-welcome', status: 'skipped', step: rec ? rec.step : 0 }])
      say('案内は、右上の「？」の「最初の案内をもう一度見る」からいつでも見られます', 4500)
    }
    if (!rec) {
      showPrompt({
        title: 'Field OS へようこそ',
        body: P('主な機能（クライアント → 案件 → スタッフ → シフト → 日報・勤怠の確認 → 精算）を、実際の画面で順に案内します（3分ほど）。'),
        buttons: [{ act: 'later', label: 'あとで' }, { act: 'start', label: '始める', primary: true }],
        acts: { later, start: () => startTour(ADMIN_WELCOME, 1) },
        onEsc: later,
      })
    } else {
      showPrompt({
        title: '案内の続き',
        body: P('前回は案内を途中で閉じました。続きから案内します。'),
        buttons: [{ act: 'later', label: 'あとで' }, { act: 'restart', label: '最初から' }, { act: 'resume', label: '続きから', primary: true }],
        acts: { later, restart: () => startTour(ADMIN_WELCOME, 1), resume: () => startTour(ADMIN_WELCOME, rec.step) },
        onEsc: later,
      })
    }
    return true
  }
  // 主な画面を初めて開いたときに、その画面の短い案内を1回だけ出す
  async function maybeAutoScreen() {
    if (!isAdmin() || !S.loaded || S.active || S.prompt || S.readonly || mustWait()) return
    const w = S.progress['admin-welcome']
    if (!w || w.status === 'in_progress') return // 最初の案内を先に出す
    if (S.suppressHash !== null && S.suppressHash === location.hash) return
    const name = adminScreen()
    if (!name) return
    const key = 'admin-screen-' + name, rec = S.progress[key]
    if (rec && rec.status !== 'in_progress') return
    const hash = location.hash, token = ++S.autoSeq
    await wait(300)
    if (token !== S.autoSeq || location.hash !== hash || S.active || S.prompt) return
    startTour(screenTour(name), rec ? rec.step : 0, { auto: true })
  }

  // ---------- はじめにやること（会社管理者。ダッシュボードの上） ----------
  const CHECKLIST = [
    { key: 'clients', label: 'クライアントを登録する', hint: '取引先（請求先）の会社を「クライアント登録」から登録します', href: '#clients' },
    { key: 'projects', label: '案件を作る', hint: 'クライアントの仕事を「案件登録」で作り、単価・日報の項目を決めます', href: '#projects' },
    { key: 'staff', label: 'スタッフを登録する', hint: 'スタッフマスタの「新規追加」から登録します', href: '#staff' },
    { key: 'shifts', label: 'シフトを組む', hint: 'シフト管理で枠を作り、スタッフを割り当てて「まとめて保存」します', href: '#shifts' },
    { key: 'logins', label: 'スタッフにログインを案内する', hint: 'スタッフの詳細の「ログインを発行」から、ログイン案内（URL・会社コード・ID）を送ります。スタッフが1人でもログインすると完了になります', href: '#staff' },
  ]
  function checklistHtml(items) {
    const done = CHECKLIST.filter(x => items[x.key]).length
    const pct = Math.round(done / CHECKLIST.length * 100)
    return `<section id="tour-checklist" class="card p-4 mb-4 border-blue-200" aria-labelledby="tour-checklist-title">
      <div class="flex items-start gap-2">
        <div class="flex-1 min-w-0">
          <h3 id="tour-checklist-title" class="font-bold text-gray-800"><i class="fas fa-flag-checkered text-blue-600 mr-1"></i>はじめにやること</h3>
          <p class="text-xs text-gray-500 mt-0.5">使い始めるための準備です。済んだ項目には自動でチェックが付き、すべて済むとこの欄は消えます（${done} / ${CHECKLIST.length} 完了）</p>
        </div>
        <button type="button" class="text-xs text-gray-500 hover:text-gray-700 underline shrink-0" data-action="tourChecklistClose">閉じる</button>
      </div>
      <div class="h-1.5 bg-gray-100 rounded-full mt-2 mb-3 overflow-hidden" role="progressbar" aria-label="はじめにやることの進み具合" aria-valuemin="0" aria-valuemax="${CHECKLIST.length}" aria-valuenow="${done}"><div class="h-full bg-blue-600 rounded-full" style="width:${pct}%"></div></div>
      <ol class="space-y-2">${CHECKLIST.map(x => {
        const ok = !!items[x.key]
        return `<li class="flex items-start gap-2 text-sm" data-check="${h(x.key)}">
          <i class="fas ${ok ? 'fa-circle-check text-emerald-500' : 'fa-circle text-gray-300'} mt-1" aria-hidden="true"></i>
          <div class="flex-1 min-w-0"><p class="${ok ? 'text-gray-400 line-through' : 'font-bold text-gray-800'}">${h(x.label)}<span class="sr-only">${ok ? '（完了）' : '（未完了）'}</span></p>
            ${ok ? '' : `<p class="text-xs text-gray-500">${h(x.hint)}</p>`}</div>
          ${ok ? '' : `<a href="${h(x.href)}" class="btn btn-outline text-xs shrink-0">開く</a>`}
        </li>`
      }).join('')}</ol>
    </section>`
  }
  // ダッシュボードを描いた後に呼ぶ（admin.js の routes.dashboard）
  async function dashboard() {
    if (!isAdmin() || S.readonly || !S.me || S.me.role !== 'company_admin') return
    let d
    try { d = (await axios.get('/api/admin/tours/checklist', { background: true })).data } catch (e) { return }
    S.checklist = d
    const old = document.getElementById('tour-checklist')
    if (d.completed_now) say('「はじめにやること」がすべて済みました。', 4000)
    if (!d.show || !d.items) { if (old) old.remove(); return }
    // 読み込みの間にほかの画面へ移ったら出さない
    if (adminScreen() !== 'dashboard' || !document.getElementById('kpi-cards')) return
    if (old) old.outerHTML = checklistHtml(d.items)
    else document.getElementById('app').insertAdjacentHTML('afterbegin', checklistHtml(d.items))
  }
  function closeChecklist() {
    const el = document.getElementById('tour-checklist')
    if (el) el.remove()
    if (S.checklist) S.checklist.show = false
    save([{ key: 'admin-checklist', status: 'skipped', step: 0 }])
    say('「はじめにやること」は、右上の「？」からもう一度表示できます', 4000)
  }
  async function reopenChecklist() {
    await save([{ key: 'admin-checklist', status: 'in_progress', step: 0 }])
    if (adminScreen() === 'dashboard') dashboard()
    else location.hash = 'dashboard'
  }

  // =========================================================
  // スタッフアプリの案内（30秒ほど）: ホーム画面に追加 → 打刻 → 日報 → 通知
  // =========================================================
  const UA = navigator.userAgent || ''
  const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const IS_ANDROID = /Android/.test(UA)
  const isStandalone = () => { try { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true } catch (e) { return false } }
  function homeScreenBody() {
    if (IS_IOS) {
      const safari = !/CriOS|FxiOS|EdgiOS|OPiOS/.test(UA)
      return (safari ? '' : P('iPhone・iPad では、<b>Safari</b> でこのページを開いてから追加してください。'))
        + '<ol><li>画面の下（iPad は上）の共有ボタン <i class="fas fa-arrow-up-from-bracket text-blue-600" aria-label="共有"></i> を押します</li><li>「ホーム画面に追加」を選び、「追加」を押します</li></ol>'
        + P('次からはホーム画面のアイコンで1回で開けます。', '<b>プッシュ通知を受け取るには、ホーム画面に追加したアイコンから開く必要があります</b>（iOS 16.4 以降）。')
    }
    if (IS_ANDROID) {
      return '<ol><li>Chrome の右上のメニュー <i class="fas fa-ellipsis-vertical text-blue-600" aria-label="メニュー"></i> を押します</li><li>「ホーム画面に追加」（または「アプリをインストール」）を選びます</li></ol>'
        + P('次からはホーム画面のアイコンで1回で開けます。')
    }
    return P('スマホで使うときは、ブラウザのメニューから「ホーム画面に追加」すると、次からアイコンで1回で開けます。')
  }
  const REPORT_NAMES = { wake_up: '起床報告', departure: '出発報告', check_in: '入店報告', work_start: '勤務開始', break_start: '休憩入', break_end: '休憩出', work_end: '勤務終了', check_out: '退店報告' }
  const STAFF_WELCOME = {
    key: 'staff-welcome',
    steps: [
      { title: 'ホーム画面に追加', skip: isStandalone, body: () => P('はじめに、このアプリをスマホのホーム画面に追加しておきましょう。') + homeScreenBody() },
      { route: 'home', sel: '#attendance-section', title: '打刻（報告のボタン）',
        body: (el) => {
          const names = [...new Set([...el.querySelectorAll('[data-action="homeReport"]')].map(b => REPORT_NAMES[b.getAttribute('data-type')]).filter(Boolean))]
          return P('シフトの日は、ホームに報告のボタンが出ます。起きたとき・現場に着いたとき・終わったときなどに、その場で押してください。')
            + (names.length ? P(`この会社で使う報告: ${names.map(n => '「' + h(n) + '」').join('')}`) : '')
        },
        fallback: () => P('シフトのある日は、ホームに「入店報告」などの報告のボタンが出ます。起きたとき・現場に着いたとき・終わったときなどに、その場で押してください。', '出るボタンは、会社の設定で変わります。') },
      { sel: '#bottom-nav [data-tab="report"]', title: '日報',
        body: P('勤務が終わったら、下の「日報」から、その日の実績を報告します。', '前に出した日報も、同じ画面で見られます。') },
      { sel: '#bottom-nav [data-tab="more"]', title: '通知とお知らせ',
        body: P('お知らせ・通知・相談は「その他」にまとまっています。', '次に、通知を受け取る設定を開きます。') },
      { route: 'notify-settings', sel: ['[data-action="pushEnable"]', '#app section.card'], title: '通知を受け取る',
        body: P('「この端末でプッシュ通知を受け取る」を押すと、シフトの変更やリマインドを、アプリを開いていなくても通知で受け取れます。',
          'この案内は「その他」の「使い方をもう一度見る」から、いつでも見られます。') },
    ],
  }
  function maybeStaffWelcome() {
    const rec = S.progress['staff-welcome']
    if (rec && rec.status !== 'in_progress') return
    startTour(STAFF_WELCOME, rec ? rec.step : 0, { auto: true })
  }
  // 「その他」の画面の「使い方をもう一度見る」（staff.js の renderMore が並べる）
  function staffMoreHtml() {
    return `<button type="button" class="report-btn w-full text-left" data-action="tourStaffReplay">
        <span class="w-11 h-11 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas fa-circle-question"></i></span>
        <span class="flex-1"><span class="block font-bold text-gray-800">使い方をもう一度見る</span><span class="block text-xs text-gray-400">ホーム画面に追加・打刻・日報・通知の案内</span></span>
        <i class="fas fa-chevron-right text-gray-300"></i>
      </button>`
  }

  // =========================================================
  // 起動
  // =========================================================
  const mustWait = () => !!(S.me && (S.me.must_change_password || S.me.mfa_setup_required))
  function autoStart() {
    if (!S.loaded || S.readonly || mustWait() || S.active || S.prompt) return
    if (isAdmin()) { if (!maybeAdminWelcome()) maybeAutoScreen() }
    else maybeStaffWelcome()
  }
  async function init(app, me) {
    if (S.inited || !me) return
    S.inited = true
    S.app = app === 'admin' ? 'admin' : 'staff'
    S.me = Object.assign({}, me)
    if (S.pwChanged) S.me.must_change_password = false
    S.readonly = !!window.HQ_VIEW || me.role === 'system_admin'
    if (isAdmin()) mountAdminHelp()
    try {
      const d = (await axios.get(apiBase(), { background: true })).data
      S.progress = (d && d.progress) || {}
      if (d && d.readonly) S.readonly = true
    } catch (e) {
      // 読めないときは自動では出さない（毎回出てしまわないように）。「？」からは見られる
      return
    }
    S.loaded = true
    // 最初の画面が描き終わってから出す
    for (let i = 0; i < 40 && pageBusy(); i++) await wait(150)
    autoStart()
  }
  // 初回のパスワードの変更が済んだら案内を始める（admin.js の「パスワードの変更」・staff-profile.js の変更の画面）
  axios.interceptors.response.use((res) => {
    try {
      const cfg = res && res.config
      if (cfg && String(cfg.method).toLowerCase() === 'post' && /\/api\/auth\/change-password$/.test(String(cfg.url || ''))) {
        // 起動の途中（init の前）に変更されたときは、init で仮パスワードではないとみなす
        S.pwChanged = true
        if (S.me) S.me.must_change_password = false
        if (S.inited) setTimeout(autoStart, 800)
      }
    } catch (e) { }
    return res
  })
  window.addEventListener('hashchange', () => {
    closeMenu()
    const own = S.tourNav && location.hash === S.tourNav
    S.tourNav = null
    if (own) return
    S.suppressHash = null
    // 案内の途中で利用者が画面を移った（戻るボタンなど）: 途中のステップを残して閉じる
    if (S.active) pauseTour(true)
    if (S.prompt) return
    maybeAutoScreen()
  })

  window.FosTour = { init, dashboard, staffMoreHtml, start: (k) => startTour(k === 'staff' ? STAFF_WELCOME : k === 'admin' ? ADMIN_WELCOME : screenTour(k), 0) }
})()
