import { expect, it, vi } from 'vitest';
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn() }));
import { deriveJournalAmount, materializeGlOperation } from '@/modules/accounting/services/controls/glOperationMaterializer';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
const ref: OperationRef = { entityType:'journal_entry',entityId:'11111111-1111-4111-8111-111111111111',operation:'journal.post' };
it('derives positive exact balanced amounts without floating rounding', () => {
  expect(deriveJournalAmount([{debit:'0.1',credit:'0'},{debit:'0.2',credit:'0'},{debit:'0',credit:'0.3'}])).toBe('0.3');
});
it.each([
  [], [{debit:'0',credit:'0'}], [{debit:'1',credit:'0'},{debit:'0',credit:'0.99'}],
  [{debit:'-1',credit:'0'},{debit:'0',credit:'-1'}], [{debit:'1',credit:'1'}], [{debit:'NaN',credit:'0'}],
].map(lines=>({lines})))('rejects invalid journal populations', ({lines}) => expect(()=>deriveJournalAmount(lines)).toThrow());
it('refuses missing company currency instead of inventing ZAR', async () => {
  const sql = vi.fn(async () => [{id:'company',default_currency:null}]);
  const ctx = {principal:{companyId:'company'},sql} as unknown as ControlTx;
  await expect(materializeGlOperation(ctx,ref)).rejects.toThrow(/currency/i);
});
