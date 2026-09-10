import {expect,it} from 'vitest';
import {currentStatementReview,type StatementReviewProof} from '@/modules/accounting/services/controls/bankStatementReviewValidity';
import {bankStatementSourceFingerprint} from '@/modules/accounting/services/controls/bankStatementAttestationSource';
const id='2ea1c0de-6f5e-4a1e-9f0b-1d2c3b4a5968',account='9c8b7a65-4321-4fed-8cba-0987654321fe';
const document='7d6c5b4a-3210-4dcb-9a87-6543210fedcb',hash='a'.repeat(64);
const source={account:{id:account,account_type:'asset',account_subtype:'bank',is_active:true},
 document:{id:document,hash,status:'matched'},currency:'ZAR'};
function proof(overrides:Partial<StatementReviewProof>={}):StatementReviewProof{
 return{id,bank_account_id:account,source_document_id:document,expected_source_hash:hash,
  source_fingerprint:bankStatementSourceFingerprint(source),currency:'ZAR',account_type:'asset',account_subtype:'bank',
  is_active:true,current_currency:'ZAR',document_id:document,document_status:'matched',document_hash:hash,bytes_verified:true,
  result:{intentId:id,sourceHash:hash,sourceFingerprint:bankStatementSourceFingerprint(source),
   bankAccountId:account,sourceDocumentId:document,status:'locally_reviewed'},...overrides};
}
it('reports a complete local review as current', ()=>{expect(currentStatementReview(proof(),true)).toBe(true);});
it('reports an unapproved review as not current', ()=>{expect(currentStatementReview(proof(),false)).toBe(false);});
it('accepts a receipt whose result kept a legacy uppercase intent identity', ()=>{
 expect(currentStatementReview(proof({result:{...proof().result!,intentId:id.toUpperCase()}}),true)).toBe(true);
});
it('refuses a receipt naming a different intent', ()=>{
 expect(currentStatementReview(proof({result:{...proof().result!,intentId:account}}),true)).toBe(false);
});
/** A row with no retained receipt must be refused, not throw on the fields the identity compare precedes. */
it('refuses a row with no retained receipt at all', ()=>{
 expect(()=>currentStatementReview(proof({result:null}),true)).not.toThrow();
 expect(currentStatementReview(proof({result:null}),true)).toBe(false);
});
