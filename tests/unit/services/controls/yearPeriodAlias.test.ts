import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import {operationPermission,operationRequiresPosting} from '@/modules/accounting/services/controls/operationPermissions';
import {CONTROL_OPERATIONS} from '@/modules/accounting/services/controls/contracts';
it('distinguishes closing a year population of periods from financial year-end posting',()=>{
 expect(CONTROL_OPERATIONS).toContain('year.periods_close');
 expect(canonicalOperationRef({entityType:'fiscal_year',entityId:'2030',operation:'year.periods_close'}).operation).toBe('year.periods_close');
 expect(operationPermission('year.periods_close','write')).toBe('write:locks');
 expect(operationRequiresPosting('year.periods_close')).toBe(false);
});
