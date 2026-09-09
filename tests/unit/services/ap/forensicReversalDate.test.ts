import { expect, it } from 'vitest';
import { chooseApReversalDate } from '@/modules/accounting/services/ap/apReversalMaterial';
it('freezes a real reversal target from original period or server SAST day', () => {
  expect(chooseApReversalDate('2026-08-01', 'open', '2026-09-09')).toBe('2026-08-01');
  expect(chooseApReversalDate('2026-08-01', 'closed', '2026-09-09')).toBe('2026-09-09');
  expect(chooseApReversalDate('2026-08-01', 'closed', '2026-09-09', '2026-09-10')).toBe('2026-09-10');
  expect(() => chooseApReversalDate('2026-08-01', 'closed', '2026-09-09', '2026-07-31')).toThrow();
  expect(() => chooseApReversalDate('2026-08-01', 'closed', '2026-09-09', '2026-02-30')).toThrow();
});
