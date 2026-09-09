import Decimal from 'decimal.js';
import {deriveArInvoiceMoney} from './arExactMaterial';
import type {ArRow} from './arSourceMaterial';
const Money=Decimal.clone({precision:80,rounding:Decimal.ROUND_HALF_UP});
function decimal(raw:unknown):Decimal{
 if((typeof raw!=='number'&&typeof raw!=='string')||String(raw).trim()==='')throw new Error('Recurring invoice decimal is invalid');
 const value=new Money(String(raw));if(!value.isFinite()||value.isNegative())throw new Error('Recurring invoice decimal is invalid');return value;
}
/** Existing template aggregate tolerance remains explicit; generated financial facts use exact decimal arithmetic. */
export function deriveArRecurringMoney(template:ArRow,ledgerCurrency:string){
 const raw:unknown=typeof template.line_items==='string'?JSON.parse(template.line_items):template.line_items;
 if(!Array.isArray(raw)||!raw.length||raw.length>10000)throw new Error('Recurring invoice line population is invalid');
 const lines=raw.map((item:unknown)=>{
  if(!item||typeof item!=='object')throw new Error('Recurring invoice line is invalid');
  const row=item as ArRow,description=typeof row.description==='string'?row.description.trim():'';
  const quantity=decimal(row.quantity),unitPrice=decimal(row.unitPrice);
  if(!description||!quantity.gt(0))throw new Error('Recurring invoice line is invalid');
  return{description,quantity:quantity.toFixed(),unit_price:unitPrice.toFixed(),amount:quantity.mul(unitPrice).toDecimalPlaces(2).toFixed()};
 });
 const subtotal=lines.reduce((sum,line)=>sum.add(line.amount),new Money(0));
 const rate=decimal(template.tax_rate),tax=subtotal.mul(rate).div(100).toDecimalPlaces(2),amount=subtotal.add(tax);
 const tolerance=Money.min(new Money('0.01').mul(lines.length),1);
 for(const [key,expected] of [['subtotal',subtotal],['tax_amount',tax],['total_amount',amount]] as const){
  if(template[key]!=null&&decimal(template[key]).sub(expected).abs().gt(tolerance))throw new Error('Recurring invoice stored totals do not reconcile');
 }
 const money=deriveArInvoiceMoney({subtotal:subtotal.toFixed(),tax_amount:tax.toFixed(),total_amount:amount.toFixed(),currency_code:template.currency_code},lines,ledgerCurrency);
 return{...money,lines};
}
