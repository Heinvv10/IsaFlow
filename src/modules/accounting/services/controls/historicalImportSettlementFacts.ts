import Decimal from 'decimal.js';
import type {ControlTx} from './contracts';
import type {HistoricalImportNormalized} from './historicalImportTypes';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
/** Paid state needs an actual owned document allocation and its exact control/bank journal. */
export async function loadHistoricalSettlementFacts(ctx:ControlTx,source:HistoricalImportNormalized,accounts:Row[]){
 const doc=source.document;if(!doc||!doc.settlements.length)return[];
 const company=ctx.principal.companyId,ar=source.kind==='customer_invoice';
 const control=accounts.find(a=>a.account_subtype===(ar?'receivable':'payable'));
 if(!control)throw new Error('Historical settlement control account unavailable');
 const result:Row[]=[];
 for(const settlement of doc.settlements){
  const payments=ar?await ctx.sql`SELECT p.id,p.total_amount::text,p.status,p.bank_account_id,a.amount_allocated::text,ci.id AS invoice_id,
    (SELECT count(*)::int FROM customer_payment_allocations x WHERE x.payment_id=p.id) AS allocation_count
   FROM customer_payments p JOIN customer_payment_allocations a ON a.payment_id=p.id
   JOIN customer_invoices ci ON ci.company_id=p.company_id AND ci.id=a.invoice_id AND COALESCE(ci.client_id,ci.customer_id)=p.client_id
   WHERE p.company_id=${company}::uuid AND p.gl_journal_entry_id=${settlement.journalId}::uuid AND p.client_id=${doc.partyId}::uuid
    AND ci.invoice_number=${doc.invoiceNumber} ORDER BY p.id FOR SHARE OF p,a,ci`
   :await ctx.sql`SELECT p.id,p.total_amount::text,p.status,p.bank_account_id,a.amount_allocated::text,si.id AS invoice_id,
    (SELECT count(*)::int FROM payment_allocations x WHERE x.payment_id=p.id) AS allocation_count
   FROM supplier_payments p JOIN payment_allocations a ON a.payment_id=p.id
   JOIN supplier_invoices si ON si.company_id=p.company_id AND si.id=a.invoice_id AND si.supplier_id=p.supplier_id
   WHERE p.company_id=${company}::uuid AND p.gl_journal_entry_id=${settlement.journalId}::uuid AND p.supplier_id=${doc.partyId}::uuid
    AND si.invoice_number=${doc.invoiceNumber} ORDER BY p.id FOR SHARE OF p,a,si`;
  const payment=payments[0] as Row|undefined;
  if(payments.length!==1||!payment||payment.status!==(ar?'confirmed':'processed')||payment.allocation_count!==1
   ||!new D(String(payment.amount_allocated)).eq(settlement.amount)||!new D(String(payment.total_amount)).eq(settlement.amount))throw new Error('Historical settlement lacks exact party and document allocation evidence');
  const banks=await ctx.sql`SELECT b.id,b.gl_account_id,b.is_active,ga.is_active AS gl_active,ga.account_type,ga.account_subtype FROM bank_accounts b
   JOIN gl_accounts ga ON ga.company_id=b.company_id AND ga.id=b.gl_account_id
   WHERE b.company_id=${company}::uuid AND (b.id=${payment.bank_account_id}::uuid OR b.gl_account_id=${payment.bank_account_id}::uuid)
   ORDER BY b.id FOR SHARE OF b,ga` as Row[];
  const bank=banks[0];
  if(banks.length!==1||!bank||bank.is_active!==true||bank.gl_active!==true||bank.account_type!=='asset'||bank.account_subtype!=='bank')throw new Error('Historical settlement bank evidence unavailable');
  const journals=await ctx.sql`SELECT id,entry_date::text,status,reversed_at FROM gl_journal_entries
   WHERE company_id=${company}::uuid AND id=${settlement.journalId}::uuid FOR SHARE` as Row[];
  const journal=journals[0];if(journals.length!==1||!journal||journal.status!=='posted'||journal.reversed_at!==null||String(journal.entry_date)<source.accountingDate)throw new Error('Historical settlement journal unavailable');
  const lines=await ctx.sql`SELECT id,gl_account_id,debit::text,credit::text FROM gl_journal_lines
   WHERE company_id=${company}::uuid AND journal_entry_id=${settlement.journalId}::uuid ORDER BY id LIMIT 3 FOR SHARE` as Row[];
  const controlLine=lines.find(line=>line.gl_account_id===control.id),bankLine=lines.find(line=>line.gl_account_id===bank.gl_account_id);
  if(lines.length!==2||!controlLine||!bankLine||!new D(String(ar?controlLine.credit:controlLine.debit)).eq(settlement.amount)
   ||!new D(String(ar?bankLine.debit:bankLine.credit)).eq(settlement.amount)||!new D(String(ar?controlLine.debit:controlLine.credit)).isZero()
   ||!new D(String(ar?bankLine.credit:bankLine.debit)).isZero())throw new Error('Historical settlement control and bank legs differ');
  result.push({payment,bank,journal,lines,amount:settlement.amount});
 }
 return result;
}
