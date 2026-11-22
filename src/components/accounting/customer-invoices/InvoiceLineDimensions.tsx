/**
 * A line's dimensions on the invoice line grid (behind "Dimensions"): the job (Project Profitability, migration 874),
 * the CC2 project and the BU (migration 870), on their own row under the line, a third of its width each with its name
 * shown, so none is squeezed into a narrow column (they clipped at 1280 px as three more table columns).
 */
import type { InvoiceLine } from './InvoiceLineItemsTable';
import { CodingPicker } from './InvoiceLineItemsTable';
import type { InvoiceLineCodingOptions } from './useInvoiceLineCodingOptions';

const lbl = 'mb-1 text-xs font-medium text-slate-600 dark:text-slate-400';

export function InvoiceLineDimensions({ line, options, onUpdate }: {
  line: InvoiceLine; options: InvoiceLineCodingOptions; onUpdate: (key: string, field: keyof InvoiceLine, value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 px-3 py-2">
      <CodingPicker label="Job (Project Profitability)" labelClassName={lbl} value={line.projectId} options={options.projects} all={options} empty="No job" onChange={(v) => onUpdate(line.key, 'projectId', v)} />
      <CodingPicker label="CC2 project" labelClassName={lbl} value={line.cc2Id} options={options.cc2s} all={options} empty="No CC2 project" onChange={(v) => onUpdate(line.key, 'cc2Id', v)} />
      <CodingPicker label="BU" labelClassName={lbl} value={line.buId} options={options.bus} all={options} empty="No BU" onChange={(v) => onUpdate(line.key, 'buId', v)} />
    </div>
  );
}
