import {readHistoricalJournalRelationship} from '../controls/historicalJournalRelationship';
import {assertGeneratedJournalMoney} from '../controls/generatedJournalMoney';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';
import { isRealCalendarDate } from '@/lib/validation';
import { requireControlTx } from '../controls/context';
import { executeControlledOperation } from '../controls/approvalExecutionService';
import { assertGeneratedJournal, type ParentJournalControl } from '../controls/generatedJournalPermit';
import { materializeGlOperation } from '../controls/glOperationMaterializer';
import { initializeOperationObservations } from '../controls/approvalRequestService';
import { recordCommittedChange } from '../controls/changeEventService';
import { postingPeriodBlock, throwPostingBlock } from './postingPeriodGuard';
import { journalAffectsVatReturn } from '../controls/journalVatFootprint';
import type { ApMaterial } from '../controls/apOperationMaterializer';
import type { ControlTx, OperationRef } from '../controls/contracts';
export interface JournalControlOptions { approvalId?: string | null; parentControl?: ParentJournalControl }
function poison(error: unknown): never {
  const store = als.getStore();
  if (store) store.controlWriteFailed = true;
  throw error;
}
export async function runJournalControl<T>(companyId: string, userId: string, ref: OperationRef, opts: JournalControlOptions | undefined,
  effect: (ctx: ControlTx, material: ApMaterial, parent: ParentJournalControl) => Promise<T>): Promise<T> {
  let ctx: ControlTx, parent: ParentJournalControl | undefined;
  try {
    ctx = requireControlTx();
    if (ctx.principal.companyId !== companyId || ctx.principal.personId !== userId) throw new Error('Journal context does not match authenticated person and tenant');
    parent = opts?.parentControl;
    // Generated financial families must use their own approval and subledger lifecycle — an INTEGRITY check, not a
    // refusal a caller can safely catch and continue past: a caller that swallows this per row and keeps going
    // (migrationApService.ts, migrationImportService.ts) must not COMMIT whatever it wrote before this call, so it
    // stays inside this poisoning try along with the tenant-mismatch check above.
    if (!parent) await assertDirectJournalOperation(ctx, ref);
  } catch (error) { poison(error); }
  // A lockdown or closed-period refusal for a DIRECT (no parentControl) post or reverse, thrown HERE, before
  // executeControlledOperation opens the controlled write, and OUTSIDE both poisoning try/catch blocks:
  // assertPostingGuards throws the exact same rule from inside that write, and firing it there — even when the
  // caller catches it — marks this request's control transaction failed regardless (the poison above and below),
  // which withAuth then turns into a 500 CONTROL_INTEGRITY_FAILED no matter what the caller does. Unlike the two
  // checks above, this one IS safe for a caller to catch and continue past (bankRuleAutoPostLine.ts already does,
  // deleting the draft and returning normally) — it refuses a business state, not an integrity fault. A direct
  // call's parent is always `{permit, parent: effectiveRef}` with effectiveRef.entityType 'journal_entry' — never
  // 'fiscal_year' or 'historical_import' (only the generated-journal branch below can carry those) — so
  // authorizedClosedPeriod is always false here, exactly what assertPostingGuards would also compute for this
  // call. This is a read-only precheck against a separate snapshot of the same rows the controlled write re-reads
  // and re-checks under lock, which stays the backstop for the TOCTOU window between the two.
  if (!parent) await assertDirectPostingPeriodOk(ctx, ref);
  try {
    if (!parent) return await executeControlledOperation(ctx, ref, opts?.approvalId ?? null, async permit => {
      // The control kernel freezes the target date before its callback, including midnight boundaries.
      const effectiveRef = ref.operation === 'journal.reverse'
        ? { ...ref, reversalDate: permit.accountingDate }
        : ref;
      const material = await materializeGlOperation(ctx, effectiveRef);
      const header = material.observedSources.find(s => s.entityType === ref.entityType && s.entityId === ref.entityId)!.facts as {header:{source:string}};
      assertDirectSource(header.header.source);
      return effect(ctx, material, { permit, parent: effectiveRef });
    });
    assertGeneratedJournal(ctx, parent, ref.entityId, ref.operation as 'journal.post' | 'journal.reverse');
    if (ref.operation === 'journal.reverse' && ref.reversalDate !== undefined && ref.reversalDate !== parent.permit.accountingDate) {
      throw new Error('Journal reversal date does not match the approved parent');
    }
    const effectiveRef = ref.operation === 'journal.reverse' ? { ...ref, reversalDate: parent.permit.accountingDate } : ref;
    return await withSavepoint('controlled_generated_journal', async () => {
      const material = await materializeGlOperation(ctx, effectiveRef);
      if(parent.parent.operation==='historical_import.post'&&(await readHistoricalJournalRelationship(ctx,parent,ref.entityId,ref.operation as 'journal.post'|'journal.reverse')).length!==1){
        throw new Error('Historical journal no longer matches its approved source plan');
      }
      assertGeneratedJournalMoney(parent.permit,material.binding);
      await initializeOperationObservations(ctx, material);
      const result = await effect(ctx, material, parent);
      const after = await materializeGlOperation(ctx, { ...ref,
        ...(ref.operation === 'journal.reverse' ? { reversalDate: material.binding.accountingDate! } : {}) });
      const facts = (value: ApMaterial) => value.observedSources.find(s => s.entityType === ref.entityType && s.entityId === ref.entityId)!.facts;
      await recordCommittedChange(ctx, { entityType: ref.entityType, entityId: ref.entityId,
        previousVersion: material.binding.entityVersion, newVersion: material.binding.entityVersion + 1,
        action: ref.operation, accountingDate: material.binding.accountingDate, before: facts(material), after: facts(after),
        bindingHash: null, protectedEvidenceRef: null, operationId: parent.permit.operationId });
      return result;
    });
  } catch (error) { poison(error); }
}

/** Generated financial families must use their own approval and subledger lifecycle. */
async function assertDirectJournalOperation(ctx:ControlTx,ref:OperationRef):Promise<void> {
  const [header]=await ctx.sql`SELECT source FROM gl_journal_entries
    WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid` as {source:string}[];
  if(header) assertDirectSource(header.source);
}
type Row = Record<string, unknown>;
/**
 * Reads the same period-and-lockdown facts materializeGlOperation would (company lockdown, the entry's own fiscal
 * period, and — for a reversal with no explicit reversalDate — the same open/closed fallback to today JHB), and
 * throws the SAME error classes assertPostingGuards throws from postingPeriodBlock. Returns silently, leaving the
 * controlled write to answer, whenever the entry, its company row or a covering fiscal period cannot be read
 * cleanly (absent, ambiguous, or an invalid supplied reversalDate) — those are fault cases, not a refusal this
 * function owns, and duplicating their exact wording here would give the precheck and the write two answers that
 * can drift.
 */
async function assertDirectPostingPeriodOk(ctx: ControlTx, ref: OperationRef): Promise<void> {
  const companyId = ctx.principal.companyId;
  const [header] = await ctx.sql`SELECT entry_date::text AS entry_date FROM gl_journal_entries
    WHERE company_id=${companyId}::uuid AND id=${ref.entityId}::uuid` as Row[];
  const [company] = await ctx.sql`SELECT lockdown_enabled,lockdown_date::text AS lockdown_date FROM companies
    WHERE id=${companyId}::uuid` as Row[];
  if (!header || typeof header.entry_date !== 'string' || !company) return;
  const originalDate = header.entry_date;
  const periodAt = async (date: string) => {
    const rows = await ctx.sql`SELECT status FROM fiscal_periods
      WHERE company_id=${companyId}::uuid AND start_date<=${date}::date AND end_date>=${date}::date` as Row[];
    return rows.length === 1 ? rows[0] : null;
  };
  const originalPeriod = await periodAt(originalDate);
  let accountingDate = originalDate;
  if (ref.operation === 'journal.reverse') {
    const requested = ref.reversalDate;
    if (requested !== undefined) {
      if (!isRealCalendarDate(requested) || requested < originalDate) return;
      accountingDate = requested;
    } else {
      if (!originalPeriod || typeof originalPeriod.status !== 'string') return;
      if (originalPeriod.status === 'open') accountingDate = originalDate;
      else {
        const [clock] = await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as Row[];
        if (!clock || typeof clock.day !== 'string') return;
        accountingDate = clock.day;
      }
    }
  }
  const targetPeriod = accountingDate === originalDate ? originalPeriod : await periodAt(accountingDate);
  if (!targetPeriod || typeof targetPeriod.status !== 'string') return;
  throwPostingBlock(postingPeriodBlock(targetPeriod.status, company, accountingDate, false),
    await vatPeriodLocked(ctx, ref.entityId, accountingDate));
}
/**
 * The filed-VAT-period half of the same precheck: assertPostingGuards refuses a date inside `vat_period_locks` only
 * when the journal touches the VAT201 population (`journalAffectsVatReturn`, the ONE predicate, read here over the
 * same lines and accounts materializeGlOperation reads). Returns false — leaving the write to answer — when a line's
 * account cannot be read, for the same reason the caller does.
 */
async function vatPeriodLocked(ctx: ControlTx, entryId: string, accountingDate: string): Promise<boolean> {
  const companyId = ctx.principal.companyId;
  const lines = await ctx.sql`SELECT gl_account_id,vat_type FROM gl_journal_lines
    WHERE company_id=${companyId}::uuid AND journal_entry_id=${entryId}::uuid` as Row[];
  if (!lines.length) return false;
  const accounts = await ctx.sql`SELECT id,account_type,account_subtype FROM gl_accounts
    WHERE company_id=${companyId}::uuid AND id=ANY(${lines.map(line => String(line.gl_account_id))}::uuid[])` as Row[];
  if (accounts.length !== new Set(lines.map(line => line.gl_account_id)).size) return false;
  if (!journalAffectsVatReturn(lines, accounts)) return false;
  const locks = await ctx.sql`SELECT id FROM vat_period_locks WHERE company_id=${companyId}::uuid
    AND period_start<=${accountingDate}::date AND period_end>=${accountingDate}::date` as Row[];
  return locks.length > 0;
}
function assertDirectSource(source:string):void {
  if(new Set(['auto_invoice','auto_payment','auto_credit_note','auto_supplier_invoice','auto_supplier_payment',
    'auto_batch_payment','auto_depreciation','auto_payroll','auto_bank_transfer','auto_bank_recon','year_end','auto_gl_import']).has(source)) {
    throw new Error('Generated journal must be changed through its authorized domain operation');
  }
}
