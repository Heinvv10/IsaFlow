/**
 * A run refused with 400 BUDGET_ASSUMPTIONS_INVALID (the stored document no longer validates) still offers the
 * Assumptions form for that version, so the document can be replaced; any other refusal shows only its message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { version, V1 } from './fixtures';

const h = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/accounting/budgets/three-way', asPath: '/accounting/budgets/three-way' }) }));
vi.mock('@/components/accounting/budgets/threeWay/useThreeWay', () => ({ useThreeWay: () => h.data }));
vi.mock('@/components/accounting/budgets/threeWay/AssumptionsPanel', () => ({
  AssumptionsPanel: ({ versionId }: { versionId: string }) => <div data-testid="panel">{versionId}</div>,
}));

import { ThreeWayPage } from '@/components/accounting/budgets/threeWay/ThreeWayPage';

afterEach(() => cleanup());

const base = {
  years: [], fiscalYear: 2027, setFiscalYear: vi.fn(), versions: [version()], versionId: V1, select: vi.fn(),
  run: null, loading: false, reload: vi.fn(),
};

describe('ThreeWayPage refusals', () => {
  it('BUDGET_ASSUMPTIONS_INVALID: the message and the Assumptions form for the version', () => {
    h.data = { ...base, error: 'The assumptions document is invalid', errorCode: 'BUDGET_ASSUMPTIONS_INVALID' };
    render(<ThreeWayPage />);
    expect(screen.getByRole('alert').textContent).toContain('invalid');
    expect(screen.getByTestId('panel').textContent).toBe(V1);
  });

  it('another refusal: the message only', () => {
    h.data = { ...base, error: 'Opening does not balance', errorCode: 'BUDGET_OPENING_UNBALANCED' };
    render(<ThreeWayPage />);
    expect(screen.getByRole('alert').textContent).toContain('Opening does not balance');
    expect(screen.queryByTestId('panel')).toBeNull();
  });
});
