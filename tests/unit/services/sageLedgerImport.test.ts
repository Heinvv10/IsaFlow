/** Actual source-column, independent-approval, replay and concurrency coverage lives in historicalImportSageSource.int.test.ts.
 * The obsolete tests fabricated document_number/sage_account_id fields absent from the real table.
 */
import {expect,it,vi} from 'vitest';
vi.mock('@/lib/neon',()=>({sql:vi.fn(),withSavepoint:vi.fn(),withTransaction:vi.fn(),transaction:vi.fn(),fmtDate:(value:unknown)=>String(value)}));
import {sql} from '@/lib/neon';
import {importLedgerTransactions} from '@/modules/accounting/services/core/sageImportService';
it.each([undefined,{imports:[{importId:'00000000-0000-4000-8000-000000000001',approvalId:'00000000-0000-4000-8000-000000000002'}]}])(
 'refuses a direct Sage financial call without an authenticated control transaction (%j)',async saved=>{
  vi.mocked(sql).mockClear();
  await expect(importLedgerTransactions('00000000-0000-4000-8000-000000000003','claimed-person',saved)).rejects.toThrow('Authenticated control transaction');
  expect(sql).not.toHaveBeenCalled();
 });
