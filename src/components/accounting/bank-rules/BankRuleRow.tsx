/**
 * Single row in the bank-categorisation rules table. Extracted out of
 * pages/accounting/bank-reconciliation/rules.tsx to keep the page itself
 * under the project-wide 300-line file budget.
 */

import { Pencil, ToggleLeft, ToggleRight, Trash2, Loader2 } from 'lucide-react';

export type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

const VAT_LABELS: Record<VatCode, string> = {
  none: 'No VAT',
  standard: '15%',
  zero_rated: 'Zero Rated',
  exempt: 'Exempt',
};

export interface BankRuleRowData {
  id: string;
  ruleName: string;
  matchField: string;
  matchType: string;
  matchPattern: string;
  glAccountCode?: string;
  glAccountName?: string;
  supplierName?: string;
  clientName?: string;
  priority: number;
  isActive: boolean;
  autoCreateEntry: boolean;
  vatCode: VatCode;
}

interface BankRuleRowProps {
  rule: BankRuleRowData;
  selected: boolean;
  busyId: string;
  onToggleSelect: (id: string, checked: boolean) => void;
  onEdit: (rule: BankRuleRowData) => void;
  onToggleActive: (rule: BankRuleRowData) => void;
  onDelete: (rule: BankRuleRowData) => void;
}

export function BankRuleRow({
  rule,
  selected,
  busyId,
  onToggleSelect,
  onEdit,
  onToggleActive,
  onDelete,
}: BankRuleRowProps) {
  return (
    <tr
      className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 ${selected ? 'bg-yellow-500/5' : ''}`}
    >
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={e => onToggleSelect(rule.id, e.target.checked)}
          aria-label={`Select rule: ${rule.ruleName}`}
          className="rounded border-[var(--ff-border-light)] accent-yellow-500"
        />
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{rule.ruleName}</td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
        <span className="text-xs">{rule.matchField} {rule.matchType}</span>
      </td>
      <td className="px-4 py-3">
        <code className="px-2 py-0.5 rounded bg-[var(--ff-bg-primary)] text-yellow-400 text-xs">
          {rule.matchPattern}
        </code>
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">
        {rule.glAccountCode
          ? `${rule.glAccountCode} — ${rule.glAccountName}`
          : <span className="text-[var(--ff-text-tertiary)]">—</span>}
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">
        {rule.supplierName
          ? <span><span className="text-blue-400 text-[10px] mr-1">SUP</span>{rule.supplierName}</span>
          : rule.clientName
            ? <span><span className="text-purple-400 text-[10px] mr-1">CUST</span>{rule.clientName}</span>
            : <span className="text-[var(--ff-text-tertiary)]">—</span>}
      </td>
      <td className="px-4 py-3">
        {rule.vatCode && rule.vatCode !== 'none'
          ? <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400">{VAT_LABELS[rule.vatCode]}</span>
          : <span className="text-[var(--ff-text-tertiary)] text-xs">—</span>}
      </td>
      <td className="px-4 py-3">
        {rule.autoCreateEntry
          ? <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400" title="Posts a journal entry when matched">Auto-post</span>
          : <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-500/10 text-sky-400" title="Attaches a category for review only">Suggest</span>}
      </td>
      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{rule.priority}</td>
      <td className="px-4 py-3">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${rule.isActive ? 'bg-teal-500/10 text-teal-400' : 'bg-gray-500/10 text-gray-400'}`}>
          {rule.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onEdit(rule)}
            disabled={!!busyId}
            className="p-1 text-[var(--ff-text-secondary)] hover:text-yellow-400"
            title="Edit rule"
            aria-label={`Edit rule: ${rule.ruleName}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onToggleActive(rule)}
            disabled={busyId === rule.id}
            className="p-1 text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
            title={rule.isActive ? 'Disable rule' : 'Enable rule'}
            aria-label={`${rule.isActive ? 'Disable' : 'Enable'} rule: ${rule.ruleName}`}
          >
            {rule.isActive ? <ToggleRight className="h-4 w-4 text-teal-400" /> : <ToggleLeft className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => onDelete(rule)}
            disabled={busyId === rule.id}
            className="p-1 text-red-400 hover:text-red-300"
            title="Delete rule"
            aria-label={`Delete rule: ${rule.ruleName}`}
          >
            {busyId === rule.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </button>
        </div>
      </td>
    </tr>
  );
}
