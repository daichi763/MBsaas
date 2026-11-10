// =========================================================
// 日報の入力欄（実績件数・報告事項・インシデント／クレーム・提出ボタン）の描画。
// スタッフアプリの日報の画面（staff.js の renderReport）と、管理画面の日報テンプレートのプレビュー（admin.js。#9903）で共用する。
// 同じ関数で描くので、プレビューとスタッフのスマホの見た目がずれない。common.js（esc・delegate）の後に読み込む
// =========================================================
const REPORT_TEXT_MAX = 2000 // src/lib/validate.ts の REPORT_TEXT_MAX と同じ
const reportFieldRequired = (f) => !!f && (f.required === true || f.required === 1 || f.required === 'true')

// fields: テンプレートの項目、pv: キー → 初期値（提出済みの値）。
// opts: incident / complaint（インシデント・クレームの印の初期値）、submitLabel・submitDisabled（提出ボタン）
function reportFormBodyHtml(fields, pv, opts) {
  const o = opts || {}
  const val = (k) => { const v = pv ? pv(k) : ''; return v == null ? '' : v }
  const numFields = fields.filter(f => f.type === 'number')
  const textFields = fields.filter(f => f.type !== 'number')
  const reqMark = (f) => reportFieldRequired(f) ? '<span class="text-red-500 ml-0.5">*</span>' : ''
  // インシデント・クレームの内容（印を付けたら必須。#232）
  const flagBox = (kind, label, checked) => `
    <label class="flex items-center gap-3 py-1"><input id="${kind}-flag" type="checkbox" class="w-5 h-5 rounded rpt-flag" data-kind="${kind}" ${checked ? 'checked' : ''}><span class="text-sm font-medium text-gray-700">${label}があった</span></label>
    <div id="${kind}-note-box" class="${checked ? '' : 'hidden'} mb-2">
      <label class="text-xs text-gray-500 block mb-1" for="${kind}-note">${label}の内容<span class="text-red-500 ml-0.5">*</span></label>
      <textarea id="${kind}-note" rows="3" maxlength="${REPORT_TEXT_MAX}" class="inp rpt-autogrow" placeholder="何が・いつ・どう対応したか（例: 14時ごろ、料金の説明についてお客様から苦情。店長に報告し、説明し直して納得いただいた）">${esc(val(kind + '_note'))}</textarea>
      <p class="rpt-err hidden text-xs text-red-700 font-bold mt-1"></p>
    </div>`
  return `
      <div id="report-errors" class="hidden" tabindex="-1"></div>
      ${numFields.length ? `<section class="card p-4">
        <div class="flex items-center justify-between mb-3 gap-2">
          <h3 class="font-bold text-gray-700 text-sm"><i class="fas fa-hashtag text-blue-500 mr-1"></i>実績件数</h3>
          <button type="button" class="btn btn-outline text-xs" data-action="reportFillZero">空欄を0にする</button>
        </div>
        <p class="text-xs text-gray-400 mb-2">0件の項目も「0」を入力してください。稼働中も −／＋ で数えられます（数えた件数はこの端末に残り、提出するまで消えません）</p>
        <div class="grid grid-cols-2 gap-3">
          ${numFields.map(f => `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}${reqMark(f)}</label>
              <div class="flex items-stretch gap-1">
                <button type="button" class="btn btn-outline px-0 w-10 shrink-0 text-lg" data-action="reportCount" data-step="-1" aria-label="${esc(f.label)}を1減らす">−</button>
                <input type="number" inputmode="numeric" min="0" max="99999" step="1" data-key="${esc(f.key)}" data-label="${esc(f.label)}" class="inp rpt-field rpt-num text-center text-lg font-bold min-w-0 px-1 placeholder:font-normal placeholder:text-sm placeholder:text-gray-400" value="${esc(val(f.key))}" placeholder="—" aria-label="${esc(f.label)}">
                <button type="button" class="btn btn-outline px-0 w-10 shrink-0 text-lg" data-action="reportCount" data-step="1" aria-label="${esc(f.label)}を1増やす">＋</button>
              </div>
              <p class="rpt-err hidden text-xs text-red-700 font-bold mt-1"></p>
            </div>`).join('')}
        </div>
      </section>` : ''}
      ${textFields.length ? `<section class="card p-4">
        <h3 class="font-bold text-gray-700 mb-3 text-sm"><i class="fas fa-message text-blue-500 mr-1"></i>報告事項</h3>
        <div class="space-y-3">
          ${textFields.map(f => {
            // テキストの項目は、スマホで書いた内容を見返せるよう、すべて複数行の欄にする（#525）
            // 文字数の上限はサーバー（reportFieldRulesError）と同じく 1〜REPORT_TEXT_MAX の整数だけを使う
            const ml = Number(f.maxLength ?? f.max_length)
            const max = Number.isInteger(ml) && ml >= 1 && ml <= REPORT_TEXT_MAX ? ml : REPORT_TEXT_MAX
            const v = String(val(f.key))
            return `
            <div>
              <label class="text-xs text-gray-500 block mb-1">${esc(f.label)}${reqMark(f)}</label>
              <textarea data-key="${esc(f.key)}" data-label="${esc(f.label)}" data-required="${reportFieldRequired(f) ? '1' : ''}" rows="${f.type === 'textarea' ? 3 : 2}" maxlength="${max}" class="inp rpt-field rpt-autogrow" placeholder="${esc(f.placeholder || f.label + 'を入力')}">${esc(v)}</textarea>
              <p class="text-[11px] text-gray-400 text-right mt-0.5" data-counter data-max="${max}">残り ${max - v.length} 文字</p>
              <p class="rpt-err hidden text-xs text-red-700 font-bold mt-1"></p>
            </div>`
          }).join('')}
        </div>
      </section>` : ''}
      <section class="card p-4">
        ${flagBox('incident', 'インシデント', o.incident)}
        ${flagBox('complaint', 'クレーム', o.complaint)}
      </section>
      <div class="sticky bottom-[72px] z-10 -mx-1 px-1 pt-2 pb-1 bg-gradient-to-t from-gray-50 via-gray-50/90 to-transparent">
        <button type="submit" id="report-submit" class="btn btn-primary w-full py-3.5 text-base shadow-lg" ${o.submitDisabled ? 'disabled' : ''}>${esc(o.submitLabel || '日報を提出する')}</button>
      </div>`
}

// 送信の前の確認（UI-1 ui-staff-11。GOV.UK・DADS のエラーの出し方）。空の欄を全部調べ、それぞれの欄に赤い枠と「＊未入力です」などの文を付け、
// フォームの先頭に件数と欄へのリンクをまとめて出して、そこへ移る。問題があれば true を返す（送信しない）。入力した値は消さない。
// 直した欄は、入力したときに印を外す（reportFormBind）
function reportFormCheck(form) {
  const errs = []
  form.querySelectorAll('.rpt-num').forEach(el => { if (el.value.trim() === '') errs.push({ el, msg: '＊未入力です', kind: 'num' }) })
  form.querySelectorAll('textarea.rpt-field').forEach(el => { if (el.dataset.required && !el.value.trim()) errs.push({ el, msg: `＊「${el.dataset.label}」を入力してください`, kind: 'text' }) })
  for (const [kind, label] of [['incident', 'インシデント'], ['complaint', 'クレーム']]) {
    const flag = form.querySelector('#' + kind + '-flag'), note = form.querySelector('#' + kind + '-note')
    if (flag && note && flag.checked && !note.value.trim()) errs.push({ el: note, msg: `＊${label}の内容（何が・いつ・どう対応したか）を入力してください`, kind: 'text', label })
  }
  form.querySelectorAll('.rpt-invalid').forEach(el => reportFieldClearError(el))
  const box = form.querySelector('#report-errors')
  if (!errs.length) { if (box) { box.className = 'hidden'; box.innerHTML = '' } return false }
  errs.forEach((x, i) => {
    x.el.classList.add('rpt-invalid', 'ring-2', 'ring-red-400', 'border-red-400')
    x.el.setAttribute('aria-invalid', 'true')
    if (!x.el.id) x.el.id = 'rpt-f-' + i
    const msg = reportFieldErrorEl(x.el)
    if (msg) { msg.textContent = x.msg; msg.classList.remove('hidden'); msg.id = x.el.id + '-err'; x.el.setAttribute('aria-describedby', msg.id) }
  })
  const nums = errs.filter(x => x.kind === 'num').length
  if (box) {
    box.className = 'bg-red-50 border-2 border-red-400 rounded-2xl p-4 text-sm text-red-800 outline-none scroll-mt-20'
    box.setAttribute('role', 'alert')
    box.innerHTML = `<p class="font-bold text-base"><i class="fas fa-circle-exclamation mr-1"></i>未入力が${errs.length}件あります</p>
      ${nums ? '<p class="mt-1">0件の項目は「0」を入れてください。まとめて入れるときは「空欄を0にする」を押してください。</p>' : ''}
      <ul class="mt-2 flex flex-wrap gap-x-3 gap-y-1">${errs.map(x => `<li><a href="#" class="underline" data-action="reportErrJump" data-target="${esc(x.el.id)}">${esc(x.label ? x.label + 'の内容' : x.el.dataset.label || '')}</a></li>`).join('')}</ul>
      ${nums ? '<button type="button" class="btn btn-outline bg-white mt-3 text-sm" data-action="reportFillZero">空欄を0にする</button>' : ''}`
    box.scrollIntoView({ block: 'start', behavior: 'smooth' })
    box.focus({ preventScroll: true })
  }
  return true
}
// 欄の下のエラーの文の場所（数の欄は −／＋ の行の下、文の欄は残りの文字数の下）
function reportFieldErrorEl(el) {
  const wrap = el.closest('div.flex') && el.classList.contains('rpt-num') ? el.closest('div.flex').parentElement : el.parentElement
  return wrap ? wrap.querySelector('.rpt-err') : null
}
function reportFieldClearError(el) {
  el.classList.remove('rpt-invalid', 'ring-2', 'ring-red-400', 'border-red-400')
  el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby')
  const msg = reportFieldErrorEl(el)
  if (msg) { msg.textContent = ''; msg.classList.add('hidden') }
}
delegate('reportErrJump', (el, ev) => {
  if (ev) ev.preventDefault()
  const t = document.getElementById(el.dataset.target)
  if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.focus({ preventScroll: true }) }
})

// 入力欄の動き: 複数行の欄は入力に合わせて高さを伸ばし、残りの文字数を出す。インシデント・クレームの印で内容の欄を出し入れする。
// 非表示の欄（インシデントの内容など）は高さを測れないので、表示したときに測る
function reportFormBind(form) {
  const grow = (el) => { if (!el.offsetParent) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight + 2, 480) + 'px' }
  form.querySelectorAll('.rpt-autogrow').forEach(el => {
    if (el.value) grow(el)
    el.addEventListener('input', () => {
      grow(el)
      const c = el.nextElementSibling
      if (c && c.hasAttribute('data-counter')) c.textContent = `残り ${Number(c.dataset.max) - el.value.length} 文字`
    })
  })
  form.addEventListener('input', (ev) => { const t = ev.target; if (t && t.classList && t.classList.contains('rpt-invalid') && String(t.value).trim() !== '') reportFieldClearError(t) })
  form.querySelectorAll('.rpt-flag').forEach(el => el.addEventListener('change', () => {
    const box = form.querySelector('#' + el.dataset.kind + '-note-box')
    if (!box) return
    box.classList.toggle('hidden', !el.checked)
    if (el.checked) { const note = form.querySelector('#' + el.dataset.kind + '-note'); grow(note); note.focus() }
  }))
}

// 実績件数の空欄を0で埋める（0件をまとめて入力する）
delegate('reportFillZero', (el) => {
  const form = el.closest('form'); if (!form) return
  form.querySelectorAll('.rpt-num').forEach(x => { if (x.value.trim() === '') x.value = '0'; if (x.classList.contains('rpt-invalid')) reportFieldClearError(x) })
  const box = form.querySelector('#report-errors')
  if (box && !form.querySelector('.rpt-invalid')) { box.className = 'hidden'; box.innerHTML = '' }
  form.dispatchEvent(new Event('input'))
})
// 稼働中のカウント（#279）。−／＋ で1件ずつ増減し、入力のイベントで下書き（端末）に保存する
delegate('reportCount', (el) => {
  const inp = el.parentElement && el.parentElement.querySelector('.rpt-num')
  if (!inp) return
  const v = Math.min(99999, Math.max(0, (Math.floor(Number(inp.value)) || 0) + Number(el.dataset.step || 0)))
  inp.value = String(v)
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})
