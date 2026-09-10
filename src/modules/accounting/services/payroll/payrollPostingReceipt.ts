import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import type { ControlTx } from '../controls/contracts';
import { canonicalOperationRef } from '../controls/operationMaterializer';
import { replayKnownOperationEffect } from '../controls/operationReceiptReplay';
import type { PayrollPostResult } from './payrollControlService';
/** Reading an existing financial receipt is authorized afresh and never claims another posting effect. */
export async function readPayrollPostingReceipt(ctx:ControlTx,inputRunId:string):Promise<PayrollPostResult|null> {
  // Replay repeats these, but only after the tenant locks below: an unauthorized
  // caller must neither serialize payroll posting nor learn receipt state first.
  await assertEffectivePermission(ctx,'write:payroll');
  await assertEffectivePermission(ctx,'write:post');
  const ref=canonicalOperationRef({entityType:'payroll_run',entityId:inputRunId,operation:'payroll_run.post'}),runId=ref.entityId;
  const company=ctx.principal.companyId;
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${company}`},0))`;
  const [run]=await ctx.sql`SELECT status,journal_entry_id FROM payroll_run_headers
    WHERE company_id=${company}::uuid AND id=${runId}::uuid FOR UPDATE` as {status:string;journal_entry_id:string|null}[];
  if(!run || run.status!=='approved' || !run.journal_entry_id)return null;
  const [journal]=await ctx.sql`SELECT status,reversed_at FROM gl_journal_entries
    WHERE company_id=${company}::uuid AND id=${run.journal_entry_id}::uuid FOR SHARE` as {status:string;reversed_at:unknown}[];
  if(!journal || journal.status!=='posted' || journal.reversed_at)throw new Error('Payroll posting receipt state is inconsistent');
  // Legacy receipts may carry a non-canonical entity_id; a case-only duplicate is ambiguous, never picked.
  const effects=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${company}::uuid
    AND entity_type='payroll_run' AND lower(entity_id)=${runId} AND operation='payroll_run.post'
    AND result->>'journalEntryId'=${run.journal_entry_id} LIMIT 2` as {id:string;result:PayrollPostResult}[];
  if(effects.length>1)throw new Error('Ambiguous payroll posting receipt');
  const effect=effects[0],receiptRunId=effect?.result?.run?.id;
  if(!effect || effect.result.journalEntryId!==run.journal_entry_id || typeof receiptRunId!=='string' || receiptRunId.toLowerCase()!==runId) {
    throw new Error('Existing payroll journal has no verified posting receipt');
  }
  // Replay rechecks the linked approval's requester and reviewer authority, not just the caller's permissions.
  return replayKnownOperationEffect<PayrollPostResult>(ctx,ref,effect.id);
}
