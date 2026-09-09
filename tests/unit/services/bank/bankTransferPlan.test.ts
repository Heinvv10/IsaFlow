import {expect,it} from 'vitest';
import {parseBankTransferRequest} from '@/modules/accounting/services/bank/bankAllocationTransferPlan';
import {parseBankAllocationPlan,buildBankAllocationLines} from '@/modules/accounting/services/bank/bankAllocationPlan';
const bank='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
const request={version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:account};
it('separates a caller request from authoritative saved selection',()=>{
 expect(parseBankTransferRequest(request)).toEqual(request);
 for(const extra of [{amount:'1'},{transfer:{mode:'post',oppositeBankTransactionId:null}},{journalEntryId:bank},{personId:bank},{approvalId:bank},{cc1Id:bank},{vatAccountId:bank}])expect(()=>parseBankTransferRequest({...request,...extra})).toThrow();
 expect(()=>parseBankAllocationPlan(request)).toThrow();
});
it.each(['9999999999999999.99','-9999999999999999.99'])('posts exact opposite bank legs for signed %s without children or VAT',signedAmount=>{
 const plan=parseBankAllocationPlan({...request,transfer:{mode:'post',oppositeBankTransactionId:null}});
 const lines=buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount,controlAccountId:null,vatAccountId:null});
 expect(lines).toHaveLength(2);
 expect(lines[0]).toMatchObject({accountId:account,debit:signedAmount.startsWith('-')?'9999999999999999.99':'0',credit:signedAmount.startsWith('-')?'0':'9999999999999999.99',vatType:null,cc1Id:null,cc2Id:null,buId:null});
 expect(lines[1]).toMatchObject({accountId:bank,debit:lines[0]!.credit,credit:lines[0]!.debit});
});
it('keeps a saved link tied to one original intent and forbids mixed modes',()=>{
 const plan=parseBankAllocationPlan({...request,transfer:{mode:'link',originalIntentId:bank}});
 expect(plan).toMatchObject({transfer:{mode:'link',originalIntentId:bank}});
 expect(()=>parseBankAllocationPlan({...request,transfer:{mode:'link',originalIntentId:bank,oppositeBankTransactionId:account}})).toThrow();
 expect(()=>parseBankAllocationPlan({...request,transfer:{mode:'post',oppositeBankTransactionId:bank}})).toThrow();
});
it('refuses same-account, zero and fractional-cent economics',()=>{
 const plan=parseBankAllocationPlan({...request,transfer:{mode:'post',oppositeBankTransactionId:null}});
 for(const signedAmount of ['0','1.001'])expect(()=>buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount,controlAccountId:null,vatAccountId:null})).toThrow();
 expect(()=>buildBankAllocationLines(plan,{bankAccountId:account,signedAmount:'1',controlAccountId:null,vatAccountId:null})).toThrow('different');
});
