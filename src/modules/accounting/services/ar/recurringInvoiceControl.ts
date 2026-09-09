import {randomUUID} from 'node:crypto';
import {withSavepoint} from '@/lib/neon';
import {fmtDate} from '@/lib/fmtDate';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireArControl,runArControlled,type ArApprovalOptions} from './arControlBoundary';
import {resolveArAccounts} from '../controls/arControlAccounts';
import {deriveArRecurringMoney} from '../controls/arRecurringExact';
import {lockRecurringTemplate} from './recurringInvoiceLock';
import {RecurringInvoiceNotDueError} from './recurringInvoiceService';
import {postCustomerInvoiceFinancialEffect} from './customerInvoiceFinancialEffect';
import {mutateArRelatedEntity} from './arRelatedEntityEffect';
import type {ArRow} from '../controls/arSourceMaterial';
let sequence=0;
/** Preparation records a draft and immutable target; it never posts or advances a schedule. */
export async function prepareRecurringInvoiceRun(companyId:string,id:string,userId:string){
 const ctx=requireArControl(companyId,userId);
 await assertEffectivePermission(ctx,'write:invoices');
 return withSavepoint(`prepare_recurring_${++sequence}`,async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-ar:${companyId}`},0))`;
  const template=await lockRecurringTemplate(companyId,id);
  if(!template)throw new Error('Recurring invoice not found');
  if(template.status!=='active')throw new Error('Recurring invoice is not active');
  if(!template.is_due)throw new RecurringInvoiceNotDueError(id,fmtDate(template.next_run_date));
  const scheduledDate=fmtDate(template.next_run_date);
  const [existing]=await ctx.sql`SELECT id FROM control_recurring_invoice_runs WHERE company_id=${companyId}::uuid
   AND template_id=${id}::uuid AND scheduled_date=${scheduledDate}::date` as Array<{id:string}>;
  if(existing)return {entityType:'recurring_invoice_run',entityId:existing.id,operation:'recurring_invoice.generate'} as const;
  const accounts=await resolveArAccounts(ctx,[]),money=deriveArRecurringMoney(template,accounts.ledgerCurrency);
  const [customer]=await ctx.sql`SELECT id FROM customers WHERE company_id=${companyId}::uuid AND id=${String(template.client_id)}::uuid FOR SHARE`;
  if(!customer)throw new Error('Recurring customer not found');
  const [clock]=await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as Array<{day:string}>;
  if(!clock)throw new Error('Accounting clock unavailable');
  const invoiceId=randomUUID(),runId=randomUUID();
  await ctx.sql`INSERT INTO customer_invoices(id,company_id,invoice_number,client_id,customer_id,project_id,
   invoice_date,due_date,subtotal,tax_rate,tax_amount,total_amount,currency_code,exchange_rate,functional_total,status,notes,created_by)
   VALUES(${invoiceId}::uuid,${companyId}::uuid,${`INV-R-${runId}`},${String(template.client_id)}::uuid,${String(template.client_id)}::uuid,
   ${template.project_id??null},${clock.day}::date,${clock.day}::date+30,${money.subtotal}::numeric,${String(template.tax_rate??0)}::numeric,
   ${money.tax}::numeric,${money.amount}::numeric,${money.currency},1,${money.amount}::numeric,'draft',${template.description??template.template_name},${userId}::uuid)`;
  for(const line of money.lines)await ctx.sql`INSERT INTO customer_invoice_items(invoice_id,description,unit_price,quantity,amount,tax_rate)
   SELECT id,${line.description},${line.unit_price}::numeric,${line.quantity}::numeric,${line.amount}::numeric,${String(template.tax_rate??0)}::numeric
   FROM customer_invoices WHERE company_id=${companyId}::uuid AND id=${invoiceId}::uuid`;
  await ctx.sql`INSERT INTO control_recurring_invoice_runs(company_id,id,template_id,scheduled_date,invoice_id,requester_person_id)
   VALUES(${companyId}::uuid,${runId}::uuid,${id}::uuid,${scheduledDate}::date,${invoiceId}::uuid,${userId})`;
  return {entityType:'recurring_invoice_run',entityId:runId,operation:'recurring_invoice.generate'} as const;
 });
}
export async function generateInvoiceFromRecurring(companyId:string,id:string,userId:string,opts?:ArApprovalOptions&{runId?:string}):Promise<string>{
 const ctx=requireArControl(companyId,userId);
 const parent=opts?.runId?{entityType:'recurring_invoice_run',entityId:opts.runId,operation:'recurring_invoice.generate'} as const:await prepareRecurringInvoiceRun(companyId,id,userId);
 return runArControlled(companyId,userId,parent,opts,async permit=>{
  const [intent]=await ctx.sql`SELECT * FROM control_recurring_invoice_runs WHERE company_id=${companyId}::uuid AND id=${parent.entityId}::uuid AND template_id=${id}::uuid` as ArRow[];
  if(!intent)throw new Error('Recurring run does not belong to template');
  const template=await lockRecurringTemplate(companyId,id);
  if(!template||template.status!=='active'||!template.is_due||fmtDate(template.next_run_date)!==fmtDate(intent.scheduled_date))throw new Error('Recurring schedule changed');
  const invoiceId=String(intent.invoice_id),parentControl={permit,parent};
  await mutateArRelatedEntity(ctx,'customer_invoice',invoiceId,parentControl,'recurring_invoice_posted',async()=>{
   const changed=await ctx.sql`UPDATE customer_invoices SET status='approved',updated_at=clock_timestamp()
    WHERE company_id=${companyId}::uuid AND id=${invoiceId}::uuid AND status='draft' AND gl_journal_entry_id IS NULL RETURNING id`;
   if(changed.length!==1)throw new Error('Prepared recurring invoice is no longer draft');
   await postCustomerInvoiceFinancialEffect(companyId,invoiceId,userId,parentControl);
  });
  const nextDate=advanceDate(fmtDate(template.next_run_date),String(template.frequency));
  const status=template.end_date&&nextDate>fmtDate(template.end_date)?'completed':'active';
  await mutateArRelatedEntity(ctx,'recurring_invoice',id,parentControl,'recurring_schedule_advanced',()=>ctx.sql`UPDATE recurring_invoices
   SET last_run_date=${permit.accountingDate}::date,next_run_date=${nextDate}::date,run_count=run_count+1,status=${status}
   WHERE company_id=${companyId}::uuid AND id=${id}::uuid`);
  return invoiceId;
 });
}
function advanceDate(date:string,frequency:string){
 const result=new Date(`${date}T12:00:00Z`);
 if(frequency==='weekly')result.setUTCDate(result.getUTCDate()+7);
 else if(frequency==='monthly')result.setUTCMonth(result.getUTCMonth()+1);
 else if(frequency==='quarterly')result.setUTCMonth(result.getUTCMonth()+3);
 else if(frequency==='annually')result.setUTCFullYear(result.getUTCFullYear()+1);
 else throw new Error('Unsupported recurring frequency');
 return result.toISOString().slice(0,10);
}
