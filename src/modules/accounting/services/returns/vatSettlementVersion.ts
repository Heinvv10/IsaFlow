/**
 * What a VAT settlement is posted against (wave 6 VR, §0a.12), judged before submitVATReturn writes anything.
 *
 *   - the live (finalised or filed) VAT201 version for EXACTLY the period, row-locked FOR SHARE so an amend cannot
 *     supersede it before the settlement commits, whose VAT period lock is still active (as fileReturn requires):
 *     409 otherwise;
 *   - no settlement of a period that only overlaps this one (a VAT category change): 409;
 *   - what the period already settled (every vat_returns row for exactly the period): a version that already has its
 *     own settlement is refused by the caller; otherwise the caller posts only the difference (a top-up after an amend).
 *
 * Lock order: the VAT key SHARED first, then the version row. An amend takes the VAT key exclusive, then the version
 * FOR UPDATE, so the two queue on the key instead of deadlocking (the settlement's journal re-takes the shared key).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { takeVatLockShared } from '../gl/journalVatLockGuard';
import { ReturnRefusal } from './returnVersionTypes';

export interface VatFiguresAt { outputTax: number; inputTax: number; netVat: number }
export interface SettledVersion extends VatFiguresAt { id: string; versionNo: number; status: 'finalised' | 'filed' }
export interface SettlementBasis {
  version: SettledVersion;
  /** Sum of every settlement already recorded for exactly this period (any version, or none). */
  prior: VatFiguresAt & { count: number };
  /** True when a settlement already names this version. */
  versionSettled: boolean;
}

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function settlementBasis(companyId: string, periodStart: string, periodEnd: string): Promise<SettlementBasis> {
  await takeVatLockShared(companyId);
  const rows = (await sql`
    SELECT v.id, v.version_no, v.status, v.figures, l.id AS lock_id, l.unlocked_at
      FROM tax_return_versions v
      LEFT JOIN vat_period_locks l ON l.id = v.vat_period_lock_id AND l.company_id = v.company_id
     WHERE v.company_id = ${companyId}::UUID AND v.form_type = 'VAT201'
       AND v.period_start = ${periodStart}::DATE AND v.period_end = ${periodEnd}::DATE
       AND v.status IN ('finalised', 'filed')
       FOR SHARE OF v
  `) as DbRow[];
  const r = rows[0];
  if (!r) {
    throw new ReturnRefusal(409,
      `Finalise the VAT201 for ${periodStart} to ${periodEnd} first. A VAT settlement is posted against a finalised `
      + 'or filed return for exactly that period.', 'VAT201_NOT_FINALISED');
  }
  if (r.lock_id == null || r.unlocked_at != null) {
    throw new ReturnRefusal(409,
      'The VAT period lock of this return was removed outside the return lifecycle. Amend the return, finalise it '
      + 'again, then settle.', 'VAT201_LOCK_RELEASED');
  }
  const f = (r.figures ?? {}) as Record<string, unknown>;
  const version: SettledVersion = {
    id: String(r.id), versionNo: Number(r.version_no), status: r.status as SettledVersion['status'],
    outputTax: num(f.outputTax), inputTax: num(f.inputTax), netVat: num(f.netVat),
  };

  const settled = (await sql`
    SELECT COUNT(*) FILTER (WHERE NOT (period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE)) AS overlapping,
           COUNT(*) FILTER (WHERE period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE) AS same,
           COUNT(*) FILTER (WHERE return_version_id = ${version.id}::UUID) AS mine,
           COALESCE(SUM(total_output_tax) FILTER (WHERE period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE), 0) AS output_tax,
           COALESCE(SUM(total_input_tax) FILTER (WHERE period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE), 0) AS input_tax,
           COALESCE(SUM(net_vat) FILTER (WHERE period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE), 0) AS net_vat
      FROM vat_returns
     WHERE company_id = ${companyId}::UUID AND period_start <= ${periodEnd}::DATE AND period_end >= ${periodStart}::DATE
  `) as DbRow[];
  const s = settled[0] ?? {};
  if (num(s.overlapping) > 0) {
    throw new ReturnRefusal(409,
      `A VAT settlement is already recorded for a period that overlaps ${periodStart} to ${periodEnd} (the VAT `
      + 'category changed). Settle that difference by hand; nothing was posted.', 'VAT_SETTLEMENT_PERIOD_OVERLAP');
  }
  return {
    version,
    prior: { outputTax: num(s.output_tax), inputTax: num(s.input_tax), netVat: num(s.net_vat), count: num(s.same) },
    versionSettled: num(s.mine) > 0,
  };
}
