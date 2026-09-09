import {expect,it} from 'vitest';
import {CONTROL_OPERATIONS} from '@/modules/accounting/services/controls/contracts';
import {operationPermission,operationRequiresPosting,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
it('requires bank authority and independent statement policy without posting authority',()=>{
 expect(CONTROL_OPERATIONS).toContain('bank_statement.attest');
 expect(operationPermission('bank_statement.attest','read')).toBe('read:bank-tx');
 expect(operationPermission('bank_statement.attest','write')).toBe('write:bank-tx');
 expect(operationRuleType('bank_statement.attest')).toBe('bank_statement_attestation');
 expect(operationRequiresPosting('bank_statement.attest')).toBe(false);
});
