/**
 * A run refused with 400 BUDGET_ASSUMPTIONS_INVALID (the stored document no longer validates) still offers the
 * Assumptions form for that version, so the document can be replaced; any other refusal shows its message. Either
 * way the version switcher stays (review M3), and a switch writes ?version_id= (review L8). A run for another version
 * than the one selected is never drawn (review M2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { threeWayView, version, V1, V2 } from './fixtures';

const h = vi.hoisted(() => ({ data: {} as Record<string, unknown>, replace: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { a: '1' }, pathname: '/accounting/budgets/three-way', asPath: '/accounting/budgets/three-way?a=1', replace: h.replace }) }));
vi.mock('@/components/accounting/budgets/threeWay/useThreeWay', () => ({ useThreeWay: () => h.data }));
vi.mock('@/components/accounting/budgets/threeWay/AssumptionsPanel', () => ({
  AssumptionsPanel: ({ versionId }: { versionId: string }) => <div data-testid="panel">{versionId}</div>,
}));

import { ThreeWayPage } from '@/components/accounting/budgets/threeWay/ThreeWayPage';

afterEach(() => { cleanup(); h.replace.mockReset(); });

const base = {
  years: [], fiscalYear: 2027, setFiscalYear: vi.fn(), versions: [version(), version({ id: V2, name: 'Worst', kind: 'scenario', isPrimary: false, basedOnVersionId: V1 })], versionId: V1, select: vi.fn(),
  run: null, loading: false, reload: vi.fn(),
};

describe('ThreeWayPage refusals', () => {
  it('BUDGET_ASSUMPTIONS_INVALID: the message and the Assumptions form for the version', () => {
    h.data = { ...base, error: 'The assumptions document is invalid', errorCode: 'BUDGET_ASSUMPTIONS_INVALID' };
    render(<ThreeWayPage />);
    expect(screen.getByRole('alert').textContent).toContain('invalid');
    expect(screen.getByTestId('panel').textContent).toBe(V1);
  });

  it('another refusal: the message and the version switcher, no form', () => {
    h.data = { ...base, error: 'Opening does not balance', errorCode: 'BUDGET_OPENING_UNBALANCED' };
    render(<ThreeWayPage />);
    expect(screen.getByRole('alert').textContent).toContain('Opening does not balance');
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(screen.getByLabelText('Budget version')).toBeTruthy();
  });

  it('switching from the fallback switcher selects and writes ?version_id= (shallow)', () => {
    const select = vi.fn();
    h.data = { ...base, select, error: 'Opening does not balance', errorCode: 'BUDGET_OPENING_UNBALANCED' };
    render(<ThreeWayPage />);
    fireEvent.change(screen.getByLabelText('Budget version'), { target: { value: V2 } });
    expect(select).toHaveBeenCalledWith(V2);
    expect(h.replace).toHaveBeenCalledWith({ pathname: '/accounting/budgets/three-way', query: { a: '1', version_id: V2 } }, undefined, { shallow: true });
  });

  it('a run for another version than the one selected is not drawn', () => {
    h.data = { ...base, versionId: V2, run: threeWayView(), error: null, errorCode: null, loading: true };
    render(<ThreeWayPage />);
    expect(screen.queryByTestId('three-way-header')).toBeNull();
    expect(screen.getByText(/Projecting/)).toBeTruthy();
  });
});
