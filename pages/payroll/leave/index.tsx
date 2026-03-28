/**
 * Leave Management Page
 * Route: /payroll/leave
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Calendar, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';

interface LeaveApp { id: string; first_name: string; last_name: string; leave_type_name: string; leave_type_code: string; start_date: string; end_date: string; days: number; status: string; reason: string; }
const statusColors: Record<string, string> = { pending: 'bg-amber-500/10 text-amber-400', approved: 'bg-teal-500/10 text-teal-400', rejected: 'bg-red-500/10 text-red-400', cancelled: 'bg-gray-500/10 text-gray-400' };

export default function LeavePage() {
  const [applications, setApplications] = useState<LeaveApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    const params = statusFilter ? `?status=${statusFilter}` : '';
    try {
      const res = await apiFetch(`/api/payroll/leave-applications${params}`, { credentials: 'include' });
      const json = await res.json();
      setApplications(json.data || []);
    } catch { setApplications([]); }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10"><Calendar className="h-6 w-6 text-green-500" /></div>
              <div><h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Leave Management</h1><p className="text-sm text-[var(--ff-text-secondary)]">Manage employee leave applications and balances</p></div>
            </div>
            <Link href="/payroll/leave/apply" className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"><Plus className="h-4 w-4" /> Apply for Leave</Link>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Status</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Employee</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">From</th><th className="px-4 py-3">To</th><th className="px-4 py-3 text-right">Days</th><th className="px-4 py-3">Status</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...</td></tr>}
                {!loading && applications.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No leave applications</td></tr>}
                {applications.map(a => (
                  <tr key={a.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">{a.first_name} {a.last_name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.leave_type_name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.start_date}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.end_date}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{a.days}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${statusColors[a.status] || ''}`}>{a.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
