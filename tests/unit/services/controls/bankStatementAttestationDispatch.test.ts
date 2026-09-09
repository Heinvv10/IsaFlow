import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import {operationRequiresPosting} from '@/modules/accounting/services/controls/operationPermissions';
it('binds local statement review to its saved intent without posting capability',()=>{
 const ref={entityType:'bank_statement_attestation_intent',entityId:'77777777-7777-4777-8777-777777777777',operation:'bank_statement.attest' as const};
 expect(canonicalOperationRef(ref)).toEqual(ref);
 expect(operationRequiresPosting(ref.operation)).toBe(false);
 expect(()=>canonicalOperationRef({...ref,entityType:'bank_transaction'})).toThrow('Unsupported');
});
