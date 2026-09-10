/** Owned bank credit and foreign-bank no-write proof run through real current material and
 * independent approvals in apCiPaymentWorkflow.int.test.ts, not an unscoped SQL mock.
 */
import {it} from 'vitest';
import {processSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {apIdentity as a,expectUnissuedApRefusal} from './ap/unissuedApFixture';
it('refuses payment processing without issued authority before any SQL, including forged ALS',async()=>{
 await expectUnissuedApRefusal(()=>processSupplierPayment(a.company,a.id,a.person));
});
