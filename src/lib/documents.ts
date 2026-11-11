// =========================================================
// 書類のアップロード・ダウンロード・削除（#9956。スタッフの書類・従業員の書類・クライアントの契約書・お知らせの添付で共用）
//   アップロードの流れ: 送信データ → 1ファイルずつ確認（形式・大きさ・中身）→ R2 に保存 → D1 に登録 → 登録できなければ R2 から消す
//   形式・大きさの条件はここ（DOC_UPLOAD_RULES・NOTICE_ATTACH_RULES）だけに書く。直すときに一部の画面だけ通る、ということが無いように
// =========================================================
import type { Context } from 'hono'
import { cleanFileName } from './validate'

// 書類（スタッフの書類・従業員の書類・クライアントの契約書）の形式と上限
export const DOC_ALLOWED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'odt', 'ods', 'odp', 'jpg', 'jpeg', 'png', 'gif', 'webp']
export const DOC_MAX_BYTES = 20 * 1024 * 1024 // 20MB
export const DOC_MIME_MAP: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  txt: ['text/plain'],
  odt: ['application/vnd.oasis.opendocument.text'],
  ods: ['application/vnd.oasis.opendocument.spreadsheet'],
  odp: ['application/vnd.oasis.opendocument.presentation'],
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
  png: ['image/png'],
  gif: ['image/gif'],
  webp: ['image/webp'],
}

// お知らせの添付（#555）: 画像・PDF だけ。拡張子で種類を決め、保存・返すときの Content-Type はここから取る（送られた type は使わない）
export const NOTICE_ATTACH_MAX_BYTES = 10 * 1024 * 1024
export const NOTICE_ATTACH_TYPES: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
// 先頭のバイトが拡張子の形式と合うか（画像・PDF に見せかけた HTML などを、そのまま表示する形で返さないように）
export function noticeAttachmentMagicOk(ext: string, b: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)
  switch (ext) {
    case 'pdf': return starts([0x25, 0x50, 0x44, 0x46]) // %PDF
    case 'jpg': case 'jpeg': return starts([0xff, 0xd8, 0xff])
    case 'png': return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'gif': return starts([0x47, 0x49, 0x46, 0x38]) // GIF8
    case 'webp': return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8) // RIFF....WEBP
  }
  return false
}

export function docExt(filename: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filename)
  return m ? m[1].toLowerCase() : ''
}
// R2キーの一部に使うため危険な記号だけ置換する（元のファイル名はDB側にそのまま保持）
export function sanitizeForKey(filename: string): string {
  return filename.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 150)
}

export type UploadResult = { filename: string; ok: boolean; document_id?: number; attachment_id?: number; error?: string }
// R2 に置いたファイル（D1 に登録する値）
export type StoredFile = { key: string; fileName: string; contentType: string; size: number }
type Checked = { error: string } | { contentType: string; body?: ArrayBuffer }
export type UploadRules = {
  // 1ファイルを確かめる。だめなら error、良ければ保存する Content-Type（中身を読んだときはその中身も）
  check(file: File, ext: string): Promise<Checked>
  idField: 'document_id' | 'attachment_id' // 応答で ID を入れる名前
  messages: { put: string; insert: string } // R2 に置けなかった・D1 に登録できなかったときの文言
}

export const DOC_UPLOAD_RULES: UploadRules = {
  idField: 'document_id',
  messages: { put: 'ファイルのアップロードに失敗しました。', insert: 'ファイルの登録に失敗しました。' },
  async check(file, ext) {
    if (!DOC_ALLOWED_EXT.includes(ext)) return { error: 'このファイル形式には対応していません。' }
    if (file.size > DOC_MAX_BYTES) return { error: 'ファイルサイズは20MB以下にしてください。' }
    // MIME Typeは端末・ブラウザ差で信頼性が低いため、拡張子を主判定としつつ
    // 明確に一致しない場合のみ弾く補助チェックとする（空/octet-streamは許容）
    const acceptableMimes = DOC_MIME_MAP[ext] || []
    if (file.type && file.type !== 'application/octet-stream' && acceptableMimes.length && !acceptableMimes.includes(file.type)) {
      return { error: 'このファイル形式には対応していません。' }
    }
    return { contentType: file.type || 'application/octet-stream' }
  },
}

export const NOTICE_ATTACH_RULES: UploadRules = {
  idField: 'attachment_id',
  messages: { put: 'ファイルのアップロードに失敗しました', insert: 'ファイルの登録に失敗しました' },
  async check(file, ext) {
    const type = NOTICE_ATTACH_TYPES[ext]
    if (!type) return { error: 'PDF か画像（JPEG・PNG・GIF・WebP）を選んでください' }
    if (!file.size) return { error: '空のファイルです' }
    if (file.size > NOTICE_ATTACH_MAX_BYTES) return { error: '1つ10MB以下にしてください' }
    const body = await file.arrayBuffer()
    if (!noticeAttachmentMagicOk(ext, new Uint8Array(body, 0, Math.min(16, body.byteLength)))) return { error: 'ファイルの中身が拡張子の形式と合いません' }
    return { contentType: type, body }
  },
}

/**
 * 送られたファイル（files）を1つずつ確かめ、R2 に置いて D1 に登録する。成功した分だけ残す。
 * 戻り値はファイルごとの結果。送信データの形が不正・ファイルが無い・parse がエラーを返したときは 400 の応答を返す。
 * - キーは `${keyPrefix}/${UUID}/${ファイル名}`（同名のファイルでも上書きされないように）
 * - insert の changes が 0 なら登録しなかった扱いにして R2 から消し、limitError の文言を返す（お知らせの添付の件数の上限）
 */
export async function storeUploads<M = undefined>(c: Context<any>, opts: {
  bucket: R2Bucket
  keyPrefix: string
  rules: UploadRules
  parse?: (form: FormData) => M | { error: string } // ファイル以外の項目（書類の種類・期限など）
  insert: (f: StoredFile, meta: M) => D1PreparedStatement
  limitError?: string
}): Promise<Response | UploadResult[]> {
  let form: FormData
  try { form = await c.req.formData() } catch { return c.json({ error: '送信データの形式が不正です' }, 400) }
  const files = form.getAll('files').filter(f => f instanceof File) as File[]
  if (files.length === 0) return c.json({ error: 'ファイルが選択されていません' }, 400)
  const meta = opts.parse ? opts.parse(form) : undefined
  if (meta && typeof meta === 'object' && 'error' in meta) return c.json({ error: (meta as { error: string }).error }, 400)

  const { rules } = opts
  const results: UploadResult[] = []
  for (const file of files) {
    const checked = await rules.check(file, docExt(file.name))
    if ('error' in checked) { results.push({ filename: file.name, ok: false, error: checked.error }); continue }
    const key = `${opts.keyPrefix}/${crypto.randomUUID()}/${sanitizeForKey(file.name)}`
    try {
      const body = checked.body ?? await file.arrayBuffer()
      await opts.bucket.put(key, body, { httpMetadata: { contentType: checked.contentType } })
    } catch {
      results.push({ filename: file.name, ok: false, error: rules.messages.put }); continue
    }
    try {
      const r = await opts.insert({ key, fileName: cleanFileName(file.name), contentType: checked.contentType, size: file.size }, meta as M).run()
      if (!r.meta.changes) {
        await opts.bucket.delete(key).catch(() => {})
        results.push({ filename: file.name, ok: false, error: opts.limitError || rules.messages.insert }); continue
      }
      results.push({ filename: file.name, ok: true, [rules.idField]: Number(r.meta.last_row_id) })
    } catch {
      // D1登録に失敗した場合はアップロード済みのR2オブジェクトを掃除する
      await opts.bucket.delete(key).catch(() => {})
      results.push({ filename: file.name, ok: false, error: rules.messages.insert })
    }
  }
  return results
}

// 書類の表（同じ列の形: document_id・company_id・original_file_name・storage_key・mime_type・file_size・uploaded_by・doc_type・valid_until など）
export type DocumentTable = 'staff_documents' | 'employee_documents' | 'client_documents'

/**
 * 書類のアップロード（スタッフの書類・従業員の書類・クライアントの契約書）。応答は { results }。
 * columns: ファイル以外に入れる列（company_id・持ち主の ID・uploaded_by・doc_type・valid_until）。列名はコードで決めた値だけを渡す
 */
export async function uploadDocuments<M>(c: Context<any>, opts: {
  bucket: R2Bucket
  table: DocumentTable
  keyPrefix: string
  parse: (form: FormData) => M | { error: string }
  columns: (meta: M) => Record<string, unknown>
}): Promise<Response> {
  const db: D1Database = c.env.DB
  const out = await storeUploads<M>(c, {
    bucket: opts.bucket, keyPrefix: opts.keyPrefix, rules: DOC_UPLOAD_RULES, parse: opts.parse,
    insert: (f, meta) => {
      const cols: Record<string, unknown> = { ...opts.columns(meta), original_file_name: f.fileName, storage_key: f.key, mime_type: f.contentType, file_size: f.size }
      const names = Object.keys(cols)
      return db.prepare(`INSERT INTO ${opts.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...Object.values(cols))
    },
  })
  return out instanceof Response ? out : c.json({ results: out })
}

// ダウンロード（元ファイル名・元Content-Typeで返す。実行される事故を避けるため常にattachment指定）
export async function downloadDocument(c: Context<any>, opts: { bucket: R2Bucket; table: DocumentTable; docId: string; companyId: number }): Promise<Response> {
  const doc = await (c.env.DB as D1Database).prepare(`SELECT * FROM ${opts.table} WHERE document_id = ? AND company_id = ?`).bind(opts.docId, opts.companyId).first()
  if (!doc) return c.json({ error: 'ファイルを取得できませんでした' }, 404)
  const obj = await opts.bucket.get(doc.storage_key as string)
  if (!obj) return c.json({ error: 'ファイルを取得できませんでした' }, 404)
  const filename = (doc.original_file_name as string).replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(doc.original_file_name as string)
  return c.body(obj.body, 200, {
    'Content-Type': (doc.mime_type as string) || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0',
  })
}

// 削除（D1を先に消し、R2はベストエフォート。孤立するならR2側の残骸の方が実害が小さいため）
export async function deleteDocument(c: Context<any>, opts: { bucket: R2Bucket; table: DocumentTable; docId: string; companyId: number }): Promise<Response> {
  const db: D1Database = c.env.DB
  const doc = await db.prepare(`SELECT * FROM ${opts.table} WHERE document_id = ? AND company_id = ?`).bind(opts.docId, opts.companyId).first()
  if (!doc) return c.json({ error: 'ファイルの削除に失敗しました' }, 404)
  try {
    await db.prepare(`DELETE FROM ${opts.table} WHERE document_id = ?`).bind(opts.docId).run()
  } catch {
    return c.json({ error: 'ファイルの削除に失敗しました' }, 500)
  }
  await opts.bucket.delete(doc.storage_key as string).catch(() => {})
  return c.json({ ok: true })
}
