import { Clock, CheckCircle, BarChart3 } from 'lucide-react';

interface TimeSummary {
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  totalValue: number;
  byProject: { projectName: string; hours: number; value: number }[];
  byCustomer: { customerId: string; customerName: string; hours: number; value: number }[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const fmtHours = (n: number) => n.toFixed(2);

function SummaryCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    green: 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400',
    gray: 'bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    purple: 'bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-2 rounded-lg ${colors[color]}`}>{icon}</div>
        <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
      </div>
      <div className="text-xl font-bold text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}

interface Props {
  summary: TimeSummary | null;
}

export function TimeSummaryTab({ summary }: Props) {
  if (!summary) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Total Hours" value={fmtHours(summary.totalHours)} icon={<Clock className="w-5 h-5" />} color="blue" />
        <SummaryCard label="Billable Hours" value={fmtHours(summary.billableHours)} icon={<CheckCircle className="w-5 h-5" />} color="green" />
        <SummaryCard label="Non-Billable" value={fmtHours(summary.nonBillableHours)} icon={<Clock className="w-5 h-5" />} color="gray" />
        <SummaryCard label="Total Value" value={fmt(summary.totalValue)} icon={<BarChart3 className="w-5 h-5" />} color="purple" />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">By Project</h3>
          {summary.byProject.length === 0 ? (
            <p className="text-sm text-gray-500">No data</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                  <th className="pb-2">Project</th>
                  <th className="pb-2 text-right">Hours</th>
                  <th className="pb-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {summary.byProject.map(p => (
                  <tr key={p.projectName} className="border-b dark:border-gray-700/50">
                    <td className="py-2 text-gray-900 dark:text-white">{p.projectName}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmtHours(p.hours)}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmt(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">By Customer</h3>
          {summary.byCustomer.length === 0 ? (
            <p className="text-sm text-gray-500">No data</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b dark:border-gray-700">
                  <th className="pb-2">Customer</th>
                  <th className="pb-2 text-right">Hours</th>
                  <th className="pb-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {summary.byCustomer.map(c => (
                  <tr key={c.customerId} className="border-b dark:border-gray-700/50">
                    <td className="py-2 text-gray-900 dark:text-white">{c.customerName}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmtHours(c.hours)}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-400">{fmt(c.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
