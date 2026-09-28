# Field OS — 通信人材会社向け 運営標準化SaaS（動作モックアップ v0.1）

## プロジェクト概要
- **名称**: Field OS（ディセクテラ株式会社 想定サービスのモックアップ）
- **目的**: 通信系人材会社（携帯ショップ・家電量販店・催事・光回線などへの派遣/請負）の日次運営を標準化するSaaS。勤怠・日報・実績・シフト・フォロー・請求前チェックまでを1つに統合。
- **フェーズ**: Phase 1 動作モックアップ（仕様書 §25 準拠）。サンプルデータ入りで全画面が動作します。

## URL
- **開発プレビュー（sandbox）**: https://3000-iuu45cp1y072lqbwcd8ow-b32ec7bb.sandbox.novita.ai
- **GitHub**: https://github.com/n0101r2000/SaaSDev
- **ログイン**: `/login`（会社コード + ユーザーコード + パスワード）
- **本番デプロイ**: 未実施（Cloudflare Pages へデプロイ可能な構成）

## デモアカウント（パスワードは全て `pass1234`）
| 役割 | 会社コード | ユーザーコード | 画面 |
|---|---|---|---|
| スタッフ | `sample` | `st001` 〜 `st020` | `/staff`（モバイル向け） |
| 会社管理者（代表） | `sample` | `admin` | `/admin`（PC向け） |
| 現場マネージャー | `sample` | `mgr01` | `/admin` |
| 営業マネージャー | `sample` | `sales01` | `/admin` |
| SaaS運営本部 | `hq` | `hq` | `/hq`（運営本部・ダーク） |

## 実装済み機能

### スタッフ画面（モバイルファースト `/staff`）
- ホーム: 本日のシフト・勤怠報告状況・未読お知らせ・相談返信通知
- 勤怠報告: 起床 → 出発 → 入店（位置情報取得・写真必須）→ 退店（写真必須） の順序制フロー、遅刻自動判定
  - 入店/退店報告は写真1枚が必須。カメラ起動 / アルバム選択に対応し、ブラウザ側で JPEG・画質70%・長辺1600px・500KB以下に圧縮（Exif自動除去）してから Cloudflare R2 へアップロード
- 日報入力: 案件ごとのテンプレートから動的フォーム生成（MNP/PI/新規/機種変/光 等の数値 + 所感）、トラブル/クレームフラグ
- シフト確認・希望提出、お知らせ（既読管理・重要マーク）、自分の実績（月次集計+日別）、相談窓口（カテゴリ・緊急度・返信履歴）

### 管理画面（PC向け `/admin`）
- ダッシュボード: 本日の稼働/売上見込みKPI、未報告アラート（起床/入店/日報）、**ルールベース管理者ToDo**（日報未提出3日以上・遅刻頻発・欠勤頻発・トラブル連続・未対応相談）、直近トラブル、要フォロー一覧、案件別実績、本日シフト（欠勤処理）
- スタッフ: 一覧（フォロー/離職リスク/未報告/低評価フィルタ）、詳細（評価レーダーチャート・月次実績・フォロー履歴・日報/勤怠履歴）、**スキルシート自動生成**（印刷対応）
- 案件・クライアント管理（CRUD）、シフト管理（週間グリッド・確定/欠勤/代打）
- 日報管理（確認チェック・コメント返信）、実績分析（日別積上げグラフ・スタッフランキング・案件/クライアント別）
- お知らせ配信（全体/案件別・既読状況確認）、フォローログ、相談対応、**請求前チェック**（案件別集計・スタッフ別明細・CSV出力）

### SaaS運営本部画面（`/hq`）
- 導入企業一覧（MRR・アクティブ率・日報数・成熟度）、企業詳細（プラン/状態/成熟度/支援メモ編集）
- 日報テンプレート配布（携帯ショップ/家電量販店/催事/光回線 標準テンプレ）、伴走支援管理

## データアーキテクチャ
- **ストレージ**: Cloudflare D1（SQLite、ローカルは `--local` モード）+ Cloudflare R2（入店/退店報告の写真、非公開バケット）
- **テーブル（15）**: companies / users / sessions / staff_profiles / clients / report_templates / projects / shifts / attendance_reports / daily_reports / evaluations / follow_logs / notices / notice_reads / consultations
  - `attendance_reports.photo_key`: R2オブジェクトキー（画像バイナリ自体はDBに保存しない。マイグレーション `0002_add_attendance_photo.sql`）
- **マルチテナント**: 全テーブルに `company_id`、ログインは 会社コード+ユーザーコード+パスワード
- **認証**: SHA-256 ハッシュ + httpOnly Cookie セッション（30日）、ロール別ミドルウェア（/api/admin/*, /api/hq/*）
- **日報**: テンプレート定義（fields_json）→ 回答は JSON 保存 → `json_extract` で集計

## サンプルデータ
- 株式会社サンプルモバイル人材: スタッフ20名 / クライアント3社 / 案件5件 / シフト231件 / 勤怠594件 / 日報137件
- デモ状態: 未報告スタッフ（田中彩香=高リスク、小林竜也=起床のみ・遅刻頻発、井上結衣=欠勤2回）、トラブル報告、未対応相談 など
- **日付追随**: `node scripts/gen_seed.cjs` で seed.sql を当日基準に再生成可能 → `npm run db:reset` 相当で再投入

## 開発・運用コマンド
```bash
npm run build                                            # ビルド
pm2 start ecosystem.config.cjs                           # 開発サーバ起動（port 3000）
npx wrangler d1 migrations apply webapp-production --local   # マイグレーション
node scripts/gen_seed.cjs                                # seed再生成（日付追随）
npx wrangler d1 execute webapp-production --local --file=./seed.sql  # seed投入
```

## 入店/退店報告 写真添付機能 セットアップ

### 1. R2バケット作成（初回のみ・要手動実行）
```bash
npx wrangler r2 bucket create saasdev-attendance-photos
```
- バケットは**非公開**のまま作成してください（`--jurisdiction` 等の公開設定は行わない）。画像は必ず `/api/staff/attendance-photo/*` のログイン認証付きエンドポイント経由でのみ配信されます。
- ローカル開発（`npm run dev` / `wrangler dev`）では miniflare が R2 をローカルエミュレートするため、追加設定なしで動作します。

### 2. wrangler.jsonc（設定済み）
```jsonc
"r2_buckets": [
  { "binding": "PHOTOS", "bucket_name": "saasdev-attendance-photos" }
]
```

### 3. マイグレーション適用
```bash
npx wrangler d1 migrations apply webapp-production --local   # ローカル
npx wrangler d1 migrations apply webapp-production           # 本番
```

### 4. 型定義の再生成（R2バインディングを追加したため）
```bash
npm run cf-typegen
```

### 環境変数
新規の環境変数（`.dev.vars` 等）は不要です。R2アクセスはバインディング経由（`c.env.PHOTOS`）で行うため、アクセスキー等のシークレットは発生しません。

### 追加APIエンドポイント
| Method | Path | 概要 |
|---|---|---|
| POST | `/api/staff/attendance-photo` | 入店/退店報告を写真(multipart/form-data)付きで登録。`shift_id` / `report_type`(`check_in`\|`check_out`) / `photo`(必須) / `latitude` / `longitude`(任意, check_inのみ) |
| GET | `/api/staff/attendance-photo/*` | R2に保存された写真の取得（ログイン中ユーザーと同一 `company_id` のみ閲覧可、署名付きレスポンスではなくWorker経由のプライベート配信） |

既存の `/api/staff/attendance`（起床・出発報告）は無変更です。

### 変更ファイル一覧
- `migrations/0002_add_attendance_photo.sql`（新規）: `attendance_reports.photo_key` 列追加
- `wrangler.jsonc`: R2バケットバインディング追加
- `src/api.ts`: `PHOTOS: R2Bucket` バインディング型追加、`/staff/attendance-photo`（POST/GET）追加
- `src/index.tsx`: スタッフ画面に `#modal-root` コンテナ追加（写真添付モーダル表示用）
- `public/static/staff.js`: 入店/退店報告ボタンの分岐、写真選択・圧縮（canvas, ライブラリ追加なし）・プレビュー・アップロードUI一式を追加
- `worker-configuration.d.ts`: `wrangler types` 再生成（R2バインディング型を反映）

### 動作確認結果（自己レビュー範囲）
- ✅ `npx tsc --noEmit` : 型エラー 0件
- ✅ `npm run build`（`build:css` + `vite build`）: エラー 0件
- ✅ ESLint: プロジェクトに設定なし（既存踏襲、追加導入は今回のスコープ外）
- ⚠️ Android / iPhone / PC 実機での撮影・アップロード動作、および 100KB/500KB/5MB/10MB 各サイズでの実写真テストは、開発サンドボックス環境の制約上**未実施**です。デプロイ後に実機で以下を確認してください。
  - iPhone Safari: カメラ起動・アルバム選択・HEIC画像の読み込み（`createImageBitmap`のHEICデコード可否）
  - Android Chrome: カメラ起動・アルバム選択（`capture="environment"`の挙動はAndroid機種依存のため要確認）
  - PC: ファイル選択ダイアログでの動作（カメラボタンはPCではファイル選択ダイアログにフォールバックします）

### 残課題
- 管理画面（`/admin`）側でのスタッフ詳細画面に写真サムネイル表示は未追加です（`attendance` データには `photo_key` が既に含まれて返却されるため、表示追加は比較的小さな変更で対応可能です）。
- HEICファイルは端末・ブラウザによっては `createImageBitmap` でのデコードに失敗する場合があり、その際はエラーメッセージを表示してJPEG/PNGでの再選択を促す仕様としています（HEIC→JPEGの確実な変換には専用ライブラリの追加が必要になるため、今回は「不要なライブラリを追加しない」方針を優先しました）。
- R2バケットの実作成（`wrangler r2 bucket create`）はCloudflareアカウントへの操作が必要なため未実施です。上記セットアップ手順に従って作成してください。

## スタッフマスタ / 従業員管理 分離・企業間スタッフ連携（フェーズA〜C）
仕様: `docs/spec_multi_company_staff.md`

- **管理画面の分離**: 「スタッフマスタ」（企業間で共有し得る情報）と「従業員管理」（旧 社員名簿。雇用・給与・口座等、自社のみ）
- **所属区分（affiliation_type）**: `own_employee`（自社雇用）/ `linked_external`（他社連携）/ `partner_manual`（取引先所属）/ `skillsheet_only`（スキルシートのみ）
- **新規作成の4つのルート**（スタッフマスタの「新規追加」ボタン）
  1. QRコード / スタッフIDから連携: 他社の自社雇用スタッフを、恒久固定のスタッフID（`persons.global_staff_code`, 例 `FS1A2B3C4D5E`）で連携。連携のたびに同意確認ポップアップを表示し、同意は `roster_consents` に記録する
  2. 従業員管理から作成: ログインアカウント・スタッフマスタ・従業員管理を同時に作成
  3. 取引先から作成: 取引先マスタ（`staff_affiliations`）から選択するか新規登録。ログインの発行は任意
  4. スキルシートのみ作成: ログインなし。既存のスキルシート生成機能をそのまま利用
- **権限制御**: 他社連携スタッフの基本項目（氏名・スキル等）は所属元企業の値を参照するだけで、稼働先はAPIレベルで編集不可（403）。メモ・評価・フォロー等の追記項目は企業ごとに独立して保持する。従業員管理は `own_employee` かつ所属元が自社のスタッフに限り参照・更新できる
- **ログインを持たない人物**: `users.role = 'roster_only'`（ログイン不可。お知らせ対象・スタッフ数集計の対象外）。既存のシフト・勤怠・評価等は従来どおり `staff_id` で紐付ける
- **API**（`src/roster.ts`。`/api/admin/*` の管理者ロールでのみ利用可）
  - `GET /api/admin/roster/consent-terms` / `GET /api/admin/roster/lookup?code=` / `POST /api/admin/roster/link`
  - `POST /api/admin/roster`（`route`: `employee` / `partner` / `skillsheet`）
  - `GET /api/admin/roster/partners` / `GET /api/admin/roster/consents[?staff_id=]`
- **マイグレーション**: `0012_add_persons_and_staff_master.sql`（`persons` と `roster_consents` を追加し、`staff_profiles` / `users` / `staff_affiliations` に列を追加。既存の `staff_id` の値は変更しない）
- **フェーズD 必須項目の企業別設定**: スタッフマスタ画面の「必須項目の設定」から変更します（変更できるのは会社管理者のみ）。氏名・性別は常に必須で変更できません。設定は `roster_field_requirements` に保存され、新規作成と基本項目の更新の両方に適用されます。①連携で登録したスタッフには適用しません。④スキルシートのみでは、最寄駅などの稼働系の項目は必須判定の対象外です
- **フェーズE QRコード**: 自社雇用スタッフのスタッフ詳細と、スタッフ本人の画面（その他 → マイプロフィール）に、恒久固定のQRコードを表示します。①連携ではカメラでQRを読み取れます。読み取りはブラウザ内の jsQR で行い、画像はサーバーへ送信しません
- **フェーズF 追記項目の共有**: 稼働先の「稼働先追記項目」（現場評価・稼働メモ。列は `site_evaluation` / `work_memo`）は、所属元のスタッフ詳細「連携先企業」パネルに閲覧専用で表示されます。各社の管理者メモ・フォロー履歴・日報は他社に公開しません
  - API: `GET/PUT /api/admin/roster/field-settings`, `GET /api/admin/roster/:id/share-code`, `GET /api/admin/roster/:id/links`, `GET /api/staff/me/profile`（本人向け。基本項目と連携用IDのみを返します）
- **フェーズG 企業間チャット**: スタッフ詳細の「企業間チャット」欄、一覧画面（`#roster-chat`）、ダッシュボードの新着通知、サイドバーの未読バッジで構成します
  - スレッドは「所属元 × 稼働先 × スタッフ」の組ごとに1本（キーは稼働先側の連携行 `staff_id`）で、参加できるのはその2社の管理系ロールのみです
  - **スタッフ本人は閲覧も投稿もできません**。APIは `/api/admin/roster-chat/*` だけに置いています（`role=staff` は 403）。`/staff` 画面は `roster-chat.js` を読み込みません。チャット欄には「このやり取りはスタッフ本人には表示されません」と表示します
  - 既読は企業単位で管理します（`roster_comment_reads`）。履歴は削除しません（`migrations/0014`）
- **今後のフェーズ**: H 統合ログイン・勤怠の自動振り分け

## 未実装（次フェーズ候補）
- 本番Cloudflare Pagesデプロイ + 本番D1作成
- クライアント閲覧用アカウント画面、給与明細連携、勤怠打刻の位置検証強化
- 業務マニュアル/研修コンテンツ（Phase 4）、AI活用（要約・リスク予兆）、多店舗チェーン向け機能
- 通知のプッシュ/LINE連携、監査ログ、CSVインポート

## 技術スタック / デプロイ
- **Platform**: Cloudflare Pages + Workers（edge runtime）
- **Backend**: Hono 4 + TypeScript、**DB**: Cloudflare D1
- **Frontend**: Vanilla JS SPA（hash routing）+ TailwindCSS CDN + Chart.js + axios + dayjs + FontAwesome
- **Status**: ✅ 開発サーバ稼働中（sandbox）
- **Last Updated**: 2026-07-06
