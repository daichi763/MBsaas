-- 請求・支払の単位に「月額」を足す（利用者の要望 11/17。Sprint 29 #9984。w29-monthly）と、月額（固定。#9702）の置き換え
-- 列の追加・トリガーの追加と、金額を変えないデータの移し替えだけ（表・列は消さない。monthly_bill_rules も残す）。
--
-- 月額（bill_unit_type / pay_unit_type = 'monthly'）のシフトの1日分 = 月額 ÷ その月の働いた日数。
--   働いた日数 = 同じ会社・同じ案件・同じスタッフの、その暦月（1日〜末日）の、単位が月額の確定・代打のシフトの数（希望・欠勤は数えない）。
--   1円未満は切り捨て、余りはその月の最後の稼働日のシフト（稼働日・開始時刻・shift_id の順で最後）に足す（月の合計 = 月額）。
--   数量（bill_qty / pay_qty）は 1/働いた日数（画面・CSV は「1/7日」のように出す）。数えないシフト（希望・欠勤）は金額 0・数量 0。
--   金額はシフトの行（unit_price / pay_amount）に持つ（集計はこれまでどおりシフトの金額を足すだけ）。
--   シフトの追加・削除・状態・日付・開始時刻・スタッフ・案件・単位・単価・金額の変更のたびに、下のトリガーがその月のグループ
--   （変更の前と後の両方）だけを計算し直し、値の変わる行だけを書く。確定済み（settle_status = 'confirmed'）と締めた期間（#170）の
--   ほかのシフトは書き換えない（合計が月額と合わなくなったら、精算の確認事項に出す。src/settlement.ts）。
--   変更したシフトそのものは、確定済みのままの変更でなければ計算し直す（アプリが日額と同じ計算で書いた値を直すため）。
--   時給の計算（実働・丸め・延長・割増）は月額には効かない。
--
-- 1. 以前の「月額」の値（unit_price_type = 'monthly' など。今までのコードは日額として計算していた）を 'daily' にそろえる
--    （新しいコードで 'monthly' が月額の意味になっても、今の金額が変わらないように）
UPDATE projects SET unit_price_type = 'daily' WHERE unit_price_type = 'monthly';
UPDATE projects SET pay_unit_type = 'daily' WHERE pay_unit_type = 'monthly';
UPDATE project_price_history SET unit_price_type = 'daily' WHERE unit_price_type = 'monthly';
UPDATE project_price_history SET pay_unit_type = 'daily' WHERE pay_unit_type = 'monthly';
UPDATE rate_rules SET bill_unit_type = 'daily' WHERE bill_unit_type = 'monthly';
UPDATE rate_rules SET pay_unit_type = 'daily' WHERE pay_unit_type = 'monthly';
UPDATE shift_slot_roles SET bill_unit_type = 'daily' WHERE bill_unit_type = 'monthly';
UPDATE shift_slot_roles SET pay_unit_type = 'daily' WHERE pay_unit_type = 'monthly';
UPDATE shifts SET bill_unit_type = 'daily' WHERE bill_unit_type = 'monthly';
UPDATE shifts SET pay_unit_type = 'daily' WHERE pay_unit_type = 'monthly';

-- 2. 月額（固定）のルールを新しい月額に移した印
--   migrated_at: 移す処理をした日時（日本時間）。NULL = まだ（この後の 4. で処理する）
--   migrated_from: 新しい月額に移した最初の月（'YYYY-MM'。'0000-00' = すべての月）。この月より前は、これまでどおり
--     「月額（固定）」の行として請求する（src/lib/monthly-billing.ts）。NULL = 移せなかった（すべての月を、これまでどおり「月額（固定）」で請求する）
ALTER TABLE monthly_bill_rules ADD COLUMN migrated_at TEXT;
ALTER TABLE monthly_bill_rules ADD COLUMN migrated_from TEXT;

-- 3. 月額のシフトの金額を計算し直すトリガー（追加・変更・削除の3つ。1日分・数量の式は3つとも同じ。値の変わる行だけを書くので、
--    トリガーの中の更新でまたトリガーが動いても、2回目は何も書かずに止まる）
CREATE TRIGGER IF NOT EXISTS trg_shifts_monthly_insert AFTER INSERT ON shifts
WHEN NEW.bill_unit_type = 'monthly' OR NEW.pay_unit_type = 'monthly'
BEGIN
  UPDATE shifts SET unit_price = CASE WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END,
    bill_qty = CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
  WHERE shifts.bill_unit_type = 'monthly' AND (shifts.staff_id = NEW.staff_id AND shifts.project_id = NEW.project_id AND shifts.company_id = NEW.company_id
        AND shifts.work_date BETWEEN substr(NEW.work_date, 1, 7) || '-01' AND substr(NEW.work_date, 1, 7) || '-31')
    AND (shifts.shift_id = NEW.shift_id OR (COALESCE(shifts.settle_status, 'planned') != 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL
          AND shifts.work_date BETWEEN k.period_from AND k.period_to)))
    AND (shifts.unit_price IS NOT CASE WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END
      OR shifts.bill_qty IS NOT CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END);
  UPDATE shifts SET pay_amount = CASE WHEN shifts.pay_rate IS NULL THEN NULL WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(shifts.pay_rate AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(shifts.pay_rate AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END,
    pay_qty = CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
  WHERE shifts.pay_unit_type = 'monthly' AND (shifts.staff_id = NEW.staff_id AND shifts.project_id = NEW.project_id AND shifts.company_id = NEW.company_id
        AND shifts.work_date BETWEEN substr(NEW.work_date, 1, 7) || '-01' AND substr(NEW.work_date, 1, 7) || '-31')
    AND (shifts.shift_id = NEW.shift_id OR (COALESCE(shifts.settle_status, 'planned') != 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL
          AND shifts.work_date BETWEEN k.period_from AND k.period_to)))
    AND (shifts.pay_amount IS NOT CASE WHEN shifts.pay_rate IS NULL THEN NULL WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(shifts.pay_rate AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(shifts.pay_rate AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END
      OR shifts.pay_qty IS NOT CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END);
END;

CREATE TRIGGER IF NOT EXISTS trg_shifts_monthly_update
AFTER UPDATE OF status, work_date, start_time, staff_id, project_id, settle_status, bill_unit_type, bill_rate, unit_price, bill_qty, pay_unit_type, pay_rate, pay_amount, pay_qty ON shifts
WHEN NEW.bill_unit_type = 'monthly' OR NEW.pay_unit_type = 'monthly' OR OLD.bill_unit_type = 'monthly' OR OLD.pay_unit_type = 'monthly'
BEGIN
  UPDATE shifts SET unit_price = CASE WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END,
    bill_qty = CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
  WHERE shifts.bill_unit_type = 'monthly' AND ((shifts.staff_id = NEW.staff_id AND shifts.project_id = NEW.project_id AND shifts.company_id = NEW.company_id
        AND shifts.work_date BETWEEN substr(NEW.work_date, 1, 7) || '-01' AND substr(NEW.work_date, 1, 7) || '-31')
      OR (shifts.staff_id = OLD.staff_id AND shifts.project_id = OLD.project_id AND shifts.company_id = OLD.company_id
        AND shifts.work_date BETWEEN substr(OLD.work_date, 1, 7) || '-01' AND substr(OLD.work_date, 1, 7) || '-31'))
    AND ((shifts.shift_id = NEW.shift_id AND NOT (COALESCE(OLD.settle_status, 'planned') = 'confirmed' AND COALESCE(NEW.settle_status, 'planned') = 'confirmed'))
      OR (shifts.shift_id != NEW.shift_id AND COALESCE(shifts.settle_status, 'planned') != 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL
          AND shifts.work_date BETWEEN k.period_from AND k.period_to)))
    AND (shifts.unit_price IS NOT CASE WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END
      OR shifts.bill_qty IS NOT CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END);
  UPDATE shifts SET pay_amount = CASE WHEN shifts.pay_rate IS NULL THEN NULL WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(shifts.pay_rate AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(shifts.pay_rate AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END,
    pay_qty = CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
  WHERE shifts.pay_unit_type = 'monthly' AND ((shifts.staff_id = NEW.staff_id AND shifts.project_id = NEW.project_id AND shifts.company_id = NEW.company_id
        AND shifts.work_date BETWEEN substr(NEW.work_date, 1, 7) || '-01' AND substr(NEW.work_date, 1, 7) || '-31')
      OR (shifts.staff_id = OLD.staff_id AND shifts.project_id = OLD.project_id AND shifts.company_id = OLD.company_id
        AND shifts.work_date BETWEEN substr(OLD.work_date, 1, 7) || '-01' AND substr(OLD.work_date, 1, 7) || '-31'))
    AND ((shifts.shift_id = NEW.shift_id AND NOT (COALESCE(OLD.settle_status, 'planned') = 'confirmed' AND COALESCE(NEW.settle_status, 'planned') = 'confirmed'))
      OR (shifts.shift_id != NEW.shift_id AND COALESCE(shifts.settle_status, 'planned') != 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL
          AND shifts.work_date BETWEEN k.period_from AND k.period_to)))
    AND (shifts.pay_amount IS NOT CASE WHEN shifts.pay_rate IS NULL THEN NULL WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(shifts.pay_rate AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(shifts.pay_rate AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END
      OR shifts.pay_qty IS NOT CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END);
END;

CREATE TRIGGER IF NOT EXISTS trg_shifts_monthly_delete AFTER DELETE ON shifts
WHEN OLD.bill_unit_type = 'monthly' OR OLD.pay_unit_type = 'monthly'
BEGIN
  UPDATE shifts SET unit_price = CASE WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END,
    bill_qty = CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
  WHERE shifts.bill_unit_type = 'monthly' AND (shifts.staff_id = OLD.staff_id AND shifts.project_id = OLD.project_id AND shifts.company_id = OLD.company_id
        AND shifts.work_date BETWEEN substr(OLD.work_date, 1, 7) || '-01' AND substr(OLD.work_date, 1, 7) || '-31')
    AND (COALESCE(shifts.settle_status, 'planned') != 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL
          AND shifts.work_date BETWEEN k.period_from AND k.period_to))
    AND (shifts.unit_price IS NOT CASE WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(COALESCE(shifts.bill_rate, 0) AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END
      OR shifts.bill_qty IS NOT CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.bill_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END);
  UPDATE shifts SET pay_amount = CASE WHEN shifts.pay_rate IS NULL THEN NULL WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(shifts.pay_rate AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(shifts.pay_rate AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END,
    pay_qty = CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
  WHERE shifts.pay_unit_type = 'monthly' AND (shifts.staff_id = OLD.staff_id AND shifts.project_id = OLD.project_id AND shifts.company_id = OLD.company_id
        AND shifts.work_date BETWEEN substr(OLD.work_date, 1, 7) || '-01' AND substr(OLD.work_date, 1, 7) || '-31')
    AND (COALESCE(shifts.settle_status, 'planned') != 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL
          AND shifts.work_date BETWEEN k.period_from AND k.period_to))
    AND (shifts.pay_amount IS NOT CASE WHEN shifts.pay_rate IS NULL THEN NULL WHEN shifts.status IN ('confirmed','substitute')
        THEN CAST(shifts.pay_rate AS INTEGER) / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute'))
          + CASE WHEN NOT EXISTS (SELECT 1 FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')
          AND (x.work_date > shifts.work_date OR (x.work_date = shifts.work_date AND (COALESCE(x.start_time, '') > COALESCE(shifts.start_time, '')
            OR (COALESCE(x.start_time, '') = COALESCE(shifts.start_time, '') AND x.shift_id > shifts.shift_id))))) THEN CAST(shifts.pay_rate AS INTEGER) % (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END
        ELSE 0 END
      OR shifts.pay_qty IS NOT CASE WHEN shifts.status IN ('confirmed','substitute') THEN 1.0 / (SELECT COUNT(*) FROM shifts x WHERE x.staff_id = shifts.staff_id AND x.project_id = shifts.project_id
          AND x.work_date BETWEEN substr(shifts.work_date, 1, 7) || '-01' AND substr(shifts.work_date, 1, 7) || '-31'
          AND x.company_id = shifts.company_id AND x.pay_unit_type = 'monthly' AND x.status IN ('confirmed','substitute')) ELSE 0 END);
END;

-- 4. 月額（固定）のルールを新しい月額に移す（migrated_at が NULL のルールだけ。scripts/test-w29-monthly.mjs は、この印の間を
--    もう一度流して、移す前と後で請求の合計が変わらないことを確かめる）
-- [0114-data-begin]
-- ルール・月ごとの印（bad: 0 = 移せる / 1 = その月は移せない / 2 = ルールごと移せない）。作業用の表で、最後に消す
CREATE TABLE IF NOT EXISTS w0114_cells (rule_id INTEGER NOT NULL, ym TEXT NOT NULL, bad INTEGER NOT NULL);
DELETE FROM w0114_cells;
-- ルールごと移せない条件（スタッフ別・案件全体の共通）: 案件の標準の請求単価が 0 でない、またはこの案件に効く単価ルールに請求単価（0 以外）がある
-- （新しい月額は日額・時給の代わりになるので、日額・時給と月額（固定）を両方請求していた形は表せない）
INSERT INTO w0114_cells (rule_id, ym, bad)
  SELECT r.rule_id, '', 2 FROM monthly_bill_rules r JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id
  WHERE r.migrated_at IS NULL AND (COALESCE(p.unit_price, 0) != 0 OR EXISTS (SELECT 1 FROM rate_rules rr WHERE rr.company_id = r.company_id AND COALESCE(rr.bill_rate, 0) != 0
    AND (rr.project_id = r.project_id OR (rr.project_id IS NULL AND (rr.client_id IS NULL OR rr.client_id = p.client_id)))));

-- 4-1. スタッフ別のルール
-- 月ごと: その月の確定・代打のシフトに、確定済み・締めた期間・請求単価や請求額のあるもの・手動で単価を変えたもの（price_locked）があれば、その月は移せない
--   （その月はこれまでどおり「月額（固定）」の行で請求する。確定済み・締めた月の金額を変えないため）
INSERT INTO w0114_cells (rule_id, ym, bad)
  SELECT r.rule_id, substr(s.work_date, 1, 7),
    MAX(CASE WHEN s.status IN ('confirmed','substitute') AND (COALESCE(s.settle_status, 'planned') = 'confirmed' OR COALESCE(s.price_locked, 0) != 0
      OR COALESCE(s.bill_rate, 0) != 0 OR COALESCE(s.unit_price, 0) != 0
      OR EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = s.company_id AND k.reopened_at IS NULL AND s.work_date BETWEEN k.period_from AND k.period_to)) THEN 1 ELSE 0 END)
  FROM monthly_bill_rules r JOIN shifts s ON s.staff_id = r.staff_id AND s.project_id = r.project_id AND s.company_id = r.company_id
  WHERE r.migrated_at IS NULL AND r.staff_id IS NOT NULL
    AND (r.valid_from IS NULL OR s.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR s.work_date <= r.valid_to || '-31')
  GROUP BY r.rule_id, substr(s.work_date, 1, 7);
-- 移す最初の月 = 移せない最後の月の次の月（移せない月がなければすべての月）
UPDATE monthly_bill_rules SET migrated_from = CASE
    WHEN EXISTS (SELECT 1 FROM w0114_cells c WHERE c.rule_id = monthly_bill_rules.rule_id AND c.bad = 2) THEN NULL
    ELSE COALESCE((SELECT substr(date(MAX(c.ym) || '-01', '+1 month'), 1, 7) FROM w0114_cells c WHERE c.rule_id = monthly_bill_rules.rule_id AND c.bad = 1), '0000-00') END
  WHERE migrated_at IS NULL AND staff_id IS NOT NULL;
-- 移す月のシフト（状態は問わない。希望のシフトも、確定・代打になったときに月額で数える）で、請求単価・請求額が 0・未設定、
-- 手動の単価の変更なし・未確定・締めていないものを、月額（単価 = ルールの金額）にする。1日分の金額はトリガーが入れる
UPDATE shifts SET bill_unit_type = 'monthly',
    bill_rate = (SELECT r.amount FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.migrated_from IS NOT NULL AND r.staff_id = shifts.staff_id
      AND r.project_id = shifts.project_id AND r.company_id = shifts.company_id
      AND (r.valid_from IS NULL OR shifts.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR shifts.work_date <= r.valid_to || '-31')
      AND shifts.work_date >= r.migrated_from || '-01' ORDER BY r.rule_id DESC LIMIT 1),
    price_source = CASE WHEN json_valid(price_source) AND json_type(price_source, '$.basis') = 'array'
      THEN json_set(price_source, '$.basis[0]', 'monthly', '$.basis[1]', (SELECT r.amount FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.migrated_from IS NOT NULL
        AND r.staff_id = shifts.staff_id AND r.project_id = shifts.project_id AND r.company_id = shifts.company_id
        AND (r.valid_from IS NULL OR shifts.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR shifts.work_date <= r.valid_to || '-31')
        AND shifts.work_date >= r.migrated_from || '-01' ORDER BY r.rule_id DESC LIMIT 1)) ELSE price_source END
  WHERE EXISTS (SELECT 1 FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.migrated_from IS NOT NULL AND r.staff_id = shifts.staff_id
      AND r.project_id = shifts.project_id AND r.company_id = shifts.company_id
      AND (r.valid_from IS NULL OR shifts.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR shifts.work_date <= r.valid_to || '-31')
      AND shifts.work_date >= r.migrated_from || '-01')
    AND COALESCE(bill_unit_type, 'daily') != 'monthly' AND COALESCE(bill_rate, 0) = 0 AND COALESCE(unit_price, 0) = 0 AND COALESCE(price_locked, 0) = 0
    AND COALESCE(settle_status, 'planned') != 'confirmed'
    AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL AND shifts.work_date BETWEEN k.period_from AND k.period_to);
-- これから作るシフトにも効くよう、スタッフ別の単価ルール（請求だけ・月額）として残す（移した最初の月から、ルールの終了月の末日まで）
INSERT INTO rate_rules (company_id, project_id, staff_id, bill_unit_type, bill_rate, valid_from, valid_to, memo, created_at)
  SELECT company_id, project_id, staff_id, 'monthly', amount,
    CASE WHEN migrated_from = '0000-00' THEN (CASE WHEN valid_from IS NULL THEN NULL ELSE valid_from || '-01' END) ELSE max(migrated_from, COALESCE(valid_from, '')) || '-01' END,
    CASE WHEN valid_to IS NULL THEN NULL ELSE date(valid_to || '-01', '+1 month', '-1 day') END,
    substr('月額（固定）#' || rule_id || ' から移した月額' || CASE WHEN memo IS NOT NULL AND memo != '' THEN '・' || memo ELSE '' END, 1, 200), datetime('now', '+9 hours')
  FROM monthly_bill_rules WHERE migrated_at IS NULL AND staff_id IS NOT NULL AND migrated_from IS NOT NULL AND (valid_to IS NULL OR migrated_from <= valid_to);
UPDATE monthly_bill_rules SET migrated_at = datetime('now', '+9 hours') WHERE migrated_at IS NULL AND staff_id IS NOT NULL;

-- 4-2. 案件全体のルール（スタッフ別のルールを移した後に見る。スタッフ別で月額にしたシフトは請求単価があるので、その月は移せない）
-- 新しい月額は人ごとなので、ルールの期間に、欠勤以外のシフトのあるスタッフが2人以上の月がある案件、
-- 期間の重なるスタッフ別の月額（固定）がある案件は、ルールごと移さない（これまでどおり「月額（固定）」の行で請求する）
INSERT INTO w0114_cells (rule_id, ym, bad)
  SELECT r.rule_id, substr(s.work_date, 1, 7),
    CASE WHEN COUNT(DISTINCT CASE WHEN s.status != 'absent' THEN s.staff_id END) > 1 THEN 2
      ELSE MAX(CASE WHEN s.status IN ('confirmed','substitute') AND (COALESCE(s.settle_status, 'planned') = 'confirmed' OR COALESCE(s.price_locked, 0) != 0
        OR COALESCE(s.bill_rate, 0) != 0 OR COALESCE(s.unit_price, 0) != 0
        OR EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = s.company_id AND k.reopened_at IS NULL AND s.work_date BETWEEN k.period_from AND k.period_to)) THEN 1 ELSE 0 END) END
  FROM monthly_bill_rules r JOIN shifts s ON s.project_id = r.project_id AND s.company_id = r.company_id
  WHERE r.migrated_at IS NULL AND r.staff_id IS NULL
    AND (r.valid_from IS NULL OR s.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR s.work_date <= r.valid_to || '-31')
  GROUP BY r.rule_id, substr(s.work_date, 1, 7);
INSERT INTO w0114_cells (rule_id, ym, bad)
  SELECT r.rule_id, '', 2 FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.staff_id IS NULL AND EXISTS (SELECT 1 FROM monthly_bill_rules o
    WHERE o.company_id = r.company_id AND o.project_id = r.project_id AND o.staff_id IS NOT NULL
      AND (o.valid_from IS NULL OR r.valid_to IS NULL OR o.valid_from <= r.valid_to) AND (r.valid_from IS NULL OR o.valid_to IS NULL OR r.valid_from <= o.valid_to));
UPDATE monthly_bill_rules SET migrated_from = CASE
    WHEN EXISTS (SELECT 1 FROM w0114_cells c WHERE c.rule_id = monthly_bill_rules.rule_id AND c.bad = 2) THEN NULL
    ELSE COALESCE((SELECT substr(date(MAX(c.ym) || '-01', '+1 month'), 1, 7) FROM w0114_cells c WHERE c.rule_id = monthly_bill_rules.rule_id AND c.bad = 1), '0000-00') END
  WHERE migrated_at IS NULL AND staff_id IS NULL;
UPDATE shifts SET bill_unit_type = 'monthly',
    bill_rate = (SELECT r.amount FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.migrated_from IS NOT NULL AND r.staff_id IS NULL
      AND r.project_id = shifts.project_id AND r.company_id = shifts.company_id
      AND (r.valid_from IS NULL OR shifts.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR shifts.work_date <= r.valid_to || '-31')
      AND shifts.work_date >= r.migrated_from || '-01' ORDER BY r.rule_id DESC LIMIT 1),
    price_source = CASE WHEN json_valid(price_source) AND json_type(price_source, '$.basis') = 'array'
      THEN json_set(price_source, '$.basis[0]', 'monthly', '$.basis[1]', (SELECT r.amount FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.migrated_from IS NOT NULL
        AND r.staff_id IS NULL AND r.project_id = shifts.project_id AND r.company_id = shifts.company_id
        AND (r.valid_from IS NULL OR shifts.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR shifts.work_date <= r.valid_to || '-31')
        AND shifts.work_date >= r.migrated_from || '-01' ORDER BY r.rule_id DESC LIMIT 1)) ELSE price_source END
  WHERE EXISTS (SELECT 1 FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.migrated_from IS NOT NULL AND r.staff_id IS NULL
      AND r.project_id = shifts.project_id AND r.company_id = shifts.company_id
      AND (r.valid_from IS NULL OR shifts.work_date >= r.valid_from || '-01') AND (r.valid_to IS NULL OR shifts.work_date <= r.valid_to || '-31')
      AND shifts.work_date >= r.migrated_from || '-01')
    AND COALESCE(bill_unit_type, 'daily') != 'monthly' AND COALESCE(bill_rate, 0) = 0 AND COALESCE(unit_price, 0) = 0 AND COALESCE(price_locked, 0) = 0
    AND COALESCE(settle_status, 'planned') != 'confirmed'
    AND NOT EXISTS (SELECT 1 FROM settlement_closings k WHERE k.company_id = shifts.company_id AND k.reopened_at IS NULL AND shifts.work_date BETWEEN k.period_from AND k.period_to);
-- これから作るシフト: 期限のないルールをすべての月で移せて、案件の標準単価の改定（price_valid_from）がなければ、案件の標準の請求単価を月額にする。
-- それ以外（期限のあるルール・途中の月から移したルール）は、案件の単価ルール（請求だけ・月額。期間つき）として残す
UPDATE projects SET unit_price_type = 'monthly', unit_price = (SELECT r.amount FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.staff_id IS NULL
    AND r.project_id = projects.project_id AND r.company_id = projects.company_id AND r.migrated_from = '0000-00' AND r.valid_from IS NULL AND r.valid_to IS NULL ORDER BY r.rule_id DESC LIMIT 1)
  WHERE price_valid_from IS NULL AND EXISTS (SELECT 1 FROM monthly_bill_rules r WHERE r.migrated_at IS NULL AND r.staff_id IS NULL
    AND r.project_id = projects.project_id AND r.company_id = projects.company_id AND r.migrated_from = '0000-00' AND r.valid_from IS NULL AND r.valid_to IS NULL);
INSERT INTO rate_rules (company_id, project_id, staff_id, bill_unit_type, bill_rate, valid_from, valid_to, memo, created_at)
  SELECT r.company_id, r.project_id, NULL, 'monthly', r.amount,
    CASE WHEN r.migrated_from = '0000-00' THEN (CASE WHEN r.valid_from IS NULL THEN NULL ELSE r.valid_from || '-01' END) ELSE max(r.migrated_from, COALESCE(r.valid_from, '')) || '-01' END,
    CASE WHEN r.valid_to IS NULL THEN NULL ELSE date(r.valid_to || '-01', '+1 month', '-1 day') END,
    substr('月額（固定）#' || r.rule_id || ' から移した月額' || CASE WHEN r.memo IS NOT NULL AND r.memo != '' THEN '・' || r.memo ELSE '' END, 1, 200), datetime('now', '+9 hours')
  FROM monthly_bill_rules r JOIN projects p ON p.project_id = r.project_id AND p.company_id = r.company_id
  WHERE r.migrated_at IS NULL AND r.staff_id IS NULL AND r.migrated_from IS NOT NULL AND (r.valid_to IS NULL OR r.migrated_from <= r.valid_to)
    AND NOT (r.migrated_from = '0000-00' AND r.valid_from IS NULL AND r.valid_to IS NULL AND p.price_valid_from IS NULL);
UPDATE monthly_bill_rules SET migrated_at = datetime('now', '+9 hours') WHERE migrated_at IS NULL AND staff_id IS NULL;
DROP TABLE IF EXISTS w0114_cells;
-- [0114-data-end]
