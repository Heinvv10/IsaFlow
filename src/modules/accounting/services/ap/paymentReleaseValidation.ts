import Decimal from 'decimal.js';
import {UUID_RE} from '@/lib/validation';
import {canonicalMoney} from '../controls/canonical';
export interface ReleasePaymentFact {id:string;supplierId:string;amount:string;currency:string}
/** Existing bank adapters accept integer cents only. No unbound FX or rounding. */
export function paymentReleaseAmount(value:string,currency:string):{amount:string;cents:number}{
 if(currency!=='ZAR')throw new Error('Payment release currency must be ZAR');
 const amount=new Decimal(canonicalMoney(value)),cents=amount.mul(100);
 if(!amount.gt(0)||!cents.isInteger()||cents.gt(Number.MAX_SAFE_INTEGER))throw new Error('Invalid exact payment amount');
 return{amount:amount.toFixed(),cents:cents.toNumber()};
}
export function validateReleasePopulation(payments:readonly ReleasePaymentFact[],headerAmount:string,headerCount:number){
 if(!payments.length||payments.length>100)throw new Error('Payment population must contain 1 to 100 records');
 if(payments.length!==headerCount)throw new Error('Payment count does not reconcile');
 const ids=new Set<string>();let total=new Decimal(0);
 for(const payment of payments){
  if(!UUID_RE.test(payment.id)||!UUID_RE.test(payment.supplierId))throw new Error('Invalid payment identity');
  if(ids.has(payment.id.toLowerCase()))throw new Error('Duplicate payment');ids.add(payment.id.toLowerCase());
  total=total.add(paymentReleaseAmount(payment.amount,payment.currency).amount);
 }
 if(!total.eq(canonicalMoney(headerAmount)))throw new Error('Payment total does not reconcile');
 return{...paymentReleaseAmount(total.toFixed(),'ZAR'),currency:'ZAR' as const};
}
/** Enqueue consumption does not extend the human authorization's original expiry. */
export function assertReleaseApprovalCurrent(approval:{status:string;unexpired:boolean}):void{
 if(approval.status!=='consumed'||!approval.unexpired)throw new Error('Release approval is unconsumed or expired');
}
