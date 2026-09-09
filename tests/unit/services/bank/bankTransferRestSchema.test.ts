import {expect,it} from 'vitest';
import {bankControlSchema} from '@/lib/api/bankControlActionSchema';
const input={action:'prepare_allocate',allocationType:'transfer',bankTransactionId:'11111111-1111-4111-8111-111111111111',contraAccountId:'22222222-2222-4222-8222-222222222222'};
it('accepts the existing contra account transport field for a saved transfer preparation',()=>{
 expect(bankControlSchema.parse(input)).toEqual(input);
});
it('rejects caller-supplied transfer matching authority',()=>{
 expect(()=>bankControlSchema.parse({...input,transfer:{mode:'post',oppositeBankTransactionId:null}})).toThrow();
});
it('shared transfer preparation omits an absent optional description from retained material',async()=>{
 const {parseBankTransferRequest}=await import('@/modules/accounting/services/bank/bankAllocationTransferPlan');
 const result=parseBankTransferRequest({version:1,kind:'transfer',bankTransactionId:input.bankTransactionId,counterpartyAccountId:input.contraAccountId,description:undefined});
 expect(Object.hasOwn(result,'description')).toBe(false);
});
