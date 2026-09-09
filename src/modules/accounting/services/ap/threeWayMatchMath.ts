import Decimal from 'decimal.js';
import type {ThreeWayMatchResult} from '../../types/ap.types';
const D=Decimal.clone({precision:80});
export interface CumulativeMatchInput {ordered:string;unitPrice:string;accepted:readonly string[]|null;invoiced:readonly string[];
 invoiceUnitPrice:string;qtyTolerance:string;priceTolerance:string}
export function calculateCumulativeThreeWayMatch(input:CumulativeMatchInput):ThreeWayMatchResult&{missing:string[];qtyVariancePct:number;priceVariancePct:number}{
 const decimal=(value:string)=>{const n=new D(value);if(!n.isFinite()||n.isNegative())throw new Error('Invalid three-way match amount');return n;};
 const ordered=decimal(input.ordered),price=decimal(input.unitPrice),actualPrice=decimal(input.invoiceUnitPrice);
 const qtyTolerance=decimal(input.qtyTolerance),priceTolerance=decimal(input.priceTolerance);
 if(qtyTolerance.gt(100)||priceTolerance.gt(100))throw new Error('Invalid three-way tolerance');
 const sum=(values:readonly string[])=>values.reduce((total,value)=>total.add(decimal(value)),new D(0));
 const invoiced=sum(input.invoiced),accepted=input.accepted===null?null:sum(input.accepted);
 const withinCapacity=(actual:Decimal,capacity:Decimal)=>actual.lte(capacity.mul(new D(1).add(qtyTolerance.div(100))));
 const quantityMatch=withinCapacity(invoiced,ordered);
 const priceMatch=actualPrice.sub(price).abs().lte(price.mul(priceTolerance).div(100));
 const grnMatch=accepted!==null&&withinCapacity(invoiced,accepted);
 const missing=accepted===null?['accepted_receipt_evidence_unavailable']:[];
 const mismatches:string[]=[];
 if(!quantityMatch)mismatches.push('Cumulative invoice quantity exceeds purchase-order capacity and tolerance');
 if(!priceMatch)mismatches.push('Invoice unit price exceeds purchase-order price tolerance');
 if(accepted!==null&&!grnMatch)mismatches.push('Cumulative invoice quantity exceeds accepted receipt capacity and tolerance');
 const variance=(actual:Decimal,base:Decimal)=>base.isZero()?actual.isZero()?0:100:actual.sub(base).div(base).mul(100).toNumber();
 return{status:quantityMatch&&priceMatch&&grnMatch?'fully_matched':quantityMatch&&priceMatch?'po_matched':grnMatch?'grn_matched':'unmatched',
  quantityMatch,priceMatch,grnMatch,mismatches,missing,qtyVariancePct:variance(invoiced,ordered),priceVariancePct:variance(actualPrice,price)};
}
