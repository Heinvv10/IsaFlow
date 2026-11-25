// The month columns of the assumption lists are MonthFields (typed or picked), not the browser's native month input.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AssumptionLists } from '@/components/accounting/budgets/threeWay/AssumptionLists';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';

afterEach(cleanup);

const doc = {
  capex: [{ id: 'c1', month: '2026-03', amountExVat: 10000, vatClaimable: true, description: 'Van' }],
  loans: { existing: [], planned: [] }, equity: { shareIssues: [], dividends: [] },
} as unknown as ThreeWayAssumptions;

const box = () => screen.getByRole('textbox', { name: 'Capex 1 Month paid' }) as HTMLInputElement;
const type = (t: string) => { fireEvent.focus(box()); fireEvent.change(box(), { target: { value: t } }); fireEvent.blur(box()); };

describe('assumption lists: month columns', () => {
  it('show the month as Mar 2026 in a text box, no native month input', () => {
    const { container } = render(<AssumptionLists doc={doc} firstMonth="2026-01" loans={[]} readOnly={false} onChange={() => {}} />);
    expect(box().value).toBe('Mar 2026');
    expect(container.querySelector('input[type="month"]')).toBeNull();
  });
  it('a typed month is saved as YYYY-MM into the list', () => {
    const onChange = vi.fn();
    render(<AssumptionLists doc={doc} firstMonth="2026-01" loans={[]} readOnly={false} onChange={onChange} />);
    type('sep 2027');
    const next = onChange.mock.calls.at(-1)![0](doc) as ThreeWayAssumptions;
    expect((next.capex[0] as unknown as { month: string }).month).toBe('2027-09');
  });
  it('refused text changes nothing in the list', () => {
    const onChange = vi.fn();
    render(<AssumptionLists doc={doc} firstMonth="2026-01" loans={[]} readOnly={false} onChange={onChange} />);
    type('zzz');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('read-only disables the box and the picker button', () => {
    render(<AssumptionLists doc={doc} firstMonth="2026-01" loans={[]} readOnly onChange={() => {}} />);
    expect(box().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Choose month' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
