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
