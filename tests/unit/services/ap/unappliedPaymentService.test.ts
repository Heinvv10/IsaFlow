import {beforeEach,expect,it,vi} from 'vitest';
const {sqlFn}=vi.hoisted(()=>({sqlFn:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:sqlFn}));
import {getUnappliedPayments} from '@/modules/accounting/services/ap/unappliedPaymentService';
const company='11111111-1111-4111-8111-111111111111';
const payment=(id:string,over:Record<string,unknown>={})=>({id,payment_number:id,payment_date:'2026-01-01',total_amount:'115.00',status:'processed',party_id:'supplier',party_name:'Supplier',journal_status:'posted',journal_date:'2026-01-01',gl_journal_entry_id:'j',allocations:[],contras:[],cancellations:[],created_at:'2026-01-02T00:00:00Z',...over});
beforeEach(()=>vi.resetAllMocks());
it('computes totals over the complete observed population, not the page',async()=>{
 sqlFn.mockResolvedValue([payment('a'),payment('b'),payment('c',{party_id:null,party_name:null})]);
 const report=await getUnappliedPayments(company,{asAt:'2026-01-03',limit:1});
 expect(report.rows.map(row=>row.paymentId)).toEqual(['a']);expect(report.rowsTotal).toBe(2);expect(report.universeTotal).toBe(3);
 expect(report.totalUnapplied).toBe(230);expect(report.totalUnattributed).toBe(115);expect(report.unattributed.map(row=>row.paymentId)).toEqual(['c']);
 expect(report.postedThrough).toBe('2026-01-02T00:00:00.000Z');expect(report.historyCoverage.status).toBe('complete');
 expect(sqlFn).toHaveBeenCalledTimes(1);
});
it('preserves an owned nameless supplier and the date/id cursor',async()=>{
 sqlFn.mockResolvedValue([payment('a'),payment('b',{party_name:null})]);
 const report=await getUnappliedPayments(company,{asAt:'2026-01-03',limit:1,after:{paymentDate:'2026-01-01',id:'a'}});
 expect(report.rows[0]).toMatchObject({paymentId:'b',supplierId:'supplier',supplierName:null,paymentAmount:115});expect(report.unattributed).toEqual([]);
});
it('excludes unposted draft/approved payments without inventing cash',async()=>{
 sqlFn.mockResolvedValue([payment('a',{status:'draft',journal_status:null}),payment('b',{status:'approved',journal_status:null}),payment('c',{status:'reconciled'})]);
 const report=await getUnappliedPayments(company,{asAt:'2026-01-03',limit:10});expect(report.rows.map(row=>row.paymentId)).toEqual(['c']);expect(report.historyCoverage.status).toBe('complete');
});
it('uses retained cancellation dates rather than current status alone',async()=>{
 sqlFn.mockResolvedValue([payment('a',{status:'cancelled',contras:[{date:'2026-01-04'}],cancellations:[{date:'2026-01-04'}]})]);
 expect((await getUnappliedPayments(company,{asAt:'2026-01-03',limit:10})).totalUnapplied).toBe(115);
 expect((await getUnappliedPayments(company,{asAt:'2026-01-04',limit:10})).totalUnapplied).toBe(0);
});
it('passes company scope into every source family and uses owned joins',async()=>{
 sqlFn.mockResolvedValue([]);await getUnappliedPayments(company,{asAt:'2026-01-03',limit:10});
 const [strings,...params]=sqlFn.mock.calls[0]!,query=(strings as string[]).join('?');
 expect(params).toContain(company);expect(query).toContain('sp.company_id=');expect(query).toContain('s.company_id=sp.company_id');expect(query).toContain('je.company_id=p.company_id');expect(query).toContain('inv.company_id=p.company_id');
});
it('reports incomplete legacy evidence rather than asserting a fabricated balance',async()=>{
 sqlFn.mockResolvedValue([payment('a',{allocations:[{amount:'5',createdAt:'2026-01-02'}]})]);
 const report=await getUnappliedPayments(company,{asAt:'2026-01-03',limit:10});expect(report.totalUnapplied).toBe(0);expect(report.historyCoverage).toMatchObject({status:'partial',unresolvedPaymentCount:1,unresolvedAllocationCount:1});
});
