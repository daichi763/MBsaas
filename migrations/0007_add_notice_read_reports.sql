-- お知らせ既読管理: 年度別既読率レポート（長期保存）と notice_reads の削除用インデックス
--
-- notice_reads は2年間のみ保持し、Cronで2年経過分を定期削除する（このmigrationでは削除しない）。
-- 集計結果（年度別・スタッフ別既読率）は notice_reads が削除された後も参照できるよう、
-- 別テーブルへ長期保存する。同一年度の再集計は UNIQUE 制約 + UPSERT で冪等に上書きする。

CREATE TABLE IF NOT EXISTS notice_read_reports (
  report_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  fiscal_year INTEGER NOT NULL,             -- 4/1始まりの年度（例: 2025 = 2025/04/01-2026/03/31）
  target_notice_count INTEGER NOT NULL DEFAULT 0,
  target_user_count INTEGER NOT NULL DEFAULT 0,  -- 延べ対象人数
  read_count INTEGER NOT NULL DEFAULT 0,         -- 延べ既読人数
  unread_count INTEGER NOT NULL DEFAULT 0,       -- 延べ未読人数
  read_rate REAL,                                -- 既読率(%) 小数1桁目安。対象0人の場合はNULL
  calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, fiscal_year),
  FOREIGN KEY (company_id) REFERENCES companies(company_id)
);

CREATE TABLE IF NOT EXISTS notice_read_staff_reports (
  report_id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  fiscal_year INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  target_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  read_rate REAL,                                -- 対象0件の場合はNULL
  calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, fiscal_year, staff_id),
  FOREIGN KEY (company_id) REFERENCES companies(company_id),
  FOREIGN KEY (staff_id) REFERENCES staff_profiles(staff_id)
);

CREATE INDEX IF NOT EXISTS idx_notice_read_reports_company_fy ON notice_read_reports(company_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_notice_read_staff_reports_company_fy ON notice_read_staff_reports(company_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_notice_read_staff_reports_staff ON notice_read_staff_reports(staff_id);

-- notice_reads の2年経過削除処理（WHERE read_at < ?）を高速化する
CREATE INDEX IF NOT EXISTS idx_notice_reads_read_at ON notice_reads(read_at);
