/**
 * Payroll Employees List — Phase 2.
 * Route: /payroll/employees
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Users, Loader2, AlertCircle, Plus, Search } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface EmployeeListItem {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  employmentType: string;
  startDate: string;
  endDate?: string;
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? 'bg-teal-500/10 text-teal-400'
          : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export default function EmployeesListPage() {
  const [employees, setEmployees] = useState<EmployeeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/employees');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = (json.data ?? json) as EmployeeListItem[];
      setEmployees(data);
    } catch {
      setError('Failed to load employees');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = employees.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.employeeNumber.toLowerCase().includes(q) ||
      `${e.firstName} ${e.lastName}`.toLowerCase().includes(q)
    );
  });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Employees</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">SA-compliant payroll roster</p>
              </div>
            </div>
            <Link
              href="/payroll/employees/new"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
            >
              <Plus className="h-4 w-4" /> New Employee
            </Link>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or employee number..."
                className="pl-9 pr-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm w-80 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {filtered.length} employee{filtered.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <Users className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No employees yet</p>
              <Link
                href="/payroll/employees/new"
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> New Employee
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Start</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(e => (
                    <tr
                      key={e.id}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]"
                    >
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)] font-mono text-xs">{e.employeeNumber}</td>
                      <td className="py-3 px-4">
                        <Link
                          href={`/payroll/employees/${e.id}`}
                          className="font-medium text-[var(--ff-text-primary)] hover:text-teal-400"
                        >
                          {e.firstName} {e.lastName}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)] capitalize">{e.employmentType}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{e.startDate.slice(0, 10)}</td>
                      <td className="py-3 px-4"><StatusBadge active={!e.endDate || new Date(e.endDate) > new Date()} /></td>
                      <td className="py-3 px-4">
                        <Link href={`/payroll/employees/${e.id}`} className="text-teal-400 hover:text-teal-300 text-xs font-medium">
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
