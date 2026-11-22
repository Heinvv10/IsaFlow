/**
 * The employee portal's tax certificates (wave 6 SS-c): the signed-in employee's own IRP5 figures, one card per FILED
 * EMP501 version (annual or interim), each with a PDF copy. Read-only. Weekly and fortnightly pay has no certificate
 * here yet (the IRP5 run-kind guard refuses those runs), and the section says so when it has none. A 401 (the session
 * ended) goes to sign in, as the portal home does.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Money } from '@/components/ui/Money';
import { portalCall, PortalCallError } from '@/components/employeePortal/portalFetch';
import { apiErrorMessage } from '@/lib/apiFetch';
import { formatDisplayDate } from '@/utils/dateFormat';
import { kindLabel } from '@/modules/accounting/services/payroll/employeePortalIrp5Kind';

interface Line { code: string; label: string; amount: number }
interface Certificate {
  versionId: string; taxYear: number; kind: 'interim' | 'annual'; filedAt: string | null; certificateNumber: string;
  income: Line[]; deductions: Line[]; tax: Line[];
}
interface Certificates { payFrequency: string; certificates: Certificate[] }

const cell = 'border-b border-gray-200 px-3 py-2 dark:border-gray-800';
const muted = 'text-sm text-gray-600 dark:text-gray-300';

function Lines({ caption, lines }: { caption: string; lines: Line[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mb-3 max-lg:overflow-x-auto" data-testid="irp5-lines-scroll">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={`${cell} w-16`}>Code</th>
            <th scope="col" className={cell}>{caption}</th>
            <th scope="col" className={`${cell} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.code}-${l.label}`}>
              <td className={cell}>{l.code}</td><td className={cell}>{l.label}</td>
              <td className={`${cell} text-right`}><Money amount={l.amount} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Irp5Section() {
  const router = useRouter();
  const [data, setData] = useState<Certificates | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const failed = 'Could not load your tax certificates.';
    portalCall<Certificates>('/api/employee-portal/irp5', failed).then(setData).catch((err: unknown) => {
      if (err instanceof PortalCallError && err.status === 401) void router.replace('/employee-portal/login');
      else setError(apiErrorMessage(err, failed));
    });
  }, [router]);

  return (
    <section aria-labelledby="irp5" className="mb-8">
      <h2 id="irp5" className="mb-2 text-lg font-semibold">Tax certificates (IRP5)</h2>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {!error && !data && <p role="status" className={muted}>Loading your tax certificates…</p>}
      {data && data.certificates.length === 0 && data.payFrequency !== 'monthly' && (
        <p className={`${muted} mb-2`}>
          IRP5 certificates for {data.payFrequency} pay are not shown here yet. Ask your employer for yours.
        </p>
      )}
      {data && data.certificates.length === 0 && data.payFrequency === 'monthly' && (
        <p className={muted}>
          No tax certificates here yet. A certificate shows here once your employer has filed the tax year&apos;s
          reconciliation (EMP501) with SARS.
        </p>
      )}
      {data?.certificates.map((c) => (
        <article key={c.versionId} aria-labelledby={`irp5-${c.versionId}`} className="mb-4 rounded border border-gray-200 p-3 dark:border-gray-800">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 id={`irp5-${c.versionId}`} className="font-semibold">Tax year {c.taxYear}: {kindLabel(c.kind)}</h3>
            <a className="font-medium text-teal-700 underline dark:text-teal-400 max-lg:inline-flex max-lg:items-center max-lg:min-h-11" href={`/api/employee-portal/irp5/${c.versionId}`}>
              Download PDF<span className="sr-only"> IRP5 copy for tax year {c.taxYear}, {c.kind}</span>
            </a>
          </div>
          <p className={`${muted} mb-2`}>
            Certificate {c.certificateNumber}{c.filedAt ? `, filed with SARS on ${formatDisplayDate(c.filedAt)}` : ''}
          </p>
          <Lines caption="Income" lines={c.income} />
          <Lines caption="Deductions" lines={c.deductions} />
          <Lines caption="Tax, UIF and SDL" lines={c.tax} />
        </article>
      ))}
    </section>
  );
}
