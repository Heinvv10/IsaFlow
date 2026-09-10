import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import type { ControlTx } from '../controls/contracts';
import type { PayrollPostResult } from './payrollControlService';
/** Reading an existing financial receipt is authorized afresh and never claims another posting effect. */
export async function readPayrollPostingReceipt(ctx:ControlTx,runId:string):Promise<PayrollPostResult|null> {
  await assertEffectivePermission(ctx,'write:payroll');
  await assertEffectivePermission(ctx,'write:post');
  const company=ctx.principal.companyId;
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${company}`},0))`;
  const [run]=await ctx.sql`SELECT status,journal_entry_id FROM payroll_run_headers
    WHERE company_id=${company}::uuid AND id=${runId}::uuid FOR UPDATE` as {status:string;journal_entry_id:string|null}[];
  if(!run || run.status!=='approved' || !run.journal_entry_id)return null;
  const [journal]=await ctx.sql`SELECT status,reversed_at FROM gl_journal_entries
    WHERE company_id=${company}::uuid AND id=${run.journal_entry_id}::uuid FOR SHARE` as {status:string;reversed_at:unknown}[];
  if(!journal || journal.status!=='posted' || journal.reversed_at)throw new Error('Payroll posting receipt state is inconsistent');
  const [effect]=await ctx.sql`SELECT result FROM control_operation_effects WHERE company_id=${company}::uuid
    AND entity_type='payroll_run' AND lower(entity_id)=lower(${runId}) AND operation='payroll_run.post'
    AND result->>'journalEntryId'=${run.journal_entry_id} ORDER BY committed_at DESC LIMIT 1` as {result:PayrollPostResult}[];
  if(!effect || effect.result?.journalEntryId!==run.journal_entry_id || effect.result.run?.id!==runId) {
    throw new Error('Existing payroll journal has no verified posting receipt');
  }
  return effect.result;
}
