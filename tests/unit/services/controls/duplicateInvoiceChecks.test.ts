import {expect,it} from 'vitest';
import {detectInvoiceDuplicates} from '@/modules/accounting/services/controls/duplicateInvoiceChecks';
const row=(id:string,extra:Record<string,unknown>={})=>({id,supplier_id:'supplier',invoice_date:'2026-09-01',invoice_number:'INV-001',subtotal:'1000',tax_amount:'150',total_amount:'1150',currency:'ZAR',status:'approved',document_id:null,file_hash:null,file_verified:false,version:null,...extra});
it('detects changed references with proven source reuse and distinguishes candidates',()=>{
 const exact=detectInvoiceDuplicates([row('a',{document_id:'doc-a',file_hash:'a'.repeat(64),file_verified:true}),row('b',{invoice_number:'INV001',document_id:'doc-b',file_hash:'a'.repeat(64),file_verified:true})]);
 expect(exact).toHaveLength(1);expect(exact[0]!.finding.classification).toBe('confirmed');
 expect(detectInvoiceDuplicates([row('a'),row('b')])[0]!.finding.classification).toBe('candidate');
});
it('does not confuse recurring months with a same-date duplicate',()=>{
 expect(detectInvoiceDuplicates([row('a'),row('b',{invoice_date:'2026-08-01'})])).toEqual([]);
});

import {riskHash,riskResult} from '@/modules/accounting/services/controls/invoiceRiskQueriesResult';
it('keeps complete findings and exact totals across page20 and rejects a stale cursor',()=>{
 const rows=Array.from({length:122},(_,i)=>row(String(i).padStart(3,'0'))),findings=detectInvoiceDuplicates(rows);
 const args={id:'duplicate_invoice_checks',options:{limit:20},populationCount:122,excludedCount:0,findings,missing:[],coverage:[],capturedAt:'2026-09-09T00:00:00Z',sourceVersions:[],sourceHash:riskHash(rows)};
 const first=riskResult(args);expect(first.findingCount).toBe(121);expect(first.findings).toHaveLength(20);expect(first.amountTotals).toEqual({ZAR:'139150'});
 const second=riskResult({...args,options:{limit:20,cursor:first.nextCursor!}});expect(second.findingCount).toBe(121);expect(second.findings[0]?.key).not.toBe(first.findings[0]?.key);
 expect(()=>riskResult({...args,sourceHash:'changed',options:{cursor:first.nextCursor!}})).toThrow('changed');
});
