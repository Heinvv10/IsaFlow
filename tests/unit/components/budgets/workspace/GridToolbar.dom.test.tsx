/** Grid toolbar (spec §11): view and member picker with each member's FY net profit, rounding, PY toggle, Excel buttons. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridToolbar, type GridToolbarProps } from '@/components/accounting/budgets/workspace/GridToolbar';
import { ID, gridModel } from './gridFixture';

afterEach(cleanup);

const dims = gridModel().dimensions; // cc1: CC-A Alpha (m1), CC-B Beta (m2); no cc2, no bu
const props = (over: Partial<GridToolbarProps> = {}): GridToolbarProps => ({
  view: { kind: 'company' }, dimensions: dims, members: [], onViewChange: vi.fn(), roundingUnit: 1,
  onRoundingUnitChange: vi.fn(), density: 'owner', onDensityChange: vi.fn(), showPy: true, onShowPyChange: vi.fn(),
  onDownloadTemplate: vi.fn(), onImport: vi.fn(), disabled: false, ...over,
});
const options = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent);

describe('GridToolbar', () => {
  it('offers only dimensions that have members; picking one selects its first member', () => {
    const p = props();
    render(<GridToolbar {...p} />);
    const view = screen.getByLabelText('View');
    expect(options(view)).toEqual(['Company', 'By CC1']);
    expect(screen.queryByLabelText('Member')).toBeNull();
    fireEvent.change(view, { target: { value: 'cc1' } });
    expect(p.onViewChange).toHaveBeenCalledWith({ kind: 'cc1', memberId: ID.m1 });
  });

  it('the member picker shows each member with its FY net profit and switches member', () => {
    const p = props({
      view: { kind: 'cc1', memberId: ID.m1 },
      members: [
        { id: ID.m1, code: 'CC-A', name: 'Alpha', isActive: true, total: -1_000 },
        { id: ID.m2, code: 'CC-B', name: 'Beta', isActive: true, total: 250_000 },
      ],
    });
    render(<GridToolbar {...p} />);
    const member = screen.getByLabelText('Member');
    expect(options(member)).toEqual([expect.stringMatching(/^CC-A Alpha · NP \(10(\.00)?\)$/), expect.stringMatching(/^CC-B Beta · NP 2[\s ,]?500(\.00)?$/)]);
    fireEvent.change(member, { target: { value: ID.m2 } });
    expect(p.onViewChange).toHaveBeenCalledWith({ kind: 'cc1', memberId: ID.m2 });
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'company' } });
    expect(p.onViewChange).toHaveBeenLastCalledWith({ kind: 'company' });
  });

  it('rounding, the PY toggle and the Excel buttons call back; no Import when read-only', () => {
    const p = props();
    const { rerender } = render(<GridToolbar {...p} />);
    fireEvent.change(screen.getByLabelText('Rounding unit'), { target: { value: '1000' } });
    expect(p.onRoundingUnitChange).toHaveBeenCalledWith(1000);
    const py = screen.getByRole('button', { name: 'PY and Δ' });
    expect(py).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(py);
    expect(p.onShowPyChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Template' }));
    expect(p.onDownloadTemplate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(p.onImport).toHaveBeenCalledTimes(1);
    rerender(<GridToolbar {...p} onImport={null} />);
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });
});
