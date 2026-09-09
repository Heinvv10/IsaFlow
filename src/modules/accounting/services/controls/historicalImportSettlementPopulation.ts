import Decimal from 'decimal.js';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {HistoricalImportNormalized} from './historicalImportTypes';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
/** Lock the invoice against new allocation FKs and bind its entire posted payment population. */
export async function loadHistoricalSettlementPopulation(ctx:ControlTx,source:HistoricalImportNormalized){
 assertControlTx(ctx);const doc=source.document;if(!doc)return null;
 const company=ctx.principal.companyId,ar=source.kind==='customer_invoice';
 const invoices=ar?await ctx.sql`SELECT id,status,gl_journal_entry_id,invoice_date::text,due_date::text,subtotal::text,tax_amount::text,total_amount::text,amount_paid::text,currency_code,exchange_rate::text FROM customer_invoices WHERE company_id=${company}::uuid
  AND COALESCE(client_id,customer_id)=${doc.partyId}::uuid AND invoice_number=${doc.invoiceNumber} ORDER BY id FOR UPDATE`
  :await ctx.sql`SELECT id,status,gl_journal_entry_id,invoice_date::text,due_date::text,subtotal::text,tax_amount::text,total_amount::text,amount_paid::text,currency,currency_code,exchange_rate::text FROM supplier_invoices WHERE company_id=${company}::uuid
  AND supplier_id=${doc.partyId}::uuid AND invoice_number=${doc.invoiceNumber} ORDER BY id FOR UPDATE`;
 if(invoices.length>1||(!invoices.length&&doc.settlements.length))throw new Error('Historical settlement allocation population unavailable');
 const invoice=invoices[0] as Row|undefined;if(!invoice)return null;
 if(source.existingJournalId&&invoice.gl_journal_entry_id!==null&&invoice.gl_journal_entry_id!==source.existingJournalId)throw new Error('Historical invoice prior journal differs from source');
 const allocations=ar?await ctx.sql`SELECT a.id,a.amount_allocated::text,p.id AS payment_id,p.status,j.id AS journal_id
  FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id AND p.company_id=${company}::uuid
  JOIN gl_journal_entries j ON j.company_id=p.company_id AND j.id=p.gl_journal_entry_id
  WHERE a.invoice_id=${invoice.id}::uuid AND j.status='posted' AND j.reversed_at IS NULL ORDER BY a.id FOR SHARE OF a,p,j`
  :await ctx.sql`SELECT a.id,a.amount_allocated::text,p.id AS payment_id,p.status,j.id AS journal_id
  FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id AND p.company_id=${company}::uuid
  JOIN gl_journal_entries j ON j.company_id=p.company_id AND j.id=p.gl_journal_entry_id
  WHERE a.invoice_id=${invoice.id}::uuid AND j.status='posted' AND j.reversed_at IS NULL ORDER BY a.id FOR SHARE OF a,p,j`;
 if(allocations.length!==doc.settlements.length||allocations.some(row=>{
  const allocation=row as Row,expected=doc.settlements.find(s=>s.journalId===allocation.journal_id);
  return !expected||!new D(String(allocation.amount_allocated)).eq(expected.amount);
 }))throw new Error('Historical settlement allocation population differs from evidence');
 return{invoice,allocations};
}
