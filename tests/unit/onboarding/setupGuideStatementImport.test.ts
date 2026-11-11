/**
 * The setup guide's bank step is statement import only: IsaFlow has no live
 * bank feed. The task keeps id 'bank-feed' so stored progress survives.
 */
import { describe, expect, it } from 'vitest';
import { SETUP_CATEGORIES } from '@/components/onboarding/setupGuideConfig';

const bankSection = SETUP_CATEGORIES.find((s) => s.id === 'connect-bank');

describe('setup guide: statement import step', () => {
  it('the old bank-feed task points at Statement Imports', () => {
    const task = bankSection?.tasks.find((t) => t.id === 'bank-feed');
    expect(task?.href).toBe('/accounting/bank/statements');
    expect(task?.label).toBe('Review statement imports');
  });

  it('no bank step promises a bank feed, a connection or automatic import', () => {
    const copy = [bankSection?.label, bankSection?.description, ...(bankSection?.tasks ?? []).flatMap((t) => [t.label, t.description])];
    for (const text of copy) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/bank feed|automatic|connect|link your/i);
    }
  });
});
