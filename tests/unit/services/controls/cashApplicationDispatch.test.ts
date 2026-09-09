import {expect,it} from 'vitest';
import {CONTROL_OPERATIONS,type OperationRef} from '@/modules/accounting/services/controls/contracts';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
import {operationPermission,operationRequiresPosting,operationRuleType} from '@/modules/accounting/services/controls/operationPermissions';
for(const [entityType,operation] of [['cash_application_intent','cash_application.apply'],['cash_application_reversal_intent','cash_application.reverse']]){
 it(`binds ${operation} to its saved intent and payment authority`,()=>{
  const ref={entityType,operation,entityId:'77777777-7777-4777-8777-777777777777'} as OperationRef;
  expect(canonicalOperationRef(ref)).toEqual(ref);
  expect(CONTROL_OPERATIONS).toContain(operation);
  expect(operationPermission(operation!,'read')).toBe('read:bank-tx');
  expect(operationPermission(operation!,'write')).toBe('write:bank-tx');
  expect(operationRequiresPosting(operation!)).toBe(true);
  expect(operationRuleType(operation!)).toBe('payment');
  expect(()=>canonicalOperationRef({...ref,entityType:'customer_payment'})).toThrow('Unsupported');
 });
}
