import {beforeEach,expect,it,vi} from 'vitest';
import {buildBankAllocationPreparation,buildBankSplitPreparation,executeSavedBankOperation} from '@/components/accounting/bank-transactions/bankControlClient';
import type {BankPreparedOperation} from '@/modules/accounting/services/bank/bankControlReadService';
const fetch=vi.hoisted(()=>vi.fn());vi.mock('@/lib/apiFetch',()=>({apiFetch:fetch}));
const bank='00000000-0000-4000-8000-000000000001',intent='00000000-0000-4000-8000-000000000002',account='00000000-0000-4000-8000-000000000003',approval='00000000-0000-4000-8000-000000000004';
beforeEach(()=>fetch.mockReset());
function saved():BankPreparedOperation{return{intentId:intent,operation:{entityType:'bank_allocation_intent',entityId:intent,operation:'bank_allocation.post'},plan:{version:1,kind:'account',bankTransactionId:bank,lines:[{accountId:account,amount:'115.23',vatCode:'none'}]},createdAt:'2026-09-09',accountingDate:'2026-09-09',amount:'115.23',currency:'ZAR',executed:false,requesterIsCurrentPerson:true,approvalVisibility:'visible',approval:{id:approval,operation:'bank_allocation.post',entityType:'bank_allocation_intent',entityId:intent,status:'approved',requestedAt:'2026-09-09',expiresAt:'2026-09-10'}};}
it('party preparation omits account VAT fields and preserves selected dimensions',()=>{
 expect(buildBankAllocationPreparation(bank,{type:'customer',entityId:account,label:'Customer',vatCode:'none',cc1Id:account})).toEqual({action:'prepare_allocate',bankTransactionId:bank,allocationType:'customer',entityId:account,cc1Id:account});
});
it('split preparation retains decimal strings without binary conversion',()=>{
 const body=buildBankSplitPreparation(bank,[{contraAccountId:account,amount:'9007199254740993.01',vatCode:'none'}]);
 expect(body.lines[0]?.amount).toBe('9007199254740993.01');
 expect(()=>buildBankSplitPreparation(bank,[{contraAccountId:account,amount:'1e3',vatCode:'none'}])).toThrow();
});
it('execution sends only exact saved references and requires an approved own instruction',async()=>{
 fetch.mockResolvedValue({ok:true,json:async()=>({success:true,data:{bankTransactionId:bank,journalEntryId:account}})});
 await executeSavedBankOperation(bank,saved());expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({action:'allocate',bankTransactionId:bank,intent_id:intent,approval_id:approval});
 for(const patch of [{approval:null},{requesterIsCurrentPerson:false},{approval:{...saved().approval!,status:'pending' as const}}])await expect(executeSavedBankOperation(bank,{...saved(),...patch})).rejects.toThrow();
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses mismatched saved bank or approval entity and malformed success receipts',async()=>{
 await expect(executeSavedBankOperation(account,saved())).rejects.toThrow();
 await expect(executeSavedBankOperation(bank,{...saved(),approval:{...saved().approval!,entityId:account}})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 fetch.mockResolvedValue({ok:true,json:async()=>({success:true,data:{pending:true}})});
 await expect(executeSavedBankOperation(bank,saved())).rejects.toThrow(/receipt/i);
});
