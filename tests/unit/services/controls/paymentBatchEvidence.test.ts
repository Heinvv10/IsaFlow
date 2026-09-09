import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({record:vi.fn(),version:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:mocks.record}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:mocks.version}));
import {recordBatchEntity} from '@/modules/accounting/services/ap/batchPaymentWriteService';
it('preserves settlement accounting date even when the invoice date is older',async()=>{
 await recordBatchEntity({} as never,'supplier_invoice',{id:'invoice'},
  {id:'invoice',invoice_date:'2026-08-01'},'payment_applied','2026-09-09');
 expect(mocks.record).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({accountingDate:'2026-09-09'}));
});
