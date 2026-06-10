/**
 * LLM-tier subsection for the auto-post settings card.
 * Rendered inside the existing card below the standard controls.
 */

interface AutoPostSettings {
  enabled: boolean;
  minConfidence: number;
  amountCap: number;
  llmEnabled: boolean;
  llmMinConfidence: number;
  llmAmountCap: number;
}

interface Props {
  ap: AutoPostSettings;
  apDraft: { llmMinConfidence: string; llmAmountCap: string };
  apSaving: boolean;
  onDraftChange: (key: 'llmMinConfidence' | 'llmAmountCap', value: string) => void;
  onSave: (patch: Partial<AutoPostSettings>) => void;
}

export function AutoPostLlmSection({ ap, apDraft, apSaving, onDraftChange, onSave }: Props) {
  return (
    <div className="mt-5 pt-4 border-t border-[var(--ff-border-light)]">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1">
          <p className="text-sm font-medium text-[var(--ff-text-primary)]">
            AI (LLM) auto-post — high-risk, off by default
          </p>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
            Lets the AI tier post journal entries for transactions rules and history can&#39;t
            categorize, under its own stricter limits. Requires{' '}
            <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> to be configured.
          </p>
        </div>
        <button
          type="button"
          disabled={apSaving}
          onClick={() => onSave({ llmEnabled: !ap.llmEnabled })}
          className={`px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 ${ap.llmEnabled ? 'bg-green-600 text-white' : 'bg-slate-500/20 text-[var(--ff-text-secondary)]'}`}
        >
          {ap.llmEnabled ? 'On' : 'Off'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">
            AI min confidence (0–1, default 0.95)
          </label>
          <input
            type="number" step="0.01" min="0.01" max="1"
            className="ff-input text-sm w-full"
            value={apDraft.llmMinConfidence}
            onChange={(e) => onDraftChange('llmMinConfidence', e.target.value)}
            onBlur={(e) => onSave({ llmMinConfidence: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">
            AI amount cap (R, 0 = no cap, default 2000)
          </label>
          <input
            type="number" step="1" min="0"
            className="ff-input text-sm w-full"
            value={apDraft.llmAmountCap}
            onChange={(e) => onDraftChange('llmAmountCap', e.target.value)}
            onBlur={(e) => onSave({ llmAmountCap: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}
