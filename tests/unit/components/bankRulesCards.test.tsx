// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    for (const name of [/Select rule: Fuel/, /Select all visible rules/]) {
      expect(screen.getByRole('checkbox', { name }).closest('label')!.className).toContain('max-lg:h-11');
    }
  });
});
