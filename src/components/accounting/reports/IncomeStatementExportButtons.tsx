/**
 * The Income Statement page's export buttons and their handlers. Each export
 * opens a route in a new tab, over the same period and filters the page shows.
 */

import { Download, FileSpreadsheet } from 'lucide-react';

interface Props {
  periodStart: string;
  periodEnd: string;
  costCentreId: string;
  businessUnitId: string;
  disabled: boolean;
}

export function IncomeStatementExportButtons({ periodStart, periodEnd, costCentreId, businessUnitId, disabled }: Props) {
  function handleExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    if (businessUnitId) params.set('business_unit_id', businessUnitId);
    window.open(`/api/accounting/income-statement-export?${params}`, '_blank');
  }

  function handleXlsxExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    if (businessUnitId) params.set('business_unit_id', businessUnitId);
    window.open(`/api/accounting/income-statement-xlsx?${params}`, '_blank');
  }

  return (
    <>
      <button onClick={handleXlsxExport} disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-success-700 text-white rounded-lg hover:bg-success-800 text-sm font-medium disabled:opacity-50">
        <FileSpreadsheet className="h-4 w-4" /> Export Excel
      </button>
      <button onClick={handleExport} disabled={disabled}
        className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium disabled:opacity-50">
        <Download className="h-4 w-4" /> Export CSV
      </button>
    </>
  );
}
