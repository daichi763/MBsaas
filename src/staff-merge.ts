// =========================================================
// 仮登録スタッフと既存スタッフ（他社連携・自社雇用など）の統合
// docs/spec_spot_shift.md 第5段階
//
// 統合元（仮登録）のシフト・勤怠・日報・評価・フォロー・相談・書類・単価ルール・応募・報告用URLを統合先へ移す。
// 統合元の行は削除せず「統合済み」（merged_into_staff_id）として残し、一覧・候補・検索から外す。ログインは無効化する。
// 適用日（今日）以降の未報告・未確定のシフトは、統合先の区分で単価・支払先を置き換える（手動変更の金額は支払先のみ）。
// 確定済み・報告済みのシフトは金額を変えず、スタッフだけを付け替える。
// 打刻修正申請と案件 × スタッフの報告設定も移す（報告設定は統合先に行がない案件 × 種類だけ。#10）。
// 統合元を連携元にした他社の連携行は、統合先を連携元に付け替える（#248 #103）。
// メールアドレスは統合先のログイン・再設定用にコピーせず、統合先の「未確認のメール」として残す（#38）。
// =========================================================
import { Hono } from 'hono'
import { applyPricingToShift, conflictFor, findConflicts, loadPricingData } from './shift-board'
import { TYPE_LABEL, normalizePhone, payeeTypeFor } from './staff-lifecycle'
import { revokeSessionsStmt } from './lib/auth'
import { conflictLabel } from './lib/staff-eligibility'
import { JSON_IN, bindJsonArray } from './lib/d1-chunk'

type Bindings = { DB: D1Database }
type Variables = { user: any }
export const staffMergeApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
const normName = (s: any) => String(s || '').replace(/[\s\u3000]/g, '').toLowerCase()
// ひらがな→カタカナ・空白除去（フリガナの比較用）
const normKana = (s: any) => String(s || '').replace(/[\s\u3000]/g, '').replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
// \u9000\u8077\u30fb\u505c\u6b62\u4e2d\u306a\u3089\u753b\u9762\u306b\u51fa\u3059\u5370\uff08\u5728\u7c4d\u4e2d\u306f null\uff09
function inactiveLabel(r: any, today: string): string | null {
  if (r.employment_status === 'retired' || (r.retired_at && r.retired_at < today)) return '\u9000\u8077'
  if (r.user_status && r.user_status !== 'active') return '\u505c\u6b62'
  return null
}
function addDays(d: string, n: number): string { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const yen = (v: any) => v == null ? '-' : Number(v).toLocaleString('ja-JP') + '\u5186'
// \u5358\u4fa1\u30eb\u30fc\u30eb\u306e\u7bc4\u56f2\uff08\u6848\u4ef6\u30fb\u958b\u50ac\u5834\u6240\u30fb\u5f79\u5272\uff09\u304c\u540c\u3058\u304b
const sameScope = (a: any, b: any) => (a.project_id ?? null) === (b.project_id ?? null) && (a.site_id ?? null) === (b.site_id ?? null) && (a.role_name || null) === (b.role_name || null)

async function loadStaff(db: D1Database, companyId: number, staffId: any) {
  return db.prepare(`SELECT sp.*, us.name, us.phone, us.email, us.role AS user_role, us.user_code, us.status AS user_status, us.retired_at,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana_resolved,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.gender ELSE sp.gender END AS gender_resolved,
      oc.company_name AS owner_company_name
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    WHERE sp.staff_id = ? AND sp.company_id = ?`).bind(staffId, companyId).first() as Promise<any>
}

// 統合候補（同じ電話番号・同じ氏名・同じフリガナ）。q を渡すと氏名の部分一致でも探す
staffMergeApi.get('/staff/:id/merge-candidates', async (c) => {
  const u = c.get('user'); const db = c.env.DB
  const s = await loadStaff(db, u.company_id, c.req.param('id'))
  if (!s) return c.json({ error: 'スタッフが見つかりません' }, 404)
  const q = String(c.req.query('q') || '').trim()
  const rows = ((await db.prepare(`SELECT sp.staff_id, us.name, us.phone, COALESCE(sp.affiliation_type,'own_employee') AS affiliation_type, sp.is_provisional,
      sp.employment_status, us.status AS user_status, us.retired_at,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana, oc.company_name AS owner_company_name, CASE WHEN sp.affiliation_type = 'linked_external' THEN sp.relink_code ELSE pe.global_staff_code END AS global_staff_code,
      (SELECT COUNT(*) FROM shifts sh WHERE sh.staff_id = sp.staff_id AND sh.status IN ('confirmed','substitute')) AS shift_count,
      (SELECT MAX(sh.work_date) FROM shifts sh WHERE sh.staff_id = sp.staff_id AND sh.status IN ('confirmed','substitute')) AS last_work_date
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = COALESCE(sp.root_staff_id, sp.source_staff_id)
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ? AND sp.staff_id != ? AND sp.merged_into_staff_id IS NULL
      AND COALESCE(sp.affiliation_type,'own_employee') != 'skillsheet_only' LIMIT 3000`).bind(u.company_id, s.staff_id).all()).results as any[])
  const phone = normalizePhone(s.phone), name = normName(s.name), kana = normKana(s.kana_resolved)
  const nq = normName(q), today = todayJST()
  const out = rows.map(r => {
    const reasons: string[] = []
    if (phone.length >= 10 && normalizePhone(r.phone) === phone) reasons.push('電話番号が同じ')
    if (name && normName(r.name) === name) reasons.push('氏名が同じ')
    if (kana && r.kana && normKana(r.kana) === kana) reasons.push('フリガナが同じ')
    const score = (reasons.includes('電話番号が同じ') ? 4 : 0) + (reasons.includes('氏名が同じ') ? 2 : 0) + (reasons.includes('フリガナが同じ') ? 1 : 0)
    const { employment_status: _es, user_status: _us, retired_at: _ra, ...rest } = r
    return { ...rest, phone: r.affiliation_type === 'linked_external' ? null : r.phone, reasons, score, inactive: inactiveLabel(r, today),
      match_q: !!nq && (normName(r.name).includes(nq) || (r.kana && normKana(r.kana).includes(normKana(q)))) }
  }).filter(r => r.score > 0 || r.match_q)
    // 退職・停止中の人は、一致の度合いが同じでも後ろに並べる（#97）
    .sort((a, b) => (a.inactive ? 1 : 0) - (b.inactive ? 1 : 0) || b.score - a.score || (b.affiliation_type === 'linked_external' ? 1 : 0) - (a.affiliation_type === 'linked_external' ? 1 : 0) || a.name.localeCompare(b.name, 'ja'))
    .slice(0, 30)
  return c.json({ candidates: out, source: { staff_id: s.staff_id, name: s.name, is_provisional: !!s.is_provisional, merged_into_staff_id: s.merged_into_staff_id } })
})

// 統合の実行（dry_run で影響を確認）
staffMergeApi.post('/staff/:id/merge', async (c) => {
  const u = c.get('user'); const db = c.env.DB; const b = await c.req.json().catch(() => ({} as any))
  const src = await loadStaff(db, u.company_id, c.req.param('id'))
  if (!src) return c.json({ error: 'スタッフが見つかりません' }, 404)
  if (src.merged_into_staff_id) return c.json({ error: 'このスタッフはすでに統合済みです' }, 409)
  if (!src.is_provisional) return c.json({ error: '統合できるのは仮登録のスタッフのみです（統合元にしてください）' }, 400)
  const tgt = await loadStaff(db, u.company_id, b.target_staff_id)
  if (!tgt) return c.json({ error: '統合先のスタッフが見つかりません' }, 404)
  if (tgt.staff_id === src.staff_id) return c.json({ error: '同じスタッフには統合できません' }, 400)
  if (tgt.merged_into_staff_id) return c.json({ error: '統合先のスタッフは統合済みです' }, 409)
  const tType = tgt.affiliation_type || 'own_employee'
  if (tType === 'skillsheet_only') return c.json({ error: 'スキルシートのみのスタッフには統合できません' }, 400)
  const today = todayJST()

  // ---- 影響範囲 ----
  const count = async (sql: string, ...bind: any[]) => Number(((await db.prepare(sql).bind(...bind).first()) as any)?.n || 0)
  const sid = src.staff_id
  const T = tgt.staff_id
  const shifts = ((await db.prepare(`SELECT s.shift_id, s.project_id, s.slot_role_id, s.work_date, s.start_time, s.end_time, s.status, s.price_locked, s.settle_status, p.project_name,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS reported
    FROM shifts s JOIN projects p ON p.project_id = s.project_id WHERE s.staff_id = ? AND s.company_id = ? ORDER BY s.work_date`).bind(sid, u.company_id).all()).results as any[])
  // 報告設定: 統合先に行がない案件 × 種類だけを引き継ぐ（統合先の設定を優先する）
  const reportSettingsWhere = `FROM project_staff_report_settings s WHERE s.staff_id = ? AND s.company_id = ?
    AND NOT EXISTS (SELECT 1 FROM project_staff_report_settings t WHERE t.project_id = s.project_id AND t.staff_id = ? AND t.report_type = s.report_type)`
  const counts = {
    shifts: shifts.length,
    attendance_reports: await count('SELECT COUNT(*) AS n FROM attendance_reports WHERE staff_id = ?', sid),
    daily_reports: await count('SELECT COUNT(*) AS n FROM daily_reports WHERE staff_id = ?', sid),
    evaluations: await count('SELECT COUNT(*) AS n FROM evaluations WHERE staff_id = ?', sid),
    follow_logs: await count('SELECT COUNT(*) AS n FROM follow_logs WHERE staff_id = ?', sid),
    consultations: await count('SELECT COUNT(*) AS n FROM consultations WHERE staff_id = ?', sid),
    staff_documents: await count('SELECT COUNT(*) AS n FROM staff_documents WHERE staff_id = ?', sid),
    rate_rules: await count('SELECT COUNT(*) AS n FROM rate_rules WHERE staff_id = ? AND company_id = ?', sid, u.company_id),
    recruit_applications: await count('SELECT COUNT(*) AS n FROM recruit_applications WHERE staff_id = ? AND company_id = ?', sid, u.company_id),
    attendance_corrections: await count('SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id = ? AND company_id = ?', sid, u.company_id),
    attendance_corrections_pending: await count("SELECT COUNT(*) AS n FROM attendance_corrections WHERE staff_id = ? AND company_id = ? AND status = 'pending'", sid, u.company_id),
    report_settings: await count(`SELECT COUNT(*) AS n ${reportSettingsWhere}`, sid, u.company_id, T),
    linked_rows: 0,
  }
  // 重複の確認: 統合先（他社のシフトを含む同一人物）と同じ時間帯・同じ枠
  const active = shifts.filter(s => s.status !== 'absent')
  const warnings: string[] = []
  // 統合先が退職・停止中なら、今後のシフトが退職者に付くため確認を求める（再雇用なら在籍状況を戻してから統合する。#97）
  const tInactive = inactiveLabel(tgt, today)
  if (tInactive) warnings.push(`統合先の「${tgt.name}」は${tInactive === '退職' ? '退職済み' : '停止中'}です。統合すると、今後のシフトは${tInactive === '退職' ? '退職者' : '停止中のスタッフ'}に付き、新しいシフトには割り当てられません。再雇用などで同じ人として使う場合は、統合先の在籍状況を戻してから統合してください`)
  if (active.length) {
    const dates = active.map(s => s.work_date).sort()
    const cf = await findConflicts(db, u.company_id, [tgt.staff_id], dates[0], dates[dates.length - 1])
    for (const s of active) {
      const list = conflictFor(cf.get(tgt.staff_id), s.work_date, s.start_time, s.end_time)
      if (list.length) warnings.push(`${s.work_date} ${s.start_time}〜${s.end_time} ${s.project_name}: 統合先に同じ時間帯のシフトがあります（${list.map((x: any) => conflictLabel(x, u.company_id)).join('、')}）${list.some((x: any) => x.company_id === u.company_id && x.slot_role_id && x.slot_role_id === s.slot_role_id) ? '・同じ枠' : ''}`)
    }
  }
  // 単価ルール: 統合先に同じ範囲（案件・開催場所・役割）のスタッフ別ルールがあれば、統合先のルールを残し、統合元のルールは移さずに消す（#499）
  const ruleRows = ((await db.prepare(`SELECT r.*, p.project_name FROM rate_rules r LEFT JOIN projects p ON p.project_id = r.project_id
    WHERE r.company_id = ? AND r.staff_id IN (?, ?) ORDER BY r.rule_id`).bind(u.company_id, sid, T).all()).results as any[])
  const srcRules = ruleRows.filter(r => r.staff_id === sid), tgtRules = ruleRows.filter(r => r.staff_id === T)
  const dropRules = srcRules.filter(r => tgtRules.some(t => sameScope(r, t)))
  const moveRules = srcRules.filter(r => !dropRules.includes(r))
  for (const r of dropRules) {
    const t = tgtRules.find(x => sameScope(r, x))!
    warnings.push(`単価ルール: 統合先に同じ${r.project_name ? `案件（${r.project_name}）` : '範囲'}のスタッフ別ルールがあります（支払 統合先 ${yen(t.pay_rate)}／統合元 ${yen(r.pay_rate)}・請求 統合先 ${yen(t.bill_rate)}／統合元 ${yen(r.bill_rate)}）。統合先のルールを残し、統合元のルールは削除します`)
  }
  // 従業員管理のデータ: 統合先が自社雇用で、従業員データがない場合だけ移す。それ以外は統合元に残し、雇用終了として見られるようにする（#109）
  const srcEr = await db.prepare('SELECT employee_record_id, employment_ended_at FROM employee_records WHERE staff_id = ?').bind(sid).first() as any
  const tgtEr = await db.prepare('SELECT employee_record_id FROM employee_records WHERE staff_id = ?').bind(tgt.staff_id).first() as any
  const tgtIsOwnEmployee = tType === 'own_employee' && (tgt.owner_company_id == null || tgt.owner_company_id === u.company_id)
  const moveEr = !!srcEr && !tgtEr && tgtIsOwnEmployee
  const endedAt = srcEr?.employment_ended_at || addDays(today, -1)
  if (srcEr && tgtEr) warnings.push(`統合元と統合先の両方に従業員管理のデータがあります。統合元の従業員データは移さず、雇用終了（${endedAt}）として従業員管理の「雇用終了」の欄に残します`)
  else if (srcEr && !tgtIsOwnEmployee) warnings.push(`統合先は${TYPE_LABEL[tType] || tType}のため、統合元の従業員管理のデータ（給与・口座など）は統合先へ移さず、雇用終了（${endedAt}）として従業員管理の「雇用終了」の欄に残します`)

  // 他社の連携行: 統合元を連携元（source / root）にしている行を、統合先に付け替える（#248）
  const links = ((await db.prepare(`SELECT sp.staff_id, sp.company_id, sp.user_id, sp.source_staff_id FROM staff_profiles sp
    WHERE sp.affiliation_type = 'linked_external' AND (sp.source_staff_id = ? OR sp.root_staff_id = ?)`).bind(sid, sid).all()).results as any[])
  counts.linked_rows = links.length
  // 統合先が他社連携なら、連携の雇用元は統合先の雇用元（多段連携）
  const newRoot = tType === 'linked_external' ? (tgt.root_staff_id || tgt.source_staff_id || T) : T
  const rootUser = links.length ? await db.prepare('SELECT us.role, us.status FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id WHERE sp.staff_id = ?').bind(newRoot).first() as any : null
  // 連携先の会社に、統合先の人がすでに別の行で連携されている場合（同じ人が2行になる）
  const dupCompanies = new Set<number>()
  if (links.length && tgt.person_id) {
    const rows = ((await db.prepare(`SELECT DISTINCT company_id FROM staff_profiles WHERE person_id = ? AND company_id IN ${JSON_IN}`)
      .bind(tgt.person_id, bindJsonArray(links.map(l => l.company_id))).all()).results as any[])
    for (const r of rows) dupCompanies.add(r.company_id)
  }
  const linkCompanies = new Set(links.map(l => l.company_id)).size
  if (links.length && tType !== 'own_employee' && tType !== 'linked_external') warnings.push(`統合元は他社 ${linkCompanies}社 に連携されています。統合先は${TYPE_LABEL[tType] || tType}ですが、連携先は統合先の基本情報を参照するようになります。連携を続けない場合は、連携先に取引終了を依頼してください`)
  if (dupCompanies.size) warnings.push(`連携先のうち ${dupCompanies.size}社 には、統合先の人がすでに連携されています。その会社では同じ人が2行のまま残ります（連携先で一方の取引終了が必要です）`)

  // メールアドレス: 統合元のメールは本人確認をしていない（応募フォーム・仮登録）ので、統合先のログイン・再設定用にはコピーしない（#38）
  const srcMail = String(src.unverified_email || src.email || '').trim()
  const tgtMail = String(tgt.email || '').trim()
  const keepMail = !!srcMail && tType !== 'linked_external' && srcMail.toLowerCase() !== tgtMail.toLowerCase() && !String(tgt.unverified_email || '').trim()

  const future = shifts.filter(s => s.work_date >= today && s.status !== 'absent' && !s.reported && s.settle_status !== 'confirmed')
  const settled = shifts.filter(s => s.settle_status === 'confirmed').length
  const srcType = src.affiliation_type || 'own_employee'
  const effects: string[] = [
    `シフト ${counts.shifts}件・勤怠 ${counts.attendance_reports}件・日報 ${counts.daily_reports}件・評価 ${counts.evaluations}件・フォロー ${counts.follow_logs}件・相談 ${counts.consultations}件・書類 ${counts.staff_documents}件を「${tgt.name}」へ移します`,
    ...(counts.attendance_corrections ? [`打刻修正申請 ${counts.attendance_corrections}件${counts.attendance_corrections_pending ? `（うち承認待ち ${counts.attendance_corrections_pending}件）` : ''}を統合先に付け替えます`] : []),
    ...(counts.report_settings ? [`案件ごとの報告設定 ${counts.report_settings}件を統合先に引き継ぎます（統合先に設定がある案件は統合先の設定のまま）`] : []),
    ...(moveRules.length ? [`スタッフ別の単価ルール ${moveRules.length}件を統合先に付け替えます`] : []),
    ...(dropRules.length ? [`統合先と範囲が重なるスタッフ別の単価ルール ${dropRules.length}件は、統合先のルールを残して削除します`] : []),
    ...(counts.recruit_applications ? [`募集の応募 ${counts.recruit_applications}件を統合先に付け替えます`] : []),
    ...(links.length ? [`他社 ${linkCompanies}社 の連携を統合先に引き継ぎます（連携先の基本情報・企業間チャットは統合先のものになります）`] : []),
    future.length ? `今日以降の予定シフト ${future.length}件の単価・支払先を、統合先の区分（${TYPE_LABEL[tType] || tType}）で置き換えます${future.some(s => s.price_locked) ? `（手動で金額を変えた${future.filter(s => s.price_locked).length}件は支払先のみ）` : ''}` : '置き換える予定シフトはありません',
    ...(shifts.length - future.length ? [`過去・報告済み・確定済みのシフト ${shifts.length - future.length}件は金額を変えず、スタッフだけを付け替えます${settled ? `（確定済み ${settled}件を含む）` : ''}`] : []),
    ...(moveEr ? ['統合元の従業員管理のデータを統合先へ移します'] : []),
    ...(srcMail ? [keepMail
      ? `統合元のメールアドレス（${srcMail}）は本人確認をしていないため、統合先のログイン・パスワード再設定には使いません。統合先の「未確認のメール」として残すので、本人に確かめてから「区分・登録状態」の欄で設定してください`
      : `統合元のメールアドレス（${srcMail}）は統合先に引き継ぎません`] : []),
    ...(tType === 'linked_external' ? [`統合先は他社連携のスタッフです。基本情報は所属元（${tgt.owner_company_name || '他社'}）の登録内容を使います`] : []),
    `「${src.name}」は統合済みとして残し（削除しません）、一覧・候補・検索から外します${src.user_role === 'staff' ? '。ログインは使えなくなります' : ''}`,
    '統合は元に戻せません',
  ]
  if (b.dry_run) return c.json({
    source: { staff_id: sid, name: src.name, type: srcType, type_label: TYPE_LABEL[srcType] || srcType },
    target: { staff_id: tgt.staff_id, name: tgt.name, type: tType, type_label: TYPE_LABEL[tType] || tType, owner_company_name: tgt.owner_company_name, inactive: tInactive },
    counts, future_shifts: future.length, effects, warnings,
  })
  if (warnings.length && !b.force) return c.json({ error: '確認が必要な点があります', warnings, need_force: true }, 409)

  // ---- 実行 ----
  const now = nowJST()
  const stmts: D1PreparedStatement[] = [
    db.prepare('UPDATE shifts SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE attendance_reports SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE daily_reports SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE evaluations SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE follow_logs SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE consultations SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE staff_documents SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE shift_report_tokens SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE recruit_applications SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    // 打刻修正申請（承認すると申請の staff_id で勤怠を作るため、承認待ちも含めて付け替える。#10）
    db.prepare('UPDATE attendance_corrections SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    // 報告設定: 統合先に行がない案件 × 種類だけを引き継ぎ、履歴に残してから統合元の行を消す（#10）
    db.prepare(`INSERT INTO report_setting_logs (company_id, project_id, staff_id, report_type, old_enabled, new_enabled, action, batch_id, changed_by, changed_by_name, changed_by_role, created_at)
      SELECT s.company_id, s.project_id, ?, s.report_type, NULL, s.enabled, 'merge', ?, ?, ?, ?, ? ${reportSettingsWhere}`)
      .bind(T, `merge-${sid}-${T}`, u.user_id, u.name || null, u.role || null, now, sid, u.company_id, T),
    db.prepare(`INSERT OR IGNORE INTO project_staff_report_settings (project_id, staff_id, company_id, report_type, enabled, source, updated_by, updated_at)
      SELECT project_id, ?, company_id, report_type, enabled, source, ?, ? FROM project_staff_report_settings WHERE staff_id = ? AND company_id = ?`).bind(T, u.user_id, now, sid, u.company_id),
    db.prepare('DELETE FROM project_staff_report_settings WHERE staff_id = ? AND company_id = ?').bind(sid, u.company_id),
    // 既読率の年度集計は統合元の分を消す（次回の集計で統合先として数え直す）
    db.prepare('DELETE FROM notice_read_staff_reports WHERE staff_id = ?').bind(sid),
  ]
  // 単価ルール: 範囲が重なるものは統合先を優先して統合元を消し、それ以外は付け替える（#499）
  if (dropRules.length) stmts.push(db.prepare(`DELETE FROM rate_rules WHERE company_id = ? AND staff_id = ? AND rule_id IN ${JSON_IN}`).bind(u.company_id, sid, bindJsonArray(dropRules.map(r => r.rule_id))))
  if (moveRules.length) stmts.push(db.prepare(`UPDATE rate_rules SET staff_id = ? WHERE company_id = ? AND staff_id = ? AND rule_id IN ${JSON_IN}`).bind(T, u.company_id, sid, bindJsonArray(moveRules.map(r => r.rule_id))))
  if (moveEr) {
    stmts.push(db.prepare('UPDATE employee_records SET staff_id = ? WHERE staff_id = ?').bind(T, sid))
    stmts.push(db.prepare('UPDATE employee_documents SET staff_id = ? WHERE staff_id = ?').bind(T, sid))
  } else if (srcEr) {
    // 統合元に残す従業員データは、雇用終了の欄で見られるように雇用終了日を入れる（#109）
    stmts.push(db.prepare(`UPDATE employee_records SET employment_ended_at = COALESCE(employment_ended_at, ?), ended_reason = COALESCE(ended_reason, ?), updated_at = ? WHERE staff_id = ?`)
      .bind(endedAt, `統合（統合先: ${tgt.name}）`, now, sid))
  }
  // 他社の連携行の付け替え（#248）。連携元は統合先、雇用元（基本情報の参照先）は統合先またはその雇用元。
  // 人物ID・表示名も統合先にそろえ、統合先の雇用元にログインがあれば連携先でもアプリを使えるようにする（#103）。
  // 連携先の会社に統合先の人の行がすでにある場合は、人物IDは変えない（同じ会社に同じ人物IDの行を2つ作らない）
  if (links.length) {
    stmts.push(db.prepare(`UPDATE staff_profiles SET source_staff_id = CASE WHEN source_staff_id = ? THEN ? ELSE source_staff_id END, root_staff_id = ?
      WHERE affiliation_type = 'linked_external' AND (source_staff_id = ? OR root_staff_id = ?)`).bind(sid, T, newRoot, sid, sid))
    const movable = links.filter(l => !dupCompanies.has(l.company_id))
    if (movable.length && tgt.person_id) {
      const ids = bindJsonArray(movable.map(l => l.staff_id)), uids = bindJsonArray(movable.map(l => l.user_id))
      stmts.push(db.prepare(`UPDATE staff_profiles SET person_id = ? WHERE staff_id IN ${JSON_IN}`).bind(tgt.person_id, ids))
      stmts.push(db.prepare(`UPDATE users SET person_id = ?, name = ? WHERE user_id IN ${JSON_IN}`).bind(tgt.person_id, tgt.name, uids))
      if (rootUser?.role === 'staff' && rootUser?.status === 'active') {
        stmts.push(db.prepare(`UPDATE users SET role = 'staff' WHERE role = 'roster_only' AND status = 'active' AND user_id IN ${JSON_IN}`).bind(uids))
      }
    }
  }
  // 未確認のメールとして統合先に残す（ログイン・再設定には使わない。#38）
  if (keepMail) stmts.push(db.prepare('UPDATE staff_profiles SET unverified_email = ? WHERE staff_id = ?').bind(srcMail, T))
  // 統合元を「統合済み」に。ログインとセッションを無効化
  stmts.push(db.prepare('UPDATE staff_profiles SET merged_into_staff_id = ?, merged_at = ? WHERE staff_id = ?').bind(T, now, sid))
  stmts.push(db.prepare("UPDATE users SET status = 'inactive' WHERE user_id = ?").bind(src.user_id))
  stmts.push(revokeSessionsStmt(db, src.user_id))
  await db.batch(stmts)

  // クライアントのNGスタッフ（カンマ区切り）の付け替え
  const ngs = ((await db.prepare(`SELECT client_id, ng_staff_ids FROM clients WHERE company_id = ? AND (',' || COALESCE(ng_staff_ids,'') || ',') LIKE ?`).bind(u.company_id, `%,${sid},%`).all()).results as any[])
  for (const cl of ngs) {
    const ids = [...new Set(String(cl.ng_staff_ids || '').split(',').map(x => x.trim()).filter(Boolean).map(x => (x === String(sid) ? String(T) : x)))]
    await db.prepare('UPDATE clients SET ng_staff_ids = ? WHERE client_id = ?').bind(ids.join(','), cl.client_id).run()
  }
  // 統合先の空欄を統合元の値で補う（他社連携の基本情報は所属元が正なので触らない）。メールは補わない（上の未確認のメール）
  if (!tgt.phone && src.phone) await db.prepare('UPDATE users SET phone = ? WHERE user_id = ?').bind(src.phone, tgt.user_id).run()
  if (tType !== 'linked_external') {
    await db.prepare(`UPDATE staff_profiles SET kana = COALESCE(NULLIF(kana,''), ?), gender = COALESCE(NULLIF(gender,''), ?) WHERE staff_id = ?`).bind(src.kana || null, src.gender || null, T).run()
  }
  if (src.memo) await db.prepare(`UPDATE staff_profiles SET memo = TRIM(COALESCE(memo,'') || CASE WHEN COALESCE(memo,'') = '' THEN '' ELSE char(10) END || ?) WHERE staff_id = ?`).bind(`［仮登録「${src.name}」から統合］${src.memo}`, T).run()

  // 今日以降の予定シフトの単価・支払先を統合先の区分で置き換える
  const data = future.length ? await loadPricingData(db, u.company_id, future.map(s => s.project_id)) : null
  const payee = { payee_type: payeeTypeFor(tType), payee_affiliation_id: tType === 'partner_manual' ? tgt.partner_affiliation_id ?? null : null, payee_company_id: tType === 'linked_external' ? tgt.owner_company_id ?? null : null }
  for (const s of future) {
    if (s.price_locked) await db.prepare('UPDATE shifts SET payee_type = ?, payee_affiliation_id = ?, payee_company_id = ? WHERE shift_id = ?').bind(payee.payee_type, payee.payee_affiliation_id, payee.payee_company_id, s.shift_id).run()
    else await applyPricingToShift(db, u.company_id, s.shift_id, { data })
  }
  // 記録（付け替えた・削除した単価ルールも残す）
  const moved = {
    ...counts, shift_ids: shifts.map(s => s.shift_id),
    rate_rule_ids: moveRules.map(r => r.rule_id),
    dropped_rate_rules: dropRules.map(({ project_name: _pn, ...r }) => r),
    linked_staff_ids: links.map(l => l.staff_id),
    employee_record: srcEr ? (moveEr ? 'moved' : 'kept_on_source') : null,
  }
  await db.prepare(`INSERT INTO staff_merges (company_id, source_staff_id, target_staff_id, source_name, target_name, moved_json, repriced_shifts, note, merged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, sid, T, src.name, tgt.name, JSON.stringify(moved), future.length, String(b.note || '').slice(0, 300) || null, u.user_id).run()
  await db.prepare(`INSERT INTO staff_affiliation_history (company_id, staff_id, from_type, to_type, effective_date, from_affiliation, to_affiliation, affected_shifts, note, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, T, srcType, tType, today, src.affiliation || null, tgt.affiliation || null, future.length, `仮登録「${src.name}」を統合（シフト${counts.shifts}件）`, u.user_id).run()
  return c.json({ ok: true, target_staff_id: T, moved: counts, repriced_shifts: future.length })
})

// 統合の履歴（スタッフ詳細の表示用）
staffMergeApi.get('/staff/:id/merges', async (c) => {
  const u = c.get('user')
  const rows = ((await c.env.DB.prepare(`SELECT m.*, us.name AS merged_by_name FROM staff_merges m LEFT JOIN users us ON us.user_id = m.merged_by
    WHERE m.company_id = ? AND (m.target_staff_id = ? OR m.source_staff_id = ?) ORDER BY m.created_at DESC`).bind(u.company_id, c.req.param('id'), c.req.param('id')).all()).results as any[])
  return c.json({ merges: rows.map(r => { let moved: any = {}; try { moved = JSON.parse(r.moved_json || '{}') } catch { } delete moved.shift_ids; return { ...r, moved_json: undefined, moved } }) })
})
