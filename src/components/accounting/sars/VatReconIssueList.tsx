/** The issues the VAT reconciliation flags, one per line. Renders nothing when there are none. */
import { AlertTriangle } from 'lucide-react';

export const fmtMonth = (m: string) => {
  const [y, mo] = m.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(mo) - 1]} ${y}`;
};

export function VatReconIssueList({ issues }: { issues: Array<{ month: string; severity: string; message: string }> }) {
  if (issues.length === 0) return null;
  return (
    <div className="space-y-2">
      {issues.map((issue, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 rounded-lg border px-4 py-2 text-xs ${
            issue.severity === 'error'
              ? 'border-red-800 bg-red-900/20 text-red-300'
              : 'border-amber-800 bg-amber-900/20 text-amber-300'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span><strong>{fmtMonth(issue.month)}:</strong> {issue.message}</span>
        </div>
      ))}
    </div>
  );
}
