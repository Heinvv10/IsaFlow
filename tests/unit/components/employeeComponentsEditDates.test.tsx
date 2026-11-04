/**
 * The profile's Pay Components card: every assignment, ended or open, has "Edit dates", which sends the new
 * effective-from and effective-to (blank = open-ended) to onEditDates. This is how a run refused for a manual
 * pro-rata is cleared (payroll-component-edit-dates.int.test.ts drives the route behind it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmployeeComponentsCard, type Assignment } from '@/components/payroll/EmployeeComponentsCard';

afterEach(cleanup);

const ended: Assignment = {
  id: 'a-ended', componentId: 'c-1', componentName: 'Basic Salary', componentType: 'earning', componentActive: true,
  amount: 31000, effectiveFrom: '2026-03-30', effectiveTo: '2026-03-31', isRecurring: true,
};
const open: Assignment = { ...ended, id: 'a-open', componentName: 'Travel allowance', effectiveFrom: '2025-01-01', effectiveTo: null };

function renderCard(onEditDates = vi.fn(async () => undefined)) {
  render(
    <EmployeeComponentsCard
      components={[]} assignments={[ended, open]} newComponentId="" newAmount="" newFrom="" newIsRecurring
      onNewComponentId={vi.fn()} onNewAmount={vi.fn()} onNewFrom={vi.fn()} onNewIsRecurring={vi.fn()}
      onAssign={vi.fn()} onEnd={vi.fn()} onEditDates={onEditDates} adding={false}
    />,
  );
  return onEditDates;
}

function typeDate(label: RegExp, text: string) {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
}

describe('Edit dates', () => {
  it('is offered on an ended row as well as an open one; End only on the open one', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Edit dates for Basic Salary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit dates for Travel allowance' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End Basic Salary' })).toBeNull();
    expect(screen.getByRole('button', { name: 'End Travel allowance' })).toBeTruthy();
  });

  it('moves an ended row to the 1st of next month and clears its end', async () => {
    const onEditDates = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit dates for Basic Salary' }));
    typeDate(/^New effective from/, '2026-04-01');
    typeDate(/^New effective to/, '');
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }));
    await waitFor(() => expect(onEditDates).toHaveBeenCalledWith('a-ended', '2026-04-01', null));
  });

  it('sends an end date when one is typed, and Cancel sends nothing', async () => {
    const onEditDates = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit dates for Travel allowance' }));
    typeDate(/^New effective to/, '2026-03-31');
    fireEvent.click(screen.getByRole('button', { name: 'Save dates' }));
    await waitFor(() => expect(onEditDates).toHaveBeenCalledWith('a-open', '2025-01-01', '2026-03-31'));

    fireEvent.click(screen.getByRole('button', { name: 'Edit dates for Basic Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onEditDates).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Save dates' })).toBeNull();
  });

  it('holds Save while a date is unreadable', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit dates for Basic Salary' }));
    typeDate(/^New effective from/, 'not a date');
    expect((screen.getByRole('button', { name: 'Save dates' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
