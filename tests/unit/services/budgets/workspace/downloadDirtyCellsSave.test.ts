/**
 * "Download my changes" hands the built file to the repo's one download helper (`@/lib/saveBlob`),
 * not a private copy of it, with the version and year in the file name.
 */
import { describe, expect, it, vi } from 'vitest';
import { downloadDirtyCells } from '@/components/accounting/budgets/workspace/downloadDirtyCells';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { gridModel, ID, MONTHS, TOKEN } from '../../../components/budgets/workspace/gridFixture';

const saveBlob = vi.hoisted(() => vi.fn());
vi.mock('@/lib/saveBlob', () => ({ saveBlob }));

describe('downloadDirtyCells → saveBlob', () => {
  it('saves one .xlsx through @/lib/saveBlob', async () => {
    const model = gridModel();
    const key = cellKey({ glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[2]! });
    const out = await downloadDirtyCells({
      versionId: ID.version, versionName: 'Original', fiscalYear: 2027, token: TOKEN, months: MONTHS,
      accounts: model.accounts, dimensions: model.dimensions, dirty: [key], valueAt: () => 123_450,
    });
    expect(out).toBeNull();
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = saveBlob.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe('Original-FY2027-my-changes.xlsx');
  });
});
