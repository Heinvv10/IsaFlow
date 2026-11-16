/**
 * The "13 weeks" tab of the Cash Flow Forecast page: the forecast from the books (GET /api/accounting/cash-forecast-13),
 * header, runway, grid, overdue customer invoices and warnings; and, for owners/admins/managers when the data
 * layer's routes answer, the editing (cell changes, expected items, pay day). After any write the forecast reloads.
 */
import { useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';
import { PHONE_TAP } from '@/components/accounting/formActionBar';
import type { ForecastLine } from '@/modules/accounting/services/cashForecast13/types';
import { createItem, deleteItem, deleteOverride, saveOverride, savePayDay, type StoredOverride } from './cash13Client';
import { useCash13 } from './useCash13';
import { ForecastGrid, overrideKey } from './ForecastGrid';
import { inForceLine } from './forecastRows';
import { Cash13Header, Cash13Runway, OverdueArPanel, WarningsList } from './Cash13Summary';
import { CellEditor } from './CellEditor';
import { AddItemForm } from './AddItemForm';
import { ExpectedItemsList, PayDayControl } from './Cash13Inputs';

export function Cash13Tab() {
  const { companyRole } = useCompany();
  const writer = canWrite(companyRole);
  const data = useCash13();
  const { forecast, store, write } = data;
  const editable = writer && store.status === 'ready';
  const [editing, setEditing] = useState<{ line: ForecastLine; week: number } | null>(null);
  const [adding, setAdding] = useState(false);

  const overrides = useMemo(() => {
    const m = new Map<string, StoredOverride>();
    for (const o of data.overrides) m.set(overrideKey(o.lineKey, o.weekStart), o);
    return m;
  }, [data.overrides]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--ff-text-secondary)]">
          Cash in and out over the next 13 weeks, from your invoices, bills, payroll, SARS, loans and budget.
        </p>
        <div className="flex gap-2">
          {editable && <Button className={PHONE_TAP} leftIcon={Plus} onClick={() => setAdding(true)}>Add expected item</Button>}
          <Button variant="secondary" className={PHONE_TAP} leftIcon={RefreshCw} onClick={() => void data.reload()}>Refresh</Button>
        </div>
      </div>

      {writer && store.status === 'missing' && (
        <p className="text-sm text-ink-muted" data-testid="store-missing">Changing the forecast is not available yet: you can view it.</p>
      )}
      {store.status === 'failed' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{store.message}</p>}
      {!writer && <p className="text-sm text-ink-muted" data-testid="read-only-note">You can view this forecast. Owners, admins and managers can change it.</p>}

      {forecast.status === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-16 text-ink-muted"><Loader2 className="h-5 w-5 animate-spin" />Loading the forecast…</div>
      )}
      {forecast.status === 'error' && (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">{forecast.message}</p>
      )}
      {forecast.status === 'ok' && (
        <>
          <Cash13Header forecast={forecast.data} />
          <Cash13Runway weeks={forecast.data.weeks} />
          <ForecastGrid forecast={forecast.data} overrides={overrides} onEdit={editable ? (line, week) => setEditing({ line, week }) : undefined} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OverdueArPanel overdue={forecast.data.overdueAR} />
            <WarningsList warnings={forecast.data.warnings} />
            {store.status === 'ready' && (
              <>
                <PayDayControl setting={data.payDay} canEdit={editable} onSave={(rule) => write(() => savePayDay(rule))} />
                <ExpectedItemsList state={data.items} canEdit={editable} onDelete={(id) => write(() => deleteItem(id))} />
              </>
            )}
          </div>
          {editing && (
            <CellEditor line={inForceLine(editing.line, forecast.data.lines)} week={editing.week} weeks={forecast.data.weeks}
              existing={overrides.get(overrideKey(editing.line.key, forecast.data.weeks[editing.week]?.start ?? ''))}
              onClose={() => setEditing(null)}
              onSave={(body) => write(() => saveOverride(body))}
              onRemove={(id) => write(() => deleteOverride(id))} />
          )}
        </>
      )}
      {adding && <AddItemForm onClose={() => setAdding(false)} onCreate={(body) => write(() => createItem(body))} />}
    </div>
  );
}
