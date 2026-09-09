import {expect,it} from 'vitest';
import {assertHistoricalDocumentPlan} from '@/modules/accounting/services/controls/historicalImportCurrentFacts';
import {normalizeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExactPlan';
function fixture(ar=true){
 const source=normalizeHistoricalImport({version:1,sourceSystem:'csv',sourceKey:'DOC',kind:ar?'customer_invoice':'supplier_invoice',mode:'post_journal',accountingDate:'2023-02-28',currency:'ZAR',records:[
  {recordId:'1',accountCode:'control',debit:ar?'115':'0',credit:ar?'0':'115',description:'Control'},
  {recordId:'2',accountCode:'base',debit:ar?'0':'100',credit:ar?'100':'0',description:'Base'},
  {recordId:'3',accountCode:'tax',debit:ar?'0':'15',credit:ar?'15':'0',description:'Tax'}],
 document:{partyId:'11111111-1111-4111-8111-111111111111',invoiceNumber:'SYNTHETIC',dueDate:'2023-03-01',subtotal:'100',taxAmount:'15',totalAmount:'115',amountPaid:'0',settlements:[]}});
 const accounts=[{id:'control',account_type:ar?'asset':'liability',account_subtype:ar?'receivable':'payable'},
  {id:'base',account_type:ar?'revenue':'expense',account_subtype:null},{id:'tax',account_type:ar?'liability':'asset',account_subtype:ar?'vat_output':'vat_input'}];
 const plan=source.records.map(r=>({glAccountId:r.accountCode,debit:r.debit,credit:r.credit}));
 return{source,accounts,plan};
}
it.each([true,false])('accepts reconciled source document and current account classifications (AR=%s)',ar=>{
 const f=fixture(ar);expect(()=>assertHistoricalDocumentPlan(f.source,f.accounts,f.plan)).not.toThrow();
});
it.each([true,false])('rejects wrongly classified control account despite matching subtype (AR=%s)',ar=>{
 const f=fixture(ar);f.accounts[0]!.account_type='revenue';expect(()=>assertHistoricalDocumentPlan(f.source,f.accounts,f.plan)).toThrow('classification');
});
it('rejects a VAT account with an incompatible class',()=>{
 const f=fixture();f.accounts[2]!.account_type='revenue';expect(()=>assertHistoricalDocumentPlan(f.source,f.accounts,f.plan)).toThrow('classification');
});
