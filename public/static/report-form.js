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
    </div>`
  return `
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
                <input type="number" inputmode="numeric" min="0" max="99999" step="1" data-key="${esc(f.key)}" data-label="${esc(f.label)}" class="inp rpt-field rpt-num text-center text-lg font-bold min-w-0 px-1" value="${esc(val(f.key))}" placeholder="未入力">
                <button type="button" class="btn btn-outline px-0 w-10 shrink-0 text-lg" data-action="reportCount" data-step="1" aria-label="${esc(f.label)}を1増やす">＋</button>
              </div>
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
            </div>`
          }).join('')}
        </div>
      </section>` : ''}
      <section class="card p-4">
        ${flagBox('incident', 'インシデント', o.incident)}
        ${flagBox('complaint', 'クレーム', o.complaint)}
      </section>
      <button type="submit" id="report-submit" class="btn btn-primary w-full py-3.5 text-base" ${o.submitDisabled ? 'disabled' : ''}>${esc(o.submitLabel || '日報を提出する')}</button>`
}

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
  form.querySelectorAll('.rpt-num').forEach(x => { if (x.value.trim() === '') x.value = '0' })
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
