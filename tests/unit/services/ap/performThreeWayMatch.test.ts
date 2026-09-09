import {describe,it,expect} from 'vitest';
import {performThreeWayMatch} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {company,invoice,fixture,source} from './threeWayMatchFixture';
describe('performThreeWayMatch with issued current authority and observed source material',()=>{
 it('matches exact quantities, prices and accepted GRN evidence',async()=>{
  const result=await fixture().run(),item=result.itemResults[0]!;
  expect(result).toMatchObject({invoiceId:invoice,matchStatus:'fully_matched'});expect(result.itemResults).toHaveLength(1);
  expect(item).toMatchObject({lineMatchStatus:'fully_matched',qtyVariancePct:0,priceVariancePct:0,match:{quantityMatch:true,priceMatch:true,grnMatch:true}});
 });
 it.each(['absent','legacy null'])('returns unmatched with no items for %s PO, after current authorization and owned locking',async()=>{
  const f=fixture([]),result=await f.run();expect(result).toMatchObject({matchStatus:'unmatched',itemResults:[]});
  expect(f.query.mock.calls.some(([sql])=>sql.includes('control_lock_permission_principal'))).toBe(true);
  expect(f.updates()).toHaveLength(1);
 });
 it('rejects price 5% above the default 2% tolerance',async()=>{
  const item=(await fixture([source({unit_price:'105'})]).run()).itemResults[0]!;
  expect(item.lineMatchStatus).not.toBe('fully_matched');expect(item.priceVariancePct).toBeCloseTo(5,1);
  expect(item.match.priceMatch).toBe(false);expect(item.match.mismatches.some(m=>m.toLowerCase().includes('unit price'))).toBe(true);
 });
 it('accepts the exact 2% price boundary',async()=>{
  const item=(await fixture([source({unit_price:'102'})]).run()).itemResults[0]!;
  expect(item.match.priceMatch).toBe(true);expect(item.priceVariancePct).toBeCloseTo(2,2);
 });
 const excess=()=>{const row=source();return source({quantity:'12',bills:[{...row.bills[0]!,quantity:'12'}],receipts:[{...row.receipts[0]!,received:'12'}]});};
 it('reports cumulative quantity 20% above PO capacity',async()=>{
  const item=(await fixture([excess()]).run()).itemResults[0]!;
  expect(item.qtyVariancePct).toBeCloseTo(20,1);expect(item.match.quantityMatch).toBe(false);expect(item.lineMatchStatus).not.toBe('fully_matched');
 });
 it('retains grn_matched when accepted receipt covers an over-PO invoice',async()=>{
  const item=(await fixture([excess()]).run()).itemResults[0]!;
  expect(item.match.grnMatch).toBe(true);expect(item.match.quantityMatch).toBe(false);expect(item.lineMatchStatus).toBe('grn_matched');
 });
 it('applies supplier-specific 5% tolerance to a 4% price variance',async()=>{
  const row=source({unit_price:'104'});row.rules[0]!.qty='5';row.rules[0]!.price='5';
  const item=(await fixture([row]).run()).itemResults[0]!;expect(item.match.priceMatch).toBe(true);expect(item.priceVariancePct).toBeCloseTo(4,1);
 });
 it.each(['absent','null'])('falls back to 2% when rule tolerances are %s',async mode=>{
  const row=source({unit_price:'103',rules:mode==='absent'?[]:[{id:'rule',qty:null,price:null,updatedAt:''} as unknown as ReturnType<typeof source>['rules'][number]]});
  const item=(await fixture([row]).run()).itemResults[0]!;expect(item.match.priceMatch).toBe(false);expect(item.priceVariancePct).toBeCloseTo(3,1);
 });
 it('persists one update per item plus the invoice aggregate',async()=>{
  const f=fixture([source(),source({item_id:'eeeeeeee-0000-4000-8000-000000000005',description:'Connector'})]);await f.run();
  expect(f.updates()).toHaveLength(3);expect(f.updates().filter(([sql])=>sql.includes('UPDATE supplier_invoice_items'))).toHaveLength(2);
 });
 it('persists exact variance/status with owned invoice predicates',async()=>{
  const f=fixture();await f.run();const [sql,args]=f.updates()[0]!;
  expect(sql).toContain('qty_variance_pct');expect(sql).toContain('price_variance_pct');expect(sql).toContain('i.company_id=');
  expect(args).toEqual(expect.arrayContaining(['fully_matched',0,company,invoice]));
 });
 it('refuses a missing owned invoice',async()=>{const f=fixture();f.state.exists=false;await expect(f.run()).rejects.toThrow('Supplier invoice not found');expect(f.updates()).toHaveLength(0);});
 it('returns unmatched when the owned invoice has no items',async()=>{
  const f=fixture([source({item_id:null})]);expect(await f.run()).toMatchObject({matchStatus:'unmatched',itemResults:[]});expect(f.updates()).toHaveLength(1);
 });
 it('refuses a call outside an issued context',async()=>{await expect(performThreeWayMatch(company,invoice)).rejects.toThrow('Authenticated control transaction required');});
 it('rechecks current role before reading or persisting matching material',async()=>{
  const f=fixture();f.state.role='viewer';await expect(f.run()).rejects.toThrow('Current permissions');expect(f.updates()).toHaveLength(0);
 });
 it.each(['missing GRN','legacy supplier PO'])('never promotes %s to verified matching',async mode=>{
  const row=source(mode==='missing GRN'?{receipts:[]}:{flat_po_id:null,supplier_po_id:'legacy-po'});
  const item=(await fixture([row]).run()).itemResults[0]!;expect(item.lineMatchStatus).toBe('unmatched');expect(item.match.missing.length).toBeGreaterThan(0);
 });
 it('rolls back its savepoint when cache storage fails',async()=>{
  const f=fixture();f.state.failUpdate=true;await expect(f.run()).rejects.toThrow('Synthetic cache storage failure');
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('ROLLBACK TO SAVEPOINT'))).toBe(true);
 });
});
