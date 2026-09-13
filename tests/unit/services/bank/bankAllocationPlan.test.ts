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
it('requires exact split equality and refuses invoice-targeted customer refunds',()=>{
 const plan=parseBankAllocationPlan({version:1,kind:'split',bankTransactionId:bank,lines:[{accountId:account,amount:'1',vatCode:'none'}]});
 expect(()=>buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount:'1.01',controlAccountId:null,vatAccountId:null})).toThrow('total');
 const receipt=parseBankAllocationPlan({version:1,kind:'customer',bankTransactionId:bank,partyId:account,applications:[{invoiceId:bank,amount:'1'}]});
 expect(()=>buildBankAllocationLines(receipt,{bankAccountId:bank,signedAmount:'-1',controlAccountId:account,vatAccountId:null})).toThrow('Refund applications');
});
it('canonicalizes UUID case before binding it to PostgreSQL source identity',()=>{
 const upper='ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF';
 const plan=parseBankAllocationPlan({version:1,kind:'customer',bankTransactionId:upper,partyId:upper,applications:[]});
 expect(plan.bankTransactionId).toBe(upper.toLowerCase());
});

it('does not lose a cent when testing outstanding at the admitted amount bound',()=>{
 expect(()=>assertAllocationOutstanding('10000000000000000000','10000000000000000000','0.01')).toThrow('outstanding');
});

it.each(['supplier','customer'] as const)('%s refund uses exactly gross bank/control lines and no VAT',kind=>{
 const plan=parseBankAllocationPlan({version:1,kind,bankTransactionId:bank,partyId:account,applications:[]});
 const lines=buildBankAllocationLines(plan,{bankAccountId:bank,signedAmount:kind==='supplier'?'115.23':'-115.23',controlAccountId:account,vatAccountId:null});
 expect(lines).toHaveLength(2);expect(lines.every(line=>line.vatType===null)).toBe(true);
 expect(lines[0]).toMatchObject({accountId:account,debit:kind==='customer'?'115.23':'0',credit:kind==='supplier'?'115.23':'0'});
 expect(lines[1]).toMatchObject({accountId:bank,debit:kind==='supplier'?'115.23':'0',credit:kind==='customer'?'115.23':'0'});
});

/**
 * The unattended provisional posting rides in the PLAN, so the receipt's fingerprint covers what the predictor
 * decided. Only a single-line account allocation can be one, and every field is bounded: a plan is the only place
 * this flag can come from, and each of these shapes would otherwise reach the effect.
 */
it('accepts a provisional account allocation and keeps the prediction in the plan',()=>{
 const supplier='33333333-3333-4333-8333-333333333333';
 const plan=parseBankAllocationPlan({version:1,kind:'account',bankTransactionId:bank,
  lines:[{accountId:account,amount:'115.00',vatCode:'standard'}],provisional:{predictedSupplierId:supplier,confidence:0.9}});
 expect(plan).toMatchObject({kind:'account',provisional:{predictedSupplierId:supplier,confidence:0.9}});
 // The predictor may match no supplier at all and still post to the fallback expense account.
 expect(parseBankAllocationPlan({version:1,kind:'account',bankTransactionId:bank,
  lines:[{accountId:account,amount:'1.00',vatCode:'none'}],provisional:{confidence:0}})).toMatchObject({provisional:{confidence:0}});
});
it('refuses a provisional block that is out of bounds, malformed, or on a plan that cannot be one',()=>{
 const line={accountId:account,amount:'1.00',vatCode:'none'};
 const account_plan=(provisional:unknown)=>({version:1,kind:'account',bankTransactionId:bank,lines:[line],provisional});
 expect(()=>parseBankAllocationPlan(account_plan({confidence:1.01}))).toThrow();
 expect(()=>parseBankAllocationPlan(account_plan({confidence:-0.1}))).toThrow();
 expect(()=>parseBankAllocationPlan(account_plan({confidence:'0.9'}))).toThrow();
 expect(()=>parseBankAllocationPlan(account_plan({}))).toThrow();
 expect(()=>parseBankAllocationPlan(account_plan({confidence:0.9,postingAgent:'ai-provisional:v1'}))).toThrow();
 expect(()=>parseBankAllocationPlan(account_plan({confidence:0.9,predictedSupplierId:'not-a-uuid'}))).toThrow();
 // A split, a party settlement or a transfer is never a provisional posting: the predictor produces one account line.
 expect(()=>parseBankAllocationPlan({version:1,kind:'split',bankTransactionId:bank,lines:[line],provisional:{confidence:0.9}})).toThrow();
 expect(()=>parseBankAllocationPlan({version:1,kind:'supplier',bankTransactionId:bank,partyId:account,applications:[],provisional:{confidence:0.9}})).toThrow();
});
it('a plan with no provisional block stays an ordinary allocation',()=>{
 const plan=parseBankAllocationPlan({version:1,kind:'account',bankTransactionId:bank,lines:[{accountId:account,amount:'1.00',vatCode:'none'}]});
 expect('provisional' in plan&&plan.provisional!==undefined).toBe(false);
});
