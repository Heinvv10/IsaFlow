import type {TransactionOutcome} from '@/modules/accounting/services/controls/transactionObservers';
import type {InvocationCompletion} from './invocationTypes';
/** Receipt absence never proves an abort; old/unavailable transaction status remains unknown. */
export function classifyInvocationProof(status:string|null,receipt:InvocationCompletion|null):{outcome:TransactionOutcome;completion:InvocationCompletion|null}{
 if(status==='committed'&&receipt)return{outcome:'committed',completion:receipt};
 if(status==='aborted')return{outcome:'rolled_back',completion:null};
 return{outcome:'unknown',completion:null};
}
