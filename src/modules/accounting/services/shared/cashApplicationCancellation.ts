import type {ControlTx} from '../controls/contracts';
import {assertControlTx} from '../controls/context';
/** Cash must be unapplied through its own approved inverse before reversing the original payment. */
export async function assertCashApplicationsUnapplied(ctx:ControlTx,paymentId:string,kind:'customer'|'supplier'){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const rows=kind==='customer'?await ctx.sql`SELECT a.id FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
  WHERE p.company_id=${company}::uuid AND p.id=${paymentId}::uuid AND a.application_intent_id IS NOT NULL AND a.reversed_at IS NULL LIMIT 1 FOR SHARE OF a`
  :await ctx.sql`SELECT a.id FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id
  WHERE p.company_id=${company}::uuid AND p.id=${paymentId}::uuid AND a.application_intent_id IS NOT NULL AND a.reversed_at IS NULL LIMIT 1 FOR SHARE OF a`;
 if(rows.length)throw new Error('Controlled cash application requires approved unapplication before payment reversal');
}
