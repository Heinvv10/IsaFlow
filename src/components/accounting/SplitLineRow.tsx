/**
 * One line of the Split Transaction modal: a GL account (with its VAT code and
 * project / BU), or a SUPPLIER or CUSTOMER. A supplier/customer line settles
 * that contact: the server records its payment, receipt or refund document on
 * the split's journal and applies it to their oldest open documents unless
 * "Leave on account" is ticked. It carries no VAT and no dimensions, because
 * the bill or invoice already did, so those controls are not offered.
 */
import { Trash2, Search } from 'lucide-react';
import type { SelectOption, VatCode } from './BankTxTable';
import { VAT_OPTIONS } from './BankTxTable';

export type SplitTarget = 'account' | 'supplier' | 'customer';

export interface SplitLineState {
  id: string; // local key for React rendering
  target: SplitTarget;
  /** The GL account, supplier or customer id, per `target`. */
  targetId: string;
  targetLabel: string;
  amount: string; // string to allow free-form input
  vatCode: VatCode;
  description: string;
  /** Project (CC2) and business unit; the FNO is derived from the project server-side. Account lines only. */
  cc2Id: string;
  buId: string;
  /** Contact lines only: leave the document on account instead of applying it FIFO. */
  leaveOnAccount: boolean;
}

const TARGET_LABEL: Record<SplitTarget, string> = { account: 'GL Account', supplier: 'supplier', customer: 'customer' };

interface Props {
  line: SplitLineState;
  index: number;
  canRemove: boolean;
  options: SelectOption[];
  pickerOpen: boolean;
  pickerSearch: string;
  cc2Options: SelectOption[];
  buOptions: SelectOption[];
  onTogglePicker: () => void;
  onPickerSearch: (q: string) => void;
  onPick: (o: SelectOption) => void;
  onChange: (patch: Partial<SplitLineState>) => void;
  /** A new type clears the line's pick and closes its picker (the search belonged to the old list). */
  onTargetChange: (target: SplitTarget) => void;
  onRemove: () => void;
}

const FIELD = 'text-xs px-2 py-1.5 rounded bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] focus:outline-none focus:border-blue-500';

export function SplitLineRow({
  line, index, canRemove, options, pickerOpen, pickerSearch, cc2Options, buOptions,
  onTogglePicker, onPickerSearch, onPick, onChange, onTargetChange, onRemove,
}: Props) {
  const isAccount = line.target === 'account';
  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-[var(--ff-text-tertiary)] w-12 shrink-0">Line {index + 1}</span>
        <select value={line.target} aria-label={`Line ${index + 1} type`}
          onChange={e => onTargetChange(e.target.value as SplitTarget)}
          className={`${FIELD} px-1`}>
          <option value="account">Account</option>
          <option value="supplier">Supplier</option>
          <option value="customer">Customer</option>
        </select>
        {canRemove && (
          <button onClick={onRemove} aria-label={`Remove line ${index + 1}`}
            className="ml-auto p-1 rounded hover:bg-red-500/10 text-red-400">
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className={`grid gap-2 ${isAccount ? 'grid-cols-2 sm:grid-cols-[1fr_100px_110px]' : 'grid-cols-[1fr_100px]'}`}>
        <div className={`relative ${isAccount ? 'col-span-2 sm:col-span-1' : ''}`}>
          <button onClick={onTogglePicker} aria-expanded={pickerOpen}
            className={`w-full text-left text-xs px-2 py-1.5 rounded border truncate ${
              line.targetId
                ? 'bg-[var(--ff-bg-secondary)] border-[var(--ff-border-light)] text-[var(--ff-text-primary)]'
                : 'bg-amber-500/5 border-amber-500/30 text-amber-400 font-medium'
            }`}>
            {line.targetLabel || `Select ${TARGET_LABEL[line.target]}`}
          </button>
          {pickerOpen && (
            <div className="absolute z-50 top-full left-0 mt-1 w-80 max-w-[calc(100vw-3rem)] bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
              <div className="p-2 relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--ff-text-tertiary)]" />
                <input type="text" placeholder={`Search ${line.target === 'account' ? 'accounts' : `${line.target}s`}...`}
                  aria-label={`Line ${index + 1} search ${line.target === 'account' ? 'accounts' : `${line.target}s`}`}
                  value={pickerSearch} onChange={e => onPickerSearch(e.target.value)}
                  className={`w-full pl-7 ${FIELD}`} autoFocus />
              </div>
              <div className="max-h-44 overflow-y-auto">
                {options.map(o => (
                  <button key={o.id} onClick={() => onPick(o)}
                    className="w-full text-left px-3 py-1.5 hover:bg-[var(--ff-bg-primary)] text-xs flex items-center gap-2">
                    {o.code && <span className="font-mono text-[var(--ff-text-tertiary)] w-10 shrink-0">{o.code}</span>}
                    <span className="text-[var(--ff-text-primary)] truncate">{o.name}</span>
                  </button>
                ))}
                {options.length === 0 && <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results</div>}
              </div>
            </div>
          )}
        </div>

        <input type="number" min="0.01" step="0.01" placeholder="0.00" aria-label={`Line ${index + 1} amount`}
          value={line.amount} onChange={e => onChange({ amount: e.target.value })}
          className={`${FIELD} text-right font-mono`} />

        {isAccount && (
          <select value={line.vatCode} aria-label={`Line ${index + 1} VAT`}
            onChange={e => onChange({ vatCode: e.target.value as VatCode })}
            className={`${FIELD} px-1 ${line.vatCode === 'standard' ? 'text-cyan-400' : ''}`}>
            {VAT_OPTIONS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
        )}
      </div>

      <input type="text" placeholder="Description (optional)" value={line.description}
        onChange={e => onChange({ description: e.target.value })}
        className={`mt-2 w-full ${FIELD}`} />

      {isAccount && (cc2Options.length > 0 || buOptions.length > 0) && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <select value={line.cc2Id} aria-label={`Line ${index + 1} project`}
            onChange={e => onChange({ cc2Id: e.target.value })} className={`${FIELD} px-1`}>
            <option value="">Project (none)</option>
            {cc2Options.map(o => <option key={o.id} value={o.id}>{o.code ? `${o.code} ${o.name}` : o.name}</option>)}
          </select>
          <select value={line.buId} aria-label={`Line ${index + 1} business unit`}
            onChange={e => onChange({ buId: e.target.value })} className={`${FIELD} px-1`}>
            <option value="">Business unit (none)</option>
            {buOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}

      {!isAccount && (
        <label className="mt-2 flex items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
          <input type="checkbox" checked={line.leaveOnAccount}
            onChange={e => onChange({ leaveOnAccount: e.target.checked })} />
          Leave on account (otherwise it settles their oldest open {line.target === 'supplier' ? 'bills' : 'invoices'})
        </label>
      )}
    </div>
  );
}
