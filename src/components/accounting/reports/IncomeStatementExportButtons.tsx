/**
 * The Income Statement page's export buttons. Each export opens a route in a
 * new tab, over the same period and filters the page shows; the PDF also hears
 * which comparators are on, because it leaves them out and says so.
 */

import { Download, FileSpreadsheet, FileText } from 'lucide-react';

const COMPARATORS = ['prior', 'budget', 'variance', 'trend'] as const;

interface Props {
  periodStart: string;
  periodEnd: string;
  costCentreId: string;
  businessUnitId: string;
  columns: Record<(typeof COMPARATORS)[number], boolean>;
  disabled: boolean;
}

export function IncomeStatementExportButtons({ periodStart, periodEnd, costCentreId, businessUnitId, columns, disabled }: Props) {
  function open(path: string, comparators = '') {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    if (businessUnitId) params.set('business_unit_id', businessUnitId);
    if (comparators) params.set('comparators', comparators);
    window.open(`/api/accounting/${path}?${params}`, '_blank');
  }

  const onScreen = COMPARATORS.filter((name) => columns[name]).join(',');

  return (
    <>
      <button onClick={() => open('income-statement-xlsx')} disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-success-700 text-white rounded-lg hover:bg-success-800 text-sm font-medium disabled:opacity-50">
        <FileSpreadsheet className="h-4 w-4" /> Export Excel
      </button>
      <button onClick={() => open('income-statement-export')} disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium disabled:opacity-50">
        <Download className="h-4 w-4" /> Export CSV
      </button>
      <button onClick={() => open('income-statement-pdf', onScreen)} disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium disabled:opacity-50">
        <FileText className="h-4 w-4" /> Export PDF
      </button>
    </>
  );
}
