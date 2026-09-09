import Decimal from 'decimal.js';
import {isRealCalendarDate} from '@/lib/validation';
const Money=Decimal.clone({precision:80});
export interface StatementObservation {id:string;accountId:string|null;periodStart:string|null;periodEnd:string|null;
 sourceCount:number|null;opening:string|null;closing:string|null;importedCount:number;importedNet:string;sourceBytesVerified:boolean}
/** OCR facts are retained observations. Matching them cannot authenticate a bank statement or its extraction. */
export function analyseBankStatementCompleteness(row:StatementObservation){
 const missing=['independent_statement_review_unavailable','external_bank_confirmation_unavailable'],reasons:string[]=[];
 if(!row.accountId)missing.push('owned_bank_account_unavailable');
 if(!row.sourceBytesVerified)missing.push('source_statement_bytes_unavailable_or_changed');
 if(!row.periodStart||!row.periodEnd||!isRealCalendarDate(row.periodStart)||!isRealCalendarDate(row.periodEnd)||row.periodStart>row.periodEnd)
  missing.push('source_statement_period_unavailable');
 if(row.sourceCount===null||!Number.isSafeInteger(row.sourceCount)||row.sourceCount<0)missing.push('source_statement_count_unavailable');
 if(row.opening===null||row.closing===null)missing.push('source_statement_balances_unavailable');
 let difference=new Money(0);
 if(missing.length===2){
  const opening=new Money(row.opening!),closing=new Money(row.closing!),net=new Money(row.importedNet);
  if(!opening.isFinite()||!closing.isFinite()||!net.isFinite())missing.push('invalid_statement_amount');
  else{
   difference=closing.sub(opening.add(net)).abs();
   if(row.sourceCount!==row.importedCount)reasons.push('statement_count_difference');
   if(!difference.isZero())reasons.push('statement_balance_difference');
  }
 }
 return{reasons,missing,amount:difference.toFixed(),classification:'candidate' as const};
}
