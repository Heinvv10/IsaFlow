/**
 * Leave Management — request list.
 * Route: /payroll/leave
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { CalendarOff, Loader2, AlertCircle, Plus, Filter } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface LeaveRequestRow {
  id: string;
  employeeName: string;
  employeeNumber: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/10 text-yellow-400',
  approved: 'bg-teal-500/10 text-teal-400',
  rejected: 'bg-red-500/10 text-red-400',
  cancelled: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
};

const MONTHS = ['All','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[status] ?? 'bg-gray-500/10 text-gray-400'}`}>
      {status}
    </span>
  );
}

export default function LeaveIndexPage() {
  const [requests, setRequests] = useState<LeaveRequestRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterMonth, setFilterMonth] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterMonth) params.set('month', filterMonth);
      const res = await apiFetch(`/api/payroll/leave?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: LeaveRequestRow[] };
      setRequests((json.data ?? []) as LeaveRequestRow[]);
    } catch {
      setError('Failed to load leave requests');
    } finally {
      setIsLoading(false);
    }
  }, [filterStatus, filterMonth]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarOff className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Leave Management</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">BCEA-compliant leave requests</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/payroll/leave/balances" className="px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">
                Balances
              </Link>
              <Link href="/payroll/leave/new" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
                <Plus className="h-4 w-4" /> New Request
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6">
          {/* Filters */}
          <div className="flex items-center gap-3 mb-6">
            <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              <option value="">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              value={filterMonth}
              onChange={e => setFilterMonth(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i === 0 ? '' : String(i)}>{m}</option>
              ))}
            </select>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">{requests.length} request{requests.length !== 1 ? 's' : ''}</span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /> <span>{error}</span>
            </div>
          ) : requests.length === 0 ? (
            <div className="text-center py-16">
              <CalendarOff className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No leave requests</p>
              <Link href="/payroll/leave/new" className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
                <Plus className="h-4 w-4" /> New Request
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Employee</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Leave Type</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">From</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">To</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Days</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="py-3 px-4" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4">
                        <span className="font-medium text-[var(--ff-text-primary)]">{r.employeeName}</span>
                        <span className="ml-2 text-xs text-[var(--ff-text-tertiary)] font-mono">{r.employeeNumber}</span>
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{r.leaveTypeName}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{r.startDate}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{r.endDate}</td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-primary)] font-medium">{r.days}</td>
                      <td className="py-3 px-4"><StatusBadge status={r.status} /></td>
                      <td className="py-3 px-4 text-right">
                        <Link href={`/payroll/leave/${r.id}`} className="text-teal-400 hover:text-teal-300 text-xs font-medium">View</Link>
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
