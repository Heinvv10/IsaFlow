import {expect,it} from 'vitest';
import {parseBankAllocationPlan,buildBankAllocationLines,assertAllocationOutstanding} from '@/modules/accounting/services/bank/bankAllocationPlan';
const bank='11111111-1111-4111-8111-111111111111',account='22222222-2222-4222-8222-222222222222';
it('keeps exact large cents and computes a balanced VAT split without Number',()=>{
 const plan=parseBankAllocationPlan({version:1,kind:'account',bankTransactionId:bank,lines:[{accountId:account,amount:'9999999999999999.99',vatCode:'standard'}]});
 const lines=buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount:'-9999999999999999.99',controlAccountId:null,vatAccountId:account});
 expect(lines.at(-1)).toMatchObject({credit:'9999999999999999.99',debit:'0'});
 expect(lines[0]!.debit).toBe('8695652173913043.47');expect(lines[1]!.debit).toBe('1304347826086956.52');
});
it('refuses fractional cents, excessive bounds, duplicate invoice applications and extra actor fields',()=>{
 const raw={version:1,kind:'account',bankTransactionId:bank,lines:[{accountId:account,amount:'1.001',vatCode:'none'}]};
 expect(()=>parseBankAllocationPlan(raw)).toThrow();
 expect(()=>parseBankAllocationPlan({...raw,lines:[{accountId:account,amount:'100000000000000000000',vatCode:'none'}]})).toThrow();
 expect(()=>parseBankAllocationPlan({...raw,personId:bank})).toThrow();
 expect(()=>parseBankAllocationPlan({version:1,kind:'customer',bankTransactionId:bank,partyId:account,applications:[{invoiceId:bank,amount:'1'},{invoiceId:bank,amount:'1'}]})).toThrow();
});
it('requires exact split equality and enforces customer receipt direction',()=>{
 const plan=parseBankAllocationPlan({version:1,kind:'split',bankTransactionId:bank,lines:[{accountId:account,amount:'1',vatCode:'none'}]});
 expect(()=>buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount:'1.01',controlAccountId:null,vatAccountId:null})).toThrow('total');
 const receipt=parseBankAllocationPlan({version:1,kind:'customer',bankTransactionId:bank,partyId:account,applications:[]});
 expect(()=>buildBankAllocationLines(receipt,{bankAccountId:bank,signedAmount:'-1',controlAccountId:account,vatAccountId:null})).toThrow('direction');
});
it('canonicalizes UUID case before binding it to PostgreSQL source identity',()=>{
 const upper='ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF';
 const plan=parseBankAllocationPlan({version:1,kind:'customer',bankTransactionId:upper,partyId:upper,applications:[]});
 expect(plan.bankTransactionId).toBe(upper.toLowerCase());
});

it('does not lose a cent when testing outstanding at the admitted amount bound',()=>{
 expect(()=>assertAllocationOutstanding('10000000000000000000','10000000000000000000','0.01')).toThrow('outstanding');
});
