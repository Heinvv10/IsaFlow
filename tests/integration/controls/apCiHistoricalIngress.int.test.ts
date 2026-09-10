import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {apCiWorkflowFixture} from './apCiWorkflowFixture';
import {storeHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {executeHistoricalImport} from '@/modules/accounting/services/controls/historicalImportExecution';
import {commitAPInvoice} from '@/modules/admin/services/sageMigrationCommitService';
let f:Awaited<ReturnType<typeof apCiWorkflowFixture>>;
beforeAll(async()=>{f=await apCiWorkflowFixture();await f.pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Historical AP CI',11,2023,'2023-11-01','2023-11-30','closed')",[f.f.companyA]);},30000);
afterAll(async()=>{if(f)await f.close();});
async function prepared(){
 const key=randomUUID(),codes=(await f.pool.query('SELECT id,account_code FROM gl_accounts WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.f.companyA,[f.accounts.payable,f.accounts.default_expense,f.accounts.vat_input]])).rows;
 const code=(id:string)=>codes.find(r=>r.id===id).account_code as string;
 const input={version:1,sourceSystem:'csv',sourceKey:key,kind:'supplier_invoice',mode:'post_journal',accountingDate:'2023-11-14',currency:'ZAR',records:[
  {recordId:'payable',accountCode:code(f.accounts.payable),debit:'0',credit:'1150',description:'Historical payable'},
  {recordId:'expense',accountCode:code(f.accounts.default_expense),debit:'1000',credit:'0',description:'Historical expense'},
  {recordId:'vat',accountCode:code(f.accounts.vat_input),debit:'150',credit:'0',description:'Historical input VAT'}],
  document:{partyId:f.supplier,invoiceNumber:key,dueDate:'2023-12-14',subtotal:'1000',taxAmount:'150',totalAmount:'1150',amountPaid:'0',settlements:[]}};
 const source=await f.actor(ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify(input)),mimeType:'application/json'}));
 const result=await f.actor(ctx=>prepareHistoricalImport(ctx,{sourceSystem:'csv',sourceKey:key,kind:'supplier_invoice',mode:'post_journal',accountingDate:'2023-11-14',evidenceId:source.sourceId,sourceRecordIds:['payable','expense','vat']}));
 return{operation:'historical_import.post' as const,entityType:'historical_import',entityId:result.importId};
}
it('retains the separately supported historical AP source date and closed period under actual independent approval',async()=>{
 const ref=await prepared();await expect(f.actor(ctx=>executeHistoricalImport(ctx,ref))).rejects.toThrow('Independent');
 const approvalId=await f.approve(ref),result=await f.actor(ctx=>executeHistoricalImport(ctx,ref,approvalId));
 expect(result).toMatchObject({accountingDate:'2023-11-14',amount:'1150',currency:'ZAR'});
 expect((await f.pool.query('SELECT j.entry_date::text,j.status,p.status AS period_status FROM gl_journal_entries j JOIN fiscal_periods p ON p.company_id=j.company_id AND p.id=j.fiscal_period_id WHERE j.company_id=$1 AND j.id=$2',[f.f.companyA,result.journalEntryId])).rows).toEqual([{entry_date:'2023-11-14',status:'posted',period_status:'closed'}]);
 expect((await f.pool.query('SELECT subtotal::text,tax_amount::text,total_amount::text,invoice_date::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[f.f.companyA,result.documentId])).rows).toEqual([{subtotal:'1000.00',tax_amount:'150.00',total_amount:'1150.00',invoice_date:'2023-11-14'}]);
});
it('refuses changed inactive historical accounts before retaining financial prefixes',async()=>{
 const ref=await prepared(),approvalId=await f.approve(ref);await f.pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[f.f.companyA,f.accounts.default_expense]);
 try{const before=await f.state();await expect(f.actor(ctx=>executeHistoricalImport(ctx,ref,approvalId))).rejects.toThrow();expect(await f.state()).toEqual(before);}
 finally{await f.pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[f.f.companyA,f.accounts.default_expense]);}
});
it('reports the distinct legacy admin invoice ingress refusal without committing its newly created bill',async()=>{
 const input={supplierName:'Synthetic AP CI supplier',invoiceNumber:randomUUID(),invoiceDate:'2023-11-14',dueDate:'2023-12-14',reference:'AP CI original admin source',subtotal:1000,taxAmount:150,totalAmount:1150} as Parameters<typeof commitAPInvoice>[2],before=await f.state();
 await expect(f.actor(()=>commitAPInvoice(f.f.companyA,f.f.u1.id,input))).rejects.toThrow();expect(await f.state()).toEqual(before);
});
