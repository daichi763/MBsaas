// pm2 で開発サーバーを常駐させる設定（任意。ふだんは npm run dev か npx wrangler dev で足りる）。
// Workers の構成（wrangler.jsonc の main = dist/_worker.js）なので、先に npm run build を実行してから起動する:
//   npm run build && pm2 start ecosystem.config.cjs
// D1・R2 は wrangler.jsonc の設定をそのまま使い、ローカル（.wrangler/state）に保存する。本番には接続しない。
module.exports = {
  apps: [
    {
      name: 'mbsaas-dev',
      script: 'npx',
      args: 'wrangler dev --local --ip 0.0.0.0 --port 3000',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
