import {expect,it} from 'vitest';
import {operationPermission,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
it.each([
 ['supplier_invoice.post','read:invoices','write:invoices','supplier_invoice'],
 ['supplier_payment.process','read:bank-tx','write:bank-tx','payment'],
 ['journal.post','read:reports','write:journals','journal_entry'],
 ['journal.reverse','read:reports','write:journals','journal_entry'],
 ['payroll_run.post','read:payroll','write:payroll','payroll_run'],
 ['payroll_run.reopen','read:payroll','write:payroll','payroll_run'],
 ['fiscal_period.close','read:reports','write:locks','fiscal_period'],
 ['fiscal_period.lock','read:reports','write:locks','fiscal_period'],
 ['fiscal_period.reopen','read:reports','write:locks','fiscal_period'],
 ['year.close','read:reports','write:locks','fiscal_year'],
 ['company_lockdown.change','read:reports','write:locks','company_lockdown'],
 ['vat_period.lock','read:vat','write:locks','vat_period'],
])('derives domain authority for %s', (operation,read,write,rule)=>{
 expect(operationPermission(operation,'read')).toBe(read);expect(operationPermission(operation,'write')).toBe(write);
 expect(operationRuleType(operation)).toBe(rule);
});
it('fails closed for unsupported operations',()=>{
 expect(()=>operationPermission('journal.erase','write')).toThrow();
 expect(()=>operationRuleType('supplier_payment.fake')).toThrow();
});
