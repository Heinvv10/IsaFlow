import Decimal from 'decimal.js';
import {canonicalMoney} from './canonical';
const Money=Decimal.clone({precision:80,rounding:Decimal.ROUND_HALF_UP});
type Row=Record<string,unknown>;
function value(raw:unknown):Decimal{
 if(typeof raw!=='string')throw new Error('AR money must be persisted decimal text');
 const amount=new Money(canonicalMoney(raw));if(amount.isNegative())throw new Error('AR money cannot be negative');return amount;
}
function currency(raw:unknown,ledger:string):string{
 if(typeof raw!=='string'||!/^[A-Z]{3}$/.test(raw)||!/^[A-Z]{3}$/.test(ledger))throw new Error('AR currency is unknown');
 if(raw!==ledger)throw new Error('AR currency requires a bound conversion; foreign nominal posting is unsupported');return raw;
}
export function deriveArInvoiceMoney(header:Row,lines:readonly Row[],ledgerCurrency:string){
 if(!lines.length||lines.length>10000)throw new Error('AR invoice line population is invalid');
 const subtotal=value(header.subtotal),tax=value(header.tax_amount),amount=value(header.total_amount);
 let sum=new Money(0);
 for(const line of lines){const lineAmount=value(line.amount),quantity=value(line.quantity),unitPrice=value(line.unit_price);
  if(!quantity.gt(0)||!quantity.mul(unitPrice).toDecimalPlaces(2).eq(lineAmount))throw new Error('AR invoice line amount does not reconcile');sum=sum.add(lineAmount);}
 if(!sum.eq(subtotal)||!subtotal.add(tax).eq(amount)||!amount.gt(0))throw new Error('AR invoice totals do not reconcile');
 const denomination=currency(header.currency_code,ledgerCurrency);
 if(header.exchange_rate!=null&&!value(header.exchange_rate).eq(1))throw new Error('AR currency requires a bound conversion');
 if(header.functional_total!=null&&!value(header.functional_total).eq(amount))throw new Error('AR functional total does not reconcile');
 return{subtotal:subtotal.toFixed(),tax:tax.toFixed(),amount:amount.toFixed(),currency:denomination};
}
/** Unallocated cash is valid only with its own recorded currency; linked legacy receipts need unanimous source currency. */
export function deriveArSettlementMoney(total:unknown,recordedCurrency:unknown,allocations:readonly {amount:unknown;currency:unknown}[],ledgerCurrency:string){
 if(allocations.length>10000)throw new Error('AR allocation population is invalid');
 const amount=value(total),currencies=new Set(allocations.map(a=>a.currency));
 const denomination=currency(recordedCurrency??(currencies.size===1?[...currencies][0]:null),ledgerCurrency);
 let allocated=new Money(0);
 for(const allocation of allocations){currency(allocation.currency,denomination);const part=value(allocation.amount);if(!part.gt(0))throw new Error('AR allocation must be positive');allocated=allocated.add(part);}
 if(!amount.gt(0)||allocated.gt(amount))throw new Error('AR settlement allocations exceed its amount');
 return{amount:amount.toFixed(),currency:denomination};
}
export function deriveArCreditMoney(header:Row,linkedCurrency:unknown,ledgerCurrency:string){
 const subtotal=value(header.subtotal),tax=value(header.tax_amount),amount=value(header.total_amount);
 if(!amount.gt(0)||!subtotal.add(tax).eq(amount))throw new Error('Credit note totals do not reconcile');
 const denomination=currency(header.currency_code??linkedCurrency,ledgerCurrency);
 if(linkedCurrency!=null)currency(linkedCurrency,denomination);
 return{subtotal:subtotal.toFixed(),tax:tax.toFixed(),amount:amount.toFixed(),currency:denomination};
}
