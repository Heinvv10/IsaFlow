import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
it('binds compensation only to an immutable preparation identity',()=>{
 const ref={entityType:'payroll_compensation_intent',entityId:'77777777-7777-4777-8777-777777777777',operation:'payroll_compensation.change' as const};
 expect(canonicalOperationRef(ref)).toEqual(ref);
 expect(()=>canonicalOperationRef({...ref,entityType:'payroll_run'})).toThrow('Unsupported');
});
