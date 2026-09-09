import {expect,it} from 'vitest';
import {CONTROL_OPERATIONS} from '@/modules/accounting/services/controls/contracts';
import {operationPermission,operationRequiresPosting,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
it.each([
 ['bank_transfer.post','write:bank-tx','payment'],
 ['asset_depreciation.post','write:assets','asset_depreciation'],
 ['customer_invoice.post','write:invoices','customer_invoice'],
 ['customer_invoice.cancel','write:invoices','customer_invoice'],
 ['customer_payment.confirm','write:bank-tx','payment'],
 ['customer_payment.cancel','write:bank-tx','payment'],
 ['credit_note.approve','write:invoices','credit_note'],
 ['credit_note.cancel','write:invoices','credit_note'],
 ['credit_note_application.apply','write:invoices','credit_note'],
 ['recurring_invoice.generate','write:invoices','customer_invoice'],
])('requires both current domain and posting authority for %s',(operation,scope,rule)=>{
 expect(CONTROL_OPERATIONS).toContain(operation);
 expect(operationPermission(operation,'write')).toBe(scope);
 expect(operationRuleType(operation)).toBe(rule);
 expect(operationRequiresPosting(operation)).toBe(true);
});
