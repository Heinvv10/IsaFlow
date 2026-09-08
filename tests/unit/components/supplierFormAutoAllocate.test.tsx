/**
 * The supplier form's auto-allocate control says what it actually does.
 *
 * The old control was a bare toggle labelled "Auto Allocate Payments to Oldest
 * Invoice" bound to a column nothing read, next to code that ordered bills by
 * `created_at DESC` — the NEWEST. The label was wrong twice over: about the
 * order, and about anything happening at all.
 *
 * Rendered and clicked, not grepped: the label is a conditional and the
 * toggle/select pair is interaction, so only a real render can show that
 * turning it on emits a strategy and that the label follows the strategy
 * rather than a hardcoded word.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  SupplierForm, INITIAL_SUPPLIER_FORM, type SupplierFormData,
} from '@/components/accounting/SupplierForm';

/** Renders with `form`, returning the latest value the form emitted. */
function renderForm(form: SupplierFormData) {
  const onChange = vi.fn();
  const view = render(<SupplierForm form={form} onChange={onChange} />);
  return { onChange, view };
}

const orderSelect = () => screen.getByLabelText('Auto allocate order') as HTMLSelectElement;
const toggle = () => screen.getByRole('switch', { name: /auto allocate/i })
  ?? screen.getAllByRole('switch')[0]!;

describe('SupplierForm — auto-allocate control', () => {
  it('starts off, with the order select disabled', () => {
    renderForm({ ...INITIAL_SUPPLIER_FORM });

    expect(screen.getAllByRole('switch')[0]!.getAttribute('aria-checked')).toBe('false');
    expect(orderSelect().disabled).toBe(true);
    // Not "to Oldest Invoice" — nothing is being allocated to anything.
    expect(screen.getByText('Auto Allocate Payments')).toBeTruthy();
  });

  it('turning it on emits "oldest", not a boolean', () => {
    const { onChange } = renderForm({ ...INITIAL_SUPPLIER_FORM });

    fireEvent.click(screen.getAllByRole('switch')[0]!);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]![0]).toMatchObject({ auto_allocate_strategy: 'oldest' });
  });

  it('reads the ORDER out of the strategy, not a hardcoded word', () => {
    renderForm({ ...INITIAL_SUPPLIER_FORM, auto_allocate_strategy: 'newest' });

    // The defect this replaces: the label said "Oldest" while the code took
    // the newest bill.
    expect(screen.getByText('Auto Allocate Payments to Newest Invoice')).toBeTruthy();
    expect(screen.queryByText('Auto Allocate Payments to Oldest Invoice')).toBeNull();
    expect(orderSelect().value).toBe('newest');
    expect(orderSelect().disabled).toBe(false);
  });

  it('shows the order of a record loaded AFTER mount', () => {
    // The select must not keep showing the value it was first mounted with —
    // an edit form fetches its record and re-renders.
    const { view } = renderForm({ ...INITIAL_SUPPLIER_FORM });
    view.rerender(
      <SupplierForm
        form={{ ...INITIAL_SUPPLIER_FORM, auto_allocate_strategy: 'newest' }}
        onChange={vi.fn()}
      />,
    );
    expect(orderSelect().value).toBe('newest');
  });

  it('choosing an order emits that order', () => {
    const { onChange } = renderForm({
      ...INITIAL_SUPPLIER_FORM, auto_allocate_strategy: 'oldest',
    });

    fireEvent.change(orderSelect(), { target: { value: 'newest' } });

    expect(onChange.mock.calls[0]![0]).toMatchObject({ auto_allocate_strategy: 'newest' });
  });

  it('turning it off emits "off"', () => {
    const { onChange } = renderForm({
      ...INITIAL_SUPPLIER_FORM, auto_allocate_strategy: 'oldest',
    });

    fireEvent.click(screen.getAllByRole('switch')[0]!);

    expect(onChange.mock.calls[0]![0]).toMatchObject({ auto_allocate_strategy: 'off' });
  });
});
