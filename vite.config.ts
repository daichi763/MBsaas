import build from '@hono/vite-build/cloudflare-workers'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    // Workers 用: fetch 以外の処理（scheduled = 毎日の cron）もビルド結果に含める。出力先はこれまでどおり dist/_worker.js
    build({ output: '_worker.js' }),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ]
})
