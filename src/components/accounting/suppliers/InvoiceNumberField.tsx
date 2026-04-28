/**
 * InvoiceNumberField — supplier invoice number input with optional auto-sequence.
 * - When `useSequence` is true, the input is disabled and shows the peeked SIV number
 *   from Settings → Document Numbers; the server reserves on save.
 * - When false, the user types a custom invoice ref (e.g. the supplier's bill number).
 */

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';

export interface InvoiceNumberFieldProps {
  useSequence: boolean;
  invoiceNumber: string;
  sequencePreview: string;
  onUseSequenceChange: (value: boolean) => void;
  onInvoiceNumberChange: (value: string) => void;
}

export function InvoiceNumberField(props: InvoiceNumberFieldProps) {
  const { useSequence, invoiceNumber, sequencePreview, onUseSequenceChange, onInvoiceNumberChange } = props;
  return (
    <div>
      <label className={lbl}>
        Invoice Number {useSequence ? '(next from sequence — final number reserved on save)' : '*'}
      </label>
      <input
        type="text"
        required={!useSequence}
        disabled={useSequence}
        value={useSequence ? sequencePreview : invoiceNumber}
        onChange={e => onInvoiceNumberChange(e.target.value)}
        className={`${inp} ${useSequence ? 'opacity-60 cursor-not-allowed' : ''}`}
        placeholder={useSequence ? sequencePreview || 'SIV…' : 'Custom number'}
      />
      <label className="flex items-center gap-2 mt-1.5 text-[11px] text-slate-500 dark:text-slate-400 cursor-pointer">
        <input
          type="checkbox"
          checked={useSequence}
          onChange={e => onUseSequenceChange(e.target.checked)}
          className="rounded border-slate-300 dark:border-slate-600"
        />
        Use SIV sequence from Document Numbers settings
      </label>
    </div>
  );
}
