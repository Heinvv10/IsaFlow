/**
 * Payroll Employee Components card — assignment form + list of current assignments.
 * Used by /payroll/employees/[id].
 */
import { Loader2, Plus, X } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

export interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
}

export interface Assignment {
  id: string;
  componentId: string;
  componentName: string;
  componentType: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

interface Props {
  components: Component[];
  assignments: Assignment[];
  newComponentId: string;
  newAmount: string;
  newFrom: string;
  onNewComponentId: (v: string) => void;
  onNewAmount: (v: string) => void;
  onNewFrom: (v: string) => void;
  onAssign: () => void;
  onEnd: (assignmentId: string) => void;
  adding: boolean;
}

const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

export function EmployeeComponentsCard({
  components,
  assignments,
  newComponentId,
  newAmount,
  newFrom,
  onNewComponentId,
  onNewAmount,
  onNewFrom,
  onAssign,
  onEnd,
  adding,
}: Props) {
  return (
    <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Pay Components</h2>

      <div className="flex items-end gap-3 mb-4 pb-4 border-b border-[var(--ff-border-primary)]">
        <div className="flex-1">
          <label className={label}>Component</label>
          <select className={field} value={newComponentId} onChange={e => onNewComponentId(e.target.value)}>
            <option value="">Select a component…</option>
            {components.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.componentType})</option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <label className={label}>Amount (R)</label>
          <input type="number" step="0.01" className={field}
            value={newAmount} onChange={e => onNewAmount(e.target.value)} />
        </div>
        <div className="w-40">
          <label className={label}>Effective from</label>
          <input type="date" className={field}
            value={newFrom} onChange={e => onNewFrom(e.target.value)} />
        </div>
        <button
          onClick={onAssign}
          disabled={!newComponentId || !newAmount || adding}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
        >
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Assign
        </button>
      </div>

      {assignments.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-tertiary)]">No components assigned yet. Assign at least a basic-salary component to produce non-zero payroll.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-primary)] text-left">
              <th className="py-2 text-[var(--ff-text-secondary)] font-medium">Component</th>
              <th className="py-2 text-[var(--ff-text-secondary)] font-medium">Type</th>
              <th className="py-2 text-[var(--ff-text-secondary)] font-medium text-right">Amount</th>
              <th className="py-2 text-[var(--ff-text-secondary)] font-medium">From</th>
              <th className="py-2 text-[var(--ff-text-secondary)] font-medium">To</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {assignments.map(a => (
              <tr key={a.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                <td className="py-2 text-[var(--ff-text-primary)]">{a.componentName}</td>
                <td className="py-2 text-[var(--ff-text-secondary)] capitalize">{a.componentType}</td>
                <td className="py-2 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(a.amount)}</td>
                <td className="py-2 text-[var(--ff-text-secondary)]">{a.effectiveFrom.slice(0, 10)}</td>
                <td className="py-2 text-[var(--ff-text-secondary)]">{a.effectiveTo ? a.effectiveTo.slice(0, 10) : '—'}</td>
                <td className="py-2 text-right">
                  {!a.effectiveTo && (
                    <button onClick={() => onEnd(a.id)}
                      className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:text-red-400">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
