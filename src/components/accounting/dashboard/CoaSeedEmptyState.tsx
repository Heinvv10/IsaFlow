import { useState } from 'react';
import { Layers, Loader2, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

type TemplateId = 'isaflow_standard' | 'xero_compatible' | 'sage_compatible' | 'blank';

interface TemplateOption {
  id: TemplateId;
  label: string;
  tagline: string;
  codes: string;
  detail: string;
}

const TEMPLATES: TemplateOption[] = [
  {
    id: 'isaflow_standard',
    label: 'ISAFlow Standard',
    tagline: 'Recommended for SA businesses',
    codes: '1xxx · 2xxx · 3xxx · 4xxx · 5xxx',
    detail: 'Assets, Liabilities, Equity, Revenue, Expenses — balanced 5-category SA layout with 31 starter accounts.',
  },
  {
    id: 'xero_compatible',
    label: 'Xero-compatible',
    tagline: 'Match your Xero account structure',
    codes: '001–003 · 010–013 · 100–103 · 200–300 · 400 · 500–800',
    detail: '3-digit codes used by Xero SA. Switch accountants easily — your existing Xero mappings stay intact.',
  },
  {
    id: 'sage_compatible',
    label: 'Sage One-compatible',
    tagline: 'Match your Sage account structure',
    codes: '1000–1600 · 2000–2501 · 3000 · 4000 · 5000 · 6000',
    detail: "Account codes aligned with Sage One SA. Ideal if you're migrating existing Sage data into ISAFlow.",
  },
];

export function CoaSeedEmptyState({ onSeeded }: { onSeeded: () => void }) {
  const [selected, setSelected] = useState<TemplateId>('isaflow_standard');
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState('');

  async function seed() {
    setSeeding(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/coa-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selected }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error?.message || 'Failed to seed chart of accounts');
      }
      onSeeded();
    } catch (err) {
      log.error('Failed to seed COA', { error: err }, 'coa-empty-state');
      setError(err instanceof Error ? err.message : 'Failed to seed chart of accounts');
      setSeeding(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] p-8">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 rounded-full bg-teal-500/10 border border-teal-500/30 flex items-center justify-center flex-shrink-0">
            <Layers className="h-6 w-6 text-teal-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-[var(--ff-text-primary)]">Set up your chart of accounts</h2>
            <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
              Pick a template to seed the general ledger. You can add, rename, or disable accounts afterwards.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          {TEMPLATES.map(t => {
            const active = selected === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelected(t.id)}
                disabled={seeding}
                className={`text-left p-4 rounded-lg border transition-colors disabled:opacity-50 ${active
                  ? 'border-teal-500 bg-teal-500/5'
                  : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-teal-500/40'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-[var(--ff-text-primary)]">{t.label}</span>
                  {active && <CheckCircle2 className="h-4 w-4 text-teal-400" />}
                </div>
                <p className="text-xs text-teal-400 mb-2">{t.tagline}</p>
                <p className="text-xs font-mono text-[var(--ff-text-tertiary)] mb-2">{t.codes}</p>
                <p className="text-xs text-[var(--ff-text-secondary)] leading-relaxed">{t.detail}</p>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-[var(--ff-border-light)]">
          <p className="text-xs text-[var(--ff-text-tertiary)]">
            Prefer to start from scratch? Pick any template and delete the accounts you don&apos;t need, or add accounts manually with the <strong>Add Account</strong> button once the ledger is set up.
          </p>
          <button
            onClick={() => void seed()}
            disabled={seeding}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 text-white rounded-lg text-sm font-semibold transition-colors"
          >
            {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {seeding ? 'Seeding…' : 'Seed chart of accounts'}
          </button>
        </div>
      </div>
    </div>
  );
}
