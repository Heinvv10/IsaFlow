import { payrollCalculationHashes } from '../controls/payrollCalculationReceipt';
import { withSavepoint } from '@/lib/neon';
import { requireControlTx } from '../controls/context';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { lockPayrollSources } from '../controls/payrollSourceMaterial';
import { readControlEntityVersion } from '../controls/operationVersions';
import { recordCommittedChange } from '../controls/changeEventService';
import { lastDayOfMonthIso } from './payrollJournalParts';
/** Loan applications, replacement lines, run totals and evidence share one authenticated savepoint. */
export async function runPayrollCalculation<T>(runId:string,companyId:string,effect:()=>Promise<T>) {
  const ctx=requireControlTx();
  if(ctx.principal.companyId!==companyId) throw new Error('Payroll tenant does not match authenticated context');
  await assertEffectivePermission(ctx,'write:payroll');
  return withSavepoint('controlled_payroll_calculation',async()=>{
    await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${companyId}`},0))`;
    const before=await lockPayrollSources(ctx,runId);
    const ref={entityType:'payroll_run',entityId:runId};
    const prior=await readControlEntityVersion(ctx,ref);
    let version=prior?.version ?? 0;
    const accountingDate=lastDayOfMonthIso(Number(before.header.period_year),Number(before.header.period_month));
    if(!prior){
      await recordCommittedChange(ctx,{...ref,previousVersion:null,newVersion:1,action:'baseline_observed',accountingDate,
        before:null,after:before,bindingHash:null,protectedEvidenceRef:null});version=1;
    }
    const result=await effect();
    const after=await lockPayrollSources(ctx,runId);
    await recordCommittedChange(ctx,{...ref,previousVersion:version,newVersion:version+1,action:'calculated',accountingDate,
      before,after,bindingHash:null,protectedEvidenceRef:null});
    const hashes=payrollCalculationHashes(after);
    await ctx.sql`INSERT INTO control_payroll_calculations(company_id,run_id,calculation_version,input_hash,output_hash,created_by)
      VALUES(${companyId}::uuid,${runId}::uuid,${version+1},${hashes.input_hash},${hashes.output_hash},${ctx.principal.personId})`;
    return result;
  });
}
