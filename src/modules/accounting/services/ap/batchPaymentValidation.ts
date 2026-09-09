import Decimal from 'decimal.js';
import {UUID_RE,isRealCalendarDate} from '@/lib/validation';
import type {BatchPaymentCreateInput} from '../../types/ap.types';
import {paymentReleaseAmount} from './paymentReleaseValidation';
export function validateBatchInput(input:BatchPaymentCreateInput){
 if(!input||!Array.isArray(input.payments)||!input.payments.length||input.payments.length>100)throw new Error('Batch requires 1 to 100 payments');
 if(input.batchDate!==undefined&&!isRealCalendarDate(input.batchDate))throw new Error('Invalid batch date');
 if(input.paymentMethod!==undefined&&input.paymentMethod!=='eft')throw new Error('Batch supports EFT payments only');
 if(input.bankAccountId!==undefined&&!UUID_RE.test(input.bankAccountId))throw new Error('Invalid bank account');
 const suppliers=new Set<string>(),invoices=new Set<string>();let total=new Decimal(0);
 const payments=input.payments.map(payment=>{
  if(!payment||!UUID_RE.test(payment.supplierId)||!Array.isArray(payment.invoiceAllocations)||!payment.invoiceAllocations.length||payment.invoiceAllocations.length>100)throw new Error('Invalid batch payment');
  const supplierId=payment.supplierId.toLowerCase();if(suppliers.has(supplierId))throw new Error('Duplicate supplier');suppliers.add(supplierId);
  let amount=new Decimal(0);
  const allocations=payment.invoiceAllocations.map(allocation=>{
   if(!allocation||!UUID_RE.test(allocation.invoiceId)||typeof allocation.amount!=='number')throw new Error('Invalid batch allocation');
   const invoiceId=allocation.invoiceId.toLowerCase();if(invoices.has(invoiceId))throw new Error('Duplicate invoice');invoices.add(invoiceId);
   const money=paymentReleaseAmount(String(allocation.amount),'ZAR');amount=amount.add(money.amount);
   return{invoiceId,amount:money.amount};
  }).sort((a,b)=>a.invoiceId<b.invoiceId?-1:1);
  total=total.add(amount);return{supplierId,amount:amount.toFixed(),allocations};
 }).sort((a,b)=>a.supplierId<b.supplierId?-1:1);
 if(invoices.size>100)throw new Error('Batch exceeds 100 invoices');
 return{payments,total:paymentReleaseAmount(total.toFixed(),'ZAR').amount};
}

/** A batch owns one aggregate journal; a child cannot reverse that journal independently. */
export function assertStandalonePaymentVoid(batchId: unknown): void {
 if (batchId !== null && batchId !== undefined) throw new Error('Cannot void an individual batch payment');
}

/** A batch child can be posted only by its aggregate batch effect. */
export function assertStandalonePaymentProcess(batchId:unknown):void{
 if(batchId!==null&&batchId!==undefined)throw new Error('Cannot process an individual batch payment');
}
