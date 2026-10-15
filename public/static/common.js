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

// API のエラー文言（無ければ fallback）を toast で出す。toast の無い画面では alert で出す
function showApiError(e, fallback) {
  const msg = (e && e.response && e.response.data && e.response.data.error) || fallback || 'エラーが発生しました'
  if (typeof toast === 'function') toast(msg)
  else alert(msg)
  return msg
}
