import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferControlFixture} from './bankTransferControlFixture';
import {checkPayrollControls} from '@/modules/accounting/services/controls/payrollControlChecks';
import {captureControlExceptions,listControlExceptions,resolveControlException} from '@/modules/accounting/services/controls/controlExceptionService';
let f:Awaited<ReturnType<typeof transferControlFixture>>;const run=randomUUID(),checkId='payroll_control_checks';
beforeAll(async()=>{
 f=await transferControlFixture();await f.pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[f.f.companyA]);
 await f.pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status,total_gross,total_taxable,total_paye,total_uif,total_sdl,total_eti,total_net,employee_count) VALUES($1,$2,9,2026,'approved',100,100,0,0,0,0,100,1)",[run,f.f.companyA]);
},30000);afterAll(async()=>{if(f)await f.close();});
it('captures real payroll mismatch and prevents unknown recheck closure and revoked payroll access',async()=>{
 const detected=await f.actor(ctx=>checkPayrollControls(ctx));expect(detected.findings.some(row=>row.severity==='high')).toBe(true);
 const captured=await f.actor(ctx=>captureControlExceptions(ctx,{checkId}));expect(captured.exceptionIds.length).toBeGreaterThan(0);const id=captured.exceptionIds[0]!;
 // Synthetic uncalculated state removes the mismatch but cannot invent settlement evidence.
 await f.pool.query("UPDATE payroll_run_headers SET status='draft',total_gross=0,total_taxable=0,total_net=0,employee_count=0 WHERE company_id=$1 AND id=$2",[f.f.companyA,run]);
 const current=await f.actor(ctx=>checkPayrollControls(ctx));expect(current.status).toBe('unknown');expect(current.findingCount).toBe(0);
 const result=await f.actor(ctx=>resolveControlException(ctx,{exceptionId:id,expectedVersion:1,resolution:'fixed',reason:'Synthetic incomplete evidence review'}),'u2');
 expect(result.outcome).toBe('recheck_blocked');expect(result.exception.status).toBe('open');expect(result.exception.lastRecheck).toMatchObject({status:'unknown',findingCount:0});
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.f.companyA,f.f.u1.id]);
 await expect(f.actor(ctx=>listControlExceptions(ctx,{checkId}))).rejects.toThrow(/permissions/);
 await expect(f.actor(ctx=>captureControlExceptions(ctx,{checkId}))).rejects.toThrow(/permissions/);
 expect((await f.pool.query('SELECT version FROM control_exceptions WHERE company_id=$1 AND id=$2',[f.f.companyA,id])).rows[0].version).toBe(2);
});
