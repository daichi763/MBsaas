-- 移行の控えの表を消す（Sprint 22。#9950。w22-migrations。docs/decisions.md の D-54）
-- 0035・0036・0057 の移行で、直す前・重複として外した行の控えを残した表。画面・API では読まず、
-- 退職後の削除・日報の3年の削除の対象にも入っていなかった（位置情報・写真のキー・日報の値・直す前の生年月日を持つ）。
-- 「表は消さない」（docs/db.md の 2.6）の例外として、利用者の決定（2026-11-09「バックアップの後に消す」）で消す。
-- 本番に当てる前に、3つの表の行数を確かめ、D1 のバックアップを取ること（docs/operations.md の本番リリース）。
-- 当てる順番: ほかのマイグレーションと違い、このファイルはコード（参照を外した版）を本番に出した後に当てる。
--   先に当てると、前の版のコードの解約・R2 の写真の確かめ・案件の削除が、無い表を読んで失敗する。
-- ほかの表・トリガー・ビューからは参照されていない
DROP TABLE IF EXISTS attendance_reports_duplicates_0036;
DROP TABLE IF EXISTS daily_report_duplicates;
DROP TABLE IF EXISTS roster_value_fixes;
