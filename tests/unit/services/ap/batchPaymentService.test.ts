/** apCiBatch.int.test.ts proves both former mocked assertions with actual nonempty batch
 * execution: no source_document_id FK misuse and exact persisted parent/child journal links.
 */
import {it} from 'vitest';
import {processBatch} from '@/modules/accounting/services/ap/batchPaymentService';
import {apIdentity as a,expectUnissuedApRefusal} from './unissuedApFixture';
it('refuses batch processing without issued authority before any SQL, including forged ALS',async()=>{
 await expectUnissuedApRefusal(()=>processBatch(a.company,a.id,a.person));
});
