import Decimal from 'decimal.js';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {materializeGlOperation} from '../controls/glOperationMaterializer';
import type {CashApplicationPlan} from './cashApplicationPlan';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export async function loadCashApplicationInvoices(ctx:ControlTx,plan:CashApplicationPlan,partyId:string){
 assertControlTx(ctx);const company=ctx.principal.companyId,items=[];
 for(const allocation of [...plan.applications].sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId))){
  const rows=plan.kind==='customer'?await ctx.sql`SELECT *,COALESCE(client_id,customer_id) AS party_id,currency_code AS currency
   FROM customer_invoices WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid FOR UPDATE`
   :await ctx.sql`SELECT *,supplier_id AS party_id FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid FOR UPDATE`;
  const invoice=(rows as Row[])[0];
  if(!invoice||invoice.party_id!==partyId||invoice.currency!=='ZAR'||!['approved','posted','sent','partially_paid','partial','paid','overdue'].includes(String(invoice.status)))throw new Error('Owned posted cash application invoice required');
  const [journal]=await ctx.sql`SELECT id,status,source,source_record_id,reversed_at FROM gl_journal_entries
   WHERE company_id=${company}::uuid AND id=${invoice.gl_journal_entry_id}::uuid FOR SHARE` as Row[];
  if(!journal||journal.status!=='posted'||journal.reversed_at||journal.source_record_id!==invoice.id||journal.source!==(plan.kind==='customer'?'auto_invoice':'auto_supplier_invoice'))throw new Error('Live invoice source journal required');
  const material=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:String(journal.id),operation:'journal.post'});
  if(material.binding.currency!=='ZAR'||!new D(String(material.binding.amount)).eq(String(invoice.total_amount)))throw new Error('Invoice journal denomination or amount changed');
  items.push({allocation,invoice,journal,observedSources:material.observedSources});
 }
 return items;
}
