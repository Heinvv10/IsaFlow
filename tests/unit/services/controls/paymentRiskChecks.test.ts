import {expect,it} from 'vitest';
import {detectPaymentPatterns} from '@/modules/accounting/services/controls/paymentRiskChecks';
const payment=(id:string,invoice:string)=>({id,supplier_id:'supplier',payment_date:'2026-09-09',total_amount:'100',status:'processed',reference:null,version:null,
 allocations:[{invoice_id:invoice,amount:'100',currency:'ZAR'}],attempts:[]});
it('distinguishes distinct invoice installment allocations from repeated payment candidates',()=>{
 expect(detectPaymentPatterns([payment('a','one'),payment('b','two')])).toEqual([]);
 const result=detectPaymentPatterns([payment('a','one'),payment('b','one')]);
 expect(result).toHaveLength(1);expect(result[0]!.finding.classification).toBe('candidate');
});
it('detects repeated immutable preparation executions without counting one intent retry twice',()=>{
 const row={...payment('a','one'),attempts:[{intent_id:'intent-a',preparation_id:'prep',attempted_at:'2026-09-09T00:00:00Z'},{intent_id:'intent-b',preparation_id:'prep',attempted_at:'2026-09-09T00:01:00Z'}]};
 expect(detectPaymentPatterns([row])[0]!.finding.classification).toBe('confirmed');
 expect(detectPaymentPatterns([{...row,attempts:[row.attempts[0]!,row.attempts[0]!]}])).toEqual([]);
});
it('flags a verified change within48h before activity, never a later or older change',()=>{
 const row={...payment('a','one'),attempts:[{intent_id:'intent',preparation_id:'prep',attempted_at:'2026-09-09T12:00:00Z',verified_at:'2026-09-07T12:00:00Z'}]};
 expect(detectPaymentPatterns([row])[0]!.finding.kind).toBe('recent_beneficiary_change');
 expect(detectPaymentPatterns([{...row,attempts:[{...row.attempts[0]!,verified_at:'2026-09-07T11:59:59Z'}]}])).toEqual([]);
 expect(detectPaymentPatterns([{...row,attempts:[{...row.attempts[0]!,verified_at:'2026-09-09T12:00:01Z'}]}])).toEqual([]);
});
