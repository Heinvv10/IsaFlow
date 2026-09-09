import {expect,it} from 'vitest';
import {analyzeUnappliedCashHistory} from '@/modules/accounting/services/shared/unappliedCashHistory';
const payment={id:'p',payment_date:'2026-01-01',status:'confirmed',total_amount:'115.00',journal_status:'posted',journal_date:'2026-01-01',party_id:'c',allocations:[],contras:[],cancellations:[]};
it('does not invent an accounting date for an unbound legacy application',()=>{
 const report=analyzeUnappliedCashHistory([{...payment,allocations:[{amount:'10',createdAt:'2026-01-03'}]}],'2026-01-02',1);
 expect(report.rows).toEqual([]);expect(report.historyCoverage).toMatchObject({status:'partial',unresolvedPaymentCount:1,unresolvedAllocationCount:1});
});
it('requires dated committed cancellation and matching posted contra evidence',()=>{
 const row={...payment,status:'cancelled',contras:[{date:'2026-01-04'}],cancellations:[{date:'2026-01-04'}]};
 expect(analyzeUnappliedCashHistory([row],'2026-01-03',1).rows[0]?.unapplied_amount).toBe(115);
 expect(analyzeUnappliedCashHistory([row],'2026-01-04',1).rows).toEqual([]);
 expect(analyzeUnappliedCashHistory([{...row,cancellations:[]}],'2026-01-03',1).historyCoverage.status).toBe('partial');
});
it('uses controlled accounting intervals and inverse consumption watermark',()=>{
 const row={...payment,allocations:[{amount:'115',applicationId:'a',applicationDate:'2026-01-02',inverseId:'i',reversedAt:'2026-02-03T01:00:00Z',inverseDate:'2026-01-04',inverseCreatedAt:'2026-02-03T01:00:00Z'}]};
 expect(analyzeUnappliedCashHistory([row],'2026-01-03',1).rows).toEqual([]);
 const report=analyzeUnappliedCashHistory([row],'2026-01-04',1);expect(report.rows[0]?.unapplied_amount).toBe(115);expect(report.postedThrough).toBe('2026-02-03T01:00:00.000Z');
});
it('does not call an unposted approved supplier draft missing cash evidence',()=>{
 const report=analyzeUnappliedCashHistory([{...payment,status:'approved',journal_status:null,journal_date:null}],'2026-01-04',1);
 expect(report.rows).toEqual([]);expect(report.historyCoverage.status).toBe('complete');
});
