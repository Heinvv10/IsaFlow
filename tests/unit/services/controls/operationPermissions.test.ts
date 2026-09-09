import {expect,it} from 'vitest';
import {operationPermission,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
it.each([
 ['supplier_invoice.post','read:invoices','write:invoices','supplier_invoice'],
 ['supplier_payment.process','read:bank-tx','write:bank-tx','payment'],
 ['journal.post','read:reports','write:journals','journal_entry'],
 ['journal.reverse','read:reports','write:journals','journal_entry'],
])('derives domain authority for %s', (operation,read,write,rule)=>{
 expect(operationPermission(operation,'read')).toBe(read);expect(operationPermission(operation,'write')).toBe(write);
 expect(operationRuleType(operation)).toBe(rule);
});
it('fails closed for unsupported operations',()=>{
 expect(()=>operationPermission('journal.erase','write')).toThrow();
 expect(()=>operationRuleType('supplier_payment.fake')).toThrow();
});
