// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BankRulesTable } from '@/components/accounting/bank-rules/BankRulesTable';

const rule = {
  id: 'r1', ruleName: 'Fuel', matchField: 'description', matchType: 'contains', matchPattern: 'ENGEN',
  glAccountCode: '7200', glAccountName: 'Fuel', priority: 1, isActive: true, autoCreateEntry: false, vatCode: 'standard' as const,
};

function renderTable() {
  return render(
    <BankRulesTable loading={false} totalRules={1} filteredRules={[rule]} search="" selected={new Set()}
      busyId="" onSelectChange={vi.fn()} onEdit={vi.fn()} onToggleActive={vi.fn()} onDelete={vi.fn()} />,
  );
}

describe('BankRulesTable cards', () => {
  it('is a card table with a label on every data cell', () => {
    const { container } = renderTable();
    expect(container.querySelector('table')!.className).toContain('table-cards');
    const labels = [...container.querySelectorAll('tbody td[data-label]')].map(td => td.getAttribute('data-label'));
    expect(labels).toEqual(['Match', 'Pattern', 'GL account', 'Supplier / Customer', 'VAT', 'Effect', 'Priority', 'Status', 'Actions']);
  });

  it('gives the row actions and checkboxes a 44px target on phones', () => {
    renderTable();
    for (const name of [/Edit rule/, /Disable rule/, /Delete rule/]) {
      expect(screen.getByRole('button', { name }).className).toContain('max-lg:h-11');
    }
    for (const name of [/Select rule: Fuel/, /Select all rules on this list/]) {
      const label = screen.getByRole('checkbox', { name }).closest('label')!;
      expect(label.className).toMatch(/max-lg:h-11|min-h-11/);
    }
  });

  it('select-all is a visible control below lg (the header row is hidden on cards) and selects every visible rule', () => {
    const onSelectChange = vi.fn();
    render(<BankRulesTable loading={false} totalRules={2} filteredRules={[rule, { ...rule, id: 'r2' }]} search="" selected={new Set()}
      busyId="" onSelectChange={onSelectChange} onEdit={vi.fn()} onToggleActive={vi.fn()} onDelete={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: 'Select all rules on this list' });
    expect(box.closest('label')!.className).toContain('lg:hidden');
    fireEvent.click(box);
    expect([...onSelectChange.mock.calls[0][0]]).toEqual(['r1', 'r2']);
  });

  it('empty and loading messages stay centred on cards', () => {
    const { container } = render(<BankRulesTable loading={false} totalRules={0} filteredRules={[]} search="" selected={new Set()}
      busyId="" onSelectChange={vi.fn()} onEdit={vi.fn()} onToggleActive={vi.fn()} onDelete={vi.fn()} />);
    expect(container.querySelector('td[colspan]')!.className).toContain('max-lg:!text-center');
  });
});
