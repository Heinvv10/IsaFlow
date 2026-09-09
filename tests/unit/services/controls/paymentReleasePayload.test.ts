import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openReleasePayload,sealReleasePayload,validateReleaseFileFields,type PaymentReleasePayload} from '@/modules/accounting/services/ap/paymentReleasePayload';
beforeEach(()=>{vi.stubEnv('ENCRYPTION_KEY','synthetic-release-test-key-with-32-characters');});
afterEach(()=>vi.unstubAllEnvs());
const payload:PaymentReleasePayload={version:1,companyId:'company',intentId:'intent',channel:'eft',bankFormat:'fnb',providerConfigurationFingerprint:null,
 header:{companyName:'Synthetic',bankAccountNumber:'123456789',branchCode:'250655',accountType:'current',batchReference:'EFT1',actionDate:'2026-09-09'},
 payments:[{beneficiaryName:'Supplier',beneficiaryAccountNumber:'987654321',beneficiaryBranchCode:'250655',beneficiaryAccountType:'current',amount:1,reference:'REF1'}]};
it('encrypts the immutable payload and binds its exact tenant/intent/hash',()=>{
 const sealed=sealReleasePayload(payload);expect(JSON.stringify(sealed)).not.toContain('987654321');
 expect(openReleasePayload('company','intent',sealed.envelope,sealed.hash)).toEqual(payload);
 expect(()=>openReleasePayload('foreign','intent',sealed.envelope,sealed.hash)).toThrow();
 expect(()=>openReleasePayload('company','other',sealed.envelope,sealed.hash)).toThrow();
});
it('refuses truncation and CSV/newline injection in generated EFT files',()=>{
 expect(()=>validateReleaseFileFields(payload.header,payload.payments)).not.toThrow();
 expect(()=>validateReleaseFileFields({...payload.header,bankAccountNumber:'123456789012'},payload.payments)).toThrow();
 expect(()=>validateReleaseFileFields(payload.header,[{...payload.payments[0]!,reference:'A\nTXN'}])).toThrow();
});
