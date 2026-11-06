// 管理画面からのメールアドレスの変更（w17-masters: #9803）を、メールを送れる環境で確かめる（npm test 用）
//   サーバーは次の変数を付けて起動する（run-tests.mjs がこの行を読む）:
//   --var MAIL_ENABLED:true --var RESEND_API_KEY:re_dummy_w17
//   中身は test-w17-masters.mjs と同じ（サーバーの動きが verify になるので、確認用のメールの流れの側を確かめる）。
//   実際の送信を避けるため、宛先を送らないアドレス（email_suppressions）にする（PERSIST は run-tests.mjs が渡す）
if (!process.env.PERSIST) { console.error('PERSIST（wrangler dev の --persist-to の場所）を渡してください（確認用のメールを実際に送らないため）'); process.exit(1) }
await import('./test-w17-masters.mjs')
