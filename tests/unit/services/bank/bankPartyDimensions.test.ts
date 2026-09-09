import {it,expect} from 'vitest';
import {parseBankAllocationPlan,buildBankAllocationLines} from '@/modules/accounting/services/bank/bankAllocationPlan';
const id='11111111-1111-4111-8111-111111111111',bank='22222222-2222-4222-8222-222222222222',control='33333333-3333-4333-8333-333333333333';
it.each(['customer','supplier'] as const)('binds %s dimensions on its control leg for receipts and refunds',kind=>{
 const plan=parseBankAllocationPlan({version:1,kind,bankTransactionId:id,partyId:id,applications:[],cc1Id:id,cc2Id:bank,buId:control});
 for(const signedAmount of ['115','-115']){
  const lines=buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount,controlAccountId:control,vatAccountId:null});
  expect(lines.find(line=>line.accountId===control)).toMatchObject({cc1Id:id,cc2Id:bank,buId:control});
  expect(lines.find(line=>line.accountId===bank)).toMatchObject({cc1Id:null,cc2Id:null,buId:null});
 }
});
it('preserves omitted dimension shape and refuses caller-shaped dimension objects',()=>{
 const input={version:1,kind:'customer',bankTransactionId:id,partyId:id,applications:[]};
 expect(parseBankAllocationPlan(input)).toEqual(input);
 expect(()=>parseBankAllocationPlan({...input,cc1Id:{id}})).toThrow();
});
