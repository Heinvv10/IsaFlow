/**
 * The "?" overlay lists the GO_TO shortcuts. It used to offer "Go to Inventory" and "Go to Accounting"
 * long after those stopped being tabs, and had no Payroll. Every name must be a top-level tab label.
 */
import { describe, expect, it } from 'vitest';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { GO_TO } from '@/components/layout/useGlobalShortcuts';

describe('GO_TO', () => {
  const tabLabels = new Set(TABS.map((t) => t.label));

  it('every name is a top-level tab label', () => {
    expect(GO_TO.map((g) => g.name).filter((n) => !tabLabels.has(n))).toEqual([]);
  });

  it('includes Payroll (G then Y) and Month-End (G then M)', () => {
    expect(GO_TO.find((g) => g.name === 'Payroll')?.key).toBe('y');
    expect(GO_TO.find((g) => g.name === 'Month-End')?.key).toBe('m');
  });

  it('keys are unique and never G', () => {
    const keys = GO_TO.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('g');
  });
});
