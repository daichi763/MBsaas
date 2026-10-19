// Workers Builds（git 連携のデプロイ）用の設定ファイルを作る。
// wrangler.jsonc のトップレベルはローカル開発用（メール停止・デモ表示など）で、本番の設定は env.production にある。
// Workers Builds のデプロイは `npx wrangler deploy` / `npx wrangler versions upload`（--env なし）なので、
// そのままだとローカル用の設定で本番に出てしまう。CI のときだけ、トップレベルを env.production の値で置き換えた
// wrangler.json を作る（wrangler は wrangler.json を wrangler.jsonc より先に読む）。--env production でも同じ設定になる。
import fs from 'fs'

if (process.env.WORKERS_CI !== '1' && process.env.CI !== 'true') process.exit(0)

// JSONC のコメントと末尾のカンマを取り除く（文字列の中の // などは残す）
function stripJsonc(src) {
  let out = '', inStr = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i], next = src[i + 1]
    if (inStr) {
      out += ch
      if (ch === '\\') { out += next; i++ } else if (ch === '"') inStr = false
    } else if (ch === '"') { inStr = true; out += ch }
    else if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n' }
    else if (ch === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++ }
    else out += ch
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const conf = JSON.parse(stripJsonc(fs.readFileSync('wrangler.jsonc', 'utf8')))
const prod = conf.env && conf.env.production
if (!prod || !prod.vars) throw new Error('wrangler.jsonc に env.production（vars を含む）がありません')
const out = { ...conf, ...prod, env: { production: prod } }
fs.writeFileSync('wrangler.json', JSON.stringify(out, null, 2) + '\n')
console.log(`wrangler.json を本番の設定で作成しました（APP_BASE_URL=${prod.vars.APP_BASE_URL}, DEMO_MODE=${prod.vars.DEMO_MODE}）`)
