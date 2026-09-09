import {createHash} from 'node:crypto';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {canonicalJson} from '../controls/canonical';
import {derivePaymentAmount} from '../controls/apOperationMaterializer';
import {getVerifiedBeneficiary} from '../controls/beneficiaryService';
import type {ControlTx} from '../controls/contracts';
import {paymentReleaseAmount} from './paymentReleaseValidation';
export interface PaymentSourceRow {id:string;supplier_id:string;total_amount:string;payment_date:string;bank_account_id:string|null;batch_id:string|null;payment_method:string;reference:string|null;status:string}
/** Monetary payment facts exclude workflow status/settlement, which are separately enforced. */
export async function loadPaymentReleaseSource(ctx:ControlTx,paymentId:string){
 assertControlTx(ctx);if(!UUID_RE.test(paymentId))throw new Error('Invalid payment reference');
 await assertEffectivePermission(ctx,'write:bank-tx');
 const [payment]=await ctx.sql`SELECT id,supplier_id,total_amount::text,payment_date::text,bank_account_id,batch_id,payment_method,reference,status
  FROM supplier_payments WHERE company_id=${ctx.principal.companyId}::uuid AND id=${paymentId}::uuid FOR UPDATE` as PaymentSourceRow[];
 if(!payment)throw new Error('Payment not found');
 if(!['draft','approved','processed'].includes(payment.status)||payment.payment_method!=='eft')throw new Error('Payment is not eligible for EFT preparation');
 const rows=await ctx.sql`SELECT pa.invoice_id,pa.amount_allocated::text,si.currency AS invoice_currency,
  si.id AS owned_invoice_id,si.supplier_id FROM payment_allocations pa
  JOIN supplier_payments sp ON sp.id=pa.payment_id
  LEFT JOIN supplier_invoices si ON si.id=pa.invoice_id AND si.company_id=sp.company_id AND si.supplier_id=sp.supplier_id
  WHERE sp.company_id=${ctx.principal.companyId}::uuid AND sp.id=${paymentId}::uuid ORDER BY pa.invoice_id,pa.id LIMIT 101` as Array<{
   invoice_id:string;amount_allocated:string;invoice_currency:string;owned_invoice_id:string|null;supplier_id:string|null}>;
 if(!rows.length||rows.length>100||rows.some(row=>!row.owned_invoice_id)||new Set(rows.map(row=>row.invoice_id)).size!==rows.length)throw new Error('Invalid owned payment allocation population');
 const {amount,currency}=derivePaymentAmount(payment.total_amount,rows);
 const money=paymentReleaseAmount(amount,currency);
 const beneficiary=await getVerifiedBeneficiary(ctx,{entityType:'supplier',entityId:payment.supplier_id});
 const facts={id:payment.id,supplierId:payment.supplier_id,amount,currency,paymentDate:payment.payment_date,
  bankAccountId:payment.bank_account_id,batchId:payment.batch_id,paymentMethod:payment.payment_method,reference:payment.reference,
  allocations:rows.map(row=>({invoiceId:row.invoice_id,amount:row.amount_allocated,currency:row.invoice_currency}))};
 const fingerprint=createHash('sha256').update(canonicalJson(facts)).digest('hex');
 return{payment,amount:money.amount,currency,cents:money.cents,beneficiary,facts,fingerprint};
}
