-- 請求単価の「月額（固定）」（利用者の要望 Sprint 15。#9702。w15-monthly-billing）
-- 表の追加のみ（既存の表・列・値は変えない。シフトの時給・日額の計算には使わない）。
--
-- monthly_bill_rules: 案件の月額の請求。その月に確定・代打のシフトが1件以上ある案件について、月に1回だけ請求する
--   （staff_id のあるルールは、そのスタッフのその案件のシフトが1件以上ある月に1回）。シフトの数・時間には左右されない。
--   金額はシフトの請求額（shifts.unit_price）には入れず、精算・請求前確認・請求の CSV・明細書・案件とクライアントの売上に
--   「月額」の行として足す（src/lib/monthly-billing.ts）。支払（スタッフへの給与）には使わない。
--   project_id: 案件（必須）
--   staff_id: NULL = 案件全体 / スタッフ = そのスタッフの分だけ（案件全体のルールとは別の行として、両方を請求する）
--   amount: 月額（円）
--   valid_from / valid_to: 適用する月（'YYYY-MM'。この月を含む。NULL = 期限なし）。月の途中では変えられない（日割りしない）。
--     同じ案件・同じ対象（案件全体／同じスタッフ）のルールの期間は重ならない（API で確かめる）
--   memo: 備考（請求明細書の備考に出す）
--   company_id を持つので、解約企業の削除（OFFBOARDING_TABLES）でも消す。スタッフ別のルールは、退職後の削除でそのスタッフの分を消す
CREATE TABLE IF NOT EXISTS monthly_bill_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  staff_id INTEGER,
  amount INTEGER NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  memo TEXT,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER,
  updated_at DATETIME,
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_monthly_bill_rules_project ON monthly_bill_rules(company_id, project_id);
CREATE INDEX IF NOT EXISTS idx_monthly_bill_rules_staff ON monthly_bill_rules(staff_id);
