import build from '@hono/vite-build/cloudflare-workers'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'
// このリポジトリは Node の型（@types/node）を入れていないので、ビルドの設定で使う所だけ型の確認を外す
// @ts-ignore
import { execSync } from 'node:child_process'
declare const process: { env: Record<string, string | undefined> }

// 版の短い ID（/api/health で返す。#9973）。Workers Builds・GitHub Actions ではコミットの環境変数、手元では git のコミット、どちらもなければ dev
function appVersion(): string {
  const ci = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || ''
  if (/^[0-9a-f]{7,40}$/i.test(ci)) return ci.slice(0, 8).toLowerCase()
  try {
    const sha = execSync('git rev-parse --short=8 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.toLowerCase()
  } catch { }
  return 'dev'
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [
    // Workers 用: fetch 以外の処理（scheduled = 毎日の cron）もビルド結果に含める。出力先はこれまでどおり dist/_worker.js
    build({ output: '_worker.js' }),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ]
})
