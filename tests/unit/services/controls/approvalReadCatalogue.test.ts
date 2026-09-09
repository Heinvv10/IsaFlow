import {expect,it} from 'vitest';
import {approvalOperationNames,operationPermission} from '@/modules/accounting/services/controls/operationPermissions';
it('exposes the actual immutable approval operation permission catalogue',()=>{
 const names=approvalOperationNames();
 expect(Object.isFrozen(names)).toBe(true);
 expect(names).toContain('bank_allocation.post');expect(names).toContain('payroll_run.post');
 expect(names).not.toContain('beneficiary.activate');expect(names).not.toContain('payroll_run.approve');
 expect(new Set(names).size).toBe(names.length);
 for(const name of names)expect(operationPermission(name,'read')).toMatch(/^read:/);
});
