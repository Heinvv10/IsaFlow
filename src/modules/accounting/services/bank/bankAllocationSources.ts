import {assertBankVatAccount} from './bankAllocationVatPreparation';
import {loadBankAllocationDimensions} from './bankAllocationDimensions';
import {getVerifiedBeneficiary} from '../controls/beneficiaryService';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
import {buildBankAllocationLines,isBankAllocationRefund,type BankAllocationPlan} from './bankAllocationPlan';
import {materializeGlOperation} from '../controls/glOperationMaterializer';
import Decimal from 'decimal.js';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export async function loadBankAllocationSources(ctx:ControlTx,plan:BankAllocationPlan){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [bank]=await ctx.sql`SELECT * FROM bank_transactions WHERE company_id=${company}::uuid AND id=${plan.bankTransactionId}::uuid FOR UPDATE` as Row[];
 if(!bank)throw new Error('Owned bank transaction not found');
 const refund=isBankAllocationRefund(plan.kind,String(bank.amount));
 if(refund&&'applications' in plan&&plan.applications.length)throw new Error('Refund applications must be empty');
 const metadata=await ctx.sql`SELECT id,currency,gl_account_id FROM bank_accounts WHERE company_id=${company}::uuid AND gl_account_id=${bank.bank_account_id}::uuid ORDER BY id FOR SHARE` as Row[];
 const [ledger]=await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${company}::uuid FOR SHARE` as Row[];
 if(metadata.length!==1||metadata[0]!.currency!=='ZAR'||ledger?.default_currency!=='ZAR')throw new Error('Bank allocation requires unambiguous owned ZAR denomination');
 const accounts=await ctx.sql`SELECT id,account_code,account_name,account_type,account_subtype,is_active,is_system_account FROM gl_accounts WHERE company_id=${company}::uuid
  AND (id=${bank.bank_account_id}::uuid OR id=ANY(${('lines' in plan?[...plan.lines.map(l=>l.accountId),...(plan.vatAccountId?[plan.vatAccountId]:[])]:[])}::uuid[]) OR (is_system_account=true AND account_subtype IN('receivable','payable','vat_input','vat_output')))
  ORDER BY id FOR SHARE` as Row[];
 const bankAccount=accounts.find(a=>a.id===bank.bank_account_id);
 if(!bankAccount||bankAccount.is_active!==true||bankAccount.account_type!=='asset'||bankAccount.account_subtype!=='bank')throw new Error('Owned active bank GL account required');
 const system=(role:string,type:string)=>{const found=accounts.filter(a=>a.is_system_account===true&&a.account_subtype===role&&a.account_type===type&&a.is_active===true);if(found.length!==1)throw new Error('Allocation system account missing or ambiguous');return String(found[0]!.id);};
 const controlAccountId=plan.kind==='customer'?system('receivable','asset'):plan.kind==='supplier'?system('payable','liability'):null;
 const vatAccountId='lines' in plan&&plan.lines.some(l=>l.vatCode==='standard')?(plan.vatAccountId?assertBankVatAccount(accounts.find(account=>account.id===plan.vatAccountId),String(bank.amount))
  :system(new D(String(bank.amount)).lt(0)?'vat_input':'vat_output',new D(String(bank.amount)).lt(0)?'asset':'liability')):null;
 if('lines' in plan)for(const line of plan.lines){
  const account=accounts.find(a=>a.id===line.accountId);if(!account||account.is_active!==true||line.accountId===bank.bank_account_id)throw new Error('Owned active contra account required');
 }
 const dimensions=await loadBankAllocationDimensions(ctx,plan);
 let party:Row|null=null;const invoices:Row[]=[];
 if('applications' in plan){
  const rows=plan.kind==='customer'?await ctx.sql`SELECT id,name FROM customers WHERE company_id=${company}::uuid AND id=${plan.partyId}::uuid FOR SHARE`
   :await ctx.sql`SELECT id,name FROM suppliers WHERE company_id=${company}::uuid AND id=${plan.partyId}::uuid FOR SHARE`;
  party=(rows as Row[])[0]??null;if(!party)throw new Error('Owned allocation party required');
  for(const allocation of plan.applications){
   const rows=plan.kind==='customer'?await ctx.sql`SELECT *,COALESCE(client_id,customer_id) AS party_id,currency_code AS currency FROM customer_invoices WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid FOR UPDATE`
    :await ctx.sql`SELECT *,supplier_id AS party_id FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid FOR UPDATE`;
   const invoice=(rows as Row[])[0];
   if(!invoice||invoice.party_id!==plan.partyId||invoice.currency!=='ZAR'||!['approved','posted','sent','partially_paid','partial','paid','overdue'].includes(String(invoice.status))||!invoice.gl_journal_entry_id)throw new Error('Owned posted allocation invoice required');
   const journal=await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:String(invoice.gl_journal_entry_id),operation:'journal.post'});
   const facts=journal.observedSources[0]!.facts as {header:Row};
   if(facts.header.status!=='posted'||facts.header.reversed_at||facts.header.source_record_id!==invoice.id||facts.header.source!==(plan.kind==='customer'?'auto_invoice':'auto_supplier_invoice')||!new D(journal.binding.amount!).eq(String(invoice.total_amount)))throw new Error('Allocation invoice journal changed');
   invoices.push({invoice,journal:journal.observedSources,allocation});
  }
 }
 const lines=buildBankAllocationLines(plan,{bankAccountId:String(bank.bank_account_id),signedAmount:String(bank.amount),controlAccountId,vatAccountId});
 const periods=await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${company}::uuid AND start_date<=${bank.transaction_date}::date AND end_date>=${bank.transaction_date}::date ORDER BY id FOR UPDATE` as Row[];
 if(periods.length!==1)throw new Error('Unambiguous bank accounting period required');
 const vatLocks=await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${company}::uuid AND period_start<=${bank.transaction_date}::date AND period_end>=${bank.transaction_date}::date ORDER BY id FOR SHARE` as Row[];
 const beneficiary=plan.kind==='supplier'&&!refund?await getVerifiedBeneficiary(ctx,{entityType:'supplier',entityId:plan.partyId}):null;
 const receipts=await ctx.sql`SELECT p.* FROM customer_payments p JOIN gl_journal_entries je ON je.company_id=p.company_id AND je.id=p.gl_journal_entry_id
  WHERE p.company_id=${company}::uuid AND je.source_record_id=${plan.bankTransactionId}::uuid ORDER BY p.id FOR SHARE OF p` as Row[];
 const disbursements=await ctx.sql`SELECT p.* FROM supplier_payments p JOIN gl_journal_entries je ON je.company_id=p.company_id AND je.id=p.gl_journal_entry_id
  WHERE p.company_id=${company}::uuid AND je.source_record_id=${plan.bankTransactionId}::uuid ORDER BY p.id FOR SHARE OF p` as Row[];
 const receiptAllocations=await ctx.sql`SELECT a.* FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id JOIN gl_journal_entries je ON je.company_id=p.company_id AND je.id=p.gl_journal_entry_id
  WHERE p.company_id=${company}::uuid AND je.source_record_id=${plan.bankTransactionId}::uuid ORDER BY a.id FOR SHARE OF a` as Row[];
 const paymentAllocations=await ctx.sql`SELECT a.* FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id JOIN gl_journal_entries je ON je.company_id=p.company_id AND je.id=p.gl_journal_entry_id
  WHERE p.company_id=${company}::uuid AND je.source_record_id=${plan.bankTransactionId}::uuid ORDER BY a.id FOR SHARE OF a` as Row[];
 const generated=await ctx.sql`SELECT id FROM gl_journal_entries WHERE company_id=${company}::uuid AND source_record_id=${plan.bankTransactionId}::uuid AND status='posted' ORDER BY id LIMIT 101 FOR SHARE` as {id:string}[];
 if(generated.length>100)throw new Error('Bank allocation journal population exceeds limit');
 const generatedJournals=[];for(const journal of generated)generatedJournals.push((await materializeGlOperation(ctx,{entityType:'journal_entry',entityId:journal.id,operation:'journal.post'})).observedSources);
 const facts={bank,metadata,ledger,accounts,party,invoices,lines,periods,vatLocks,beneficiary,receipts,disbursements,receiptAllocations,paymentAllocations,generatedJournals,...(dimensions?{dimensions}:{})};
 return{...facts,fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
}
export type BankAllocationSources=Awaited<ReturnType<typeof loadBankAllocationSources>>;
