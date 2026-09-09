import {expect,it} from 'vitest';
import {analyzeUnappliedCashHistory,cashHistoryPage} from '@/modules/accounting/services/shared/unappliedCashHistory';
const p={id:'one',payment_date:'2026-01-01',status:'confirmed',total_amount:'115',journal_status:'posted',journal_date:'2026-01-01',party_id:'c',allocations:[],contras:[],cancellations:[]};
it('refuses a detail row lost against the independent payment census',()=>{
 expect(()=>analyzeUnappliedCashHistory([p],'2026-01-02',2)).toThrow(/population|census/i);
});
it('rejects duplicated detail identities even when their count matches',()=>{
 expect(()=>analyzeUnappliedCashHistory([p,p],'2026-01-02',2)).toThrow(/duplicate|population/i);
});
it('accounts for every disposition without synthesizing an eligible universe',()=>{
 const rows=[p,{...p,id:'fully',allocations:[{amount:'115',applicationId:'a',applicationDate:'2026-01-01'}]},
  {...p,id:'draft',status:'draft',journal_status:null},
  {...p,id:'missing',allocations:[{amount:'10'}]}];
 const result=analyzeUnappliedCashHistory(rows,'2026-01-02',4);
 expect(result.historyCoverage).toMatchObject({status:'partial',unresolvedPaymentCount:1,population:{sourceCount:4,analyzedCount:4,recognizedRemainderCount:1,fullyAppliedCount:1,inactiveCount:1,unresolvedCount:1}});
 expect(cashHistoryPage(result.rows,{limit:1})).not.toHaveProperty('universeTotal');
});
