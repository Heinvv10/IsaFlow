import {canonicalJson,canonicalMoney} from './canonical';
import type {ExactBankJournalLine} from '../bank/bankAllocationPlan';
interface StoredLine {gl_account_id:unknown;debit:unknown;credit:unknown;vat_type:unknown;cc1_id:unknown;cc2_id:unknown;bu_id:unknown}
/** Parent amount alone cannot authorize a different account, VAT classification or dimension. */
export function matchesBankAllocationJournalLines(expected:readonly ExactBankJournalLine[],actual:readonly StoredLine[]):boolean {
 if(expected.length!==actual.length)return false;
 const shape=(account:unknown,debit:unknown,credit:unknown,vat:unknown,cc1:unknown,cc2:unknown,bu:unknown)=>
  canonicalJson({account,debit:canonicalMoney(String(debit)),credit:canonicalMoney(String(credit)),vat,cc1,cc2,bu});
 const planned=expected.map(l=>shape(l.accountId,l.debit,l.credit,l.vatType,l.cc1Id,l.cc2Id,l.buId)).sort();
 const stored=actual.map(l=>shape(l.gl_account_id,l.debit,l.credit,l.vat_type,l.cc1_id,l.cc2_id,l.bu_id)).sort();
 return planned.every((line,index)=>line===stored[index]);
}
