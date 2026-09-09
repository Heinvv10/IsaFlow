import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import {operationPermission,operationRequiresPosting} from '@/modules/accounting/services/controls/operationPermissions';
it('uses immutable historical intent and dedicated import plus posting authority',()=>{
 const ref={entityType:'historical_import',entityId:'11111111-1111-4111-8111-111111111111',operation:'historical_import.post' as const};
 expect(canonicalOperationRef(ref)).toEqual(ref);
 expect(operationPermission(ref.operation,'write')).toBe('write:imports');
 expect(operationRequiresPosting(ref.operation)).toBe(true);
 expect(()=>canonicalOperationRef({...ref,entityType:'journal_entry'})).toThrow();
});
