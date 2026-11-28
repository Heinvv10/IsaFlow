/**
 * Wave 7 CX (review LOW): every approval-evidence arm of regularRunCancelRefusal refuses on its own. The expected
 * table is written out here, not imported, so removing or renaming any arm (or its SQL column) turns one case red.
 * The SQL reads are pinned by tests/integration/w7-cx-regular-cancel.int.test.ts; this pins the mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ row: {} as Record<string, unknown> | null, text: '' }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[]) => {
    state.text = strings.join('?');
    return state.row ? [state.row] : [];
  }),
}));

import { regularRunCancelRefusal } from '@/modules/accounting/services/payroll/payrollRunCancelEvidence';

const ARMS: Array<[string, RegExp]> = [
  ['approved', /approved before/],
  ['reopened', /reopened after an approval/],
  ['paid', /marked paid/],
  ['journal', /carries a payroll journal/],
  ['request_approved', /approval request was approved/],
  ['audit', /audit trail records/],
  ['directive', /tax directive/],
  ['garnishee', /garnishee deduction was applied/],
  ['bank_file', /salary bank file/],
  ['payslip', /payslips were frozen or emailed/],
  ['emp201', /EMP201 return names it/],
  ['later_run', /later run of its pay frequency/],
];
const clear = () => Object.fromEntries(ARMS.map(([k]) => [k, false]));
const RUN = { id: '11111111-1111-4111-8111-111111111111' };

beforeEach(() => { state.row = clear(); state.text = ''; });

describe('regularRunCancelRefusal: each evidence arm', () => {
  it('no evidence: null (the run may be cancelled)', async () => {
    expect(await regularRunCancelRefusal('co', RUN)).toBeNull();
  });
  it.each(ARMS)('%s alone refuses, naming why', async (key, why) => {
    state.row = { ...clear(), [key]: true };
    expect(await regularRunCancelRefusal('co', RUN)).toMatch(why);
    expect(state.text).toMatch(new RegExp(`AS ${key}\\b`)); // the SQL computes the column the arm reads
  });
  it('a run that no longer exists is refused', async () => {
    state.row = null;
    expect(await regularRunCancelRefusal('co', RUN)).toMatch(/no longer exists/);
  });
});
