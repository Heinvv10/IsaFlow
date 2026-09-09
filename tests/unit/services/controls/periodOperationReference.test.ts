import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
const id='11111111-1111-4111-8111-111111111111';
it.each([
 ['payroll_run.post','payroll_run',id],['payroll_run.reopen','payroll_run',id],
 ['fiscal_period.close','fiscal_period',id],['fiscal_period.lock','fiscal_period',id],['fiscal_period.reopen','fiscal_period',id],
 ['year.close','fiscal_year','2026'],['vat_period.lock','vat_period','2026-07-01/2026-08-31'],
 ['company_lockdown.change','company_lockdown_intent',id],
] as const)('accepts typed owned reference %s', (operation,entityType,entityId)=>{
 expect(canonicalOperationRef({operation,entityType,entityId})).toEqual({operation,entityType,entityId});
});
it.each(['2026-02-31/2026-03-31','2026-09-09/2026-08-31','anything'])('refuses invalid VAT reference %s',entityId=>{
 expect(()=>canonicalOperationRef({operation:'vat_period.lock',entityType:'vat_period',entityId})).toThrow();
});
it('never accepts a year identifier as a payroll entity or a malformed year',()=>{
 expect(()=>canonicalOperationRef({operation:'payroll_run.post',entityType:'payroll_run',entityId:'2026'})).toThrow();
 expect(()=>canonicalOperationRef({operation:'year.close',entityType:'fiscal_year',entityId:'2026x'})).toThrow();
});
it('reconstructs payroll reopen target date from persisted approval binding',()=>{
 const stored={operation:'payroll_run.reopen' as const,entityType:'payroll_run',entityId:id,accountingDate:'2026-09-10'};
 expect(canonicalOperationRef(stored)).toMatchObject({reversalDate:'2026-09-10'});
});
