// Workers Builds（git 連携のデプロイ）用の設定ファイルを作る。
// wrangler.jsonc のトップレベルはローカル開発用（メール停止・デモ表示など）で、本番の設定は env.production にある。
// Workers Builds のデプロイは `npx wrangler deploy` / `npx wrangler versions upload`（--env なし）なので、
// そのままだとローカル用の設定で本番に出てしまう。CI のときだけ、トップレベルを env.production の値で置き換えた
// wrangler.json を作る（wrangler は wrangler.json を wrangler.jsonc より先に読む）。--env production でも同じ設定になる。
// CI なのに本番の設定の wrangler.json を作れなかった・中身が本番の値でないときは、ビルドを止める（exit 1。#9944）。
import fs from 'fs'

if (!isCi(process.env)) {
  // CI でないのに残っていると、wrangler dev が本番の vars（DEMO_MODE=false など）を読む（ローカルの D1 のままでも動きが変わる）
  if (fs.existsSync('wrangler.json')) console.warn('注意: wrangler.json（本番の設定）が残っています。wrangler dev が本番の設定を読むので、ローカルで動かすときは消してください')
  process.exit(0)
}

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

try {
  const conf = JSON.parse(stripJsonc(fs.readFileSync('wrangler.jsonc', 'utf8')))
  const prod = conf.env && conf.env.production
  if (!prod || !prod.vars) throw new Error('wrangler.jsonc に env.production（vars を含む）がありません')
  const out = { ...conf, ...prod, env: { production: prod } }
  // プレビューの URL は本番の D1・R2 につながるので出さない（D-49）。設定が落ちていたらデプロイを止める
  if (out.preview_urls !== false) throw new Error('wrangler.jsonc の preview_urls が false ではありません（トップレベルと env.production の両方に false を書く）')
  checkProduction(conf, out)
  fs.writeFileSync('wrangler.json', JSON.stringify(out, null, 2) + '\n')
  // 書いたファイルを読み直して、wrangler が読む中身が本番の値であることを確かめる
  checkProduction(conf, JSON.parse(fs.readFileSync('wrangler.json', 'utf8')))
  console.log(`wrangler.json を本番の設定で作成しました（APP_BASE_URL=${prod.vars.APP_BASE_URL}, DEMO_MODE=${prod.vars.DEMO_MODE}）`)
} catch (e) {
  // 途中まで作ったファイルでデプロイされないよう消す
  try { fs.rmSync('wrangler.json', { force: true }) } catch { }
  console.error(`エラー: CI のビルドで本番の設定（wrangler.json）を作れませんでした。ビルドを止めます（scripts/ci-wrangler-config.mjs）: ${e && e.message ? e.message : e}`)
  process.exit(1)
}

// CI（GitHub Actions・Workers Builds など）か。CI=true・CI=1、WORKERS_CI=1、Workers Builds の WORKERS_CI_* のどれかがあれば CI とみなす
function isCi(env) {
  const on = (v) => v !== undefined && v !== '' && !/^(0|false|no)$/i.test(String(v).trim())
  return on(env.CI) || on(env.WORKERS_CI) || Object.keys(env).some(k => k.startsWith('WORKERS_CI_') && env[k])
}

// 本番の設定として使ってよいか。ローカル用の値のまま本番に出ないよう、docs/operations.md の 3.2 の 7 の表の値と比べる。
// 本番の値を意図して変えるときは、ここと operations.md の表を一緒に直す
function checkProduction(conf, out) {
  const errs = []
  const vars = out.vars || {}
  if (out.name !== conf.name) errs.push(`name が ${JSON.stringify(out.name)}（${JSON.stringify(conf.name)} にする）`)
  // vars は環境ごとに引き継がれないので、ローカル用にある名前は本番にもいる
  for (const k of Object.keys(conf.vars || {})) if (!(k in vars)) errs.push(`vars.${k} が env.production にない`)
  const expect = { DEMO_MODE: 'false', MAIL_ENABLED: 'true', RETENTION_ENABLED: 'true' }
  for (const [k, v] of Object.entries(expect)) if (vars[k] !== v) errs.push(`vars.${k} が ${JSON.stringify(vars[k])}（本番は "${v}"）`)
  let host = ''
  try { const u = new URL(String(vars.APP_BASE_URL || '')); host = u.protocol === 'https:' ? u.hostname : '' } catch { }
  if (!host || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host)) errs.push(`vars.APP_BASE_URL が ${JSON.stringify(vars.APP_BASE_URL)}（本番の https の URL にする）`)
  // D1・R2・定期処理も環境ごとに引き継がれない
  const bindings = (list) => (Array.isArray(list) ? list : []).map(b => b && b.binding).filter(Boolean)
  for (const key of ['d1_databases', 'r2_buckets']) {
    const have = bindings(out[key])
    for (const b of bindings(conf[key])) if (!have.includes(b)) errs.push(`${key} の ${b} が env.production にない`)
  }
  if (!out.triggers || !Array.isArray(out.triggers.crons) || !out.triggers.crons.length) errs.push('triggers.crons が env.production にない（定期処理が止まる）')
  if (!out.observability || out.observability.enabled !== true) errs.push('observability.enabled が true ではない（Workers Logs が残らない）')
  if (errs.length) throw new Error('本番の設定ではありません: ' + errs.join(' / '))
}
