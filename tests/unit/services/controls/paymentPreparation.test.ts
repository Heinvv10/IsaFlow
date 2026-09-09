import {expect,it,vi} from 'vitest';
import {assertPreparedPaymentCurrent} from '@/modules/accounting/services/ap/paymentPreparationService';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
it('old prepared payment cannot acquire replacement banking implicitly',()=>{
 const preparation={payment_fingerprint:'paymentA',beneficiary_version_id:'bankA',beneficiary_version:1,beneficiary_fingerprint:'hashA'};
 const bank={beneficiaryId:'bankA',version:1,fingerprint:'hashA'};
 expect(()=>assertPreparedPaymentCurrent(preparation,'paymentA',bank)).not.toThrow();
 expect(()=>assertPreparedPaymentCurrent(preparation,'paymentA',{...bank,beneficiaryId:'bankB',version:2})).toThrow('reprepare');
 expect(()=>assertPreparedPaymentCurrent(preparation,'paymentB',bank)).toThrow('reprepare');
});
