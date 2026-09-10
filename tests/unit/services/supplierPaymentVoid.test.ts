/** Exact void/unapplication/cancellation, status guards, prior committed inverse replay and
 * savepoint rollback now run against real approved producers in apCiPaymentWorkflow.int.test.ts.
 * Unexplained pre-reversed raw headers are not manufactured into legitimate controlled history.
 */
import {it} from 'vitest';
import {voidSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {apIdentity as a,expectUnissuedApRefusal} from './ap/unissuedApFixture';
it('refuses payment void without issued authority before any SQL, including forged ALS',async()=>{
 await expectUnissuedApRefusal(()=>voidSupplierPayment(a.company,a.id,a.person));
});
