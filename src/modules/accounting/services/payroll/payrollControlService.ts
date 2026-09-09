import { readPayrollPostingReceipt } from './payrollPostingReceipt';
import { randomUUID } from 'node:crypto';
import { requireControlTx } from '../controls/context';
import { executeControlledOperation } from '../controls/approvalExecutionService';
import { materializePayrollOperation } from '../controls/payrollOperationMaterializer';
import { registerGeneratedJournal } from '../controls/generatedJournalPermit';
import { postJournalEntry, reverseJournalEntry } from '../gl/journalEntryPostingService';
import { defaultHumanMeta } from '../gl/journalEntryMeta';
import { mapRunRow, type PayrollRunSummary } from './payrollRunService';
import type { ExactPayrollLine } from '../controls/payrollExactPlan';
import type { PayrollRow } from '../controls/payrollSourceMaterial';
export interface PayrollControlOptions { approvalId?: string; postingAgent?: string; reversalDate?: string; reason?: string }
export interface PayrollPostResult { run: PayrollRunSummary; journalEntryId: string }
export function requirePayrollActor(companyId: string, userId: string) {
  const ctx = requireControlTx();
  if (ctx.principal.companyId !== companyId || ctx.principal.personId !== userId) throw new Error('Payroll actor does not match authenticated context');
  return ctx;
}
export async function executePayrollPost(companyId: string, runId: string, userId: string, opts?: PayrollControlOptions): Promise<PayrollPostResult> {
  const ctx = requirePayrollActor(companyId,userId);
  if (opts?.reversalDate !== undefined) throw new Error('Reversal date only applies to payroll reopen');
  if(!opts?.approvalId){const existing=await readPayrollPostingReceipt(ctx,runId);if(existing)return existing;}
  const ref = {entityType:'payroll_run',entityId:runId,operation:'payroll_run.post' as const};
  return executeControlledOperation(ctx,ref,opts?.approvalId ?? null,async permit=>{
    const material = await materializePayrollOperation(ctx,ref);
    const {header,plan,targetPeriod,journal} = material.observedSources[0]!.facts as {
      header:PayrollRow;plan:{lines:ExactPayrollLine[]};targetPeriod:PayrollRow;journal:{header:PayrollRow}|null };
    if (!['draft','calculated','processed','approved'].includes(String(header.status))) throw new Error('Payroll run is not approvable');
    if (journal && journal.header.reversed_at == null) {
      if (journal.header.status !== 'posted' || header.status !== 'approved') throw new Error('Payroll journal state is inconsistent');
      throw new Error('Payroll run already posted; use its existing posting receipt');
    }
    const journalEntryId=randomUUID(), meta=defaultHumanMeta(userId);
    await ctx.sql`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,source_record_id,created_by,posting_agent)
      VALUES(${journalEntryId}::uuid,${companyId}::uuid,${permit.accountingDate}::date,${String(targetPeriod.id)}::uuid,
        'Payroll run','auto_payroll',${runId}::uuid,${userId}::uuid,${opts?.postingAgent ?? meta.postingAgent})`;
    for (const line of plan.lines) await ctx.sql`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
      VALUES(${companyId}::uuid,${journalEntryId}::uuid,${line.glAccountId}::uuid,${line.debit}::numeric,${line.credit}::numeric,${line.description})`;
    const parentControl={permit,parent:ref};
    await registerGeneratedJournal(ctx,parentControl,journalEntryId,'journal.post');
    await postJournalEntry(companyId,journalEntryId,userId,{parentControl});
    const [updated]=await ctx.sql`UPDATE payroll_run_headers SET status='approved',journal_entry_id=${journalEntryId}::uuid,updated_at=clock_timestamp()
      WHERE company_id=${companyId}::uuid AND id=${runId}::uuid RETURNING *` as PayrollRow[];
    if (!updated) throw new Error('Payroll run changed concurrently');
    return {run:mapRunRow(updated),journalEntryId};
  });
}
export async function executePayrollReopen(companyId:string,runId:string,userId:string,opts?:PayrollControlOptions): Promise<{runId:string;previousStatus:string;newStatus:'calculated';reversalId:string}> {
  const ctx=requirePayrollActor(companyId,userId);
  const reason=opts?.reason?.trim();
  if(reason !== undefined && (reason.length<5 || reason.length>2000)) throw new Error('Reopen reason must contain 5 to 2000 characters');
  const ref={entityType:'payroll_run',entityId:runId,operation:'payroll_run.reopen' as const,
    ...(opts?.reversalDate === undefined ? {} : {reversalDate:opts.reversalDate})};
  return executeControlledOperation(ctx,ref,opts?.approvalId ?? null,async permit=>{
    const material=await materializePayrollOperation(ctx,{...ref,reversalDate:permit.accountingDate});
    const {header,journal}=material.observedSources[0]!.facts as {header:PayrollRow;journal:{header:PayrollRow}|null};
    if (header.status !== 'approved') throw new Error('Only approved payroll runs can reopen');
    let reversalId='';
    if (header.journal_entry_id) {
      if (!journal || journal.header.status !== 'posted' || journal.header.reversed_at) throw new Error('Payroll journal cannot be reversed');
      const parentControl={permit,parent:ref};
      await registerGeneratedJournal(ctx,parentControl,String(header.journal_entry_id),'journal.reverse');
      reversalId=(await reverseJournalEntry(companyId,String(header.journal_entry_id),userId,{parentControl,reversalDate:permit.accountingDate})).id;
    }
    // Retain the original journal FK for after-material and immutable reversal provenance.
    await ctx.sql`UPDATE payroll_run_headers SET status='calculated',updated_at=clock_timestamp(),
      notes=CASE WHEN ${reason !== undefined} THEN concat_ws(E'\n',NULLIF(notes,''),${reason ?? null}::text) ELSE notes END
      WHERE company_id=${companyId}::uuid AND id=${runId}::uuid`;
    return {runId,previousStatus:'approved',newStatus:'calculated',reversalId};
  });
}
