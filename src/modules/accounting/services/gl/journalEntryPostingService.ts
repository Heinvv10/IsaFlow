/** Shared journal writers: authenticated control gate before any financial effect. */
import { randomUUID } from 'node:crypto';
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { JournalEntry } from '../../types/gl.types';
import { mapEntryRow } from './journalEntryCrudService';
import { defaultHumanMeta, actorMeta, type PostingActorOpts } from './journalEntryMeta';
import { runJournalControl, type JournalControlOptions } from './journalControlService';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
import type { ApMaterial } from '../controls/apOperationMaterializer';
import { isAuthorizedYearEndPosting } from '../controls/yearEndPostingGuard';
export { resolveReversalDate } from './journalReversalDate';
export type { JournalControlOptions } from './journalControlService';
type Row = DbRow;
export class ClosedFiscalPeriodError extends Error {
  readonly periodStatus: string;
  constructor(periodStatus: string) { super(`Cannot post to ${periodStatus} fiscal period`); this.name = 'ClosedFiscalPeriodError'; this.periodStatus = periodStatus; }
}
export class InactiveAccountError extends Error {
  readonly accounts: string[];
  constructor(accounts: { code: string; name: string }[]) {
    super(`Cannot post to deactivated GL account${accounts.length === 1 ? '' : 's'}: ${accounts.map(a => `${a.code} ${a.name}`).join(', ')}. Reactivate the account, or recode the line to an active one.`);
    this.name = 'InactiveAccountError'; this.accounts = accounts.map(a => a.code);
  }
}
/** Kept for legacy direct writers; the controlled posting path locks and validates the complete population. */
export async function assertNoInactiveAccountLines(companyId: string, entryId: string): Promise<void> {
  const rows = await sql`SELECT DISTINCT ga.account_code,ga.account_name FROM gl_journal_lines jl
    JOIN gl_accounts ga ON ga.id=jl.gl_account_id AND ga.company_id=jl.company_id
    WHERE jl.journal_entry_id=${entryId} AND jl.company_id=${companyId}::uuid AND ga.is_active=false
    ORDER BY ga.account_code` as Row[];
  if (rows.length) throw new InactiveAccountError(rows.map(r => ({ code: String(r.account_code), name: String(r.account_name) })));
}
function facts(material: ApMaterial): { header: Row; targetPeriod: Row; company: Row; accounts: Row[]; vatLocks: Row[] } {
  return material.observedSources.find(s => s.entityType === 'journal_entry' && s.entityId === material.binding.entityId)!.facts as
    { header: Row; targetPeriod: Row; company: Row; accounts: Row[]; vatLocks: Row[] };
}
function assertPostingGuards(material: ApMaterial, authorizedYearEnd = false): ReturnType<typeof facts> {
  const state = facts(material);
  if (state.targetPeriod.status !== 'open' && !(authorizedYearEnd && state.targetPeriod.status === 'closed')) {
    throw new ClosedFiscalPeriodError(String(state.targetPeriod.status));
  }
  if (state.company.lockdown_enabled === true && (!state.company.lockdown_date
    || material.binding.accountingDate! <= String(state.company.lockdown_date))) throw new Error('Journal date is within company lockdown');
  if (state.vatLocks.length) throw new Error('Journal date is within a filed VAT period');
  const inactive = state.accounts.filter(a => a.is_active !== true);
  if (inactive.length) throw new InactiveAccountError(inactive.map(a => ({ code: String(a.account_code), name: String(a.account_name) })));
  return state;
}
export async function postJournalEntry(companyId: string, id: string, userId: string, opts?: JournalControlOptions): Promise<JournalEntry> {
  return runJournalControl(companyId, userId, { entityType: 'journal_entry', entityId: id, operation: 'journal.post' }, opts,
    async (ctx, material, parent) => {
      const state = facts(material);
      const authorizedYearEnd = isAuthorizedYearEndPosting(ctx, parent, state.header, state.targetPeriod, material.binding.accountingDate!);
      const { header } = assertPostingGuards(material, authorizedYearEnd);
      if (header.status !== 'draft') throw new Error(`Cannot post entry with status: ${header.status}`);
      const rows = await ctx.sql`UPDATE gl_journal_entries SET status='posted',posted_by=${ctx.principal.personId}::uuid,posted_at=clock_timestamp()
        WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='draft' RETURNING *` as Row[];
      if (rows.length !== 1) throw new Error('Journal posting state changed');
      log.info('Posted journal entry', { id }, 'accounting');
      // Legacy mapper uses undefined for absent optional API fields; omit them from the durable JSON result.
      return Object.fromEntries(Object.entries(mapEntryRow(rows[0]!)).filter(([, value]) => value !== undefined)) as unknown as JournalEntry;
    });
}
/** Contra lines are copied in SQL, retaining exact cents and every classification without Number conversion. */
export async function reverseJournalEntry(companyId: string, id: string, userId: string,
  opts?: PostingActorOpts & JournalControlOptions & { reversalDate?: string }): Promise<JournalEntry> {
  const ref = { entityType: 'journal_entry', entityId: id, operation: 'journal.reverse' as const,
    ...(opts?.reversalDate === undefined ? {} : { reversalDate: opts.reversalDate }) };
  return runJournalControl(companyId, userId, ref, opts, async (ctx, material, parentControl) => {
    const { header, targetPeriod } = assertPostingGuards(material);
    if (header.status !== 'posted') throw new Error('Can only reverse posted entries');
    if (header.reversed_at) throw new Error('Journal entry already reversed');
    const contraId = randomUUID(), meta = actorMeta(opts) ?? defaultHumanMeta(ctx.principal.personId);
    const sourceRecord = parentControl.parent.entityType === 'journal_entry' ? null : parentControl.parent.entityId;
    const rows = await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,
      source_record_id,reversal_of_id,created_by,posting_agent,source_document_hash,extraction_confidence,actor_type,actor_token_jti)
      VALUES(${contraId}::uuid,${companyId}::uuid,${material.binding.accountingDate}::date,${String(targetPeriod.id)}::uuid,
        ${`Reversal of ${id}`},${header.source},${sourceRecord}::uuid,${id}::uuid,${ctx.principal.personId}::uuid,
        ${meta.postingAgent},${meta.sourceDocumentHash ?? null},${meta.extractionConfidence ?? null},${meta.actorType ?? null},${meta.actorTokenJti ?? null}) RETURNING *` as Row[];
    if (rows.length !== 1) throw new Error('Reversal journal could not be created');
    await ctx.sql`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit,description,project_id,cost_center_id,bu_id,vat_type)
      SELECT ${contraId}::uuid,company_id,gl_account_id,credit,debit,'Reversal: ' || COALESCE(description,''),project_id,cost_center_id,bu_id,vat_type
      FROM gl_journal_lines WHERE company_id=${companyId}::uuid AND journal_entry_id=${id}::uuid`;
    await registerGeneratedJournal(ctx, parentControl, contraId, 'journal.post');
    const reversal = await postJournalEntry(companyId, contraId, userId, { parentControl });
    const updated = await ctx.sql`UPDATE gl_journal_entries SET reversed_by=${ctx.principal.personId}::uuid,reversed_at=clock_timestamp()
      WHERE company_id=${companyId}::uuid AND id=${id}::uuid AND status='posted' AND reversed_at IS NULL RETURNING id`;
    if (updated.length !== 1) throw new Error('Journal reversal state changed');
    log.info('Reversed journal entry', { originalId: id, reversalId: contraId }, 'accounting');
    return reversal;
  });
}
