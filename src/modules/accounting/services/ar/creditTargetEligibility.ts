import Decimal from 'decimal.js';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {materializeGlOperation} from '../controls/glOperationMaterializer';
/** Credit allocation requires a real current receivable/payable, including its posted journal. */
export async function assertPostedCreditTarget(ctx:ControlTx,kind:'customer'|'supplier',id:string):Promise<void>{
 assertControlTx(ctx);
 const company=ctx.principal.companyId;
 const rows=kind==='customer'
  ?await ctx.sql`SELECT status,gl_journal_entry_id,total_amount,currency_code AS currency FROM customer_invoices WHERE company_id=${company}::uuid AND id=${id}::uuid FOR UPDATE`
  :await ctx.sql`SELECT status,gl_journal_entry_id,total_amount,currency FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${id}::uuid FOR UPDATE`;
 const invoice=rows[0] as {status:string;gl_journal_entry_id:string|null;total_amount:string;currency:string}|undefined;
 if(rows.length!==1||!invoice||!['approved','posted','sent','partially_paid','partial','paid','overdue'].includes(invoice.status)||!invoice.gl_journal_entry_id)throw new Error('Credit target requires an eligible posted invoice');
 const [journal]=await ctx.sql`SELECT status,reversed_at,source,source_record_id FROM gl_journal_entries
  WHERE company_id=${company}::uuid AND id=${invoice.gl_journal_entry_id}::uuid FOR SHARE` as Array<{status:string;reversed_at:unknown;source:string;source_record_id:string|null}>;
 const source=kind==='customer'?'auto_invoice':'auto_supplier_invoice';
 if(!journal||journal.status!=='posted'||journal.reversed_at||journal.source!==source||journal.source_record_id!==id)throw new Error('Credit target requires its own live posted invoice journal');
 const material=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:invoice.gl_journal_entry_id,operation:'journal.post'});
 if(material.binding.amount===null||!new Decimal(material.binding.amount).eq(invoice.total_amount)||material.binding.currency!==invoice.currency)throw new Error('Credit target posted journal does not reconcile');
}
