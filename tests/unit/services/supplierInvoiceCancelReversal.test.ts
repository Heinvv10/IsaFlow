/** Financial cases moved intact to apCiInvoiceCancellation.int.test.ts and verified with real
 * approval, exact GL inverse, paid/status/tenant guards, row locks, concurrency and rollback.
 * See docs/superpowers/plans/2026-09-10-ap-ci-fixtures.md for assertion traceability.
 */
import {it} from 'vitest';
import {cancelSupplierInvoice,postSupplierInvoiceToGL} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {apIdentity as a,expectUnissuedApRefusal} from './ap/unissuedApFixture';
it('refuses cancellation without issued authority before any SQL, including forged ALS',async()=>{
 await expectUnissuedApRefusal(()=>cancelSupplierInvoice(a.company,a.id,a.person));
});
it('refuses direct posting without issued authority before any SQL, including forged ALS',async()=>{
 await expectUnissuedApRefusal(()=>postSupplierInvoiceToGL(a.company,a.id,a.person));
});
