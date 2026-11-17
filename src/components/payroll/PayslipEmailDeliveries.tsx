/**
 * Who this run's payslip has been emailed to, at its current approval (wave 6 PE, review #1542 A5, E-S1): each
 * employee's latest attempt, its address and time. A slip whose delivery is unknown (the mail server may have taken
 * it) says so, so nobody resends it without thinking.
 *  - A FAILED slip (provably not sent) has "Try again", open to every role the card is shown to: it names the employee
 *    in a plain send, which the server allows (nothing went out). "Retry all failed" does the same for every failed
 *    row, a batch at a time.
 *  - A SENT or MAY-HAVE-BEEN-SENT slip has "Send again" for an owner or admin only: that is a resend, a second mail.
 */
import { Button } from '@/components/ui/Button';
import { formatDisplayDateTime } from '@/utils/dateFormat';
import type { Delivery } from './payslipEmailPayloads';

const STATUS: Record<Delivery['status'], string> = {
  sent: 'Sent', failed: 'Not sent', unknown: 'May have been sent (the mail server did not confirm)',
};

interface Props {
  deliveries: Delivery[];
  /** Owner or admin: may resend a slip that was (or may have been) sent. */
  canResend: boolean;
  busy: boolean;
  onRetry: (employeeIds: string[]) => void;
  onResend: (employeeId: string) => void;
}

export function PayslipEmailDeliveries({ deliveries, canResend, busy, onRetry, onResend }: Props) {
  if (deliveries.length === 0) return null;
  const failed = deliveries.filter((d) => d.status === 'failed').map((d) => d.employeeId);
  return (
    <div className="mt-3">
      {failed.length > 1 && (
        <div className="mb-2 flex justify-end">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRetry(failed)}>Retry all failed ({failed.length})</Button>
        </div>
      )}
      <div className="overflow-x-auto" role="region" aria-label="Payslip emails for this run" tabIndex={0}>
        <table className="w-full text-left text-sm text-[var(--ff-text-primary)]" data-testid="payslip-email-deliveries">
          <thead className="text-xs text-[var(--ff-text-secondary)]">
            <tr><th className="py-1 pr-3 font-medium">Employee</th><th className="py-1 pr-3 font-medium">Status</th>
              <th className="py-1 pr-3 font-medium">To</th><th className="py-1 pr-3 font-medium">When</th>
              <th className="py-1 font-medium"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.employeeId} className="border-t border-[var(--ff-border-primary)]">
                <td className="py-1.5 pr-3">{d.employeeName} ({d.employeeNumber})</td>
                <td className={`py-1.5 pr-3 ${d.status === 'sent' ? '' : 'text-amber-700 dark:text-amber-400'}`}>{STATUS[d.status]}</td>
                <td className="py-1.5 pr-3 break-all">{d.recipient}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatDisplayDateTime(d.at)}</td>
                <td className="py-1.5">
                  {d.status === 'failed' ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRetry([d.employeeId])}
                      aria-label={`Try sending ${d.employeeName}'s payslip again`}>Try again</Button>
                  ) : canResend ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => onResend(d.employeeId)}
                      aria-label={`Send ${d.employeeName}'s payslip again`}>Send again</Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
