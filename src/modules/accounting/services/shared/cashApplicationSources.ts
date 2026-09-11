import {verifyCashAccountingLegs} from './cashApplicationJournalProof';
import {verifyCashBankOrigin} from './cashApplicationBankOrigin';
import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {materializeGlOperation} from '../controls/glOperationMaterializer';
import {getVerifiedBeneficiary} from '../controls/beneficiaryService';
import {loadCashApplicationInvoices} from './cashApplicationInvoiceSources';
import {cashApplicationMoney,type CashApplicationPlan} from './cashApplicationPlan';
import {CANONICAL_UUID_TEXT} from '../controls/intentIdentity';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export async function loadCashApplicationSources(ctx:ControlTx,plan:CashApplicationPlan){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [ledger]=await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${company}::uuid FOR SHARE` as Row[];
 if(ledger?.default_currency!=='ZAR')throw new Error('Cash application requires ZAR ledger');
 const rows=plan.kind==='customer'?await ctx.sql`SELECT *,client_id AS party_id FROM customer_payments WHERE company_id=${company}::uuid AND id=${plan.paymentId}::uuid FOR UPDATE`
  :await ctx.sql`SELECT *,supplier_id AS party_id FROM supplier_payments WHERE company_id=${company}::uuid AND id=${plan.paymentId}::uuid FOR UPDATE`;
 const payment=(rows as Row[])[0];
 if(!payment||!(plan.kind==='customer'?['confirmed','reconciled']:['processed','reconciled']).includes(String(payment.status)))throw new Error('Owned posted cash payment required');
 if(payment.currency_code!=null&&payment.currency_code!=='ZAR')throw new Error('Cash application requires supported ZAR denomination');
 if(plan.accountingDate<fmtDate(payment.payment_date as string|Date))throw new Error('Cash application cannot predate its payment');
 cashApplicationMoney(String(payment.total_amount));
 const partyRows=plan.kind==='customer'?await ctx.sql`SELECT id,name FROM customers WHERE company_id=${company}::uuid AND id=${payment.party_id}::uuid FOR SHARE`
  :await ctx.sql`SELECT id,name FROM suppliers WHERE company_id=${company}::uuid AND id=${payment.party_id}::uuid FOR SHARE`;
 const party=(partyRows as Row[])[0];if(!party)throw new Error('Owned cash application party required');
 const [journal]=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND id=${payment.gl_journal_entry_id}::uuid FOR SHARE` as Row[];
 const origins=await ctx.sql`SELECT e.id,e.entity_id,e.result FROM control_operation_effects e
  JOIN LATERAL(SELECT i.* FROM control_bank_allocation_intents i WHERE i.company_id=e.company_id AND i.id=CASE WHEN e.entity_id_canonical ~ ${CANONICAL_UUID_TEXT} THEN e.entity_id_canonical::uuid END AND i.id::text=e.entity_id_canonical OFFSET 0) i ON true
  WHERE e.company_id=${company}::uuid AND e.operation='bank_allocation.post' AND e.entity_type='bank_allocation_intent' AND e.result->>'paymentId'=${plan.paymentId}
  AND i.currency='ZAR' AND i.payload->>'kind'=${plan.kind} ORDER BY e.id LIMIT 2` as {id:string;entity_id:string;result:{journalEntryId:string;bankTransactionId:string}}[];
 if(origins.length>1)throw new Error('Ambiguous original bank payment effect');
 const origin=origins[0]??null;
 if(!journal||journal.status!=='posted'||journal.reversed_at||journal.source!==(plan.kind==='customer'?'auto_payment':'auto_supplier_payment')
  ||journal.source_record_id!==(origin?origin.result.bankTransactionId:plan.paymentId)||(origin&&origin.result.journalEntryId!==journal.id))throw new Error('Live original cash source journal required');
 const bankOriginProof=origin?await verifyCashBankOrigin(ctx,origin.id,origin.entity_id,plan.kind,payment,journal):null;
 const cashJournal=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:String(journal.id),operation:'journal.post'});
 if(cashJournal.binding.accountingDate!==fmtDate(payment.payment_date as string|Date)||cashJournal.binding.currency!=='ZAR'||!new D(String(cashJournal.binding.amount)).eq(String(payment.total_amount)))throw new Error('Cash journal date, amount or denomination changed');
 const accountingLegs=await verifyCashAccountingLegs(ctx,String(journal.id),plan.kind,'payment',String(payment.total_amount),payment.bank_account_id?String(payment.bank_account_id):null);
 const allocations=(plan.kind==='customer'?await ctx.sql`SELECT a.*,i.currency_code AS invoice_currency FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id LEFT JOIN customer_invoices i ON i.company_id=p.company_id AND i.id=a.invoice_id
  WHERE p.company_id=${company}::uuid AND p.id=${plan.paymentId}::uuid ORDER BY a.id LIMIT 10001 FOR SHARE OF a`
  :await ctx.sql`SELECT a.*,i.currency AS invoice_currency FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id LEFT JOIN supplier_invoices i ON i.company_id=p.company_id AND i.id=a.invoice_id
  WHERE p.company_id=${company}::uuid AND p.id=${plan.paymentId}::uuid ORDER BY a.id LIMIT 10001 FOR SHARE OF a`) as Row[];
 const originalInvoiceIds=[...new Set(allocations.map(a=>String(a.invoice_id)))].sort();
 const originalInvoices=(plan.kind==='customer'?await ctx.sql`SELECT id,currency_code AS currency FROM customer_invoices
  WHERE company_id=${company}::uuid AND id=ANY(${originalInvoiceIds}::uuid[]) ORDER BY id FOR SHARE`
  :await ctx.sql`SELECT id,currency FROM supplier_invoices WHERE company_id=${company}::uuid AND id=ANY(${originalInvoiceIds}::uuid[]) ORDER BY id FOR SHARE`) as Row[];
 if(originalInvoices.length!==originalInvoiceIds.length||originalInvoices.some(i=>i.currency!=='ZAR'))throw new Error('Original cash invoice ownership or denomination changed');
 if(allocations.some(a=>a.invoice_currency!=='ZAR'))throw new Error('Original cash allocations have unknown or unsupported denomination');
 if(!origin&&payment.currency_code==null&&allocations.length===0)throw new Error('Legacy unapplied cash denomination needs explicit owned source proof');
 if(allocations.length>10000)throw new Error('Cash allocation population exceeds supported bound');
 const invoices=await loadCashApplicationInvoices(ctx,plan,String(party.id));
 if(invoices.some(i=>plan.accountingDate<fmtDate(i.invoice.invoice_date as string|Date)))throw new Error('Cash application cannot predate an invoice');
 const periods=await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${company}::uuid AND start_date<=${plan.accountingDate}::date AND end_date>=${plan.accountingDate}::date ORDER BY id FOR UPDATE` as Row[];
 const vatLocks=await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${company}::uuid AND period_start<=${plan.accountingDate}::date AND period_end>=${plan.accountingDate}::date ORDER BY id FOR SHARE` as Row[];
 const beneficiary=plan.kind==='supplier'?await getVerifiedBeneficiary(ctx,{entityType:'supplier',entityId:String(party.id)}):null;
 const facts={ledger,payment,party,journal,cashJournal:cashJournal.observedSources,origin,bankOriginProof,accountingLegs,allocations,originalInvoices,invoices,periods,vatLocks,beneficiary};
 return{...facts,fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
}
