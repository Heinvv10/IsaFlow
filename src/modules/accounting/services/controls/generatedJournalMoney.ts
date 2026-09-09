import {canonicalMoney} from './canonical';
import type {OperationBinding} from './contracts';
type MoneyBinding=Pick<OperationBinding,'amount'|'currency'>;
/** Relationship alone cannot authorize a different currency or nominal amount. */
export function assertGeneratedJournalMoney(parent:MoneyBinding,child:MoneyBinding):void{
  if(parent.amount===null||parent.currency===null||child.amount===null||child.currency!==parent.currency
    ||canonicalMoney(parent.amount)!==canonicalMoney(child.amount)){
    throw new Error('Generated journal amount or currency differs from the approved parent');
  }
}
