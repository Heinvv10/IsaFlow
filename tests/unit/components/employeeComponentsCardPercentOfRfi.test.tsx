/** Wave 5 RF: a percent_of_rfi row stores amount 0 (the run costs it), so the profile shows "7.5% of RFI", never "R 0.00". */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { EmployeeComponentsCard, type Assignment } from '@/components/payroll/EmployeeComponentsCard';

const row = (over: Partial<Assignment>): Assignment => ({
  id: 'a', componentId: 'c', componentName: 'Basic Salary', componentType: 'earning', componentActive: true,
  amount: 25000, effectiveFrom: '2026-03-01', effectiveTo: null, isRecurring: true, ...over,
});
const card = (assignments: Assignment[]) => (
  <EmployeeComponentsCard components={[]} assignments={assignments} newComponentId="" newAmount="" newFrom="2026-11-01" newIsRecurring
    onNewComponentId={() => undefined} onNewAmount={() => undefined} onNewFrom={() => undefined} onNewIsRecurring={() => undefined}
    onAssign={() => undefined} onEnd={() => undefined} adding={false} />
);
afterEach(cleanup);

describe('EmployeeComponentsCard: a percentage of RFI', () => {
  it('shows the percentage, not R 0.00, and leaves a plain amount as money', () => {
    render(card([row({}), row({ id: 'p', componentName: 'Employer pension', amount: 0, percentOfRfi: 0.075 })]));
    const pension = within(screen.getByRole('row', { name: /Employer pension/ }));
    expect(pension.getByText('7.5% of RFI')).toBeTruthy();
    expect(pension.queryByText(/R\s0\.00/)).toBeNull();
    expect(within(screen.getByRole('row', { name: /Basic Salary/ })).getByText(/R\s25\s000\.00/)).toBeTruthy();
    // The cell says how the run costs it (round 2 tdd L3); a money cell carries no such title.
    expect(pension.getByText('7.5% of RFI').getAttribute('title')).toBe('Costed by each pay run on the earnings that count as retirement-funding income');
    expect(within(screen.getByRole('row', { name: /Basic Salary/ })).getByText(/R\s25\s000\.00/).getAttribute('title')).toBeNull();
  });
});
