import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {canonicalJson} from '../controls/canonical';
import {sameIntentId} from '../controls/intentIdentity';
const D=Decimal.clone({precision:80});
type Row=Record<string,unknown>;
export interface TransferCandidateFacts {bank:Row;counterpartyAccountId:string;journal:Row;lines:Row[];originalBank:Row|null;intent:Row|null;effect:Row|null;events:Row[];occupied:boolean}
/** Every raw owned journal leg participates; callers must not filter by an account join. */
export function proveBankTransferCandidate(f:TransferCandidateFacts){
 const {bank,journal,lines,originalBank:original,intent,effect}=f;
 const fail=()=>{throw new Error('Existing transfer provenance is unresolved or occupied');};
 if(!original||!intent||!effect||f.occupied||lines.length!==2)return fail();
 const result=effect.result as Row|undefined,p=intent.payload as Row|undefined,transfer=p?.transfer as Row|undefined;
 if(!result||!p||p.version!==1||p.kind!=='transfer'||transfer?.mode!=='post'||transfer.oppositeBankTransactionId!==null
  ||p.bankTransactionId!==original.id||p.counterpartyAccountId!==bank.bank_account_id||intent.bank_transaction_id!==original.id
  ||intent.currency!=='ZAR'||effect.entity_type!=='bank_allocation_intent'||effect.entity_id!==intent.id||effect.operation!=='bank_allocation.post'
  ||!sameIntentId(result.intentId,String(intent.id))||result.bankTransactionId!==original.id||result.journalEntryId!==journal.id||result.paymentId!==null
  ||result.oppositeBankTransactionId!==null||result.status!=='allocated')return fail();
 if(journal.source!=='auto_bank_transfer'||journal.source_record_id!==original.id||journal.status!=='posted'||journal.reversed_at
  ||original.bank_account_id!==f.counterpartyAccountId||original.counterparty_account_id!==bank.bank_account_id
  ||original.transfer_journal_entry_id!==journal.id||original.allocation_type!=='transfer'||!['allocated','matched','reconciled'].includes(String(original.status)))return fail();
 const date=(v:unknown)=>fmtDate(v as Date|string);
 if(date(journal.entry_date)!==date(original.transaction_date)||date(intent.accounting_date)!==date(original.transaction_date)
  ||Math.abs(Date.parse(date(bank.transaction_date))-Date.parse(date(original.transaction_date)))>2*86400000)return fail();
 const signed=new D(String(bank.amount)),old=new D(String(original.amount));
 if(!signed.isFinite()||signed.isZero()||!signed.mul(100).isInteger()||!old.eq(signed.neg())||!new D(String(intent.amount)).eq(signed.abs()))return fail();
 const from=lines.find(l=>l.gl_account_id===f.counterpartyAccountId),to=lines.find(l=>l.gl_account_id===bank.bank_account_id);
 if(!from||!to||from===to||original.matched_journal_line_id!==from.id)return fail();
 for(const [line,amount] of [[from,old],[to,signed]] as const){
  const debit=new D(String(line.debit)),credit=new D(String(line.credit));
  if(!debit.eq(amount.gt(0)?amount:0)||!credit.eq(amount.lt(0)?amount.neg():0)
   ||['vat_type','cost_center_id','cc1_id','cc2_id','bu_id'].some(key=>line[key]!=null))return fail();
 }
 if(!f.events.some(e=>e.entity_type===effect.entity_type&&e.entity_id===intent.id&&e.action===effect.operation
  &&e.operation_id===effect.operation_id&&e.binding_hash===effect.binding_hash))return fail();
 // Canonical serialization rejects non-JSON/accessor-shaped material before retention.
 canonicalJson({intent,effect,events:f.events});
 return{originalIntentId:String(intent.id),destinationLineId:String(to.id),journal,lines,originalBank:original,intent,effect,changeEvents:f.events};
}
