/**
 * Apply for Leave Page
 * Route: /payroll/leave/apply
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Calendar, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';

interface Employee { id: string; first_name: string; last_name: string; employee_number: string; }

const LEAVE_TYPES = [
  { code: 'annual', name: 'Annual Leave' },
  { code: 'sick', name: 'Sick Leave' },
  { code: 'family_responsibility', name: 'Family Responsibility Leave' },
  { code: 'maternity', name: 'Maternity Leave' },
  { code: 'unpaid', name: 'Unpaid Leave' },
  { code: 'study', name: 'Study Leave' },
];

export default function LeaveApplyPage() {
  const router = useRouter();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [employeeId, setEmployeeId] = useState('');
  const [leaveType, setLeaveType] = useState('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    apiFetch('/api/payroll/employees')
      .then(r => r.json())
      .then(json => {
        const list = json.data ?? json;
        setEmployees(Array.isArray(list) ? list : []);
        if (Array.isArray(list) && list.length > 0) setEmployeeId(list[0].id);
      })
      .catch(() => setError('Failed to load employees'))
      .finally(() => setLoading(false));
  }, []);

  const days = startDate && endDate
    ? Math.max(1, Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1)
    : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId || !startDate || !endDate || days < 1) {
      setError('Please fill in all required fields');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/leave-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, leaveType, startDate, endDate, days, reason }),
      });
      const json = await res.json();
      if (json.success) {
        router.push('/payroll/leave');
      } else {
        setError(json.error?.message || json.message || 'Failed to submit leave application');
      }
    } catch {
      setError('Failed to submit leave application');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/payroll/leave" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Leave
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/10"><Calendar className="h-6 w-6 text-green-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Apply for Leave</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Submit a new leave application</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-2xl">
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{error}</div>
          )}

          {loading ? (
            <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin inline" /></div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Employee *</label>
                  <select value={employeeId} onChange={e => setEmployeeId(e.target.value)} className="ff-select w-full" required>
                    {employees.map(emp => (
                      <option key={emp.id} value={emp.id}>{emp.employee_number} — {emp.first_name} {emp.last_name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Leave Type *</label>
                  <select value={leaveType} onChange={e => setLeaveType(e.target.value)} className="ff-select w-full" required>
                    {LEAVE_TYPES.map(t => (
                      <option key={t.code} value={t.code}>{t.name}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Start Date *</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="ff-input w-full" required />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">End Date *</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="ff-input w-full" required />
                  </div>
                </div>

                {days > 0 && (
                  <div className="p-3 bg-teal-500/10 rounded-lg text-teal-400 text-sm font-medium">
                    {days} working day{days !== 1 ? 's' : ''}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reason</label>
                  <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} className="ff-input w-full" placeholder="Optional reason for leave" />
                </div>
              </div>

              <div className="flex justify-end gap-3">
                <Link href="/payroll/leave" className="px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-secondary)] text-sm">
                  Cancel
                </Link>
                <button type="submit" disabled={submitting || !employeeId || !startDate || !endDate} className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                  {submitting ? <><Loader2 className="h-4 w-4 animate-spin inline mr-1" />Submitting...</> : 'Submit Application'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
