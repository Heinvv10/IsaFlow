/**
 * Table of bank rules with select-all checkbox + empty / loading / no-match
 * states. Wraps BankRuleRow so the page itself doesn't have to host the
 * full table markup.
 */

import { BankRuleRow, type BankRuleRowData } from './BankRuleRow';

interface BankRulesTableProps {
  loading: boolean;
  totalRules: number;
  filteredRules: BankRuleRowData[];
  search: string;
  selected: Set<string>;
  busyId: string;
  onSelectChange: (next: Set<string>) => void;
  onEdit: (rule: BankRuleRowData) => void;
  onToggleActive: (rule: BankRuleRowData) => void;
  onDelete: (rule: BankRuleRowData) => void;
}

export function BankRulesTable({
  loading,
  totalRules,
  filteredRules,
  search,
  selected,
  busyId,
  onSelectChange,
  onEdit,
  onToggleActive,
  onDelete,
}: BankRulesTableProps) {
  const allChecked = filteredRules.length > 0 && filteredRules.every(r => selected.has(r.id));
  const someChecked = filteredRules.some(r => selected.has(r.id));

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
            <th className="px-3 py-3 w-8">
              <input
                type="checkbox"
                checked={allChecked}
                ref={el => {
                  if (el) el.indeterminate = someChecked && !allChecked;
                }}
                onChange={e => {
                  const next = new Set(selected);
                  filteredRules.forEach(r => {
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                  });
                  onSelectChange(next);
                }}
                aria-label="Select all visible rules"
                className="rounded border-[var(--ff-border-light)] accent-yellow-500"
              />
            </th>
            <th className="px-4 py-3">Rule</th>
            <th className="px-4 py-3">Match</th>
            <th className="px-4 py-3">Pattern</th>
            <th className="px-4 py-3">GL Account</th>
            <th className="px-4 py-3">Supplier / Customer</th>
            <th className="px-4 py-3">VAT</th>
            <th className="px-4 py-3">Effect</th>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={11} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td>
            </tr>
          )}
          {!loading && totalRules === 0 && (
            <tr>
              <td colSpan={11} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                No rules configured. Create one to auto-categorise bank transactions.
              </td>
            </tr>
          )}
          {!loading && totalRules > 0 && filteredRules.length === 0 && (
            <tr>
              <td colSpan={11} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                No rules match &ldquo;{search}&rdquo;
              </td>
            </tr>
          )}
          {filteredRules.map(rule => (
            <BankRuleRow
              key={rule.id}
              rule={rule}
              selected={selected.has(rule.id)}
              busyId={busyId}
              onToggleSelect={(id, checked) => {
                const next = new Set(selected);
                if (checked) next.add(id);
                else next.delete(id);
                onSelectChange(next);
              }}
              onEdit={onEdit}
              onToggleActive={onToggleActive}
              onDelete={onDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
