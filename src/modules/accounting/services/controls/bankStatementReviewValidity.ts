import {bankStatementSourceFingerprint} from './bankStatementAttestationSource';
import {sameIntentId} from './intentIdentity';
export interface StatementReviewProof {
 id:string;bank_account_id:string;source_document_id:string;expected_source_hash:string;source_fingerprint:string;currency:string;
 account_type:string|null;account_subtype:string|null;is_active:boolean|null;current_currency:string;
 document_id:string|null;document_status:string|null;document_hash:string|null;bytes_verified:boolean;
 result:{intentId?:string;sourceHash?:string;sourceFingerprint?:string;bankAccountId?:string;sourceDocumentId?:string;status?:string}|null;
}
export function currentStatementReview(row:StatementReviewProof,approved:boolean){
 const source={account:{id:row.bank_account_id,account_type:row.account_type??'',account_subtype:row.account_subtype??'',is_active:row.is_active??false},
  document:{id:row.document_id??'',hash:row.document_hash??'',status:row.document_status??''},currency:row.current_currency};
 return approved&&row.bytes_verified&&row.account_type==='asset'&&row.account_subtype==='bank'&&row.is_active===true
  &&row.current_currency===row.currency&&bankStatementSourceFingerprint(source)===row.source_fingerprint
  &&row.result!==null&&sameIntentId(row.result.intentId,row.id)&&row.result.sourceHash===row.expected_source_hash&&row.result.sourceFingerprint===row.source_fingerprint
  &&row.result.bankAccountId===row.bank_account_id&&row.result.sourceDocumentId===row.source_document_id&&row.result.status==='locally_reviewed';
}
