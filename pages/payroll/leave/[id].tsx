/**
 * Leave Request detail — view and approve/reject.
 * Route: /payroll/leave/[id]
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { CalendarOff, Loader2, AlertCircle, ArrowLeft, CheckCircle, XCircle } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage, ApiEnvelopeError } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { WriteOnly } from '@/components/payroll/WriteOnly';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';
import { formatDisplayDate } from '@/utils/dateFormat';

interface LeaveRequest {
  id: string;
  employeeName: string;
  employeeNumber: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: string;
  approvedAt: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/10 text-yellow-400',
  approved: 'bg-teal-500/10 text-teal-400',
  rejected: 'bg-red-500/10 text-red-400',
  cancelled: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
};

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-1">{label}</dt>
      <dd className="text-sm text-[var(--ff-text-primary)]">{value ?? '—'}</dd>
    </div>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function LeaveDetailPage() {
  const router = useRouter();
  // load() must depend on the id only: the router object's identity is not a reason to fetch again.
  const routerRef = useRef(router);
  routerRef.current = router;
  const { id } = router.query as { id: string };
  const [request, setRequest] = useState<LeaveRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  const load = useCallback(async (): Promise<boolean> => {
    if (!id) return true;
    // Guard: if id is not a UUID (e.g. a nav typo like "types"), redirect to the list
    if (!UUID_RE.test(id)) {
      await routerRef.current.replace('/payroll/leave');
      return true;
    }
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/leave/${id}`);
      if (res.status === 403) throw new ApiEnvelopeError(payrollLoadMessage(403, 'Could not load the leave request - try again'));
      await assertOk(res, 'Could not load the leave request - try again');
      const json = await res.json() as { data?: LeaveRequest };
      setRequest((json.data ?? null) as LeaveRequest | null);
      return true;
    } catch (err) {
      setRequest(null);
      setError(apiErrorMessage(err, 'Could not load the leave request - try again'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleAction = async (status: 'approved' | 'rejected' | 'cancelled') => {
    setActionLoading(status);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/leave/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      await assertOk(res, 'Could not update the leave request - try again');
      if (!(await load())) setError('The leave request was updated, but could not be reloaded - refresh the page');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not update the leave request - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this pending leave request?')) return;
    setActionLoading('delete');
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/leave/${id}`, { method: 'DELETE' });
      await assertOk(res, 'Could not delete the leave request - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete the leave request - try again'));
      setActionLoading('');
      return;
    }
    // The request is deleted; a failed navigation is not a failed delete.
    try { await router.push('/payroll/leave'); } catch (e) { log.warn('navigation failed', { error: e }, 'LeaveRequestPage'); }
    setActionLoading('');
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
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Leave Request</h1>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-xl">
          {isLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : !request ? (
            error
              ? <div className="flex items-center gap-2 text-red-400 py-4"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
              : <p className="text-[var(--ff-text-secondary)]">Request not found.</p>
          ) : (
            <>
              {error && <div className="flex items-center gap-2 text-red-400 pb-4"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>}
              <div className="flex items-center gap-2 mb-6">
                <span className={`px-3 py-1 rounded-full text-sm font-medium capitalize ${STATUS_COLORS[request.status] ?? ''}`}>
                  {request.status}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-5 mb-8">
                <Field label="Employee" value={`${request.employeeName} (${request.employeeNumber})`} />
                <Field label="Leave Type" value={request.leaveTypeName} />
                <Field label="Start Date" value={request.startDate} />
                <Field label="End Date" value={request.endDate} />
                <Field label="Days" value={String(request.days)} />
                <Field label="Submitted" value={formatDisplayDate(request.createdAt)} />
                {request.approvedAt && <Field label="Actioned" value={formatDisplayDate(request.approvedAt)} />}
                {request.reason && <div className="col-span-2"><Field label="Notes" value={request.reason} /></div>}
              </dl>

              {request.status === 'pending' && (
                <WriteOnly>
                  <div className="flex flex-wrap gap-3">
                    <button
                      onClick={() => handleAction('approved')}
                      disabled={!!actionLoading}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
                    >
                      {actionLoading === 'approved' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                      Approve
                    </button>
                    <button
                      onClick={() => handleAction('rejected')}
                      disabled={!!actionLoading}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium"
                    >
                      {actionLoading === 'rejected' ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                      Reject
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={!!actionLoading}
                      className="px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-50 text-sm"
                    >
                      Delete
                    </button>
                  </div>
                </WriteOnly>
              )}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
