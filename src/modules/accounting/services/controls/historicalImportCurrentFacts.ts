import Decimal from 'decimal.js';
import {canonicalJson} from './canonical';
import {journalAffectsVatReturn} from './journalVatFootprint';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {HistoricalImportNormalized} from './historicalImportTypes';
import {loadHistoricalSettlementFacts} from './historicalImportSettlementFacts';
type Row=Record<string,unknown>;
const D=Decimal.clone({precision:80});
export async function loadHistoricalImportCurrentFacts(ctx:ControlTx,source:HistoricalImportNormalized){
 assertControlTx(ctx);const companyId=ctx.principal.companyId;
 const [company]=await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${companyId}::uuid FOR SHARE` as Row[];
 if(!company||company.default_currency!=='ZAR'||source.currency!==company.default_currency)throw new Error('Historical ledger currency unavailable or unsupported');
 const codes=[...new Set(source.records.map(row=>row.accountCode))].sort();
 const accounts=await ctx.sql`SELECT id,account_code,account_name,account_type,account_subtype,is_active,level FROM gl_accounts
  WHERE company_id=${companyId}::uuid AND account_code=ANY(${codes}::text[]) ORDER BY id FOR SHARE` as Row[];
 if(accounts.length!==codes.length||new Set(accounts.map(a=>a.account_code)).size!==codes.length||accounts.some(a=>a.is_active!==true||Number(a.level)!==3))throw new Error('Historical account missing, inactive or ambiguous');
 const plan=source.records.map(row=>({glAccountId:String(accounts.find(a=>a.account_code===row.accountCode)!.id),debit:row.debit,credit:row.credit,description:row.description,...(row.vatType?{vatType:row.vatType}:{})}));
 const periods=await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods WHERE company_id=${companyId}::uuid
  AND start_date<=${source.accountingDate}::date AND end_date>=${source.accountingDate}::date ORDER BY id FOR SHARE` as Row[];
 if(periods.length!==1||!['open','closed'].includes(String(periods[0]!.status)))throw new Error('Historical period unavailable, locked or ambiguous');
 if(company.lockdown_enabled===true&&(!company.lockdown_date||source.accountingDate<=String(company.lockdown_date)))throw new Error('Historical date is within company lockdown');
 const vatLines=plan.map(row=>({gl_account_id:row.glAccountId,vat_type:row.vatType??null}));
 const vatLocks=journalAffectsVatReturn(vatLines,accounts)?await ctx.sql`SELECT id,period_start::text,period_end::text FROM vat_period_locks
  WHERE company_id=${companyId}::uuid AND period_start<=${source.accountingDate}::date AND period_end>=${source.accountingDate}::date ORDER BY id FOR SHARE` as Row[]:[];
 if(vatLocks.length)throw new Error('Historical date is within a filed VAT period');
 let party:Row|null=null;
 if(source.document){
  const partyId=source.document.partyId;
  const rows=source.kind==='customer_invoice'?await ctx.sql`SELECT id,name,is_active FROM customers WHERE company_id=${companyId}::uuid AND id=${partyId}::uuid FOR SHARE`
   :await ctx.sql`SELECT id,name,is_active FROM suppliers WHERE company_id=${companyId}::uuid AND id=${partyId}::uuid FOR SHARE`;
  party=rows[0] as Row??null;if(!party||party.is_active!==true)throw new Error('Historical document party missing or inactive');
  assertHistoricalDocumentPlan(source,accounts,plan);
 }
 let existingJournal:Row|null=null;let existingLines:Row[]=[];
 if(source.existingJournalId){
  const rows=await ctx.sql`SELECT id,entry_date::text,status,reversed_at,source,posting_agent FROM gl_journal_entries
   WHERE company_id=${companyId}::uuid AND id=${source.existingJournalId}::uuid FOR SHARE` as Row[];
  existingJournal=rows[0]??null;
  if(!existingJournal||existingJournal.status!=='posted'||existingJournal.reversed_at!==null||existingJournal.entry_date!==source.accountingDate
   ||!['auto_migration','auto_gl_import','manual'].includes(String(existingJournal.source)))throw new Error('Historical attachment journal unavailable');
  existingLines=await ctx.sql`SELECT id,gl_account_id,debit::text,credit::text,vat_type FROM gl_journal_lines
   WHERE company_id=${companyId}::uuid AND journal_entry_id=${source.existingJournalId}::uuid ORDER BY id LIMIT 1001 FOR SHARE` as Row[];
  const shape=(rows:Array<{id:string;debit:string;credit:string;vat:unknown}>)=>rows.map(row=>canonicalJson(row)).sort();
  if(canonicalJson(shape(existingLines.map(r=>({id:String(r.gl_account_id),debit:new D(String(r.debit)).toFixed(),credit:new D(String(r.credit)).toFixed(),vat:r.vat_type??null}))))
   !==canonicalJson(shape(plan.map(r=>({id:r.glAccountId,debit:r.debit,credit:r.credit,vat:r.vatType??null})))))throw new Error('Historical attachment journal lines differ from evidence');
 }
 const settlements=await loadHistoricalSettlementFacts(ctx,source,accounts);
 return{company,accounts,period:periods[0]!,vatLocks,party,plan,existingJournal,existingLines,settlements};
}
export function assertHistoricalDocumentPlan(source:HistoricalImportNormalized,accounts:Row[],plan:Array<{glAccountId:string;debit:string;credit:string}>){
 const doc=source.document;if(!doc)return;
 const ar=source.kind==='customer_invoice',control=ar?'receivable':'payable',vat=ar?'vat_output':'vat_input';
 let controlTotal=new D(0),vatTotal=new D(0),baseTotal=new D(0);const controls=new Set<string>();
 for(const line of plan){
  const account=accounts.find(a=>a.id===line.glAccountId)!;
  if(account.account_subtype===control){if(account.account_type!==(ar?'asset':'liability'))throw new Error('Historical control account classification differs');controls.add(line.glAccountId);controlTotal=controlTotal.add(ar?line.debit:line.credit);if(new D(ar?line.credit:line.debit).gt(0))throw new Error('Historical document control direction differs');}
  else if(account.account_subtype===vat){if(account.account_type!==(ar?'liability':'asset'))throw new Error('Historical VAT account classification differs');vatTotal=vatTotal.add(ar?line.credit:line.debit);if(new D(ar?line.debit:line.credit).gt(0))throw new Error('Historical document VAT direction differs');}
  else{if((ar&&account.account_type!=='revenue')||(!ar&&!['expense','asset'].includes(String(account.account_type)))
    ||['bank','cash','receivable','payable','vat_input','vat_output'].includes(String(account.account_subtype))||new D(ar?line.debit:line.credit).gt(0))throw new Error('Historical document base account differs');
   baseTotal=baseTotal.add(ar?line.credit:line.debit);}
 }
 if(controls.size!==1||!controlTotal.eq(doc.totalAmount)||!vatTotal.eq(doc.taxAmount)||!baseTotal.eq(doc.subtotal))throw new Error('Historical document plan does not reconcile');
}
