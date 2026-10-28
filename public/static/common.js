// Field OS 画面共通の部品（すべてのレイアウトの head で、各画面の js より先に読み込む）
//
// 値を HTML に埋め込むときの決まり:
// - 本文・属性値に入れる値は必ず esc() を通す（属性値はダブルクォートで囲む）
// - onclick="fn('${値}')" のように、値を JS の文字列に埋め込まない。
//   ブラウザは属性値の &#39; や &quot; を元の文字に戻してから JS として実行するため、esc しても文字列を抜け出せる。
//   値は data-* 属性（esc 済み）に入れ、data-action と delegate() で処理を結び付け、処理側で el.dataset から読む。
//   onclick に埋め込んでよいのは、数値の ID と、コードに書いた固定の文字列だけ。

// HTML の実体参照に変換する（& < > " ' `）
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"'`]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[m]))
}

// 属性値用。esc に加えて改行・タブも実体参照にする（data-* に複数行の値を入れても崩れないように）
function escAttr(s) {
  return esc(s).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;')
}

// data-action="名前" を付けた要素がクリックされたら、delegate(名前, fn) で登録した fn(el, event) を呼ぶ。
// 例: `<button data-action="deleteDocument" data-id="${d.document_id}" data-name="${esc(d.original_file_name)}">`
//     delegate('deleteDocument', el => deleteDocument(Number(el.dataset.id), el.dataset.name))
function delegate(action, fn) { delegate.handlers[action] = fn }
delegate.handlers = {}
document.addEventListener('click', (ev) => {
  const el = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null
  if (!el || el.disabled) return
  const fn = delegate.handlers[el.getAttribute('data-action')]
  if (fn) fn(el, ev)
})

// 処理中はボタンを無効にして二重送信を防ぐ。処理が終わったら元に戻す（例外は呼び出し元へそのまま投げる）
async function withSubmitLock(button, fn) {
  if (button && button.dataset.busy === '1') return
  const wasDisabled = button ? button.disabled : false
  if (button) { button.dataset.busy = '1'; button.disabled = true }
  try {
    return await fn()
  } finally {
    if (button) { delete button.dataset.busy; button.disabled = wasDisabled }
  }
}

// モーダルの閉じ方（#9422）。入力欄のあるモーダルは、背景のタップ（入力欄から背景へのドラッグも含む）では閉じず、
// 右上の ✕ と「キャンセル」でだけ閉じる（入力が消えないように）。入力欄のない確認・表示だけのモーダルは、今までどおり背景のタップでも閉じる。
// 各画面の modal()（背景に onclick="…closeModal()" を付ける作り）はそのままで、ここで全画面分をまとめて扱う。Esc で閉じるモーダルはない
const MODAL_INPUT_SEL = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([readonly]):not([disabled]), select:not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable=""], [contenteditable="true"]'
function modalHasInputs(bg) {
  const box = bg.querySelector('.modal-box')
  return !!(box && box.querySelector(MODAL_INPUT_SEL))
}
// 背景のタップで閉じる作りのモーダル（背景に onclick がある）だけを対象にする。ログインし直しなど、もともと背景で閉じないものは触らない
const modalClosesOnBackdrop = (bg) => typeof bg.onclick === 'function'
// 背景のクリックは、各画面の onclick より先に（キャプチャで）受けて止める
document.addEventListener('click', (ev) => {
  const bg = ev.target
  if (!bg || !bg.classList || !bg.classList.contains('modal-bg') || !modalClosesOnBackdrop(bg) || !modalHasInputs(bg)) return
  ev.stopImmediatePropagation()
  ev.preventDefault()
  const x = bg.querySelector('.modal-x')
  if (x && x.animate) x.animate([{ scale: '1' }, { scale: '1.35' }, { scale: '1' }], { duration: 400 })
  // 閉じない理由は、モーダルごとに1回だけ伝える
  if (!bg.dataset.backdropNoted) {
    bg.dataset.backdropNoted = '1'
    // 「キャンセル」のボタンが無いモーダル（スタッフの登録など）では ✕ だけを案内する
    const hasCancel = [...bg.querySelectorAll('button')].some(b => b.textContent.trim() === 'キャンセル')
    if (typeof toast === 'function') toast(hasCancel ? '入力中の内容を閉じるときは、右上の ✕ か「キャンセル」を押してください' : '入力中の内容を閉じるときは、右上の ✕ を押してください')
  }
}, true)
// 入力欄のあるモーダルに、閉じるボタン（✕）が無ければ右上に足す（スクロールしても右上に残る）
const MODAL_X_SEL = '.modal-x, [onclick*="closeModal"] .fa-xmark, [onclick*="closeModal"] .fa-times, [data-modal-close]'
function addModalCloseButtons() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    const box = bg.querySelector('.modal-box')
    if (!box || box.querySelector(MODAL_X_SEL) || !modalClosesOnBackdrop(bg) || !modalHasInputs(bg)) return
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'modal-x text-gray-400 hover:text-gray-600'
    b.dataset.action = 'modalX'
    b.setAttribute('aria-label', '閉じる'); b.title = '閉じる'
    b.style.cssText = 'position:sticky;top:0;float:right;z-index:1;width:2rem;height:2rem;margin:-.75rem -.75rem .25rem .5rem;border-radius:9999px;background:rgba(255,255,255,.9);font-size:1.1rem;line-height:2rem;text-align:center'
    b.innerHTML = '<i class="fas fa-xmark"></i>'
    box.insertBefore(b, box.firstChild)
  })
}
delegate('modalX', (el) => {
  const bg = el.closest('.modal-bg')
  if (!bg) return
  // #modal-root のモーダルは各画面の closeModal で閉じる（閉じたときの後片付けがあるため）。それ以外は背景ごと外す
  if (bg.closest('#modal-root') && typeof window.closeModal === 'function') window.closeModal()
  else bg.remove()
})
let modalScanQueued = false
new MutationObserver(() => {
  if (modalScanQueued) return
  modalScanQueued = true
  queueMicrotask(() => { modalScanQueued = false; addModalCloseButtons() })
}).observe(document.documentElement, { childList: true, subtree: true })

// API のエラー文言（無ければ fallback）を toast で出す。toast の無い画面では alert で出す
function showApiError(e, fallback) {
  const msg = (e && e.response && e.response.data && e.response.data.error) || fallback || 'エラーが発生しました'
  if (typeof toast === 'function') toast(msg)
  else alert(msg)
  return msg
}

// シフトの時刻の表示（#415 #547）。終了が開始以前のシフト（22:00〜06:00 など。日をまたぐ勤務）は、終了に『翌』を付ける。
// sep は区切り（既定は『〜』）。戻り値はエスケープしていないので、HTML に入れるときは esc() を通す
function formatShiftTime(start, end, sep) {
  const s = String(start || '').slice(0, 5), e = String(end || '').slice(0, 5)
  const min = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
  const next = min(s) != null && min(e) != null && min(e) <= min(s)
  return `${s}${sep == null ? '〜' : sep}${next ? '翌' : ''}${e}`
}

// 報告の日時（'YYYY-MM-DD HH:MM[:SS]'）の表示。稼働日と同じ日なら時刻だけ、違う日（日をまたいだ後の報告）なら『10/16 01:30』（#547）
function formatReportedTime(at, workDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(String(at || ''))
  if (!m) return ''
  return `${m[1]}-${m[2]}-${m[3]}` === String(workDate || '').slice(0, 10) ? m[4] : `${Number(m[2])}/${Number(m[3])} ${m[4]}`
}
