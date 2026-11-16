/**
 * Which previewed lines a confirm would PREDICTABLY refuse (WP6 round 2), decided read-only so the preview lists only
 * lines that can post, and says why the others are held. A confirm still re-decides every line under its lock; this
 * only stops the screen promising what the service will refuse.
 *
 *  - dropped silently, counted in `excluded`: a target account that is inactive, missing, a bank account (that is a
 *    transfer, row 5's) or AP/AR control; a line a reconciliation session holds; a date in a closed fiscal period, or in
 *    a month with no period that the single accept would NOT create (outside the auto-create window: `noPeriod`; inside
 *    it the confirm creates the period, exactly as the single accept does, so the line is let through); a standard-rated line in a locked VAT period; a VAT code the allocation refuses;
 *  - listed apart as `needsAttention`, not as postable: a line the caller imported themself under an enforced rule
 *    (someone else must allocate it) and a hand-keyed line a manual-journal rule holds for approval.
 *
 * The VAT shown is the EFFECTIVE one: the same `resolveRuleVatCode` the confirm runs, so a denied or no-supply account
 * previews as 'none' and the amounts are what will post.
 */
import type { DbRow } from '@/lib/neon';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';
import { isBankSubtype } from '../gl/accountSubtypes';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { findActiveVatLock } from '../gl/journalVatLockGuard';
import { isOutsideWindowByCalendarYear } from '../gl/fiscalPeriodAutoCreate';
import { isBankEvidenced } from '../ap/bankLinePaymentGate';
import { sql } from '@/lib/neon';
import { BALANCE_SHEET_LEAF_LEVEL, LEAF_RULE_ACCOUNT_TYPES } from '../gl/isReportVisibleLeaf';
import { contactControlAccountIds } from './contactControlGuard';
import { importerAllocationRefusal, importerArmOf } from './bankLineImporterGate';
import { handKeyedLineJournalRefusal } from './bankLineJournalGate';
import { vatInclusiveSplit } from './bankVatInclusive';

export interface ScreenedLine { row: DbRow; effectiveVatCode: string; netAmount: number; vatAmount: number }
export interface NeedsAttention { id: string; kind: 'importer' | 'approval'; reason: string }
export type ExcludedCounts = Record<'badTarget' | 'reconciliationHeld' | 'periodClosed' | 'noPeriod' | 'vatLocked' | 'vatCode', number>;

/**
 * Targets the writer refuses outright: the late-claim clearing account (lateClaimClearingGuard) and a balance-sheet header
 * with sub-accounts (headerAccountGuard, the same test: leaf-rule type, level below the leaf level or NULL, has a child).
 * Read-only here (the guard itself takes row locks, which a preview must not).
 */
async function unpostableTargetIds(companyId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT ga.id::TEXT AS id FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}::UUID AND ga.id = ANY(${ids}::UUID[])
      AND (ga.account_subtype = 'vat_input_late_claim'
        OR (ga.account_type = ANY(${[...LEAF_RULE_ACCOUNT_TYPES]}::TEXT[])
            AND (ga.level IS NULL OR ga.level < ${BALANCE_SHEET_LEAF_LEVEL})
            AND EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ${companyId}::UUID)))`) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/** `stopAt`: stop screening once that many lines are postable (the caller needs no more); `stoppedAt` is the id of the row that reached it. */
export async function screenCandidates(companyId: string, userId: string, rows: DbRow[], stopAt = Number.POSITIVE_INFINITY): Promise<{
  postable: ScreenedLine[]; needsAttention: NeedsAttention[]; excluded: ExcludedCounts; stoppedAt: string | null;
}> {
  const excluded: ExcludedCounts = { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 };
  const postable: ScreenedLine[] = [];
  const needsAttention: NeedsAttention[] = [];
  const control = await contactControlAccountIds(companyId, [...new Set(rows.map((r) => String(r.gl)))]);
  const refused = await unpostableTargetIds(companyId, [...new Set(rows.map((r) => String(r.gl)))]);
  const periods = new Map<string, string>();
  // The importer check depends on the line's batch and feed, not on the line: asked once per batch.
  const importerByBatch = new Map<string, Awaited<ReturnType<typeof importerAllocationRefusal>>>();
  for (const row of rows) {
    const gl = String(row.gl);
    if (control.has(gl.toLowerCase()) || refused.has(gl.toLowerCase()) || isBankSubtype(row.account_subtype == null ? null : String(row.account_subtype))
      || gl === String(row.bank_account_id)) { excluded.badTarget += 1; continue; }
    if (row.reconciliation_id != null) { excluded.reconciliationHeld += 1; continue; }
    const date = String(row.date);
    if (!periods.has(date)) periods.set(date, await getPeriodStatusForDate(companyId, date));
    const period = periods.get(date);
    if (period === 'closed') { excluded.periodClosed += 1; continue; }
    if (period === 'no_period' && isOutsideWindowByCalendarYear(date)) { excluded.noPeriod += 1; continue; }
    let effective: string;
    try {
      const requested = row.vat == null ? 'none' : String(row.vat);
      const guarded = await resolveRuleVatCode({
        allocType: 'account', companyId, requestedVatCode: requested, glAccountId: gl,
        denialContext: { bankTxId: String(row.id), source: 'bulk_accept_preview' },
        guardContext: { bankTxId: String(row.id), ruleName: 'bulk accept preview' },
      });
      effective = guarded.denied || guarded.nonSupplyCoerced ? guarded.vatCode : requested;
    } catch { excluded.vatCode += 1; continue; }
    if (effective === 'standard' && await findActiveVatLock(companyId, date)) { excluded.vatLocked += 1; continue; }
    const amount = Number(row.amount);
    const arm = importerArmOf('account', null, amount);
    let importer = null as Awaited<ReturnType<typeof importerAllocationRefusal>>;
    if (arm) {
      const key = `${String(row.import_batch_id ?? '')}|${String(row.bank_feed_connection_id ?? '')}|${arm}`;
      if (!importerByBatch.has(key)) importerByBatch.set(key, await importerAllocationRefusal(companyId, row, userId, arm));
      importer = importerByBatch.get(key) ?? null;
    }
    if (importer) { needsAttention.push({ id: String(row.id), kind: 'importer', reason: importer.message }); continue; }
    const held = isBankEvidenced(row) ? null : await handKeyedLineJournalRefusal(companyId, Math.abs(amount));
    if (held) { needsAttention.push({ id: String(row.id), kind: 'approval', reason: held.message }); continue; }
    const split = vatInclusiveSplit(Math.abs(amount), effective === 'standard');
    postable.push({ row, effectiveVatCode: effective, netAmount: split.netAmount, vatAmount: split.vatAmount });
    if (postable.length >= stopAt) return { postable, needsAttention, excluded, stoppedAt: String(row.id) };
  }
  return { postable, needsAttention, excluded, stoppedAt: null };
}
