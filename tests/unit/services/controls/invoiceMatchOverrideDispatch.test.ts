import {expect,it} from 'vitest';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
it('admits only the persisted match override intent as its annotation operation',()=>{
 const ref={entityType:'invoice_match_override_intent',entityId:'11111111-1111-4111-8111-111111111111',operation:'invoice_match.override' as const};
 expect(canonicalOperationRef(ref)).toEqual(ref);
 expect(()=>canonicalOperationRef({...ref,entityType:'supplier_invoice'})).toThrow();
 expect(()=>canonicalOperationRef({...ref,reversalDate:'2026-09-09'})).toThrow();
});
