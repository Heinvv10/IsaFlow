import {expect,it} from 'vitest';
import {matchesBankAllocationJournalLines} from '@/modules/accounting/services/controls/bankAllocationJournalShape';
import {canonicalOperationRef} from '@/modules/accounting/services/controls/operationMaterializer';
const expected=[{accountId:'expense',debit:'100',credit:'0',description:'Expense',vatType:'standard',cc1Id:null,cc2Id:null,buId:null},
 {accountId:'vat',debit:'15',credit:'0',description:'VAT',vatType:'standard',cc1Id:null,cc2Id:null,buId:null},
 {accountId:'bank',debit:'0',credit:'115',description:'Bank',vatType:null,cc1Id:null,cc2Id:null,buId:null}];
const actual=()=>expected.map(l=>({gl_account_id:l.accountId,debit:l.debit,credit:l.credit,vat_type:l.vatType,cc1_id:l.cc1Id,cc2_id:l.cc2Id,bu_id:l.buId}));
it('compares exact accounting line multisets independently of row order and decimal scale',()=>{
 const rows=actual().reverse();rows[2]!.debit='100.00000000';expect(matchesBankAllocationJournalLines(expected,rows)).toBe(true);
});
it.each(['gl_account_id','debit','vat_type','bu_id'])('refuses changed %s even when parent total remains unchanged',key=>{
 const rows=actual();Object.assign(rows[0]!,{[key]:key==='debit'?'99':'changed'});
 expect(matchesBankAllocationJournalLines(expected,rows)).toBe(false);
});
it('refuses extra or omitted lines',()=>{
 expect(matchesBankAllocationJournalLines(expected,[...actual(),actual()[0]!])).toBe(false);
 expect(matchesBankAllocationJournalLines(expected,actual().slice(1))).toBe(false);
});
it('supports only the frozen bank allocation operation and entity association',()=>{
 const ref={operation:'bank_allocation.post' as const,entityType:'bank_allocation_intent',entityId:'11111111-1111-4111-8111-111111111111'};
 expect(canonicalOperationRef(ref)).toEqual(ref);
 expect(()=>canonicalOperationRef({...ref,entityType:'bank_transfer_intent'})).toThrow();
});
