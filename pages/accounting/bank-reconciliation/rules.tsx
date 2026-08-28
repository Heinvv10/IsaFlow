/**
 * Bank Categorisation Rules Page
 * Phase 2: Quick entry rules + statement mapping
 */

import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Search, X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';
import { BankRuleForm } from '@/components/accounting/bank-rules/BankRuleForm';
import { useBankRuleRefData } from '@/components/accounting/bank-rules/useBankRuleRefData';
import { BankRulesHeader } from '@/components/accounting/bank-rules/BankRulesHeader';
import { BankRulesTable } from '@/components/accounting/bank-rules/BankRulesTable';
import { useBankRules, type BankRule } from '@/components/accounting/bank-rules/useBankRules';

/**
 * Best-effort live preview of match count while the user types. Failures
 * are logged via `log.warn` (not silently swallowed) so a systematic outage
 * is observable instead of leaving every form field stuck on the
 * "Checking matches…" placeholder forever.
 */
async function fetchPreviewMatchCount(params: URLSearchParams): Promise<number | null> {
  try {
    const res = await apiFetch(`/api/accounting/bank-rules-preview?${params}`, { credentials: 'include' });
    if (!res.ok) {
      log.warn('Bank rules preview failed', { status: res.status }, 'bankRules');
      return null;
    }
    const json = await res.json();
    return json.data?.matchCount ?? null;
  } catch (err) {
    log.warn(
      'Bank rules preview threw',
      { error: err instanceof Error ? err.message : String(err) },
      'bankRules',
    );
    return null;
  }
}

export default function BankRulesPage() {
  const { accounts, bankAccounts, suppliers, clients, defaultBankId, errors: refErrors } = useBankRuleRefData();
  const rules = useBankRules({ defaultBankId, fetchPreview: fetchPreviewMatchCount });

  // Modal-based confirmations replace window.confirm() so the UX is styled,
  // accessible (focus management, ARIA), and consistent across the app.
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BankRule | null>(null);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <BankRulesHeader
          bankAccounts={bankAccounts}
          selectedBankId={rules.selectedBankId}
          onSelectBank={rules.setSelectedBankId}
          selectedCount={rules.selected.size}
          bulkDeleting={rules.bulkDeleting}
          onRequestBulkDelete={() => setConfirmBulkOpen(true)}
          busy={rules.busy}
          onRequestRunRules={() => setConfirmRunOpen(true)}
          onClickNewRule={() => { rules.resetForm(); rules.setShowForm(v => !v); }}
        />

        <div className="p-6 space-y-4">
          {rules.error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{rules.error}</div>}
          {refErrors.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
              <p className="font-medium mb-1">Some reference data failed to load — dropdowns may be empty:</p>
              <ul className="list-disc list-inside text-xs">
                {refErrors.map((msg, i) => <li key={i}>{msg}</li>)}
              </ul>
            </div>
          )}
          {rules.applyResult && (
            <div className="p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
              Rules applied: {rules.applyResult.applied} categorised, {rules.applyResult.skipped} skipped
            </div>
          )}
          {rules.applyResult?.autoPostSkippedClosedPeriod ? (
            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
              <p className="font-medium">
                {rules.applyResult.autoPostSkippedClosedPeriod} auto-post attempt
                {rules.applyResult.autoPostSkippedClosedPeriod > 1 ? 's were' : ' was'} skipped
                — transaction date falls in a closed fiscal period.
              </p>
              <p className="text-xs mt-1">
                We can&apos;t post journal entries into a closed or locked period.
                Either re-open the period from <em className="not-italic font-medium">Accounting → Fiscal Periods</em>,
                or leave these historical transactions alone — current-period transactions still got their JEs.
              </p>
            </div>
          ) : null}
          {rules.applyResult?.autoPostSkippedNoPeriod ? (
            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
              <p className="font-medium">
                {rules.applyResult.autoPostSkippedNoPeriod} auto-post attempt
                {rules.applyResult.autoPostSkippedNoPeriod > 1 ? 's were' : ' was'} skipped
                — no fiscal period exists for the transaction date.
              </p>
              <p className="text-xs mt-1">
                These dates fall outside any fiscal year you&apos;ve created (e.g. transactions
                in a year that hasn&apos;t been opened yet). Create the missing fiscal year from
                <em className="not-italic font-medium"> Accounting → Fiscal Periods</em>,
                then re-run rules. The periods don&apos;t need to be re-opened — they just need to exist.
              </p>
            </div>
          ) : null}
          {rules.applyResult?.autoPostSkippedRaced ? (
            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
              <p className="font-medium">
                {rules.applyResult.autoPostSkippedRaced} transaction
                {rules.applyResult.autoPostSkippedRaced > 1 ? 's were' : ' was'} skipped
                — allocated by another request while the rules were running.
              </p>
              <p className="text-xs mt-1">
                Someone (or an agent) allocated these while this run was in progress, so the rule
                left them alone rather than posting a second journal on top. Nothing was lost —
                re-run rules if you want to check what is still uncategorised.
              </p>
            </div>
          ) : null}
          {rules.applyResult?.autoPostRulesSkippedNoBankGl ? (
            <div className="p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
              <p className="font-medium">
                {rules.applyResult.autoPostRulesSkippedNoBankGl} auto-post rule
                {rules.applyResult.autoPostRulesSkippedNoBankGl > 1 ? 's were' : ' was'} skipped.
              </p>
              <p className="text-xs mt-1">
                The selected bank account is not a valid bank-subtype GL account, so we
                can&apos;t post journal entries against it. Open the bank account from
                <em className="not-italic font-medium"> Banking → Bank Accounts</em>,
                confirm its <em className="not-italic font-medium">account_subtype</em> is
                <em className="not-italic font-medium"> bank</em>, then re-run rules.
              </p>
            </div>
          ) : null}

          {rules.showForm && (
            <BankRuleForm
              form={rules.form}
              setForm={rules.setForm}
              isEditing={rules.editingRule !== null}
              busy={rules.busy}
              accounts={accounts}
              suppliers={suppliers}
              clients={clients}
              previewState={rules.previewState}
              onSubmit={rules.handleSubmit}
              onCancel={rules.resetForm}
            />
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
            <input
              value={rules.search}
              onChange={e => rules.setSearch(e.target.value)}
              placeholder="Search rules by name, pattern, account…"
              aria-label="Search rules"
              className="ff-input w-full pl-9 pr-8"
            />
            {rules.search && (
              <button
                type="button"
                onClick={() => rules.setSearch('')}
                aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {rules.search && (
            <p className="text-xs text-[var(--ff-text-tertiary)] -mt-2">
              {rules.filteredRules.length} of {rules.rules.length} rules
            </p>
          )}

          <BankRulesTable
            loading={rules.loading}
            totalRules={rules.rules.length}
            filteredRules={rules.filteredRules}
            search={rules.search}
            selected={rules.selected}
            busyId={rules.busy}
            onSelectChange={rules.setSelected}
            onEdit={rules.handleEdit}
            onToggleActive={(r) => void rules.doAction('toggle', r.id, { isActive: !r.isActive })}
            onDelete={(r) => setConfirmDelete(r as BankRule)}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmRunOpen}
        title="Run rules now?"
        message={
          <>
            Run all active rules against this bank account?
            {'\n\n'}• Suggest rules will attach a category to matching transactions for your review.
            {'\n'}• Auto-post rules will also post journal entries to the GL.
            {'\n\n'}Already-categorised transactions are skipped.
          </>
        }
        confirmLabel="Run rules"
        confirmTone="primary"
        busy={rules.busy === 'apply'}
        onCancel={() => setConfirmRunOpen(false)}
        onConfirm={() => {
          setConfirmRunOpen(false);
          void rules.doAction('apply', undefined, { bankAccountId: rules.selectedBankId });
        }}
      />

      <ConfirmDialog
        open={confirmBulkOpen}
        title="Delete selected rules?"
        message={`Delete ${rules.selected.size} selected rule${rules.selected.size > 1 ? 's' : ''}? This cannot be undone.`}
        confirmLabel="Delete"
        confirmTone="danger"
        busy={rules.bulkDeleting}
        onCancel={() => setConfirmBulkOpen(false)}
        onConfirm={async () => {
          await rules.performBulkDelete();
          setConfirmBulkOpen(false);
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete rule?"
        message={confirmDelete ? `Delete rule "${confirmDelete.ruleName}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        confirmTone="danger"
        busy={rules.busy === confirmDelete?.id}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete) return;
          const ruleId = confirmDelete.id;
          setConfirmDelete(null);
          void rules.doAction('delete', ruleId);
        }}
      />
    </AppLayout>
  );
}
