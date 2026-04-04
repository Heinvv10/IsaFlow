/**
 * Payroll Employees List Page
 * Displays all employees with search, status filter, and link to create new.
 * Route: /payroll/employees
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { formatCurrency } from '@/utils/formatters';
import { Users, Loader2, AlertCircle, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';

interface EmployeeListItem {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  department: string | null;
  position: string | null;
  status: string;
  employment_type: string;
  pay_structure: {
    basic_salary: number;
  } | null;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        status === 'active'
          ? 'bg-teal-500/10 text-teal-400'
          : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
      }`}
    >
      {status === 'active' ? 'Active' : 'Inactive'}
    </span>
  );
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<EmployeeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadEmployees = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('q', debouncedSearch);
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiFetch(`/api/payroll/employees?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEmployees((json.data ?? json) as EmployeeListItem[]);
    } catch {
      setError('Failed to load employees');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Employees</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Manage payroll employees</p>
              </div>
            </div>
            <Link
              href="/payroll/employees/new"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Employee
            </Link>
          </div>
        </div>

        <div className="p-6">
          {/* Filters */}
          <div className="flex items-center gap-3 mb-6 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, number, department..."
                className="pl-9 pr-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm w-72 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {employees.length} employee{employees.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Content */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : employees.length === 0 ? (
            <div className="text-center py-16">
              <Users className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No employees found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                {search ? 'Try a different search term' : 'Add your first employee to get started'}
              </p>
              {!search && (
                <Link
                  href="/payroll/employees/new"
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  New Employee
                </Link>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Department</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Position</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Basic Salary</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => (
                    <tr
                      key={emp.id}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] transition-colors"
                    >
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)] font-mono text-xs">
                        {emp.employee_number}
                      </td>
                      <td className="py-3 px-4">
                        <Link
                          href={`/payroll/employees/${emp.id}`}
                          className="font-medium text-[var(--ff-text-primary)] hover:text-teal-400 transition-colors"
                        >
                          {emp.first_name} {emp.last_name}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{emp.department ?? '-'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{emp.position ?? '-'}</td>
                      <td className="py-3 px-4">
                        <StatusBadge status={emp.status} />
                      </td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)] font-mono">
                        {emp.pay_structure ? formatCurrency(emp.pay_structure.basic_salary) : '-'}
                      </td>
                      <td className="py-3 px-4">
                        <Link
                          href={`/payroll/employees/${emp.id}`}
                          className="text-teal-400 hover:text-teal-300 text-xs font-medium transition-colors"
                        >
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
