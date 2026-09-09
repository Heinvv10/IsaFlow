import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
export type ArRow=Record<string,unknown>;
async function fence(ctx:ControlTx){assertControlTx(ctx);await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-ar:${ctx.principal.companyId}`},0))`;}
export async function lockArInvoiceSources(ctx:ControlTx,id:string){
 await fence(ctx);const company=ctx.principal.companyId;
 const [header]=await ctx.sql`SELECT ci.*,COALESCE(ci.client_id,ci.customer_id) AS owned_customer_id
 FROM customer_invoices ci JOIN customers c ON c.id=COALESCE(ci.client_id,ci.customer_id) AND c.company_id=ci.company_id
 WHERE ci.company_id=${company}::uuid AND ci.id=${id}::uuid FOR UPDATE OF ci FOR SHARE OF c` as ArRow[];
 if(!header)throw new Error('AR invoice not found');
 const lines=await ctx.sql`SELECT i.* FROM customer_invoice_items i JOIN customer_invoices ci ON ci.id=i.invoice_id
 WHERE ci.company_id=${company}::uuid AND ci.id=${id}::uuid ORDER BY i.id LIMIT 10001 FOR SHARE OF i` as ArRow[];
 if(lines.length>10000)throw new Error('AR invoice line population exceeds its bound');
 return{header,lines};
}
export async function lockArPaymentSources(ctx:ControlTx,id:string){
 await fence(ctx);const company=ctx.principal.companyId;
 const [header]=await ctx.sql`SELECT p.* FROM customer_payments p JOIN customers c ON c.id=p.client_id AND c.company_id=p.company_id
 WHERE p.company_id=${company}::uuid AND p.id=${id}::uuid FOR UPDATE OF p FOR SHARE OF c` as ArRow[];
 if(!header)throw new Error('AR payment not found');
 const allocations=await ctx.sql`SELECT a.*,ci.currency_code AS invoice_currency,ci.total_amount AS invoice_total,ci.amount_paid AS invoice_paid,
 ci.status AS invoice_status,ci.gl_journal_entry_id AS invoice_journal_id
 FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
 JOIN customer_invoices ci ON ci.id=a.invoice_id AND ci.company_id=p.company_id AND COALESCE(ci.client_id,ci.customer_id)=p.client_id
 WHERE p.company_id=${company}::uuid AND p.id=${id}::uuid ORDER BY ci.id,a.id LIMIT 10001 FOR UPDATE OF ci FOR SHARE OF a` as ArRow[];
 const [count]=await ctx.sql`SELECT count(*)::integer AS count FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
 WHERE p.company_id=${company}::uuid AND p.id=${id}::uuid` as {count:number}[];
 if(allocations.length>10000||count?.count!==allocations.length)throw new Error('AR payment allocation material is incomplete');
 const invoices=await ctx.sql`SELECT ci.*,COALESCE(ci.client_id,ci.customer_id) AS owned_customer_id FROM customer_invoices ci
 WHERE ci.company_id=${company}::uuid AND EXISTS(SELECT 1 FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
 WHERE p.company_id=ci.company_id AND p.id=${id}::uuid AND a.invoice_id=ci.id AND COALESCE(ci.client_id,ci.customer_id)=p.client_id)
 ORDER BY ci.id LIMIT 10001 FOR UPDATE OF ci` as ArRow[];
 const invoiceLines=await ctx.sql`SELECT i.* FROM customer_invoice_items i JOIN customer_invoices ci ON ci.id=i.invoice_id
 WHERE ci.company_id=${company}::uuid AND EXISTS(SELECT 1 FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
 WHERE p.company_id=ci.company_id AND p.id=${id}::uuid AND a.invoice_id=ci.id AND COALESCE(ci.client_id,ci.customer_id)=p.client_id)
 ORDER BY ci.id,i.id LIMIT 10001 FOR SHARE OF i` as ArRow[];
 if(invoiceLines.length>10000||invoices.length>10000)throw new Error('AR payment source population exceeds its bound');return{header,allocations,invoices,invoiceLines};
}
