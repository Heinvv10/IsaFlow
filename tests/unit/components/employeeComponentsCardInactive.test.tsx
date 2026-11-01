/** The profile lists every assignment; one on a switched-off component says so, as the drawer leaves it out of current pay. */
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

describe('EmployeeComponentsCard', () => {
  it('marks only the row on an inactive component', () => {
    render(card([row({}), row({ id: 'b', componentName: 'Retired Allowance', componentActive: false })]));
    expect(within(screen.getByRole('row', { name: /Retired Allowance/ })).getByText('Inactive, not paid')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Basic Salary/ })).queryByText('Inactive, not paid')).toBeNull();
  });

  it('the table scroller can be reached by keyboard', () => {
    render(card([row({})]));
    const scroller = screen.getByRole('region', { name: 'Assigned pay components' });
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.className).toContain('overflow-x-auto');
  });
});
