// ハッシュ・乱数の共通関数（#9955）
const enc = new TextEncoder()

/** バイト列を小文字の16進の文字列にする */
export function toHex(u8: Uint8Array): string {
  return [...u8].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** SHA-256 の16進（小文字64文字） */
export async function sha256(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))))
}
/** bytes バイトの乱数の16進（長さは bytes × 2 文字） */
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a); return toHex(a)
}
/** バイト列を base64url（URL に使える形。末尾の = は付けない）にする */
export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** bytes バイトの乱数の base64url（URL に入れるトークン） */
export function randomB64url(bytes: number): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a); return b64url(a)
}
