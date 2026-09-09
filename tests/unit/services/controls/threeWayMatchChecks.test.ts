import {expect,it} from 'vitest';
import {calculateCumulativeThreeWayMatch} from '@/modules/accounting/services/ap/threeWayMatchMath';
const base={ordered:'10',unitPrice:'100',accepted:['4','6'],invoiced:['4','6'],invoiceUnitPrice:'100',qtyTolerance:'2',priceTolerance:'2'};
it('matches cumulative partial receipts and invoices, including an ordinary partial bill',()=>{
 expect(calculateCumulativeThreeWayMatch(base).status).toBe('fully_matched');
 expect(calculateCumulativeThreeWayMatch({...base,accepted:['4'],invoiced:['4']}).status).toBe('fully_matched');
});
it('refuses cumulative overbilling and prices beyond the exact inclusive tolerance',()=>{
 expect(calculateCumulativeThreeWayMatch({...base,invoiced:['4','7']}).quantityMatch).toBe(false);
 expect(calculateCumulativeThreeWayMatch({...base,invoiceUnitPrice:'103'}).priceMatch).toBe(false);
 expect(calculateCumulativeThreeWayMatch({...base,invoiceUnitPrice:'102'}).priceMatch).toBe(true);
});
it('distinguishes missing receipt evidence from a known zero accepted receipt',()=>{
 expect(calculateCumulativeThreeWayMatch({...base,accepted:null}).missing).toContain('accepted_receipt_evidence_unavailable');
 expect(calculateCumulativeThreeWayMatch({...base,accepted:['0']}).missing).toEqual([]);
 expect(calculateCumulativeThreeWayMatch({...base,accepted:['0']}).grnMatch).toBe(false);
});
it('refuses invalid tolerance and negative quantities before accounting comparison',()=>{
 expect(()=>calculateCumulativeThreeWayMatch({...base,qtyTolerance:'-1'})).toThrow();
 expect(()=>calculateCumulativeThreeWayMatch({...base,invoiced:['-1']})).toThrow();
});
