/**
 * /employee-portal (wave 6 SS): the signed-in employee's own final payslips (download as PDF) and leave balances.
 * Read-only. A 401 from any read means the session ended: back to sign in.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { PortalShell } from '@/components/employeePortal/PortalShell';
import { portalCall, PortalCallError } from '@/components/employeePortal/portalFetch';

interface Me { employeeName: string; employeeNumber: string; employer: string }
interface Slip { runId: string; periodYear: number; periodMonth: number; runDate: string | null; netPay: number }
interface Leave { leaveType: string; year: number; accrued: number; taken: number; pending: number; balance: number }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const cell = 'border-b border-gray-200 px-3 py-2 dark:border-gray-800';

export default function EmployeePortalHome() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [slips, setSlips] = useState<Slip[] | null>(null);
  const [leave, setLeave] = useState<Leave[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([portalCall<Me>('/api/employee-portal/me'), portalCall<Slip[]>('/api/employee-portal/payslips'), portalCall<Leave[]>('/api/employee-portal/leave')])
      .then(([m, s, l]) => { setMe(m); setSlips(s); setLeave(l); })
      .catch((err: unknown) => {
        if (err instanceof PortalCallError && err.status === 401) void router.replace('/employee-portal/login');
        else setError(err instanceof Error ? err.message : 'Could not load your details.');
      });
  }, [router]);

  async function signOut(): Promise<void> {
    await portalCall('/api/employee-portal/logout', { method: 'POST', body: {} }).catch(() => undefined);
    await router.replace('/employee-portal/login');
  }

  return (
    <PortalShell title={me ? `Hello, ${me.employeeName}` : 'Your payslips'} employer={me?.employer}
      actions={<Button variant="secondary" size="sm" onClick={() => void signOut()}>Sign out</Button>}>
      {error && <p role="alert" className="mb-4 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <section aria-labelledby="slips" className="mb-8">
        <h2 id="slips" className="mb-2 text-lg font-semibold">Payslips</h2>
        {slips?.length === 0 && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            No payslips here yet. Payslips show here from the first pay run your employer approves after online payslips
            started; earlier payslips are available from your employer.
          </p>
        )}
        {slips && slips.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead><tr><th className={cell}>Month</th><th className={`${cell} text-right`}>Net pay</th><th className={cell}><span className="sr-only">Download</span></th></tr></thead>
            <tbody>
              {slips.map((s) => (
                <tr key={s.runId}>
                  <td className={cell}>{MONTHS[s.periodMonth - 1]} {s.periodYear}</td>
                  <td className={`${cell} text-right`}><Money amount={s.netPay} /></td>
                  <td className={`${cell} text-right`}>
                    <a className="font-medium text-teal-700 underline dark:text-teal-400" href={`/api/employee-portal/payslips/${s.runId}`}
                      aria-label={`Download payslip for ${MONTHS[s.periodMonth - 1]} ${s.periodYear}`}>Download PDF</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="leave">
        <h2 id="leave" className="mb-2 text-lg font-semibold">Leave balances</h2>
        {leave?.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-300">No leave balances recorded for this year.</p>}
        {leave && leave.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead><tr><th className={cell}>Leave</th><th className={`${cell} text-right`}>Taken</th><th className={`${cell} text-right`}>Balance (days)</th></tr></thead>
            <tbody>
              {leave.map((l) => (
                <tr key={l.leaveType}><td className={cell}>{l.leaveType}</td><td className={`${cell} text-right`}>{l.taken}</td><td className={`${cell} text-right`}>{l.balance}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </PortalShell>
  );
}
