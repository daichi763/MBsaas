// =========================================================
// 仮登録スタッフと既存スタッフ（他社連携・自社雇用など）の統合
// docs/spec_spot_shift.md 第5段階
//
// 統合元（仮登録）のシフト・勤怠・日報・評価・フォロー・相談・書類・単価ルール・応募・報告用URLを統合先へ移す。
// 統合元の行は削除せず「統合済み」（merged_into_staff_id）として残し、一覧・候補・検索から外す。ログインは無効化する。
// 適用日（今日）以降の未報告・未確定のシフトは、統合先の区分で単価・支払先を置き換える（手動変更の金額は支払先のみ）。
// 確定済み・報告済みのシフトは金額を変えず、スタッフだけを付け替える。
// =========================================================
import { Hono } from 'hono'
import { applyPricingToShift, conflictFor, findConflicts, loadPricingData } from './shift-board'
import { TYPE_LABEL, normalizePhone, payeeTypeFor } from './staff-lifecycle'

type Bindings = { DB: D1Database }
type Variables = { user: any }
export const staffMergeApi = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function nowJST(): string { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ') }
function todayJST(): string { return nowJST().slice(0, 10) }
const normName = (s: any) => String(s || '').replace(/[\s\u3000]/g, '').toLowerCase()
// ひらがな→カタカナ・空白除去（フリガナの比較用）
const normKana = (s: any) => String(s || '').replace(/[\s\u3000]/g, '').replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))

async function loadStaff(db: D1Database, companyId: number, staffId: any) {
  return db.prepare(`SELECT sp.*, us.name, us.phone, us.email, us.role AS user_role, us.user_code, us.status AS user_status,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana_resolved,
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.gender ELSE sp.gender END AS gender_resolved,
      oc.company_name AS owner_company_name
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = sp.source_staff_id
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
      CASE WHEN sp.affiliation_type = 'linked_external' THEN src.kana ELSE sp.kana END AS kana, oc.company_name AS owner_company_name, pe.global_staff_code,
      (SELECT COUNT(*) FROM shifts sh WHERE sh.staff_id = sp.staff_id AND sh.status IN ('confirmed','substitute')) AS shift_count,
      (SELECT MAX(sh.work_date) FROM shifts sh WHERE sh.staff_id = sp.staff_id AND sh.status IN ('confirmed','substitute')) AS last_work_date
    FROM staff_profiles sp JOIN users us ON us.user_id = sp.user_id
    LEFT JOIN staff_profiles src ON src.staff_id = sp.source_staff_id
    LEFT JOIN companies oc ON oc.company_id = sp.owner_company_id
    LEFT JOIN persons pe ON pe.person_id = sp.person_id
    WHERE sp.company_id = ? AND sp.staff_id != ? AND sp.merged_into_staff_id IS NULL
      AND COALESCE(sp.affiliation_type,'own_employee') != 'skillsheet_only' LIMIT 3000`).bind(u.company_id, s.staff_id).all()).results as any[])
  const phone = normalizePhone(s.phone), name = normName(s.name), kana = normKana(s.kana_resolved)
  const nq = normName(q)
  const out = rows.map(r => {
    const reasons: string[] = []
    if (phone.length >= 10 && normalizePhone(r.phone) === phone) reasons.push('電話番号が同じ')
    if (name && normName(r.name) === name) reasons.push('氏名が同じ')
    if (kana && r.kana && normKana(r.kana) === kana) reasons.push('フリガナが同じ')
    const score = (reasons.includes('電話番号が同じ') ? 4 : 0) + (reasons.includes('氏名が同じ') ? 2 : 0) + (reasons.includes('フリガナが同じ') ? 1 : 0)
    return { ...r, phone: r.affiliation_type === 'linked_external' ? null : r.phone, reasons, score, match_q: !!nq && (normName(r.name).includes(nq) || (r.kana && normKana(r.kana).includes(normKana(q)))) }
  }).filter(r => r.score > 0 || r.match_q)
    .sort((a, b) => b.score - a.score || (b.affiliation_type === 'linked_external' ? 1 : 0) - (a.affiliation_type === 'linked_external' ? 1 : 0) || a.name.localeCompare(b.name, 'ja'))
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
  const shifts = ((await db.prepare(`SELECT s.shift_id, s.project_id, s.slot_role_id, s.work_date, s.start_time, s.end_time, s.status, s.price_locked, s.settle_status, p.project_name,
      (SELECT COUNT(*) FROM attendance_reports a WHERE a.shift_id = s.shift_id) AS reported
    FROM shifts s JOIN projects p ON p.project_id = s.project_id WHERE s.staff_id = ? AND s.company_id = ? ORDER BY s.work_date`).bind(sid, u.company_id).all()).results as any[])
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
  }
  // 重複の確認: 統合先（他社のシフトを含む同一人物）と同じ時間帯・同じ枠
  const active = shifts.filter(s => s.status !== 'absent')
  const warnings: string[] = []
  if (active.length) {
    const dates = active.map(s => s.work_date).sort()
    const cf = await findConflicts(db, u.company_id, [tgt.staff_id], dates[0], dates[dates.length - 1])
    for (const s of active) {
      const list = conflictFor(cf.get(tgt.staff_id), s.work_date, s.start_time, s.end_time)
      if (list.length) warnings.push(`${s.work_date} ${s.start_time}〜${s.end_time} ${s.project_name}: 統合先に同じ時間帯のシフトがあります（${list.map((x: any) => (x.company_id === u.company_id ? x.project_name : x.company_name + '・他社') + ' ' + x.start_time + '〜' + x.end_time).join('、')}）${list.some((x: any) => x.slot_role_id && x.slot_role_id === s.slot_role_id) ? '・同じ枠' : ''}`)
    }
  }
  const srcEr = await db.prepare('SELECT employee_record_id, employment_ended_at FROM employee_records WHERE staff_id = ?').bind(sid).first() as any
  const tgtEr = await db.prepare('SELECT employee_record_id FROM employee_records WHERE staff_id = ?').bind(tgt.staff_id).first() as any
  if (srcEr && tgtEr) warnings.push('統合元と統合先の両方に従業員管理のデータがあります。統合元の従業員データは移さず、そのまま保持します')
  const future = shifts.filter(s => s.work_date >= today && s.status !== 'absent' && !s.reported && s.settle_status !== 'confirmed')
  const settled = shifts.filter(s => s.settle_status === 'confirmed').length
  const srcType = src.affiliation_type || 'own_employee'
  const effects: string[] = [
    `シフト ${counts.shifts}件・勤怠 ${counts.attendance_reports}件・日報 ${counts.daily_reports}件・評価 ${counts.evaluations}件・フォロー ${counts.follow_logs}件・相談 ${counts.consultations}件・書類 ${counts.staff_documents}件を「${tgt.name}」へ移します`,
    ...(counts.rate_rules ? [`スタッフ別の単価ルール ${counts.rate_rules}件を統合先に付け替えます`] : []),
    ...(counts.recruit_applications ? [`募集の応募 ${counts.recruit_applications}件を統合先に付け替えます`] : []),
    future.length ? `今日以降の予定シフト ${future.length}件の単価・支払先を、統合先の区分（${TYPE_LABEL[tType] || tType}）で置き換えます${future.some(s => s.price_locked) ? `（手動で金額を変えた${future.filter(s => s.price_locked).length}件は支払先のみ）` : ''}` : '置き換える予定シフトはありません',
    ...(shifts.length - future.length ? [`過去・報告済み・確定済みのシフト ${shifts.length - future.length}件は金額を変えず、スタッフだけを付け替えます${settled ? `（確定済み ${settled}件を含む）` : ''}`] : []),
    ...(srcEr && !tgtEr ? ['統合元の従業員管理のデータを統合先へ移します'] : []),
    ...(tType === 'linked_external' ? [`統合先は他社連携のスタッフです。基本情報は所属元（${tgt.owner_company_name || '他社'}）の登録内容を使います`] : []),
    `「${src.name}」は統合済みとして残し（削除しません）、一覧・候補・検索から外します${src.user_role === 'staff' ? '。ログインは使えなくなります' : ''}`,
    '統合は元に戻せません',
  ]
  if (b.dry_run) return c.json({
    source: { staff_id: sid, name: src.name, type: srcType, type_label: TYPE_LABEL[srcType] || srcType },
    target: { staff_id: tgt.staff_id, name: tgt.name, type: tType, type_label: TYPE_LABEL[tType] || tType, owner_company_name: tgt.owner_company_name },
    counts, future_shifts: future.length, effects, warnings,
  })
  if (warnings.length && !b.force) return c.json({ error: '確認が必要な点があります', warnings, need_force: true }, 409)

  // ---- 実行 ----
  const T = tgt.staff_id
  const stmts: D1PreparedStatement[] = [
    db.prepare('UPDATE shifts SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE attendance_reports SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE daily_reports SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE evaluations SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE follow_logs SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE consultations SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE staff_documents SET staff_id = ? WHERE staff_id = ?').bind(T, sid),
    db.prepare('UPDATE rate_rules SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE shift_report_tokens SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    db.prepare('UPDATE recruit_applications SET staff_id = ? WHERE staff_id = ? AND company_id = ?').bind(T, sid, u.company_id),
    // 既読率の年度集計は統合元の分を消す（次回の集計で統合先として数え直す）
    db.prepare('DELETE FROM notice_read_staff_reports WHERE staff_id = ?').bind(sid),
  ]
  if (srcEr && !tgtEr) {
    stmts.push(db.prepare('UPDATE employee_records SET staff_id = ? WHERE staff_id = ?').bind(T, sid))
    stmts.push(db.prepare('UPDATE employee_documents SET staff_id = ? WHERE staff_id = ?').bind(T, sid))
  }
  // 統合元を「統合済み」に。ログインとセッションを無効化
  stmts.push(db.prepare('UPDATE staff_profiles SET merged_into_staff_id = ?, merged_at = ? WHERE staff_id = ?').bind(T, nowJST(), sid))
  stmts.push(db.prepare("UPDATE users SET status = 'inactive' WHERE user_id = ?").bind(src.user_id))
  stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(src.user_id))
  await db.batch(stmts)

  // クライアントのNGスタッフ（カンマ区切り）の付け替え
  const ngs = ((await db.prepare(`SELECT client_id, ng_staff_ids FROM clients WHERE company_id = ? AND (',' || COALESCE(ng_staff_ids,'') || ',') LIKE ?`).bind(u.company_id, `%,${sid},%`).all()).results as any[])
  for (const cl of ngs) {
    const ids = [...new Set(String(cl.ng_staff_ids || '').split(',').map(x => x.trim()).filter(Boolean).map(x => (x === String(sid) ? String(T) : x)))]
    await db.prepare('UPDATE clients SET ng_staff_ids = ? WHERE client_id = ?').bind(ids.join(','), cl.client_id).run()
  }
  // 統合先の空欄を統合元の値で補う（他社連携の基本情報は所属元が正なので触らない）
  if (!tgt.phone && src.phone) await db.prepare('UPDATE users SET phone = ? WHERE user_id = ?').bind(src.phone, tgt.user_id).run()
  if (!tgt.email && src.email) await db.prepare('UPDATE users SET email = ? WHERE user_id = ?').bind(src.email, tgt.user_id).run()
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
  // 記録
  await db.prepare(`INSERT INTO staff_merges (company_id, source_staff_id, target_staff_id, source_name, target_name, moved_json, repriced_shifts, note, merged_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.company_id, sid, T, src.name, tgt.name, JSON.stringify({ ...counts, shift_ids: shifts.map(s => s.shift_id) }), future.length, String(b.note || '').slice(0, 300) || null, u.user_id).run()
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
