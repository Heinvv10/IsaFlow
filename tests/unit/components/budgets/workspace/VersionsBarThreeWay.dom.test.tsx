/** Versions bar (budgets P6 spec §8): a "Three-way" link to the version on screen, only with the `budgets_three_way` flag. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';

const h = vi.hoisted(() => ({ flags: new Set<string>() as ReadonlySet<string> }));
vi.mock('@/hooks/useNavFlags', () => ({ useNavFlags: () => h.flags }));

import { VersionsBar, type VersionsBarProps } from '@/components/accounting/budgets/workspace/VersionsBar';

afterEach(() => { cleanup(); h.flags = new Set(); });

const v: BudgetVersion = {
  id: 'b0000000-0000-4000-8000-000000000001', fiscalYear: 2027, name: 'Original', kind: 'original', status: 'draft',
  basedOnVersionId: null, isPrimary: true, approvedBy: null, approvedAt: null, lockedBy: null,
  lockedAt: null, unlockedBy: null, unlockedAt: null, unlockReason: null, createdBy: 'u1',
  createdAt: '2026-10-01T00:00:00.000000Z', updatedAt: '2026-10-26T18:01:02.123456Z', amountCount: 6, total: 0,
} as BudgetVersion;
const props: VersionsBarProps = {
  versions: [v], current: v, role: 'owner', dirtyCount: 0, disabled: false, compareVersionId: null,
  onSelect: vi.fn(), onCompare: vi.fn(), onNewReforecast: vi.fn(), onAction: vi.fn(async () => null),
};

describe('VersionsBar three-way link', () => {
  it('hidden without the flag', () => {
    render(<VersionsBar {...props} />);
    expect(screen.queryByTestId('version-three-way')).toBeNull();
  });
  it('with the flag: links to the version on screen', () => {
    h.flags = new Set(['budgets_three_way']);
    render(<VersionsBar {...props} />);
    expect(screen.getByTestId('version-three-way').getAttribute('href')).toBe(`/accounting/budgets/three-way?version_id=${v.id}`);
  });
});
