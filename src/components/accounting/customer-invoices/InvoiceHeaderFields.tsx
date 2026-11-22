/**
 * InvoiceHeaderFields — the "Client & Job" and "Dates & Period" cards shared by the new and edit invoice pages, on the
 * form kit: ContactPicker and DateField (typed dates: "1 Oct 2026", "t", and "+30" from the invoice date). The page owns
 * the form; this reports each change as a patch. The job picker stays the line editor's CodingPicker. "Amounts are" and
 * the currency are the line grid's settings row (InvoiceSettingsRow); VAT is per line (formVat).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ContactPicker } from '@/components/ui/pickers/ContactPicker';
import { DateField } from '@/components/ui/DateField';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { CodingPicker } from './InvoiceLineItemsTable';
import type { InvoiceLineCodingOptions } from './useInvoiceLineCodingOptions';
import { dueBeforeInvoice, isoOrEmpty, type InvoiceDateKey, type InvoiceHeaderForm, type Refused } from './invoiceHeaderForm';

export interface InvoiceCurrency { code: string; name: string }

interface Props {
  form: InvoiceHeaderForm;
  onChange: (patch: Partial<InvoiceHeaderForm>) => void;
  options: InvoiceLineCodingOptions;
  onProjectChange: (projectId: string) => void;
  onDateValidity: (key: InvoiceDateKey, v: FieldValidity) => void;
  /** The page's refused dates (useInvoiceDateValidity), so a field's own refusal reason is not hidden by another message. */
  refused: Refused;
  /** The invoice date is refused in a closed period. Off on the draft edit page, which saves a draft the server accepts. Default on. */
  postingDate?: boolean;
  /** Names the client when the page already holds it (a scan match), so the picker need not look it up. */
  clientLabel?: string;
  /** Bumped by the page when it resets the form, to clear refused date text. */
  resetKey?: number;
  /** Muted notes saying where a default came from (useContactDefaults). */
  hints?: { dueDate?: string };
  /** The user committed something in Due date, even text it refused. */
  onDueDateEdited?: () => void;
}

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';
const lbl = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5';

export function InvoiceCard({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className={`${card} p-5`}>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">{n}</span>{title}</h3>
      {children}
    </div>
  );
}

export function InvoiceHeaderFields({ form, onChange, options, onProjectChange, onDateValidity, refused, clientLabel, resetKey, hints, onDueDateEdited, postingDate = true }: Props) {
  // Due date's floor is the invoice date, so a refusal made against the old floor is stale once the invoice date moves:
  // drop it and show the last accepted due date again (the page's value) instead of leaving it red and blocking save.
  const [dueRevalidate, setDueRevalidate] = useState(0);
  const prevInvoiceDate = useRef(form.invoiceDate);
  useEffect(() => {
    if (prevInvoiceDate.current === form.invoiceDate) return;
    prevInvoiceDate.current = form.invoiceDate;
    onDateValidity('dueDate', { valid: true, code: null, reason: null });
    setDueRevalidate((k) => k + 1);
  }, [form.invoiceDate, onDateValidity]);
  const date = (key: InvoiceDateKey, label: string, extra: { required?: boolean; minDate?: string; error?: string; anchorDate?: string; helperText?: string; postingDate?: boolean } = {}) => (
    <DateField label={label} value={form[key] || null} resetKey={key === 'dueDate' ? `${resetKey ?? 0}:${dueRevalidate}` : resetKey} {...extra}
      onChange={(iso, v) => { if (key === 'dueDate') onDueDateEdited?.(); onDateValidity(key, v); if (v.valid) onChange({ [key]: iso ?? '' }); }} />
  );
  return (
    <>
      <InvoiceCard n={1} title="Client & Job">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ContactPicker kind="customer" label="Client" value={form.clientId || null} valueLabel={clientLabel}
            onChange={(v) => onChange({ clientId: v ?? '' })} placeholder="Select client…"
            labelClassName="after:ml-0.5 after:text-red-600 dark:after:text-red-400 after:content-['*']" />
          <div>
            <label className={lbl} htmlFor="invoice-job" onClick={() => document.getElementById('invoice-job')?.focus()}>Job <span className="font-normal text-gray-600 dark:text-gray-400">(display; new lines start on it)</span></label>
            <CodingPicker id="invoice-job" label="Invoice job" value={form.projectId} options={options.projects} all={options} empty="No job" onChange={onProjectChange} />
          </div>
        </div>
      </InvoiceCard>
      <InvoiceCard n={2} title="Dates & Period">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {date('invoiceDate', 'Invoice date', { required: true, postingDate })}
          {/* Typing counts as touched before it commits: a default landing now would wipe the text under the cursor. */}
          <div onInput={onDueDateEdited}>{date('dueDate', 'Due date', {
            anchorDate: form.invoiceDate,
            ...(hints?.dueDate ? { helperText: hints.dueDate } : {}),
            // The floor is only ever a real ISO date (DateField throws on any other); the field cannot re-check a value it
            // already holds when the floor moves, so a due date now before the invoice date is shown red from here (unless
            // the Due text on screen was itself refused: that reason is the one the user needs, and the field shows it).
            ...(isoOrEmpty(form.invoiceDate) ? { minDate: form.invoiceDate } : {}),
            ...(dueBeforeInvoice(form) && !refused.dueDate ? { error: 'The due date is before the invoice date' } : {}),
          })}</div>
          {date('billingPeriodStart', 'Period start')}
          {date('billingPeriodEnd', 'Period end')}
        </div>
      </InvoiceCard>
    </>
  );
}

export function InvoiceNotesCard({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className={`${card} p-5`}>
      <label htmlFor="invoice-notes" className={lbl}>Notes</label>
      <textarea id="invoice-notes" name="notes" value={value} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={placeholder}
        className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 ff-focus-ring resize-none" />
    </div>
  );
}
