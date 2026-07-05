/**
 * New Leave Request form.
 * Route: /payroll/leave/new
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { CalendarOff, Loader2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface EmployeeOption { id: string; firstName: string; lastName: string; employeeNumber: string }
interface LeaveTypeOption { id: string; name: string; isPaid: boolean }

function calcBusinessDays(start: string, end: string): number {
  if (!start || !end) return 0;
  let count = 0;
  const s = new Date(start);
  const e = new Date(end);
  if (s > e) return 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

export default function NewLeaveRequestPage() {
  const router = useRouter();
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const [employeeId, setEmployeeId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const days = calcBusinessDays(startDate, endDate);

  const loadOptions = useCallback(async () => {
    setIsLoading(true);
    try {
      const [empRes, typeRes] = await Promise.all([
        apiFetch('/api/payroll/employees'),
        apiFetch('/api/payroll/leave/types'),
      ]);
      const empJson = await empRes.json() as { data?: EmployeeOption[] };
      const typeJson = await typeRes.json() as { data?: LeaveTypeOption[] };
      setEmployees((empJson.data ?? []) as EmployeeOption[]);
      setLeaveTypes((typeJson.data ?? []) as LeaveTypeOption[]);
    } catch {
      setError('Failed to load options');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void loadOptions(); }, [loadOptions]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId || !leaveTypeId || !startDate || !endDate) {
      setError('All fields are required');
      return;
    }
    if (days <= 0) {
      setError('End date must be after start date');
      return;
    }
    setIsSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, leaveTypeId, startDate, endDate, days, reason: reason || undefined }),
      });
      if (!res.ok) {
        const json = await res.json() as { message?: string };
        throw new Error(json.message ?? `HTTP ${res.status}`);
      }
      await router.push('/payroll/leave');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-4">
            <Link href="/payroll/leave" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarOff className="h-5 w-5 text-teal-500" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">New Leave Request</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Submit a leave request for an employee</p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-xl">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
              )}

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Employee</label>
                <select
                  value={employeeId}
                  onChange={e => setEmployeeId(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="">Select employee…</option>
                  {employees.map(e => (
                    <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeNumber})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Leave Type</label>
                <select
                  value={leaveTypeId}
                  onChange={e => setLeaveTypeId(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                >
                  <option value="">Select leave type…</option>
                  {leaveTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name} {t.isPaid ? '(Paid)' : '(Unpaid)'}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Start Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">End Date</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    required
                    min={startDate}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
                  />
                </div>
              </div>

              {days > 0 && (
                <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm font-medium">
                  {days} business day{days !== 1 ? 's' : ''} calculated
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Notes (optional)</label>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500 resize-none"
                  placeholder="Reason or notes…"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
                >
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Submit Request
                </button>
                <Link href="/payroll/leave" className="px-5 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">
                  Cancel
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
