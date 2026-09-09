import Decimal from 'decimal.js';
import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {withSavepoint} from '@/lib/neon';
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
import {allocationMoney,isBankAllocationRefund} from './bankAllocationPlan';
import {prepareBankAllocation} from './bankAllocationControl';
const D=Decimal.clone({precision:80});
const id=z.string().uuid().transform(value=>value.toLowerCase());
const request=z.object({kind:z.enum(['customer','supplier']),bankTransactionId:id,partyId:id,
 description:z.string().max(1000).optional(),autoApply:z.boolean().optional(),cc1Id:id.optional(),cc2Id:id.optional(),buId:id.optional(),
 applications:z.array(z.object({invoiceId:id,amount:z.string().transform(allocationMoney)}).strict()).max(100).optional()}).strict();
type Candidate={id:string;outstanding:string};
/** Contact defaults select exact instructions once, before immutable approval material is made. */
export async function preparePartyBankAllocation(ctx:ControlTx,input:unknown){
 assertControlTx(ctx);const parsed=request.parse(input),company=ctx.principal.companyId;
 await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
 return withSavepoint('bank_default_prepare',async()=>{
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
  const [bank]=await ctx.sql`SELECT amount::text FROM bank_transactions WHERE company_id=${company}::uuid
   AND id=${parsed.bankTransactionId}::uuid FOR UPDATE` as {amount:string}[];
  if(!bank)throw new Error('Owned bank transaction not found');
  const parties=parsed.kind==='customer'?await ctx.sql`SELECT auto_allocate_strategy FROM customers
   WHERE company_id=${company}::uuid AND id=${parsed.partyId}::uuid FOR SHARE`
   :await ctx.sql`SELECT auto_allocate_strategy FROM suppliers WHERE company_id=${company}::uuid AND id=${parsed.partyId}::uuid FOR SHARE`;
  if(parties.length!==1)throw new Error('Owned allocation party required');
  const strategy=(parties[0] as {auto_allocate_strategy:string|null}).auto_allocate_strategy;
  let applications=parsed.applications;
  if(applications===undefined){
   applications=[];
   if(parsed.autoApply!==false&&!isBankAllocationRefund(parsed.kind,bank.amount)&&strategy&&strategy!=='off'){
    if(strategy!=='oldest'&&strategy!=='newest')throw new Error('Unknown bank allocation strategy');
    const oldest=strategy==='oldest';
    // A single probe beyond the immutable plan limit distinguishes exhausted cash from a truncated plan.
    const rows=(parsed.kind==='customer'?await ctx.sql`
     SELECT id,(total_amount-COALESCE(amount_paid,0))::text AS outstanding FROM customer_invoices
     WHERE company_id=${company}::uuid AND COALESCE(client_id,customer_id)=${parsed.partyId}::uuid
      AND status<>ALL(${['draft','pending_approval','cancelled','paid','written_off']}::text[])
      AND total_amount-COALESCE(amount_paid,0)>0.01
     ORDER BY CASE WHEN ${oldest} THEN invoice_date END ASC,CASE WHEN NOT ${oldest} THEN invoice_date END DESC,
      CASE WHEN ${oldest} THEN created_at END ASC,CASE WHEN NOT ${oldest} THEN created_at END DESC,
      CASE WHEN ${oldest} THEN id END ASC,CASE WHEN NOT ${oldest} THEN id END DESC LIMIT 101 FOR UPDATE`
     :await ctx.sql`
     SELECT id,(total_amount-COALESCE(amount_paid,0))::text AS outstanding FROM supplier_invoices
     WHERE company_id=${company}::uuid AND supplier_id=${parsed.partyId}::uuid AND deleted_at IS NULL
      AND status<>ALL(${['draft','cancelled','paid','written_off']}::text[])
      AND total_amount-COALESCE(amount_paid,0)>0.01
     ORDER BY CASE WHEN ${oldest} THEN invoice_date END ASC,CASE WHEN NOT ${oldest} THEN invoice_date END DESC,
      CASE WHEN ${oldest} THEN created_at END ASC,CASE WHEN NOT ${oldest} THEN created_at END DESC,
      CASE WHEN ${oldest} THEN id END ASC,CASE WHEN NOT ${oldest} THEN id END DESC LIMIT 101 FOR UPDATE`) as Candidate[];
    let remaining=new D(allocationMoney(new D(bank.amount).abs().toFixed()));
    for(const row of rows){
     if(remaining.lte('0.01'))break;
     const amount=D.min(remaining,new D(row.outstanding));
     if(applications.length===100)throw new Error('Default allocation requires more than 100 applications');
     applications.push({invoiceId:row.id,amount:allocationMoney(amount.toFixed())});remaining=remaining.sub(amount);
    }
   }
  }
  return prepareBankAllocation(ctx,{version:1,kind:parsed.kind,bankTransactionId:parsed.bankTransactionId,
   partyId:parsed.partyId,description:parsed.description,applications,cc1Id:parsed.cc1Id,cc2Id:parsed.cc2Id,buId:parsed.buId});
 });
}
