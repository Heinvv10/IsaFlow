import { Sparkles, Check, X } from 'lucide-react';
import type { SelectOption } from '../BankTxTable';
import { ACCOUNT_TYPES, type GLSuggestion } from './glAccountSuggestions';
import { INPUT, LABEL } from './styles';

interface Props {
  code: string;
  name: string;
  type: string;
  onCode: (v: string) => void;
  onName: (v: string) => void;
  onType: (v: string) => void;
  transactionDescription?: string;
  suggestion: GLSuggestion | null;
  suggestionApplied: boolean;
  existingMatch: SelectOption | null;
  onApplySuggestion: () => void;
  onDismissSuggestion: () => void;
}

export function AccountForm({
  code, name, type, onCode, onName, onType,
  transactionDescription, suggestion, suggestionApplied, existingMatch,
  onApplySuggestion, onDismissSuggestion,
}: Props) {
  const nb = ACCOUNT_TYPES.find(t => t.value === type)?.nb;

  return (
    <>
      {suggestion && !suggestionApplied && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border ${existingMatch ? 'bg-amber-500/10 border-amber-500/30' : 'bg-teal-500/10 border-teal-500/30'}`}>
          <Sparkles className={`h-4 w-4 mt-0.5 flex-shrink-0 ${existingMatch ? 'text-amber-400' : 'text-teal-400'}`} />
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium mb-1 ${existingMatch ? 'text-amber-300' : 'text-teal-300'}`}>
              {existingMatch ? 'Existing account found' : 'Suggested from transaction'}
            </p>
            <p className="text-sm text-[var(--ff-text-primary)]">
              <span className="font-mono">{suggestion.code}</span> — {existingMatch ? existingMatch.name : suggestion.name}
              <span className="text-xs text-[var(--ff-text-tertiary)] ml-1">
                ({ACCOUNT_TYPES.find(t => t.value === suggestion.type)?.label})
              </span>
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={onApplySuggestion} title={existingMatch ? 'Use this account' : 'Accept suggestion'}
              className={`px-2 py-1 rounded text-xs font-medium ${existingMatch ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400' : 'hover:bg-teal-500/20 text-teal-400'}`}>
              {existingMatch ? 'Use' : <Check className="h-4 w-4" />}
            </button>
            <button onClick={onDismissSuggestion} title="Dismiss"
              className="p-1 rounded hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)]">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {suggestion && suggestionApplied && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-teal-500/10 border border-teal-500/20 text-xs text-teal-400">
          <Check className="h-3.5 w-3.5" />
          Suggestion applied — you can still edit the fields below
        </div>
      )}

      {transactionDescription && (
        <div className="text-xs text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-primary)] rounded px-3 py-2 truncate">
          Transaction: <span className="text-[var(--ff-text-secondary)]">{transactionDescription}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Account Code *</label>
          <input type="text" value={code} onChange={e => onCode(e.target.value)}
            placeholder="e.g. 5250" className={`${INPUT} font-mono`} autoFocus />
        </div>
        <div>
          <label className={LABEL}>Type *</label>
          <select value={type} onChange={e => onType(e.target.value)} className={INPUT}>
            {ACCOUNT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className={LABEL}>Account Name *</label>
        <input type="text" value={name} onChange={e => onName(e.target.value)}
          placeholder="e.g. Cleaning & Maintenance" className={INPUT} />
      </div>
      <div className="flex items-center gap-2 text-xs text-[var(--ff-text-tertiary)]">
        Normal balance:&nbsp;
        <span className={nb === 'debit' ? 'text-red-400' : 'text-teal-400'}>
          {nb === 'debit' ? 'Debit' : 'Credit'}
        </span>
      </div>
    </>
  );
}
