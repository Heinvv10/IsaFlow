/**
 * AccountMappingTable — editable account mapping step for migration wizard.
 * Displays parsed accounts; lets the user override auto-mapped types.
 */

import type { ParsedAccount } from '@/modules/accounting/services/migrationParserService';

const GL_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type GLType = typeof GL_TYPES[number];

interface Props {
  accounts: ParsedAccount[];
  onChange: (updated: ParsedAccount[]) => void;
  onAutoMap: () => void;
  autoMapping: boolean;
}

export function AccountMappingTable({ accounts, onChange, onAutoMap, autoMapping }: Props) {
  const updateRow = (index: number, patch: Partial<ParsedAccount>) => {
    const updated = [...accounts];
    updated[index] = { ...updated[index]!, ...patch };
    onChange(updated);
  };

  const mapped = accounts.filter(a => a.mappedType).length;
  const unmapped = accounts.length - mapped;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <span className="px-2 py-0.5 rounded bg-teal-500/20 text-teal-400 font-medium">{mapped} mapped</span>
          {unmapped > 0 && (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">{unmapped} unmapped</span>
          )}
        </div>
        <button
          onClick={onAutoMap}
          disabled={autoMapping}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium disabled:opacity-50"
        >
          {autoMapping ? 'Mapping...' : 'Auto-Map'}
        </button>
      </div>

      <div className="rounded-lg border border-[var(--ff-border-light)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
              <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Source Code</th>
              <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Source Name</th>
              <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Source Type</th>
              <th className="text-left px-3 py-2 text-[var(--ff-text-secondary)] font-medium">ISAFlow Type</th>
              <th className="text-right px-3 py-2 text-[var(--ff-text-secondary)] font-medium">Opening Bal.</th>
              <th className="px-3 py-2 text-[var(--ff-text-secondary)] font-medium text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {accounts.map((acct, idx) => (
              <tr key={idx} className="hover:bg-[var(--ff-bg-primary)]/50">
                <td className="px-3 py-2 font-mono text-xs text-[var(--ff-text-secondary)]">
                  {acct.sourceCode || '—'}
                </td>
                <td className="px-3 py-2 text-[var(--ff-text-primary)]">{acct.sourceName}</td>
                <td className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">{acct.sourceType || '—'}</td>
                <td className="px-3 py-2">
                  <select
                    value={acct.mappedType ?? ''}
                    onChange={e => updateRow(idx, { mappedType: e.target.value as GLType || undefined })}
                    className="w-full bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded px-2 py-1 text-xs text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— select —</option>
                    {GL_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-[var(--ff-text-primary)]">
                  {acct.openingBalance !== 0
                    ? acct.openingBalance.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : '—'
                  }
                </td>
                <td className="px-3 py-2 text-center">
                  {acct.mappedType
                    ? <span className="inline-block w-2 h-2 rounded-full bg-teal-400" title="Mapped" />
                    : <span className="inline-block w-2 h-2 rounded-full bg-amber-400" title="Unmapped" />
                  }
                </td>
              </tr>
            ))}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--ff-text-tertiary)] text-sm">
                  No accounts parsed yet. Upload a Chart of Accounts file to continue.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
