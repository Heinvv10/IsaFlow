import {beforeEach,expect,it,vi} from 'vitest';
const {sqlFn}=vi.hoisted(()=>({sqlFn:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:sqlFn}));
import {getUnappliedReceiptOrigins} from '@/modules/accounting/services/ar/unappliedReceiptOrigin';
const company='11111111-1111-4111-8111-111111111111';
const payment=(posting_agent:string|null,over:Record<string,unknown>={})=>({id:posting_agent,payment_date:'2026-01-01',total_amount:'115.00',status:'confirmed',journal_status:'posted',journal_date:'2026-01-01',posting_agent,allocations:[],contras:[],cancellations:[],...over});
beforeEach(()=>vi.resetAllMocks());
it('aggregates source-shaped receipts into distinct evidence labels and tool totals',async()=>{
 sqlFn.mockResolvedValue([payment('mcp:tool'),payment('mcp:tool'),payment('system:job'),payment('human:legacy'),payment(null)]);
 const report=await getUnappliedReceiptOrigins(company,'2026-01-03');
 expect(report.agent).toEqual({receipts:2,unapplied:230});expect(report.system).toEqual({receipts:1,unapplied:115});
 expect(report.notStampedAsAgent).toEqual({receipts:2,unapplied:230});expect(report.noJournal).toEqual({receipts:0,unapplied:0});
 expect(report.agentTools).toEqual([{postingAgent:'mcp:tool',receipts:2,unapplied:230}]);expect(report.total).toEqual({receipts:5,unapplied:575});
 expect(report.caveat).toContain('NOT as human');
});
it('includes pre-cancellation cash and removes it on the dated cancellation day',async()=>{
 sqlFn.mockResolvedValue([payment('mcp:tool',{status:'cancelled',contras:[{date:'2026-01-04'}],cancellations:[{date:'2026-01-04'}]})]);
 expect((await getUnappliedReceiptOrigins(company,'2026-01-03')).total.unapplied).toBe(115);
 expect((await getUnappliedReceiptOrigins(company,'2026-01-04')).total.unapplied).toBe(0);
});
it('reports absent original journal evidence as partial rather than proved historical cash',async()=>{
 sqlFn.mockResolvedValue([payment(null,{journal_status:null,journal_date:null})]);
 const report=await getUnappliedReceiptOrigins(company,'2026-01-03');expect(report.total).toEqual({receipts:0,unapplied:0});expect(report.historyCoverage.status).toBe('partial');
});
it('scopes original journal, events and effects to the owned company',async()=>{
 sqlFn.mockResolvedValue([]);await getUnappliedReceiptOrigins(company,'2026-01-03');
 const [strings,...params]=sqlFn.mock.calls[0]!,query=(strings as string[]).join('?');expect(params).toContain(company);
 expect(query).toContain('je.company_id=p.company_id');expect(query).toContain('e.company_id=p.company_id');expect(query).toContain('f.company_id=e.company_id');
});
