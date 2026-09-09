import {expect,it} from 'vitest';
import {projectHistoryValues} from '@/modules/accounting/services/controls/controlChangeHistoryProjection';
it('preserves exact nested payroll and classification material and records only sensitive redactions',()=>{
 const input={before:null,after:{amount:'123.45',components:[{amount:'7000.01',component_id:'component'}],classification:{account_subtype:'bank',parent_account_id:'parent'},bank_account_number:'123456789',nested:{accountNumber:'987654321',access_token:'secret'}}};
 const result=projectHistoryValues(input);
 expect(result.after).toMatchObject({amount:'123.45',components:[{amount:'7000.01',component_id:'component'}],classification:{account_subtype:'bank',parent_account_id:'parent'}});
 expect(result.redactedPaths).toEqual(['/after/bank_account_number','/after/nested/access_token','/after/nested/accountNumber']);
 expect(JSON.stringify(result)).not.toContain('123456789');expect(JSON.stringify(result)).not.toContain('987654321');expect(JSON.stringify(result)).not.toContain('secret');
});
it('rejects noncanonical evidence instead of silently losing fields',()=>{
 expect(()=>projectHistoryValues({before:null,after:{missing:undefined}})).toThrow();
});
it('redacts payment authentication data while preserving ordinary account codes and actor identifiers',()=>{
 const result=projectHistoryValues({before:null,after:{card_number:'4111111111111111',cvv:'123',pin:'9876',account_code:'1140',grant_id:'opaque-grant'}});
 expect(result.after).toEqual({card_number:'[REDACTED]',cvv:'[REDACTED]',pin:'[REDACTED]',account_code:'1140',grant_id:'opaque-grant'});
});
it('refuses malformed protected before/after shapes rather than asserting faithful evidence',()=>{
 expect(()=>projectHistoryValues({before:7,after:{}} as never)).toThrow();
 expect(()=>projectHistoryValues({before:null,after:[],extra:'ignored'} as never)).toThrow();
});
it('withholds beneficiary keyed fingerprints without deleting ordinary source hashes',()=>{
 const result=projectHistoryValues({before:null,after:{binding:{beneficiaries:[{fingerprint:'private-bank-hmac',entityType:'supplier'}],sourceVersions:[{entityType:'journal_entry',fingerprint:'ordinary-source-hash'}]}}});
 expect(JSON.stringify(result)).not.toContain('private-bank-hmac');expect(JSON.stringify(result)).toContain('ordinary-source-hash');
 expect(result.redactedPaths).toContain('/after/binding/beneficiaries/0/fingerprint');
});
